/**
 * Dashboard-Layout in der Oberfläche: Typen, Beschriftungen und reine Umbau-Funktionen für den Bearbeitungsmodus.
 * Welche Widgets es gibt und welches Recht sie brauchen, entscheidet allein der Server
 * (`server/src/lib/dashboard-layout.ts`); die Oberfläche zeigt nur, was `GET /dashboard/layout` in `widgets` nennt.
 */

export type ColumnWeight = 2 | 3 | 5;

export interface Layout {
  version: 2;
  badges: string[];
  columns: { weight: ColumnWeight; widgets: string[] }[];
  mobile: string[];
}

export interface LayoutResponse {
  layout: Layout;
  source: 'personal' | 'role' | 'shared' | 'default';
  widgets: string[];
  templates?: string[];
  /** Rollen für gemeinsame Vorlagen (mitgelieferte und eigene), nur mit „Dashboard-Vorlagen speichern“ */
  templateRoles?: { id: string; label: string }[];
}

/** Arbeitskopie im Bearbeitungsmodus: Spalten tragen einen festen Schlüssel, damit sie sich verschieben lassen. */
export interface EditColumn {
  key: string;
  weight: ColumnWeight;
  widgets: string[];
}
export interface EditLayout {
  badges: string[];
  columns: EditColumn[];
  mobile: string[];
}

export const MAX_COLUMNS = 4;
export const WEIGHTS: { value: ColumnWeight; label: string }[] = [
  { value: 2, label: 'Schmal' },
  { value: 3, label: 'Normal' },
  { value: 5, label: 'Breit' },
];

export const PANEL_TITLES: Record<string, string> = {
  media: 'Redaktionsfluss',
  approvals: 'Offene Freigaben',
  ready: 'Bereit zur Veröffentlichung',
  publications: 'Veröffentlichungen',
  uploads: 'Neue Uploads',
  sites: 'Websites',
  banners: 'Aktive Banner',
  rss: 'Quellen (RSS)',
  press: 'Presseanfragen',
};

export const BADGE_TITLES: Record<string, string> = {
  badge_approvals: 'Offene Freigaben',
  badge_unreviewed: 'Ungesichtete Dateien',
  badge_ready: 'Bereit zur Veröffentlichung',
  badge_banners: 'Aktive Banner',
  badge_uploads: 'Uploads in 24 Std.',
  badge_connection_errors: 'Verbindungsfehler',
  badge_press: 'Offene Presseanfragen',
};

export const isBadge = (id: string) => id in BADGE_TITLES;
export const isPanel = (id: string) => id in PANEL_TITLES;
export const titleOf = (id: string) => PANEL_TITLES[id] ?? BADGE_TITLES[id] ?? id;

let seq = 0;
export const newColumnKey = () => `col-${++seq}`;

export function toEdit(l: Layout): EditLayout {
  return { badges: [...l.badges], columns: l.columns.map((c) => ({ key: newColumnKey(), weight: c.weight, widgets: [...c.widgets] })), mobile: [...l.mobile] };
}

export function fromEdit(l: EditLayout): Layout {
  return { version: 2, badges: [...l.badges], columns: l.columns.map((c) => ({ weight: c.weight, widgets: [...c.widgets] })), mobile: [...l.mobile] };
}

/** Inhaltlicher Vergleich ohne Spaltenschlüssel – für „ungespeicherte Änderungen“. */
export const sameLayout = (a: Layout, b: Layout) => JSON.stringify([a.badges, a.columns, a.mobile]) === JSON.stringify([b.badges, b.columns, b.mobile]);

export function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

export const columnOf = (l: EditLayout, widget: string) => l.columns.find((c) => c.widgets.includes(widget))?.key ?? null;

/** Kachel in eine (andere) Spalte setzen; `index` fehlt = ans Ende. */
export function placeWidget(l: EditLayout, widget: string, columnKey: string, index?: number): EditLayout {
  const columns = l.columns.map((c) => ({ ...c, widgets: c.widgets.filter((w) => w !== widget) }));
  const target = columns.find((c) => c.key === columnKey);
  if (!target) return l;
  target.widgets.splice(index === undefined ? target.widgets.length : Math.max(0, Math.min(target.widgets.length, index)), 0, widget);
  return { ...l, columns };
}

/** Widget einblenden: Kennzahl ans Ende der Reihe, Kachel ans Ende der letzten Spalte. */
export function addWidget(l: EditLayout, id: string): EditLayout {
  if (isBadge(id)) return l.badges.includes(id) ? l : { ...l, badges: [...l.badges, id] };
  if (columnOf(l, id)) return l;
  const base = l.columns.length ? l : { ...l, columns: [{ key: newColumnKey(), weight: 3 as ColumnWeight, widgets: [] }] };
  return placeWidget(base, id, base.columns[base.columns.length - 1].key);
}

/** Widget ausblenden – auch aus der Handy-Reihenfolge. */
export function removeWidget(l: EditLayout, id: string): EditLayout {
  return {
    badges: l.badges.filter((w) => w !== id),
    columns: l.columns.map((c) => ({ ...c, widgets: c.widgets.filter((w) => w !== id) })),
    mobile: l.mobile.filter((w) => w !== id),
  };
}

export function addColumn(l: EditLayout): EditLayout {
  if (l.columns.length >= MAX_COLUMNS) return l;
  return { ...l, columns: [...l.columns, { key: newColumnKey(), weight: 3, widgets: [] }] };
}

/** Nur leere Spalten lassen sich löschen; eine Spalte bleibt immer. */
export function removeColumn(l: EditLayout, key: string): EditLayout {
  const col = l.columns.find((c) => c.key === key);
  if (!col || col.widgets.length || l.columns.length <= 1) return l;
  return { ...l, columns: l.columns.filter((c) => c.key !== key) };
}

export const setWeight = (l: EditLayout, key: string, weight: ColumnWeight): EditLayout => ({ ...l, columns: l.columns.map((c) => (c.key === key ? { ...c, weight } : c)) });

/** Spaltenbreite als Flex-Angabe: Gewicht verteilt den Platz, unter 300 px bricht die Spalte um (schmale Bildschirme). */
export const columnStyle = (weight: number) => ({ flex: `${weight} 1 0`, minWidth: 'min(100%, 300px)' });
