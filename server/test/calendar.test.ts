import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { invalidateRoles } from '../src/auth/roles.js';
import { fromCivil, localDate, toCivil } from '../src/calendar/recurrence.js';
import { parseIcal } from '../src/calendar/ical.js';
import { refreshDueCalendarSources } from '../src/calendar/sources.js';
import { calendarTriggerTick } from '../src/calendar/triggers.js';

/**
 * Kalender (#200–#203) gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL). Die Datenbank wird zu Beginn
 * geleert (die Testdateien laufen nacheinander).
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
let ipCounter = 10;
const TZ = 'Europe/Berlin';
const berlin = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(fromCivil({ y, m, d, h, mi, s: 0 }, TZ)).toISOString();
const hm = (iso: string) => {
  const c = toCivil(Date.parse(iso), TZ);
  return `${localDate(Date.parse(iso), TZ)} ${String(c.h).padStart(2, '0')}:${String(c.mi).padStart(2, '0')}`;
};

class Client {
  cookie = '';
  ip = `10.79.0.${ipCounter++}`;
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as any,
      remoteAddress: this.ip,
      url: `/api/v1${url}`,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json, headers: res.headers, body: res.body };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
  del = (u: string) => this.raw('DELETE', u);
}

let admin: Client;
let viewer: Client;
let passwordHash: string;

const login = async (email: string) => {
  const c = new Client(app);
  expect((await c.post('/auth/login', { email, password: PASSWORD })).json.next).toBe('done');
  return c;
};
const entries = async (c: Client, from: string, to: string, extra = '') => (await c.get(`/calendar/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`)).json.entries as any[];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateRoles();
  await migrate(() => {});
  app = await buildApp();
  await pool.query(`INSERT INTO users (email, name, password_hash, roles) VALUES ('admin@example.org','Alex Admin',$1,'{platform_admin}'), ('lesen@example.org','Lea Lesen',$1,'{viewer}')`, [passwordHash]);
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
  admin = await login('admin@example.org');
  viewer = await login('lesen@example.org');
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Kalender: Kategorien und Termine (#200)', () => {
  let uebung: string;

  it('liefert die vorbelegten Kategorien und verwaltet sie', async () => {
    const cats = (await admin.get('/calendar/categories')).json;
    expect(cats.map((c: any) => c.name)).toEqual(['Übung', 'Veranstaltung', 'Besprechung']);
    uebung = cats[0].id;
    expect((await admin.post('/calendar/categories', { name: 'übung', color: 'rot' })).status).toBe(400);
    expect((await admin.post('/calendar/categories', { name: 'Dienst', color: 'pink' })).status).toBe(400);
    const c = await admin.post('/calendar/categories', { name: 'Dienst', color: 'gruen' });
    expect(c.status).toBe(200);
    expect((await admin.put(`/calendar/categories/${c.json.id}`, { name: 'Dienstabend', color: 'tuerkis' })).json.color).toBe('tuerkis');
    expect((await admin.del(`/calendar/categories/${c.json.id}`)).status).toBe(200);
  });

  it('Lesezugriff: sehen ja, ändern nein', async () => {
    expect((await viewer.get('/calendar/categories')).status).toBe(200);
    expect((await viewer.post('/calendar/categories', { name: 'X', color: 'rot' })).status).toBe(403);
    expect((await viewer.post('/calendar/events', { title: 'X', startDate: '2026-12-01', allDay: true })).status).toBe(403);
    const me = (await viewer.get('/auth/me')).json;
    expect(me.permissions).toContain('calendar.view');
    expect(me.permissions).not.toContain('calendar.manage');
  });

  it('einzelner Termin mit Uhrzeit, ganztägiger Termin über mehrere Tage', async () => {
    const t = await admin.post('/calendar/events', { title: 'Jahreshauptversammlung', location: 'Gerätehaus', start: berlin(2026, 12, 4, 19, 30), end: berlin(2026, 12, 4, 22, 0), categoryId: null, tags: ['Verein', 'Verein'] });
    expect(t.status).toBe(200);
    expect(t.json.tags).toEqual(['Verein']);
    const a = await admin.post('/calendar/events', { title: 'Weihnachtsmarkt', allDay: true, startDate: '2026-12-12', endDate: '2026-12-13' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ allDay: true, startDate: '2026-12-12', endDate: '2026-12-13' });
    expect(a.json.start).toBe(berlin(2026, 12, 12));
    expect(a.json.end).toBe(berlin(2026, 12, 14));
    expect((await admin.post('/calendar/events', { title: 'Falsch', start: berlin(2026, 12, 4, 20), end: berlin(2026, 12, 4, 19) })).status).toBe(400);
    const list = await entries(viewer, berlin(2026, 12, 1), berlin(2026, 12, 31));
    expect(list.map((e) => e.title)).toEqual(['Jahreshauptversammlung', 'Weihnachtsmarkt']);
    expect(list[0]).toMatchObject({ kind: 'event', source: 'own', readOnly: false, recurring: false, location: 'Gerätehaus' });
  });

  let serie: string;
  it('Serie „jeden 1. Samstag“ mit Anzahl, über die Zeitumstellung in Ortszeit', async () => {
    const r = await admin.post('/calendar/events', {
      title: 'Übungsdienst',
      start: berlin(2026, 2, 7, 10),
      end: berlin(2026, 2, 7, 12),
      categoryId: uebung,
      tags: ['Ausbildung'],
      recurrence: { freq: 'monthly', monthly: 'weekday', ends: 'count', count: 6 },
    });
    expect(r.status).toBe(200);
    serie = r.json.id;
    expect(r.json.rrule).toBe('FREQ=MONTHLY;COUNT=6;BYDAY=1SA');
    expect(r.json.rruleText).toBe('monatlich am 1. Samstag, 6-mal');
    expect(r.json.recurrence).toMatchObject({ freq: 'monthly', monthly: 'weekday', ordinal: 1, ends: 'count', count: 6 });
    const list = (await entries(admin, berlin(2026, 1, 1), berlin(2026, 12, 31))).filter((e) => e.seriesId === serie);
    expect(list.map((e) => hm(e.start))).toEqual(['2026-02-07 10:00', '2026-03-07 10:00', '2026-04-04 10:00', '2026-05-02 10:00', '2026-06-06 10:00', '2026-07-04 10:00']);
    expect(list[0].category).toMatchObject({ name: 'Übung', color: 'orange' });
    expect(list[2].key).toBe(`event:${serie}:${list[2].instance}`);
    // until_at begrenzt die Abfrage
    expect((await one<any>('SELECT until_at FROM calendar_events WHERE id = $1', [serie]))!.until_at.toISOString()).toBe(berlin(2026, 7, 4, 12));
    expect((await entries(admin, berlin(2026, 8, 1), berlin(2026, 12, 31))).filter((e) => e.seriesId === serie)).toEqual([]);
  });

  it('einzelnen Termin der Serie ändern und einen anderen löschen', async () => {
    const april = berlin(2026, 4, 4, 10);
    const r = await admin.put(`/calendar/events/${serie}`, { scope: 'instance', instance: april, title: 'Übungsdienst (Atemschutz)', start: berlin(2026, 4, 4, 14), end: berlin(2026, 4, 4, 17), categoryId: uebung });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ seriesId: serie, instance: april, title: 'Übungsdienst (Atemschutz)' });
    const overrideId = r.json.id;
    // nochmal ändern: dieselbe Zeile
    expect((await admin.put(`/calendar/events/${serie}`, { scope: 'instance', instance: april, title: 'Übungsdienst (AGT)', start: berlin(2026, 4, 4, 14), end: berlin(2026, 4, 4, 17), categoryId: uebung })).json.id).toBe(overrideId);
    expect((await admin.put(`/calendar/events/${serie}`, { scope: 'instance', instance: berlin(2026, 4, 5, 10), title: 'X', start: berlin(2026, 4, 5, 10), end: berlin(2026, 4, 5, 11) })).status).toBe(400);
    expect((await admin.del(`/calendar/events/${serie}?scope=instance&instance=${encodeURIComponent(berlin(2026, 5, 2, 10))}`)).status).toBe(200);
    const list = (await entries(admin, berlin(2026, 1, 1), berlin(2026, 12, 31))).filter((e) => e.seriesId === serie);
    expect(list.map((e) => `${hm(e.start)} ${e.title}`)).toEqual(['2026-02-07 10:00 Übungsdienst', '2026-03-07 10:00 Übungsdienst', '2026-04-04 14:00 Übungsdienst (AGT)', '2026-06-06 10:00 Übungsdienst', '2026-07-04 10:00 Übungsdienst']);
    // Geänderten Einzeltermin löschen: Termin entfällt ganz
    expect((await admin.del(`/calendar/events/${overrideId}?scope=instance`)).status).toBe(200);
    const after = (await entries(admin, berlin(2026, 1, 1), berlin(2026, 12, 31))).filter((e) => e.seriesId === serie);
    expect(after).toHaveLength(4);
    expect((await one<any>('SELECT cardinality(exdates) AS n FROM calendar_events WHERE id = $1', [serie]))!.n).toBe(2);
  });

  it('wöchentliche Serie ohne Ende, Filter nach Kategorie und Quelle', async () => {
    const r = await admin.post('/calendar/events', { title: 'Dienstabend', start: berlin(2026, 1, 5, 19), end: berlin(2026, 1, 5, 21), recurrence: { freq: 'weekly', weekdays: [1, 4], ends: 'never' } });
    expect(r.json.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TH');
    expect(r.json.rruleText).toBe('wöchentlich am Montag, Donnerstag');
    const nov = await entries(admin, berlin(2026, 11, 1), berlin(2026, 11, 15));
    expect(nov.filter((e) => e.title === 'Dienstabend').map((e) => hm(e.start))).toEqual(['2026-11-02 19:00', '2026-11-05 19:00', '2026-11-09 19:00', '2026-11-12 19:00']);
    const onlyUebung = await entries(admin, berlin(2026, 1, 1), berlin(2026, 12, 31), `&categories=${uebung}`);
    expect(new Set(onlyUebung.map((e) => e.title))).toEqual(new Set(['Übungsdienst']));
    const none = await entries(admin, berlin(2026, 12, 1), berlin(2026, 12, 31), '&categories=none');
    expect(none.map((e) => e.title)).toContain('Weihnachtsmarkt');
    expect(none.map((e) => e.title)).not.toContain('Übungsdienst');
    expect(await entries(admin, berlin(2026, 12, 1), berlin(2026, 12, 31), '&sources=ical')).toEqual([]);
    expect((await admin.get(`/calendar/entries?from=${encodeURIComponent(berlin(2026, 1, 1))}&to=${encodeURIComponent(berlin(2028, 1, 1))}`)).status).toBe(400);
    // Serie in Einzeltermin umwandeln
    const u = await admin.put(`/calendar/events/${r.json.id}`, { title: 'Dienstabend', start: berlin(2026, 1, 5, 19), end: berlin(2026, 1, 5, 21), recurrence: null });
    expect(u.json.rrule).toBeNull();
    expect((await entries(admin, berlin(2026, 11, 1), berlin(2026, 11, 15))).filter((e) => e.title === 'Dienstabend')).toEqual([]);
    expect((await admin.del(`/calendar/events/${r.json.id}`)).status).toBe(200);
  });

  it('Serie löschen entfernt auch geänderte Termine; Kategorie löschen lässt Termine ohne Kategorie', async () => {
    const r = await admin.put(`/calendar/events/${serie}`, { scope: 'instance', instance: berlin(2026, 6, 6, 10), title: 'Sonder', start: berlin(2026, 6, 6, 9), end: berlin(2026, 6, 6, 10), categoryId: uebung });
    expect(r.status).toBe(200);
    expect((await admin.del(`/calendar/events/${r.json.id}?scope=series`)).status).toBe(200);
    expect(await one('SELECT 1 FROM calendar_events WHERE id = $1 OR series_id = $1', [serie])).toBeNull();
    const c = await admin.post('/calendar/categories', { name: 'Kurz', color: 'violett' });
    const e = await admin.post('/calendar/events', { title: 'Mit Kategorie', start: berlin(2026, 12, 20, 10), end: berlin(2026, 12, 20, 11), categoryId: c.json.id });
    await admin.del(`/calendar/categories/${c.json.id}`);
    expect((await admin.get(`/calendar/events/${e.json.id}`)).json.category).toBeNull();
    const audit = await many<any>(`SELECT action FROM audit_events WHERE action LIKE 'calendar.%'`);
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(['calendar.category_created', 'calendar.category_updated', 'calendar.category_deleted', 'calendar.event_created', 'calendar.event_updated', 'calendar.event_deleted']));
  });
});

describe('Kalender: geplante Beiträge und Presse-Fristen (#201)', () => {
  let postId: string;
  const inDays = (d: number, h = 9) => {
    const t = new Date(Date.now() + d * 86_400_000);
    const c = toCivil(+t, TZ);
    return berlin(c.y, c.m, c.d, h, 0);
  };
  const range = () => [inDays(-3), inDays(30)] as const;

  it('zeigt Beiträge mit Termin samt Status und Kanälen; Lesezugriff ohne Verschieben', async () => {
    await setSettings({ 'editorial.four_eyes': false } as any);
    const p = await admin.post('/posts', { title: 'Tag der offenen Tür', kind: 'event' });
    postId = p.json.id;
    expect((await admin.put(`/posts/${postId}/revision`, { baseRevision: 1, title: 'Tag der offenen Tür', body: 'Herzliche Einladung', publishAt: inDays(5) })).json.changed).toBe(true);
    const [from, to] = range();
    const list = (await entries(admin, from, to)).filter((e) => e.kind === 'post');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: postId, title: 'Tag der offenen Tür', start: inDays(5), status: 'draft', statusLabel: 'Entwurf', movable: true, link: `/beitraege/${postId}`, source: 'post', color: 'post' });
    expect(list[0].meta).toMatchObject({ revision: 2 });
    const asViewer = (await entries(viewer, from, to)).filter((e) => e.kind === 'post');
    expect(asViewer[0]).toMatchObject({ movable: false, readOnly: true });
    expect((await viewer.post(`/calendar/posts/${postId}/schedule`, { revision: 2, publishAt: inDays(6) })).status).toBe(403);
    // Quellenfilter
    expect((await entries(admin, from, to, '&sources=own')).some((e) => e.kind === 'post')).toBe(false);
    expect((await admin.get(`/calendar/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json.sources.map((s: any) => s.id)).toEqual(['own', 'post', 'press']);
    expect((await viewer.get(`/calendar/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json.sources.map((s: any) => s.id)).toEqual(['own', 'post']);
  });

  it('Verschieben erzeugt eine neue Fassung; die Freigabe entfällt nach den bestehenden Regeln', async () => {
    expect((await admin.post(`/posts/${postId}/submit`, { revision: 2 })).status).toBe(200);
    const st = (await admin.get(`/posts/${postId}`)).json;
    expect((await admin.post(`/posts/${postId}/decision`, { revision: 2, contentHash: st.revision.content_hash, decision: 'approved' })).status).toBe(200);
    const [from, to] = range();
    expect((await entries(admin, from, to)).find((e) => e.kind === 'post')).toMatchObject({ status: 'approved', movable: true, meta: { approved: true } });
    // veralteter Stand → 409, Vergangenheit → 400
    expect((await admin.post(`/calendar/posts/${postId}/schedule`, { revision: 1, publishAt: inDays(6) })).status).toBe(409);
    expect((await admin.post(`/calendar/posts/${postId}/schedule`, { revision: 2, publishAt: inDays(-2) })).status).toBe(400);
    const r = await admin.post(`/calendar/posts/${postId}/schedule`, { revision: 2, publishAt: inDays(7, 18) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, number: 3, approvalInvalidated: true, wasSubmitted: true });
    const after = (await admin.get(`/posts/${postId}`)).json;
    expect(after.state).toBe('draft');
    expect(after.revision).toMatchObject({ number: 3, publish_at: inDays(7, 18), body: 'Herzliche Einladung' });
    expect(after.revisions[0].change_note).toBe('Termin im Kalender verschoben');
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'post.revised' ORDER BY id DESC LIMIT 1`))!.details).toMatchObject({ quelle: 'Kalender', freigabe_entfaellt: true, fassung: 3 });
    // gleicher Termin: keine neue Fassung
    expect((await admin.post(`/calendar/posts/${postId}/schedule`, { revision: 3, publishAt: inDays(7, 18) })).json.changed).toBe(false);
  });

  it('beauftragte Veröffentlichung lässt sich nicht im Kalender verschieben', async () => {
    const st = (await admin.get(`/posts/${postId}`)).json;
    await admin.post(`/posts/${postId}/submit`, { revision: 3 });
    await admin.post(`/posts/${postId}/decision`, { revision: 3, contentHash: st.revision.content_hash, decision: 'approved' });
    // Stellvertretend für einen beauftragten Social-Post
    const conn = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('facebook', 'Seite', 'active', '{}') RETURNING id`);
    const appr = await one<any>(`SELECT id FROM approvals WHERE revision_id = $1 AND revoked_at IS NULL`, [st.revision.id]);
    await pool.query(`INSERT INTO social_publications (post_id, revision_id, approval_id, connection_id, status, marker) VALUES ($1, $2, $3, $4, 'queued', 'bc-test')`, [postId, st.revision.id, appr!.id, conn!.id]);
    const [from, to] = range();
    expect((await entries(admin, from, to)).find((e) => e.kind === 'post')).toMatchObject({ movable: false });
    const r = await admin.post(`/calendar/posts/${postId}/schedule`, { revision: 3, publishAt: inDays(8) });
    expect(r.status).toBe(409);
    expect(r.json.message ?? r.json.error).toMatch(/sozialen Kanälen|bereits beauftragt/);
  });

  it('Fristen von Presseanfragen, überfällige hervorgehoben – nur mit Recht', async () => {
    await pool.query(`INSERT INTO press_requests (case_no, topic, outlet, due_at, status) VALUES ('P-2026-0001', 'Nachfrage zum Brand', 'Tageblatt', $1, 'new'), ('P-2026-0002', 'Interview Jugendfeuerwehr', 'Radio', $2, 'in_progress'), ('P-2026-0003', 'Erledigt', '', $2, 'done')`, [inDays(-1), inDays(2)]);
    const [from, to] = range();
    const press = (await entries(admin, from, to)).filter((e) => e.kind === 'press');
    expect(press.map((e) => [e.title, e.overdue, e.statusLabel])).toEqual([
      ['Frist P-2026-0001: Nachfrage zum Brand', true, 'neu'],
      ['Frist P-2026-0002: Interview Jugendfeuerwehr', false, 'in Bearbeitung'],
    ]);
    expect(press[0]).toMatchObject({ readOnly: true, color: 'press', link: expect.stringMatching(/^\/presse\//) });
    expect((await entries(viewer, from, to)).some((e) => e.kind === 'press')).toBe(false);
    expect((await entries(admin, from, to, '&sources=press')).every((e) => e.kind === 'press')).toBe(true);
  });
});

describe('Kalender: iCal einlesen und als Abo anbieten (#202)', () => {
  // Beispiel-Kalender auf einem lokalen Server; Inhalt und Antwort sind je Test einstellbar
  let ics = '';
  let status = 200;
  let hits = 0;
  let server: http.Server;
  let base = '';
  const cal = (events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Wehr-Kalender', ...events, 'END:VCALENDAR'].join('\r\n');
  const SERIES = ['BEGIN:VEVENT', 'UID:dienst@wehr', 'SUMMARY:Dienstabend', 'DTSTART;TZID=W. Europe Standard Time:20261102T193000', 'DTEND;TZID=W. Europe Standard Time:20261102T213000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6', 'EXDATE;TZID=W. Europe Standard Time:20261109T193000', 'CATEGORIES:Ausbildung', 'END:VEVENT'].join('\r\n');
  const MOVED = ['BEGIN:VEVENT', 'UID:dienst@wehr', 'RECURRENCE-ID;TZID=W. Europe Standard Time:20261116T193000', 'SUMMARY:Dienstabend (Atemschutz)', 'DTSTART;TZID=W. Europe Standard Time:20261117T190000', 'DTEND;TZID=W. Europe Standard Time:20261117T210000', 'END:VEVENT'].join('\r\n');
  const CANCELLED = ['BEGIN:VEVENT', 'UID:dienst@wehr', 'RECURRENCE-ID;TZID=W. Europe Standard Time:20261123T193000', 'STATUS:CANCELLED', 'SUMMARY:Dienstabend', 'DTSTART;TZID=W. Europe Standard Time:20261123T193000', 'END:VEVENT'].join('\r\n');
  const FEST = ['BEGIN:VEVENT', 'UID:fest@wehr', 'SUMMARY:Sommerfest', 'DESCRIPTION:Mit Fahrzeugschau', 'LOCATION:Gerätehaus', 'DTSTART;VALUE=DATE:20261205', 'DTEND;VALUE=DATE:20261207', 'END:VEVENT'].join('\r\n');
  let sourceId: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'file:///etc/passwd' });
        return res.end();
      }
      res.writeHead(status, { 'content-type': 'text/calendar' });
      res.end(status === 200 ? ics : 'Fehler');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('Schutz: interne Adressen ohne Freigabe gesperrt, Zugangsdaten in der Adresse abgewiesen, Rechte', async () => {
    ics = cal([SERIES]);
    const blocked = await admin.post('/calendar/sources/test', { url: `${base}/kalender.ics?token=geheim` });
    expect(blocked.status).toBe(400);
    expect(blocked.json.message).toMatch(/internes Netz/);
    expect(hits).toBe(0);
    expect((await admin.post('/calendar/sources/test', { url: 'https://nutzer:pw@example.org/k.ics' })).status).toBe(400);
    expect((await admin.post('/calendar/sources/test', { url: 'ftp://example.org/k.ics' })).status).toBe(400);
    expect((await viewer.post('/calendar/sources/test', { url: `${base}/k.ics` })).status).toBe(403);
    expect((await viewer.get('/calendar/sources')).status).toBe(403);
    await setSettings({ 'security.allowed_private_hosts': ['127.0.0.1'] } as any);
  });

  it('Verbindungstest liest die Datei, ohne etwas zu speichern; Fehler verständlich', async () => {
    ics = cal([SERIES, MOVED, FEST]);
    const t = await admin.post('/calendar/sources/test', { url: `${base}/kalender.ics?token=geheim` });
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ name: 'Wehr-Kalender', events: 3, recurring: 1 });
    expect(await one('SELECT 1 FROM calendar_sources')).toBeNull();
    ics = '<html>Anmeldung</html>';
    expect((await admin.post('/calendar/sources/test', { url: `${base}/k.ics` })).json.message).toMatch(/keine Kalenderdatei/);
    status = 404;
    expect((await admin.post('/calendar/sources/test', { url: `${base}/k.ics` })).json.message).toMatch(/404/);
    status = 200;
    expect((await admin.post('/calendar/sources/test', { url: `${base}/redirect` })).status).toBe(400);
  });

  it('Quelle anlegen: Adresse verschlüsselt, Termine schreibgeschützt mit Kategorie, Serie mit Ausnahme und Änderung', async () => {
    ics = cal([SERIES, MOVED, FEST]);
    const cats = (await admin.get('/calendar/categories')).json;
    const uebung = cats.find((c: any) => c.name === 'Übung').id;
    const r = await admin.post('/calendar/sources', { name: 'Wehr', url: `${base}/kalender.ics?token=geheim`, categoryId: uebung, intervalMin: 30 });
    expect(r.status).toBe(200);
    sourceId = r.json.id;
    expect(r.json).toMatchObject({ name: 'Wehr', host: '127.0.0.1', eventCount: 3, active: true });
    expect(JSON.stringify(r.json)).not.toContain('geheim');
    const src = await one<any>('SELECT * FROM calendar_sources WHERE id = $1', [sourceId]);
    const secret = await one<any>('SELECT ciphertext, owner_type FROM secrets WHERE id = $1', [src.url_secret_id]);
    expect(secret.owner_type).toBe('calendar_source');
    expect(secret.ciphertext).not.toContain('geheim');
    expect(JSON.stringify(await many('SELECT * FROM audit_events WHERE action LIKE $1', ['calendar.source%']))).not.toContain('geheim');
    const list = (await entries(admin, berlin(2026, 11, 1), berlin(2026, 12, 31), `&sources=ical:${sourceId}`)).map((e) => `${hm(e.start)} ${e.title}`);
    expect(list).toEqual(['2026-11-02 19:30 Dienstabend', '2026-11-17 19:00 Dienstabend (Atemschutz)', '2026-11-23 19:30 Dienstabend', '2026-11-30 19:30 Dienstabend', '2026-12-05 00:00 Sommerfest', '2026-12-07 19:30 Dienstabend']);
    const e = (await entries(admin, berlin(2026, 11, 1), berlin(2026, 12, 31), '&sources=ical')).find((x) => x.title === 'Sommerfest')!;
    expect(e).toMatchObject({ readOnly: true, source: 'ical', sourceName: 'Wehr', allDay: true, category: { name: 'Übung' }, tags: [] });
    expect((await admin.put(`/calendar/events/${e.id}`, { title: 'X', allDay: true, startDate: '2026-12-05' })).status).toBe(409);
    expect((await admin.del(`/calendar/events/${e.id}`)).status).toBe(409);
    expect((await admin.get('/calendar/entries?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z')).json.sources.map((s: any) => s.id)).toContain(`ical:${sourceId}`);
    // webcal:// wird zu https://
    expect((await admin.post('/calendar/sources/test', { url: 'webcal://nicht-vorhanden.invalid/k.ics' })).json.message).not.toMatch(/Protokoll|webcal/);
  });

  it('Abruf übernimmt Änderungen, Absagen und gelöschte Termine; Empfangsprotokoll', async () => {
    ics = cal([SERIES.replace('SUMMARY:Dienstabend', 'SUMMARY:Übungsabend'), CANCELLED]);
    const r = await admin.post(`/calendar/sources/${sourceId}/refresh`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ events: 2, added: 0, changed: 1, removed: 2 });
    const list = (await entries(admin, berlin(2026, 11, 1), berlin(2026, 12, 31), '&sources=ical')).map((e) => `${hm(e.start)} ${e.title}`);
    expect(list).toEqual(['2026-11-02 19:30 Übungsabend', '2026-11-16 19:30 Übungsabend', '2026-11-30 19:30 Übungsabend', '2026-12-07 19:30 Übungsabend']);
    const log = (await admin.get(`/calendar/sources/${sourceId}/log`)).json;
    expect(log[0]).toMatchObject({ ok: true, trigger: 'manual', events: 2, changed: 1, removed: 2 });
    expect(log.at(-1)).toMatchObject({ trigger: 'test', added: 3 });
    // Fehler landen im Protokoll, die Termine bleiben
    status = 500;
    expect((await admin.post(`/calendar/sources/${sourceId}/refresh`)).status).toBe(502);
    status = 200;
    expect((await admin.get(`/calendar/sources/${sourceId}/log`)).json[0]).toMatchObject({ ok: false, message: expect.stringMatching(/HTTP 500/) });
    expect((await admin.get('/calendar/sources')).json[0]).toMatchObject({ lastError: expect.stringMatching(/HTTP 500/), eventCount: 1 });
    // Worker: fällig erst nach dem Intervall
    hits = 0;
    await refreshDueCalendarSources();
    expect(hits).toBe(0);
    await pool.query(`UPDATE calendar_sources SET last_fetch_at = now() - interval '31 minutes'`);
    await refreshDueCalendarSources();
    expect(hits).toBe(1);
    // Deaktivieren: kein Abruf mehr; ohne Kategorie
    await admin.put(`/calendar/sources/${sourceId}`, { name: 'Wehr', categoryId: null, intervalMin: 30, active: false });
    await pool.query(`UPDATE calendar_sources SET last_fetch_at = now() - interval '2 hours'`);
    await refreshDueCalendarSources();
    expect(hits).toBe(1);
    expect((await entries(admin, berlin(2026, 11, 1), berlin(2026, 12, 31), '&sources=ical'))[0].category).toBeNull();
  });

  it('iCal-Abo: geheimer Link je Person, Kategorien wählbar, Beschreibung optional, erneuern und widerrufen', async () => {
    expect((await viewer.get('/calendar/feed')).json).toMatchObject({ active: false });
    const c = await viewer.post('/calendar/feed', {});
    expect(c.status).toBe(200);
    const feedUrl: string = c.json.url;
    expect(feedUrl).toMatch(/\/api\/v1\/public\/calendar\/bcal_[A-Za-z0-9_-]{40,}\.ics$/);
    const token = feedUrl.split('/').pop()!;
    expect(await one('SELECT 1 FROM calendar_feeds WHERE token_hash = $1', [token])).toBeNull();
    const pub = (t: string) => app.inject({ method: 'GET', url: `/api/v1/public/calendar/${t}` });
    let res = await pub(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    let parsed = parseIcal(res.body, TZ);
    const titles = parsed.events.map((e) => e.summary);
    expect(titles).toContain('Übungsabend');
    expect(titles).toContain('Jahreshauptversammlung');
    // keine Beiträge, keine Presse-Fristen, ohne Zustimmung keine Beschreibung und kein Ort
    expect(titles.some((t) => /Tag der offenen Tür|Frist/.test(t))).toBe(false);
    expect(res.body).not.toContain('DESCRIPTION');
    expect(res.body).not.toContain('LOCATION');
    expect(parsed.events.find((e) => e.summary === 'Weihnachtsmarkt')).toMatchObject({ allDay: true });
    // Kategorien wählen + Beschreibung
    const cats = (await admin.get('/calendar/categories')).json;
    const veranstaltung = cats.find((x: any) => x.name === 'Veranstaltung').id;
    const now = new Date();
    const c2 = toCivil(+now + 20 * 86_400_000, TZ);
    await admin.post('/calendar/events', { title: 'Tag der Feuerwehr', description: 'Mit Vorführung', location: 'Marktplatz', start: berlin(c2.y, c2.m, c2.d, 10), end: berlin(c2.y, c2.m, c2.d, 16), categoryId: veranstaltung });
    expect((await viewer.put('/calendar/feed', { categories: [veranstaltung], includeDescription: true })).status).toBe(200);
    res = await pub(token);
    parsed = parseIcal(res.body, TZ);
    expect(parsed.events.map((e) => e.summary)).toEqual(['Tag der Feuerwehr']);
    expect(parsed.events[0]).toMatchObject({ description: 'Mit Vorführung', location: 'Marktplatz', categories: ['Veranstaltung'] });
    // Erneuern: alter Link ungültig
    const renewed: string = (await viewer.post('/calendar/feed', {})).json.url;
    expect((await pub(token)).statusCode).toBe(404);
    const token2 = renewed.split('/').pop()!;
    expect((await pub(token2)).statusCode).toBe(200);
    expect((await viewer.get('/calendar/feed')).json).toMatchObject({ active: true, categories: [veranstaltung], includeDescription: true });
    // Konto deaktiviert → Link liefert nichts
    await pool.query(`UPDATE users SET status = 'disabled' WHERE email = 'lesen@example.org'`);
    expect((await pub(token2)).statusCode).toBe(404);
    await pool.query(`UPDATE users SET status = 'active' WHERE email = 'lesen@example.org'`);
    // Widerrufen
    expect((await viewer.del('/calendar/feed')).status).toBe(200);
    expect((await pub(token2)).statusCode).toBe(404);
    expect((await pub('bcal_unsinn')).statusCode).toBe(404);
    const actions = (await many<any>(`SELECT action FROM audit_events WHERE action LIKE 'calendar.feed%' ORDER BY id`)).map((a) => a.action);
    expect(actions).toEqual(['calendar.feed_created', 'calendar.feed_updated', 'calendar.feed_renewed', 'calendar.feed_revoked']);
  });

  it('NUL-Zeichen und ein einzelner fehlerhafter Termin blockieren die Quelle nicht (#237)', async () => {
    const ev = (uid: string, summary: string, start: string) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, 'DESCRIPTION:Text\u0000mit NUL', `DTSTART:${start}`, 'END:VEVENT'].join('\r\n');
    const refresh = () => admin.post(`/calendar/sources/${sourceId}/refresh`);
    const titles = async () => (await entries(admin, berlin(2026, 12, 1), berlin(2026, 12, 31), `&sources=ical:${sourceId}`)).map((e) => `${hm(e.start)} ${e.title}`);
    ics = cal([SERIES, ev('nul@wehr', 'Funk\u0000übung', '20261210T180000Z')]);
    const r = await refresh();
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([]);
    expect(await titles()).toEqual(['2026-12-07 19:30 Dienstabend', '2026-12-10 19:00 Funkübung']);
    expect((await one<any>(`SELECT description FROM calendar_events WHERE uid = 'nul@wehr'`))!.description).toBe('Textmit NUL');
    // Ein Termin lässt sich nicht speichern (hier über eine Prüfregel der Datenbank nachgestellt): die übrigen
    // werden trotzdem abgeglichen, der betroffene behält seinen bisherigen Stand, das Protokoll nennt ihn
    await pool.query(`ALTER TABLE calendar_events ADD CONSTRAINT test_kaputt CHECK (title NOT LIKE 'Kaputt%')`);
    try {
      ics = cal([SERIES.replace('SUMMARY:Dienstabend', 'SUMMARY:Übungsabend'), ev('nul@wehr', 'Kaputt geändert', '20261210T180000Z'), ev('neu@wehr', 'Kaputt neu', '20261211T180000Z'), ev('ok@wehr', 'Grillabend', '20261212T180000Z')]);
      const r2 = await refresh();
      expect(r2.status).toBe(200);
      expect(r2.json).toMatchObject({ added: 1, changed: 1, removed: 0 });
      expect(r2.json.warnings).toEqual(['„Kaputt geändert“ konnte nicht gespeichert werden und wurde übersprungen.', '„Kaputt neu“ konnte nicht gespeichert werden und wurde übersprungen.']);
      expect(await titles()).toEqual(['2026-12-07 19:30 Übungsabend', '2026-12-10 19:00 Funkübung', '2026-12-12 19:00 Grillabend']);
      const log = (await admin.get(`/calendar/sources/${sourceId}/log`)).json;
      expect(log[0]).toMatchObject({ ok: true, added: 1, changed: 1, warnings: r2.json.warnings });
      expect((await admin.get('/calendar/sources')).json[0].lastError).toBeNull();
    } finally {
      await pool.query('ALTER TABLE calendar_events DROP CONSTRAINT test_kaputt');
    }
  });

  it('doppelter geänderter Einzeltermin, sehr lange Serie und Serienende-Korrektur (#231)', async () => {
    const refresh = () => admin.post(`/calendar/sources/${sourceId}/refresh`);
    // derselbe geänderte Termin zweimal in der Datei (alte und neue SEQUENCE): die neuere gilt, kein Fehler
    const moved = (seq: number, title: string, start: string) => MOVED.replace('SUMMARY:Dienstabend (Atemschutz)', `SEQUENCE:${seq}\r\nSUMMARY:${title}`).replace('DTSTART;TZID=W. Europe Standard Time:20261117T190000', `DTSTART;TZID=W. Europe Standard Time:${start}`).replace('DTEND;TZID=W. Europe Standard Time:20261117T210000\r\n', '');
    const LONG = ['BEGIN:VEVENT', 'UID:lang@wehr', 'SUMMARY:Tagesdienst', 'DTSTART;TZID=Europe/Berlin:20260101T080000', 'DTEND;TZID=Europe/Berlin:20260101T090000', 'RRULE:FREQ=DAILY;COUNT=10000', 'END:VEVENT'].join('\r\n');
    ics = cal([SERIES, moved(1, 'Alt', '20261117T180000'), moved(2, 'Neu', '20261118T180000'), LONG]);
    const r = await refresh();
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([]);
    const nov = (await entries(admin, berlin(2026, 11, 10), berlin(2026, 11, 25), `&sources=ical:${sourceId}`)).filter((e) => e.title !== 'Tagesdienst').map((e) => `${hm(e.start)} ${e.title}`);
    expect(nov).toEqual(['2026-11-18 18:00 Neu', '2026-11-23 19:30 Dienstabend']);
    expect((await many(`SELECT 1 FROM calendar_events WHERE uid = 'dienst@wehr' AND recurrence_id IS NOT NULL`)).length).toBe(1);
    // 10 000 Termine: das Serienende stimmt, auch die letzten erscheinen
    const long = await one<any>(`SELECT id, until_at FROM calendar_events WHERE uid = 'lang@wehr'`);
    expect(long.until_at.toISOString()).toBe(berlin(2053, 5, 18, 9));
    expect((await entries(admin, berlin(2053, 5, 17), berlin(2053, 6, 1), `&sources=ical:${sourceId}`)).map((e) => hm(e.start))).toEqual(['2053-05-17 08:00', '2053-05-18 08:00']);
    // ein früher falsch gespeichertes Serienende korrigiert der nächste Abruf
    await pool.query(`UPDATE calendar_events SET until_at = $2 WHERE id = $1`, [long.id, berlin(2039, 9, 13, 9)]);
    expect((await refresh()).json).toMatchObject({ changed: 1, added: 0, removed: 0 });
    expect((await one<any>(`SELECT until_at FROM calendar_events WHERE id = $1`, [long.id])).until_at.toISOString()).toBe(berlin(2053, 5, 18, 9));
    // Migration 185: Serien, deren Ende gekappt sein kann (≥ 4 999 Tage), gelten als unbegrenzt; kürzere bleiben
    await pool.query(`UPDATE calendar_events SET until_at = $2 WHERE id = $1`, [long.id, berlin(2039, 9, 13, 9)]);
    const migration = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations/185_calendar_until_recheck.sql'), 'utf8');
    await pool.query(migration);
    expect((await one<any>(`SELECT until_at FROM calendar_events WHERE id = $1`, [long.id])).until_at).toBeNull();
    expect((await one<any>(`SELECT until_at FROM calendar_events WHERE uid = 'dienst@wehr' AND recurrence_id IS NULL`)).until_at).not.toBeNull();
    expect((await entries(admin, berlin(2053, 5, 17), berlin(2053, 6, 1), `&sources=ical:${sourceId}`))).toHaveLength(2);
  });

  it('Quelle löschen entfernt Termine und die verschlüsselte Adresse', async () => {
    expect((await admin.del(`/calendar/sources/${sourceId}`)).status).toBe(200);
    expect(await one(`SELECT 1 FROM calendar_events WHERE source = 'ical'`)).toBeNull();
    expect(await one(`SELECT 1 FROM secrets WHERE owner_type = 'calendar_source'`)).toBeNull();
  });
});

describe('Workflows: Eingang „Kalendereintrag“ (#203)', () => {
  const node = (id: string, type: string, data: any, y = 0) => ({ id, type, position: { x: 0, y }, data });
  const edge = (id: string, source: string, target: string) => ({ id, source, target, sourceHandle: 'out' });
  let uebung: string;
  let notifyId: string;
  const runs = async (automationId: string) => many<any>(`SELECT payload, event_key, trigger FROM automation_runs WHERE automation_id = $1 AND mode = 'live' ORDER BY created_at`, [automationId]);

  async function workflow(name: string, config: any) {
    const inp = await admin.post('/automation-inputs', { name, kind: 'calendar', config });
    expect(inp.status, JSON.stringify(inp.json)).toBe(200);
    const a = (await admin.post('/automations', { name })).json.id;
    const cur = await admin.get(`/automations/${a}`);
    const g = { nodes: [node('in', 'input', { inputId: inp.json.id }), node('n', 'output', { outputId: notifyId }, 100)], edges: [edge('e1', 'in', 'n')] };
    expect((await admin.put(`/automations/${a}`, { name, description: '', graph: g, baseHash: cur.json.draft_hash })).status).toBe(200);
    // Testlauf mit Beispieltermin
    const t = await admin.post(`/automations/${a}/test`, {});
    expect(t.json.status, JSON.stringify(t.json.steps)).toBe('succeeded');
    expect((await one<any>(`SELECT payload FROM automation_runs WHERE automation_id = $1 AND mode = 'test'`, [a]))!.payload).toMatchObject({ titel: 'Übungsdienst Atemschutz', kategorie: 'Übung', zeitpunkt: 'beginn' });
    expect((await admin.post(`/automations/${a}/activate`)).status).toBe(200);
    return a as string;
  }
  // Zeitpunkte in Ortszeit, sicher nach der Aktivierung (übermorgen und später)
  const day = (plus: number) => toCivil(Date.now() + plus * 86_400_000, TZ);
  const at = (plus: number, h: number, mi = 0) => {
    const c = day(plus);
    return berlin(c.y, c.m, c.d, h, mi);
  };

  beforeAll(async () => {
    await setSettings({ 'automations.enabled': true } as any);
    uebung = (await admin.get('/calendar/categories')).json.find((c: any) => c.name === 'Übung').id;
    const n = await admin.post('/automation-outputs', { name: 'Hinweis an Admin', kind: 'notify', config: { roles: ['platform_admin'], title: '{{zeitpunkt}}: {{titel}}', body: '{{beginn}} – {{ort}}' } });
    expect(n.status, JSON.stringify(n.json)).toBe(200);
    notifyId = n.json.id;
  });

  it('Eingang prüft Einstellungen und Filter-Verweise; Katalog liefert Felder und Vorlage', async () => {
    expect((await admin.post('/automation-inputs', { name: 'Zu früh', kind: 'calendar', config: { timing: 'before', beforeValue: 31, beforeUnit: 'days' } })).status).toBe(400);
    expect((await admin.post('/automation-inputs', { name: 'Unbekannt', kind: 'calendar', config: { categoryIds: ['00000000-0000-4000-8000-000000000000'] } })).status).toBe(400);
    const cat = (await admin.get('/automations/catalog')).json;
    const k = cat.inputKinds.find((x: any) => x.kind === 'calendar');
    expect(k.fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['titel', 'beginn', 'ende', 'ort', 'kategorie', 'schlagwoerter', 'quelle', 'zeitpunkt', 'gueltig_bis']));
    expect(cat.calendarCategories.map((c: any) => c.name)).toContain('Übung');
    expect(cat.templates.find((t: any) => t.id === 'calendar-exercise-banner')).toMatchObject({ input: { kinds: ['calendar'] } });
  });

  it('zu Beginn: nur passende Termine, jeder Zeitpunkt genau einmal, Zeitzone korrekt', async () => {
    const a = await workflow('Übung beginnt', { timing: 'start', categoryIds: [uebung], sources: ['own'] });
    const ev = await admin.post('/calendar/events', { title: 'Übung Brandhaus', location: 'Übungsgelände', start: at(2, 10), end: at(2, 12), categoryId: uebung, tags: ['Atemschutz'] });
    await admin.post('/calendar/events', { title: 'Besprechung', start: at(2, 10), end: at(2, 11) });
    const t = Date.parse(at(2, 10));
    expect(await calendarTriggerTick(t - 60_000)).toBe(0);
    expect(await calendarTriggerTick(t + 5_000)).toBe(1);
    // nochmal (z. B. nach Neustart) und später im Nachholfenster: kein zweiter Lauf
    expect(await calendarTriggerTick(t + 35_000)).toBe(0);
    expect(await calendarTriggerTick(t + 9 * 60_000)).toBe(0);
    const r = await runs(a);
    expect(r).toHaveLength(1);
    expect(r[0].payload).toMatchObject({ titel: 'Übung Brandhaus', ort: 'Übungsgelände', kategorie: 'Übung', schlagwoerter: 'Atemschutz', quelle: 'Eigene Termine', zeitpunkt: 'beginn', ganztaegig: 'nein', beginn: at(2, 10), ende: at(2, 12), gueltig_bis: at(2, 12) });
    // Ortszeit 10:00 → UTC je nach Sommer-/Winterzeit
    const off = (Date.parse(at(2, 10)) - Date.UTC(day(2).y, day(2).m - 1, day(2).d, 10)) / -3_600_000;
    expect([1, 2]).toContain(off);
    // Verschieben nach dem Auslösen: neuer Zeitpunkt löst einmal aus
    await admin.put(`/calendar/events/${ev.json.id}`, { title: 'Übung Brandhaus', start: at(2, 14), end: at(2, 16), categoryId: uebung });
    expect(await calendarTriggerTick(Date.parse(at(2, 14)) + 1_000)).toBe(1);
    expect(await calendarTriggerTick(Date.parse(at(2, 14)) + 31_000)).toBe(0);
    expect(await runs(a)).toHaveLength(2);
    // Verpasst (länger als 10 Minuten): nicht nachgeholt
    await admin.post('/calendar/events', { title: 'Nachtübung', start: at(3, 22), end: at(3, 23), categoryId: uebung });
    expect(await calendarTriggerTick(Date.parse(at(3, 22)) + 11 * 60_000)).toBe(0);
    await admin.post(`/automations/${a}/disable`).catch(() => {});
    await pool.query(`UPDATE automations SET status = 'disabled' WHERE id = $1`, [a]);
  });

  it('Serie: jeder Termin löst einmal aus, ausgelassene nicht, verschobene zum neuen Zeitpunkt', async () => {
    const a = await workflow('Dienstabend', { timing: 'start', tags: ['dienst'] });
    const s = await admin.post('/calendar/events', { title: 'Dienstabend', start: at(4, 19), end: at(4, 21), tags: ['Dienst'], recurrence: { freq: 'daily', ends: 'count', count: 3 } });
    // zweiten Termin verschieben, dritten auslassen
    await admin.put(`/calendar/events/${s.json.id}`, { scope: 'instance', instance: at(5, 19), title: 'Dienstabend (später)', start: at(5, 20), end: at(5, 22), tags: ['Dienst'] });
    await admin.del(`/calendar/events/${s.json.id}?scope=instance&instance=${encodeURIComponent(at(6, 19))}`);
    for (const t of [at(4, 19), at(5, 19), at(5, 20), at(6, 19)]) {
      await calendarTriggerTick(Date.parse(t) + 2_000);
      await calendarTriggerTick(Date.parse(t) + 40_000);
    }
    const r = await runs(a);
    expect(r.map((x) => `${x.payload.titel} ${hm(x.payload.beginn)}`)).toEqual([`Dienstabend ${hm(at(4, 19))}`, `Dienstabend (später) ${hm(at(5, 20))}`]);
    await pool.query(`UPDATE automations SET status = 'disabled' WHERE id = $1`, [a]);
  });

  it('vorher (X Stunden) und zum Ende; Text-Filter', async () => {
    const before = await workflow('2 Stunden vorher', { timing: 'before', beforeValue: 2, beforeUnit: 'hours', textContains: 'tag der offenen' });
    const end = await workflow('Zum Ende', { timing: 'end', textContains: 'tag der offenen' });
    await admin.post('/calendar/events', { title: 'Tag der offenen Tür', start: at(7, 11), end: at(7, 17) });
    await admin.post('/calendar/events', { title: 'Anderer Termin', start: at(7, 11), end: at(7, 17) });
    expect(await calendarTriggerTick(Date.parse(at(7, 9)) + 1_000)).toBe(1);
    expect(await calendarTriggerTick(Date.parse(at(7, 11)) + 1_000)).toBe(0);
    expect(await calendarTriggerTick(Date.parse(at(7, 17)) + 1_000)).toBe(1);
    expect((await runs(before))[0].payload).toMatchObject({ zeitpunkt: 'vorher', titel: 'Tag der offenen Tür' });
    expect((await runs(end))[0].payload).toMatchObject({ zeitpunkt: 'ende' });
    expect(await runs(end)).toHaveLength(1);
    // Zeitpunkte vor der Aktivierung lösen nie aus
    expect(await calendarTriggerTick(Date.now() - 60 * 60_000)).toBe(0);
  });

  it('Workflows abgeschaltet: nichts startet', async () => {
    await admin.post('/calendar/events', { title: 'Tag der offenen Tür 2', start: at(8, 11), end: at(8, 17) });
    await setSettings({ 'automations.enabled': false } as any);
    expect(await calendarTriggerTick(Date.parse(at(8, 9)) + 1_000)).toBe(0);
    await setSettings({ 'automations.enabled': true } as any);
  });
});
