import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, one } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { processMedia } from '../src/media/process.js';
import { mediaPaths } from '../src/media/storage.js';

/**
 * Durchlauf von Meilenstein 1 gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL).
 * Die Datenbank wird zu Beginn komplett geleert. Die Bridge wird durch direkte API-Aufrufe ersetzt.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, opts: { body?: unknown; payload?: Buffer; headers?: Record<string, string> } = {}) {
    const json = opts.body !== undefined;
    const res = await this.app.inject({
      method: method as any,
      url: url.startsWith('/api/') || url.startsWith('/healthz') ? url : `/api/v1${url}`,
      payload: json ? JSON.stringify(opts.body) : opts.payload,
      headers: {
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-lifelink-request': '1' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(opts.headers ?? {}),
      },
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, json: body, headers: res.headers, rawPayload: res.rawPayload };
  }
  get = (u: string, headers?: Record<string, string>) => this.raw('GET', u, { headers });
  post = (u: string, b: unknown = {}, headers?: Record<string, string>) => this.raw('POST', u, { body: b, headers });
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, { body: b });
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, { body: b });
}

function multipart(file: { name: string; data: Buffer; type: string }, fields: Record<string, string> = {}) {
  const boundary = `----lifelink${crypto.randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Testfoto mit GPS-Daten im EXIF – die öffentliche Fassung darf sie nicht enthalten. */
async function photoWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Make: 'Testkamera' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 6/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '8/1 41/1 0/1' } })
    .toBuffer();
}

async function processAllQuarantine() {
  const rows = await pool.query(`SELECT id FROM media WHERE status = 'quarantine'`);
  for (const r of rows.rows) await processMedia(r.id);
}

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return { client: c, token, userId: inv.json.user.id };
}

let admin: Client;
let editor: Client;
let approver: Client;
let publisher: Client;
let anonymous: Client;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.LIFELINK_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
  anonymous = new Client(app);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Erstsetup und Anmeldung', () => {
  it('richtet Admin, Organisation, Basisadresse und Zeitzone ein', async () => {
    const st = await admin.get('/auth/state');
    expect(st.json.setupRequired).toBe(true);
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.LIFELINK_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    const setup = { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://lifelink.example.org/', timezone: 'Europe/Berlin' };
    expect((await admin.post('/auth/setup', { ...setup, token: 'falsch' })).status).toBe(403);
    expect((await admin.post('/auth/setup', { ...setup, publicUrl: 'ftp://x' })).status).toBe(400);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: setup });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await admin.post('/auth/setup', setup);
    expect(ok.status).toBe(200);
    expect(ok.json.next).toBe('mfa_setup');
    // Zweiter Setup-Versuch ist gesperrt
    expect((await new Client(app).post('/auth/setup', setup)).status).toBe(403);
    await setSettings({ 'security.require_2fa_admins': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    const me = await admin.get('/auth/me');
    expect(me.json.instance.organization).toBe('Musterorganisation');
    expect(me.json.instance.publicUrl).toBe('https://lifelink.example.org');
  });

  it('sperrt nach zu vielen Fehlversuchen', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.post('/auth/login', { email: 'admin@example.org', password: 'falsch' })).status).toBe(401);
    expect((await c.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).status).toBe(423);
    await pool.query(`UPDATE users SET locked_until = NULL, failed_logins = 0`);
  });

  it('Einladungen sind einmalig, befristet und widerrufbar', async () => {
    const r = await acceptInvite('redaktion@example.org', ['editor', 'media_manager'], 'Robin');
    editor = r.client;
    // Ein zweites Mal einlösen geht nicht
    expect((await new Client(app).post(`/auth/invite/${r.token}`, { name: 'Xaver', password: 'Noch-ein-Passwort-2026' })).status).toBe(404);
    // Widerruf
    const inv = await admin.post('/users/invite', { email: 'widerruf@example.org', roles: ['viewer'] });
    const token = inv.json.link.split('/einladung/')[1];
    expect(inv.json.link.startsWith('https://lifelink.example.org/einladung/')).toBe(true);
    expect((await admin.post(`/users/${inv.json.user.id}/revoke-link`)).json.revoked).toBe(1);
    expect((await anonymous.get(`/auth/invite/${token}`)).status).toBe(404);
    // Ablauf
    const inv2 = await admin.post('/users/invite', { email: 'ablauf@example.org', roles: ['viewer'] });
    await pool.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [inv2.json.user.id]);
    expect((await anonymous.post(`/auth/invite/${inv2.json.link.split('/einladung/')[1]}`, { name: 'Zu spät', password: 'Zu-spaet-Passwort-2026' })).status).toBe(404);
    approver = (await acceptInvite('freigabe@example.org', ['approver'], 'Kim')).client;
    publisher = (await acceptInvite('online@example.org', ['publisher'], 'Sam')).client;
  });
});

