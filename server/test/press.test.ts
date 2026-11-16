import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { invalidateRoles } from '../src/auth/roles.js';
import { checkPressDeadlines, openPressDeadlines } from '../src/press/deadlines.js';
import { runRetention } from '../src/lib/retention.js';

/**
 * Presseanfragen (#204–#207) gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL). Die Datenbank wird zu Beginn
 * geleert (die Testdateien laufen nacheinander).
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
let ipCounter = 10;

export class Client {
  cookie = '';
  ip = `10.79.0.${ipCounter++}`;
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as any,
      remoteAddress: this.ip,
      url: `/api/v1${url}`,
      payload: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
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
    return { status: res.statusCode, json, headers: res.headers, body: res.body, raw: res.rawPayload };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
  del = (u: string, b: unknown = {}) => this.raw('DELETE', u, b);
  reauth = async () => expect((await this.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
}

let admin: Client;
let editor: Client;
let reader: Client;
let editorId: string;
let passwordHash: string;

async function login(email: string, name: string, roles: string[]): Promise<{ client: Client; id: string }> {
  const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ($1,$2,$3,$4) RETURNING id`, [email, name, passwordHash, roles]);
  const client = new Client(app);
  expect((await client.post('/auth/login', { email, password: PASSWORD })).json.next).toBe('done');
  return { client, id: u!.id };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateRoles();
  await migrate(() => {});
  app = await buildApp();
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
  admin = (await login('admin@example.org', 'Alex Admin', ['platform_admin'])).client;
  const e = await login('redaktion@example.org', 'Rita Redaktion', ['editor']);
  editor = e.client;
  editorId = e.id;
  reader = (await login('leser@example.org', 'Lea Leser', ['viewer'])).client;
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

export { admin, editor };

describe('Presseanfragen: Grundmodul (#204)', () => {
  let id: string;

  it('Rechte: Lesezugriff sieht keine Presseanfragen, Redaktion darf erfassen', async () => {
    expect((await reader.get('/press/requests')).status).toBe(403);
    expect((await reader.post('/press/requests', { topic: 'Test' })).status).toBe(403);
    const me = (await editor.get('/auth/me')).json;
    expect(me.permissions).toEqual(expect.arrayContaining(['press.view', 'press.manage', 'press.reply', 'press.snippets', 'press.contacts']));
    expect(me.permissions).not.toContain('press.approve');
    expect(me.permissions).not.toContain('press.mailbox');
  });

  it('von Hand erfassen: Vorgangsnummer, Verlauf, Audit, Benachrichtigung ohne Kontaktdaten', async () => {
    expect((await editor.post('/press/requests', { topic: 'x' })).status).toBe(400);
    expect((await editor.post('/press/requests', { topic: 'Brand Lagerhalle', contactEmail: 'kein-mail' })).status).toBe(400);
    const due = new Date(Date.now() + 60 * 60_000).toISOString();
    const r = await editor.post('/press/requests', {
      topic: 'Brand Lagerhalle',
      body: 'Wie viele Kräfte waren im Einsatz?',
      outlet: 'Musterstädter Zeitung',
      contactName: 'Paula Presse',
      contactEmail: 'paula@zeitung.example',
      contactPhone: '+49 123 456',
      channel: 'phone',
      assigneeId: editorId,
      dueAt: due,
    });
    expect(r.status).toBe(200);
    expect(r.json.case_no).toMatch(/^P-\d{4}-0001$/);
    id = r.json.id;
    const d = (await editor.get(`/press/requests/${id}`)).json;
    expect(d.request).toMatchObject({ status: 'new', contact_email: 'paula@zeitung.example', assignee_name: 'Rita Redaktion', overdue: false });
    expect(d.events.map((e: any) => e.kind)).toEqual(['created']);
    const a = await one<any>(`SELECT * FROM audit_events WHERE action = 'press.request_created'`);
    expect(a.object_label).toBe(r.json.case_no);
    expect(JSON.stringify(a.details)).not.toContain('paula');
    const n = await many<any>(`SELECT title, body, permission, category FROM notifications WHERE link = $1`, [`/presse/${id}`]);
    expect(n.some((x) => x.permission === 'press.manage' && x.category === 'press')).toBe(true);
    expect(JSON.stringify(n)).not.toContain('paula');
  });

  it('Status, Zuständigkeit, Frist und Verknüpfungen ändern – mit Verlauf', async () => {
    expect((await editor.patch(`/press/requests/${id}`, { assigneeId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await editor.patch(`/press/requests/${id}`, { status: 'in_progress' })).json.changed).toBe(true);
    expect((await editor.patch(`/press/requests/${id}`, { status: 'in_progress' })).json.changed).toBe(false);
    const post = await one<any>(`INSERT INTO posts (kind, title) VALUES ('news', 'Brand in der Lagerhalle') RETURNING id`);
    const ev = await one<any>(`INSERT INTO fe2_events (event_key, keyword, title) VALUES ('e1', 'B3', 'Brand Lagerhalle') RETURNING id`);
    expect((await editor.patch(`/press/requests/${id}`, { postId: post.id, fe2EventId: ev.id, contactPhone: '+49 999' })).status).toBe(200);
    expect((await editor.post(`/press/requests/${id}/notes`, { text: 'Rückruf zugesagt' })).status).toBe(200);
    const d = (await editor.get(`/press/requests/${id}`)).json;
    expect(d.request).toMatchObject({ status: 'in_progress', post_title: 'Brand in der Lagerhalle', fe2_title: 'Brand Lagerhalle', contact_phone: '+49 999' });
    const texts = d.events.map((e: any) => e.text);
    expect(texts).toEqual(expect.arrayContaining(['Status: neu → in Bearbeitung', 'Mit Beitrag verknüpft', 'Mit Einsatz verknüpft', 'Telefon geändert', 'Rückruf zugesagt']));
    // Kontaktdaten stehen nicht im Verlauf
    expect(JSON.stringify(d.events)).not.toContain('+49 999');
  });

  it('Übersicht mit Filtern: offen, meine, überfällig, Suche', async () => {
    await editor.post('/press/requests', { topic: 'Übung am Samstag', outlet: 'Radio Muster', dueAt: new Date(Date.now() - 60_000).toISOString() });
    const open = (await editor.get('/press/requests?filter=open')).json;
    expect(open.requests).toHaveLength(2);
    expect(open.counts).toMatchObject({ open: 2, overdue: 1, mine: 1 });
    expect((await editor.get('/press/requests?filter=overdue')).json.requests.map((r: any) => r.topic)).toEqual(['Übung am Samstag']);
    expect((await editor.get('/press/requests?filter=mine')).json.requests.map((r: any) => r.topic)).toEqual(['Brand Lagerhalle']);
    expect((await editor.get('/press/requests?filter=all&q=radio')).json.requests).toHaveLength(1);
    expect((await admin.get('/press/requests?filter=mine')).json.requests).toHaveLength(0);
    const dash = (await editor.get('/dashboard')).json;
    expect(dash.press.counts).toMatchObject({ open: 2, overdue: 1, mine: 1 });
    expect(JSON.stringify(dash.press)).not.toContain('paula');
  });

  it('Fristen: Abfrage für den Kalender, Erinnerung und Überschreitung je einmal', async () => {
    const all = await openPressDeadlines();
    expect(all.map((d) => d.topic)).toEqual(['Übung am Samstag', 'Brand Lagerhalle']);
    expect(all[0]).toMatchObject({ overdue: true, link: expect.stringMatching(/^\/presse\//) });
    expect(Object.keys(all[0])).not.toContain('contact_email');
    expect(await openPressDeadlines({ from: new Date() })).toHaveLength(1);
    expect(await openPressDeadlines({ assigneeId: editorId })).toHaveLength(1);
    expect(await checkPressDeadlines()).toEqual({ reminded: 1, overdue: 1 });
    expect(await checkPressDeadlines()).toEqual({ reminded: 0, overdue: 0 });
    const n = await one<any>(`SELECT user_id, category, kind FROM notifications WHERE title LIKE '%Frist %' AND title NOT LIKE '%überschritten%'`);
    expect(n).toMatchObject({ user_id: editorId, category: 'press', kind: 'warning' });
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE '%Frist überschritten' AND permission = 'press.manage'`)).not.toBeNull();
    // Frist ändern setzt die Erinnerung zurück
    await editor.patch(`/press/requests/${id}`, { dueAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    expect((await checkPressDeadlines()).reminded).toBe(1);
  });

  it('erledigt: zählt nicht mehr als offen; Löschfrist (Standard 12 Monate) löscht samt Verlauf', async () => {
    await editor.patch(`/press/requests/${id}`, { status: 'done' });
    let r = await one<any>(`SELECT done_at, answered_at FROM press_requests WHERE id = $1`, [id]);
    expect(r.done_at).not.toBeNull();
    expect(await openPressDeadlines({ assigneeId: editorId })).toHaveLength(0);
    // wieder geöffnet: Erledigt-Zeitpunkt fällt weg
    await editor.patch(`/press/requests/${id}`, { status: 'in_progress' });
    expect((await one<any>(`SELECT done_at FROM press_requests WHERE id = $1`, [id]))!.done_at).toBeNull();
    await editor.patch(`/press/requests/${id}`, { status: 'done' });
    const dry = await runRetention({ dryRun: true });
    expect(dry.categories.find((c) => c.key === 'press_requests')).toMatchObject({ count: 0, days: 360 });
    await pool.query(`UPDATE press_requests SET done_at = now() - interval '13 months' WHERE id = $1`, [id]);
    expect((await runRetention({ dryRun: true })).categories.find((c) => c.key === 'press_requests')!.count).toBe(1);
    await runRetention({ dryRun: false });
    expect(await one(`SELECT 1 FROM press_requests WHERE id = $1`, [id])).toBeNull();
    expect(await one(`SELECT 1 FROM press_request_events WHERE request_id = $1`, [id])).toBeNull();
  });

  it('Datenschutzanfrage findet und löscht Presseanfragen', async () => {
    const r = await editor.post('/press/requests', { topic: 'Nachfrage', contactName: 'Max Mustermann', contactEmail: 'max@example.net' });
    const hits = (await admin.get('/privacy/search?q=max@example.net')).json.hits;
    const hit = hits.find((h: any) => h.kind === 'press_request');
    expect(hit).toMatchObject({ id: r.json.id, actions: ['delete'] });
    expect((await admin.post('/privacy/action', { kind: 'press_request', id: r.json.id, action: 'delete' })).status).toBe(200);
    expect(await one(`SELECT 1 FROM press_requests WHERE id = $1`, [r.json.id])).toBeNull();
  });

  it('Löschen von Hand mit Audit', async () => {
    const r = await editor.post('/press/requests', { topic: 'Wird gelöscht' });
    expect((await reader.del(`/press/requests/${r.json.id}`)).status).toBe(403);
    expect((await editor.del(`/press/requests/${r.json.id}`)).status).toBe(200);
    expect((await editor.get(`/press/requests/${r.json.id}`)).status).toBe(404);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'press.request_deleted'`)).not.toBeNull();
  });

  it('Workflow-Eingang „Neue Presseanfrage“ startet einen Lauf nur mit Feldern ohne Kontaktdaten', async () => {
    const input = await admin.post('/automation-inputs', { name: 'Presse', kind: 'press', config: { channels: ['phone'] } });
    expect(input.status).toBe(200);
    const output = await admin.post('/automation-outputs', { name: 'Info', kind: 'notify', config: { roles: ['platform_admin'], title: 'Presse: {{thema}}' } });
    expect(output.status).toBe(200);
    const graph = {
      nodes: [
        { id: 'n1', type: 'input', position: { x: 0, y: 0 }, data: { inputId: input.json.id } },
        { id: 'n2', type: 'output', position: { x: 200, y: 0 }, data: { outputId: output.json.id } },
      ],
      edges: [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2' }],
    };
    const a = await admin.post('/automations', { name: 'Presseanfrage melden' });
    expect(a.status).toBe(200);
    const cur = await admin.get(`/automations/${a.json.id}`);
    expect((await admin.put(`/automations/${a.json.id}`, { name: 'Presseanfrage melden', graph, baseHash: cur.json.draft_hash })).status).toBe(200);
    const t = await admin.post(`/automations/${a.json.id}/test`, {});
    expect(t.json.status, JSON.stringify(t.json)).toBe('succeeded');
    const act = await admin.post(`/automations/${a.json.id}/activate`, {});
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    await editor.post('/press/requests', { topic: 'Per Mail erfasst', channel: 'mail', contactEmail: 'a@b.example' });
    await editor.post('/press/requests', { topic: 'Per Telefon', channel: 'phone', contactEmail: 'geheim@b.example', contactName: 'Geheim' });
    const runs = await many<any>(`SELECT payload FROM automation_runs WHERE automation_id = $1 AND mode = 'live'`, [a.json.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0].payload).toMatchObject({ thema: 'Per Telefon', eingangsweg: 'Telefon', nummer: expect.stringMatching(/^P-/) });
    expect(JSON.stringify(runs[0].payload)).not.toMatch(/geheim/i);
  });
});
