import { describe, expect, it } from 'vitest';
import { buildIcs, escapeText, foldLine, parseDuration, parseIcal, unfold, unescapeText } from '../src/calendar/ical.js';
import { expand, formatRrule, fromCivil, localDate, midnight, parseRrule, resolveTzid, seriesEnd, toCivil, type SeriesSource } from '../src/calendar/recurrence.js';

/** Kalender (#200, #202): Wiederholungsregeln, Zeitzonen und iCal-Lesen/-Schreiben – reine Unit-Tests ohne Datenbank. */
const TZ = 'Europe/Berlin';
const berlin = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s)!;
  return fromCivil({ y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: 0 }, TZ);
};
const fmt = (ms: number) => {
  const c = toCivil(ms, TZ);
  return `${localDate(ms, TZ)} ${String(c.h).padStart(2, '0')}:${String(c.mi).padStart(2, '0')}`;
};
const series = (start: string, rule: string | null, opts: Partial<SeriesSource> = {}, durMin = 60): SeriesSource => {
  const s = berlin(start);
  return { start: s, end: s + durMin * 60_000, allDay: false, tz: TZ, rrule: rule ? parseRrule(rule, TZ) : null, ...opts };
};
const all = (src: SeriesSource, from = '2000-01-01', to = '2100-01-01') => expand(src, berlin(from), berlin(to)).map((o) => fmt(o.start));

