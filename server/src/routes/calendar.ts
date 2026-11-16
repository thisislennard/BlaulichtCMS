import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { expand, formatRrule, localDate, midnight, parseRrule, toCivil, type Rrule } from '../calendar/recurrence.js';
import { addDays } from '../calendar/ical.js';
import { reschedulePost } from '../calendar/providers.js';
import { CATEGORY_COLORS, MAX_RANGE_DAYS, calendarProviders, calendarTimeZone, computeUntil, occurrences, safeRrule, toEntry, type CalendarEntry, type EventRow } from '../calendar/store.js';

/**
 * Kalender (#200): Kategorien mit Farben, eigene Termine und Serien (Wiederholungen nach RFC 5545), Ansichten per
 * Zeitraum. Weitere Einträge (geplante Beiträge, Fristen anderer Module) kommen über Anbieter (calendar/store.ts).
 */

const isoDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');

export const recurrenceInput = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(99).default(1),
    /** Wochentage für „wöchentlich“: 0 = Sonntag … 6 = Samstag */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    /** monatlich/jährlich: am selben Tag des Monats oder am n-ten Wochentag („jeden 1. Samstag“) */
    monthly: z.enum(['day', 'weekday']).default('day'),
    ordinal: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1)]).optional(),
    ends: z.enum(['never', 'until', 'count']).default('never'),
    until: isoDateStr.nullable().default(null),
    count: z.number().int().min(1).max(500).nullable().default(null),
  })
  .refine((r) => r.ends !== 'until' || !!r.until, { message: 'Bitte ein Enddatum wählen.', path: ['until'] })
  .refine((r) => r.ends !== 'count' || !!r.count, { message: 'Bitte die Anzahl angeben.', path: ['count'] });
export type RecurrenceInput = z.infer<typeof recurrenceInput>;

const eventInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).default(''),
  location: z.string().trim().max(300).default(''),
  allDay: z.boolean().default(false),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
  /** ganztägig: erster und letzter Tag (inklusive) */
  startDate: isoDateStr.optional(),
  endDate: isoDateStr.optional(),
  categoryId: z.uuid().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  recurrence: recurrenceInput.nullable().default(null),
});

/** Ordnungszahl des Wochentags im Monat (1–5) bzw. -1 für den letzten. */
export function ordinalOf(ms: number, tz: string): number {
  const c = toCivil(ms, tz);
  return Math.ceil(c.d / 7);
}

