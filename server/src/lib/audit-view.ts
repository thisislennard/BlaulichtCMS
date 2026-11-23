import { many } from '../db/pool.js';

/**
 * Lesbare Audit-Ansicht „Aktivitäten“ (#258): Bereich je Aktion (Filter) und ob das betroffene Objekt noch existiert
 * (Link „Öffnen“). Die Sätze stehen in web/src/i18n/de/activity.json; server/test/units.test.ts prüft, dass jede
 * Aktion aus `audit(…)` einen Satz hat und hier ausdrücklich einem Bereich zugeordnet ist – „System“ ist kein
 * Auffangbecken für neue Module.
 */
export const AUDIT_AREAS = ['editorial', 'calendar', 'media', 'incidents', 'banners', 'designs', 'press', 'warnings', 'channels', 'automations', 'user', 'system'] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

/** Bereich nach dem Präfix der Aktion („press.request_created“ → press). */
export const AUDIT_AREA_BY_PREFIX: Record<string, AuditArea> = {
  post: 'editorial',
  publication: 'editorial',
  template: 'editorial',
  social: 'editorial',
  social_page: 'editorial',
  social_feed: 'editorial',
  rss: 'editorial',
  import: 'editorial',
  calendar: 'calendar',
  collection: 'media',
  folder: 'media',
  media: 'media',
  upload_link: 'media',
  trash: 'media',
  design: 'media',
  job: 'media',
  incident: 'incidents',
  banner: 'banners',
  design_template: 'designs',
  press: 'press',
  warning: 'warnings',
  keywords: 'warnings',
  official_warning: 'warnings',
  site: 'channels',
  bridge: 'channels',
  connection: 'channels',
  fe2: 'channels',
  feuersoftware: 'channels',
  automation: 'automations',
  user: 'user',
  auth: 'user',
  setup: 'user',
  role: 'user',
  api_key: 'user',
  backup: 'system',
  update: 'system',
  updates: 'system',
  system: 'system',
  settings: 'system',
  audit: 'system',
  retention: 'system',
  privacy: 'system',
  access: 'system',
  dashboard: 'system',
  notify: 'system',
};

/**
 * Ausnahmen für einzelne Aktionen (gehen dem Präfix vor). Ergebnisse von Workflows (automation.post_created …) stehen
 * bewusst beim Workflow, Einsatzentwürfe aus FE2/Feuersoftware bei den Verbindungen.
 */
export const AUDIT_AREA_BY_ACTION: Record<string, AuditArea> = {
  // Push für das eigene Gerät gehört zum Konto, nicht zu den Systemeinstellungen
  'notify.push_subscribed': 'user',
  'notify.push_unsubscribed': 'user',
};

const prefixOf = (action: string) => action.split('.')[0];

/** Ausdrückliche Zuordnung (null = keine – der Test verlangt eine für jede Aktion aus dem Code). */
export function explicitAuditArea(action: string): AuditArea | null {
  return AUDIT_AREA_BY_ACTION[action] ?? AUDIT_AREA_BY_PREFIX[prefixOf(action)] ?? null;
}

/** Bereich einer Aktion; Unbekanntes (z. B. Aktionen früherer Versionen) zählt zu „System“. */
export function auditArea(action: string): AuditArea {
  return explicitAuditArea(action) ?? 'system';
}

/**
 * SQL-Bedingung für einen Bereich – dieselbe Zuordnung wie auditArea(), damit „Ältere laden“ im gefilterten Bereich
 * vollständig ist. „System“ ist der Rest (alles, was keinem anderen Bereich angehört).
 */
export function auditAreaCondition(area: AuditArea, params: unknown[]): string {
  if (area === 'system') {
    return `NOT (${AUDIT_AREAS.filter((a) => a !== 'system')
      .map((a) => auditAreaCondition(a, params))
      .join(' OR ')})`;
  }
  const prefixes = Object.keys(AUDIT_AREA_BY_PREFIX).filter((p) => AUDIT_AREA_BY_PREFIX[p] === area);
  const actions = Object.keys(AUDIT_AREA_BY_ACTION).filter((a) => AUDIT_AREA_BY_ACTION[a] === area);
  const elsewhere = Object.keys(AUDIT_AREA_BY_ACTION).filter((a) => AUDIT_AREA_BY_ACTION[a] !== area && AUDIT_AREA_BY_PREFIX[prefixOf(a)] === area);
  params.push(prefixes, actions, elsewhere);
  const n = params.length;
  return `((split_part(action, '.', 1) = ANY($${n - 2}::text[]) AND NOT (action = ANY($${n}::text[]))) OR action = ANY($${n - 1}::text[]))`;
}

