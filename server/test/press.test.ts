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
import { storeSecret } from '../src/lib/secrets.js';
import { resetM365TokenCache } from '../src/lib/mail.js';
import { MAX_ATTEMPTS, mailboxState, pollPressMailbox } from '../src/press/mailbox.js';
import { fakeGraph, fakeImap, fakeSmtp } from './press-fakes.js';
import { deliverPressReply } from '../src/routes/press-replies.js';
import { deliverRelease } from '../src/press/releases.js';

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

  it('Löschfrist auch ohne „erledigt“: neu/beantwortet nach der letzten Aktivität, 30 Tage vorher angekündigt (#243)', async () => {
    const mk = async (topic: string) => (await editor.post('/press/requests', { topic, contactName: 'Erika Beispiel', contactEmail: 'erika@zeitung.example' })).json.id as string;
    const answered = await mk('Beantwortet, nie erledigt');
    const withMail = await mk('Alt, aber neue Mail');
    const touched = await mk('Wird nach der Ankündigung bearbeitet');
    await editor.patch(`/press/requests/${answered}`, { status: 'answered' });
    const age = async (id: string) => {
      await pool.query(`UPDATE press_requests SET created_at = now() - interval '13 months', updated_at = now() - interval '13 months', answered_at = CASE WHEN answered_at IS NULL THEN NULL ELSE now() - interval '13 months' END WHERE id = $1`, [id]);
      await pool.query(`UPDATE press_request_events SET at = now() - interval '13 months' WHERE request_id = $1`, [id]);
    };
    for (const id of [answered, withMail, touched]) await age(id);
    await pool.query(`INSERT INTO press_messages (request_id, direction, status, subject) VALUES ($1, 'in', 'received', 'Neue Mail')`, [withMail]);
    const cat = async () => (await runRetention({ dryRun: true })).categories.find((c) => c.key === 'press_requests_open')!;
    expect(await cat()).toMatchObject({ count: 0, days: 360, note: expect.stringContaining('2 beim nächsten Lauf anzukündigen') });
    // erster Lauf: nur ankündigen, nichts löschen
    await runRetention({ dryRun: false });
    expect((await many(`SELECT 1 FROM press_requests WHERE id = ANY($1::uuid[])`, [[answered, withMail, touched]])).length).toBe(3);
    const notes = await many<any>(`SELECT title, body, permission, link FROM notifications WHERE title LIKE '%in 30 Tagen gelöscht'`);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ permission: 'press.manage', link: '/presse?filter=expiring', title: '2 Presseanfragen werden in 30 Tagen gelöscht' });
    expect(notes[0].body).not.toMatch(/Erika|erika@/);
    expect((await editor.get(`/press/requests/${answered}`)).json.deletion).toEqual({ at: expect.any(String) });
    expect((await editor.get(`/press/requests/${withMail}`)).json.deletion).toBeNull();
    const list = (await editor.get('/press/requests?filter=expiring')).json;
    expect(list.requests.map((r: any) => r.id).sort()).toEqual([answered, touched].sort());
    expect(list.counts.expiring).toBe(2);
    // zweiter Lauf: keine zweite Ankündigung; eine Notiz setzt die Frist zurück
    await runRetention({ dryRun: false });
    expect((await many(`SELECT 1 FROM notifications WHERE title LIKE '%in 30 Tagen gelöscht'`)).length).toBe(1);
    expect((await editor.post(`/press/requests/${touched}/notes`, { text: 'Bleibt – Nachfrage erwartet' })).status).toBe(200);
    expect((await editor.get(`/press/requests/${touched}`)).json.deletion).toBeNull();
    // 30 Tage nach der Ankündigung (Frist abgelaufen): gelöscht – die übrigen bleiben
    await pool.query(`UPDATE press_requests SET retention_notified_at = now() - interval '31 days' WHERE id = ANY($1::uuid[])`, [[answered, touched]]);
    expect((await cat()).count).toBe(1);
    await runRetention({ dryRun: false });
    expect(await one(`SELECT 1 FROM press_requests WHERE id = $1`, [answered])).toBeNull();
    expect(await one(`SELECT 1 FROM press_request_events WHERE request_id = $1`, [answered])).toBeNull();
    expect(await one(`SELECT 1 FROM press_requests WHERE id = $1`, [withMail])).not.toBeNull();
    expect(await one(`SELECT 1 FROM press_requests WHERE id = $1`, [touched])).not.toBeNull();
    // 0 = nie
    await setSettings({ 'privacy.press_open_months': 0 } as any);
    expect(await cat()).toMatchObject({ days: 0, count: 0 });
    await setSettings({ 'privacy.press_open_months': 12 } as any);
    await pool.query(`DELETE FROM press_requests WHERE id = ANY($1::uuid[])`, [[withMail, touched]]);
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

const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const exeBytes = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]), Buffer.alloc(200, 0x78)]);
const mailNew = (id: string) => `From: =?UTF-8?Q?Paula_M=C3=BCller?= <paula@zeitung.example>
To: presse@feuerwehr.example
Subject: =?UTF-8?Q?Gro=C3=9Fbrand_in_der_Halle?=
Message-ID: <${id}>
Date: ${new Date().toUTCString()}
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Wie viele Kräfte waren im Einsatz?
--b1
Content-Type: text/html; charset=utf-8

<p>Wie viele Kräfte?</p><img src="https://tracker.example/p.gif"><script>alert(1)</script>
--b1
Content-Type: application/pdf
Content-Disposition: attachment; filename="Fragen.pdf"
Content-Transfer-Encoding: base64

${pdfBytes.toString('base64')}
--b1
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="tool.exe"
Content-Transfer-Encoding: base64

${exeBytes.toString('base64')}
--b1--
`;
const simpleMail = (id: string, headers: string, subject = 'Frage', from = 'redaktion@radio.example') => `From: ${from}
To: presse@feuerwehr.example
Subject: ${subject}
Message-ID: <${id}>
${headers}
Content-Type: text/plain; charset=utf-8

Text`;

