/**
 * Dashboard-Layout: Widget-Verzeichnis, Normalisierung und Prüfung.
 *
 * Ein Layout besteht aus
 *  - `badges`: geordnete Reihe kompakter Kennzahl-Kacheln,
 *  - `columns`: bis zu vier Spalten mit Gewicht (2 = schmal, 3 = normal, 5 = breit) und den Kacheln darin,
 *  - `mobile`: eigene Reihenfolge der Kacheln für schmale Bildschirme.
 *
 * Diese Datei ist die EINE Stelle, an der steht, welches Widget welches Recht braucht. Alles, was gespeichert oder
 * ausgeliefert wird, läuft durch `normalizeLayout` – so sieht niemand ein Widget, für das das Recht fehlt, und
 * ältere gespeicherte Layouts (`{ desktop: [{ id, size }], mobile }`) funktionieren ohne Datenmigration weiter.
 *
 * Bewusst ohne Datenbank- und Fastify-Importe: reine Funktionen, direkt testbar.
 */

export interface WidgetDef {
  id: string;
  /** badge = Kennzahl in der oberen Reihe; panel = Kachel in einer Spalte */
  kind: 'badge' | 'panel';
  /** Recht, ohne das das Widget weder angeboten noch gespeichert noch ausgeliefert wird */
  permission: string;
}

export const WIDGET_DEFS: readonly WidgetDef[] = [
  { id: 'badge_approvals', kind: 'badge', permission: 'post.read' },
  { id: 'badge_unreviewed', kind: 'badge', permission: 'media.read' },
  { id: 'badge_ready', kind: 'badge', permission: 'post.read' },
  { id: 'badge_banners', kind: 'badge', permission: 'post.read' },
  { id: 'badge_uploads', kind: 'badge', permission: 'media.read' },
  { id: 'badge_connection_errors', kind: 'badge', permission: 'connection.manage' },
  { id: 'media', kind: 'panel', permission: 'media.read' },
  { id: 'approvals', kind: 'panel', permission: 'post.read' },
  { id: 'ready', kind: 'panel', permission: 'post.read' },
  { id: 'publications', kind: 'panel', permission: 'post.read' },
  { id: 'uploads', kind: 'panel', permission: 'media.read' },
  { id: 'sites', kind: 'panel', permission: 'post.read' },
  { id: 'banners', kind: 'panel', permission: 'post.read' },
  { id: 'rss', kind: 'panel', permission: 'post.read' },
];

const DEF_BY_ID = new Map(WIDGET_DEFS.map((w) => [w.id, w]));

export const COLUMN_WEIGHTS = [2, 3, 5] as const;
export type ColumnWeight = (typeof COLUMN_WEIGHTS)[number];
export const DEFAULT_COLUMN_WEIGHT: ColumnWeight = 3;
export const MAX_COLUMNS = 4;

export interface DashboardColumn {
  weight: ColumnWeight;
  widgets: string[];
}

export interface DashboardLayout {
  version: 2;
  badges: string[];
  columns: DashboardColumn[];
  mobile: string[];
}

type Perms = ReadonlySet<string> | null | undefined;

/** Widgets, die mit diesen Rechten sichtbar sind (ohne Rechte-Angabe: alle bekannten). */
export function availableWidgets(perms: Perms, kind?: WidgetDef['kind']): string[] {
  return WIDGET_DEFS.filter((w) => (!kind || w.kind === kind) && (!perms || perms.has(w.permission))).map((w) => w.id);
}

