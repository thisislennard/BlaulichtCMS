import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { getSettings, setSettings } from '../src/lib/settings.js';
import { claimJobs, completeJob } from '../src/jobs/queue.js';
import { notify } from '../src/lib/notify.js';
import { deliverNotification } from '../src/lib/notify-channels.js';
import { findPlaintextSecrets, migratePlaintextSecrets } from '../src/lib/secret-audit.js';
import { connectionSecrets, loadConnection } from '../src/connections/common.js';

/**
 * Push- und E-Mail-Benachrichtigungen (#191) und Klartext-Prüfung der Zugangsdaten (#190) gegen eine echte
 * PostgreSQL-Datenbank. Ein lokaler Stellvertreter spielt Push-Dienst (entschlüsselt die Nachrichten wie ein Browser)
 * sowie Microsoft-Anmeldung und Microsoft Graph.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'Client~Geheimnis.Wert_2026';

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as any,
      url: `/api/v1${url}`,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json, body: res.body };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  del = (u: string) => this.raw('DELETE', u, {});
}

/** Gerät (Browser) mit eigenem Schlüsselpaar, wie es PushManager.subscribe() erzeugt. */
function device(name: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { name, ecdh, auth, endpoint: `${base}/push/${name}`, sub: () => ({ endpoint: `${base}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }) };
}

/** Entschlüsseln wie der Browser (RFC 8291/8188). */
function decrypt(d: ReturnType<typeof device>, body: Buffer): any {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = d.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), d.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, d.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

let base = '';
let server: http.Server;
const pushes: { device: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
const graphMails: { sender: string; auth: string; body: any }[] = [];
const tokenRequests: URLSearchParams[] = [];
const goneDevices = new Set<string>();

let admin: Client;
let editor: Client;
let approver: Client;
let editorId: string;
const freshReauth = () => pool.query(`UPDATE sessions SET reauth_at = now()`);

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return { client: c, userId: inv.json.user.id as string };
}

/** Worker-Ersatz: fällige notify.deliver-Aufträge ausführen, alles andere abhaken. */
async function drain() {
  for (let i = 0; i < 10; i++) {
    const jobs = await claimJobs(20);
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.kind === 'notify.deliver') await deliverNotification(Number(j.payload.id));
      await completeJob(j.id);
    }
  }
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      if (url.startsWith('/push/')) {
        const name = url.slice(6);
        if (goneDevices.has(name)) return res.writeHead(410).end();
        pushes.push({ device: name, headers: req.headers, body });
        return res.writeHead(201).end();
      }
      if (url === `/login/${TENANT}/oauth2/v2.0/token`) {
        const form = new URLSearchParams(body.toString());
        tokenRequests.push(form);
        if (form.get('client_secret') !== SECRET || form.get('client_id') !== CLIENT) {
          return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
        }
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token_type: 'Bearer', expires_in: 3599, access_token: 'graph-token-1' }));
      }
      const m = /^\/graph\/users\/([^/]+)\/sendMail$/.exec(url);
      if (m) {
        const sender = decodeURIComponent(m[1]);
        if (sender !== 'funktion@example.org') return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } }));
        graphMails.push({ sender, auth: String(req.headers.authorization), body: JSON.parse(body.toString()) });
        return res.writeHead(202).end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.BLAULICHTCMS_PUSH_TEST_URL = base;
  process.env.BLAULICHTCMS_M365_TEST_URL = base;
  app = await buildApp();
  admin = new Client(app);
});

afterAll(async () => {
  server?.close();
  await app?.close();
  await pool.end();
});

describe('Benachrichtigungen: Push', () => {
  const ed = () => devices.editor;
  const devices: Record<string, ReturnType<typeof device>> = {};

  it('richtet Konten ein; jede Person sieht nur Arten, für die sie Rechte hat', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    const e = await acceptInvite('redaktion@example.org', ['editor'], 'Robin');
    editor = e.client;
    editorId = e.userId;
    approver = (await acceptInvite('freigabe@example.org', ['approver'], 'Sam')).client;

    const pe = await editor.get('/notify/preferences');
    expect(pe.status).toBe(200);
    const ids = pe.json.categories.map((c: any) => c.id);
    expect(ids).toContain('incident');
    expect(ids).toContain('decision');
    expect(ids).not.toContain('approval');
    expect(ids).not.toContain('update');
    expect(ids).not.toContain('security');
    expect((await approver.get('/notify/preferences')).json.categories.map((c: any) => c.id)).toContain('approval');
    // VAPID-Schlüssel beim ersten Bedarf erzeugt: öffentlich in den Einstellungen, privat nur verschlüsselt
    expect(pe.json.vapidPublicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    const s = await getSettings(true);
    expect(s['push.vapid_secret_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(await many(`SELECT value FROM settings`))).not.toMatch(/"d"|privateKey/);
    expect(pe.json.channels).toEqual({ push: true, mail: false });
    // Kein Recht für die Verwaltung
    expect((await editor.get('/notify/settings')).status).toBe(403);
    expect((await admin.get('/notify/settings')).status).toBe(200);
  });

  it('Push-Abo nur für bekannte Push-Dienste; Testnachricht kommt verschlüsselt und mit VAPID an', async () => {
    devices.editor = device('robin-handy');
    devices.approver = device('sam-tablet');
    expect((await editor.post('/notify/push/subscriptions', { subscription: { ...ed().sub(), endpoint: 'https://intern.example.org/push/x' }, label: 'Böse' })).status).toBe(400);
    expect((await editor.post('/notify/push/subscriptions', { subscription: { ...ed().sub(), endpoint: 'https://10.0.0.1/push' } })).status).toBe(400);
    const r = await editor.post('/notify/push/subscriptions', { subscription: ed().sub(), label: 'Handy' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await approver.post('/notify/push/subscriptions', { subscription: devices.approver.sub(), label: 'Tablet' })).status).toBe(200);
    const prefs = await editor.get('/notify/preferences');
    expect(prefs.json.subscriptions).toHaveLength(1);
    expect(prefs.body).not.toContain('/push/robin-handy'); // Adresse beim Push-Dienst geht nie an die Oberfläche
    expect(prefs.json.subscriptions[0].endpoint_hash).toBe(r.json.endpoint_hash);

    pushes.length = 0;
    const t = await editor.post('/notify/push/test', {});
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json.results).toEqual([{ id: r.json.id, label: 'Handy', status: 'sent' }]);
    expect(pushes).toHaveLength(1);
    const p = pushes[0];
    expect(p.headers['content-encoding']).toBe('aes128gcm');
    expect(Number(p.headers.ttl)).toBe(86400);
    expect(decrypt(ed(), p.body).title).toBe('Testnachricht');
    // VAPID: JWT mit ES256, aud = Herkunft des Push-Dienstes, Signatur passt zum öffentlichen Schlüssel
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(p.headers.authorization))!;
    expect(m[2]).toBe(prefs.json.vapidPublicKey);
    const [h, c, sig] = m[1].split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims.aud).toBe(base);
    expect(claims.sub).toBe('https://blaulichtcms.example.org');
    const pub = Buffer.from(m[2], 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('Ereignisse gehen nach Recht und Wahl der Person per Push hinaus; erloschene Abos werden entfernt', async () => {
    pushes.length = 0;
    // Einsatz-Eingang: Recht post.edit (Redaktion), Vorgabe Push
    await notify({ kind: 'info', title: 'Neuer Einsatzentwurf aus FE2: Brand', link: '/beitraege/1', permission: 'post.edit', category: 'incident' });
    // Freigabe angefordert: nur Freigabe-Rolle
    await notify({ kind: 'info', title: 'Freigabe erbeten: Testbeitrag', permission: 'approval.post' });
    await drain();
    expect(pushes.map((p) => p.device).sort()).toEqual(['robin-handy', 'sam-tablet']);
    const toRobin = decrypt(ed(), pushes.find((p) => p.device === 'robin-handy')!.body);
    expect(toRobin).toMatchObject({ title: 'Neuer Einsatzentwurf aus FE2: Brand', link: '/beitraege/1', tag: 'blaulichtcms-incident' });
    expect(decrypt(devices.approver, pushes.find((p) => p.device === 'sam-tablet')!.body).title).toBe('Freigabe erbeten: Testbeitrag');

    // Person schaltet Push für Einsätze ab → keine Zustellung mehr; nicht angebotene Arten werden übergangen
    expect((await editor.put('/notify/preferences', { choices: { incident: [], approval: ['push'] } })).status).toBe(200);
    const stored = await one<any>(`SELECT preferences->'notifyChannels' AS n FROM users WHERE id = $1`, [editorId]);
    expect(stored.n).toEqual({ incident: [] });
    pushes.length = 0;
    await notify({ kind: 'info', title: 'Zweiter Einsatz', permission: 'post.edit', category: 'incident' });
    await drain();
    expect(pushes).toHaveLength(0);

    // An eine Person gerichtet (Entscheidung über eigene Fassung)
    await notify({ kind: 'success', title: 'Freigegeben: Beitrag', userId: editorId, category: 'decision' });
    goneDevices.add('robin-handy');
    await drain();
    expect((await one<any>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [editorId])).n).toBe(0);
    goneDevices.clear();
  });

  it('Push global aus: kein Auftrag, kein neues Abo', async () => {
    await setSettings({ 'notify.push_enabled': false });
    const before = (await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'notify.deliver'`)).n;
    await notify({ kind: 'info', title: 'Freigabe erbeten: X', permission: 'approval.post' });
    expect((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'notify.deliver'`)).n).toBe(before);
    expect((await editor.post('/notify/push/subscriptions', { subscription: ed().sub() })).status).toBe(409);
    await setSettings({ 'notify.push_enabled': true });
  });
});

describe('E-Mail über Microsoft 365', () => {
  const form = { tenantId: TENANT, clientId: CLIENT, sender: 'funktion@example.org', saveSent: true };

  it('Aktivieren nur nach bestandener Testmail mit genau diesen Angaben', async () => {
    await freshReauth();
    expect((await admin.put('/notify/settings', { transport: 'm365', pushEnabled: true, mailEnabled: true, ...form, clientSecret: SECRET })).status).toBe(409);
    // Falsches Geheimnis: verständliche Meldung, Geheimnis nie in der Antwort
    const bad = await admin.post('/notify/settings/test-mail', { to: 'pruefung@example.org', ...form, clientSecret: 'falsch-geheim' });
    expect(bad.status).toBe(502);
    expect(bad.json.message).toMatch(/Client-Geheimnis ungültig/);
    expect(bad.body).not.toContain('falsch-geheim');
    // Postfach unbekannt
    const nobox = await admin.post('/notify/settings/test-mail', { to: 'pruefung@example.org', ...form, sender: 'fehlt@example.org', clientSecret: SECRET });
    expect(nobox.status).toBe(502);
    expect(nobox.json.message).toMatch(/nicht gefunden/);
    const ok = await admin.post('/notify/settings/test-mail', { to: 'pruefung@example.org', ...form, clientSecret: SECRET });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const last = graphMails.at(-1)!;
    expect(last.auth).toBe('Bearer graph-token-1');
    expect(last.body.message.toRecipients).toEqual([{ emailAddress: { address: 'pruefung@example.org' } }]);
    expect(last.body.saveToSentItems).toBe(true);
    expect(tokenRequests.at(-1)!.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(tokenRequests.at(-1)!.get('grant_type')).toBe('client_credentials');
    // Andere Absenderadresse als getestet → erneuter Test nötig
    expect((await admin.put('/notify/settings', { transport: 'm365', pushEnabled: true, mailEnabled: true, ...form, sender: 'anders@example.org', clientSecret: SECRET })).status).toBe(409);
    // Ohne frische Bestätigung kein Umschalten
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour'`);
    expect((await admin.put('/notify/settings', { transport: 'm365', pushEnabled: true, mailEnabled: true, ...form, clientSecret: SECRET })).json.error).toBe('reauth_required');
    await freshReauth();
    const save = await admin.put('/notify/settings', { transport: 'm365', pushEnabled: true, mailEnabled: true, ...form, clientSecret: SECRET });
    expect(save.status, JSON.stringify(save.json)).toBe(200);
  });

  it('Client-Geheimnis nur verschlüsselt gespeichert, nie an die Oberfläche', async () => {
    const s = await getSettings(true);
    expect(s['mail.transport']).toBe('m365');
    expect(s['m365.secret_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(await many(`SELECT key, value FROM settings`))).not.toContain(SECRET);
    expect(JSON.stringify(await many(`SELECT ciphertext FROM secrets`))).not.toContain(SECRET);
    const v = await admin.get('/notify/settings');
    expect(v.body).not.toContain(SECRET);
    expect(v.json.m365).toMatchObject({ secret_set: true, sender: 'funktion@example.org' });
    expect((await admin.get('/settings')).body).not.toContain('m365.secret_id');
    // Leeres Geheimnis beim Speichern = gespeichertes behalten; anderes Verzeichnis ohne neues Geheimnis → abgewiesen
    expect((await admin.put('/notify/settings', { transport: 'm365', pushEnabled: true, mailEnabled: true, ...form })).status).toBe(200);
    expect((await admin.post('/notify/settings/test-mail', { to: 'x@example.org', ...form, tenantId: '99999999-2222-3333-4444-555555555555' })).status).toBe(400);
  });

  it('Benachrichtigungen, Sicherheitsmeldungen und Automationen senden über Microsoft 365', async () => {
    graphMails.length = 0;
    // Redaktion wählt E-Mail für Einsätze
    expect((await editor.put('/notify/preferences', { choices: { incident: ['mail'] } })).status).toBe(200);
    expect((await editor.get('/notify/preferences')).json.channels.mail).toBe(true);
    await notify({ kind: 'info', title: 'Neuer Einsatzentwurf aus Feuersoftware Connect: TH', link: '/beitraege/2', permission: 'post.edit', category: 'incident' });
    await drain();
    expect(graphMails).toHaveLength(1);
    expect(graphMails[0].body.message.toRecipients).toEqual([{ emailAddress: { address: 'redaktion@example.org' } }]);
    expect(graphMails[0].body.message.subject).toBe('[BlaulichtCMS] Neuer Einsatzentwurf aus Feuersoftware Connect: TH');
    expect(graphMails[0].body.message.body.content).toContain('https://blaulichtcms.example.org/beitraege/2');

    // Kontomeldung an die betroffene Person (security.alert_mail_user) geht denselben Weg
    graphMails.length = 0;
    const { notifyAffectedUser } = await import('../src/lib/security-alerts.js');
    await notifyAffectedUser(editorId, 'Passwort geändert', 'Ihr Passwort wurde geändert.');
    await new Promise((r) => setTimeout(r, 300));
    expect(graphMails.map((m) => m.body.message.toRecipients[0].emailAddress.address)).toContain('redaktion@example.org');
  });

  it('Warnversand: Testmodus aus nur mit frischer Microsoft-365-Testmail', async () => {
    await setSettings({ 'm365.verified': null });
    const off = await admin.put('/warning-settings', { host: '', port: 587, security: 'starttls', user: '', from: '', testMode: false, testRecipient: 'test@example.org' });
    expect(off.status).toBe(409);
    expect(off.json.message).toMatch(/Microsoft 365/);
    expect((await admin.post('/notify/settings/test-mail', { to: 'pruefung@example.org', ...form })).status).toBe(200);
    expect((await admin.put('/warning-settings', { host: '', port: 587, security: 'starttls', user: '', from: '', testMode: false, testRecipient: 'test@example.org' })).status).toBe(200);
    expect((await admin.get('/warning-config')).json.transport.kind).toBe('m365');
  });
});

describe('Zugangsdaten nie im Klartext (#190)', () => {
  it('der Datenbestand nach Push und Microsoft 365 enthält keine Klartext-Zugangsdaten', async () => {
    expect(await findPlaintextSecrets()).toEqual([]);
  });

  it('erkennt Klartext in Einstellungen und Verbindungen und verschiebt ihn in den verschlüsselten Speicher', async () => {
    const c = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('feuersoftware', 'Altbestand', 'draft', $1) RETURNING id`, [JSON.stringify({ apiKey: 'klartext-schluessel-123', intervalSeconds: 60, tokenExpiresAt: '2026-12-01' })]);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('altlast.password', '"klartext-passwort"'), ('altlast.feed', '"https://nutzer:geheim@feed.example.org/rss"')`);
    const found = await findPlaintextSecrets();
    expect(found).toEqual(
      expect.arrayContaining([
        { where: 'connection', id: c.id, path: 'apiKey' },
        { where: 'setting', id: 'altlast.password', path: 'altlast.password' },
        { where: 'setting', id: 'altlast.feed', path: 'altlast.feed' },
      ]),
    );
    expect(found.some((f) => f.path === 'tokenExpiresAt')).toBe(false);
    const r = await migratePlaintextSecrets();
    expect(r.moved).toBe(1);
    const conn = await loadConnection(c.id);
    expect(conn.config.apiKey).toBeUndefined();
    expect(conn.config.intervalSeconds).toBe(60);
    expect((await connectionSecrets(conn)).apiKey).toBe('klartext-schluessel-123');
    expect(JSON.stringify(await many(`SELECT ciphertext FROM secrets`))).not.toContain('klartext-schluessel-123');
    await pool.query(`DELETE FROM settings WHERE key LIKE 'altlast.%'`);
    expect(await findPlaintextSecrets()).toEqual([]);
  });

  it('Adressen mit eingebetteten Zugangsdaten werden abgewiesen (Quellen, Warnfeeds)', async () => {
    expect((await admin.post('/rss/preview', { url: 'https://nutzer:geheim@feed.example.org/rss' })).status).toBe(400);
    const w = await admin.post('/connections', { kind: 'warnfeed', name: 'CAP mit Passwort', config: { format: 'cap', url: 'https://nutzer:geheim@cap.example.org/feed.xml' } });
    expect(w.status).toBe(400);
  });
});
