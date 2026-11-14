/**
 * Schlanker iCalendar-Leser (RFC 5545) für Kalender-Exporte (z. B. Alamos FE2 iCal-Export).
 * Unterstützt: Zeilenfaltung, Escapes, DTSTART/DTEND mit TZID, UTC oder Ganztags (VALUE=DATE),
 * DURATION, STATUS, LAST-MODIFIED, SEQUENCE, RECURRENCE-ID, EXDATE und RRULE mit
 * FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (wöchentlich).
 */

export interface IcsEvent {
  uid: string;
  /** Eindeutiger Schlüssel je Vorkommen (uid + Startzeit bei Serien) */
  key: string;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string | null;
  all_day: boolean;
  status: string;
  categories: string[];
  organizer: string;
  sequence: number;
  recurring: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
}

function parseLine(line: string): Prop | null {
  // Doppelpunkt außerhalb von Anführungszeichen trennt Name/Parameter vom Wert
  let inQuote = false;
  let idx = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ':' && !inQuote) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const head = line.slice(0, idx).split(';');
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(idx + 1) };
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** Lokale Wandzeit in einer Zeitzone → UTC-Millisekunden. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

function validTz(tz: string | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    // Windows-Zeitzonennamen, wie sie manche Exporte schreiben
    const map: Record<string, string> = { 'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Berlin' };
    return map[tz] ?? fallback;
  }
}

function parseDate(p: Prop, defaultTz: string): { ms: number; allDay: boolean } | null {
  const v = p.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || p.params.VALUE === 'DATE') {
    m ??= /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { ms: zonedToUtc(+m[1], +m[2], +m[3], 0, 0, 0, validTz(p.params.TZID, defaultTz)), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  if (m[7] === 'Z') return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
  return { ms: zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], validTz(p.params.TZID, defaultTz)), allDay: false };
}

function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const ms = (+(m[2] ?? 0) * 7 * 86400 + +(m[3] ?? 0) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

interface RawEvent {
  props: Map<string, Prop[]>;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function expandRrule(rule: string, startMs: number, tz: string, windowStart: number, windowEnd: number, exdates: Set<number>): number[] {
  const r = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]));
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL ?? 1));
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  let until = Infinity;
  if (r.UNTIL) {
    const u = parseDate({ name: 'UNTIL', params: {}, value: r.UNTIL }, tz);
    if (u) until = u.ms + (u.allDay ? 86_399_000 : 0);
  }
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d: string) => DAY_CODES.indexOf(d.slice(-2))) : null;
  // Wandzeit in der Zeitzone fortschreiben, damit Sommerzeitwechsel korrekt bleiben
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
      .formatToParts(new Date(startMs))
      .map((x) => [x.type, x.value]),
  );
  const base = { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
  const out: number[] = [];
  let n = 0;
  const push = (ms: number) => {
    if (ms < startMs) return true;
    if (ms > until || n >= count) return false;
    n++;
    if (ms >= windowStart && ms <= windowEnd && !exdates.has(ms)) out.push(ms);
    return true;
  };
  for (let i = 0; i < 2000 && out.length < 500; i++) {
    if (freq === 'DAILY') {
      const dt = new Date(Date.UTC(base.y, base.mo - 1, base.d + i * interval));
      const ms = zonedToUtc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), base.h, base.mi, base.s, tz);
      if (!push(ms) || ms > windowEnd) break;
    } else if (freq === 'WEEKLY') {
      const weekStart = new Date(Date.UTC(base.y, base.mo - 1, base.d + i * 7 * interval));
      const startDow = new Date(Date.UTC(base.y, base.mo - 1, base.d)).getUTCDay();
      const days = byDay && byDay.length ? [...byDay].sort((a, b) => ((a - startDow + 7) % 7) - ((b - startDow + 7) % 7)) : [startDow];
      let stop = false;
      for (const dow of days) {
        const dt = new Date(weekStart.getTime() + ((dow - startDow + 7) % 7) * 86_400_000);
        const ms = zonedToUtc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), base.h, base.mi, base.s, tz);
        if (!push(ms)) {
          stop = true;
          break;
        }
        if (ms > windowEnd) stop = true;
      }
      if (stop) break;
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const months = freq === 'MONTHLY' ? i * interval : i * interval * 12;
      const dt = new Date(Date.UTC(base.y, base.mo - 1 + months, 1));
      const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      if (base.d > dim) continue; // z. B. 31. in kurzen Monaten auslassen (RFC-Verhalten)
      const ms = zonedToUtc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, base.d, base.h, base.mi, base.s, tz);
      if (!push(ms) || ms > windowEnd) break;
    } else break;
  }
  return out;
}

