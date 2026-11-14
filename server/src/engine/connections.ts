import { one, pool } from '../db/pool.js';
import { readSecretJson } from '../lib/secrets.js';
import { getSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { StepError } from '../lib/errors.js';
import type { RuntimeConnection } from './types.js';

/** Lädt eine Verbindung inkl. entschlüsselter Geheimnisse – nur zur Laufzeit im Worker/Test. */
export async function loadRuntimeConnection(id: string | null | undefined): Promise<RuntimeConnection | null> {
  if (!id) return null;
  const row = await one<any>('SELECT id, name, connector, config, secret_id, status FROM connections WHERE id = $1', [id]);
  if (!row) throw new StepError('config', 'Die gewählte Verbindung existiert nicht mehr.');
  if (row.status === 'disabled') throw new StepError('config', `Die Verbindung „${row.name}“ ist deaktiviert.`);
  return { id: row.id, name: row.name, connector: row.connector, config: row.config ?? {}, secrets: await readSecretJson(row.secret_id) };
}

export async function markConnectionUsed(id: string, ok: boolean, message?: string) {
  if (ok) {
    await pool.query(`UPDATE connections SET last_used_at = now(), status = CASE WHEN status IN ('error','untested') THEN 'ok' ELSE status END, status_message = CASE WHEN status = 'error' THEN NULL ELSE status_message END WHERE id = $1`, [id]);
  } else {
    // Nur beim Wechsel in den Fehlerzustand benachrichtigen, nicht bei jedem weiteren Fehlschlag
    const changed = await one<{ name: string }>(
      `UPDATE connections SET last_used_at = now(), status = 'error', status_message = $2 WHERE id = $1 AND status NOT IN ('disabled','error') RETURNING name`,
      [id, (message ?? '').slice(0, 500)],
    );
    if (!changed) await pool.query(`UPDATE connections SET last_used_at = now(), status_message = $2 WHERE id = $1 AND status = 'error'`, [id, (message ?? '').slice(0, 500)]);
    if (changed && (await getSettings())['notify.on_connection_error']) {
      await notify({ kind: 'warning', title: `Verbindung „${changed.name}“ meldet einen Fehler`, body: (message ?? '').slice(0, 300), link: `/verbindungen/${id}`, permission: 'connection.read' });
    }
  }
}

/* Einfacher Circuit Breaker je Verbindung: nach 5 vorübergehenden Fehlern in Folge 60 s Pause,
   damit ein ausgefallenes Ziel nicht alle Worker blockiert. */
const breakers = new Map<string, { failures: number; openUntil: number }>();

export function breakerCheck(id: string) {
  const b = breakers.get(id);
  if (b && b.openUntil > Date.now()) {
    throw new StepError('transient', 'Zielsystem ist nach mehreren Fehlern kurz gesperrt (Schutzschaltung).', { retryAfterMs: b.openUntil - Date.now() });
  }
}

export function breakerResult(id: string, ok: boolean, transient: boolean) {
  if (ok) {
    breakers.delete(id);
    return;
  }
  if (!transient) return;
  const b = breakers.get(id) ?? { failures: 0, openUntil: 0 };
  b.failures++;
  if (b.failures >= 5) {
    b.openUntil = Date.now() + 60_000;
    b.failures = 0;
  }
  breakers.set(id, b);
}
