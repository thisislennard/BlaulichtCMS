import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { chainKeyFrom, verifyAudit } from '../lib/audit-chain.js';
import { sha256File } from '../lib/crypto.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { backupDir, decryptBackup } from './backup.js';
import { BACKUP_NAME, downloadForDrill, offsiteConfig } from './offsite.js';

/**
 * Probe-Wiederherstellung (#212, „Wiederherstellung üben“): Eine Sicherung – lokal oder vom Ziel außer Haus – wird in
 * eine **Wegwerf-Datenbank** derselben PostgreSQL-Instanz eingespielt und geprüft; der laufende Bestand bleibt
 * unberührt. Danach wird die Wegwerf-Datenbank gelöscht.
 *
 * Geprüft wird: Entschlüsseln (GCM-Auth-Tag), vollständiges Einspielen mit `pg_restore --exit-on-error`, Tabellen und
 * Zeilen je Tabelle, Stand der Migrationen, Konten vorhanden, Hash-Kette des Audit-Protokolls (mit dem Schlüssel aus
 * der Sicherung) und ob ihr Ende zum laufenden Protokoll passt. Ergebnis als Protokoll in `restore_drills`, im
 * Systemstatus und bei Fehlschlag als Benachrichtigung an „Sicherungen erstellen“.
 *
 * Braucht eine Datenbankverbindung mit dem Recht, Datenbanken anzulegen (im Image der Superuser über
 * DATABASE_ADMIN_URL bzw. den eingebetteten Socket) und freien Platz etwa in Höhe der Datenbankgröße.
 */

const PROBE_NAME = /^blaulichtcms_probe_[0-9a-f]{8}$/;
/** Wichtige Tabellen, deren Zeilenzahl im Protokoll einzeln erscheint. */
const KEY_TABLES = ['users', 'posts', 'post_revisions', 'approvals', 'media', 'collections', 'connections', 'warning_cases', 'audit_events', 'settings', 'secrets'];

export class DrillRunningError extends Error {
  constructor() {
    super('Es läuft bereits eine Probe-Wiederherstellung.');
  }
}

/** Verbindungsadresse für eine andere Datenbank derselben Instanz (gleiche Rolle, gleicher Socket/Host). */
export function probeUrl(adminUrl: string, dbName: string): string {
  if (!PROBE_NAME.test(dbName)) throw new Error('Ungültiger Name der Probedatenbank.');
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Probe einplanen. Ohne Angabe: die neueste Sicherung auf dem Ziel außer Haus (wenn eingerichtet und zuletzt
 * erfolgreich) – so wird genau die Kopie geprüft, auf die es im Ernstfall ankommt –, sonst die neueste lokale.
 */
export async function scheduleDrill(trigger: 'manual' | 'schedule', userId: string | null, pick: { source?: 'local' | 'offsite'; fileName?: string } = {}) {
  await pool.query(`UPDATE restore_drills SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Prozess beendet)' WHERE status IN ('queued','running') AND created_at < now() - interval '6 hours'`);
  let source = pick.source;
  let fileName = pick.fileName;
  if (fileName && !BACKUP_NAME.test(fileName)) throw new Error('Unbekannter Dateiname.');
  if (!source || !fileName) {
    const c = await offsiteConfig();
    if ((source ?? 'offsite') === 'offsite' && c.enabled && c.last_ok_file && !fileName) {
      source = 'offsite';
      fileName = c.last_ok_file;
    } else if (source !== 'offsite') {
      const b = await one<{ file_name: string }>(`SELECT file_name FROM backups WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1`);
      if (!b) throw new Error('Es gibt noch keine Sicherung, die sich einspielen ließe.');
      source = 'local';
      fileName = fileName ?? b.file_name;
    } else throw new Error('Auf dem Ziel außer Haus liegt noch keine übertragene Sicherung.');
  }
  if (source === 'local' && !(await one(`SELECT 1 FROM backups WHERE file_name = $1 AND status = 'ok'`, [fileName]))) throw new Error('Diese Sicherung gibt es nicht (mehr).');
  const row = await one<{ id: string }>(
    `INSERT INTO restore_drills (source, file_name, trigger, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [source, fileName, trigger, userId],
  );
  if (!row) throw new DrillRunningError();
  const { enqueue } = await import('../jobs/queue.js');
  await enqueue('backup.drill', { drillId: row.id }, { dedupKey: `backup.drill:${row.id}`, maxAttempts: 1 });
  return { id: row.id, source: source!, fileName: fileName! };
}

function runRestore(dump: string, url: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.env.PG_RESTORE ?? 'pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${url}`, dump], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, output: e.code === 'ENOENT' ? 'pg_restore ist nicht installiert oder nicht im PATH (PG_RESTORE setzen).' : e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, output: out.trim().slice(-800) }));
  });
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Verbindungen zur Probedatenbank. Ein Fehler auf einer ruhenden Verbindung (z. B. vom Server beendet) wird nur
 * protokolliert: Ohne Fehler-Listener würfe pg-pool ihn als ungefangene Ausnahme und beendete den Worker.
 */
