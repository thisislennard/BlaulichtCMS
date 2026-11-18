import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { deriveKey, sha256File } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';

/**
 * Datenbanksicherung (pg_dump, Custom-Format), mit AES-256-GCM verschlüsselt.
 * Dateiformat: "BCBK1" | IV (12 Byte) | Chiffrat | Auth-Tag (16 Byte).
 * Entschlüsseln: `node server/dist/cli.js backup-decrypt <datei> <ziel.dump>` (braucht BLAULICHTCMS_MASTER_KEY).
 * Wichtig: Datenbank-Sicherung und Master-Schlüssel gehören zusammen, werden aber getrennt aufbewahrt.
 */
const MAGIC = Buffer.from('BCBK1');

export class BackupRunningError extends Error {
  constructor() {
    super('Es läuft bereits eine Sicherung.');
  }
}

export const backupDir = () => path.join(config.dataDir, 'backups');

export async function runBackup(trigger: 'schedule' | 'manual', userId: string | null) {
  fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
  // Eindeutiger Name (Sekunden + Zufall): zwei Sicherungen in derselben Minute überschreiben sich nicht (#62)
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const fileName = `blaulichtcms-${stamp}-${crypto.randomBytes(3).toString('hex')}.bcbk`;
  const target = path.join(backupDir(), fileName);
  const part = `${target}.part`;
  // Verwaiste Läufe (Prozess beendet) freigeben; der eindeutige Index lässt nur eine laufende Sicherung zu
  await pool.query(`UPDATE backups SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Prozess beendet)' WHERE status = 'running' AND started_at < now() - interval '1 hour'`);
  const row = await one<{ id: string }>(
    `INSERT INTO backups (file_name, status, trigger, created_by) VALUES ($1,'running',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [fileName, trigger, userId],
  );
  if (!row) throw new BackupRunningError();
  let sha256 = '';
  let dump: ChildProcessByStdio<null, Readable, Readable> | null = null;
  try {
    dump = spawn(process.env.PG_DUMP ?? 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--dbname=${config.databaseUrl}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    dump.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)));
    // Fehler beim Start (z. B. pg_dump nicht installiert) sofort abfangen – sonst unbehandelte Ablehnung
    let spawnError: Error | null = null;
    const exited = new Promise<number>((resolve) => {
      dump!.on('error', (e: NodeJS.ErrnoException) => {
        spawnError = e.code === 'ENOENT' ? new Error('pg_dump ist nicht installiert oder nicht im PATH (PG_DUMP setzen).') : e;
        resolve(-1);
      });
      dump!.on('close', (code) => resolve(code ?? 1));
    });
    let written: { sha256: string; bytes: number };
    try {
      written = await encryptToFile(dump, part, deriveKey('backup'));
    } catch (e) {
      // Startfehler verständlich melden statt „premature close“
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
      throw spawnError ?? e;
    }
    const code = await exited;
    if (spawnError) throw spawnError;
    if (code !== 0) throw new Error(`pg_dump beendet mit Code ${code}: ${stderr.slice(0, 500)}`);
    sha256 = written.sha256;
    fs.renameSync(part, target);
    // Wiederherstellbarkeit prüfen (#113): entschlüsseln (Auth-Tag) und Inhaltsverzeichnis mit pg_restore lesen
    const entries = await verifyBackup(target);
    const size = fs.statSync(target).size;
    // Prüfsumme wurde beim Schreiben gebildet (#248) – kein zweites Einlesen der ganzen Datei
    await pool.query(`UPDATE backups SET status = 'ok', finished_at = now(), size_bytes = $2, sha256 = $3 WHERE id = $1`, [row!.id, size, sha256]);
    await prune();
    log('info', 'backup', `Sicherung erstellt und geprüft: ${fileName} (${Math.round(size / 1024)} KB, ${entries} Einträge)`);
    // Sicherung außer Haus (#212): Übertragung im Worker einplanen; ein Fehler dabei macht die Sicherung nicht ungültig
    try {
      const { scheduleUpload } = await import('./offsite.js');
      await scheduleUpload(row!.id);
    } catch (e) {
      log('warn', 'backup', `Übertragung außer Haus nicht eingeplant: ${(e as Error).message}`);
    }
    return { id: row!.id, fileName, size };
  } catch (e) {
    // pg_dump nie hängen lassen (#248): ein blockierter Kindprozess hielte Verbindung, Snapshot und Sperren offen
    if (dump) stopProcess(dump);
    fs.rmSync(part, { force: true });
    // Eine Sicherung, die die Prüfung nicht besteht, ist unbrauchbar – nicht als Rückweg stehen lassen
    fs.rmSync(target, { force: true });
    const msg = (e as Error).message;
    await pool.query(`UPDATE backups SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [row!.id, msg.slice(0, 1000)]);
    log('error', 'backup', `Sicherung fehlgeschlagen: ${msg}`);
    await notify({ kind: 'error', title: 'Sicherung fehlgeschlagen', body: msg.slice(0, 300), link: '/einstellungen/sicherung', permission: 'backup.manage' });
    throw e;
  }
}