/** Formularangaben → RRULE (Wanduhrzeit des ersten Termins). */
export function buildRrule(rec: RecurrenceInput, start: number, tz: string): string {
  const c = toCivil(start, tz);
  const wd = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  const r: Rrule = { freq: rec.freq.toUpperCase() as Rrule['freq'], interval: rec.interval, count: null, until: null, untilDate: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
  if (rec.freq === 'weekly') r.byday = (rec.weekdays.length ? [...new Set(rec.weekdays)].sort() : [wd]).map((d) => ({ wd: d }));
  if ((rec.freq === 'monthly' || rec.freq === 'yearly') && rec.monthly === 'weekday') {
    r.byday = [{ wd, n: rec.ordinal ?? ordinalOf(start, tz) }];
    if (rec.freq === 'yearly') r.bymonth = [c.m];
  }
  if (rec.ends === 'count' && rec.count) r.count = rec.count;
  if (rec.ends === 'until' && rec.until) r.untilDate = rec.until;
  return formatRrule(r);
}

/** RRULE → Formularangaben; null, wenn die Regel mehr kann als das Formular (z. B. aus einem iCal-Kalender). */
export function recurrenceFromRrule(rule: string | null, tz: string): RecurrenceInput | null {
  if (!rule) return null;
  let r: Rrule;
  try {
    r = parseRrule(rule, tz);
  } catch {
    return null;
  }
  if (r.bymonthday.length || r.bysetpos.length) return null;
  const base: RecurrenceInput = { freq: r.freq.toLowerCase() as RecurrenceInput['freq'], interval: r.interval, weekdays: [], monthly: 'day', ends: r.count ? 'count' : r.until != null ? 'until' : 'never', until: r.untilDate ?? (r.until != null ? localDate(r.until, tz) : null), count: r.count };
  if (r.freq === 'WEEKLY') return r.byday.every((b) => b.n == null) ? { ...base, weekdays: r.byday.map((b) => b.wd) } : null;
  if (r.freq === 'MONTHLY' || r.freq === 'YEARLY') {
    if (!r.byday.length) return base;
    if (r.byday.length === 1 && r.byday[0].n != null) return { ...base, monthly: 'weekday', ordinal: r.byday[0].n as RecurrenceInput['ordinal'] };
    return null;
  }
  return r.byday.length ? null : base;
}

/** Lesbare Beschreibung einer Regel („jeden 1. Samstag im Monat, 6-mal“). */
export function describeRrule(rule: string | null, tz: string): string | null {
  if (!rule) return null;
  let r: Rrule;
  try {
    r = parseRrule(rule, tz);
  } catch {
    return 'Wiederholung (nicht unterstützte Regel)';
  }
  const DAY = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const ORD: Record<number, string> = { 1: '1.', 2: '2.', 3: '3.', 4: '4.', 5: '5.', [-1]: 'letzten' };
  const every = (one: string, many: string) => (r.interval === 1 ? one : `alle ${r.interval} ${many}`);
  let text: string;
  const days = r.byday.map((b) => (b.n != null ? `${ORD[b.n] ?? `${b.n}.`} ${DAY[b.wd]}` : DAY[b.wd]));
  switch (r.freq) {
    case 'DAILY':
      text = every('täglich', 'Tage');
      break;
    case 'WEEKLY':
      text = `${every('wöchentlich', 'Wochen')}${days.length ? ` am ${days.join(', ')}` : ''}`;
      break;
    case 'MONTHLY':
      text = `${every('monatlich', 'Monate')}${r.byday.length ? ` am ${days.join(', ')}` : r.bymonthday.length ? ` am ${r.bymonthday.map((d) => (d < 0 ? 'letzten Tag' : `${d}.`)).join(', ')}` : ''}`;
      break;
    case 'YEARLY':
      text = `${every('jährlich', 'Jahre')}${r.byday.length ? ` am ${days.join(', ')}` : ''}`;
      break;
  }
  if (r.count) text += `, ${r.count}-mal`;
  else if (r.untilDate) text += `, bis ${r.untilDate.split('-').reverse().join('.')}`;
  else if (r.until != null) text += `, bis ${localDate(r.until, tz).split('-').reverse().join('.')}`;
  return text;
}

interface Times {
  start: number;
  end: number;
  allDay: boolean;
}

/** Beginn/Ende aus der Eingabe; ganztägig als Mitternacht der Zeitzone (Ende exklusiv). */
function timesFrom(v: z.infer<typeof eventInput>, tz: string): Times {
  if (v.allDay) {
    if (!v.startDate) throw badRequest('Bitte das Datum angeben.');
    const endDate = v.endDate ?? v.startDate;
    if (endDate < v.startDate) throw badRequest('Das Ende muss nach dem Beginn liegen.');
    const start = midnight(v.startDate, tz);
    const end = addDays(midnight(endDate, tz), 1, tz);
    if (end - start > 366 * 86_400_000) throw badRequest('Ein Termin darf höchstens ein Jahr dauern.');
    return { start, end, allDay: true };
  }
  if (!v.start || !v.end) throw badRequest('Bitte Beginn und Ende angeben.');
  const start = Date.parse(v.start);
  const end = Date.parse(v.end);
  if (end < start) throw badRequest('Das Ende muss nach dem Beginn liegen.');
  if (end - start > 366 * 86_400_000) throw badRequest('Ein Termin darf höchstens ein Jahr dauern.');
  return { start, end, allDay: false };
}

async function assertCategory(id: string | null) {
  if (id && !(await one('SELECT 1 FROM calendar_categories WHERE id = $1', [id]))) throw badRequest('Die Kategorie gibt es nicht (mehr).');
}

const cleanTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim()).filter(Boolean))];