describe('Zeitzone Europe/Berlin', () => {
  it('rechnet Winter- und Sommerzeit richtig um', () => {
    expect(new Date(berlin('2026-01-15 10:00')).toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(new Date(berlin('2026-07-15 10:00')).toISOString()).toBe('2026-07-15T08:00:00.000Z');
  });
  it('verschiebt eine Uhrzeit in der Umstellungslücke nach vorn und wählt bei doppelter Uhrzeit die frühere', () => {
    // 29.03.2026: 02:00 → 03:00
    expect(fmt(berlin('2026-03-29 02:30'))).toBe('2026-03-29 03:30');
    // 25.10.2026: 03:00 → 02:00, 02:30 kommt zweimal vor
    expect(new Date(berlin('2026-10-25 02:30')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('Mitternacht und Ortsdatum', () => {
    expect(new Date(midnight('2026-06-01', TZ)).toISOString()).toBe('2026-05-31T22:00:00.000Z');
    expect(localDate(Date.parse('2026-05-31T22:30:00Z'), TZ)).toBe('2026-06-01');
  });
  it('bildet TZID aus Outlook, Google und Mozilla auf IANA ab', () => {
    expect(resolveTzid('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(resolveTzid('Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTzid('/mozilla.org/20050126_1/Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTzid('"Europe/Vienna"')).toBe('Europe/Vienna');
    expect(resolveTzid('Unbekannte Zone')).toBeNull();
  });
});

describe('Wiederholungsregeln', () => {
  it('täglich mit Intervall und Anzahl', () => {
    expect(all(series('2026-11-02 18:00', 'FREQ=DAILY;INTERVAL=2;COUNT=4'))).toEqual(['2026-11-02 18:00', '2026-11-04 18:00', '2026-11-06 18:00', '2026-11-08 18:00']);
  });
  it('wöchentlich an mehreren Tagen bis zu einem Datum (inklusive)', () => {
    expect(all(series('2026-11-02 19:00', 'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261112'))).toEqual(['2026-11-02 19:00', '2026-11-05 19:00', '2026-11-09 19:00', '2026-11-12 19:00']);
  });
  it('alle zwei Wochen, Wochenbeginn Montag', () => {
    expect(all(series('2026-11-04 19:00', 'FREQ=WEEKLY;INTERVAL=2;COUNT=3'))).toEqual(['2026-11-04 19:00', '2026-11-18 19:00', '2026-12-02 19:00']);
  });
  it('„jeden 1. Samstag“ im Monat', () => {
    expect(all(series('2026-11-07 10:00', 'FREQ=MONTHLY;BYDAY=1SA;COUNT=4'))).toEqual(['2026-11-07 10:00', '2026-12-05 10:00', '2027-01-02 10:00', '2027-02-06 10:00']);
  });
  it('letzter Freitag im Monat und BYSETPOS', () => {
    expect(all(series('2026-11-27 20:00', 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3'))).toEqual(['2026-11-27 20:00', '2026-12-25 20:00', '2027-01-29 20:00']);
    // letzter Werktag
    expect(all(series('2026-11-30 08:00', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3'))).toEqual(['2026-11-30 08:00', '2026-12-31 08:00', '2027-01-29 08:00']);
  });
  it('monatlich am Monatstag – Monate ohne diesen Tag entfallen, BYMONTHDAY auch negativ', () => {
    expect(all(series('2026-01-31 09:00', 'FREQ=MONTHLY;COUNT=4'))).toEqual(['2026-01-31 09:00', '2026-03-31 09:00', '2026-05-31 09:00', '2026-07-31 09:00']);
    expect(all(series('2026-01-15 09:00', 'FREQ=MONTHLY;BYMONTHDAY=15,-1;COUNT=4'))).toEqual(['2026-01-15 09:00', '2026-01-31 09:00', '2026-02-15 09:00', '2026-02-28 09:00']);
  });
  it('jährlich, auch mit BYMONTH und Ordnungszahl', () => {
    expect(all(series('2024-02-29 12:00', 'FREQ=YEARLY;COUNT=2'))).toEqual(['2024-02-29 12:00', '2028-02-29 12:00']);
    // Tag der offenen Tür: 2. Sonntag im Mai
    expect(all(series('2026-05-10 11:00', 'FREQ=YEARLY;BYMONTH=5;BYDAY=2SU;COUNT=3'))).toEqual(['2026-05-10 11:00', '2027-05-09 11:00', '2028-05-14 11:00']);
  });
  it('behält die Ortszeit über die Zeitumstellung', () => {
    const occ = expand(series('2026-03-21 10:00', 'FREQ=WEEKLY;COUNT=2'), 0, 8.64e15);
    expect(occ.map((o) => new Date(o.start).toISOString())).toEqual(['2026-03-21T09:00:00.000Z', '2026-03-28T09:00:00.000Z']);
    const occ2 = expand(series('2026-03-28 10:00', 'FREQ=WEEKLY;COUNT=2'), 0, 8.64e15);
    expect(new Date(occ2[1].start).toISOString()).toBe('2026-04-04T08:00:00.000Z');
    expect(occ2[1].end - occ2[1].start).toBe(3600_000);
  });
  it('Ausnahmen (EXDATE) entfallen, zählen aber für COUNT', () => {
    const src = series('2026-11-02 18:00', 'FREQ=DAILY;COUNT=4', { exdates: [berlin('2026-11-03 18:00')] });
    expect(all(src)).toEqual(['2026-11-02 18:00', '2026-11-04 18:00', '2026-11-05 18:00']);
  });
  it('liefert nur Termine im Zeitraum, auch bei unbegrenzter Regel', () => {
    const src = series('2020-01-06 19:00', 'FREQ=WEEKLY;BYDAY=MO');
    expect(all(src, '2026-11-01', '2026-11-20')).toEqual(['2026-11-02 19:00', '2026-11-09 19:00', '2026-11-16 19:00']);
    expect(seriesEnd(src)).toBeNull();
  });
  it('berührt den Zeitraum auch, wenn der Termin vorher beginnt', () => {
    const src = series('2026-11-02 23:00', null, {}, 120);
    expect(all(src, '2026-11-03', '2026-11-04')).toEqual(['2026-11-02 23:00']);
  });
  it('ganztägige Serie bleibt über die Umstellung ganztägig', () => {
    const s = midnight('2026-10-24', TZ);
    const src: SeriesSource = { start: s, end: midnight('2026-10-25', TZ), allDay: true, tz: TZ, rrule: parseRrule('FREQ=DAILY;COUNT=3') };
    const occ = expand(src, 0, 8.64e15);
    expect(occ.map((o) => localDate(o.start, TZ))).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(occ.every((o) => toCivil(o.start, TZ).h === 0 && toCivil(o.end, TZ).h === 0)).toBe(true);
    // 25.10. hat 25 Stunden
    expect(occ[1].end - occ[1].start).toBe(25 * 3600_000);
  });
  it('Ende der Serie bei COUNT und UNTIL', () => {
    expect(fmt(seriesEnd(series('2026-11-02 18:00', 'FREQ=DAILY;COUNT=3'))!)).toBe('2026-11-04 19:00');
    expect(fmt(seriesEnd(series('2026-11-02 18:00', 'FREQ=WEEKLY;UNTIL=20261116T170000Z'))!)).toBe('2026-11-16 19:00');
  });
  it('RRULE lesen und schreiben', () => {
    const r = parseRrule('FREQ=MONTHLY;INTERVAL=1;BYDAY=1SA;UNTIL=20271231');
    expect(r.byday).toEqual([{ wd: 6, n: 1 }]);
    expect(r.untilDate).toBe('2027-12-31');
    expect(formatRrule(r)).toBe('FREQ=MONTHLY;UNTIL=20271231;BYDAY=1SA');
    expect(() => parseRrule('FREQ=HOURLY')).toThrow(/nicht unterstützt/);
  });
});

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//DE',
  'X-WR-CALNAME:Wehr-Kalender',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:uebung-1@example.org',
  'SUMMARY:Übungsdienst\\, Gruppe 1',
  'DESCRIPTION:Treffpunkt Gerätehaus.\\nBitte PSA mitbringen.',
  'LOCATION:Gerätehaus',
  'DTSTART;TZID=W. Europe Standard Time:20261107T100000',
  'DTEND;TZID=W. Europe Standard Time:20261107T120000',
  'RRULE:FREQ=MONTHLY;BYDAY=1SA;COUNT=6',
  'EXDATE;TZID=W. Europe Standard Time:20270102T100000',
  'CATEGORIES:Übung,Ausbildung',
  'BEGIN:VALARM',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Erinnerung',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:uebung-1@example.org',
  'RECURRENCE-ID;TZID=W. Europe Standard Time:20261205T100000',
  'SUMMARY:Übungsdienst (verschoben)',
  'DTSTART;TZID=W. Europe Standard Time:20261205T140000',
  'DTEND;TZID=W. Europe Standard Time:20261205T160000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:fest@example.org',
  'SUMMARY:Sommerfest mit sehr langem Titel, der über mehrere Zeilen gefaltet wird und trot',
  ' zdem ganz ankommt',
  'DTSTART;VALUE=DATE:20270703',
  'DTEND;VALUE=DATE:20270705',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:utc@example.org',
  'SUMMARY:Besprechung',
  'DTSTART:20261110T170000Z',
  'DURATION:PT1H30M',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:float@example.org',
  'SUMMARY:Schwebend',
  'DTSTART:20261111T080000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('iCal lesen', () => {
  it('Zeilen entfalten und Texte entmaskieren', () => {
    expect(unfold('A:1\r\n 23\r\nB:x\n\tyz')).toEqual(['A:123', 'B:xyz']);
    expect(unescapeText('a\\, b\\; c\\nd\\\\e')).toBe('a, b; c\nd\\e');
    expect(parseDuration('PT1H30M')).toBe(5_400_000);
    expect(parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(parseDuration('-PT15M')).toBe(-900_000);
    expect(parseDuration('P')).toBeNull();
  });

  it('liest Termine mit TZID, Serie, Ausnahme, Änderung, ganztägig, UTC, Dauer und Status', () => {
    const cal = parseIcal(SAMPLE, TZ);
    expect(cal.name).toBe('Wehr-Kalender');
    expect(cal.events).toHaveLength(5);
    const [series1, override, fest, utc, float] = cal.events;
    expect(series1.summary).toBe('Übungsdienst, Gruppe 1');
    expect(series1.description).toBe('Treffpunkt Gerätehaus.\nBitte PSA mitbringen.');
    expect(series1.location).toBe('Gerätehaus');
    expect(series1.tz).toBe('Europe/Berlin');
    expect(fmt(series1.start)).toBe('2026-11-07 10:00');
    expect(series1.end - series1.start).toBe(2 * 3600_000);
    expect(series1.rrule).toBe('FREQ=MONTHLY;BYDAY=1SA;COUNT=6');
    expect(series1.categories).toEqual(['Übung', 'Ausbildung']);
    expect(series1.exdates.map(fmt)).toEqual(['2027-01-02 10:00']);
    // VALARM-Beschreibung überschreibt nichts
    expect(series1.description).not.toContain('Erinnerung');
    expect(override.recurrenceId && fmt(override.recurrenceId)).toBe('2026-12-05 10:00');
    expect(fmt(override.start)).toBe('2026-12-05 14:00');
    expect(fest.summary).toBe('Sommerfest mit sehr langem Titel, der über mehrere Zeilen gefaltet wird und trotzdem ganz ankommt');
    expect(fest.allDay).toBe(true);
    expect(localDate(fest.start, TZ)).toBe('2027-07-03');
    expect(localDate(fest.end, TZ)).toBe('2027-07-05');
    expect(new Date(utc.start).toISOString()).toBe('2026-11-10T17:00:00.000Z');
    expect(utc.end - utc.start).toBe(5_400_000);
    expect(utc.cancelled).toBe(true);
    expect(fmt(float.start)).toBe('2026-11-11 08:00');
    expect(float.end).toBe(float.start);

    // Serie bilden: Ausnahme entfällt, geänderter Termin ersetzt den ursprünglichen
    const occ = expand({ start: series1.start, end: series1.end, allDay: false, tz: series1.tz, rrule: series1.rruleParsed, exdates: [...series1.exdates, override.recurrenceId!] }, 0, 8.64e15);
    expect(occ.map((o) => fmt(o.start))).toEqual(['2026-11-07 10:00', '2027-02-06 10:00', '2027-03-06 10:00', '2027-04-03 10:00']);
  });

  it('lehnt Dateien ohne VCALENDAR ab und meldet nicht unterstützte Regeln', () => {
    expect(() => parseIcal('<html>Fehler</html>')).toThrow(/keine Kalenderdatei/);
    const cal = parseIcal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Stündlich\nDTSTART:20261101T100000Z\nRRULE:FREQ=HOURLY\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Ohne Beginn\nEND:VEVENT\nEND:VCALENDAR');
    expect(cal.events).toHaveLength(1);
    expect(cal.events[0].rrule).toBeNull();
    expect(cal.warnings.join(' ')).toMatch(/nicht unterstützt/);
    expect(cal.warnings.join(' ')).toMatch(/ohne Beginn/);
  });

  it('ganztägige Ausnahme bei einem Termin mit Uhrzeit trifft den Termin an diesem Tag', () => {
    const cal = parseIcal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:y\nSUMMARY:Dienst\nDTSTART;TZID=Europe/Berlin:20261102T190000\nRRULE:FREQ=WEEKLY;COUNT=3\nEXDATE;VALUE=DATE:20261109\nEND:VEVENT\nEND:VCALENDAR', TZ);
    expect(cal.events[0].exdates.map(fmt)).toEqual(['2026-11-09 19:00']);
  });
});

describe('iCal schreiben (Abo)', () => {
  it('faltet lange Zeilen auf 75 Bytes ohne Zeichen zu zerteilen', () => {
    const long = `SUMMARY:${'Ä'.repeat(60)}`;
    const folded = foldLine(long);
    for (const l of folded.split('\r\n')) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(unfold(folded)[0]).toBe(long);
  });

  it('erzeugt eine lesbare Datei, die sich wieder einlesen lässt', () => {
    const start = berlin('2026-11-07 10:00');
    const ics = buildIcs('BlaulichtCMS', [
      { uid: 'a@x', start, end: start + 3600_000, allDay: false, summary: 'Übung; Gruppe, 1', categories: ['Übung'] },
      { uid: 'b@x', start: midnight('2026-12-24', TZ), end: midnight('2026-12-25', TZ), allDay: true, summary: 'Heiligabend', description: 'Zeile 1\nZeile 2' },
    ], TZ);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261107T090000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261224');
    expect(ics).toContain('SUMMARY:Übung\\; Gruppe\\, 1');
    const back = parseIcal(ics, TZ);
    expect(back.events.map((e) => e.summary)).toEqual(['Übung; Gruppe, 1', 'Heiligabend']);
    expect(back.events[1].description).toBe('Zeile 1\nZeile 2');
    expect(back.events[1].allDay).toBe(true);
    expect(back.events[0].start).toBe(start);
  });

  it('maskiert jeden Zeilenumbruch (auch ein einzelnes CR) und lässt Steuerzeichen weg (#238)', () => {
    expect(escapeText('a\rb\r\nc\nd')).toBe('a\\nb\\nc\\nd');
    expect(escapeText('Tab\tbleibt\u0007\u001b weg\u007f')).toBe('Tab\tbleibt weg');
    const start = berlin('2026-11-07 10:00');
    const ics = buildIcs('Name\rmit CR', [{ uid: 'cr@x', start, end: start + 3600_000, allDay: false, summary: 'Übung\rEND:VEVENT', description: 'Zeile 1\rZeile 2\r\nZeile 3', location: 'Ort\u000bA' }], TZ);
    // CR nur als Teil des Zeilenendes CRLF – keine eingeschleuste Zeile
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(unfold(ics).filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    const back = parseIcal(ics, TZ);
    expect(back.name).toBe('Name\nmit CR');
    expect(back.events).toHaveLength(1);
    expect(back.events[0]).toMatchObject({ summary: 'Übung\nEND:VEVENT', description: 'Zeile 1\nZeile 2\nZeile 3', location: 'OrtA' });
  });
});
