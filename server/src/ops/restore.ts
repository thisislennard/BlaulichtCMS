import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { config } from '../config.js';
import { backupDir, decryptBackup } from './backup.js';

/**
 * Rückweg eines In-App-Updates (vom Supervisor über `cli.js update-restore` aufgerufen, API und Worker gestoppt):
 * die vor dem Update erstellte Datenbanksicherung zurückspielen.
 *
 * Ablauf ohne Datenverlust bei einem Fehler: Schema `public` umbenennen, leeres `public` anlegen, Sicherung mit
 * `pg_restore --single-transaction --exit-on-error` einspielen. Gelingt das, wird das umbenannte Schema gelöscht;
 * sonst wird das neue verworfen und das alte zurückbenannt. Eigentum und Rechte der Datenbankrollen setzt der
 * anschließende Migrationsschritt der vorigen Version neu (db/roles.ts).
 */
export async function restoreBackupForRollback(file: string, say: (m: string) => void = () => {}) {
  const src = path.resolve(file);
  if (path.dirname(src) !== path.resolve(backupDir()) || !src.endsWith('.bcbk') || !fs.existsSync(src)) {
    throw new Error(`Sicherung nicht gefunden oder nicht im Sicherungsordner: ${file}`);
  }
  const dump = path.join(backupDir(), `.rueckweg-${crypto.randomBytes(4).toString('hex')}.dump`);
  const client = new pg.Client({ connectionString: config.adminDatabaseUrl, application_name: 'blaulichtcms-restore' });
  const keep = `public_vor_rueckweg_${Date.now()}`;
  let renamed = false;
  await client.connect();
  try {
    const su = (await client.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]?.rolsuper;
    if (!su) throw new Error('Zum Zurückspielen wird eine Superuser-Verbindung gebraucht (DATABASE_ADMIN_URL).');
    say(`Entschlüssele ${path.basename(src)} …`);
    await decryptBackup(src, dump);
    // Andere Verbindungen (z. B. hängende Prozesse der neuen Version) beenden
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    await client.query(`ALTER SCHEMA public RENAME TO ${keep}`);
    renamed = true;
    await client.query(`CREATE SCHEMA public`);
    say('Spiele die Sicherung ein …');
    const err = await new Promise<string | null>((resolve) => {
      const p = spawn(process.env.PG_RESTORE ?? 'pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${config.adminDatabaseUrl}`, dump], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ENOENT' ? 'pg_restore ist nicht installiert oder nicht im PATH (PG_RESTORE setzen).' : e.message));
      p.on('close', (code) => resolve(code === 0 ? null : `pg_restore beendet mit Code ${code}: ${out.trim().slice(-800)}`));
    });
    if (err) {
      await client.query(`DROP SCHEMA public CASCADE`);
      await client.query(`ALTER SCHEMA ${keep} RENAME TO public`);
      renamed = false;
      throw new Error(`${err} – der Stand nach dem Update bleibt erhalten.`);
    }
    await client.query(`DROP SCHEMA ${keep} CASCADE`);
    renamed = false;
    // Die Sicherung wurde erstellt, während ihr eigener Eintrag noch „läuft“ – nach dem Zurückspielen stünde sie
    // sonst dauerhaft als laufend da und sperrte weitere Sicherungen. Sie ist geprüft und vollständig.
    const size = fs.statSync(src).size;
    const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    await client.query(`UPDATE backups SET status = 'ok', finished_at = now(), size_bytes = $2, sha256 = $3 WHERE file_name = $1 AND status = 'running'`, [path.basename(src), size, sha]);
    await client.query(`UPDATE backups SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Rückweg eines Updates)' WHERE status = 'running'`);
  } catch (e) {
    if (renamed) {
      // Abbruch zwischen Umbenennen und Einspielen: alten Stand wiederherstellen
      await client.query(`DROP SCHEMA IF EXISTS public CASCADE`).catch(() => {});
      await client.query(`ALTER SCHEMA ${keep} RENAME TO public`).catch(() => {});
    }
    throw e;
  } finally {
    fs.rmSync(dump, { force: true });
    await client.end().catch(() => {});
  }
}