describe('Presse-Postfach (#205)', () => {
  let imap: Awaited<ReturnType<typeof fakeImap>>;
  const cfg = () => ({ mode: 'imap', host: '127.0.0.1', port: imap.port, security: 'tls', user: 'presse', folder: 'INBOX', intervalMinutes: 5, maxAttachmentMb: 1 });

  beforeAll(async () => {
    process.env.BLAULICHTCMS_IMAP_TEST_PLAIN = '1';
    imap = await fakeImap({ user: 'presse', password: 'Geheim-123' });
  });
  afterAll(async () => {
    await imap?.close();
  });

  it('Rechte: nur „Presse-Postfach einrichten“', async () => {
    expect((await editor.get('/press/mailbox')).status).toBe(403);
    expect((await editor.post('/press/mailbox/test', cfg())).status).toBe(403);
    expect((await admin.get('/press/mailbox')).json.config).toMatchObject({ enabled: false, passwordSet: false });
  });

  it('Verbindungstest vor Aktivierung; Passwort verschlüsselt, nie in der Antwort', async () => {
    expect((await admin.post('/press/mailbox/test', { ...cfg(), password: 'falsch' })).json).toMatchObject({ ok: false, error: expect.stringContaining('Anmeldung abgelehnt') });
    expect((await admin.post('/press/mailbox/test', { ...cfg(), security: 'none' })).status).toBe(400);
    await admin.reauth();
    // Einschalten ohne erfolgreichen Test: abgelehnt
    expect((await admin.put('/press/mailbox', { ...cfg(), password: 'Geheim-123', enabled: true })).json.error).toBe('not_verified');
    const t = await admin.post('/press/mailbox/test', { ...cfg(), password: 'Geheim-123' });
    expect(t.json).toMatchObject({ ok: true, info: expect.stringContaining('0 Nachrichten') });
    const saved = await admin.put('/press/mailbox', { ...cfg(), password: 'Geheim-123', enabled: true });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain('Geheim-123');
    expect(JSON.stringify((await admin.get('/press/mailbox')).json)).not.toContain('Geheim-123');
    expect(JSON.stringify((await admin.get('/settings')).json)).not.toContain('press.mailbox');
    const row = await one<any>(`SELECT value FROM settings WHERE key = 'press.mailbox'`);
    expect(JSON.stringify(row.value)).not.toContain('Geheim-123');
    // anderes Passwort ⇒ Test gilt nicht mehr
    expect((await admin.put('/press/mailbox', { ...cfg(), password: 'Anders-456', enabled: true })).json.error).toBe('not_verified');
  });

  it('Abruf: neue Anfrage mit Anhang, Spam und automatische Antworten ignoriert, rein lesend', async () => {
    imap.add(mailNew('m1@zeitung.example'));
    imap.add(simpleMail('auto1@x', 'Auto-Submitted: auto-replied', 'Automatische Antwort: Frage'));
    imap.add(simpleMail('spam1@x', 'X-Spam-Flag: YES', 'Gewinn!'));
    imap.add(mailNew('alt@zeitung.example'), new Date(Date.now() - 3 * 86400_000)); // älter als 24 Std.: beim ersten Abruf nicht
    const r = await admin.post('/press/mailbox/poll');
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ ran: true, imported: 1 });
    expect(imap.commands.some((c) => /STORE|COPY|MOVE|EXPUNGE|SELECT|DELETE/i.test(c))).toBe(false);
    expect(imap.commands.some((c) => /^EXAMINE/.test(c))).toBe(true);
    const req = await one<any>(`SELECT * FROM press_requests WHERE channel = 'mailbox'`);
    expect(req).toMatchObject({ topic: 'Großbrand in der Halle', contact_name: 'Paula Müller', contact_email: 'paula@zeitung.example', status: 'new' });
    expect(req.body).toContain('Kräfte');
    const d = (await editor.get(`/press/requests/${req.id}`)).json;
    expect(d.messages).toHaveLength(1);
    const msg = d.messages[0];
    expect(msg).toMatchObject({ direction: 'in', from_address: 'paula@zeitung.example', blocked_images: 1 });
    expect(msg.html_body).not.toMatch(/script|tracker/);
    expect(msg.attachments).toEqual([expect.objectContaining({ filename: 'Fragen.pdf', content_type: 'application/pdf', size: pdfBytes.length })]);
    expect(msg.skipped_attachments).toEqual([{ filename: 'tool.exe', reason: expect.stringContaining('exe') }]);
    const dl = await editor.raw('GET', `/press/attachments/${msg.attachments[0].id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.raw, pdfBytes)).toBe(0);
    expect((await reader.raw('GET', `/press/attachments/${msg.attachments[0].id}`)).status).toBe(403);
    const logs = (await admin.get('/press/mailbox/log')).json.map((l: any) => l.outcome).sort();
    expect(logs).toEqual(['auto', 'created', 'spam']);
  });

  it('Antwort im selben Verlauf wird zugeordnet, Dubletten ignoriert, Status zurück auf „in Bearbeitung“', async () => {
    const req = await one<any>(`SELECT id, case_no FROM press_requests WHERE channel = 'mailbox'`);
    await editor.patch(`/press/requests/${req.id}`, { status: 'answered' });
    imap.add(simpleMail('reply1@zeitung.example', 'In-Reply-To: <m1@zeitung.example>\nReferences: <m1@zeitung.example>', 'Re: Großbrand', 'paula@zeitung.example'));
    imap.add(mailNew('m1@zeitung.example')); // gleiche Message-ID nochmal
    imap.add(simpleMail('case1@x', '', `Nachfrage [${req.case_no}]`, 'kollege@zeitung.example'));
    imap.add(simpleMail('nl@x', 'List-Unsubscribe: <https://x>', 'Newsletter'));
    expect((await pollPressMailbox({ force: true })).imported).toBe(2);
    expect((await many<any>(`SELECT id FROM press_messages WHERE request_id = $1`, [req.id])).length).toBe(3);
    expect((await one<any>(`SELECT status FROM press_requests WHERE id = $1`, [req.id]))!.status).toBe('in_progress');
    expect((await one<any>(`SELECT count(*)::int AS n FROM press_requests WHERE channel = 'mailbox'`))!.n).toBe(1);
    const outcomes = (await admin.get('/press/mailbox/log')).json.slice(0, 4).map((l: any) => l.outcome).sort();
    expect(outcomes).toEqual(['assigned', 'assigned', 'bulk', 'duplicate']);
    // nichts Neues: kein erneuter Import
    expect((await pollPressMailbox({ force: true })).imported).toBe(0);
  });

  it('Fehler beim Abruf: Protokoll und eine Meldung je Störung', async () => {
    await imap.close();
    const r1 = await pollPressMailbox({ force: true });
    expect(r1.error).toMatch(/nicht erreichbar/);
    await pollPressMailbox({ force: true });
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title = 'Presse-Postfach: Abruf fehlgeschlagen'`))!.n).toBe(1);
    expect((await admin.get('/press/mailbox')).json.state).toMatchObject({ lastOk: false });
    imap = await fakeImap({ user: 'presse', password: 'Geheim-123' });
  });

  it('NUL-Zeichen und eine fehlerhafte Mail blockieren den Eingang nicht; Fortschritt je Mail (#237)', async () => {
    const cur = (await one<any>(`SELECT value FROM settings WHERE key = 'press.mailbox'`))!.value;
    await setSettings({ 'press.mailbox': { ...cur, port: imap.port, enabled: true } } as any);
    expect((await pollPressMailbox({ force: true })).error).toBeUndefined(); // neue Quelle, noch leer
    imap.add('From: nul@zeitung.example\nSubject: =?UTF-8?Q?Test=00X?=\nMessage-ID: <nul1@zeitung.example>\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nHallo=00Welt');
    imap.add(simpleMail('kaputt1@x', '', 'Kaputt', 'kaputt@zeitung.example'));
    imap.add(simpleMail('danach1@x', '', 'Danach', 'danach@zeitung.example'));
    // eine Mail, die sich nicht speichern lässt (Fehler, der an der Mail liegt)
    await pool.query(`CREATE OR REPLACE FUNCTION test_press_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.topic = 'Kaputt' THEN RAISE EXCEPTION 'Testfehler Mail' USING ERRCODE = '22023'; END IF;
      IF NEW.topic = 'Hängt' THEN RAISE EXCEPTION 'Testfehler Abbruch' USING ERRCODE = '57014'; END IF;
      RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER test_press_fail BEFORE INSERT ON press_requests FOR EACH ROW EXECUTE FUNCTION test_press_fail()`);
    try {
      const r = await pollPressMailbox({ force: true });
      expect(r, JSON.stringify(r)).toMatchObject({ ran: true, imported: 2, skipped: 1 });
      expect(await one<any>(`SELECT topic, body, contact_email FROM press_requests WHERE contact_email = 'nul@zeitung.example'`)).toEqual({ topic: 'TestX', body: 'HalloWelt', contact_email: 'nul@zeitung.example' });
      expect(await one(`SELECT 1 FROM press_requests WHERE topic = 'Danach'`)).not.toBeNull();
      const bad = await one<any>(`SELECT outcome, subject, from_address, detail, source, external_id FROM press_mailbox_log WHERE subject = 'Kaputt'`);
      expect(bad).toMatchObject({ outcome: 'invalid', from_address: 'kaputt@zeitung.example', source: 'imap', external_id: expect.stringMatching(/^[0-9a-f]{12}:7:2$/) });
      expect(bad.detail).toMatch(/Testfehler Mail.*bleibt unverändert im Postfach/);
      expect(await one(`SELECT 1 FROM notifications WHERE title = 'Presse-Postfach: eine Mail nicht übernommen' AND permission = 'press.mailbox'`)).not.toBeNull();
      // nächster Abruf: die fehlerhafte Mail wird nicht erneut geholt
      expect((await pollPressMailbox({ force: true })).imported).toBe(0);
      expect(imap.commands.filter((c) => c === 'UID FETCH 2 (UID BODY.PEEK[])')).toHaveLength(1);
      expect((await mailboxState()).lastUid).toBe(3);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS test_press_fail ON press_requests`);
    }
  });

  it('Abbruch mitten im Stapel: Fortschritt bis zur letzten fertigen Mail; hängende Mail nach drei Versuchen übersprungen (#239)', async () => {
    imap.add(simpleMail('vorher1@x', '', 'Vorher', 'vorher@zeitung.example'));
    imap.add(simpleMail('haengt1@x', '', 'Hängt', 'haengt@zeitung.example'));
    imap.add(simpleMail('nachher1@x', '', 'Nachher', 'nachher@zeitung.example'));
    await pool.query(`CREATE TRIGGER test_press_fail BEFORE INSERT ON press_requests FOR EACH ROW EXECUTE FUNCTION test_press_fail()`);
    try {
      for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        const r = await pollPressMailbox({ force: true });
        expect(r.error).toMatch(/Testfehler Abbruch/);
        expect((await mailboxState()).current).toEqual({ id: expect.stringMatching(/^[0-9a-f]{12}:7:5$/), attempts: i });
      }
      expect((await mailboxState()).lastUid).toBe(4);
      expect(await one(`SELECT 1 FROM press_requests WHERE topic = 'Vorher'`)).not.toBeNull();
      expect(await one(`SELECT 1 FROM press_requests WHERE topic = 'Nachher'`)).toBeNull();
      const r = await pollPressMailbox({ force: true });
      expect(r, JSON.stringify(r)).toMatchObject({ imported: 1, skipped: 1 });
      expect(await one(`SELECT 1 FROM press_requests WHERE topic = 'Nachher'`)).not.toBeNull();
      expect(await one<any>(`SELECT outcome, detail FROM press_mailbox_log WHERE external_id LIKE '%:7:5' ORDER BY id DESC LIMIT 1`)).toMatchObject({ outcome: 'invalid', detail: expect.stringContaining('3 Versuche') });
      // jede fertige Mail genau einmal geholt
      expect(imap.commands.filter((c) => c === 'UID FETCH 4 (UID BODY.PEEK[])')).toHaveLength(1);
      expect(imap.commands.filter((c) => c === 'UID FETCH 5 (UID BODY.PEEK[])')).toHaveLength(MAX_ATTEMPTS);
      expect(await mailboxState()).toMatchObject({ lastUid: 6, current: null, lastOk: true });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS test_press_fail ON press_requests`);
      await pool.query(`DROP FUNCTION IF EXISTS test_press_fail()`);
    }
  });

  it('Microsoft 365: Abruf über Graph mit derselben App-Registrierung', async () => {
    const graph = await fakeGraph();
    process.env.BLAULICHTCMS_M365_TEST_URL = graph.url;
    resetM365TokenCache();
    try {
      const sec = await storeSecret('setting', '00000000-0000-0000-0000-00000000a365', 'client-geheim', null);
      await setSettings({ 'm365.tenant_id': '11111111-2222-3333-4444-555555555555', 'm365.client_id': '11111111-2222-3333-4444-666666666666', 'm365.sender': 'presse@feuerwehr.example', 'm365.secret_id': sec.id } as any);
      const m365 = { mode: 'm365', mailbox: 'presse@feuerwehr.example', intervalMinutes: 5, maxAttachmentMb: 5 };
      graph.add('g1', simpleMail('g1@tv.example', '', 'Drehgenehmigung', 'tv@sender.example'));
      expect((await admin.post('/press/mailbox/test', m365)).json).toMatchObject({ ok: true, info: expect.stringContaining('1 Nachrichten') });
      await admin.reauth();
      expect((await admin.put('/press/mailbox', { ...m365, enabled: true })).status).toBe(200);
      expect((await pollPressMailbox({ force: true })).imported).toBe(1);
      expect(await one(`SELECT 1 FROM press_requests WHERE topic = 'Drehgenehmigung' AND contact_email = 'tv@sender.example'`)).not.toBeNull();
      // erneuter Abruf: gleiche Nachricht nicht doppelt
      expect((await pollPressMailbox({ force: true })).imported).toBe(0);
      expect(graph.requests.filter((r) => r.endsWith('$value'))).toHaveLength(1);
    } finally {
      delete process.env.BLAULICHTCMS_M365_TEST_URL;
      await graph.close();
      await admin.reauth();
      await admin.put('/press/mailbox', { ...cfg(), enabled: false });
    }
  });
});

