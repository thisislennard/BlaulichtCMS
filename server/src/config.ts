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

export const config = {
  version: readVersion(),
  env: env.NODE_ENV ?? 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 7310),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgresql://lifelink:lifelink@127.0.0.1:5432/lifelink',
  /** 32 Byte, Base64. Verschlüsselt alle gespeicherten Zugangsdaten. Liegt nie in der Datenbank. */
  masterKey: env.LIFELINK_MASTER_KEY ?? '',
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  trustProxy: bool(env.TRUST_PROXY, false),
  cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
  dataDir: path.resolve(env.LIFELINK_DATA_DIR ?? path.join(APP_ROOT, 'data')),
  webDist: path.join(APP_ROOT, 'web', 'dist'),
  pluginDir: path.join(APP_ROOT, 'wordpress-plugin', 'lifelink'),
  migrationsDir: path.join(APP_ROOT, 'server', 'migrations'),
  workerConcurrency: Number(env.WORKER_CONCURRENCY ?? 4),
  /** Nur für Tests/Entwicklung: private Ziele ohne Freigabe erlauben. */
  allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
  githubApiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
  defaultUpdateRepo: env.UPDATE_REPOSITORY ?? 'thisislennard/LifeLink',
};

export type Config = typeof config;
