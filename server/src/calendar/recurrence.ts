/**
 * Wiederholungsregeln (RFC 5545, Teilmenge) und Zeitzonen ohne Fremdbibliothek.
 *
 * Wiederholungen werden in Ortszeit („Wanduhrzeit“) der Zeitzone des Termins gebildet: Eine Übung „jeden 1. Samstag
 * um 10:00“ bleibt auch nach der Umstellung auf Sommer-/Winterzeit um 10:00 Ortszeit. Erst die einzelnen Termine
 * werden in UTC-Zeitpunkte umgerechnet (Intl, IANA-Zeitzonen wie Europe/Berlin).
 *
 * Unterstützt: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL (Datum oder Zeitpunkt), BYDAY (auch mit
 * Ordnungszahl wie 1SA oder -1FR), BYMONTHDAY (auch negativ), BYMONTH, BYSETPOS, WKST. Stündliche und feinere Regeln
 * werden nicht unterstützt (der Termin gilt dann als einzelner Termin).
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export interface ByDay {
  /** 0 = Sonntag … 6 = Samstag (wie Date.getUTCDay) */
  wd: number;
  /** Ordnungszahl (1 = erster, -1 = letzter); fehlt = jeder */
  n?: number;
}
export interface Rrule {
  freq: Freq;
  interval: number;
  count: number | null;
  /** UNTIL als Zeitpunkt (ms, UTC) – bei einem reinen Datum das Ende dieses Tages in der Zeitzone des Termins */
  until: number | null;
  /** UNTIL als reines Datum (YYYY-MM-DD) */
  untilDate: string | null;
  byday: ByDay[];
  bymonthday: number[];
  bymonth: number[];
  bysetpos: number[];
  wkst: number;
}

export const WD_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/* ------------------------------------------------------------------ Zeitzonen */

