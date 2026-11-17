import { many, pool, type Queryable } from '../db/pool.js';
import { getSettings } from '../lib/settings.js';
import { expand, isValidTimeZone, parseRrule, seriesEnd, type Rrule } from './recurrence.js';

/**
 * Termine des Kalenders laden und Serien in einzelne Termine auflösen. Grundlage für die Ansichten (routes/calendar.ts),
 * das iCal-Abo und den Workflow-Auslöser „Kalendereintrag“.
 */

export const CATEGORY_COLORS = ['rot', 'orange', 'gelb', 'gruen', 'tuerkis', 'blau', 'violett', 'grau'] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

/** Längster abfragbarer Zeitraum (Ansichten, Abo). */
export const MAX_RANGE_DAYS = 400;

export interface CalendarEntry {
  /** eindeutig je Termin (auch je Termin einer Serie) */
  key: string;
  /** event = Kalendertermin; post = geplanter Beitrag; weitere Arten liefern Anbieter (z. B. press) */
  kind: string;
  id: string;
  /** Serie, zu der der Termin gehört (Hauptzeile) */
  seriesId: string | null;
  /** Ursprünglicher Beginn des Termins innerhalb einer Serie (ISO) – Kennung für „nur diesen Termin“ */
  instance: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  category: { id: string; name: string; color: string } | null;
  tags: string[];
  /** own, ical, post, press … */
  source: string;
  sourceId: string | null;
  sourceName: string | null;
  recurring: boolean;
  readOnly: boolean;
  /** Farbschlüssel, wenn keine Kategorie gilt (z. B. Beiträge) */
  color?: string;
  status?: string;
  statusLabel?: string;
  link?: string;
  overdue?: boolean;
  /** Zeitpunkt lässt sich per Ziehen ändern */
  movable?: boolean;
  meta?: Record<string, unknown>;
}

