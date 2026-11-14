import fs from 'node:fs';
import { config } from '../config.js';
import { one } from '../db/pool.js';
import { getSettings } from '../lib/settings.js';
import { freeBytes } from '../media/storage.js';

/**
 * Bereitschaft: LifeLink kann Aufträge annehmen, wenn die Datenbank antwortet, das Schema aktuell ist,
 * mindestens ein Worker lebt und genug Speicher frei ist. Wird vom Docker-Healthcheck genutzt.
 */
export async function healthStatus() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    await one('SELECT 1');
    checks.database = { ok: true, detail: 'erreichbar' };
  } catch (e) {
    checks.database = { ok: false, detail: `nicht erreichbar: ${(e as Error).message}` };
    return { ok: false, version: config.version, checks };
  }
  try {
    const files = fs.readdirSync(config.migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f));
    const applied = await one<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations WHERE name = ANY($1)', [files]);
    checks.schema = { ok: applied!.n === files.length, detail: `${applied!.n}/${files.length} Migrationen` };
  } catch {
    checks.schema = { ok: false, detail: 'Schema nicht initialisiert' };
  }
  const w = await one<{ n: number }>(`SELECT count(*)::int AS n FROM worker_heartbeats WHERE last_seen_at > now() - interval '45 seconds'`).catch(() => ({ n: 0 }));
  checks.worker = { ok: w!.n > 0, detail: w!.n > 0 ? `${w!.n} aktiv` : 'kein Worker aktiv' };
  const free = freeBytes();
  const min = (await getSettings().catch(() => null))?.['media.min_free_gb'] ?? 2;
  checks.storage = { ok: free === null || free >= min * 1024 ** 3, detail: free === null ? 'unbekannt' : `${(free / 1024 ** 3).toFixed(1)} GB frei` };
  return { ok: Object.values(checks).every((c) => c.ok), version: config.version, checks };
}
