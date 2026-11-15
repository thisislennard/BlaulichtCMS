import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { aad, decrypt, deriveKey, encrypt, fingerprint, masterKey } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { supervisorPidFile } from './datadir.js';

/**
 * Wechsel des Master-Schlüssels (#134, BSI CON.1) – `node server/dist/cli.js rotate-master-key`.
 *
 * Mit dem Master-Schlüssel verschlüsselt bzw. aus ihm abgeleitet sind:
 *   - `secrets.ciphertext` (Zugangsdaten der Verbindungen, SMTP-Passwort, Schlüssel der Audit-Kette …) → neu verschlüsselt,
 *     `secrets.fingerprint` (HMAC mit abgeleitetem Schlüssel) → neu berechnet
 *   - `users.totp_secret_enc` → neu verschlüsselt
 *   - `upload_links.token_enc` → neu verschlüsselt
 *   - Datenbanksicherungen unter /data/backups (abgeleiteter Schlüssel „backup“) → neu verschlüsselt
 *   - Wiederherstellungscodes im Format `h1:` (HMAC mit „recovery-code“, #130) → lassen sich nicht umschlüsseln und
 *     werden entfernt; die Betroffenen werden benachrichtigt und müssen neue Codes erzeugen (die Profilseite fordert
 *     bei 0 verbleibenden Codes dazu auf). Ältere Codes (ungesalzenes SHA-256) bleiben gültig.
 *   - Kurzlebige Werte (Geräte-Cookie der Kontosperre, signierte Plugin-Downloadlinks) werden einfach ungültig.
 * Die Hash-Kette des Audits bleibt gültig: Ihr Schlüssel ist ein zufälliges Geheimnis in `secrets`.
 *
 * Ablauf: Wartungsmodus muss aktiv sein → API und Worker werden über den Supervisor angehalten (SIGUSR1), damit kein
 * Prozess mit dem alten Schlüssel weiterschreibt → alter Schlüssel als `master.key.alt-<zeit>` (0600) gesichert, neuer
 * als `master.key.neu` geschrieben → alles in **einer** Transaktion neu verschlüsselt und geprüft → `master.key.neu`
 * ersetzt `master.key` → API und Worker starten mit dem neuen Schlüssel (SIGUSR2). Schlägt etwas vor dem Commit fehl,
 * bleibt alles beim alten Schlüssel.
 */

export interface ReencryptResult {
  secrets: number;
  totp: number;
  links: number;
  recoveryUsers: { id: string; email: string }[];
}