describe('Antworten per Mail (#206)', () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let requestId: string;
  let approver: Client;

  beforeAll(async () => {
    smtp = await fakeSmtp();
    await setSettings({ 'mail.transport': 'smtp', 'smtp.host': '127.0.0.1', 'smtp.port': smtp.port, 'smtp.security': 'none', 'smtp.user': '', 'smtp.from': 'presse@feuerwehr.example', 'general.sender_name': 'Feuerwehr Musterstadt' } as any);
    requestId = (await one<any>(`SELECT id FROM press_requests WHERE channel = 'mailbox' ORDER BY created_at LIMIT 1`))!.id;
    approver = (await login('freigabe@example.org', 'Frieda Freigabe', ['approver'])).client;
  });
  afterAll(async () => {
    await smtp?.close();
  });

  it('Textbausteine: verwalten nur mit Recht, lesen auch beim Antworten', async () => {
    expect((await reader.get('/press/snippets')).status).toBe(403);
    expect((await reader.post('/press/snippets', { title: 'X', body: 'Y' })).status).toBe(403);
    const s = await editor.post('/press/snippets', { title: 'Begrüßung', body: 'Guten Tag {{name}},\nzu Ihrer Anfrage „{{thema}}“ ({{nummer}}):' });
    expect(s.status).toBe(200);
    expect((await editor.put(`/press/snippets/${s.json.id}`, { title: 'Begrüßung', body: 'Guten Tag {{name}},' })).status).toBe(200);
    expect((await editor.get('/press/snippets')).json).toEqual([expect.objectContaining({ title: 'Begrüßung', body: 'Guten Tag {{name}},' })]);
    expect((await approver.get('/press/snippets')).status).toBe(403);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'press.snippet_updated'`)).not.toBeNull();
  });

  it('ohne Freigabe: Versand mit Verlaufs-Kopfzeilen, Status „beantwortet“, Verlauf und Audit', async () => {
    expect((await reader.post(`/press/requests/${requestId}/replies`, { to: ['a@b.example'], subject: 'AW: x', body: 'y' })).status).toBe(403);
    expect((await editor.post(`/press/requests/${requestId}/replies`, { to: ['kein-mail'], subject: 'AW: x', body: 'y' })).status).toBe(400);
    const r = await editor.post(`/press/requests/${requestId}/replies`, { to: ['paula@zeitung.example'], subject: 'AW: Großbrand in der Halle', body: 'Guten Tag Frau Müller,\nes waren 40 Kräfte im Einsatz.' });
    expect(r.json).toMatchObject({ status: 'queued' });
    const job = await one<any>(`SELECT kind, max_attempts FROM jobs WHERE kind = 'press.reply' AND payload->>'id' = $1`, [r.json.id]);
    expect(job).toMatchObject({ max_attempts: 1 });
    await deliverPressReply(r.json.id);
    expect(smtp.received).toHaveLength(1);
    const raw = smtp.received[0].raw;
    expect(smtp.received[0].to).toEqual(['paula@zeitung.example']);
    expect(raw).toMatch(/^In-Reply-To: <reply1@zeitung\.example>/m);
    expect(raw).toMatch(/^References: [\s\S]*<reply1@zeitung\.example>/m);
    expect(raw).toMatch(/^Message-ID: <press-[0-9a-f-]+@feuerwehr\.example>/m);
    expect((await one<any>(`SELECT subject FROM press_messages WHERE id = $1`, [r.json.id]))!.subject).toMatch(/^AW: Großbrand in der Halle \[P-\d{4}-\d{4}\]$/);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?Q\?AW=3A_Gro=C3=9Fbrand/m);
    expect(raw).toContain('Feuerwehr Musterstadt');
    const d = (await editor.get(`/press/requests/${requestId}`)).json;
    expect(d.request.status).toBe('answered');
    const out = d.messages.find((m: any) => m.id === r.json.id);
    expect(out).toMatchObject({ direction: 'out', status: 'sent', from_address: 'presse@feuerwehr.example' });
    expect(d.events.some((e: any) => e.kind === 'mail_out')).toBe(true);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'press.reply_sent'`)).not.toBeNull();
    // Rückfrage der Redaktion auf diese Antwort landet wieder bei der Anfrage
    const msgId = (await one<any>(`SELECT message_id FROM press_messages WHERE id = $1`, [r.json.id]))!.message_id;
    const { ingestPressMail } = await import('../src/press/mailbox.js');
    const back = await ingestPressMail(Buffer.from(`From: paula@zeitung.example\r\nSubject: Re: AW\r\nMessage-ID: <rueck@zeitung.example>\r\nIn-Reply-To: ${msgId}\r\n\r\nDanke!`), { source: 'imap', externalId: 'x1', receivedAt: null, maxAttachmentMb: 5, ownAddresses: [] });
    expect(back).toMatchObject({ outcome: 'assigned', requestId });
  });

  it('Absender mit Anzeigenamen („Name <adresse>“): gültiger Umschlag, Message-ID mit Domain (#230)', async () => {
    await setSettings({ 'smtp.from': 'Pressestelle Musterstadt <presse@feuerwehr.example>' } as any);
    try {
      const before = smtp.received.length;
      const r = await editor.post(`/press/requests/${requestId}/replies`, { to: ['paula@zeitung.example'], subject: 'AW: Absender', body: 'Text' });
      await deliverPressReply(r.json.id);
      expect(smtp.received).toHaveLength(before + 1);
      const m = smtp.received[before];
      expect(m.from).toBe('presse@feuerwehr.example');
      expect(m.raw).toMatch(/^From: Pressestelle Musterstadt <presse@feuerwehr\.example>\r?$/m);
      expect(m.raw).toMatch(/^Message-ID: <press-[0-9a-f-]+@feuerwehr\.example>/m);
      expect(await one<any>(`SELECT from_address, status FROM press_messages WHERE id = $1`, [r.json.id])).toEqual({ from_address: 'presse@feuerwehr.example', status: 'sent' });
      // die eigene Mail (z. B. über einen Verteiler zurück im Presse-Postfach) wird erkannt
      const { ingestPressMail } = await import('../src/press/mailbox.js');
      const { ownSenderAddresses } = await import('../src/lib/mail-address.js');
      const own = ownSenderAddresses({ 'smtp.from': 'Pressestelle Musterstadt <presse@feuerwehr.example>', 'm365.sender': '' });
      const back = await ingestPressMail(Buffer.from(m.raw.replace(/^Message-ID: .*$/m, 'Message-ID: <eigen-kopie@feuerwehr.example>')), { source: 'imap', externalId: 'own1', receivedAt: null, maxAttachmentMb: 5, ownAddresses: own });
      expect(back.outcome).toBe('own');
    } finally {
      await setSettings({ 'smtp.from': 'presse@feuerwehr.example' } as any);
    }
  });

  it('mit Freigabe: zweite Person nötig, Zurückweisen mit Begründung', async () => {
    await setSettings({ 'press.reply_approval': true } as any);
    const r = await admin.post(`/press/requests/${requestId}/replies`, { to: ['paula@zeitung.example'], subject: 'AW: Nachfrage', body: 'Entwurf' });
    expect(r.json.status).toBe('pending');
    expect(await one(`SELECT 1 FROM jobs WHERE kind = 'press.reply' AND payload->>'id' = $1`, [r.json.id])).toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE permission = 'press.approve' AND category = 'approval'`)).not.toBeNull();
    expect((await editor.post(`/press/replies/${r.json.id}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await admin.post(`/press/replies/${r.json.id}/decision`, { decision: 'approved' })).status).toBe(403); // eigene
    expect((await approver.post(`/press/replies/${r.json.id}/decision`, { decision: 'rejected' })).status).toBe(400);
    expect((await approver.post(`/press/replies/${r.json.id}/decision`, { decision: 'rejected', note: 'Zahl prüfen' })).status).toBe(200);
    expect(await one<any>(`SELECT status, decision_note FROM press_messages WHERE id = $1`, [r.json.id])).toMatchObject({ status: 'rejected', decision_note: 'Zahl prüfen' });
    expect((await admin.del(`/press/replies/${r.json.id}`)).status).toBe(200);
    const r2 = await editor.post(`/press/requests/${requestId}/replies`, { to: ['paula@zeitung.example'], subject: 'AW: Nachfrage', body: 'Korrigiert' });
    expect((await approver.post(`/press/replies/${r2.json.id}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await approver.post(`/press/replies/${r2.json.id}/decision`, { decision: 'approved' })).status).toBe(409);
    await deliverPressReply(r2.json.id);
    expect(smtp.received.at(-1)!.raw).toContain('Korrigiert');
    expect((await one<any>(`SELECT status FROM press_messages WHERE id = $1`, [r2.json.id]))!.status).toBe('sent');
    await setSettings({ 'press.reply_approval': false } as any);
  });

  it('Versand fehlgeschlagen: erneut senden; Ergebnis unbekannt nie automatisch', async () => {
    await setSettings({ 'smtp.port': 1 } as any);
    const r = await editor.post(`/press/requests/${requestId}/replies`, { to: ['paula@zeitung.example'], subject: 'AW: x', body: 'y' });
    await deliverPressReply(r.json.id);
    expect((await one<any>(`SELECT status FROM press_messages WHERE id = $1`, [r.json.id]))!.status).toBe('failed');
    await setSettings({ 'smtp.port': smtp.port } as any);
    expect((await editor.post(`/press/replies/${r.json.id}/retry`)).status).toBe(200);
    await deliverPressReply(r.json.id);
    expect((await one<any>(`SELECT status FROM press_messages WHERE id = $1`, [r.json.id]))!.status).toBe('sent');
    // unterbrochen (Status „sending“ beim Start des Auftrags) ⇒ unbekannt, kein Neuversand
    await pool.query(`UPDATE press_messages SET status = 'sending' WHERE id = $1`, [r.json.id]);
    const before = smtp.received.length;
    await deliverPressReply(r.json.id);
    expect((await one<any>(`SELECT status FROM press_messages WHERE id = $1`, [r.json.id]))!.status).toBe('unknown');
    expect(smtp.received.length).toBe(before);
    expect((await editor.post(`/press/replies/${r.json.id}/retry`)).status).toBe(409);
    expect((await editor.post(`/press/replies/${r.json.id}/resolve`, { sent: true })).status).toBe(200);
  });

  it('Microsoft 365: Antwort als MIME-Nachricht über Graph (Verlaufs-Kopfzeilen bleiben erhalten)', async () => {
    const graph = await fakeGraph();
    process.env.BLAULICHTCMS_M365_TEST_URL = graph.url;
    resetM365TokenCache();
    try {
      await setSettings({ 'mail.transport': 'm365' } as any);
      const r = await editor.post(`/press/requests/${requestId}/replies`, { to: ['paula@zeitung.example'], subject: 'AW: Graph', body: 'Antwort über Microsoft 365' });
      await deliverPressReply(r.json.id);
      expect(await one<any>(`SELECT status, error FROM press_messages WHERE id = $1`, [r.json.id])).toMatchObject({ status: 'sent' });
      expect(graph.sent).toHaveLength(1);
      expect(graph.sent[0].contentType).toBe('text/plain');
      const mime = Buffer.from(graph.sent[0].body, 'base64').toString('utf8');
      expect(mime).toMatch(/^In-Reply-To: </m);
      expect(mime).toMatch(/^To: paula@zeitung\.example/m);
    } finally {
      delete process.env.BLAULICHTCMS_M365_TEST_URL;
      await graph.close();
      await setSettings({ 'mail.transport': 'smtp' } as any);
    }
  });
});

describe('Presseverteiler und Pressemitteilungen (#207)', () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let publisher: Client;
  let listA: string;
  let listB: string;
  let paula: string;

  beforeAll(async () => {
    smtp = await fakeSmtp();
    await setSettings({ 'mail.transport': 'smtp', 'smtp.host': '127.0.0.1', 'smtp.port': smtp.port, 'smtp.security': 'none', 'smtp.from': 'presse@feuerwehr.example', 'general.public_url': '' } as any);
    publisher = (await login('veroeffentlichung@example.org', 'Vera Veröffentlichung', ['publisher'])).client;
  });
  afterAll(async () => {
    await smtp?.close();
  });

  it('Kontakte und Listen: Rechte, Dubletten, Herkunft/Einwilligung', async () => {
    expect((await reader.get('/press/contacts')).status).toBe(403);
    expect((await approverlessGet('/press/lists')).status).toBe(403);
    listA = (await editor.post('/press/lists', { name: 'Lokalpresse' })).json.id;
    listB = (await editor.post('/press/lists', { name: 'Rundfunk' })).json.id;
    expect((await editor.post('/press/lists', { name: 'lokalpresse' })).status).toBe(409);
    const c = await editor.post('/press/contacts', { name: 'Paula Müller', outlet: 'Musterstädter Zeitung', email: 'Paula@Zeitung.example', origin: 'Visitenkarte Pressetermin', consent: 'mündlich zugestimmt am 01.11.2026', listIds: [listA, listB] });
    expect(c.status).toBe(200);
    paula = c.json.id;
    expect((await editor.post('/press/contacts', { email: 'paula@zeitung.example' })).status).toBe(409);
    await editor.post('/press/contacts', { name: 'Radio', outlet: 'Radio Muster', email: 'redaktion@radio.example', listIds: [listB] });
    const lists = (await publisher.get('/press/lists')).json;
    expect(lists.map((l: any) => [l.name, l.contacts])).toEqual([['Lokalpresse', 1], ['Rundfunk', 2]]);
    const all = (await editor.get('/press/contacts')).json;
    expect(all.find((x: any) => x.id === paula)).toMatchObject({ email: 'paula@zeitung.example', origin: 'Visitenkarte Pressetermin', list_ids: expect.arrayContaining([listA, listB]) });
  });

  it('CSV-Import und -Export: Listen per Name, keine Dubletten, Abgemeldete bleiben abgemeldet, Formeln entschärft', async () => {
    await pool.query(`UPDATE press_contacts SET unsubscribed_at = now() WHERE email = 'redaktion@radio.example'`);
    const csv = 'name;medium;email;listen;herkunft\n"Tom, TV";=HYPERLINK("x");tom@tv.example;Rundfunk|Fernsehen;Messe\nRadio Neu;Radio Muster;REDAKTION@radio.example;Rundfunk;\nkaputt;x;keine-adresse;;\n';
    const dry = await editor.post('/press/contacts/import', { csv, dryRun: true });
    expect(dry.json).toMatchObject({ neu: 1, aktualisiert: 1, fehler: 1 });
    expect(await one(`SELECT 1 FROM press_contacts WHERE email = 'tom@tv.example'`)).toBeNull();
    const imp = await editor.post('/press/contacts/import', { csv });
    expect(imp.json).toMatchObject({ neu: 1, aktualisiert: 1 });
    expect(await one<any>(`SELECT name, unsubscribed_at IS NOT NULL AS unsub FROM press_contacts WHERE email = 'redaktion@radio.example'`)).toMatchObject({ name: 'Radio Neu', unsub: true });
    expect(await one(`SELECT 1 FROM press_lists WHERE name = 'Fernsehen'`)).not.toBeNull();
    const exp = await editor.raw('GET', '/press/contacts/export');
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.body).toContain(`'=HYPERLINK`);
    expect(exp.body).toContain('Tom, TV;');
    expect((await reader.raw('GET', '/press/contacts/export')).status).toBe(403);
  });

  it('Pressemitteilung aus einem Beitrag: einzeln adressiert, mit Abmeldelink, Versandprotokoll', async () => {
    const post = await one<any>(`INSERT INTO posts (kind, title) VALUES ('news', 'Neues Löschfahrzeug') RETURNING id`);
    await pool.query(`INSERT INTO post_revisions (post_id, number, title, body, excerpt, content_hash) VALUES ($1, 1, 'Neues Löschfahrzeug', '<p>Die Feuerwehr hat ein <b>neues</b> Fahrzeug.</p>', '', 'x')`, [post.id]);
    await pool.query(`UPDATE posts SET current_revision = 1 WHERE id = $1`, [post.id]);
    expect((await editor.get(`/press/releases/from-post/${post.id}`)).status).toBe(403); // Redaktion darf nicht versenden
    const tpl = (await publisher.get(`/press/releases/from-post/${post.id}`)).json;
    expect(tpl).toEqual({ subject: 'Neues Löschfahrzeug', body: 'Die Feuerwehr hat ein neues Fahrzeug.' });
    const rel = await publisher.post('/press/releases', { ...tpl, listIds: [listB], postId: post.id });
    expect(rel.status).toBe(200);
    // ohne öffentliche Adresse kein Abmeldelink ⇒ kein Versand
    await publisher.reauth();
    expect((await publisher.post(`/press/releases/${rel.json.id}/send`)).json.message).toMatch(/öffentliche Adresse/);
    await setSettings({ 'general.public_url': 'https://cms.example.org' } as any);
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour'`);
    expect((await publisher.post(`/press/releases/${rel.json.id}/send`)).json.error).toBe('reauth_required');
    await publisher.reauth();
    const sent = await publisher.post(`/press/releases/${rel.json.id}/send`);
    expect(sent.json).toMatchObject({ ok: true, recipients: 2 }); // Paula + Tom; Radio ist abgemeldet
    expect((await publisher.put(`/press/releases/${rel.json.id}`, { subject: 'Neu', body: 'y' })).status).toBe(409);
    await deliverRelease(rel.json.id);
    expect(smtp.received).toHaveLength(2);
    for (const m of smtp.received) {
      m.raw = m.raw.replace(/\r\n[ \t]+/g, ' ');
      expect(m.to).toHaveLength(1);
      expect(m.raw).toMatch(new RegExp(`^To: ${m.to[0].replace('.', '\\.')}\\r?$`, 'm'));
      expect(m.raw).toMatch(/^List-Unsubscribe: <https:\/\/cms\.example\.org\/api\/v1\/public\/press\/unsubscribe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+>/m);
      expect(m.raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
      expect(m.raw).not.toMatch(/^(Cc|Bcc):/m);
    }
    const d = (await publisher.get(`/press/releases/${rel.json.id}`)).json;
    expect(d.release.status).toBe('sent');
    expect(d.recipients.map((x: any) => x.status)).toEqual(['sent', 'sent']);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'press.release_sent'`)).not.toBeNull();
  });

  it('Abmeldung über den Link (auch Ein-Klick ohne Sitzung) – danach keine Mitteilungen mehr', async () => {
    const raw = smtp.received.find((m) => m.to[0] === 'paula@zeitung.example')!.raw;
    const token = /unsubscribe\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(raw)![1];
    const anon = new Client(app);
    expect((await anon.get(`/public/press/unsubscribe/${token.slice(0, -2)}xx`)).status).toBe(404);
    expect((await anon.get(`/public/press/unsubscribe/${token}`)).json).toEqual({ email: 'p…@zeitung.example', unsubscribed: false });
    const res = await app.inject({ method: 'POST', url: `/api/v1/public/press/unsubscribe/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect((await anon.get(`/public/press/unsubscribe/${token}`)).json.unsubscribed).toBe(true);
    const rel = await publisher.post('/press/releases', { subject: 'Zweite Mitteilung', body: 'Text', listIds: [listA] });
    await publisher.reauth();
    expect((await publisher.post(`/press/releases/${rel.json.id}/send`)).json.message).toMatch(/keine \(angemeldeten\) Kontakte/);
    // wieder anmelden nur mit vermerkter Einwilligung
    expect((await editor.put(`/press/contacts/${paula}`, { email: 'paula@zeitung.example', consent: '', resubscribe: true, listIds: [listA] })).status).toBe(400);
  });

  it('Fehler je Empfänger: Teilversand, Rest nachholen', async () => {
    await pool.query(`UPDATE press_contacts SET unsubscribed_at = NULL WHERE id = $1`, [paula]);
    const rel = await publisher.post('/press/releases', { subject: 'Dritte', body: 'Text', listIds: [listA, listB] });
    await publisher.reauth();
    await setSettings({ 'smtp.port': 1 } as any);
    await publisher.post(`/press/releases/${rel.json.id}/send`);
    await deliverRelease(rel.json.id);
    const d = (await publisher.get(`/press/releases/${rel.json.id}`)).json;
    expect(d.release.status).toBe('partial');
    expect(d.recipients.every((x: any) => x.status === 'failed')).toBe(true);
    await setSettings({ 'smtp.port': smtp.port } as any);
  });

  it('Workflow-Ausgang „Pressemitteilung an Verteiler“: Standard Entwurf, Testlauf ohne Wirkung', async () => {
    const out = await admin.post('/automation-outputs', { name: 'PM', kind: 'press_release', config: { listIds: [listA], subject: 'Presse: {{thema}}', body: 'Zur Anfrage {{nummer}}' } });
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect((await admin.post('/automation-outputs', { name: 'PM2', kind: 'press_release', config: { listIds: [], subject: 'x', body: 'y' } })).status).toBe(400);
    const input = (await admin.get('/automation-inputs')).json.find((i: any) => i.kind === 'press');
    const graph = {
      nodes: [
        { id: 'n1', type: 'input', position: { x: 0, y: 0 }, data: { inputId: input.id } },
        { id: 'n2', type: 'output', position: { x: 200, y: 0 }, data: { outputId: out.json.id } },
      ],
      edges: [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2' }],
    };
    const a = await admin.post('/automations', { name: 'Presseanfrage → PM-Entwurf' });
    const cur = await admin.get(`/automations/${a.json.id}`);
    expect((await admin.put(`/automations/${a.json.id}`, { name: 'Presseanfrage → PM-Entwurf', graph, baseHash: cur.json.draft_hash })).status).toBe(200);
    const t = await admin.post(`/automations/${a.json.id}/test`, {});
    expect(t.json.status, JSON.stringify(t.json)).toBe('succeeded');
    expect(JSON.stringify(t.json)).toContain('als Entwurf');
    const before = (await one<any>(`SELECT count(*)::int AS n FROM press_releases`))!.n;
    expect(before).toBe(3);
  });

  it('Datenschutzanfrage findet Kontakte und löscht auch die Adresse im Versandprotokoll', async () => {
    const hits = (await admin.get('/privacy/search?q=tom@tv.example')).json.hits;
    const hit = hits.find((h: any) => h.kind === 'press_contact');
    expect(hit.fields.pressemitteilungen).toBe(2);
    expect((await admin.post('/privacy/action', { kind: 'press_contact', id: hit.id, action: 'delete' })).status).toBe(200);
    expect(await one(`SELECT 1 FROM press_release_recipients WHERE email = 'tom@tv.example'`)).toBeNull();
  });
});

async function approverlessGet(url: string) {
  return reader.get(url);
}
