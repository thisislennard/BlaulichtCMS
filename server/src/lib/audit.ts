import { pool, type Queryable } from '../db/pool.js';

export interface Actor {
  id: string | null;
  name: string;
  type: 'user' | 'api_key' | 'system';
  ip?: string | null;
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
  await db.query(
    `INSERT INTO audit_events (actor_id, actor_name, actor_type, action, object_type, object_id, object_label, result, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
}