export function openProbePool(url: string): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max: 2, application_name: 'blaulichtcms-drill' });
  p.on('error', (e) => log('warn', 'backup', `Probedatenbank: Verbindung beendet (${e.message})`));
  return p;
}

/** Anzahl der Verbindungen zu einer Datenbank. */
async function connectionsTo(admin: pg.Client, dbName: string): Promise<number> {
  return Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [dbName])).rows[0].n);
}

/**
 * Eigene Probedatenbank löschen. pg-pool meldet `end()` als erledigt, bevor die Verbindungen tatsächlich getrennt
 * sind – ein sofortiges `DROP … WITH (FORCE)` beendete dann noch offene Probe-Verbindungen (CI-Fehler 57P01). Deshalb:
 * warten, bis keine Verbindung mehr besteht, dann normal löschen. Erst wenn danach noch etwas verbunden ist (z. B. ein
 * hängender pg_restore), mit FORCE – das betrifft ausschließlich Verbindungen zu genau dieser zufällig benannten
 * Probedatenbank, nie die laufende Datenbank oder andere Proben.
 */
export async function dropProbeDatabase(admin: pg.Client, dbName: string, waitMs = 15_000): Promise<void> {
  if (!PROBE_NAME.test(dbName)) throw new Error('Ungültiger Name der Probedatenbank.');
  const until = Date.now() + waitMs;
  while ((await connectionsTo(admin, dbName)) > 0 && Date.now() < until) await sleep(100);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
  } catch (e) {
    if ((e as { code?: string }).code !== '55006') throw e; // nur „wird noch benutzt“
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
  }
}

export interface DrillResult {
  durationMs: number;
  sizeBytes: number;
  sha256: string;
  tables: number;
  rows: number;
  keyTables: Record<string, number>;
  migration: string | null;
  migrations: number;
  audit: { ok: boolean; checked: number; problems: number; firstProblem: string | null; keyAvailable: boolean; matchesLive: boolean | null; lastSeq: number | null };
  checks: { step: string; ok: boolean; detail?: string }[];
}

