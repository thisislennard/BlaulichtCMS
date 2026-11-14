import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { deriveKey } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';

/**
 * Datenbanksicherung (pg_dump, Custom-Format), mit AES-256-GCM verschlüsselt.
 * Dateiformat: "LLBK1" | IV (12 Byte) | Chiffrat | Auth-Tag (16 Byte).
 * Entschlüsseln: `node server/dist/cli.js backup-decrypt <datei> <ziel.dump>` (braucht LIFELINK_MASTER_KEY).
 * Wichtig: Datenbank-Sicherung und Master-Schlüssel gehören zusammen, werden aber getrennt aufbewahrt.
 */
const MAGIC = Buffer.from('LLBK1');

export const backupDir = () => path.join(config.dataDir, 'backups');

export async function runBackup(trigger: 'schedule' | 'manual', userId: string | null) {
  fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const fileName = `lifelink-${stamp}.llbk`;
  const target = path.join(backupDir(), fileName);
  const row = await one<{ id: string }>(`INSERT INTO backups (file_name, status, trigger, created_by) VALUES ($1,'running',$2,$3) RETURNING id`, [fileName, trigger, userId]);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('backup'), iv);
    const out = fs.createWriteStream(target, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, iv]));
    const dump = spawn(process.env.PG_DUMP ?? 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--dbname=${config.databaseUrl}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    dump.stderr.on('data', (d) => (stderr += d.toString()));
    // Fehler beim Start (z. B. pg_dump nicht installiert) sofort abfangen – sonst unbehandelte Ablehnung
    let spawnError: Error | null = null;
    const exited = new Promise<number>((resolve) => {
      dump.on('error', (e: NodeJS.ErrnoException) => {
        spawnError = e.code === 'ENOENT' ? new Error('pg_dump ist nicht installiert oder nicht im PATH (PG_DUMP setzen).') : e;
        resolve(-1);
      });
      dump.on('close', (code) => resolve(code ?? 1));
    });
    const tap = new Transform({ transform: (chunk, _e, cb) => cb(null, chunk) });
    dump.stdout.pipe(cipher).pipe(tap);
    tap.pipe(out, { end: false });
    await new Promise<void>((resolve, reject) => {
      dump.on('error', () => resolve());
      tap.on('end', () => resolve());
      tap.on('error', reject);
      cipher.on('error', reject);
      out.on('error', reject);
    });
    const code = await exited;
    if (spawnError) throw spawnError;
    if (code !== 0) throw new Error(`pg_dump beendet mit Code ${code}: ${stderr.slice(0, 500)}`);
    const tag = cipher.getAuthTag();
    await new Promise<void>((resolve, reject) => out.end(tag, () => resolve()).on('error', reject));
    const size = fs.statSync(target).size;
    await pool.query(`UPDATE backups SET status = 'ok', finished_at = now(), size_bytes = $2, sha256 = $3 WHERE id = $1`, [row!.id, size, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')]);
    await prune();
    log('info', 'backup', `Sicherung erstellt: ${fileName} (${Math.round(size / 1024)} KB)`);
    return { id: row!.id, fileName, size };
  } catch (e) {
    fs.rmSync(target, { force: true });
    const msg = (e as Error).message;
    await pool.query(`UPDATE backups SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [row!.id, msg.slice(0, 1000)]);
    log('error', 'backup', `Sicherung fehlgeschlagen: ${msg}`);
    await notify({ kind: 'error', title: 'Sicherung fehlgeschlagen', body: msg.slice(0, 300), link: '/einstellungen#sicherung', permission: 'system.manage' });
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

export function decryptBackup(src: string, dest: string) {
  const data = fs.readFileSync(src);
  if (!data.subarray(0, 5).equals(MAGIC)) throw new Error('Keine LifeLink-Sicherung.');
  const iv = data.subarray(5, 17);
  const tag = data.subarray(data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('backup'), iv);
  decipher.setAuthTag(tag);
  fs.writeFileSync(dest, Buffer.concat([decipher.update(data.subarray(17, data.length - 16)), decipher.final()]), { mode: 0o600 });
}

export function backupPath(fileName: string): string {
  const p = path.join(backupDir(), path.basename(fileName));
  if (!fs.existsSync(p)) throw new Error('Datei nicht gefunden.');
  return p;
}
