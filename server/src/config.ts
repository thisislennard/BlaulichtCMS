import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Programmverzeichnis (enthält VERSION, server/, web/). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(): string {
  try {
    return fs.readFileSync(path.join(APP_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const env = process.env;
const dataDir = path.resolve(env.LIFELINK_DATA_DIR ?? path.join(APP_ROOT, 'data'));

/** Master-Schlüssel: Umgebungsvariable hat Vorrang, sonst die beim ersten Containerstart erzeugte Datei. */
function readMasterKey(): string {
  if (env.LIFELINK_MASTER_KEY?.trim()) return env.LIFELINK_MASTER_KEY.trim();
  try {
    return fs.readFileSync(path.join(dataDir, 'secrets', 'master.key'), 'utf8').trim();
  } catch {
    return '';
  }
}

export const config = {
  version: readVersion(),
  env: env.NODE_ENV ?? 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 7310),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgresql://lifelink:lifelink@127.0.0.1:5432/lifelink',
  /** 32 Byte, Base64. Verschlüsselt alle gespeicherten Zugangsdaten. Liegt nie in der Datenbank. */
  masterKey: readMasterKey(),
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  trustProxy: bool(env.TRUST_PROXY, false),
  cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  webDist: path.join(APP_ROOT, 'web', 'dist'),
  pluginDir: path.join(APP_ROOT, 'wordpress-plugin', 'lifelink-bridge'),
  migrationsDir: path.join(APP_ROOT, 'server', 'migrations'),
  /** Im Container: PostgreSQL wird vom Supervisor unter /data/postgres betrieben. */
  embeddedDb: bool(env.LIFELINK_EMBEDDED_DB, false),
  /** Nur für Tests/Entwicklung: private Ziele ohne Freigabe erlauben. */
  allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
};

export type Config = typeof config;
