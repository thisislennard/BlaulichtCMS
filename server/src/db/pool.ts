import pg from 'pg';
import { config } from '../config.js';

// Zeitstempel als Date, bigint (Lauf-IDs, Zähler) als number – Werte bleiben weit unter 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

const role = process.env.BLAULICHTCMS_ROLE ?? 'api';
/** Nur der vom Supervisor gestartete API-Prozess (Umgebung gesetzt) – nicht Kommandozeile, Tests oder Worker. */
const isApiProcess = process.env.BLAULICHTCMS_ROLE === 'api';

/**
 * Zeitgrenzen der API-Verbindungen (#192): Eine hängende Abfrage oder eine offen gelassene Transaktion hält sonst eine
 * der 10 Verbindungen dauerhaft fest – sind alle belegt, warten sämtliche Anfragen (auch die Sitzungsprüfung) und die
 * Oberfläche „hängt“. Die API bricht Abfragen nach 60 s und untätige Transaktionen nach 60 s ab; Worker und
 * Kommandozeile (Sicherung, Import, Wiederherstellung) bleiben ohne Grenze.
 */
export const API_STATEMENT_TIMEOUT_MS = 60_000;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: `blaulichtcms-${role}`,
  ...(isApiProcess ? { statement_timeout: API_STATEMENT_TIMEOUT_MS, idle_in_transaction_session_timeout: API_STATEMENT_TIMEOUT_MS } : {}),
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