export interface Civil {
  y: number;
  m: number; // 1–12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Ortszeit eines Zeitpunkts in einer Zeitzone. */
export function toCivil(ms: number, tz: string): Civil {
  if (tz === 'UTC') {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

const civilMs = (c: Civil) => Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);

/**
 * Ortszeit → Zeitpunkt. Eine Uhrzeit in der Lücke der Sommerzeit-Umstellung (02:30 am letzten Märzsonntag) wird auf
 * die gleiche Wanduhr-Dauer nach vorn verschoben (03:30); bei doppelt vorkommenden Uhrzeiten (Oktober) gilt die erste.
 */
export function fromCivil(c: Civil, tz: string): number {
  const want = civilMs(c);
  if (tz === 'UTC') return want;
  // Versatz kurz vor und kurz nach der gesuchten Zeit: deckt beide Seiten einer Umstellung ab
  const offAt = (ms: number) => civilMs(toCivil(ms, tz)) - ms;
  const offs = [...new Set([offAt(want - 12 * 3600_000), offAt(want + 12 * 3600_000)])];
  const fits = offs.map((o) => want - o).filter((ms) => civilMs(toCivil(ms, tz)) === want);
  // doppelte Uhrzeit: die frühere; Lücke: um die Umstellung nach vorn verschoben
  if (fits.length) return Math.min(...fits);
  return want - Math.min(...offs);
}

/* ------------------------------------------------------------------ Kalenderrechnung (Ortsdatum) */

/** Tage seit 1970-01-01 für ein Ortsdatum (reine Datumsrechnung, ohne Zeitzone). */
export const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
export function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export const weekday = (n: number) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 war ein Donnerstag
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const isoDate = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function parseIsoDate(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** Ortsdatum eines Zeitpunkts als YYYY-MM-DD. */
export function localDate(ms: number, tz: string): string {
  const c = toCivil(ms, tz);
  return isoDate(c.y, c.m, c.d);
}

/** Mitternacht eines Ortsdatums als Zeitpunkt. */
export function midnight(date: string, tz: string): number {
  const p = parseIsoDate(date);
  if (!p) throw new Error(`Ungültiges Datum ${date}`);
  return fromCivil({ ...p, h: 0, mi: 0, s: 0 }, tz);
}

/* ------------------------------------------------------------------ RRULE lesen und schreiben */

export class RruleError extends Error {}

/** RRULE-Wert lesen („FREQ=MONTHLY;BYDAY=1SA“). `tz` dient nur für UNTIL als reines Datum. */
export function parseRrule(value: string, tz = 'Europe/Berlin'): Rrule {
  const parts = new Map<string, string>();
  for (const seg of value.replace(/^RRULE:/i, '').split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts.set(seg.slice(0, i).trim().toUpperCase(), seg.slice(i + 1).trim());
  }
  const freq = (parts.get('FREQ') ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new RruleError(`Wiederholung ${freq || '(ohne FREQ)'} wird nicht unterstützt.`);
  const ints = (k: string, min: number, max: number) =>
    (parts.get(k) ?? '')
      .split(',')
      .filter(Boolean)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max);
  const byday: ByDay[] = [];
  for (const raw of (parts.get('BYDAY') ?? '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(raw.trim());
    if (!m) continue;
    const n = m[1] ? parseInt(m[1], 10) : undefined;
    byday.push({ wd: WD_CODES.indexOf(m[2].toUpperCase()), ...(n ? { n } : {}) });
  }
  const interval = Math.max(1, Math.min(1000, parseInt(parts.get('INTERVAL') ?? '1', 10) || 1));
  const countRaw = parts.get('COUNT');
  const count = countRaw ? Math.max(1, Math.min(100_000, parseInt(countRaw, 10) || 1)) : null;
  let until: number | null = null;
  let untilDate: string | null = null;
  const u = parts.get('UNTIL');
  if (u) {
    const t = parseIcalDateTime(u, tz);
    if (t) {
      if (t.allDay) {
        untilDate = t.date!;
        // Ende des Tages (inklusive)
        until = midnight(untilDate, tz) + 86_400_000 - 1;
      } else until = t.ms;
    }
  }
  const wkst = WD_CODES.indexOf((parts.get('WKST') ?? 'MO').toUpperCase());
  return {
    freq: freq as Freq,
    interval,
    count,
    until,
    untilDate,
    byday,
    bymonthday: ints('BYMONTHDAY', 1, 31),
    bymonth: ints('BYMONTH', 1, 12).filter((n) => n > 0),
    bysetpos: ints('BYSETPOS', 1, 366),
    wkst: wkst < 0 ? 1 : wkst,
  };
}

/** Regel als RRULE-Wert (ohne „RRULE:“), stabile Reihenfolge. */
export function formatRrule(r: Rrule): string {
  const out = [`FREQ=${r.freq}`];
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.count) out.push(`COUNT=${r.count}`);
  else if (r.untilDate) out.push(`UNTIL=${r.untilDate.replace(/-/g, '')}`);
  else if (r.until != null) out.push(`UNTIL=${new Date(r.until).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  if (r.bymonth.length) out.push(`BYMONTH=${r.bymonth.join(',')}`);
  if (r.bymonthday.length) out.push(`BYMONTHDAY=${r.bymonthday.join(',')}`);
  if (r.byday.length) out.push(`BYDAY=${r.byday.map((b) => `${b.n ?? ''}${WD_CODES[b.wd]}`).join(',')}`);
  if (r.bysetpos.length) out.push(`BYSETPOS=${r.bysetpos.join(',')}`);
  if (r.wkst !== 1) out.push(`WKST=${WD_CODES[r.wkst]}`);
  return out.join(';');
}

/* ------------------------------------------------------------------ Datum/Zeit im iCal-Format */

export interface IcalTime {
  ms: number;
  allDay: boolean;
  /** bei allDay: YYYY-MM-DD */
  date?: string;
  /** Zeitzone, in der die Wanduhrzeit gilt (UTC bei „Z“) */
  tz: string;
}

/**
 * „20261205“, „20261205T100000Z“ oder „20261205T100000“ (mit TZID oder ohne = schwebende Zeit in `tz`).
 * Liefert null bei unlesbaren Werten.
 */
export function parseIcalDateTime(v: string, tz: string, tzid?: string | null): IcalTime | null {
  const s = v.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const date = isoDate(+m[1], +m[2], +m[3]);
    if (!parseIsoDate(date)) return null;
    return { ms: midnight(date, tz), allDay: true, date, tz };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(s);
  if (!m) return null;
  const c: Civil = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0 };
  if (!parseIsoDate(isoDate(c.y, c.m, c.d)) || c.h > 23 || c.mi > 59 || c.s > 60) return null;
  if (m[7]) return { ms: civilMs(c), allDay: false, tz: 'UTC' };
  const zone = tzid ? resolveTzid(tzid) ?? tz : tz;
  return { ms: fromCivil(c, zone), allDay: false, tz: zone };
}

/** Häufige Windows-Zeitzonennamen (Outlook/Exchange) → IANA. */
const WINDOWS_TZ: Record<string, string> = {
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'pacific standard time': 'America/Los_Angeles',
  utc: 'UTC',
  'coordinated universal time': 'UTC',
  // deutschsprachige Exchange-Bezeichnungen
  'mitteleuropäische zeit': 'Europe/Berlin',
  'westeuropäische normalzeit': 'Europe/Berlin',
};

/** TZID aus einer Kalenderdatei → IANA-Zeitzone (oder null, wenn unbekannt). */
export function resolveTzid(tzid: string): string | null {
  const raw = tzid.trim().replace(/^"|"$/g, '');
  if (!raw) return null;
  const win = WINDOWS_TZ[raw.toLowerCase()];
  if (win) return win;
  if (/^\(UTC[+-]\d{2}:\d{2}\)/i.test(raw) && /amsterdam|berlin|bern|rom|stockholm|wien/i.test(raw)) return 'Europe/Berlin';
  if (isValidTimeZone(raw) && raw.includes('/')) return raw;
  // „/mozilla.org/20050126_1/Europe/Berlin“ und ähnliche Präfixe
  const m = /([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(raw);
  if (m && isValidTimeZone(m[1])) return m[1];
  if (raw.toUpperCase() === 'UTC' || raw.toUpperCase() === 'GMT') return 'UTC';
  return null;
}

/* ------------------------------------------------------------------ Termine bilden */

export interface SeriesSource {
  /** Beginn des ersten Termins (ms, UTC) */
  start: number;
  /** Ende des ersten Termins (ms, UTC) */
  end: number;
  allDay: boolean;
  /** Zeitzone der Wanduhrzeit (für Wiederholungen und ganztägige Termine) */
  tz: string;
  rrule: Rrule | null;
  /** Ausgenommene Beginn-Zeitpunkte (ms) – bei ganztägigen Terminen Mitternacht in `tz` */
  exdates?: number[];
}

export interface Occurrence {
  start: number;
  end: number;
}

/** Sicherheitsgrenzen gegen endlose oder sehr große Regeln. */
export const MAX_PERIODS = 60_000;
export const MAX_OCCURRENCES = 5_000;

/** Tage (Tagnummern) einer Periode nach den BY-Regeln, sortiert. */
function periodDays(r: Rrule, startDay: number, periodStart: number): number[] {
  const startCivil = fromDayNumber(startDay);
  let days: number[] = [];
  const monthDays = (y: number, m: number): number[] => {
    const dim = daysInMonth(y, m);
    const first = dayNumber(y, m, 1);
    let list: number[];
    if (r.bymonthday.length) {
      list = r.bymonthday.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim).map((d) => first + d - 1);
    } else if (r.byday.length) list = [];
    else {
      // ohne Angabe: Tag des Monats wie beim ersten Termin (Monate ohne diesen Tag entfallen, RFC 5545)
      list = startCivil.d <= dim ? [first + startCivil.d - 1] : [];
    }
    if (r.byday.length) {
      const all = Array.from({ length: dim }, (_, i) => first + i);
      const matched = new Set<number>();
      for (const b of r.byday) {
        const same = all.filter((n) => weekday(n) === b.wd);
        if (b.n == null) same.forEach((n) => matched.add(n));
        else {
          const pick = b.n > 0 ? same[b.n - 1] : same[same.length + b.n];
          if (pick != null) matched.add(pick);
        }
      }
      list = r.bymonthday.length ? list.filter((n) => matched.has(n)) : [...matched];
    }
    return list;
  };

  switch (r.freq) {
    case 'DAILY': {
      days = [periodStart];
      break;
    }
    case 'WEEKLY': {
      const wds = r.byday.length ? r.byday.map((b) => b.wd) : [weekday(startDay)];
      for (let i = 0; i < 7; i++) if (wds.includes(weekday(periodStart + i))) days.push(periodStart + i);
      break;
    }
    case 'MONTHLY': {
      const p = fromDayNumber(periodStart);
      days = monthDays(p.y, p.m);
      break;
    }
    case 'YEARLY': {
      const y = fromDayNumber(periodStart).y;
      const months = r.bymonth.length ? r.bymonth : r.byday.some((b) => b.n != null) && !r.bymonthday.length ? [] : [startCivil.m];
      if (months.length) for (const m of months) days.push(...monthDays(y, m));
      else {
        // BYDAY mit Ordnungszahl ohne BYMONTH: n-ter Wochentag des Jahres
        const first = dayNumber(y, 1, 1);
        const n = dayNumber(y + 1, 1, 1) - first;
        const all = Array.from({ length: n }, (_, i) => first + i);
        for (const b of r.byday) {
          const same = all.filter((d) => weekday(d) === b.wd);
          if (b.n == null) days.push(...same);
          else {
            const pick = b.n > 0 ? same[b.n - 1] : same[same.length + b.n];
            if (pick != null) days.push(pick);
          }
        }
      }
      break;
    }
  }
  // Einschränkungen, die bei DAILY/WEEKLY filtern
  if (r.freq === 'DAILY') {
    if (r.byday.length) days = days.filter((n) => r.byday.some((b) => b.wd === weekday(n)));
    if (r.bymonthday.length) days = days.filter((n) => { const c = fromDayNumber(n); const dim = daysInMonth(c.y, c.m); return r.bymonthday.some((d) => (d > 0 ? d : dim + d + 1) === c.d); });
  }
  if (r.bymonth.length && r.freq !== 'YEARLY') days = days.filter((n) => r.bymonth.includes(fromDayNumber(n).m));
  days = [...new Set(days)].sort((a, b) => a - b);
  if (r.bysetpos.length && days.length) {
    const picked = r.bysetpos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((n): n is number => n != null);
    days = [...new Set(picked)].sort((a, b) => a - b);
  }
  return days;
}

/** Erster Tag der Periode, in der `day` liegt. */
function periodOf(r: Rrule, day: number): number {
  switch (r.freq) {
    case 'DAILY':
      return day;
    case 'WEEKLY':
      return day - ((weekday(day) - r.wkst + 7) % 7);
    case 'MONTHLY': {
      const c = fromDayNumber(day);
      return dayNumber(c.y, c.m, 1);
    }
    case 'YEARLY':
      return dayNumber(fromDayNumber(day).y, 1, 1);
  }
}

function nextPeriod(r: Rrule, period: number): number {
  switch (r.freq) {
    case 'DAILY':
      return period + r.interval;
    case 'WEEKLY':
      return period + 7 * r.interval;
    case 'MONTHLY': {
      const c = fromDayNumber(period);
      const idx = c.y * 12 + (c.m - 1) + r.interval;
      return dayNumber(Math.floor(idx / 12), (idx % 12) + 1, 1);
    }
    case 'YEARLY':
      return dayNumber(fromDayNumber(period).y + r.interval, 1, 1);
  }
}

/**
 * Alle Termine einer Serie, die den Zeitraum [from, to) berühren (Ende > from und Beginn < to), aufsteigend.
 * Ohne Regel: nur der Termin selbst. Der erste Termin (DTSTART) zählt immer als erster Termin (auch für COUNT).
 */
export function expand(src: SeriesSource, from: number, to: number, limit = MAX_OCCURRENCES): Occurrence[] {
  const out: Occurrence[] = [];
  const ex = new Set(src.exdates ?? []);
  const dur = Math.max(0, src.end - src.start);
  const touches = (o: Occurrence) => (o.end > from || (o.end === o.start && o.start >= from)) && o.start < to;
  if (!src.rrule) {
    const o = { start: src.start, end: src.end };
    if (touches(o) && !ex.has(o.start)) out.push(o);
    return out;
  }
  const r = src.rrule;
  const tz = src.tz;
  const sc = toCivil(src.start, tz);
  const startDay = dayNumber(sc.y, sc.m, sc.d);
  // Ganztägig: Dauer in Tagen (Sommerzeit verändert die Länge eines Tages)
  const allDayDays = src.allDay ? Math.max(1, Math.round(dur / 86_400_000)) : 0;
  const make = (day: number): Occurrence => {
    const c = fromDayNumber(day);
    if (src.allDay) {
      const start = fromCivil({ ...c, h: 0, mi: 0, s: 0 }, tz);
      const e = fromDayNumber(day + allDayDays);
      return { start, end: fromCivil({ ...e, h: 0, mi: 0, s: 0 }, tz) };
    }
    const start = fromCivil({ ...c, h: sc.h, mi: sc.mi, s: sc.s }, tz);
    return { start, end: start + dur };
  };
  let emitted = 0;
  // Erster Termin
  const first = { start: src.start, end: src.end };
  emitted++;
  if (!ex.has(first.start) && touches(first)) out.push(first);
  if (r.count != null && emitted >= r.count) return out;

  let period = periodOf(r, startDay);
  for (let i = 0; i < MAX_PERIODS; i++, period = nextPeriod(r, period)) {
    for (const day of periodDays(r, startDay, period)) {
      if (day <= startDay) continue;
      const o = make(day);
      if (o.start <= src.start) continue;
      if (r.until != null && o.start > r.until) return out;
      if (o.start >= to) return out;
      emitted++;
      if (!ex.has(o.start) && touches(o)) {
        out.push(o);
        if (out.length >= limit) return out;
      }
      if (r.count != null && emitted >= r.count) return out;
    }
  }
  return out;
}

/**
 * Ende der Serie (Ende des letzten Termins) oder null bei unbegrenzter Wiederholung. Grundlage für Abfragen nach
 * Zeitraum (`until_at` in der Datenbank).
 */
export function seriesEnd(src: SeriesSource): number | null {
  if (!src.rrule) return src.end;
  if (src.rrule.count == null && src.rrule.until == null) return null;
  const all = expand({ ...src, exdates: [] }, -8.64e15, 8.64e15, MAX_OCCURRENCES);
  return all.length ? all[all.length - 1].end : src.end;
}