/** Termin für die Bearbeitung (Hauptzeile einer Serie oder geänderter Einzeltermin). */
async function eventDetail(id: string) {
  const e = await one<EventRow & { created_by_name: string | null; updated_by_name: string | null }>(
    `SELECT e.*, c.name AS cat_name, c.color AS cat_color, cu.name AS created_by_name, uu.name AS updated_by_name
       FROM calendar_events e LEFT JOIN calendar_categories c ON c.id = e.category_id
       LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by WHERE e.id = $1`,
    [id],
  );
  if (!e) throw notFound('Termin nicht gefunden.');
  const lastDay = e.all_day ? localDate(addDays(+e.ends_at, -1, e.tz), e.tz) : null;
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    allDay: e.all_day,
    start: new Date(e.starts_at).toISOString(),
    end: new Date(e.ends_at).toISOString(),
    startDate: e.all_day ? localDate(+e.starts_at, e.tz) : null,
    endDate: lastDay,
    tz: e.tz,
    category: e.category_id ? { id: e.category_id, name: e.cat_name, color: e.cat_color } : null,
    tags: e.tags,
    source: e.source,
    sourceId: e.source_id,
    readOnly: e.source !== 'own',
    rrule: e.rrule,
    rruleText: describeRrule(e.rrule, e.tz),
    recurrence: recurrenceFromRrule(e.rrule, e.tz),
    exdates: (e.exdates ?? []).map((d) => new Date(d).toISOString()),
    seriesId: e.series_id,
    instance: e.recurrence_id ? new Date(e.recurrence_id).toISOString() : null,
    createdAt: e.created_at,
    createdByName: e.created_by_name,
    updatedAt: e.updated_at,
    updatedByName: e.updated_by_name,
  };
}

/** Ist `instance` ein Termin dieser Serie? */
function isOccurrence(master: EventRow, instance: number): boolean {
  const rule = safeRrule(master.rrule, master.tz);
  if (!rule) return false;
  return expand({ start: +master.starts_at, end: +master.ends_at, allDay: master.all_day, tz: master.tz, rrule: rule }, instance - 1, instance + 1).some((o) => o.start === instance);
}

