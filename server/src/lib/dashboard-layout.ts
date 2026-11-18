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
 * Standardansicht je Rolle (#254): Wer sein Dashboard nicht selbst angepasst hat und für wen die Administration keine
 * Dashboard-Vorlage gespeichert hat, sieht die mitgelieferte Ansicht der ersten passenden Rolle (`ROLE_DEFAULT_LAYOUTS`;
 * eigene Rollen nach ihren Rechten, `profileFor`). Im Standard steht jeder Sachverhalt höchstens einmal (Redaktionsfluss
 * ODER Einzelkacheln, keine Kennzahl zu einer Liste, die schon als Kachel dasteht), und Kacheln nicht eingerichteter
 * Module (keine Website, keine Quelle …) fehlen dort – im Editor bleiben sie wählbar.
 *
 * Bewusst ohne Datenbank- und Fastify-Importe: reine Funktionen, direkt testbar.
 */

/** Module, die eingerichtet bzw. in Gebrauch sein müssen, damit ihre Kacheln in einer mitgelieferten Standardansicht stehen. */
export type DashboardModule = 'website' | 'rss' | 'calendar' | 'press' | 'warnings' | 'incidents' | 'automations' | 'connections' | 'social';

export interface WidgetDef {
  id: string;
  /** badge = Kennzahl in der oberen Reihe; panel = Kachel in einer Spalte */
  kind: 'badge' | 'panel';
  /** Recht, ohne das das Widget weder angeboten noch gespeichert noch ausgeliefert wird */
  permission: string;
  /** Statt `permission` genügt eines dieser Rechte (Kachel mit Teilen aus mehreren Modulen; jeder Teil prüft sein Recht) */
  anyOf?: readonly string[];
  /** Ohne dieses Modul erscheint das Widget nicht in einer mitgelieferten Standardansicht (im Editor bleibt es wählbar) */
  module?: DashboardModule;
}

export const WIDGET_DEFS: readonly WidgetDef[] = [
  { id: 'badge_approvals', kind: 'badge', permission: 'post.view' },
  { id: 'badge_unreviewed', kind: 'badge', permission: 'media.view' },
  { id: 'badge_ready', kind: 'badge', permission: 'post.view' },
  { id: 'badge_banners', kind: 'badge', permission: 'banner.view', module: 'website' },
  { id: 'badge_uploads', kind: 'badge', permission: 'media.view' },
  { id: 'badge_connection_errors', kind: 'badge', permission: 'connection.configure', module: 'connections' },
  { id: 'media', kind: 'panel', permission: 'media.view' },
  { id: 'approvals', kind: 'panel', permission: 'post.view' },
  { id: 'ready', kind: 'panel', permission: 'post.view' },
  { id: 'publications', kind: 'panel', permission: 'post.view', module: 'website' },
  { id: 'uploads', kind: 'panel', permission: 'media.view' },
  { id: 'sites', kind: 'panel', permission: 'channel.view', module: 'website' },
  { id: 'banners', kind: 'panel', permission: 'banner.view', module: 'website' },
  { id: 'rss', kind: 'panel', permission: 'source.view', module: 'rss' },
  { id: 'insights', kind: 'panel', permission: 'insights.view', module: 'social' },
  { id: 'press', kind: 'panel', permission: 'press.view', module: 'press' },
  { id: 'badge_press', kind: 'badge', permission: 'press.view', module: 'press' },
  /* Seit #254 */
  { id: 'badge_calendar_today', kind: 'badge', permission: 'calendar.view', module: 'calendar' },
  { id: 'badge_services', kind: 'badge', permission: 'system.status' },
  { id: 'calendar_upcoming', kind: 'panel', permission: 'calendar.view', module: 'calendar' },
  { id: 'my_drafts', kind: 'panel', permission: 'post.edit' },
  { id: 'my_press', kind: 'panel', permission: 'press.view', module: 'press' },
  { id: 'warnings', kind: 'panel', permission: 'warning.view', anyOf: ['warning.view', 'official.view'], module: 'warnings' },
  { id: 'incidents', kind: 'panel', permission: 'incident.view', module: 'incidents' },
  { id: 'automations', kind: 'panel', permission: 'automation.read', module: 'automations' },
  /* Checkliste „BlaulichtCMS startklar“ (#255): nur, wer die allgemeinen Einstellungen ändern darf (Administration) */
  { id: 'setup', kind: 'panel', permission: 'settings.general' },
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

/** Darf diese Person das Widget sehen? (ohne Rechte-Angabe: ja) */
const allowed = (w: WidgetDef, perms: Perms) => !perms || (w.anyOf ? w.anyOf.some((p) => perms.has(p)) : perms.has(w.permission));

/** Widgets, die mit diesen Rechten sichtbar sind (ohne Rechte-Angabe: alle bekannten). */
export function availableWidgets(perms: Perms, kind?: WidgetDef['kind']): string[] {
  return WIDGET_DEFS.filter((w) => (!kind || w.kind === kind) && allowed(w, perms)).map((w) => w.id);
}

export function widgetPermission(id: string): string | null {
  return DEF_BY_ID.get(id)?.permission ?? null;
}

/** Rechte eines Widgets: alle Alternativen (eines genügt). */
export function widgetPermissions(id: string): readonly string[] {
  const d = DEF_BY_ID.get(id);
  return d ? (d.anyOf ?? [d.permission]) : [];
}

/**
 * Kennzahlen-Reihe des Standards bis 0.6: gilt weiter für Layouts im Format vor 0.2.4 (die kannten keine Kennzahlen) –
 * gespeicherte alte Layouts bleiben so, wie sie bisher angezeigt wurden.
 */
export const LEGACY_DEFAULT_BADGES: readonly string[] = ['badge_approvals', 'badge_unreviewed', 'badge_ready', 'badge_banners', 'badge_uploads', 'badge_connection_errors'];

/** Standardansicht aus einer breiten und (optional) einer normalen Spalte; am Handy dieselben Kacheln in Lesereihenfolge. */
function std(badges: string[], wide: string[], normal: string[] = []): DashboardLayout {
  const columns: DashboardColumn[] = [{ weight: 5, widgets: wide }];
  if (normal.length) columns.push({ weight: 3, widgets: normal });
  return { version: 2, badges, columns, mobile: [...wide, ...normal] };
}

/**
 * Allgemeiner Standard für Rechte, zu denen keine Standardansicht passt (z. B. eine eigene Rolle nur mit Kalender
 * oder Designvorlagen). Gefiltert wird nach Recht – übrig bleibt, was die Person sehen darf.
 */
export const DEFAULT_LAYOUT: DashboardLayout = std(['badge_connection_errors'], ['media', 'calendar_upcoming'], ['my_press', 'warnings', 'incidents', 'sites']);

/**
 * Mitgelieferte Standardansicht je Rolle (#254). Jeder Sachverhalt höchstens einmal: Der Redaktionsfluss enthält
 * Eingang, Sichtung, Freigabe, Bereit und Veröffentlicht – wer ihn hat, bekommt dazu keine Einzelkacheln oder
 * Kennzahlen; Kennzahlen nur für Dinge ohne eigene Kachel (jede Kachel nennt ihre Anzahl selbst).
 */
export const ROLE_DEFAULT_LAYOUTS: Readonly<Record<string, DashboardLayout>> = {
  platform_admin: std(['badge_connection_errors', 'badge_services'], ['setup', 'approvals'], ['automations', 'sites']),
  editor: std([], ['media', 'my_drafts'], ['calendar_upcoming', 'my_press']),
  media_manager: std(['badge_unreviewed'], ['uploads'], ['calendar_upcoming']),
  approver: std([], ['approvals'], ['ready', 'publications']),
  publisher: std(['badge_banners'], ['ready', 'publications'], ['sites', 'incidents']),
  // Die Warnrollen haben nur Rechte für Warnvorgänge; die Kachel stellt nach vorn, was die Rolle tun kann
  // (Entwürfe, zur Freigabe, zu versenden)
  warning_author: std([], ['warnings']),
  warning_approver: std([], ['warnings']),
  warning_sender: std([], ['warnings']),
  viewer: std([], ['publications'], ['calendar_upcoming']),
  /** Keine mitgelieferte Rolle, sondern das Profil eigener Rollen mit Presse-Rechten ohne Redaktion (`profileFor`) */
  press: std([], ['my_press'], ['calendar_upcoming', 'publications']),
};

/**
 * Standardansicht einer eigenen Rolle nach ihren Rechten – wer einrichtet, vor wer schreibt, vor wer prüft …
 * Nichts passt → `generic` (DEFAULT_LAYOUT).
 */
export function profileFor(perms: ReadonlySet<string>): string {
  const any = (...ids: string[]) => ids.some((p) => perms.has(p));
  if (perms.has('settings.general')) return 'platform_admin';
  if (perms.has('post.edit')) return 'editor';
  if (any('press.manage', 'press.reply')) return 'press';
  if (any('approval.post', 'approval.banner', 'approval.incident', 'approval.automation', 'press.approve')) return 'approver';
  if (any('publish.website', 'publish.social', 'banner.publish', 'incident.publish')) return 'publisher';
  if (any('warning.approve', 'warning.level')) return 'warning_approver';
  if (perms.has('warning.send')) return 'warning_sender';
  if (perms.has('warning.draft')) return 'warning_author';
  if (any('media.review', 'media.collections')) return 'media_manager';
  if (perms.has('post.view')) return 'viewer';
  return 'generic';
}

/**
 * Standardansicht der ersten passenden Rolle (Reihenfolge der Rollen der Person, wie bei den Dashboard-Vorlagen):
 * mitgelieferte Rolle → ihre Ansicht; eigene Rolle → nach ihren Rechten (`rolePerms`).
 */
export function defaultProfile(roles: readonly string[], rolePerms: (id: string) => ReadonlySet<string> | undefined): string {
  for (const r of roles) {
    // Eigene Rollen heißen r_… (routes/roles.ts) – „press“ ist nur ein Profil, keine Rolle
    if (r !== 'press' && Object.hasOwn(ROLE_DEFAULT_LAYOUTS, r)) return r;
    const p = rolePerms(r);
    if (!p) continue;
    const k = profileFor(p);
    if (k !== 'generic') return k;
  }
  return 'generic';
}

/** Widgets nicht eingerichteter Module aus einer Standardansicht nehmen. */
function withoutUnused(l: DashboardLayout, unused: ReadonlySet<DashboardModule>): DashboardLayout {
  const keep = (id: string) => {
    const m = DEF_BY_ID.get(id)?.module;
    return !m || !unused.has(m);
  };
  return { ...l, badges: l.badges.filter(keep), columns: l.columns.map((c) => ({ ...c, widgets: c.widgets.filter(keep) })), mobile: l.mobile.filter(keep) };
}

const panelCount = (l: DashboardLayout) => l.columns.reduce((n, c) => n + c.widgets.length, 0);

/**
 * Mitgelieferte Standardansicht eines Profils, nach Recht gefiltert und ohne Widgets nicht eingerichteter Module.
 * Bliebe dadurch keine Kachel übrig (frische Instanz), gilt die Ansicht ohne Modulfilter – nie ein leeres Dashboard.
 */
export function defaultLayoutFor(profile: string, perms: Perms, unused: ReadonlySet<DashboardModule> = new Set()): DashboardLayout {
  const base = ROLE_DEFAULT_LAYOUTS[profile] ?? DEFAULT_LAYOUT;
  const lean = normalizeLayout(withoutUnused(base, unused), perms);
  if (panelCount(lean)) return lean;
  const full = normalizeLayout(base, perms);
  return panelCount(full) ? full : lean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Bekannte, erlaubte, noch nicht verwendete IDs der gewünschten Art – in der gegebenen Reihenfolge. */
function pick(raw: unknown, kind: WidgetDef['kind'], perms: Perms, seen: Set<string>): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const id of raw) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const def = DEF_BY_ID.get(id);
    if (!def || def.kind !== kind) continue;
    if (!allowed(def, perms)) continue;
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
  const badges = pick(Array.isArray(src.badges) ? src.badges : legacy ? LEGACY_DEFAULT_BADGES : [], 'badge', perms, new Set());
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
 * Welches Layout gilt: persönlich → Vorlage der ersten Rolle mit Vorlage → Vorlage für alle → mitgelieferte
 * Standardansicht des Profils (`defaultProfile`; ohne Widgets nicht eingerichteter Module, `unused`).
 * Das Ergebnis ist immer normalisiert und auf die Rechte der Person gefiltert. Gespeicherte Layouts und Vorlagen
 * gelten unverändert – der Modulfilter betrifft nur die mitgelieferte Standardansicht.
 */
export function resolveLayout(input: { personal?: unknown; shared?: Record<string, unknown> | null; roles: readonly string[]; perms: Perms; profile?: string; unused?: ReadonlySet<DashboardModule> }): { layout: DashboardLayout; source: LayoutSource } {
  const shared = isObject(input.shared) ? input.shared : {};
  const roleLayout = input.roles.map((r) => shared[r]).find(isObject);
  const [raw, source]: [unknown, LayoutSource] = isObject(input.personal) ? [input.personal, 'personal'] : roleLayout ? [roleLayout, 'role'] : isObject(shared['*']) ? [shared['*'], 'shared'] : [null, 'default'];
  if (source === 'default') return { layout: defaultLayoutFor(input.profile ?? 'generic', input.perms, input.unused), source };
  return { layout: normalizeLayout(raw, input.perms), source };
}
