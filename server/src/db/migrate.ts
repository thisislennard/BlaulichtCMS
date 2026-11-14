import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { pool } from './pool.js';

const LOCK_ID = 74_210_001;

export class SchemaNewerError extends Error {}

/** Migrationsdateien dieses Images (sortiert). */
export function migrationFiles(dir = config.migrationsDir): string[] {
  return fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
}

/**
 * Startprüfung: Kennt die Datenbank Migrationen, die dieses Image nicht enthält, ist der Datenstand neuer als das
 * Programm (z. B. Rückkehr zu einem älteren Image ohne passende Sicherung). Dann wird nicht gestartet.
 */
export async function schemaCompatibility(dir = config.migrationsDir): Promise<{ applied: string[]; pending: string[]; unknown: string[] }> {
  const files = migrationFiles(dir);
  const exists = (await pool.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS e`)).rows[0].e;
  const applied: string[] = exists ? (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name) : [];
  return { applied, pending: files.filter((f) => !applied.includes(f)), unknown: applied.filter((a) => !files.includes(a)) };
}

/** Führt alle noch fehlenden Migrationen aus, jede in eigener Transaktion, unter Advisory-Lock. */
export async function migrate(log: (msg: string) => void = console.log, dir = config.migrationsDir): Promise<string[]> {
  const compat = await schemaCompatibility(dir);
  if (compat.unknown.length) {
    throw new SchemaNewerError(
      `Der Datenstand ist neuer als dieses Programm (unbekannte Migrationen: ${compat.unknown.join(', ')}). ` +
        'Entweder das passende neuere Image verwenden oder die Sicherung von vor dem Update wiederherstellen (docs/betrieb.md, „Rückweg“).',
    );
  }
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = migrationFiles(dir);
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} fehlgeschlagen: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`Migration angewendet: ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
