import { localDate, parseIcalDateTime, parseRrule, resolveTzid, RruleError, toCivil, type Rrule } from './recurrence.js';

/**
 * Kalenderdateien (iCalendar, RFC 5545) lesen und schreiben – bewusst nur die Teilmenge, die Outlook, Google, Apple
 * und typische Wehr-Kalender liefern: VEVENT mit UID, SUMMARY, DESCRIPTION, LOCATION, DTSTART/DTEND/DURATION (UTC,
 * TZID oder ganztägig), RRULE, EXDATE, RECURRENCE-ID (geänderte Einzeltermine), STATUS, CATEGORIES. VTIMEZONE-Blöcke
 * werden nicht ausgewertet: TZID wird auf eine IANA-Zeitzone abgebildet (auch Windows-Namen wie „W. Europe Standard
 * Time“). Zeilenumbrüche nach RFC 5545 („folding“) und Maskierungen werden aufgelöst.
 */

export interface IcalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  /** Zeitzone der Wanduhrzeit (für Wiederholungen) */
  tz: string;
  /** Normalisierte Regel als Text (oder null) */
  rrule: string | null;
  rruleParsed: Rrule | null;
  exdates: number[];
  /** Beginn des ursprünglichen Termins, den dieser Eintrag ersetzt (RECURRENCE-ID) */
  recurrenceId: number | null;
  cancelled: boolean;
  categories: string[];
  sequence: number;
}

export interface ParsedCalendar {
  name: string | null;
  events: IcalEvent[];
  /** Hinweise zu übersprungenen oder vereinfachten Einträgen */
  warnings: string[];
}