let collectionId = '';
let linkToken = '';
let linkId = '';
let mediaId = '';
let postId = '';

describe('Foto-Link und Medien', () => {
  it('„Fotos und Videos sammeln“ erstellt Sammlung und Upload-Link zum Beitrag', async () => {
    const p = await editor.post('/posts', { title: 'Übung am Wochenende', kind: 'news' });
    expect(p.status).toBe(200);
    postId = p.json.id;
    const c = await editor.post(`/posts/${postId}/collect`, {});
    expect(c.status).toBe(200);
    expect(c.json.url.startsWith('https://lifelink.example.org/u/')).toBe(true);
    collectionId = c.json.collectionId;
    linkId = c.json.linkId;
    linkToken = c.json.url.split('/u/')[1];
    const info = await anonymous.get(`/public/upload/${linkToken}`);
    expect(info.status).toBe(200);
    expect(info.json.collection.title).toBe('Übung am Wochenende');
    expect(info.json.organization).toBe('Musterorganisation');
  });

  it('nimmt ein Foto ohne Konto an, legt es in Quarantäne und prüft es', async () => {
    const mp = multipart({ name: 'IMG_0001.jpg', data: await photoWithGps(), type: 'image/jpeg' }, { clientKey: 'client-key-0001' });
    const up = await anonymous.raw('POST', `/public/upload/${linkToken}`, mp);
    expect(up.status).toBe(200);
    expect(up.json.duplicate).toBe(false);
    const m = await one<any>(`SELECT * FROM media WHERE collection_id = $1`, [collectionId]);
    mediaId = m.id;
    expect(m.status).toBe('quarantine');
    expect(fs.existsSync(mediaPaths.quarantine(m.id))).toBe(true);
    // Vor der Prüfung keine Auslieferung
    expect((await editor.get(`/media/${m.id}/preview`)).status).toBe(404);
    // Wiederholtes Senden derselben Datei (gleicher Client-Schlüssel) legt nichts doppelt an
    const again = await anonymous.raw('POST', `/public/upload/${linkToken}`, mp);
    expect(again.json.duplicate).toBe(true);
    expect((await one<any>(`SELECT count(*)::int AS n FROM media WHERE collection_id = $1`, [collectionId])).n).toBe(1);
    await processAllQuarantine();
    const ready = await one<any>(`SELECT * FROM media WHERE id = $1`, [m.id]);
    expect(ready.status).toBe('ready');
    expect(ready.had_location).toBe(true);
    expect(fs.existsSync(mediaPaths.quarantine(m.id))).toBe(false);
    const pub = await sharp(mediaPaths.publicFile(m.id, 'jpg')).metadata();
    expect(pub.exif).toBeUndefined();
    const prev = await editor.get(`/media/${m.id}/preview`);
    expect(prev.status).toBe(200);
    expect(prev.headers['content-type']).toBe('image/webp');
  });

  it('weist falsche Dateitypen nach Inhaltsprüfung ab', async () => {
    const mp = multipart({ name: 'foto.jpg', data: Buffer.from('#!/bin/sh\necho kein Bild\n'), type: 'image/jpeg' }, { clientKey: 'client-key-0002' });
    expect((await anonymous.raw('POST', `/public/upload/${linkToken}`, mp)).status).toBe(200);
    await processAllQuarantine();
    const bad = await one<any>(`SELECT * FROM media WHERE client_key = 'client-key-0002'`);
    expect(bad.status).toBe('rejected');
    expect(bad.reject_reason).toMatch(/nicht erlaubt/);
  });

  it('begrenzt die Dateigröße', async () => {
    await pool.query(`UPDATE upload_links SET max_file_bytes = 1024 WHERE id = $1`, [linkId]);
    const mp = multipart({ name: 'gross.jpg', data: await photoWithGps(), type: 'image/jpeg' }, { clientKey: 'client-key-0003' });
    expect((await anonymous.raw('POST', `/public/upload/${linkToken}`, mp)).status).toBe(413);
    await pool.query(`UPDATE upload_links SET max_file_bytes = 2147483648 WHERE id = $1`, [linkId]);
  });

  it('Sichtung: Auswahl ist ein eigener Schritt', async () => {
    expect((await editor.post('/media/selection', { ids: [mediaId], selection: 'selected' })).status).toBe(200);
    expect((await publisher.post('/media/selection', { ids: [mediaId], selection: 'skipped' })).status).toBe(403);
    const c = await editor.get(`/collections/${collectionId}`);
    expect(c.json.media.find((m: any) => m.id === mediaId).selection).toBe('selected');
  });

  it('weist direkte Zugriffe ohne Recht ab', async () => {
    expect((await anonymous.get(`/media/${mediaId}/original`)).status).toBe(401);
    expect((await anonymous.get(`/collections/${collectionId}`)).status).toBe(401);
    const viewerless = (await acceptInvite('nur-warnung@example.org', ['warning_author'], 'Mika')).client;
    expect((await viewerless.get(`/media/${mediaId}/original`)).status).toBe(403);
    expect((await viewerless.get(`/posts`)).status).toBe(403);
    expect((await editor.post(`/sites`, { name: 'Test' })).status).toBe(403);
    expect((await editor.get(`/users`)).status).toBe(403);
  });

  it('weist abgelaufene und widerrufene Upload-Links ab', async () => {
    const l2 = await editor.post(`/collections/${collectionId}/links`, { days: 1, label: 'Aushang' });
    const t2 = l2.json.url.split('/u/')[1];
    await pool.query(`UPDATE upload_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [l2.json.id]);
    expect((await anonymous.get(`/public/upload/${t2}`)).status).toBe(410);
    const mp = multipart({ name: 'spaet.jpg', data: await photoWithGps(), type: 'image/jpeg' });
    expect((await anonymous.raw('POST', `/public/upload/${t2}`, mp)).status).toBe(410);
    const l3 = await editor.post(`/collections/${collectionId}/links`, {});
    const t3 = l3.json.url.split('/u/')[1];
    expect((await anonymous.get(`/public/upload/${t3}`)).status).toBe(200);
    expect((await editor.post(`/upload-links/${l3.json.id}/revoke`)).json.state).toBe('revoked');
    const r = await anonymous.get(`/public/upload/${t3}`);
    expect(r.status).toBe(410);
    expect(r.json.error).toBe('link_revoked');
    expect((await anonymous.get(`/public/upload/unbekannt-unbekannt-1234`)).status).toBe(404);
  });
});

let siteId = '';
let bridgeKey = '';
let revision = 0;
let hash = '';

async function loadPost(c: Client = editor) {
  const p = await c.get(`/posts/${postId}`);
  revision = p.json.revision.number;
  hash = p.json.revision.content_hash;
  return p.json;
}

describe('Redaktion und Freigabe (ohne WordPress)', () => {
  it('Beitrag mit Medien speichern erzeugt eine Fassung', async () => {
    const p = await loadPost();
    const save = await editor.put(`/posts/${postId}/revision`, { baseRevision: p.revision.number, title: 'Übung am Wochenende', body: 'Am Samstag fand eine gemeinsame Übung statt.', mediaIds: [mediaId], coverId: mediaId });
    expect(save.json.changed).toBe(true);
    // Gleicher Inhalt erzeugt keine neue Fassung
    const same = await editor.put(`/posts/${postId}/revision`, { baseRevision: save.json.number, title: 'Übung am Wochenende', body: 'Am Samstag fand eine gemeinsame Übung statt.', mediaIds: [mediaId], coverId: mediaId });
    expect(same.json.changed).toBe(false);
    // Veraltete Basis wird abgewiesen
    expect((await editor.put(`/posts/${postId}/revision`, { baseRevision: 1, title: 'Veraltet', body: 'Y' })).status).toBe(409);
    await loadPost();
  });

  it('gibt intern frei – ohne Zielkanal und ohne WordPress', async () => {
    expect((await editor.post(`/posts/${postId}/submit`, { revision })).status).toBe(200);
    expect((await editor.post(`/posts/${postId}/decision`, { revision, contentHash: hash, decision: 'approved' })).status).toBe(403);
    const d = await approver.post(`/posts/${postId}/decision`, { revision, contentHash: hash, decision: 'approved', note: 'passt' });
    expect(d.status).toBe(200);
    expect((await loadPost()).state).toBe('approved');
    // Ohne Zielkanal keine Veröffentlichung, aber die Freigabe gilt intern
    expect((await publisher.post(`/posts/${postId}/publish`, { revision, contentHash: hash })).status).toBe(400);
  });

  it('jede Änderung an Text, Medien oder Zielkanal verlangt eine neue Freigabe', async () => {
    const save = await editor.put(`/posts/${postId}/revision`, { baseRevision: revision, title: 'Übung am Wochenende', body: 'Am Samstag fand eine gemeinsame Übung statt. Danke an alle!', mediaIds: [mediaId], coverId: mediaId });
    expect(save.json.approvalInvalidated).toBe(true);
    const p = await loadPost();
    expect(p.state).toBe('draft');
    // Alte Freigabe passt nicht zur neuen Fassung
    expect((await publisher.post(`/posts/${postId}/publish`, { revision, contentHash: hash })).status).toBe(409);
  });
});

describe('LifeLink Bridge und WordPress-Veröffentlichung', () => {
  it('stellt die Bridge als ZIP bereit', async () => {
    const z = await admin.get('/sites/plugin.zip');
    expect(z.status).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    expect(z.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('koppelt per einmaligem Code', async () => {
    const s = await admin.post('/sites', { name: 'Testwebsite' });
    expect(s.status).toBe(200);
    siteId = s.json.site.id;
    const code = s.json.pairingCode;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await anonymous.post('/bridge/pair', { code: 'AAAA-BBBB', site_url: 'https://wp.example.org' })).status).toBe(401);
    const pair = await anonymous.post('/bridge/pair', { code: code.toLowerCase(), site_url: 'https://wp.example.org/', wp_version: '6.9', plugin_version: '1.0.0' });
    expect(pair.status).toBe(200);
    bridgeKey = pair.json.key;
    expect(bridgeKey.startsWith('llb_')).toBe(true);
    // Code ist verbraucht
    expect((await anonymous.post('/bridge/pair', { code, site_url: 'https://wp.example.org' })).status).toBe(401);
    expect((await anonymous.get('/bridge/status', { authorization: `Bearer ${bridgeKey}` })).json.site_name).toBe('Testwebsite');
    expect((await anonymous.get('/bridge/status', { authorization: 'Bearer llb_xxxxxxxxxxxx_falschfalschfalschfalsch' })).status).toBe(401);
  });

  it('veröffentlicht genau einmal und zeigt die bestätigte URL', async () => {
    // Zielkanal wählen → neue Fassung → erneute Freigabe
    await editor.put(`/posts/${postId}/revision`, { baseRevision: revision, title: 'Übung am Wochenende', body: 'Am Samstag fand eine gemeinsame Übung statt. Danke an alle!', mediaIds: [mediaId], coverId: mediaId, siteId });
    await loadPost();
    await editor.post(`/posts/${postId}/submit`, { revision });
    expect((await publisher.post(`/posts/${postId}/publish`, { revision, contentHash: hash })).status).toBe(409);
    await approver.post(`/posts/${postId}/decision`, { revision, contentHash: hash, decision: 'approved' });
    const pub = await publisher.post(`/posts/${postId}/publish`, { revision, contentHash: hash });
    expect(pub.status).toBe(200);
    // Doppelter Klick erzeugt keinen zweiten Auftrag
    const pub2 = await publisher.post(`/posts/${postId}/publish`, { revision, contentHash: hash });
    expect(pub2.json.duplicate).toBe(true);
    expect(pub2.json.id).toBe(pub.json.id);

    const auth = { authorization: `Bearer ${bridgeKey}` };
    const jobs = await anonymous.get('/bridge/jobs', auth);
    expect(jobs.json.jobs).toHaveLength(1);
    const job = jobs.json.jobs[0];
    expect(job.post.title).toBe('Übung am Wochenende');
    expect(job.media).toHaveLength(1);
    expect(job.media[0].path).toMatch(/^\/api\/v1\/bridge\/media\//);
    // Medien der Bridge: öffentliche Fassung ohne EXIF
    const media = await anonymous.get(job.media[0].url.replace('https://lifelink.example.org', ''), auth);
    expect(media.status).toBe(200);
    expect((await sharp(media.rawPayload).metadata()).exif).toBeUndefined();
    // Sofortiges erneutes Abholen liefert den Auftrag nicht doppelt aus
    expect((await anonymous.get('/bridge/jobs', auth)).json.jobs).toHaveLength(0);
    // Nach Ablauf der Wiederauslieferungsfrist kommt er erneut (Bridge arbeitet idempotent)
    await pool.query(`UPDATE publications SET fetched_at = now() - interval '5 minutes' WHERE id = $1`, [job.id]);
    expect((await anonymous.get('/bridge/jobs', auth)).json.jobs[0].id).toBe(job.id);

    const result = { status: 'published', remote_id: 42, url: 'https://wp.example.org/2026/11/uebung-am-wochenende/' };
    expect((await anonymous.post(`/bridge/jobs/${job.id}/result`, result, auth)).status).toBe(200);
    // Doppelte Bestätigung ändert nichts
    const dup = await anonymous.post(`/bridge/jobs/${job.id}/result`, result, auth);
    expect(dup.json.duplicate).toBe(true);
    const p = await loadPost(publisher);
    expect(p.state).toBe('published');
    expect(p.publications).toHaveLength(1);
    expect(p.publications[0].remote_url).toBe(result.url);
    const dash = await publisher.get('/dashboard');
    expect(dash.json.publications[0].remote_url).toBe(result.url);
    expect((await anonymous.get('/bridge/jobs', auth)).json.jobs).toHaveLength(0);
  });

  it('widerrufene Kopplung wird abgewiesen', async () => {
    expect((await admin.post(`/sites/${siteId}/revoke`)).json.status).toBe('revoked');
    expect((await anonymous.get('/bridge/jobs', { authorization: `Bearer ${bridgeKey}` })).status).toBe(401);
  });
});

describe('Betrieb', () => {
  it('protokolliert Rollen, Freigaben und Veröffentlichungen mit Person und Zeitpunkt', async () => {
    const r = await pool.query(`SELECT action, actor_name, at FROM audit_events ORDER BY id`);
    const actions = r.rows.map((x: any) => x.action);
    for (const a of ['user.invited', 'post.approved', 'publication.requested', 'publication.confirmed', 'upload_link.revoked', 'site.paired', 'site.revoked']) expect(actions).toContain(a);
    const approved = r.rows.find((x: any) => x.action === 'post.approved');
    expect(approved.actor_name).toBe('Kim');
    expect(approved.at).toBeInstanceOf(Date);
  });

  it('Healthcheck meldet fehlenden Worker als nicht bereit', async () => {
    const h = await anonymous.get('/healthz');
    expect(h.status).toBe(503);
    expect(h.json.checks.database.ok).toBe(true);
    expect(h.json.checks.schema.ok).toBe(true);
    expect(h.json.checks.worker.ok).toBe(false);
    await pool.query(`INSERT INTO worker_heartbeats (worker_id, started_at, last_seen_at, version) VALUES ('test', now(), now(), 'test')`);
    expect((await anonymous.get('/healthz')).status).toBe(200);
  });
});

describe('Fortsetzbarer Upload (M2)', () => {
  const video = () => fs.readFileSync(process.env.TEST_VIDEO ?? '/tmp/claude-0/test.mp4');
  const put = (c: Client, url: string, data: Buffer) => c.raw('PUT', url, { payload: data, headers: { 'content-type': 'application/octet-stream' } });

  it('setzt einen unterbrochenen Video-Upload fort und legt nichts doppelt an', async () => {
    const data = video();
    const link = await editor.post(`/collections/${collectionId}/links`, { days: 1 });
    const token = link.json.url.split('/u/')[1];
    const base = `/public/upload/${token}/sessions`;
    const s = await anonymous.post(base, { clientKey: 'video-key-0001', name: 'einsatz.mp4', size: data.length, type: 'video/mp4' });
    expect(s.status).toBe(200);
    expect(s.json.received).toBe(0);
    const chunk = 30_000;
    // Erster Teil kommt an
    expect((await put(anonymous, `${base}/${s.json.id}?offset=0`, data.subarray(0, chunk))).json.received).toBe(chunk);
    // Verbindungsabbruch mitten im zweiten Teil: nur ein Stück wurde geschrieben
    fs.appendFileSync(path.join(process.env.LIFELINK_DATA_DIR!, 'media', 'tmp', `upload-${s.json.id}.part`), data.subarray(chunk, chunk + 5_000));
    // Client wiederholt mit altem Stand → 409 mit tatsächlichem Stand
    const wrong = await put(anonymous, `${base}/${s.json.id}?offset=${chunk}`, data.subarray(chunk, chunk * 2));
    expect(wrong.status).toBe(409);
    expect(wrong.json.details.received).toBe(chunk + 5_000);
    // Neu verbinden: Stand abfragen und ab dort weitersenden
    const st = await anonymous.get(`${base}/${s.json.id}`);
    let offset = st.json.received;
    expect(offset).toBe(chunk + 5_000);
    // Gleiche Datei erneut anmelden (z. B. Seite neu geladen) → dieselbe Sitzung
    const again = await anonymous.post(base, { clientKey: 'video-key-0001', name: 'einsatz.mp4', size: data.length, type: 'video/mp4' });
    expect(again.json.id).toBe(s.json.id);
    expect(again.json.received).toBe(offset);
    let last: any;
    while (offset < data.length) {
      last = await put(anonymous, `${base}/${s.json.id}?offset=${offset}`, data.subarray(offset, offset + chunk));
      expect(last.status).toBe(200);
      offset = last.json.received;
    }
    expect(last.json.complete).toBe(true);
    // Nach Abschluss: erneutes Anmelden meldet Duplikat
    const dup = await anonymous.post(base, { clientKey: 'video-key-0001', name: 'einsatz.mp4', size: data.length, type: 'video/mp4' });
    expect(dup.json.duplicate).toBe(true);
    const rows = await pool.query(`SELECT * FROM media WHERE client_key = 'video-key-0001'`);
    expect(rows.rowCount).toBe(1);
    const m = rows.rows[0];
    expect(m.sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'));
    await processMedia(m.id);
    const ready = await one<any>(`SELECT * FROM media WHERE id = $1`, [m.id]);
    expect(ready.status).toBe('ready');
    expect(ready.kind).toBe('video');
    expect(ready.had_location).toBe(true);
    expect(ready.has_preview).toBe(true);
    expect(ready.has_public).toBe(true);
    // Öffentliche Fassung ohne Standort-Metadaten
    const { execFileSync } = await import('node:child_process');
    const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path.join(process.env.LIFELINK_DATA_DIR!, 'media', 'public', `${m.id}.mp4`)]).toString();
    expect(tags).not.toContain('location');
  });

  it('weist zu große Dateien und falsche Teile ab', async () => {
    await pool.query(`UPDATE upload_links SET max_file_bytes = 1000 WHERE collection_id = $1 AND revoked_at IS NULL`, [collectionId]);
    const link = await one<any>(`SELECT token_enc, id FROM upload_links WHERE collection_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [collectionId]);
    const { decrypt } = await import('../src/lib/crypto.js');
    const token = decrypt(link.token_enc, `upload-link:${link.id}`);
    const r = await anonymous.post(`/public/upload/${token}/sessions`, { clientKey: 'gross-key-0001', name: 'gross.mp4', size: 5_000_000 });
    expect(r.status).toBe(413);
  });

  it('interner Upload in Teilen über die Sammlung', async () => {
    const data = video();
    const s = await editor.post(`/collections/${collectionId}/upload-sessions`, { clientKey: 'intern-key-0001', name: 'intern.mp4', size: data.length });
    const done = await put(editor, `/collections/${collectionId}/upload-sessions/${s.json.id}?offset=0`, data);
    expect(done.json.complete).toBe(true);
    expect((await anonymous.post(`/collections/${collectionId}/upload-sessions`, { clientKey: 'x-key-00001', name: 'x', size: 1 })).status).toBe(401);
  });
});
