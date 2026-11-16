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
import { pollPressMailbox } from '../src/press/mailbox.js';
import { fakeGraph, fakeImap } from './press-fakes.js';

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