export class IcalError extends Error {}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Steuerzeichen außer Tab, Zeilenvorschub und Wagenrücklauf. RFC 5545 erlaubt sie in keinem Wert; NUL (U+0000) lehnt
 * PostgreSQL in Textspalten sogar ab – ein einziges solches Zeichen in einer Fremddatei ließe sonst den Abgleich der
 * ganzen Quelle bei jedem Abruf scheitern (#237).
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Gefaltete Zeilen zusammenführen (CRLF/LF + Leerzeichen oder Tab); unzulässige Steuerzeichen entfallen. */
export function unfold(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

export function parseLine(raw: string): Line | null {
  // Name und Parameter bis zum ersten Doppelpunkt außerhalb von Anführungszeichen
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  const segs: string[] = [];
  let cur = '';
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      segs.push(cur);
      cur = '';
    } else cur += ch;
  }
  segs.push(cur);
  const name = segs[0].trim().toUpperCase();
  const params: Record<string, string> = {};
  for (const p of segs.slice(1)) {
    const i = p.indexOf('=');
    if (i > 0) params[p.slice(0, i).trim().toUpperCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** TEXT-Werte: \n, \, \; und \\ auflösen; unzulässige Steuerzeichen entfallen. */
export function unescapeText(v: string): string {
  return v.replace(CONTROL_CHARS, '').replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Nicht maskierte Kommas trennen (CATEGORIES, EXDATE). */
function splitList(v: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      cur += v[i] + v[i + 1];
      i++;
    } else if (v[i] === ',') {
      out.push(cur);
      cur = '';
    } else cur += v[i];
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** ISO-8601-Dauer (P1D, PT1H30M, P1W, -PT15M) in ms. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim());
  if (!m || v.trim().length < 3) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86_400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const MAX_EVENTS = 5_000;

/**
 * Kalenderdatei lesen. `tz` ist die Zeitzone für schwebende Zeiten und ganztägige Termine (Einstellung der Instanz).
 * Wirft IcalError, wenn die Datei kein VCALENDAR enthält.
 */
export function parseIcal(text: string, tz = 'Europe/Berlin'): ParsedCalendar {
  const lines = unfold(text);
  if (!lines.some((l) => /^BEGIN:VCALENDAR\s*$/i.test(l))) throw new IcalError('Die Adresse liefert keine Kalenderdatei (iCal/ICS).');
  const warnings: string[] = [];
  const events: IcalEvent[] = [];
  let name: string | null = null;
  let calTz: string | null = null;
  const stack: string[] = [];
  let cur: Line[] | null = null;
  for (const raw of lines) {
    const l = parseLine(raw);
    if (!l) continue;
    if (l.name === 'BEGIN') {
      const comp = l.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length === 2) cur = [];
      continue;
    }
    if (l.name === 'END') {
      const comp = stack.pop();
      if (comp === 'VEVENT' && cur && stack.length === 1) {
        if (events.length >= MAX_EVENTS) {
          if (events.length === MAX_EVENTS) warnings.push(`Mehr als ${MAX_EVENTS} Termine – weitere wurden nicht übernommen.`);
          cur = null;
          continue;
        }
        // Ein einzelner unlesbarer Termin darf nie die ganze Datei (und damit die Quelle) scheitern lassen
        try {
          const ev = toEvent(cur, calTz ?? tz, tz, warnings);
          if (ev) events.push(ev);
        } catch {
          const title = unescapeText(cur.find((x) => x.name === 'SUMMARY')?.value ?? '').trim().slice(0, 80) || '(ohne Titel)';
          warnings.push(`„${title}“ nicht lesbar – übersprungen.`);
        }
        cur = null;
      }
      continue;
    }
    if (stack.length === 1 && stack[0] === 'VCALENDAR') {
      if (l.name === 'X-WR-CALNAME') name = unescapeText(l.value).trim().slice(0, 200) || null;
      if (l.name === 'X-WR-TIMEZONE') calTz = resolveTzid(l.value);
    }
    // Nur Eigenschaften des VEVENT selbst (nicht VALARM darin)
    if (cur && stack.length === 2 && stack[1] === 'VEVENT') cur.push(l);
  }
  return { name, events, warnings };
}

function toEvent(lines: Line[], floatingTz: string, defaultTz: string, warnings: string[]): IcalEvent | null {
  const get = (n: string) => lines.find((l) => l.name === n);
  const uid = (get('UID')?.value ?? '').trim().slice(0, 500);
  const summary = unescapeText(get('SUMMARY')?.value ?? '').trim().slice(0, 300) || '(ohne Titel)';
  const dtstart = get('DTSTART');
  if (!dtstart) {
    warnings.push(`„${summary}“ ohne Beginn übersprungen.`);
    return null;
  }
  const isDate = (l: Line) => (l.params.VALUE ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(l.value.trim());
  const start = parseIcalDateTime(dtstart.value, isDate(dtstart) ? defaultTz : floatingTz, dtstart.params.TZID);
  if (!start) {
    warnings.push(`„${summary}“: Beginn „${dtstart.value}“ nicht lesbar.`);
    return null;
  }
  // Ganztägige Termine gelten in der Zeitzone der Instanz
  const tz = start.allDay ? defaultTz : start.tz;
  let end = start.allDay ? start.ms + 86_400_000 : start.ms;
  const dtend = get('DTEND');
  const dur = get('DURATION');
  if (dtend) {
    const e = parseIcalDateTime(dtend.value, isDate(dtend) ? defaultTz : floatingTz, dtend.params.TZID);
    if (e && e.ms >= start.ms) end = e.ms;
  } else if (dur) {
    const d = parseDuration(dur.value);
    if (d != null && d >= 0) end = start.ms + d;
  }
  if (start.allDay) {
    // Ende auf Mitternacht der Zeitzone runden (Tage zählen statt Stunden)
    const days = Math.max(1, Math.round((end - start.ms) / 86_400_000));
    end = addDays(start.ms, days, tz);
  }
  let rrule: string | null = null;
  let rruleParsed: Rrule | null = null;
  const rr = get('RRULE');
  if (rr) {
    try {
      rruleParsed = parseRrule(rr.value, tz);
      rrule = rr.value.trim().replace(/^RRULE:/i, '');
    } catch (e) {
      warnings.push(`„${summary}“: ${e instanceof RruleError ? e.message : 'Wiederholung nicht lesbar'} – nur der erste Termin wird übernommen.`);
    }
  }
  const exdates: number[] = [];
  for (const l of lines.filter((x) => x.name === 'EXDATE')) {
    for (const v of splitList(l.value)) {
      const t = parseIcalDateTime(v, isDate(l) || /^\d{8}$/.test(v) ? tz : floatingTz, l.params.TZID);
      if (!t) continue;
      // ganztägige Ausnahme bei einem Termin mit Uhrzeit: der Termin an diesem Tag
      if (t.allDay && !start.allDay) {
        const sc = toCivil(start.ms, tz);
        const day = parseIcalDateTime(`${v.trim()}T${String(sc.h).padStart(2, '0')}${String(sc.mi).padStart(2, '0')}${String(sc.s).padStart(2, '0')}`, tz, tz);
        if (day) exdates.push(day.ms);
      } else exdates.push(t.ms);
    }
  }
  let recurrenceId: number | null = null;
  const rid = get('RECURRENCE-ID');
  if (rid) {
    const t = parseIcalDateTime(rid.value, isDate(rid) ? defaultTz : floatingTz, rid.params.TZID);
    if (t) recurrenceId = t.ms;
  }
  const categories = lines.filter((l) => l.name === 'CATEGORIES').flatMap((l) => splitList(l.value).map(unescapeText)).map((c) => c.trim().slice(0, 60)).filter(Boolean).slice(0, 20);
  return {
    uid: uid || `ohne-uid:${summary}:${start.ms}`,
    summary,
    description: unescapeText(get('DESCRIPTION')?.value ?? '').trim().slice(0, 5000),
    location: unescapeText(get('LOCATION')?.value ?? '').trim().slice(0, 300),
    start: start.ms,
    end,
    allDay: start.allDay,
    tz,
    rrule,
    rruleParsed,
    exdates,
    recurrenceId,
    cancelled: (get('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED',
    categories,
    sequence: parseInt(get('SEQUENCE')?.value ?? '0', 10) || 0,
  };
}

/** Kalendertage zu einem Zeitpunkt (Mitternacht) addieren – unabhängig von Sommer-/Winterzeit. */
export function addDays(ms: number, days: number, tz: string): number {
  const c = toCivil(ms, tz);
  const d = new Date(Date.UTC(c.y, c.m - 1, c.d + days));
  return parseIcalDateTime(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`, tz)!.ms;
}

/* ------------------------------------------------------------------ Schreiben (Abo) */

export interface IcsOutEvent {
  uid: string;
  start: number;
  end: number;
  allDay: boolean;
  summary: string;
  description?: string;
  location?: string;
  categories?: string[];
  lastModified?: number;
}

/**
 * TEXT-Werte maskieren (RFC 5545, 3.3.11): `\`, `;` und `,` mit Backslash; jeder Zeilenumbruch – CRLF, LF und ein
 * einzelnes CR – wird zu `\n`. Übrige Steuerzeichen außer Tab sind in TEXT nicht erlaubt und entfallen, damit kein
 * Wert die Zeilenstruktur der Datei stört.
 */
export function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(CONTROL_CHARS, '');
}

/** Zeile nach RFC 5545 auf höchstens 75 Bytes falten (UTF-8, ohne Zeichen zu zerteilen). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const max = out.length ? 74 : 75;
    if (bytes + b > max) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = (ms: number, tz: string) => localDate(ms, tz).replace(/-/g, '');

/** Kalenderdatei für ein Abo (einzelne Termine, Zeiten in UTC, ganztägig als Datum in `tz`). */
export function buildIcs(name: string, events: IcsOutEvent[], tz: string, now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BlaulichtCMS//Kalender//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utcStamp(e.lastModified ?? now)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start, tz)}`, `DTEND;VALUE=DATE:${dateStamp(e.end > e.start ? e.end : e.start + 86_400_000, tz)}`);
    else lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(Math.max(e.end, e.start))}`);
    lines.push(`SUMMARY:${escapeText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(escapeText).join(',')}`);
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
