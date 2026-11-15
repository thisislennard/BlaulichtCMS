import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { pool, type Queryable } from './pool.js';
import { OWNER_ROLE, ensureRoles, grantAppRole, isSuperuser } from './roles.js';

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
export async function schemaCompatibility(dir = config.migrationsDir, db: Queryable | pg.Client = pool): Promise<{ applied: string[]; pending: string[]; unknown: string[] }> {
  const files = migrationFiles(dir);
  const exists = (await db.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS e`)).rows[0].e;
  const applied: string[] = exists ? (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name) : [];
  return { applied, pending: files.filter((f) => !applied.includes(f)), unknown: applied.filter((a) => !files.includes(a)) };
}

/**
 * Führt alle noch fehlenden Migrationen aus, jede in eigener Transaktion, unter Advisory-Lock.
 *
 * `admin: true` (Kommandozeile `migrate`, vom Supervisor vor dem Start aufgerufen) verbindet sich mit
 * `config.adminDatabaseUrl`. Mit getrennten Rollen (`config.dbRoles`, im Container Standard, #102) und einer
 * Superuser-Verbindung werden vorher die Rollen eingerichtet (db/roles.ts), die Migrationen laufen als Eigentümerrolle
 * (`SET ROLE blaulichtcms_owner`) und danach bekommt die Laufzeitrolle ihre Rechte. Das geschieht bei jedem Start, auch
 * ohne neue Migration – so werden bestehende Installationen und eingespielte Sicherungen von selbst umgestellt.
 * API und Worker rufen migrate() mit der Laufzeitrolle auf: Ist nichts offen, ändern sie nichts.
 */
export async function migrate(log: (msg: string) => void = console.log, dir = config.migrationsDir, opts: { admin?: boolean } = {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: opts.admin ? config.adminDatabaseUrl : config.databaseUrl, application_name: 'blaulichtcms-migrate' });
  await client.connect();
  const applied: string[] = [];
  let locked = false;
  try {
    const compat = await schemaCompatibility(dir, client);
    if (compat.unknown.length) {
      throw new SchemaNewerError(
        `Der Datenstand ist neuer als dieses Programm (unbekannte Migrationen: ${compat.unknown.join(', ')}). ` +
          'Entweder das passende neuere Image verwenden oder die Sicherung von vor dem Update wiederherstellen (docs/betrieb.md, „Rückweg“).',
      );
    }
    const roles = config.dbRoles && (await isSuperuser(client));
    if (!compat.pending.length && !roles) return applied;
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    locked = true;
    if (roles) {
      await ensureRoles(client);
      await client.query(`SET ROLE ${OWNER_ROLE}`);
    }
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
    if (roles) {
      await client.query('RESET ROLE');
      await grantAppRole(client);
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end().catch(() => {});
  }
  return applied;
}
