import { pool, type Queryable } from '../db/pool.js';
import { forwardAudit } from './audit-forward.js';

export interface Actor {
  id: string | null;
  name: string;
  type: 'user' | 'api_key' | 'system';
  ip?: string | null;
}

/**
 * IP-Adressen ohne Benutzerkonto kürzen (#115): Audit-Einträge ohne actor_id (öffentliche Uploads, Anmeldeversuche
 * mit unbekanntem Konto, Bridge-/FE2-Fehlversuche) behalten die IP nur `days` Tage – genug zur Missbrauchsabwehr.
 * Danach steht „entfernt“ statt der Adresse. Einträge angemeldeter Personen folgen retention.audit_days.
 */
export async function redactAnonymousIps(days: number, db: Queryable = pool): Promise<number> {
  const d = Math.max(1, Math.floor(Number(days) || 30));
  const r = await db.query(
    `UPDATE audit_events SET ip = 'entfernt' WHERE actor_id IS NULL AND ip IS NOT NULL AND ip <> 'entfernt' AND at < now() - make_interval(days => $1)`,
    [d],
  );
  return r.rowCount ?? 0;
}

export const SYSTEM_ACTOR: Actor = { id: null, name: 'System', type: 'system' };

/** Audit-Ereignis: Akteur, Aktion, Objekt, Zeit, Ergebnis – nie Geheimnisse oder Einsatzinhalte. */
export async function audit(
  actor: Actor,
  action: string,
  object: { type?: string; id?: string | number | null; label?: string | null } = {},
  details: Record<string, unknown> = {},
  result: 'ok' | 'failed' | 'denied' = 'ok',
  db: Queryable = pool,
) {
  const r = await db.query(
    `INSERT INTO audit_events (actor_id, actor_name, actor_type, action, object_type, object_id, object_label, result, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, at`,
    [
      actor.id,
      actor.name,
      actor.type,
      action,
      object.type ?? null,
      object.id != null ? String(object.id) : null,
      object.label ?? null,
      result,
      JSON.stringify(details),
      actor.ip ?? null,
    ],
  );
  // Zusätzlich an die zentrale Protokollierung (AUDIT_FORWARD, #112)
  forwardAudit({
    type: 'audit',
    id: Number(r.rows[0].id),
    at: r.rows[0].at,
    actor: { id: actor.id, name: actor.name, type: actor.type },
    action,
    object: { type: object.type ?? null, id: object.id != null ? String(object.id) : null, label: object.label ?? null },
    result,
    details,
    ip: actor.ip ?? null,
  });
}

/**
 * Gedrosseltes Audit für Ereignisse, die in Serie auftreten können (verweigerte Zugriffe, falsche Bridge- oder
 * FE2-Schlüssel, #111): je Schlüssel höchstens ein Eintrag pro Zeitfenster. Unterdrückte Wiederholungen werden beim
 * nächsten Eintrag mitgezählt (`unterdrueckte_wiederholungen`). Der Zähler lebt im Speicher des API-Prozesses.
 */
const throttle = new Map<string, { until: number; suppressed: number }>();
export async function auditThrottled(
  key: string,
  windowMs: number,
  actor: Actor,
  action: string,
  object: { type?: string; id?: string | number | null; label?: string | null },
  details: Record<string, unknown>,
  result: 'ok' | 'failed' | 'denied',
): Promise<boolean> {
  const now = Date.now();
  const t = throttle.get(key);
  if (t && t.until > now) {
    t.suppressed++;
    return false;
  }
  if (throttle.size > 5000) {
    for (const [k, v] of throttle) if (v.until <= now && !v.suppressed) throttle.delete(k);
    if (throttle.size > 5000) throttle.clear();
  }
  throttle.set(key, { until: now + windowMs, suppressed: 0 });
  await audit(actor, action, object, t?.suppressed ? { ...details, unterdrueckte_wiederholungen: t.suppressed } : details, result);
  return true;
}

/** Nur für Tests: Drosselung zurücksetzen. */
export function resetAuditThrottle() {
  throttle.clear();
}

/** Einstellungsänderung fürs Audit: vorher/nachher je tatsächlich geändertem Schlüssel, Geheimnisse ausgenommen. */
export function settingsDiff(before: Record<string, unknown>, patch: Record<string, unknown>) {
  const out: Record<string, { vorher: unknown; nachher: unknown }> = {};
  const clip = (v: unknown) => {
    const j = JSON.stringify(v ?? null);
    return j.length > 500 ? `${j.slice(0, 500)}…` : v;
  };
  for (const [k, v] of Object.entries(patch)) {
    if (JSON.stringify(before[k] ?? null) === JSON.stringify(v ?? null)) continue;
    out[k] = /password|secret|token/i.test(k) ? { vorher: '(geändert)', nachher: '(geändert)' } : { vorher: clip(before[k]), nachher: clip(v) };
  }
  return out;
}