export function widgetPermission(id: string): string | null {
  return DEF_BY_ID.get(id)?.permission ?? null;
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 2,
  badges: ['badge_approvals', 'badge_unreviewed', 'badge_ready', 'badge_banners', 'badge_uploads', 'badge_connection_errors'],
  columns: [
    { weight: 5, widgets: ['media', 'publications', 'rss'] },
    { weight: 3, widgets: ['approvals', 'uploads', 'banners', 'sites'] },
  ],
  mobile: ['approvals', 'ready', 'uploads', 'publications', 'banners'],
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Bekannte, erlaubte, noch nicht verwendete IDs der gewünschten Art – in der gegebenen Reihenfolge. */
function pick(raw: unknown, kind: WidgetDef['kind'], perms: Perms, seen: Set<string>): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const id of raw) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const def = DEF_BY_ID.get(id);
    if (!def || def.kind !== kind) continue;
    if (perms && !perms.has(def.permission)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const weightOf = (v: unknown): ColumnWeight => ((COLUMN_WEIGHTS as readonly unknown[]).includes(v) ? (v as ColumnWeight) : DEFAULT_COLUMN_WEIGHT);

/**
 * Altes Format (bis 0.2.3): `desktop` als Liste `{ id, size: s|m|l }` in einem 12er-Raster.
 * Umsetzung in Spalten: nur breite Kacheln → eine Spalte; sonst zwei Spalten (drei, wenn kleine Kacheln überwiegen).
 * Breite Kacheln (`l`) kommen in die erste Spalte, die dann „breit“ wird; die übrigen füllen in Lesereihenfolge
 * jeweils die kürzeste Spalte (eine breite Kachel zählt doppelt). Die Reihenfolge bleibt je Spalte erhalten.
 */
export function migrateLegacyDesktop(desktop: unknown): DashboardColumn[] {
  const items: { id: string; size: 's' | 'm' | 'l' }[] = [];
  if (Array.isArray(desktop)) {
    for (const w of desktop) {
      if (!isObject(w) || typeof w.id !== 'string') continue;
      items.push({ id: w.id, size: w.size === 's' || w.size === 'l' ? w.size : 'm' });
    }
  }
  if (!items.length) return [];
  const small = items.filter((w) => w.size === 's').length;
  const medium = items.filter((w) => w.size === 'm').length;
  const count = small + medium === 0 ? 1 : small > medium ? 3 : 2;
  const columns: DashboardColumn[] = Array.from({ length: count }, () => ({ weight: DEFAULT_COLUMN_WEIGHT, widgets: [] }));
  const load = columns.map(() => 0);
  for (const w of items) {
    let target = 0;
    if (w.size !== 'l') for (let i = 1; i < count; i++) if (load[i] < load[target]) target = i;
    columns[target].widgets.push(w.id);
    load[target] += w.size === 'l' ? 2 : 1;
  }
  if (count > 1 && items.some((w) => w.size === 'l')) columns[0].weight = 5;
  return columns.filter((c) => c.widgets.length);
}

/**
 * Beliebige Eingabe (altes oder neues Format, auch beschädigt) → gültiges Layout.
 * Unbekannte, doppelte und – mit `perms` – nicht erlaubte Widgets fallen stillschweigend weg; mehr als vier Spalten
 * werden in die letzte zusammengelegt, unbekannte Gewichte werden „normal“. Leere Spalten bleiben erhalten
 * (sie sind im Bearbeitungsmodus ein Ziel zum Ablegen), mindestens eine Spalte gibt es immer.
 */
export function normalizeLayout(raw: unknown, perms?: Perms): DashboardLayout {
  const src = isObject(raw) ? raw : {};
  const legacy = !Array.isArray(src.columns) && Array.isArray(src.desktop);
  const rawColumns: unknown[] = legacy ? migrateLegacyDesktop(src.desktop) : Array.isArray(src.columns) ? src.columns : [];

  const seenPanels = new Set<string>();
  const columns: DashboardColumn[] = [];
  for (const c of rawColumns) {
    if (!isObject(c)) continue;
    const widgets = pick(c.widgets, 'panel', perms, seenPanels);
    if (columns.length < MAX_COLUMNS) columns.push({ weight: weightOf(c.weight), widgets });
    else columns[MAX_COLUMNS - 1].widgets.push(...widgets);
  }
  if (!columns.length) columns.push({ weight: DEFAULT_COLUMN_WEIGHT, widgets: [] });

  // Alte Layouts kannten keine Kennzahlen: dort die Standardreihe zeigen (gefiltert nach Recht).
  const badges = pick(Array.isArray(src.badges) ? src.badges : legacy ? DEFAULT_LAYOUT.badges : [], 'badge', perms, new Set());
  const mobile = pick(src.mobile, 'panel', perms, new Set());
  return { version: 2, badges, columns, mobile };
}

export interface LayoutIssue {
  path: string;
  message: string;
}

/**
 * Strenge Formprüfung für das Speichern: Aufbau, Spaltenzahl und Gewichte müssen stimmen (sonst 400).
 * Die Widget-IDs selbst prüft danach `normalizeLayout` – Unbekanntes und Unerlaubtes fällt dort still weg.
 */
export function layoutIssues(raw: unknown): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const ids = (v: unknown, path: string) => {
    if (!Array.isArray(v)) return void issues.push({ path, message: 'Liste erwartet.' });
    if (v.length > 40) issues.push({ path, message: 'Zu viele Einträge.' });
    if (v.some((x) => typeof x !== 'string' || x.length > 60)) issues.push({ path, message: 'Nur Widget-Kennungen erlaubt.' });
  };
  if (!isObject(raw)) return [{ path: 'layout', message: 'Layout fehlt.' }];
  if (Array.isArray(raw.desktop) && !Array.isArray(raw.columns)) {
    // Altes Format wird weiter angenommen (ältere Oberfläche im Browser-Cache, API-Nutzung)
    if (raw.desktop.length > 40) issues.push({ path: 'layout.desktop', message: 'Zu viele Einträge.' });
    if (raw.mobile !== undefined) ids(raw.mobile, 'layout.mobile');
    return issues;
  }
  ids(raw.badges ?? [], 'layout.badges');
  ids(raw.mobile ?? [], 'layout.mobile');
  if (!Array.isArray(raw.columns)) return [...issues, { path: 'layout.columns', message: 'Spalten fehlen.' }];
  if (raw.columns.length < 1) issues.push({ path: 'layout.columns', message: 'Mindestens eine Spalte.' });
  if (raw.columns.length > MAX_COLUMNS) issues.push({ path: 'layout.columns', message: `Höchstens ${MAX_COLUMNS} Spalten.` });
  const seen = new Set<string>();
  raw.columns.forEach((c, i) => {
    const path = `layout.columns.${i}`;
    if (!isObject(c)) return void issues.push({ path, message: 'Spalte erwartet.' });
    if (!(COLUMN_WEIGHTS as readonly unknown[]).includes(c.weight)) issues.push({ path: `${path}.weight`, message: 'Breite muss 2 (schmal), 3 (normal) oder 5 (breit) sein.' });
    ids(c.widgets, `${path}.widgets`);
    if (Array.isArray(c.widgets)) {
      for (const id of c.widgets) {
        if (typeof id !== 'string') continue;
        if (seen.has(id)) issues.push({ path: `${path}.widgets`, message: `Widget „${id.slice(0, 60)}“ ist mehrfach eingeordnet.` });
        seen.add(id);
      }
    }
  });
  for (const key of ['badges', 'mobile'] as const) {
    const list = raw[key];
    if (Array.isArray(list) && new Set(list).size !== list.length) issues.push({ path: `layout.${key}`, message: 'Einträge dürfen nur einmal vorkommen.' });
  }
  return issues;
}

export type LayoutSource = 'personal' | 'role' | 'shared' | 'default';

/**
 * Welches Layout gilt: persönlich → Vorlage der ersten Rolle mit Vorlage → Vorlage für alle → Standard.
 * Das Ergebnis ist immer normalisiert und auf die Rechte der Person gefiltert.
 */
export function resolveLayout(input: { personal?: unknown; shared?: Record<string, unknown> | null; roles: readonly string[]; perms: Perms }): { layout: DashboardLayout; source: LayoutSource } {
  const shared = isObject(input.shared) ? input.shared : {};
  const roleLayout = input.roles.map((r) => shared[r]).find(isObject);
  const [raw, source]: [unknown, LayoutSource] = isObject(input.personal) ? [input.personal, 'personal'] : roleLayout ? [roleLayout, 'role'] : isObject(shared['*']) ? [shared['*'], 'shared'] : [DEFAULT_LAYOUT, 'default'];
  return { layout: normalizeLayout(raw, input.perms), source };
}