const csv = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export async function calendarRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- Kategorien */

  app.get('/calendar/categories', { preHandler: requireAuth('calendar.view') }, async () => {
    return many(`SELECT c.id, c.name, c.color, c.position, (SELECT count(*)::int FROM calendar_events e WHERE e.category_id = c.id) AS event_count FROM calendar_categories c ORDER BY c.position, lower(c.name)`);
  });

  const categoryInput = z.object({ name: z.string().trim().min(1).max(60), color: z.enum(CATEGORY_COLORS) });

  app.post('/calendar/categories', { preHandler: requireAuth('calendar.manage') }, async (req) => {
    const v = categoryInput.parse(req.body);
    if (await one('SELECT 1 FROM calendar_categories WHERE lower(name) = lower($1)', [v.name])) throw badRequest('Eine Kategorie mit diesem Namen gibt es schon.');
    const c = await one<any>(`INSERT INTO calendar_categories (name, color, position) VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM calendar_categories)) RETURNING *`, [v.name, v.color]);
    await audit(req.auth!.actor, 'calendar.category_created', { type: 'calendar_category', id: c.id, label: c.name }, { farbe: c.color });
    return c;
  });

  app.put('/calendar/categories/:id', { preHandler: requireAuth('calendar.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = categoryInput.parse(req.body);
    if (await one('SELECT 1 FROM calendar_categories WHERE lower(name) = lower($1) AND id <> $2', [v.name, id])) throw badRequest('Eine Kategorie mit diesem Namen gibt es schon.');
    const c = await one<any>(`UPDATE calendar_categories SET name = $2, color = $3 WHERE id = $1 RETURNING *`, [id, v.name, v.color]);
    if (!c) throw notFound();
    await audit(req.auth!.actor, 'calendar.category_updated', { type: 'calendar_category', id, label: c.name }, { farbe: c.color });
    return c;
  });

  app.delete('/calendar/categories/:id', { preHandler: requireAuth('calendar.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await one<any>(`DELETE FROM calendar_categories WHERE id = $1 RETURNING *`, [id]);
    if (!c) throw notFound();
    await audit(req.auth!.actor, 'calendar.category_deleted', { type: 'calendar_category', id, label: c.name });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- Ansicht */

  /**
   * Einträge im Zeitraum: eigene und eingelesene Termine (aufgelöst) sowie Einträge der Anbieter, für die die Person
   * das Recht hat. Filter: Kategorien (`none` = ohne Kategorie) und Quellen (own, ical, ical:<id>, post …).
   */
  app.get('/calendar/entries', { preHandler: requireAuth('calendar.view') }, async (req) => {
    const q = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), categories: z.string().max(2000).optional(), sources: z.string().max(2000).optional() }).parse(req.query);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from) throw badRequest('Das Ende des Zeitraums muss nach dem Beginn liegen.');
    if (+to - +from > MAX_RANGE_DAYS * 86_400_000) throw badRequest(`Höchstens ${MAX_RANGE_DAYS} Tage auf einmal.`);
    const cats = csv(q.categories);
    const sources = csv(q.sources);
    const want = (src: string, sourceId?: string | null) => !sources.length || sources.includes(src) || (!!sourceId && sources.includes(`${src}:${sourceId}`));
    const perms = req.auth!.permissions;
    let entries: CalendarEntry[] = (await occurrences(from, to)).map(toEntry).filter((e) => want(e.source, e.sourceId));
    for (const p of calendarProviders()) {
      if (!perms.has(p.permission) || !want(p.id)) continue;
      try {
        entries.push(...(await p.list(from, to, { permissions: perms, userId: req.auth!.user?.id ?? null })));
      } catch (e) {
        req.log.warn({ err: e }, `Kalender-Anbieter ${p.id} fehlgeschlagen`);
      }
    }
    if (cats.length) entries = entries.filter((e) => (e.category ? cats.includes(e.category.id) : cats.includes('none') || e.kind !== 'event'));
    entries.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'de'));
    return {
      timeZone: await calendarTimeZone(),
      entries: entries.slice(0, 3000),
      truncated: entries.length > 3000,
      sources: [
        { id: 'own', label: 'Eigene Termine' },
        ...(await many<{ id: string; name: string }>('SELECT id, name FROM calendar_sources ORDER BY lower(name)')).map((s) => ({ id: `ical:${s.id}`, label: `iCal: ${s.name}` })),
        ...calendarProviders().filter((p) => perms.has(p.permission)).map((p) => ({ id: p.id, label: p.label })),
      ],
    };
  });

  /* ---------------------------------------------------------------- Termine */

  app.get('/calendar/events/:id', { preHandler: requireAuth('calendar.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return eventDetail(id);
  });

  app.post('/calendar/events', { preHandler: requireAuth('calendar.manage') }, async (req) => {
    const v = eventInput.parse(req.body);
    const tz = await calendarTimeZone();
    const t = timesFrom(v, tz);
    await assertCategory(v.categoryId);
    const rrule = v.recurrence ? buildRrule(v.recurrence, t.start, tz) : null;
    if (v.recurrence?.ends === 'until' && v.recurrence.until! < localDate(t.start, tz)) throw badRequest('Das Ende der Wiederholung liegt vor dem ersten Termin.');
    const until = computeUntil({ starts_at: t.start, ends_at: t.end, all_day: t.allDay, tz, rrule });
    const uid = req.auth!.user?.id ?? null;
    const e = await one<any>(
      `INSERT INTO calendar_events (title, description, location, starts_at, ends_at, all_day, tz, category_id, tags, rrule, until_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id, title`,
      [v.title, v.description, v.location, new Date(t.start), new Date(t.end), t.allDay, tz, v.categoryId, cleanTags(v.tags), rrule, until, uid],
    );
    await audit(req.auth!.actor, 'calendar.event_created', { type: 'calendar_event', id: e.id, label: e.title }, { beginn: new Date(t.start).toISOString(), ganztaegig: t.allDay, wiederholung: rrule });
    return eventDetail(e.id);
  });

  /**
   * Ändern. Bei einer Serie: `scope: 'series'` ändert die ganze Serie (Werte des ersten Termins), `scope: 'instance'`
   * mit `instance` (ursprünglicher Beginn) legt einen geänderten Einzeltermin an bzw. ändert ihn.
   */
  app.put('/calendar/events/:id', { preHandler: requireAuth('calendar.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ scope: z.enum(['series', 'instance']).default('series'), instance: z.iso.datetime({ offset: true }).optional() }).passthrough().parse(req.body);
    const v = eventInput.parse(req.body);
    const tz = await calendarTimeZone();
    await assertCategory(v.categoryId);
    const uid = req.auth!.user?.id ?? null;
    const resultId = await tx(async (db) => {
      const e = await one<EventRow>('SELECT * FROM calendar_events WHERE id = $1 FOR UPDATE', [id], db);
      if (!e) throw notFound('Termin nicht gefunden.');
      if (e.source !== 'own') throw new AppError(409, 'read_only', 'Eingelesene Termine sind schreibgeschützt. Änderungen bitte im Ursprungskalender vornehmen.');
      const zone = e.tz || tz;
      const t = timesFrom(v, zone);
      if (e.rrule && body.scope === 'instance') {
        if (!body.instance) throw badRequest('Bitte den Termin der Serie angeben.');
        const inst = Date.parse(body.instance);
        if (!isOccurrence(e, inst)) throw badRequest('Diesen Termin gibt es in der Serie nicht.');
        const existing = await one<{ id: string }>('SELECT id FROM calendar_events WHERE series_id = $1 AND recurrence_id = $2', [id, new Date(inst)], db);
        if (existing) {
          await db.query(`UPDATE calendar_events SET title=$2, description=$3, location=$4, starts_at=$5, ends_at=$6, all_day=$7, category_id=$8, tags=$9, updated_at=now(), updated_by=$10 WHERE id = $1`, [existing.id, v.title, v.description, v.location, new Date(t.start), new Date(t.end), t.allDay, v.categoryId, cleanTags(v.tags), uid]);
          await audit(req.auth!.actor, 'calendar.event_updated', { type: 'calendar_event', id: existing.id, label: v.title }, { umfang: 'einzeltermin', serie: id }, 'ok', db);
          return existing.id;
        }
        const o = await one<{ id: string }>(
          `INSERT INTO calendar_events (title, description, location, starts_at, ends_at, all_day, tz, category_id, tags, series_id, recurrence_id, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
          [v.title, v.description, v.location, new Date(t.start), new Date(t.end), t.allDay, zone, v.categoryId, cleanTags(v.tags), id, new Date(inst), uid],
          db,
        );
        await audit(req.auth!.actor, 'calendar.event_updated', { type: 'calendar_event', id: o!.id, label: v.title }, { umfang: 'einzeltermin', serie: id, termin: new Date(inst).toISOString() }, 'ok', db);
        return o!.id;
      }
      // Geänderter Einzeltermin bleibt Einzeltermin; sonst Termin bzw. ganze Serie
      const rrule = e.series_id ? null : v.recurrence ? buildRrule(v.recurrence, t.start, zone) : null;
      if (v.recurrence && !e.series_id && v.recurrence.ends === 'until' && v.recurrence.until! < localDate(t.start, zone)) throw badRequest('Das Ende der Wiederholung liegt vor dem ersten Termin.');
      const until = computeUntil({ starts_at: t.start, ends_at: t.end, all_day: t.allDay, tz: zone, rrule });
      await db.query(
        `UPDATE calendar_events SET title=$2, description=$3, location=$4, starts_at=$5, ends_at=$6, all_day=$7, category_id=$8, tags=$9, rrule=$10, until_at=$11, updated_at=now(), updated_by=$12 WHERE id = $1`,
        [id, v.title, v.description, v.location, new Date(t.start), new Date(t.end), t.allDay, v.categoryId, cleanTags(v.tags), rrule, until, uid],
      );
      // Aus einer Serie wird ein einzelner Termin: Ausnahmen und geänderte Termine entfallen
      if (e.rrule && !rrule) {
        await db.query(`UPDATE calendar_events SET exdates = '{}' WHERE id = $1`, [id]);
        await db.query(`DELETE FROM calendar_events WHERE series_id = $1`, [id]);
      }
      await audit(req.auth!.actor, 'calendar.event_updated', { type: 'calendar_event', id, label: v.title }, { umfang: e.rrule ? 'serie' : 'termin', wiederholung: rrule }, 'ok', db);
      return id;
    });
    return eventDetail(resultId);
  });

  /**
   * Löschen: `scope=series` (Standard) löscht den Termin bzw. die ganze Serie samt geänderten Terminen;
   * `scope=instance&instance=…` nimmt nur diesen Termin aus der Serie heraus.
   */
  app.delete('/calendar/events/:id', { preHandler: requireAuth('calendar.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const q = z.object({ scope: z.enum(['series', 'instance']).default('series'), instance: z.iso.datetime({ offset: true }).optional() }).parse(req.query);
    await tx(async (db) => {
      const e = await one<EventRow>('SELECT * FROM calendar_events WHERE id = $1 FOR UPDATE', [id], db);
      if (!e) throw notFound('Termin nicht gefunden.');
      if (e.source !== 'own') throw new AppError(409, 'read_only', 'Eingelesene Termine sind schreibgeschützt.');
      if (q.scope === 'instance' && (e.rrule || e.series_id)) {
        const masterId = e.series_id ?? e.id;
        const inst = e.series_id ? +e.recurrence_id! : q.instance ? Date.parse(q.instance) : NaN;
        if (Number.isNaN(inst)) throw badRequest('Bitte den Termin der Serie angeben.');
        if (!e.series_id && !isOccurrence(e, inst)) throw badRequest('Diesen Termin gibt es in der Serie nicht.');
        await db.query(`UPDATE calendar_events SET exdates = array_append(exdates, $2), updated_at = now() WHERE id = $1 AND NOT ($2 = ANY(exdates))`, [masterId, new Date(inst)]);
        await db.query(`DELETE FROM calendar_events WHERE series_id = $1 AND recurrence_id = $2`, [masterId, new Date(inst)]);
        await audit(req.auth!.actor, 'calendar.event_deleted', { type: 'calendar_event', id: masterId, label: e.title }, { umfang: 'einzeltermin', termin: new Date(inst).toISOString() }, 'ok', db);
        return;
      }
      const target = e.series_id ?? e.id;
      const del = await one<{ title: string }>('DELETE FROM calendar_events WHERE id = $1 RETURNING title', [target], db);
      await audit(req.auth!.actor, 'calendar.event_deleted', { type: 'calendar_event', id: target, label: del?.title ?? e.title }, { umfang: e.rrule || e.series_id ? 'serie' : 'termin' }, 'ok', db);
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- Geplante Beiträge (#201) */

  /**
   * Termin eines geplanten Beitrags verschieben (Ziehen im Kalender oder Datum/Uhrzeit ändern). Erzeugt eine neue
   * Fassung; eine Freigabe der bisherigen Fassung entfällt nach den bestehenden Regeln.
   */
  app.post('/calendar/posts/:id/schedule', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ revision: z.number().int().min(1), publishAt: z.iso.datetime({ offset: true }) }).parse(req.body);
    return reschedulePost(id, body, req.auth!.actor, req.auth!.user?.id ?? null);
  });
}
