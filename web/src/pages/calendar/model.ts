import { fromLocalInput, toLocalInput } from '../../lib/format';

/** Kalender (#200): Typen und Datumsrechnung in der Zeitzone der Instanz (lib/format). */

export interface CalendarCategory {
  id: string;
  name: string;
  color: string;
  position: number;
  event_count?: number;
}

export interface CalendarEntry {
  key: string;
  kind: string;
  id: string;
  seriesId: string | null;
  instance: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  category: { id: string; name: string; color: string } | null;
  tags: string[];
  source: string;
  sourceId: string | null;
  sourceName: string | null;
  recurring: boolean;
  readOnly: boolean;
  color?: string;
  status?: string;
  statusLabel?: string;
  link?: string;
  overdue?: boolean;
  movable?: boolean;
  meta?: Record<string, any>;
}

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays: number[];
  monthly: 'day' | 'weekday';
  ordinal?: 1 | 2 | 3 | 4 | 5 | -1;
  ends: 'never' | 'until' | 'count';
  until: string | null;
  count: number | null;
}

export interface EventDetail {
  id: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  startDate: string | null;
  endDate: string | null;
  category: { id: string; name: string; color: string } | null;
  tags: string[];
  source: string;
  readOnly: boolean;
  rrule: string | null;
  rruleText: string | null;
  recurrence: Recurrence | null;
  seriesId: string | null;
  instance: string | null;
  createdByName: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

export const COLORS: { value: string; label: string }[] = [
  { value: 'rot', label: 'Rot' },
  { value: 'orange', label: 'Orange' },
  { value: 'gelb', label: 'Gelb' },
  { value: 'gruen', label: 'Grün' },
  { value: 'tuerkis', label: 'Türkis' },
  { value: 'blau', label: 'Blau' },
  { value: 'violett', label: 'Violett' },
  { value: 'grau', label: 'Grau' },
];

/** CSS-Farbe eines Eintrags (Token). */
export function entryColor(e: Pick<CalendarEntry, 'category' | 'color' | 'kind'>): string {
  const key = e.category?.color ?? e.color ?? (e.kind === 'event' ? 'grau' : e.kind);
  return `var(--bc-cal-${key})`;
}

export const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const WEEKDAYS_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/* ------------------------------------------------------------------ Ortsdaten als „JJJJ-MM-TT“ */

export const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const civil = (s: string) => new Date(`${s}T00:00:00Z`);

export function addDays(s: string, n: number): string {
  const d = civil(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
export function addMonths(s: string, n: number): string {
  const d = civil(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return ymd(d);
}
export const weekdayOf = (s: string) => civil(s).getUTCDay();
export const startOfWeek = (s: string) => addDays(s, -((weekdayOf(s) + 6) % 7));
export const startOfMonth = (s: string) => `${s.slice(0, 7)}-01`;
export const dayOfMonth = (s: string) => Number(s.slice(8, 10));
export const monthIndex = (s: string) => Number(s.slice(5, 7)) - 1;
export const yearOf = (s: string) => Number(s.slice(0, 4));

/** Ortsdatum (Zeitzone der Instanz) eines Zeitpunkts. */
export const dayKey = (iso: string | number | Date) => toLocalInput(typeof iso === 'number' ? new Date(iso) : (iso as any)).slice(0, 10);
/** Uhrzeit HH:MM (Zeitzone der Instanz). */
export const timeOf = (iso: string) => toLocalInput(iso).slice(11, 16);
/** Mitternacht eines Ortsdatums als ISO-Zeitpunkt. */
export const dayStart = (s: string) => fromLocalInput(`${s}T00:00`)!;
export const today = () => dayKey(new Date());

/** Ortsdaten, die ein Eintrag berührt (Ende exklusiv). */
export function entryDays(e: Pick<CalendarEntry, 'start' | 'end'>): { first: string; last: string } {
  const first = dayKey(e.start);
  const endMs = Date.parse(e.end);
  const last = endMs > Date.parse(e.start) ? dayKey(endMs - 1) : first;
  return { first, last: last < first ? first : last };
}

export function dayLabel(s: string): string {
  return `${WEEKDAYS_LONG[weekdayOf(s)]}, ${dayOfMonth(s)}. ${MONTHS[monthIndex(s)]} ${yearOf(s)}`;
}

/** „10:00–12:00“, „ganztägig“, „bis 12:00“ (für Einträge, die an einem anderen Tag begonnen haben). */
export function timeText(e: CalendarEntry, day?: string): string {
  if (e.allDay) return 'ganztägig';
  const { first, last } = entryDays(e);
  const s = timeOf(e.start);
  const en = timeOf(e.end);
  if (e.start === e.end) return s;
  if (!day || first === last) return first === last ? `${s}–${en}` : `${s} – ${dayShort(last)} ${en}`;
  if (day === first) return `ab ${s}`;
  if (day === last) return `bis ${en}`;
  return 'ganztägig';
}

export const dayShort = (s: string) => `${pad(dayOfMonth(s))}.${pad(monthIndex(s) + 1)}.`;

/** Zeitraum eines Eintrags in einem Satz („Sa, 07.11.2026, 10:00–12:00“). */
export function rangeText(e: CalendarEntry): string {
  const { first, last } = entryDays(e);
  const d = (s: string) => `${WEEKDAYS_SHORT[weekdayOf(s)]}, ${dayShort(s)}${yearOf(s)}`;
  if (e.allDay) return first === last ? `${d(first)}, ganztägig` : `${d(first)} – ${d(last)}, ganztägig`;
  if (e.start === e.end) return `${d(first)}, ${timeOf(e.start)}`;
  return first === last ? `${d(first)}, ${timeOf(e.start)}–${timeOf(e.end)}` : `${d(first)}, ${timeOf(e.start)} – ${d(last)}, ${timeOf(e.end)}`;
}

export type View = 'month' | 'week' | 'list';

/** Sichtbarer Zeitraum einer Ansicht (Ortsdaten, Ende exklusiv). */
export function viewRange(view: View, anchor: string): { from: string; to: string; title: string } {
  if (view === 'week') {
    const from = startOfWeek(anchor);
    const to = addDays(from, 7);
    const last = addDays(from, 6);
    const kw = isoWeek(from);
    return { from, to, title: `KW ${kw} · ${dayShort(from)} – ${dayShort(last)}${yearOf(last)}` };
  }
  const m0 = startOfMonth(anchor);
  const title = `${MONTHS[monthIndex(m0)]} ${yearOf(m0)}`;
  if (view === 'list') return { from: m0, to: addMonths(m0, 1), title };
  const from = startOfWeek(m0);
  let to = addDays(from, 35);
  if (to <= addDays(addMonths(m0, 1), -1)) to = addDays(from, 42);
  return { from, to, title };
}

export function isoWeek(s: string): number {
  const d = civil(s);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((+d - yearStart) / 86_400_000 + 1) / 7);
}

export function shift(view: View, anchor: string, dir: 1 | -1): string {
  if (view === 'week') return addDays(anchor, 7 * dir);
  return addMonths(startOfMonth(anchor), dir);
}

/** Einträge je Ortsdatum (mehrtägige Einträge an jedem Tag). */
export function byDay(entries: CalendarEntry[], from: string, to: string): Map<string, CalendarEntry[]> {
  const map = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const { first, last } = entryDays(e);
    for (let d = first < from ? from : first; d <= last && d < to; d = addDays(d, 1)) {
      const list = map.get(d) ?? [];
      list.push(e);
      map.set(d, list);
    }
  }
  for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  return map;
}