export interface EventRow {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  tz: string;
  category_id: string | null;
  tags: string[];
  source: 'own' | 'ical';
  source_id: string | null;
  uid: string | null;
  rrule: string | null;
  exdates: Date[];
  until_at: Date | null;
  series_id: string | null;
  recurrence_id: Date | null;
  cat_name?: string | null;
  cat_color?: string | null;
  source_name?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Occ {
  row: EventRow;
  start: number;
  end: number;
  /** ursprünglicher Beginn innerhalb der Serie */
  instance: number | null;
}

export async function calendarTimeZone(): Promise<string> {
  const tz = (await getSettings())['general.timezone'] || 'Europe/Berlin';
  return isValidTimeZone(tz) ? tz : 'Europe/Berlin';
}

export function safeRrule(rule: string | null, tz: string): Rrule | null {
  if (!rule) return null;
  try {
    return parseRrule(rule, tz);
  } catch {
    return null;
  }
}

/** Ende der Serie für `until_at` (NULL = unbegrenzt). */
export function computeUntil(v: { starts_at: Date | number; ends_at: Date | number; all_day: boolean; tz: string; rrule: string | null }): Date | null {
  const r = safeRrule(v.rrule, v.tz);
  if (!r) return null;
  const end = seriesEnd({ start: +v.starts_at, end: +v.ends_at, allDay: v.all_day, tz: v.tz, rrule: r });
  return end == null ? null : new Date(end);
}

/** Abfrage aller Zeilen (Einzeltermine, Serien, geänderte Termine), die den Zeitraum berühren können. */
const ROWS_SQL = `
  SELECT e.*, c.name AS cat_name, c.color AS cat_color, s.name AS source_name
    FROM calendar_events e
    LEFT JOIN calendar_categories c ON c.id = e.category_id
    LEFT JOIN calendar_sources s ON s.id = e.source_id
   WHERE (e.rrule IS NULL AND e.starts_at < $2 AND e.ends_at >= $1)
      OR (e.rrule IS NOT NULL AND e.starts_at < $2 AND (e.until_at IS NULL OR e.until_at >= $1))`;

/** Alle Termine (aufgelöst) im Zeitraum [from, to), aufsteigend nach Beginn. */
export async function occurrences(from: Date, to: Date, db: Queryable = pool): Promise<Occ[]> {
  const rows = await many<EventRow>(ROWS_SQL, [from, to], db);
  const seriesIds = rows.filter((r) => r.rrule).map((r) => r.id);
  // Geänderte Termine einer Serie ersetzen den ursprünglichen – auch wenn sie in einen anderen Zeitraum verschoben wurden
  const overrides = seriesIds.length ? await many<{ series_id: string; recurrence_id: Date }>(`SELECT series_id, recurrence_id FROM calendar_events WHERE series_id = ANY($1)`, [seriesIds], db) : [];
  const replaced = new Map<string, number[]>();
  for (const o of overrides) replaced.set(o.series_id, [...(replaced.get(o.series_id) ?? []), +o.recurrence_id]);
  const out: Occ[] = [];
  for (const row of rows) {
    if (!row.rrule) {
      out.push({ row, start: +row.starts_at, end: +row.ends_at, instance: row.recurrence_id ? +row.recurrence_id : null });
      continue;
    }
    const rule = safeRrule(row.rrule, row.tz);
    const list = expand({ start: +row.starts_at, end: +row.ends_at, allDay: row.all_day, tz: row.tz, rrule: rule, exdates: [...(row.exdates ?? []).map(Number), ...(replaced.get(row.id) ?? [])] }, +from, +to);
    for (const o of list) out.push({ row, start: o.start, end: o.end, instance: rule ? o.start : null });
  }
  return out.sort((a, b) => a.start - b.start || a.row.title.localeCompare(b.row.title, 'de'));
}

export function toEntry(o: Occ): CalendarEntry {
  const r = o.row;
  const seriesId = r.rrule ? r.id : r.series_id;
  const inst = o.instance != null ? new Date(o.instance).toISOString() : null;
  return {
    key: `event:${r.id}${r.rrule && inst ? `:${inst}` : ''}`,
    kind: 'event',
    id: r.id,
    seriesId,
    instance: inst,
    title: r.title,
    start: new Date(o.start).toISOString(),
    end: new Date(o.end).toISOString(),
    allDay: r.all_day,
    location: r.location,
    description: r.description,
    category: r.category_id && r.cat_name ? { id: r.category_id, name: r.cat_name, color: r.cat_color ?? 'grau' } : null,
    tags: r.tags ?? [],
    source: r.source,
    sourceId: r.source_id,
    sourceName: r.source === 'ical' ? (r.source_name ?? 'iCal') : null,
    recurring: !!seriesId,
    readOnly: r.source !== 'own',
  };
}

/* ------------------------------------------------------------------ Anbieter für weitere Einträge */

/**
 * Weitere Module (z. B. Presseanfragen mit Fristen) können Einträge beisteuern, ohne den Kalender zu ändern:
 * `registerCalendarProvider({ id: 'press', label: 'Presse-Fristen', permission: 'press.view', list })`.
 * `list` liefert Einträge im Zeitraum; der Kalender zeigt sie nur Personen mit dem angegebenen Recht und bietet
 * `id` als Quelle im Filter an. Einträge von Anbietern sind schreibgeschützt (readOnly), außer der Anbieter setzt
 * `movable` und `link` selbst.
 */
export interface CalendarProvider {
  id: string;
  label: string;
  /** Recht, ohne das die Einträge nicht erscheinen */
  permission: string;
  list(from: Date, to: Date, ctx: { permissions: Set<string>; userId: string | null }): Promise<CalendarEntry[]>;
}

const providers = new Map<string, CalendarProvider>();

export function registerCalendarProvider(p: CalendarProvider) {
  providers.set(p.id, p);
}
export const calendarProviders = (): CalendarProvider[] => [...providers.values()];