export function parseIcs(text: string, opts: { defaultTz: string; windowStart: number; windowEnd: number }): IcsEvent[] {
  const lines = unfold(text);
  const raws: RawEvent[] = [];
  let cur: RawEvent | null = null;
  let depth = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      cur = { props: new Map() };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) depth++;
    else if (/^END:VEVENT$/i.test(line)) {
      raws.push(cur);
      cur = null;
      continue;
    } else if (/^END:/i.test(line)) depth--;
    if (depth > 0) continue; // VALARM etc. ignorieren
    const p = parseLine(line);
    if (!p) continue;
    const list = cur.props.get(p.name) ?? [];
    list.push(p);
    cur.props.set(p.name, list);
  }

  const get = (e: RawEvent, n: string) => e.props.get(n)?.[0];
  const overrides = new Map<string, RawEvent>();
  for (const e of raws) {
    const rid = get(e, 'RECURRENCE-ID');
    const uid = get(e, 'UID')?.value;
    if (rid && uid) {
      const d = parseDate(rid, opts.defaultTz);
      if (d) overrides.set(`${uid}|${d.ms}`, e);
    }
  }

  const out: IcsEvent[] = [];
  for (const e of raws) {
    if (get(e, 'RECURRENCE-ID')) continue;
    const uid = get(e, 'UID')?.value ?? '';
    const dtStart = get(e, 'DTSTART');
    if (!uid || !dtStart) continue;
    const start = parseDate(dtStart, opts.defaultTz);
    if (!start) continue;
    const dtEnd = get(e, 'DTEND');
    const end = dtEnd ? parseDate(dtEnd, opts.defaultTz) : null;
    const dur = get(e, 'DURATION');
    const lengthMs = end ? end.ms - start.ms : dur ? parseDuration(dur.value) : start.allDay ? 86_400_000 : 0;
    const tz = validTz(dtStart.params.TZID, opts.defaultTz);
    const exdates = new Set<number>();
    for (const ex of e.props.get('EXDATE') ?? []) {
      for (const v of ex.value.split(',')) {
        const d = parseDate({ ...ex, value: v }, opts.defaultTz);
        if (d) exdates.add(d.ms);
      }
    }
    const rrule = get(e, 'RRULE')?.value;
    const occurrences = rrule ? expandRrule(rrule, start.ms, tz, opts.windowStart, opts.windowEnd, exdates) : start.ms + Math.max(lengthMs, 0) >= opts.windowStart && start.ms <= opts.windowEnd ? [start.ms] : [];
    for (const occ of occurrences) {
      const ov = rrule ? overrides.get(`${uid}|${occ}`) : undefined;
      const src = ov ?? e;
      let s = occ;
      let len = lengthMs;
      if (ov) {
        const os = get(ov, 'DTSTART');
        const oe = get(ov, 'DTEND');
        const p1 = os ? parseDate(os, opts.defaultTz) : null;
        const p2 = oe ? parseDate(oe, opts.defaultTz) : null;
        if (p1) s = p1.ms;
        if (p1 && p2) len = p2.ms - p1.ms;
      }
      out.push({
        uid,
        key: rrule ? `${uid}|${occ}` : uid,
        title: unescapeText(get(src, 'SUMMARY')?.value ?? ''),
        description: unescapeText(get(src, 'DESCRIPTION')?.value ?? '').slice(0, 5000),
        location: unescapeText(get(src, 'LOCATION')?.value ?? ''),
        start: new Date(s).toISOString(),
        end: len > 0 ? new Date(s + len).toISOString() : null,
        all_day: start.allDay,
        status: (get(src, 'STATUS')?.value ?? 'CONFIRMED').toUpperCase(),
        categories: (get(src, 'CATEGORIES')?.value ?? '')
          .split(',')
          .map((x) => unescapeText(x.trim()))
          .filter(Boolean),
        organizer: (get(src, 'ORGANIZER')?.params.CN ?? get(src, 'ORGANIZER')?.value ?? '').replace(/^mailto:/i, ''),
        sequence: Number(get(src, 'SEQUENCE')?.value ?? 0),
        recurring: !!rrule,
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
