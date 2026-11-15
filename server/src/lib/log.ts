import { pool } from '../db/pool.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Strukturiertes Protokoll: Konsole (JSON) + Tabelle app_logs (ohne Geheimnisse/Inhalte). */
export function log(level: Level, source: string, message: string, details: Record<string, unknown> = {}, correlationId?: string) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    source,
    message,
    ...(correlationId ? { cid: correlationId } : {}),
    ...details,
  });
  if (!process.env.LOG_QUIET) {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level !== 'debug' || process.env.LOG_DEBUG) console.log(line);
  }
  if (level === 'debug' || process.env.BLAULICHTCMS_NO_DB_LOG) return;
  const detailsJson = JSON.stringify(details);
  pool
    .query('INSERT INTO app_logs (level, source, message, details, correlation_id) VALUES ($1,$2,$3,$4,$5)', [
      level,
      source,
      message.slice(0, 2000),
      detailsJson.length > 8000 ? '{"gekuerzt":true}' : detailsJson,
      correlationId ?? null,
    ])
    .catch(() => {});
}