/** Auftrag `backup.drill`: eine eingeplante Probe ausführen. */
export async function runDrill(drillId: string) {
  const d = await one<{ id: string; source: 'local' | 'offsite'; file_name: string; status: string }>(
    `UPDATE restore_drills SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued' RETURNING id, source, file_name, status`,
    [drillId],
  );
  if (!d) return;
  const started = Date.now();
  const tag = crypto.randomBytes(4).toString('hex');
  const dbName = `blaulichtcms_probe_${tag}`;
  const tmpFile = path.join(backupDir(), `.probe-${tag}.bcbk`);
  const dumpFile = path.join(backupDir(), `.probe-${tag}.dump`);
  const checks: DrillResult['checks'] = [];
  const admin = new pg.Client({ connectionString: config.adminDatabaseUrl, application_name: 'blaulichtcms-drill' });
  admin.on('error', (e) => log('warn', 'backup', `Probe-Wiederherstellung: Verwaltungsverbindung beendet (${e.message})`));
  let created = false;
  let probe: pg.Pool | null = null;
  try {
    if (!BACKUP_NAME.test(d.file_name)) throw new Error('Unbekannter Dateiname.');
    fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
    // 1. Datei bereitstellen
    let file: string;
    let sha: string;
    if (d.source === 'offsite') {
      const got = await downloadForDrill(d.file_name, tmpFile);
      file = tmpFile;
      sha = got.sha256;
      const known = await one<{ sha256: string | null }>(`SELECT sha256 FROM backups WHERE file_name = $1 AND status = 'ok'`, [d.file_name]);
      if (known?.sha256 && known.sha256 !== sha) throw new Error('Die Datei auf dem Ziel weicht von der lokalen Sicherung ab (Prüfsumme).');
      checks.push({ step: 'Vom Ziel außer Haus geladen', ok: true, detail: known?.sha256 ? 'Prüfsumme wie lokal' : undefined });
    } else {
      file = path.join(backupDir(), d.file_name);
      if (!fs.existsSync(file)) throw new Error('Die lokale Sicherungsdatei ist nicht mehr vorhanden.');
      sha = await sha256File(file);
      const known = await one<{ sha256: string | null }>(`SELECT sha256 FROM backups WHERE file_name = $1 AND status = 'ok'`, [d.file_name]);
      if (known?.sha256 && known.sha256 !== sha) throw new Error('Die lokale Sicherungsdatei wurde verändert (Prüfsumme).');
      checks.push({ step: 'Lokale Datei gelesen', ok: true });
    }
    const sizeBytes = fs.statSync(file).size;
    // 2. Platz prüfen: die Probe braucht etwa so viel wie die Datenbank
    const dbSize = Number((await one<{ s: string }>(`SELECT pg_database_size(current_database())::bigint AS s`))?.s ?? 0);
    try {
      const st = await fs.promises.statfs(config.dataDir);
      const free = st.bavail * st.bsize;
      if (free < dbSize * 1.5 + sizeBytes * 3) throw new Error(`Zu wenig freier Speicher für die Probe (${Math.round(free / 1024 ** 2)} MB frei, gebraucht etwa ${Math.round((dbSize * 1.5 + sizeBytes * 3) / 1024 ** 2)} MB).`);
    } catch (e) {
      if (/Zu wenig/.test((e as Error).message)) throw e;
    }
    // 3. Entschlüsseln (Auth-Tag prüft Unversehrtheit)
    await decryptBackup(file, dumpFile);
    checks.push({ step: 'Entschlüsselt (Unversehrtheit bestätigt)', ok: true });
    // 4. Wegwerf-Datenbank anlegen
    await admin.connect();
    const role = (await admin.query(`SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!role?.rolsuper && !role?.rolcreatedb) throw new Error('Die Datenbankverbindung darf keine Datenbank anlegen (DATABASE_ADMIN_URL mit einem Superuser setzen).');
    // Reste abgebrochener Proben entfernen (nur Datenbanken mit genau diesem Namensmuster und nur, wenn niemand mehr
    // verbunden ist – nie Verbindungen beenden, die nicht zu dieser Probe gehören)
    for (const r of (await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE 'blaulichtcms_probe_%'`)).rows) {
      if (!PROBE_NAME.test(r.datname) || r.datname === dbName) continue;
      // Belegt (DROP würde bis zu 5 s warten und dann scheitern): stehen lassen, die nächste Probe versucht es wieder
      if ((await connectionsTo(admin, r.datname)) > 0) {
        log('warn', 'backup', `Alte Probedatenbank ${r.datname} bleibt: Es ist noch eine Verbindung offen.`);
        continue;
      }
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(r.datname)}`).catch((e) => log('warn', 'backup', `Alte Probedatenbank ${r.datname} bleibt (${(e as Error).message}).`));
    }
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)} TEMPLATE template0 ENCODING 'UTF8'`);
    created = true;
    // 5. Einspielen
    const url = probeUrl(config.adminDatabaseUrl, dbName);
    const restored = await runRestore(dumpFile, url);
    fs.rmSync(dumpFile, { force: true });
    if (!restored.ok) throw new Error(`Einspielen fehlgeschlagen: ${restored.output}`);
    checks.push({ step: 'Vollständig eingespielt', ok: true });
    // 6. Inhalt prüfen
    probe = openProbePool(url);
    const tables = (await probe.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows.map((r) => String(r.table_name));
    let rows = 0;
    const keyTables: Record<string, number> = {};
    for (const t of tables) {
      const n = Number((await probe.query(`SELECT count(*)::bigint AS n FROM ${quoteIdent(t)}`)).rows[0].n);
      rows += n;
      if (KEY_TABLES.includes(t)) keyTables[t] = n;
    }
    const hasMigrations = tables.includes('schema_migrations');
    const mig = hasMigrations ? (await probe.query(`SELECT max(name) AS m, count(*)::int AS n FROM schema_migrations`)).rows[0] : { m: null, n: 0 };
    const structureOk = tables.length >= 10 && hasMigrations && Number(mig.n) > 0;
    checks.push({ step: 'Tabellen und Migrationen', ok: structureOk, detail: `${tables.length} Tabellen, Stand ${mig.m ?? '–'}` });
    const usersOk = (keyTables.users ?? 0) > 0;
    checks.push({ step: 'Benutzerkonten vorhanden', ok: usersOk, detail: `${keyTables.users ?? 0} Konten` });
    // 7. Audit-Kette mit dem Schlüssel aus der Sicherung prüfen, Ende mit dem laufenden Protokoll vergleichen
    const audit: DrillResult['audit'] = { ok: false, checked: 0, problems: 0, firstProblem: null, keyAvailable: false, matchesLive: null, lastSeq: null };
    const key = await chainKeyFrom(probe);
    if (key) {
      audit.keyAvailable = true;
      const s = await getSettings();
      const v = await verifyAudit(s['retention.audit_days'], { db: probe, key });
      audit.ok = v.ok;
      audit.checked = v.checked;
      audit.problems = v.problems.length;
      audit.firstProblem = v.problems[0]?.text ?? null;
      audit.lastSeq = v.last?.seq ?? null;
      if (v.last) {
        const live = await one<{ hash: string }>(`SELECT hash FROM audit_events WHERE chain_seq = $1`, [v.last.seq]);
        audit.matchesLive = live ? live.hash === v.last.hash : null;
      }
      checks.push({ step: 'Audit-Kette', ok: v.ok, detail: v.ok ? `${v.checked} versiegelte Einträge in Ordnung${v.unsealed ? `, ${v.unsealed} noch nicht versiegelt` : ''}` : (v.problems[0]?.text ?? 'Auffälligkeiten') });
      if (audit.matchesLive === false) checks.push({ step: 'Audit-Kette passt zum laufenden Protokoll', ok: false, detail: 'Ende der Kette weicht vom laufenden Protokoll ab' });
      else if (audit.matchesLive) checks.push({ step: 'Audit-Kette passt zum laufenden Protokoll', ok: true });
    } else {
      // Ohne Schlüssel (z. B. Sicherung vor einem Wechsel des Master-Schlüssels) nicht prüfbar – Hinweis, kein Fehler
      audit.ok = true;
      checks.push({ step: 'Audit-Kette', ok: true, detail: 'nicht prüfbar: Schlüssel der Kette in dieser Sicherung fehlt oder ist mit einem früheren Master-Schlüssel verschlüsselt' });
    }
    const result: DrillResult = {
      durationMs: Date.now() - started,
      sizeBytes,
      sha256: sha,
      tables: tables.length,
      rows,
      keyTables,
      migration: mig.m ?? null,
      migrations: Number(mig.n ?? 0),
      audit,
      checks,
    };
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw Object.assign(new Error(`Prüfung nicht bestanden: ${failed.map((c) => c.step).join(', ')}`), { result });
    await pool.query(`UPDATE restore_drills SET status = 'ok', finished_at = now(), result = $2, error = NULL WHERE id = $1`, [d.id, JSON.stringify(result)]);
    log('info', 'backup', `Probe-Wiederherstellung bestanden: ${d.file_name} (${d.source === 'offsite' ? 'vom Ziel außer Haus' : 'lokal'}, ${tables.length} Tabellen, ${rows} Zeilen, ${Math.round(result.durationMs / 1000)} s)`);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 1000);
    const result = (e as { result?: DrillResult }).result ?? { durationMs: Date.now() - started, checks: [...checks, { step: 'Abbruch', ok: false, detail: msg.slice(0, 300) }] };
    await pool.query(`UPDATE restore_drills SET status = 'failed', finished_at = now(), result = $2, error = $3 WHERE id = $1`, [d.id, JSON.stringify(result), msg]);
    log('error', 'backup', `Probe-Wiederherstellung fehlgeschlagen (${d.file_name}): ${msg}`);
    await notify({ kind: 'error', title: 'Probe-Wiederherstellung fehlgeschlagen', body: msg.slice(0, 300), link: '/einstellungen#sicherung-ausser-haus', permission: 'backup.manage' });
  } finally {
    await probe?.end().catch(() => {});
    if (created) {
      try {
        await dropProbeDatabase(admin, dbName);
      } catch (e) {
        log('warn', 'backup', `Probedatenbank ${dbName} ließ sich nicht löschen: ${(e as Error).message} – wird bei der nächsten Probe entfernt.`);
      }
    }
    await admin.end().catch(() => {});
    fs.rmSync(tmpFile, { force: true });
    fs.rmSync(dumpFile, { force: true });
    fs.rmSync(`${dumpFile}.part`, { force: true });
  }
}

/** Probe nach Zeitplan fällig? (eine Stunde nach der Sicherungszeit, wöchentlich bzw. monatlich) */
export async function drillDue(): Promise<boolean> {
  const c = await offsiteConfig();
  if (c.drill_interval === 'off') return false;
  const days = c.drill_interval === 'monthly' ? 30 : 7;
  const last = await one(`SELECT 1 FROM restore_drills WHERE trigger = 'schedule' AND created_at > now() - make_interval(days => $1) + interval '2 hours'`, [days]);
  return !last;
}

export async function recentDrills(limit = 20) {
  return many<any>(
    `SELECT d.id, d.source, d.file_name, d.trigger, d.status, d.created_at, d.started_at, d.finished_at, d.result, d.error, u.name AS created_by_name
       FROM restore_drills d LEFT JOIN users u ON u.id = d.created_by ORDER BY d.created_at DESC LIMIT $1`,
    [limit],
  );
}
