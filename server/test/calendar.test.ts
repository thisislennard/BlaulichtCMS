import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { invalidateRoles } from '../src/auth/roles.js';
import { fromCivil, localDate, toCivil } from '../src/calendar/recurrence.js';

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