/**
 * Objekte mit eigener Seite: Gibt es sie noch? (Papierkorb und gelöschte Verbindungen zählen als weg; Banner nur,
 * solange die Banner-Seite sie zeigt.) `parent` = Sammlung bei Dateien, Ordnern und Upload-Links.
 */
const OBJECT_QUERIES: Record<string, string> = {
  post: `SELECT id::text AS id, NULL::text AS parent FROM posts WHERE id = ANY($1::uuid[])`,
  collection: `SELECT id::text AS id, NULL::text AS parent FROM collections WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
  media: `SELECT id::text AS id, collection_id::text AS parent FROM media WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
  folder: `SELECT id::text AS id, collection_id::text AS parent FROM collection_folders WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
  upload_link: `SELECT id::text AS id, collection_id::text AS parent FROM upload_links WHERE id = ANY($1::uuid[])`,
  warning: `SELECT id::text AS id, NULL::text AS parent FROM warnings WHERE id = ANY($1::uuid[])`,
  design_template: `SELECT id::text AS id, NULL::text AS parent FROM design_templates WHERE id = ANY($1::uuid[])`,
  connection: `SELECT id::text AS id, NULL::text AS parent FROM connections WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
  automation: `SELECT id::text AS id, NULL::text AS parent FROM automations WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
  incident: `SELECT id::text AS id, NULL::text AS parent FROM incident_entries WHERE id = ANY($1::uuid[])`,
  press_request: `SELECT id::text AS id, NULL::text AS parent FROM press_requests WHERE id = ANY($1::uuid[])`,
  press_release: `SELECT id::text AS id, NULL::text AS parent FROM press_releases WHERE id = ANY($1::uuid[])`,
  calendar_event: `SELECT id::text AS id, NULL::text AS parent FROM calendar_events WHERE id = ANY($1::uuid[])`,
  banner: `SELECT id::text AS id, NULL::text AS parent FROM banners WHERE id = ANY($1::uuid[]) AND (ended_at IS NULL OR ended_at > now() - interval '30 days')`,
};
export const LINKED_OBJECT_TYPES = Object.keys(OBJECT_QUERIES);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditViewFields {
  area: AuditArea;
  /** null = Objektart ohne eigene Seite (nicht geprüft) */
  object_exists: boolean | null;
  object_parent: string | null;
}

/** Bereich und Objektstand für eine Seite von Audit-Einträgen – je Objektart eine Abfrage. */
export async function auditViewFields<T extends { action: string; object_type: string | null; object_id: string | null }>(rows: T[]): Promise<(T & AuditViewFields)[]> {
  const wanted = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.object_type || !r.object_id || !OBJECT_QUERIES[r.object_type] || !UUID.test(r.object_id)) continue;
    if (!wanted.has(r.object_type)) wanted.set(r.object_type, new Set());
    wanted.get(r.object_type)!.add(r.object_id.toLowerCase());
  }
  const found = new Map<string, Map<string, string | null>>();
  for (const [type, ids] of wanted) {
    const res = await many<{ id: string; parent: string | null }>(OBJECT_QUERIES[type], [[...ids]]);
    found.set(type, new Map(res.map((x) => [x.id, x.parent])));
  }
  return rows.map((r) => {
    const checked = !!r.object_type && !!r.object_id && !!OBJECT_QUERIES[r.object_type];
    const hit = checked && UUID.test(r.object_id!) ? found.get(r.object_type!)?.get(r.object_id!.toLowerCase()) : undefined;
    return { ...r, area: auditArea(r.action), object_exists: checked ? hit !== undefined : null, object_parent: hit ?? null };
  });
}
