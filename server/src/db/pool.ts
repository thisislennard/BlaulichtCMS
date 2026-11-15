import pg from 'pg';
import { config } from '../config.js';

// Zeitstempel als Date, bigint (Lauf-IDs, Zähler) als number – Werte bleiben weit unter 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: `blaulichtcms-${process.env.BLAULICHTCMS_ROLE ?? 'api'}`,
});

pool.on('error', (err) => {
  console.error('[db] Verbindungsfehler im Pool:', err.message);
});

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool) {
  return db.query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | null> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