/** Alle verschlüsselten Felder in der übergebenen Transaktion neu verschlüsseln (bricht beim ersten Fehler ab). */
export async function reencryptDatabase(db: pg.PoolClient, oldKey: Buffer, newKey: Buffer): Promise<ReencryptResult> {
  // Schreibende Zugriffe auf die betroffenen Tabellen bis zum Commit anhalten
  await db.query('LOCK TABLE secrets, users, upload_links IN SHARE ROW EXCLUSIVE MODE');
  const fail = (what: string, e: unknown) => {
    throw new Error(`${what}: ${(e as Error).message} – nichts wurde geändert.`);
  };

  const secrets = (await db.query<{ id: string; owner_type: string; owner_id: string; version: number; ciphertext: string }>(
    'SELECT id, owner_type, owner_id, version, ciphertext FROM secrets ORDER BY id',
  )).rows;
  for (const s of secrets) {
    const purpose = aad.secret(s.owner_type, s.owner_id, s.version);
    let plain = '';
    try {
      plain = decrypt(s.ciphertext, purpose, oldKey);
    } catch (e) {
      fail(`Geheimnis ${s.id} (${s.owner_type}) lässt sich nicht entschlüsseln`, e);
    }
    await db.query('UPDATE secrets SET ciphertext = $2, fingerprint = $3 WHERE id = $1', [s.id, encrypt(plain, purpose, newKey), fingerprint(plain, newKey)]);
  }

  const users = (await db.query<{ id: string; email: string; totp_secret_enc: string }>('SELECT id, email, totp_secret_enc FROM users WHERE totp_secret_enc IS NOT NULL')).rows;
  for (const u of users) {
    let plain = '';
    try {
      plain = decrypt(u.totp_secret_enc, aad.totp(u.id), oldKey);
    } catch (e) {
      fail(`Zwei-Faktor-Geheimnis von ${u.email} lässt sich nicht entschlüsseln`, e);
    }
    await db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [u.id, encrypt(plain, aad.totp(u.id), newKey)]);
  }

  const links = (await db.query<{ id: string; token_enc: string }>('SELECT id, token_enc FROM upload_links WHERE token_enc IS NOT NULL')).rows;
  for (const l of links) {
    let plain = '';
    try {
      plain = decrypt(l.token_enc, aad.uploadLink(l.id), oldKey);
    } catch (e) {
      fail(`Upload-Link ${l.id} lässt sich nicht entschlüsseln`, e);
    }
    await db.query('UPDATE upload_links SET token_enc = $2 WHERE id = $1', [l.id, encrypt(plain, aad.uploadLink(l.id), newKey)]);
  }

  // HMAC-Wiederherstellungscodes (#130) sind an den alten Schlüssel gebunden: entfernen statt still ungültig lassen
  const recoveryUsers = (await db.query<{ id: string; email: string }>(
    `UPDATE users SET recovery_codes = ARRAY(SELECT c FROM unnest(recovery_codes) AS c WHERE c NOT LIKE 'h1:%')
      WHERE EXISTS (SELECT 1 FROM unnest(recovery_codes) AS c WHERE c LIKE 'h1:%') RETURNING id, email`,
  )).rows;

  // Geräte-Cookies sind mit einem aus dem Master-Schlüssel abgeleiteten Schlüssel signiert und werden ungültig:
  // vertrauenswürdige Geräte und gemerkte Sitzungen ausdrücklich beenden statt sie still ins Leere laufen zu lassen
  await db.query('UPDATE trusted_devices SET revoked_at = now() WHERE revoked_at IS NULL');
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE remember AND stage = 'full' AND revoked_at IS NULL`);

  // Gegenprobe vor dem Commit: alles mit dem neuen Schlüssel lesbar
  for (const s of (await db.query('SELECT owner_type, owner_id, version, ciphertext FROM secrets')).rows) decrypt(s.ciphertext, aad.secret(s.owner_type, s.owner_id, s.version), newKey);
  for (const u of (await db.query('SELECT id, totp_secret_enc FROM users WHERE totp_secret_enc IS NOT NULL')).rows) decrypt(u.totp_secret_enc, aad.totp(u.id), newKey);
  for (const l of (await db.query('SELECT id, token_enc FROM upload_links WHERE token_enc IS NOT NULL')).rows) decrypt(l.token_enc, aad.uploadLink(l.id), newKey);

  return { secrets: secrets.length, totp: users.length, links: links.length, recoveryUsers };
}

/* ------------------------------ API und Worker anhalten ------------------------------ */

const APP_CONNECTIONS = `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name IN ('blaulichtcms-api', 'blaulichtcms-worker', 'blaulichtcms-worker-listen')`;

function supervisorPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(supervisorPidFile(), 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function waitForNoAppConnections(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const n = (await pool.query(APP_CONNECTIONS)).rows[0].n;
    if (n === 0) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/* ------------------------------------- Ablauf ---------------------------------------- */

export interface RotateResult extends ReencryptResult {
  keySource: 'file' | 'env';
  newKeyBase64: string | null;
  oldKeyBackup: string | null;
  backups: { file: string; ok: boolean; error?: string }[];
  resumed: boolean;
}

export async function rotateMasterKey(log: (msg: string) => void = console.log): Promise<RotateResult> {
  const s = await getSettings(true);
  if (!s['system.maintenance']) {
    throw new Error('Zuerst den Wartungsmodus einschalten: node server/dist/cli.js maintenance on "Schlüsselwechsel"');
  }
  const keySource: 'file' | 'env' = process.env.BLAULICHTCMS_MASTER_KEY?.trim() ? 'env' : 'file';
  const keyFile = path.join(config.dataDir, 'secrets', 'master.key');
  if (keySource === 'file' && !fs.existsSync(keyFile)) throw new Error(`Schlüsseldatei ${keyFile} nicht gefunden.`);
  const oldKey = masterKey();
  const newKey = crypto.randomBytes(32);
  const newKeyB64 = newKey.toString('base64');

  // API und Worker anhalten, damit niemand mehr mit dem alten Schlüssel schreibt
  const pid = supervisorPid();
  let paused = false;
  if (pid) {
    log('API und Worker werden angehalten …');
    process.kill(pid, 'SIGUSR1');
    paused = true;
  }
  const resume = () => {
    if (paused && pid) {
      process.kill(pid, 'SIGUSR2');
      paused = false;
      return true;
    }
    return false;
  };

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backupFile = keySource === 'file' ? `${keyFile}.alt-${stamp}` : null;
  const nextFile = `${keyFile}.neu`;
  let committed = false;
  let result: ReencryptResult;
  try {
    if (!(await waitForNoAppConnections(pid ? 90_000 : 0))) {
      throw new Error('API oder Worker sind noch mit der Datenbank verbunden. Ohne Supervisor beide Prozesse vorher beenden.');
    }
    if (keySource === 'file') {
      fs.copyFileSync(keyFile, backupFile!, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupFile!, 0o600);
      fs.rmSync(nextFile, { force: true });
      fs.writeFileSync(nextFile, newKeyB64 + '\n', { mode: 0o600, flag: 'wx' });
    }
    result = await tx((db) => reencryptDatabase(db, oldKey, newKey));
    committed = true;
    if (keySource === 'file') fs.renameSync(nextFile, keyFile);
  } catch (e) {
    if (!committed) {
      fs.rmSync(nextFile, { force: true });
      if (backupFile) fs.rmSync(backupFile, { force: true });
      resume();
      throw e;
    }
    // Commit erfolgt, aber die neue Schlüsseldatei konnte nicht an ihren Platz: API/Worker NICHT mit altem Schlüssel starten
    throw new Error(
      `Die Datenbank ist bereits mit dem NEUEN Schlüssel verschlüsselt, aber ${keyFile} konnte nicht ersetzt werden (${(e as Error).message}). ` +
        `Den neuen Schlüssel aus ${nextFile} von Hand nach ${keyFile} verschieben und den Container neu starten.`,
    );
  }

  // Datenbanksicherungen im Volume mit dem neuen abgeleiteten Schlüssel neu verschlüsseln
  const backups: RotateResult['backups'] = [];
  const { backupDir, reencryptBackup } = await import('./backup.js');
  const dir = backupDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bcbk')) : [];
  for (const f of files) {
    try {
      const sha = await reencryptBackup(path.join(dir, f), deriveKey('backup', oldKey), deriveKey('backup', newKey));
      await pool.query('UPDATE backups SET sha256 = $2 WHERE file_name = $1', [f, sha]);
      backups.push({ file: f, ok: true });
    } catch (e) {
      backups.push({ file: f, ok: false, error: (e as Error).message });
    }
  }

  // Bei externem Schlüssel (Umgebung) erst nach dem Eintragen des neuen Werts starten
  const resumed = keySource === 'file' ? resume() : false;
  return { ...result!, keySource, newKeyBase64: keySource === 'env' ? newKeyB64 : null, oldKeyBackup: backupFile, backups, resumed };
}