/** Kalendertag (JJJJ-MM-TT) und Stunde (0–23) eines Zeitpunkts in der Zeitzone. */
export function localDayHour(d: Date, timeZone: string): { day: string; hour: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * Tägliche Aufgabe (geplante Sicherung) fällig? Ab der eingestellten Stunde in Ortszeit, einmal je Kalendertag (#248).
 * Mit „genau diese Stunde“ fiel sie aus, wenn es die Stunde nicht gibt (02:00 am Tag der Umstellung auf Sommerzeit)
 * oder der Worker zu dieser Zeit nicht lief – jetzt läuft sie dann beim nächsten Takt desselben Tages.
 * `windowHours` begrenzt das Nachholen auf so viele Stunden ab der eingestellten (Probe-Wiederherstellung: 3).
 */
export function dailyRunDue(now: Date, timeZone: string, hour: number, lastRun: Date | null, windowHours = 24): boolean {
  const cur = localDayHour(now, timeZone);
  if (cur.hour < hour || cur.hour >= hour + windowHours) return false;
  return !lastRun || localDayHour(lastRun, timeZone).day !== cur.day;
}

/** Kindprozess beenden: erst SIGTERM, nach `graceMs` SIGKILL (wartet nicht). */
export function stopProcess(p: ChildProcess, graceMs = 5_000) {
  if (p.exitCode !== null || p.signalCode !== null || p.killed) return;
  p.kill('SIGTERM');
  const t = setTimeout(() => {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  }, graceMs);
  t.unref();
  p.once('exit', () => clearTimeout(t));
}

/**
 * Ausgabe eines Kindprozesses (pg_dump) verschlüsselt in eine Datei schreiben: "BCBK1" | IV | Chiffrat | Auth-Tag.
 * Alle Stufen hängen in einer `pipeline` (#248): Scheitert eine (typisch ENOSPC bei vollem Datenträger), werden alle
 * zerstört und der Kindprozess beendet – mit `pipe()` blieb er sonst blockiert beim Schreiben hängen. Die SHA-256 der
 * geschriebenen Datei entsteht dabei mit. `out` nur für Tests (Ziel, das einen Schreibfehler simuliert).
 */
export async function encryptToFile(proc: ChildProcessByStdio<null, Readable, Readable>, file: string, key: Buffer, out: Writable = fs.createWriteStream(file, { mode: 0o600 })): Promise<{ sha256: string; bytes: number }> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const count = (b: Buffer) => {
    hash.update(b);
    bytes += b.length;
  };
  const tap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      count(chunk);
      cb(null, chunk);
    },
  });
  try {
    const head = Buffer.concat([MAGIC, iv]);
    count(head);
    out.write(head);
    await pipeline(proc.stdout, cipher, tap, out, { end: false });
    const tag = cipher.getAuthTag();
    count(tag);
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(tag, () => resolve());
    });
    return { sha256: hash.digest('hex'), bytes };
  } catch (e) {
    stopProcess(proc);
    proc.stdout.destroy();
    out.destroy();
    // Datei erst nach dem Schließen entfernen lassen (Windows: offene Datei lässt sich nicht löschen)
    if (!(out as fs.WriteStream).closed) await new Promise<void>((r) => (out.once('close', () => r()), setTimeout(r, 2_000).unref()));
    throw e;
  }
}

async function prune() {
  const keep = (await getSettings())['backup.keep'];
  const old = await many<{ id: string; file_name: string }>(`SELECT id, file_name FROM backups WHERE status = 'ok' ORDER BY started_at DESC OFFSET $1`, [keep]);
  for (const b of old) {
    fs.rmSync(path.join(backupDir(), b.file_name), { force: true });
    await pool.query('DELETE FROM backups WHERE id = $1', [b.id]);
  }
  await pool.query(`DELETE FROM backups WHERE status = 'failed' AND started_at < now() - interval '30 days'`);
}

/** Gestreamt entschlüsseln (#77) – auch mehrere GB große Sicherungen ohne sie in den Speicher zu laden. */
export async function decryptBackup(src: string, dest: string, key: Buffer = deriveKey('backup')) {
  const size = fs.statSync(src).size;
  if (size < 5 + 12 + 16) throw new Error('Keine BlaulichtCMS-Sicherung.');
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(17);
  const tag = Buffer.alloc(16);
  try {
    fs.readSync(fd, head, 0, 17, 0);
    fs.readSync(fd, tag, 0, 16, size - 16);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, 5).equals(MAGIC)) throw new Error('Keine BlaulichtCMS-Sicherung.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(5, 17));
  decipher.setAuthTag(tag);
  const part = `${dest}.part`;
  try {
    await pipeline(fs.createReadStream(src, { start: 17, end: size - 17 }), decipher, fs.createWriteStream(part, { mode: 0o600 }));
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

/**
 * Prüft eine Datenbanksicherung auf Wiederherstellbarkeit: vollständig entschlüsseln (GCM-Auth-Tag schlägt bei
 * Beschädigung oder Manipulation fehl) und das Inhaltsverzeichnis mit `pg_restore --list` lesen. Liefert die Zahl
 * der Einträge; wirft mit verständlicher Meldung, wenn die Sicherung nicht brauchbar ist.
 */
export async function verifyBackup(file: string): Promise<number> {
  const tmp = `${file}.pruefung`;
  try {
    try {
      await decryptBackup(file, tmp);
    } catch (e) {
      throw new Error(`Prüfung fehlgeschlagen: Sicherung lässt sich nicht entschlüsseln (${(e as Error).message}).`);
    }
    const list = spawn(process.env.PG_RESTORE ?? 'pg_restore', ['--list', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    list.stdout.on('data', (d) => (out += d.toString()));
    list.stderr.on('data', (d) => (err += d.toString()));
    const code = await new Promise<number>((resolve) => {
      list.on('error', (e: NodeJS.ErrnoException) => {
        err = e.code === 'ENOENT' ? 'pg_restore ist nicht installiert oder nicht im PATH (PG_RESTORE setzen).' : e.message;
        resolve(-1);
      });
      list.on('close', (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`Prüfung fehlgeschlagen: pg_restore --list beendet mit Code ${code}: ${err.slice(0, 300)}`);
    const entries = out.split('\n').filter((l) => /^\d+;/.test(l)).length;
    if (!/ TABLE /.test(out) || entries === 0) throw new Error('Prüfung fehlgeschlagen: Die Sicherung enthält keine Tabellen.');
    return entries;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Sicherung nach einem Wechsel des Master-Schlüssels (#134) neu verschlüsseln: gestreamt mit dem alten Schlüssel
 * entschlüsseln (Auth-Tag geprüft), mit dem neuen verschlüsseln, erst dann die Datei ersetzen. Liefert die neue
 * SHA-256-Prüfsumme.
 */
export async function reencryptBackup(file: string, oldBackupKey: Buffer, newBackupKey: Buffer): Promise<string> {
  const plain = `${file}.klartext`;
  const part = `${file}.neu`;
  try {
    await decryptBackup(file, plain, oldBackupKey);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', newBackupKey, iv);
    const out = fs.createWriteStream(part, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, iv]));
    await pipeline(fs.createReadStream(plain), cipher, out, { end: false });
    await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), () => resolve()).on('error', reject));
    fs.renameSync(part, file);
    return await sha256File(file);
  } finally {
    fs.rmSync(plain, { force: true });
    fs.rmSync(part, { force: true });
  }
}

export function backupPath(fileName: string): string {
  const p = path.join(backupDir(), path.basename(fileName));
  if (!fs.existsSync(p)) throw new Error('Datei nicht gefunden.');
  return p;
}
