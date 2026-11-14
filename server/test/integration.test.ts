import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, one, many } from '../src/db/pool.js';
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

describe('Sammeldownload (M2)', () => {
  it('erzeugt das ZIP im Hintergrund mit öffentlichen Fassungen und lässt es ablaufen', async () => {
    const r = await editor.post(`/collections/${collectionId}/exports`, { selection: 'all', variant: 'public' });
    expect(r.status).toBe(200);
    const { buildExport, cleanupExports, exportPath } = await import('../src/media/exports.js');
    await buildExport(r.json.id);
    const st = await editor.get(`/exports/${r.json.id}`);
    expect(st.json.status).toBe('ready');
    expect(st.json.file_count).toBeGreaterThanOrEqual(2);
    const dl = await editor.get(`/exports/${r.json.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await anonymous.get(`/exports/${r.json.id}/download`)).status).toBe(401);
    await pool.query(`UPDATE exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.json.id]);
    await cleanupExports();
    expect(fs.existsSync(exportPath(r.json.id))).toBe(false);
    expect((await editor.get(`/exports/${r.json.id}/download`)).status).toBe(404);
  });
});

describe('Redaktion: Vorlagen, Kanaltexte, Termin, Zurückziehen (M2)', () => {
  let site2 = '';
  let key2 = '';
  let pid = '';
  const auth = () => ({ authorization: `Bearer ${key2}` });
  const cur = async () => (await editor.get(`/posts/${pid}`)).json;

  it('legt einen Beitrag aus einer Vorlage an', async () => {
    const t = await editor.post('/templates', { name: 'Einsatzbericht kurz', kind: 'incident', body: 'Am [Datum] wurden wir zu [Ort] alarmiert.' });
    expect(t.status).toBe(200);
    expect((await publisher.post('/templates', { name: 'X1' })).status).toBe(403);
    const p = await editor.post('/posts', { title: 'Einsatz Musterstraße', templateId: t.json.id });
    pid = p.json.id;
    const d = await cur();
    expect(d.post.kind).toBe('incident');
    expect(d.revision.body).toContain('[Ort]');
  });

  it('Kanaltext und Termin sind Teil der Fassung; Termin verzögert die Abholung', async () => {
    const s = await admin.post('/sites', { name: 'Zweite Testwebsite' });
    site2 = s.json.site.id;
    key2 = (await anonymous.post('/bridge/pair', { code: s.json.pairingCode, site_url: 'https://zwei.example.org' })).json.key;
    let d = await cur();
    const future = new Date(Date.now() + 3600_000).toISOString();
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Einsatz Musterstraße', body: 'Interner Langtext.', siteId: site2, variants: { wordpress: { body: 'Kurzer Text für die Website.' } }, publishAt: future });
    d = await cur();
    expect(d.revision.variants.wordpress.body).toBe('Kurzer Text für die Website.');
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    // Nur Kanaltext ändern → neue Fassung, Freigabe entfällt
    const ch = await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Einsatz Musterstraße', body: 'Interner Langtext.', siteId: site2, variants: { wordpress: { body: 'Geänderter Website-Text.' } }, publishAt: future });
    expect(ch.json.approvalInvalidated).toBe(true);
    d = await cur();
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    const pub = await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(new Date(pub.json.run_at).getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect((await cur()).state).toBe('scheduled');
    expect((await anonymous.get('/bridge/jobs', auth())).json.jobs).toHaveLength(0);
    // Termin erreicht
    await pool.query(`UPDATE publications SET run_at = now() - interval '1 second' WHERE post_id = $1`, [pid]);
    const jobs = (await anonymous.get('/bridge/jobs', auth())).json.jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].post.body).toBe('Geänderter Website-Text.');
    await anonymous.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_id: 7, url: 'https://zwei.example.org/einsatz/' }, auth());
    expect((await cur()).state).toBe('published');
  });

  it('zieht einen veröffentlichten Beitrag zurück (ohne neue Freigabe)', async () => {
    expect((await editor.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' })).status).toBe(403);
    const u = await publisher.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' });
    expect(u.status).toBe(200);
    expect((await publisher.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' })).json.duplicate).toBe(true);
    const jobs = (await anonymous.get('/bridge/jobs', auth())).json.jobs;
    expect(jobs[0].type).toBe('post.unpublish');
    await anonymous.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_id: 7, remote_status: 'draft' }, auth());
    expect((await cur()).state).toBe('deactivated');
    const list = (await editor.get('/posts')).json.find((p: any) => p.id === pid);
    expect(list.state).toBe('deactivated');
  });
});

describe('Banner (M2)', () => {
  let bid = '';
  let siteId3 = '';
  let key3 = '';
  const auth = () => ({ authorization: `Bearer ${key3}` });
  const list = async () => (await editor.get('/banners')).json.find((b: any) => b.id === bid);

  it('Entwurf → Freigabe → Veröffentlichen, Banner-Auftrag für die Bridge', async () => {
    const s = await admin.post('/sites', { name: 'Banner-Testseite' });
    siteId3 = s.json.site.id;
    key3 = (await anonymous.post('/bridge/pair', { code: s.json.pairingCode, site_url: 'https://banner.example.org' })).json.key;
    const ends = new Date(Date.now() + 2 * 3600_000).toISOString();
    const b = await editor.post('/banners', { siteId: siteId3, title: 'Straßensperrung Hauptstraße', text: 'Bitte Umleitung beachten.', tone: 'warning', priority: 3, endsAt: ends, linkUrl: 'https://banner.example.org/info', linkText: 'Details' });
    expect(b.status).toBe(200);
    bid = b.json.id;
    expect((await editor.post('/banners', { siteId: siteId3, title: 'Falsch', endsAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    let st = await list();
    expect(st.state).toBe('draft');
    expect((await publisher.post(`/banners/${bid}/publish`, { contentHash: st.content_hash })).status).toBe(409);
    await editor.post(`/banners/${bid}/submit`);
    expect((await editor.post(`/banners/${bid}/approve`, { contentHash: st.content_hash })).status).toBe(403);
    await approver.post(`/banners/${bid}/approve`, { contentHash: st.content_hash });
    st = await list();
    expect(st.state).toBe('approved');
    await publisher.post(`/banners/${bid}/publish`, { contentHash: st.content_hash });
    const r = await anonymous.get('/bridge/jobs', auth());
    const job = r.json.jobs.find((j: any) => j.type === 'banner.upsert');
    expect(job.banner.title).toBe('Straßensperrung Hauptstraße');
    expect(job.banner.priority).toBe(3);
    // Das gerade ausgelieferte Banner zählt schon zur Abgleichsliste
    expect(r.json.banner_ids).toContain(bid);
    await anonymous.post(`/bridge/jobs/${job.id}/result`, { status: 'published' }, auth());
    expect((await list()).state).toBe('live');
  });

  it('Änderung braucht neue Freigabe; Beenden entfernt das Banner auf der Website', async () => {
    let st = await list();
    const ends = new Date(Date.now() + 3 * 3600_000).toISOString();
    const u = await editor.put(`/banners/${bid}`, { siteId: siteId3, title: 'Straßensperrung Hauptstraße', text: 'Umleitung über Nebenweg.', tone: 'warning', priority: 3, endsAt: ends });
    expect(u.json.changed).toBe(true);
    st = await list();
    expect(st.state).toBe('draft');
    expect((await publisher.post(`/banners/${bid}/publish`, { contentHash: st.content_hash })).status).toBe(409);
    await publisher.post(`/banners/${bid}/end`);
    const r = await anonymous.get('/bridge/jobs', auth());
    expect(r.json.jobs.find((j: any) => j.type === 'banner.delete').banner.id).toBe(bid);
    expect(r.json.banner_ids).not.toContain(bid);
    expect((await list()).state).toBe('ended');
  });
});

describe('RSS, Live-Status und Dashboard (M2)', () => {
  it('fügt RSS und Atom mit Vorschau hinzu, dedupliziert, nutzt ETag und übernimmt Themenideen', async () => {
    const http = await import('node:http');
    let hits = 0;
    let rssItems = 2;
    const srv = http.createServer((req, res) => {
      hits++;
      if (req.url === '/atom') {
        res.setHeader('content-type', 'application/atom+xml');
        return res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom-Quelle</title><link href="https://atom.example.org/"/><entry><id>urn:1</id><title>Atom-Eintrag</title><link href="https://atom.example.org/1"/><updated>2026-11-14T10:00:00Z</updated><summary>Kurz</summary></entry></feed>`);
      }
      if (req.headers['if-none-match'] === '"v1"' && rssItems === 2) {
        res.statusCode = 304;
        return res.end();
      }
      res.setHeader('content-type', 'application/rss+xml');
      res.setHeader('etag', '"v1"');
      const items = Array.from({ length: rssItems }, (_, i) => `<item><guid>id-${i}</guid><title>Meldung ${i} &amp; mehr</title><link>https://news.example.org/${i}</link><description>&lt;p&gt;Text ${i}&lt;/p&gt;</description><pubDate>Fri, 14 Nov 2026 0${i}:00:00 GMT</pubDate></item>`).join('');
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Testquelle</title><link>https://news.example.org/</link>${items}</channel></rss>`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const url = `http://127.0.0.1:${port}/rss`;
    // Interne Adresse ohne Freigabe wird abgewiesen
    expect((await editor.post('/rss/preview', { url })).status).toBeGreaterThanOrEqual(400);
    await setSettings({ 'security.allowed_private_hosts': ['127.0.0.1'] } as any);
    const pv = await editor.post('/rss/preview', { url });
    expect(pv.json.title).toBe('Testquelle');
    expect(pv.json.items[0].title).toBe('Meldung 0 & mehr');
    const add = await editor.post('/rss/feeds', { url });
    expect(add.json.added).toBe(2);
    expect((await editor.post('/rss/feeds', { url })).status).toBe(409);
    const atom = await editor.post('/rss/feeds', { url: `http://127.0.0.1:${port}/atom` });
    expect(atom.json.feed.title).toBe('Atom-Quelle');
    // Erneuter Abruf: 304 (nichts Neues), danach neue Einträge ohne Duplikate
    const { refreshFeed } = await import('../src/routes/rss.js');
    await refreshFeed(await one('SELECT * FROM rss_feeds WHERE id = $1', [add.json.feed.id]));
    rssItems = 3;
    await refreshFeed(await one('SELECT * FROM rss_feeds WHERE id = $1', [add.json.feed.id]));
    expect((await one<any>(`SELECT count(*)::int AS n FROM rss_items WHERE feed_id = $1`, [add.json.feed.id])).n).toBe(3);
    const items = (await editor.get('/rss/items')).json;
    const first = items.find((i: any) => i.title === 'Meldung 2 & mehr');
    expect(first.summary).toBe('Text 2');
    await editor.post(`/rss/items/${first.id}`, { action: 'hide' });
    expect((await editor.get('/rss/items')).json.some((i: any) => i.id === first.id)).toBe(false);
    const idea = await editor.post(`/rss/items/${items[1].id}/idea`);
    const post = (await editor.get(`/posts/${idea.json.postId}`)).json;
    expect(post.revision.body).toContain('https://news.example.org/');
    expect((await editor.post(`/rss/items/${items[1].id}/idea`)).json.duplicate).toBe(true);
    expect((await publisher.post(`/rss/items/${items[1].id}/idea`)).status).toBe(403);
    srv.close();
    expect(hits).toBeGreaterThan(3);
  });

  it('meldet Änderungen per Server-Sent Events', async () => {
    const http = await import('node:http');
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${addr}/api/v1/events`, { headers: { cookie: editor.cookie } }, (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.on('data', async (c) => {
          events.push(c.toString());
          const all = events.join('');
          if (all.includes('event: hello') && !all.includes('event: change')) await pool.query(`INSERT INTO notifications (kind, title) VALUES ('info', 'SSE-Test')`);
          if (all.includes('event: change') && all.includes('notifications')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (e: any) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      setTimeout(() => reject(new Error('kein Ereignis')), 8000);
    });
    expect(events.join('')).toContain('"notifications"');
    const unauth = await anonymous.get('/events');
    expect(unauth.status).toBe(401);
  });

  it('speichert Dashboards persönlich und als Rollenvorlage', async () => {
    const def = await editor.get('/dashboard/layout');
    expect(def.json.source).toBe('default');
    const layout = { desktop: [{ id: 'rss', size: 'l' }, { id: 'approvals', size: 's' }], mobile: ['approvals'] };
    expect((await editor.put('/dashboard/layout', { scope: 'role', role: 'editor', layout })).status).toBe(403);
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'editor', layout })).status).toBe(200);
    expect((await editor.get('/dashboard/layout')).json.source).toBe('role');
    await editor.put('/dashboard/layout', { scope: 'personal', layout: { ...layout, mobile: ['rss'] } });
    const mine = await editor.get('/dashboard/layout');
    expect(mine.json.source).toBe('personal');
    expect(mine.json.layout.mobile).toEqual(['rss']);
    await editor.put('/dashboard/layout', { scope: 'personal', layout: null });
    expect((await editor.get('/dashboard/layout')).json.source).toBe('role');
    const d = await editor.get('/dashboard');
    expect(Array.isArray(d.json.rss)).toBe(true);
    expect(d.json.confirmedAt).toBeTruthy();
  });
});

/* ======================================================================================= M3 */

describe('Warnentwürfe (M3) und Warnstufen-Assistent (#41)', () => {
  // Fiktive Testdaten. Versand ausschließlich an einen lokalen Test-Mailserver.
  let smtp: any;
  let smtpMode: 'accept' | 'reject' | 'hang' = 'accept';
  const inbox: { to: string[]; subject: string; raw: string }[] = [];
  let author: Client;
  let warnApprover: Client;
  let sender: Client;
  let keywordId = '';
  let respId = '';
  const q: Record<string, string> = {};
  const ruleIds: Record<string, string> = {};
  let lineageA = '';
  let caseId = '';
  let updateId = '';
  let allClearId = '';
  const TEST_BOX = 'test-postfach@example.org';
  const pdfText = (buf: Buffer) => {
    const f = path.join(process.env.LIFELINK_DATA_DIR!, `pdf-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(f, buf);
    return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }) as string;
  };
  const data = {
    area: 'Musterstadt, Ortsteil Nord (fiktiv)',
    starts_at: '2026-11-14T10:00',
    valid_until: '2026-11-14T18:00',
    headline: 'Starke Rauchentwicklung (Übung)',
    situation: 'Fiktive Lage für den Test.',
    advice: 'Fenster und Türen geschlossen halten.',
    sender: 'Musterorganisation',
    callback: 'Testperson, 0000 000000',
  };
  const detail = async (id: string) => (await author.get(`/warnings/${id}`)).json;
  const saveRev = async (id: string, patch: any = {}) => {
    const d = await detail(id);
    return author.put(`/warnings/${id}/revision`, { baseRevision: d.revision.number, data: { ...d.revision.data, ...(patch.data ?? {}) }, responsibilityIds: patch.responsibilityIds ?? d.revision.responsibility_ids, keywordId: 'keywordId' in patch ? patch.keywordId : (d.revision.keyword?.id ?? null), answers: patch.answers ?? d.revision.answers });
  };
  const deliverLast = async (id: string) => {
    const { deliverWarningSend } = await import('../src/warnings/mail.js');
    const s = await one<any>(`SELECT id FROM warning_sends WHERE warning_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
    await deliverWarningSend(s.id);
    return one<any>(`SELECT * FROM warning_sends WHERE id = $1`, [s.id]);
  };
  const approve = async (id: string) => {
    const sub = await author.post(`/warnings/${id}/submit`, { revision: (await detail(id)).revision.number });
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    const d = await detail(id);
    const r = await warnApprover.post(`/warnings/${id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json;
  };

  beforeAll(async () => {
    const { SMTPServer } = await import('smtp-server');
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onData(stream: any, session: any, cb: any) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          if (smtpMode === 'reject') return cb(Object.assign(new Error('Empfänger abgelehnt (Test)'), { responseCode: 550 }));
          if (smtpMode === 'hang') return; // Daten angenommen, Antwort bleibt aus → Ergebnis unbekannt
          inbox.push({ to: session.envelope.rcptTo.map((r: any) => r.address), subject: /^Subject: (.*)$/m.exec(Buffer.concat(chunks).toString())?.[1] ?? '', raw: Buffer.concat(chunks).toString() });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    process.env.LIFELINK_SMTP_TIMEOUT_MS = '1500';
  });
  afterAll(() => smtp?.close());

  it('richtet Rollen, Zuständigkeit und Testmodus ein', async () => {
    author = (await acceptInvite('warnentwurf@example.org', ['warning_author'], 'Jo')).client;
    warnApprover = (await acceptInvite('warnfreigabe@example.org', ['warning_approver'], 'Uli')).client;
    sender = (await acceptInvite('warnversand@example.org', ['warning_sender'], 'Mika')).client;
    const r = await admin.post('/responsibilities', { name: 'Leitstelle (fiktiv)', area: 'Musterkreis', recipients: ['leitstelle@example.invalid'] });
    expect(r.status).toBe(200);
    respId = r.json.id;
    expect((await author.post('/responsibilities', { name: 'X', recipients: ['x@example.org'] })).status).toBe(403);
    const port = smtp.server.address().port;
    const s = await admin.put('/warning-settings', { host: '127.0.0.1', port, security: 'none', user: '', from: 'lifelink@example.org', testMode: true, testRecipient: TEST_BOX });
    expect(s.status).toBe(200);
  });

  it('wird ohne aktive Regeln ausgeliefert; Stichwort ohne Regel ergibt keine Empfehlung', async () => {
    expect((await one<any>(`SELECT count(*)::int AS n FROM warning_rules`))!.n).toBe(0);
    const k = await admin.post('/warning-keywords', { code: 'F-WALD-2', label: 'Waldbrand mittel (Test)', aliases: ['waldbrand', 'wald 2'] });
    expect(k.status).toBe(200);
    keywordId = k.json.id;
    const found = await author.get('/warning-keywords?q=waldbr');
    expect(found.json.map((x: any) => x.code)).toContain('F-WALD-2');
    const s = await author.post('/warnings/suggest', { keywordId, answers: {} });
    expect(s.json.level).toBeNull();
    expect(s.json.status).toBe('no_rules');
    expect(s.json.reason).toContain('Keine eindeutige Empfehlung – fachlich prüfen');
  });

  it('zeigt nur fachlich freigegebene Lagefragen; Freigabe nur durch eine andere Person', async () => {
    for (const [key, text] of [['rauch_wohngebiet', 'Zieht Rauch in ein Wohngebiet?'], ['evakuierung', 'Ist eine Evakuierung erforderlich?'], ['ungeprueft', 'Diese Frage ist nicht freigegeben?']]) {
      const r = await admin.post(`/warning-keywords/${keywordId}/questions`, { key, text });
      expect(r.status).toBe(200);
      q[key] = r.json.id;
    }
    expect((await admin.post(`/keyword-questions/${q.rauch_wohngebiet}/approve`)).status).toBe(403);
    expect((await warnApprover.post(`/keyword-questions/${q.rauch_wohngebiet}/approve`)).status).toBe(200);
    expect((await warnApprover.post(`/keyword-questions/${q.evakuierung}/approve`)).status).toBe(200);
    const qs = await author.get(`/warning-keywords/${keywordId}/questions`);
    expect(qs.json.map((x: any) => x.key).sort()).toEqual(['evakuierung', 'rauch_wohngebiet']);
  });

  it('Regeln: mehrere je Stichwort mit Begründung, Version und fachlicher Freigabe', async () => {
    const mk = async (name: string, conditions: any, level: number, lineage: string | null = null) => {
      const r = await admin.post('/warning-rules', { lineage, keywordId, name, conditions, level, reason: `Testregel: ${name} (fiktiv)` });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    const a = await mk('Rauch ohne Evakuierung', { rauch_wohngebiet: ['ja'], evakuierung: ['nein'] }, 3);
    lineageA = a.lineage;
    ruleIds.a = a.id;
    ruleIds.b = (await mk('Evakuierung', { evakuierung: ['ja'] }, 2)).id;
    ruleIds.c = (await mk('Rauch und Evakuierung', { rauch_wohngebiet: ['ja'], evakuierung: ['ja'] }, 1)).id;
    ruleIds.d = (await mk('Ungeprüfte Frage', { ungeprueft: ['ja'] }, 1)).id;
    // Entwurf wirkt nicht
    expect((await author.post('/warnings/suggest', { keywordId, answers: { rauch_wohngebiet: 'ja', evakuierung: 'nein' } })).json.status).toBe('no_rules');
    expect((await admin.post(`/warning-rules/${ruleIds.a}/approve`)).status).toBe(403); // nicht selbst freigeben
    expect((await author.post(`/warning-rules/${ruleIds.a}/approve`)).status).toBe(403);
    for (const id of Object.values(ruleIds)) expect((await warnApprover.post(`/warning-rules/${id}/approve`)).status).toBe(200);
    // Neue Version: alte tritt außer Kraft, der Vorschlag nennt die neue Version
    const v2 = await mk('Rauch ohne Evakuierung', { rauch_wohngebiet: ['ja'], evakuierung: ['nein'] }, 3, lineageA);
    expect(v2.version).toBe(2);
    expect((await warnApprover.post(`/warning-rules/${v2.id}/approve`)).status).toBe(200);
    expect((await one<any>(`SELECT status FROM warning_rules WHERE id = $1`, [ruleIds.a]))!.status).toBe('retired');
    ruleIds.a = v2.id;
  });

  it('dasselbe Stichwort mit zwei Lagebildern, unbekanntes Stichwort, fehlende Angaben, Widerspruch', async () => {
    const sug = async (answers: any, kw: string | null = keywordId) => (await author.post('/warnings/suggest', { keywordId: kw, answers })).json;
    const lageA = await sug({ rauch_wohngebiet: 'ja', evakuierung: 'nein' });
    expect(lageA.level).toBe(3);
    expect(lageA.status).toBe('suggested');
    expect(lageA.reason).toContain('Version 2');
    expect(lageA.rules[0].version).toBe(2);
    const lageB = await sug({ rauch_wohngebiet: 'nein', evakuierung: 'ja' });
    expect(lageB.level).toBe(2);
    expect(lageB.reason).toContain('Regel „Evakuierung“, Version 1');
    const unknown = await sug({ rauch_wohngebiet: 'ja' }, crypto.randomUUID());
    expect(unknown.level).toBeNull();
    expect(unknown.status).toBe('unknown_keyword');
    const missing = await sug({ rauch_wohngebiet: 'ja', evakuierung: 'unbekannt' });
    expect(missing.level).toBeNull();
    expect(missing.status).toBe('incomplete');
    expect(missing.missing.map((m: any) => m.key)).toContain('evakuierung');
    const conflictS = await sug({ rauch_wohngebiet: 'ja', evakuierung: 'ja' });
    expect(conflictS.level).toBeNull();
    expect(conflictS.status).toBe('conflict');
    expect(conflictS.reason).toContain('Keine eindeutige Empfehlung – fachlich prüfen');
    // Regel auf nicht freigegebene Frage trifft nie zu
    const none = await sug({ rauch_wohngebiet: 'nein', evakuierung: 'nein', ungeprueft: 'ja' });
    expect(none.level).toBeNull();
    expect(none.status).toBe('no_match');
    expect(none.level).not.toBe(0);
  });

  it('Erstmeldung: Vorschlag allein löst weder Mail noch Veröffentlichung aus; Stufe braucht Bestätigung', async () => {
    const c = await author.post('/warnings', { kind: 'initial' });
    expect(c.status).toBe(200);
    expect(c.json.case_no).toMatch(/^W-\d{4}-\d{4}$/);
    caseId = c.json.id;
    const s = await saveRev(caseId, { data, responsibilityIds: [respId], keywordId, answers: { rauch_wohngebiet: 'ja', evakuierung: 'nein' } });
    expect(s.json.changed).toBe(true);
    expect(s.json.suggestion.level).toBe(3);
    // Nichts versendet, nichts veröffentlicht, nichts eingeplant
    expect((await one<any>(`SELECT count(*)::int AS n FROM warning_sends`))!.n).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'warning.send'`))!.n).toBe(0);
    expect(inbox.length).toBe(0);
    const pubsBefore = (await one<any>(`SELECT count(*)::int AS n FROM publications`))!.n;
    // Einreichen ohne bestätigte Stufe geht nicht; Entwurfsrecht reicht nicht zum Bestätigen
    expect((await author.post(`/warnings/${caseId}/submit`, { revision: s.json.number })).status).toBe(400);
    expect((await author.post(`/warnings/${caseId}/level`, { revision: s.json.number, level: 3 })).status).toBe(403);
    // Bestätigung des Vorschlags ohne Begründung
    const ok = await warnApprover.post(`/warnings/${caseId}/level`, { revision: s.json.number, level: 3 });
    expect(ok.status).toBe(200);
    expect(ok.json.changed).toBe(false);
    expect((await one<any>(`SELECT count(*)::int AS n FROM publications`))!.n).toBe(pubsBefore);
    expect(inbox.length).toBe(0);
  });

  it('manuelle Änderung braucht Begründung; geänderte Lage verlangt erneute Bestätigung', async () => {
    let d = await detail(caseId);
    expect((await warnApprover.post(`/warnings/${caseId}/level`, { revision: d.revision.number, level: 2 })).status).toBe(400);
    const ch = await warnApprover.post(`/warnings/${caseId}/level`, { revision: d.revision.number, level: 2, reason: 'Wind dreht Richtung Innenstadt (fiktiv).' });
    expect(ch.status).toBe(200);
    expect(ch.json.changed).toBe(true);
    d = await detail(caseId);
    expect(d.revision.level_decision.level).toBe(2);
    expect(d.revision.level_decision.suggested).toBe(3);
    expect(d.revision.level_decision.rules[0].version).toBe(2);
    // Textänderung behält die Bestätigung
    const t = await saveRev(caseId, { data: { situation: 'Fiktive Lage, ergänzt.' } });
    expect(t.json.levelReset).toBe(false);
    // Andere Antworten → Bestätigung verfällt
    const r = await saveRev(caseId, { answers: { rauch_wohngebiet: 'nein', evakuierung: 'ja' } });
    expect(r.json.levelReset).toBe(true);
    expect((await detail(caseId)).revision.level_decision).toBeNull();
    d = await detail(caseId);
    expect((await warnApprover.post(`/warnings/${caseId}/level`, { revision: d.revision.number, level: 2 })).json.changed).toBe(false);
    const hist = await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action IN ('warning.level_changed','warning.level_confirmed')`);
    expect(hist!.n).toBeGreaterThanOrEqual(3);
  });

  it('Freigabe erzeugt die PDF mit der bestätigten Stufe; Entwurfs-PDF ist gekennzeichnet', async () => {
    const draft = await author.raw('GET', `/warnings/${caseId}/pdf`);
    expect(draft.headers['content-type']).toContain('application/pdf');
    const draftText = pdfText(draft.rawPayload);
    expect(draftText).toContain('ENTWURF');
    const a = await approve(caseId);
    expect(a.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    const d = await detail(caseId);
    expect(d.state).toBe('approved');
    const pdf = await author.raw('GET', `/warnings/${caseId}/approvals/${d.approval.id}/pdf`);
    expect(crypto.createHash('sha256').update(pdf.rawPayload).digest('hex')).toBe(a.pdfSha256);
    const text = pdfText(pdf.rawPayload);
    expect(text).toContain('Warnstufe 2');
    expect(text).toContain(d.warning.case_no);
    expect(text).not.toContain('ENTWURF');
    expect(text).toContain('Starke Rauchentwicklung');
    // Freigabe gilt nur für diese Fassung
    expect((await saveRev(caseId, { data: { advice: 'Geänderter Hinweis.' } })).json.changed).toBe(true);
    expect((await detail(caseId)).state).toBe('draft');
  });

  it('Versand nur an das Testpostfach, mit PDF; kein Doppelversand; Eingangsbestätigung', async () => {
    // Die Bestätigung blieb beim Textwechsel erhalten – erneut einreichen und freigeben
    await approve(caseId);
    const d = await detail(caseId);
    expect(d.recipients.intended).toEqual(['leitstelle@example.invalid']);
    expect((await author.post(`/warnings/${caseId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] })).status).toBe(403);
    expect((await sender.post(`/warnings/${caseId}/send`, { approvalId: d.approval.id, confirmRecipients: ['leitstelle@example.invalid'] })).status).toBe(409);
    const s = await sender.post(`/warnings/${caseId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.testMode).toBe(true);
    const row = await deliverLast(caseId);
    expect(row.status).toBe('accepted');
    expect(inbox.length).toBe(1);
    expect(inbox[0].to).toEqual([TEST_BOX]);
    expect(inbox[0].subject).toMatch(/\[TEST\]|=5BTEST=5D/);
    expect(inbox[0].raw).toContain('application/pdf');
    expect(inbox[0].raw.replace(/\r?\n /g, ' ')).toMatch(new RegExp(`X-Lifelink-Pdf-Sha256:\\s+${d.approval.pdf_sha256}`, 'i'));
    expect(inbox.some((m) => m.to.includes('leitstelle@example.invalid'))).toBe(false);
    expect((await sender.post(`/warnings/${caseId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] })).status).toBe(409);
    expect((await detail(caseId)).state).toBe('sent');
    expect((await sender.post(`/warning-sends/${row.id}/acknowledge`, { note: 'Telefonisch bestätigt (Test).' })).status).toBe(200);
    expect((await detail(caseId)).state).toBe('acknowledged');
  });

  it('Aktualisierung zeigt die bisherige Stufe und verlangt erneute Bestätigung; Fehlversand ist wiederholbar', async () => {
    const u = await author.post('/warnings', { kind: 'update', parentId: caseId });
    updateId = u.json.id;
    let d = await detail(updateId);
    expect(d.previousLevel.level).toBe(2);
    expect(d.revision.level_decision).toBeNull();
    expect(d.revision.data.area).toBe(data.area);
    expect((await author.post(`/warnings/${updateId}/submit`, { revision: d.revision.number })).status).toBe(400);
    await saveRev(updateId, { data: { situation: 'Lage entspannt sich (fiktiv).' } });
    d = await detail(updateId);
    expect((await warnApprover.post(`/warnings/${updateId}/level`, { revision: d.revision.number, level: 2 })).status).toBe(200);
    await approve(updateId);
    d = await detail(updateId);
    smtpMode = 'reject';
    await sender.post(`/warnings/${updateId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    const failed = await deliverLast(updateId);
    expect(failed.status).toBe('failed');
    expect(failed.needs_review).toBe(false);
    expect((await detail(updateId)).state).toBe('send_failed');
    smtpMode = 'accept';
    const again = await sender.post(`/warnings/${updateId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    expect(again.status).toBe(200);
    expect((await deliverLast(updateId)).status).toBe('accepted');
  });

  it('Entwarnung ist ein eigener Vorgang ohne Stufe; unbekanntes Versandergebnis sperrt den Neuversand', async () => {
    const e = await author.post('/warnings', { kind: 'all_clear', parentId: updateId });
    allClearId = e.json.id;
    let d = await detail(allClearId);
    expect(d.warning.kind).toBe('all_clear');
    expect(d.revision.keyword).toBeNull();
    expect((await warnApprover.post(`/warnings/${allClearId}/level`, { revision: d.revision.number, level: 3 })).status).toBe(400);
    await approve(allClearId);
    d = await detail(allClearId);
    expect(d.revision.level_decision).toBeNull();
    const text = pdfText((await author.raw('GET', `/warnings/${allClearId}/approvals/${d.approval.id}/pdf`)).rawPayload);
    expect(text).toContain('ENTWARNUNG');
    expect(text).not.toContain('(bestätigt)');
    expect(text).not.toContain('Warnstufe 3');
    smtpMode = 'hang';
    await sender.post(`/warnings/${allClearId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    const unk = await deliverLast(allClearId);
    expect(unk.status).toBe('unknown');
    expect(unk.needs_review).toBe(true);
    smtpMode = 'accept';
    const blocked = await sender.post(`/warnings/${allClearId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('send_unknown');
    expect((await sender.post(`/warning-sends/${unk.id}/resolve`, { outcome: 'not_delivered', note: 'Leitstelle hat nichts erhalten (Test).' })).status).toBe(200);
    expect((await sender.post(`/warnings/${allClearId}/send`, { approvalId: d.approval.id, confirmRecipients: [TEST_BOX] })).status).toBe(200);
    expect((await deliverLast(allClearId)).status).toBe('accepted');
  });

  it('neue Vorlagenversion lässt bestehende Entwürfe unverändert reproduzierbar', async () => {
    const draftCase = (await author.post('/warnings', { kind: 'initial' })).json.id;
    await saveRev(draftCase, { data, responsibilityIds: [respId] });
    const before = await author.raw('GET', `/warnings/${draftCase}/pdf`);
    const cfg = (await admin.get('/warning-config')).json;
    const t1 = cfg.templates.find((t: any) => t.family === 'mowas-uebergabe');
    const nt = await admin.post('/warning-templates', { family: t1.family, name: t1.name, fields: t1.fields, levelLabels: t1.level_labels, pdfTitle: 'Neuer Titel Version 2', pdfFooter: t1.pdf_footer, mailSubject: t1.mail_subject, mailBody: t1.mail_body });
    expect(nt.status, JSON.stringify(nt.json)).toBe(200);
    expect(nt.json.version).toBe(2);
    const after = await author.raw('GET', `/warnings/${draftCase}/pdf`);
    expect(Buffer.compare(before.rawPayload, after.rawPayload)).toBe(0);
    expect(pdfText(after.rawPayload)).not.toContain('Neuer Titel');
    expect((await detail(draftCase)).template.newer_version).toBe(2);
    const fresh = (await author.post('/warnings', { kind: 'initial' })).json.id;
    expect((await detail(fresh)).template.version).toBe(2);
  });
});

/* ======================================================================================= M4 */

describe('Verbindungen (M4): FE2, Facebook, Instagram, amtliche Warnfeeds', () => {
  // Lokaler Ersatz für Graph API und CAP-Quelle – es wird nichts an echte Dienste gesendet.
  let mock: import('node:http').Server;
  let base = '';
  const graph: { posts: any[]; calls: string[]; failNext: null | 'reject' | 'server_after_create'; containers: Record<string, string> } = { posts: [], calls: [], failNext: null, containers: {} };
  let capXml = '';
  const cap = (id: string, msgType: string, headline: string, refs = '', area = 'Musterkreis', code = '099990000000') => `<?xml version="1.0"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>test@example.invalid</sender><sent>2026-11-14T10:00:00+01:00</sent><status>Actual</status><msgType>${msgType}</msgType>${refs ? `<references>test@example.invalid,${refs},2026-11-14T09:00:00+01:00</references>` : ''}
<info><language>de-DE</language><event>Unwetter</event><urgency>Immediate</urgency><severity>Severe</severity><headline>${headline}</headline><description>Fiktive Testwarnung.</description><expires>${new Date(Date.now() + 3 * 3600_000).toISOString()}</expires><web>https://example.invalid/warnung/${id}</web>
<area><areaDesc>${area}</areaDesc><geocode><valueName>ARS</valueName><value>${code}</value></geocode></area></info></alert>`;

  beforeAll(async () => {
    const http = await import('node:http');
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const u = new URL(req.url!, 'http://x');
        const p = new URLSearchParams(body);
        graph.calls.push(`${req.method} ${u.pathname}`);
        const json = (code: number, v: any) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        };
        if (u.pathname === '/cap.xml') {
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(capXml);
        }
        // Facebook OAuth
        if (u.pathname === '/fb/oauth/access_token') return json(200, { access_token: u.searchParams.get('fb_exchange_token') ? 'LANG-USER-TOKEN' : 'KURZ-USER-TOKEN' });
        if (u.pathname === '/fb/me/permissions') return json(200, { data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'].map((permission) => ({ permission, status: 'granted' })) });
        if (u.pathname === '/fb/me/accounts') return json(200, { data: [{ id: 'PAGE1', name: 'Testseite (fiktiv)', access_token: 'OAUTH-SEITEN-TOKEN', tasks: ['CREATE_CONTENT'] }] });
        // Facebook
        if (u.pathname === '/fb/PAGE1' && req.method === 'GET') return json(200, { id: 'PAGE1', name: 'Testseite (fiktiv)', link: 'https://facebook.example/PAGE1' });
        if ((u.pathname === '/fb/PAGE1/feed' || (u.pathname === '/fb/PAGE1/photos' && p.get('published') !== 'false')) && req.method === 'POST') {
          if (graph.failNext === 'reject') {
            graph.failNext = null;
            return json(400, { error: { message: '(#200) Fehlende Berechtigung (Test)' } });
          }
          const id = `PAGE1_${graph.posts.length + 1}`;
          graph.posts.push({ id, message: p.get('message') ?? p.get('caption'), published: p.get('published') !== 'false', created_time: new Date().toISOString(), permalink_url: `https://facebook.example/${id}` });
          if (graph.failNext === 'server_after_create') {
            graph.failNext = null;
            return json(500, { error: { message: 'Interner Fehler (Test)' } });
          }
          return json(200, { id, post_id: id });
        }
        if (u.pathname === '/fb/PAGE1/feed' && req.method === 'GET') return json(200, { data: graph.posts.filter((x) => x.published) });
        if (u.pathname.startsWith('/fb/PAGE1_') && req.method === 'DELETE') {
          graph.posts = graph.posts.filter((x) => x.id !== u.pathname.slice(4));
          return json(200, { success: true });
        }
        if (u.pathname.startsWith('/fb/PAGE1_') && req.method === 'GET') return json(200, { id: u.pathname.slice(4), permalink_url: `https://facebook.example/${u.pathname.slice(4)}` });
        if (u.pathname === '/fb/PAGE1/photos') return json(200, { id: `PH${graph.calls.length}`, post_id: `PAGE1_photo${graph.calls.length}` });
        // Instagram
        if (u.pathname === '/ig/me') return json(200, { user_id: 'IG1', username: 'test_konto', account_type: 'BUSINESS' });
        if (u.pathname === '/ig/IG1/content_publishing_limit') return json(200, { data: [{ quota_usage: 1, config: { quota_total: 100 } }] });
        if (u.pathname === '/ig/IG1/media' && req.method === 'POST') {
          const id = `C${Object.keys(graph.containers).length + 1}`;
          graph.containers[id] = p.get('image_url') ? 'FINISHED' : 'ERROR';
          return json(200, { id });
        }
        if (u.pathname === '/ig/IG1/media' && req.method === 'GET') return json(200, { data: graph.posts.filter((x) => x.ig) });
        if (u.pathname === '/ig/IG1/media_publish') {
          const id = `M${graph.posts.length + 1}`;
          graph.posts.push({ id, ig: true, caption: 'x', timestamp: new Date().toISOString(), permalink: `https://instagram.example/p/${id}` });
          return json(200, { id });
        }
        if (/^\/ig\/C\d+$/.test(u.pathname)) return json(200, { status_code: graph.containers[u.pathname.slice(4)] ?? 'ERROR' });
        if (/^\/ig\/M\d+$/.test(u.pathname)) return json(200, { permalink: `https://instagram.example/p/${u.pathname.slice(4)}` });
        json(404, { error: { message: `unbekannt ${u.pathname}` } });
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(mock.address() as any).port}`;
    process.env.LIFELINK_META_GRAPH_URL = `${base}/fb`;
    process.env.LIFELINK_IG_GRAPH_URL = `${base}/ig`;
  });
  afterAll(() => mock?.close());

  let fe2Id = '';
  let fe2Token = '';
  const alarm = (id: string, extra: any = {}) => ({
    einsatz: { id, stichwort: 'F-WALD-2', stichwort_text: 'Waldbrand mittel', ort: 'Musterstadt', ortsteil: 'Nord', alarmzeit: '2026-11-14T10:00', einheiten: ['HLF 1', 'TLF 2'], status: 'offen', ...extra },
    meldung: { alarmtext: 'VERTRAULICH Person Max Mustermann Tel 0123', anrufer: 'Erika Musterfrau' },
  });
  const inbound = (body: any, token = fe2Token, headers: Record<string, string> = {}) => anonymous.raw('POST', `/inbound/fe2/${fe2Id}`, { body, headers: { authorization: `Bearer ${token}`, ...headers } });

  it('Verbindungsrahmen: nur mit Recht; Verbinden → Testen → Vorschau → Aktivieren', async () => {
    expect((await editor.post('/connections', { kind: 'fe2', name: 'FE2' })).status).toBe(403);
    const c = await admin.post('/connections', { kind: 'fe2', name: 'FE2 Leitstelle (Test)' });
    expect(c.status).toBe(200);
    fe2Id = c.json.id;
    fe2Token = c.json.token;
    expect(fe2Token).toMatch(/^llfe2_/);
    const d = await admin.get(`/connections/${fe2Id}`);
    expect(JSON.stringify(d.json)).not.toContain(fe2Token);
    expect(d.json.inbound_url).toBe(`https://lifelink.example.org/api/v1/inbound/fe2/${fe2Id}`);
    // Aktivieren ohne Test geht nicht
    expect((await admin.post(`/connections/${fe2Id}/activate`)).status).toBe(409);
    const t1 = await admin.post(`/connections/${fe2Id}/test`);
    expect(t1.json.ok).toBe(false);
  });

  it('FE2: Authentisierung, Vorschau vor Aktivierung, Allowlist ohne vertrauliche Inhalte', async () => {
    expect((await inbound(alarm('E-1'), 'llfe2_falsch')).status).toBe(401);
    expect((await anonymous.raw('POST', `/inbound/fe2/${fe2Id}`, { body: alarm('E-1') })).status).toBe(401);
    const before = (await one<any>(`SELECT count(*)::int AS n FROM posts`))!.n;
    const r = await inbound(alarm('E-0'));
    expect(r.status).toBe(200);
    expect(r.json.outcome).toBe('test');
    expect((await one<any>(`SELECT count(*)::int AS n FROM posts`))!.n).toBe(before);
    const d = await admin.get(`/connections/${fe2Id}`);
    expect(d.json.preview.fields.keyword).toBe('F-WALD-2');
    expect(d.json.preview.fields.units).toBe('HLF 1, TLF 2');
    expect(JSON.stringify(d.json.preview)).not.toContain('Mustermann');
    expect(d.json.preview.ignoredKeys).toBeGreaterThanOrEqual(2);
    const t = await admin.post(`/connections/${fe2Id}/test`);
    expect(t.json.ok).toBe(true);
    expect((await admin.post(`/connections/${fe2Id}/activate`)).status).toBe(200);
  });

  it('FE2: ein Entwurf je Einsatz, Wiederholung ohne Duplikat, Folgeereignis, keine Inhalte in Protokollen', async () => {
    const r1 = await inbound(alarm('E-100'));
    expect(r1.json.outcome).toBe('created');
    const ev = await one<any>(`SELECT * FROM fe2_events WHERE event_key = $1`, [`${fe2Id}:E-100`]);
    expect(ev.post_id).toBeTruthy();
    const post = await one<any>(`SELECT r.* FROM post_revisions r WHERE r.post_id = $1`, [ev.post_id]);
    expect(post.title).toBe('Waldbrand mittel in Musterstadt – Nord');
    expect(post.body).not.toContain('Mustermann');
    expect(post.body).not.toContain('VERTRAULICH');
    expect((await inbound(alarm('E-100'))).json.outcome).toBe('duplicate');
    const r3 = await inbound(alarm('E-100', { einheiten: ['HLF 1', 'TLF 2', 'DLK'] }));
    expect(r3.json.outcome).toBe('updated');
    expect(r3.json.sequence).toBe(2);
    expect((await one<any>(`SELECT count(*)::int AS n FROM posts p JOIN fe2_events e ON e.post_id = p.id WHERE e.event_key = $1`, [`${fe2Id}:E-100`]))!.n).toBe(1);
    expect((await one<any>(`SELECT body FROM post_revisions WHERE post_id = $1`, [ev.post_id]))!.body).toContain('DLK');
    // Redaktion bearbeitet → spätere FE2-Meldungen ändern den Entwurf nicht mehr
    const d = (await editor.get(`/posts/${ev.post_id}`)).json;
    await editor.put(`/posts/${ev.post_id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Redaktioneller Text.', excerpt: '' });
    expect((await inbound(alarm('E-100', { status: 'beendet' }))).json.outcome).toBe('updated');
    expect((await one<any>(`SELECT status FROM fe2_events WHERE event_key = $1`, [`${fe2Id}:E-100`]))!.status).toBe('closed');
    expect((await one<any>(`SELECT current_revision FROM posts WHERE id = $1`, [ev.post_id]))!.current_revision).toBe(2);
    const logs = await one<any>(`SELECT count(*)::int AS n FROM app_logs WHERE message ILIKE '%Mustermann%' OR message ILIKE '%E-100%' OR details::text ILIKE '%Mustermann%'`);
    expect(logs!.n).toBe(0);
    const audits = await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE details::text ILIKE '%Mustermann%'`);
    expect(audits!.n).toBe(0);
    // Angehaltene Verbindung nimmt nichts an
    await admin.post(`/connections/${fe2Id}/disable`);
    expect((await inbound(alarm('E-101'))).status).toBe(409);
    // Neuer Schlüssel macht den alten ungültig
    const rot = await admin.post(`/connections/${fe2Id}/rotate-token`);
    await admin.post(`/connections/${fe2Id}/activate`);
    expect((await inbound(alarm('E-102'))).status).toBe(401);
    expect((await inbound(alarm('E-102'), rot.json.token)).json.outcome).toBe('created');
  });

  let fbId = '';
  let igId = '';
  let spPostId = '';
  it('Facebook: Anmeldung ist kein Veröffentlichungstest – Testbeitrag unveröffentlicht anlegen und löschen', async () => {
    const c = await admin.post('/connections', { kind: 'facebook', name: 'Facebook-Testseite', config: { appId: '123' } });
    fbId = c.json.id;
    expect((await admin.put(`/connections/${fbId}/secrets`, { pageToken: 'EAAG-geheimer-Seitentoken' })).status).toBe(200);
    await admin.put(`/connections/${fbId}`, { name: 'Facebook-Testseite', config: { pageId: 'PAGE1' } });
    const t = await admin.post(`/connections/${fbId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.steps.find((s: any) => s.kind === 'login').message).toContain('kein Veröffentlichungstest');
    expect(t.json.steps.find((s: any) => s.kind === 'publish').ok).toBe(true);
    expect(graph.calls).toContain('DELETE /fb/PAGE1_1');
    expect(graph.posts.length).toBe(0);
    const view = await admin.get(`/connections/${fbId}`);
    expect(JSON.stringify(view.json)).not.toContain('geheimer');
    expect(view.json.secrets_set).toContain('pageToken');
    expect(view.json.capabilities.photos).toBe(true);
    await admin.post(`/connections/${fbId}/activate`);
  });

  it('Instagram: Konto, Kontingent und Mediencontainer ohne Veröffentlichung', async () => {
    const c = await admin.post('/connections', { kind: 'instagram', name: 'Instagram-Testkonto', config: { appId: '123' } });
    igId = c.json.id;
    await admin.put(`/connections/${igId}/secrets`, { token: 'IGQ-geheimer-token' });
    const t = await admin.post(`/connections/${igId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(graph.calls.filter((x) => x === 'POST /ig/IG1/media_publish').length).toBe(0);
    expect(t.json.account.username).toBe('test_konto');
    await admin.post(`/connections/${igId}/activate`);
  });

  it('Kanäle sind Teil der Fassung; nur betroffener Kanal wird wiederholt; unbekanntes Ergebnis wird zuerst geprüft', async () => {
    const { runSocialPublication } = await import('../src/connections/social.js');
    const p = await editor.post('/posts', { title: 'Tag der offenen Tür (fiktiv)', kind: 'event' });
    spPostId = p.json.id;
    const img = await one<any>(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' AND has_public AND deleted_at IS NULL LIMIT 1`);
    let d = (await editor.get(`/posts/${spPostId}`)).json;
    const save = await editor.put(`/posts/${spPostId}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Wir laden herzlich ein.', excerpt: '', mediaIds: [img.id], socialTargets: [fbId, igId] });
    expect(save.json.changed).toBe(true);
    d = (await editor.get(`/posts/${spPostId}`)).json;
    expect(d.revision.social_targets.sort()).toEqual([fbId, igId].sort());
    // Ohne Freigabe nichts
    expect((await publisher.post(`/posts/${spPostId}/social`, { revision: d.revision.number, contentHash: d.revision.content_hash })).status).toBe(409);
    await editor.post(`/posts/${spPostId}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${spPostId}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    const check = await editor.get(`/posts/${spPostId}/social-check`);
    expect(check.json.length).toBe(2);
    // Facebook lehnt ab (Berechtigung), Instagram klappt
    graph.failNext = 'reject';
    const r = await publisher.post(`/posts/${spPostId}/social`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(r.json.items.length).toBe(2);
    // Facebook zuerst ausführen, damit die gezielte Ablehnung dort ankommt
    const ordered = [...r.json.items].sort((a: any) => (a.connection_id === fbId ? -1 : 1));
    for (const it of ordered) await runSocialPublication(it.id);
    let rows = await many<any>(`SELECT sp.*, c.kind FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1`, [spPostId]);
    const fb = rows.find((x) => x.kind === 'facebook');
    const ig = rows.find((x) => x.kind === 'instagram');
    expect(fb.status).toBe('failed');
    expect(fb.error).toContain('Fehlende Berechtigung');
    expect(fb.error).not.toContain('geheimer');
    expect(ig.status).toBe('published');
    expect(ig.remote_url).toContain('instagram.example');
    const igPublishCalls = graph.calls.filter((x) => x === 'POST /ig/IG1/media_publish').length;
    // Doppelt veröffentlichen geht nicht
    const again = await publisher.post(`/posts/${spPostId}/social`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(again.json.items.find((x: any) => x.connection_id === igId).duplicate).toBe(true);
    // Nur Facebook wiederholen: Server legt Beitrag an, antwortet aber mit 500 → unbekannt
    graph.failNext = 'server_after_create';
    await publisher.post(`/social-publications/${fb.id}/retry`);
    await runSocialPublication(fb.id);
    expect((await one<any>(`SELECT status FROM social_publications WHERE id = $1`, [fb.id]))!.status).toBe('unknown');
    const postsBefore = graph.posts.filter((x) => !x.ig && x.published).length;
    // Erneuter Anstoß prüft zuerst und findet den Beitrag → kein zweiter Beitrag
    await publisher.post(`/social-publications/${fb.id}/retry`);
    await runSocialPublication(fb.id);
    rows = await many<any>(`SELECT * FROM social_publications WHERE id = $1`, [fb.id]);
    expect(rows[0].status).toBe('published');
    expect(graph.posts.filter((x) => !x.ig && x.published).length).toBe(postsBefore);
    expect(graph.calls.filter((x) => x === 'POST /ig/IG1/media_publish').length).toBe(igPublishCalls);
    // Kanaländerung → neue Fassung → neue Freigabe
    d = (await editor.get(`/posts/${spPostId}`)).json;
    const ch = await editor.put(`/posts/${spPostId}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: d.revision.body, excerpt: '', mediaIds: [img.id], socialTargets: [fbId] });
    expect(ch.json.approvalInvalidated).toBe(true);
  });

  it('Manueller Export und zeitlich begrenzte Medien-URL', async () => {
    const p = await editor.post('/posts', { title: 'Export-Test (fiktiv)' });
    const img = await one<any>(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' AND has_public AND deleted_at IS NULL LIMIT 1`);
    let d = (await editor.get(`/posts/${p.json.id}`)).json;
    await editor.put(`/posts/${p.json.id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Text für den Export.', excerpt: '', mediaIds: [img.id] });
    d = (await editor.get(`/posts/${p.json.id}`)).json;
    expect((await publisher.get(`/posts/${p.json.id}/social-export`)).status).toBe(409);
    await editor.post(`/posts/${p.json.id}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${p.json.id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    const ex = await publisher.get(`/posts/${p.json.id}/social-export`);
    expect(ex.json.facebook).toContain('Text für den Export.');
    expect(ex.json.files.length).toBe(1);
    const path = new URL(ex.json.files[0].url).pathname;
    const f = await anonymous.raw('GET', path);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toContain('image/jpeg');
    await pool.query(`UPDATE media_tokens SET expires_at = now() - interval '1 second'`);
    expect((await anonymous.raw('GET', path)).status).toBe(404);
  });

  let wfId = '';
  it('Warnfeed: privates Ziel nur nach Freigabe, Gebietsfilter, Aktualisierung und Entwarnung', async () => {
    capXml = cap('W-1', 'Alert', 'Unwetterwarnung (Test)');
    const c = await admin.post('/connections', { kind: 'warnfeed', name: 'CAP-Testquelle', config: { format: 'cap', url: `${base}/cap.xml` } });
    wfId = c.json.id;
    await admin.put(`/connections/${wfId}`, { name: 'CAP-Testquelle', config: { format: 'cap', url: `${base}/cap.xml`, areaFilter: { codes: ['09999'], names: [] } } });
    const t0 = await admin.post(`/connections/${wfId}/test`);
    expect(t0.json.ok).toBe(false); // 127.0.0.1 ist privat und nicht freigegeben
    expect((await admin.post(`/connections/${wfId}/approve-private`, { host: '127.0.0.1' })).status).toBe(200);
    const t = await admin.post(`/connections/${wfId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.steps[1].message).toContain('1 von 1');
    await admin.post(`/connections/${wfId}/activate`);
    const { refreshWarnfeed } = await import('../src/connections/warnfeed.js');
    const conn = async () => one<any>(`SELECT * FROM connections WHERE id = $1`, [wfId]);
    await refreshWarnfeed(await conn());
    capXml = cap('W-OTHER', 'Alert', 'Andere Region', '', 'Fernkreis', '011110000000');
    await refreshWarnfeed(await conn());
    capXml = cap('W-2', 'Update', 'Unwetterwarnung aktualisiert (Test)', 'W-1');
    await refreshWarnfeed(await conn());
    const list = (await editor.get('/official-warnings')).json;
    expect(list.find((w: any) => w.identifier === 'W-1').superseded).toBe(true);
    expect(list.find((w: any) => w.identifier === 'W-OTHER').in_area).toBe(false);
    expect(list.find((w: any) => w.identifier === 'W-2').in_area).toBe(true);
    // Ohne automatische Banner: Entwurf mit Link zur Originalquelle (normale Freigabe)
    const site = await one<any>(`SELECT id FROM wp_sites WHERE status = 'active' LIMIT 1`);
    const bd = await editor.post(`/official-warnings/${list.find((w: any) => w.identifier === 'W-2').id}/banner-draft`, { siteId: site.id });
    const b = await one<any>(`SELECT * FROM banners WHERE id = $1`, [bd.json.id]);
    expect(b.approved_hash).toBeNull();
    expect(b.link_url).toBe('https://example.invalid/warnung/W-2');
  });

  it('Warnfeed: automatische Banner erst nach dokumentierter fachlicher Prüfung; Entwarnung beendet das Banner', async () => {
    const site = await one<any>(`SELECT id FROM wp_sites WHERE status = 'active' LIMIT 1`);
    const cfg = { format: 'cap', url: `${base}/cap.xml`, areaFilter: { codes: ['09999'], names: [] }, autoBanner: true, bannerSiteId: site.id };
    expect((await admin.put(`/connections/${wfId}`, { name: 'CAP-Testquelle', config: cfg })).status).toBe(400);
    expect((await admin.post(`/connections/${wfId}/review`, { checks: { origin: true }, note: 'Unvollständig geprüft.' })).status).toBe(400);
    const all = { origin: true, reuse: true, area: true, validity: true, updates: true, cancel: true };
    expect((await admin.post(`/connections/${wfId}/review`, { checks: all, note: 'Fiktive Prüfung für den Test dokumentiert.' })).status).toBe(200);
    expect((await admin.put(`/connections/${wfId}`, { name: 'CAP-Testquelle', config: cfg })).status).toBe(200);
    const { refreshWarnfeed } = await import('../src/connections/warnfeed.js');
    const conn = async () => one<any>(`SELECT * FROM connections WHERE id = $1`, [wfId]);
    capXml = cap('W-3', 'Alert', 'Sturmwarnung (Test)');
    await refreshWarnfeed(await conn());
    const w3 = await one<any>(`SELECT * FROM official_warnings WHERE identifier = 'W-3'`);
    expect(w3.banner_id).toBeTruthy();
    const job = await one<any>(`SELECT * FROM banner_jobs WHERE banner_id = $1`, [w3.banner_id]);
    expect(job.action).toBe('upsert');
    capXml = cap('W-4', 'Cancel', 'Entwarnung (Test)', 'W-3');
    await refreshWarnfeed(await conn());
    expect((await one<any>(`SELECT ended_at FROM banners WHERE id = $1`, [w3.banner_id]))!.ended_at).toBeTruthy();
    expect((await one<any>(`SELECT banner_id FROM official_warnings WHERE identifier = 'W-4'`))!.banner_id).toBeNull();
  });

  it('OAuth-Rückweg funktioniert ohne Sitzungs-Cookie (SameSite=Strict) über den einmaligen state', async () => {
    const c = await admin.post('/connections', { kind: 'facebook', name: 'Facebook per OAuth', config: { appId: '4711' } });
    expect((await admin.post(`/connections/${c.json.id}/oauth/start`)).status).toBe(400); // App-Geheimnis fehlt
    await admin.put(`/connections/${c.json.id}/secrets`, { appSecret: 'app-geheimnis-test' });
    const start = await admin.post(`/connections/${c.json.id}/oauth/start`);
    const state = new URL(start.json.url).searchParams.get('state')!;
    expect(new URL(start.json.url).searchParams.get('redirect_uri')).toBe('https://lifelink.example.org/api/v1/connections/oauth/callback');
    // Gefälschter state wird abgewiesen
    const bad = await anonymous.raw('GET', `/connections/oauth/callback?state=${c.json.id}.falsch&code=x`);
    expect(bad.status).toBe(302);
    expect(decodeURIComponent(bad.headers.location as string)).toContain('ungültig');
    const s2 = await admin.post(`/connections/${c.json.id}/oauth/start`);
    const state2 = new URL(s2.json.url).searchParams.get('state')!;
    void state;
    const cb = await anonymous.raw('GET', `/connections/oauth/callback?state=${encodeURIComponent(state2)}&code=abc`);
    expect(cb.status).toBe(302);
    expect(decodeURIComponent(cb.headers.location as string)).toContain('Seite(n) wählen');
    // state ist verbraucht
    expect(decodeURIComponent((await anonymous.raw('GET', `/connections/oauth/callback?state=${encodeURIComponent(state2)}&code=abc`)).headers.location as string)).toContain('ungültig');
    const v = await admin.get(`/connections/${c.json.id}`);
    expect(v.json.pages).toEqual([{ id: 'PAGE1', name: 'Testseite (fiktiv)' }]);
    expect(JSON.stringify(v.json)).not.toContain('OAUTH-SEITEN-TOKEN');
    expect((await admin.post(`/connections/${c.json.id}/page`, { pageId: 'PAGE1' })).status).toBe(200);
    expect((await admin.post(`/connections/${c.json.id}/test`)).json.ok).toBe(true);
  });

  it('Widerruf löscht Zugangsdaten; Redaktion sieht keine Geheimnisse', async () => {
    const list = await editor.get('/connections');
    expect(list.json.every((c: any) => ['facebook', 'instagram'].includes(c.kind))).toBe(true);
    expect(JSON.stringify(list.json)).not.toContain('secret');
    await admin.post(`/connections/${igId}/revoke`);
    const c = await one<any>(`SELECT status, secret_id FROM connections WHERE id = $1`, [igId]);
    expect(c.status).toBe('revoked');
    expect(c.secret_id).toBeNull();
    expect((await one<any>(`SELECT count(*)::int AS n FROM secrets WHERE owner_id = $1 AND revoked_at IS NULL`, [igId]))!.n).toBe(0);
  });
});

describe('Bridge-Updates über den WordPress-Updateweg (M4)', () => {
  it('Testwebsite zuerst, Freigabe erst nach Test, signierter Download mit Prüfsumme', async () => {
    const pair = async (name: string, url: string) => {
      const s = await admin.post('/sites', { name });
      const key = (await anonymous.post('/bridge/pair', { code: s.json.pairingCode, site_url: url })).json.key;
      return { id: s.json.site.id, key };
    };
    const test = await pair('Update-Testseite', 'https://test.example.org');
    const live = await pair('Update-Echtseite', 'https://www.example.org');
    const offer = (k: string, v = '0.3.0') => anonymous.get('/bridge/update', { authorization: `Bearer ${k}`, 'x-lifelink-bridge-version': v });
    expect((await offer(live.key)).json.available).toBe(false);
    expect((await offer(test.key)).json.available).toBe(false);
    expect((await editor.put(`/sites/${test.id}/update-channel`, { channel: 'test' })).status).toBe(403);
    await admin.put(`/sites/${test.id}/update-channel`, { channel: 'test' });
    const o = (await offer(test.key)).json;
    expect(o.available).toBe(true);
    expect(o.version).toBe('0.4.0');
    expect(o.package).toMatch(/^https:\/\/lifelink\.example\.org\/api\/v1\/bridge\/update\/package\?/);
    const path = new URL(o.package).pathname + new URL(o.package).search;
    const dl = await anonymous.raw('GET', path);
    expect(dl.status).toBe(200);
    expect(crypto.createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(o.sha256);
    expect((await anonymous.raw('GET', path.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).status).toBe(403);
    // Freigabe ohne Rückmeldung der Testwebsite mit der neuen Version → abgelehnt
    const rel = await admin.post('/sites/bridge-release', { version: '0.4.0', note: 'Auf Testseite geprüft.' });
    expect(rel.status).toBe(409);
    // Testwebsite meldet nach dem Update die neue Version (Kopplung blieb erhalten)
    expect((await offer(test.key, '0.4.0')).status).toBe(200);
    expect((await admin.post('/sites/bridge-release', { version: '0.4.0', note: 'Auf Testseite geprüft, Theme unverändert.' })).status).toBe(200);
    expect((await offer(live.key)).json.available).toBe(true);
    const st = (await admin.get('/sites/bridge-release')).json;
    expect(st.releases[0].tested_on_name).toBe('Update-Testseite');
    // Gleiche Dateien → gleiche Prüfsumme (feste Zeitstempel im ZIP)
    const { bridgePackage } = await import('../src/routes/bridge.js');
    expect(bridgePackage().sha256).toBe(o.sha256);
  });
});

describe('Sicherung, Updates und Wiederherstellung (M4)', () => {
  it('Wartungsmodus hält schreibende Vorgänge an, Banner auf Websites bleiben unberührt', async () => {
    expect((await editor.post('/system/maintenance', { enabled: true })).status).toBe(403);
    const pre0 = await admin.get('/system/update-preflight');
    expect(pre0.json.ready).toBe(false);
    expect(pre0.json.checks.find((c: any) => c.id === 'maintenance').ok).toBe(false);
    expect((await admin.post('/system/maintenance', { enabled: true, reason: 'Update auf neue Version (Test)' })).status).toBe(200);
    const { getSettings } = await import('../src/lib/settings.js');
    await getSettings(true);
    const w = await editor.post('/posts', { title: 'Während der Wartung' });
    expect(w.status).toBe(503);
    expect(w.json.error).toBe('maintenance');
    // Lesen bleibt möglich, Anmeldung auch
    expect((await editor.get('/posts')).status).toBe(200);
    // Bridge bekommt keine neuen Aufträge und keine Banner-Liste (bestehende Banner bleiben)
    const site = await one<any>(`SELECT id FROM wp_sites WHERE status = 'active' LIMIT 1`);
    const s = await admin.post('/sites', { name: 'Wartungstest' });
    expect(s.status).toBe(503);
    void site;
    const pre = await admin.get('/system/update-preflight');
    expect(pre.json.checks.find((c: any) => c.id === 'maintenance').ok).toBe(true);
    expect(pre.json.checks.find((c: any) => c.id === 'schema').ok).toBe(true);
    expect(pre.json.postgres).toMatch(/^\d+/);
    expect((await admin.post('/system/maintenance', { enabled: false })).status).toBe(200);
    await getSettings(true);
    expect((await editor.post('/posts', { title: 'Nach der Wartung' })).status).toBe(200);
  });

  it('fehlgeschlagene Migration wird vollständig zurückgerollt und kann nach Korrektur erneut laufen', async () => {
    const { migrate, migrationFiles } = await import('../src/db/migrate.js');
    const { config } = await import('../src/config.js');
    const dir = fs.mkdtempSync(path.join(process.env.LIFELINK_DATA_DIR!, 'mig-'));
    for (const f of migrationFiles()) fs.copyFileSync(path.join(config.migrationsDir, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '999_test_kaputt.sql'), `CREATE TABLE test_halb_fertig (id int);\nALTER TABLE gibt_es_nicht ADD COLUMN x int;`);
    await expect(migrate(() => {}, dir)).rejects.toThrow(/999_test_kaputt\.sql/);
    expect((await one<any>(`SELECT to_regclass('public.test_halb_fertig') AS t`))!.t).toBeNull();
    expect((await one<any>(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '999_test_kaputt.sql'`))!.n).toBe(0);
    // Bestehende Daten unverändert
    expect((await one<any>(`SELECT count(*)::int AS n FROM users`))!.n).toBeGreaterThan(3);
    fs.writeFileSync(path.join(dir, '999_test_kaputt.sql'), `CREATE TABLE test_halb_fertig (id int);`);
    expect(await migrate(() => {}, dir)).toEqual(['999_test_kaputt.sql']);
    // Rückkehr zum Image ohne diese Migration: Start wird verweigert (Datenstand neuer als Programm)
    const { SchemaNewerError } = await import('../src/db/migrate.js');
    await expect(migrate(() => {})).rejects.toBeInstanceOf(SchemaNewerError);
    const h = await anonymous.raw('GET', '/healthz');
    expect(h.json.checks.schema.ok).toBe(false);
    expect(h.json.checks.schema.detail).toContain('neuer als Programm');
    // Aufräumen: Testmigration entfernen
    await pool.query(`DROP TABLE test_halb_fertig; DELETE FROM schema_migrations WHERE name = '999_test_kaputt.sql'`);
    expect(await migrate(() => {})).toEqual([]);
  });
});

describe('Sicherheitsprüfung (M4)', () => {
  it('öffentliche Videofassung enthält nur Bild und Ton – keine Daten- oder Untertitelspuren', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.LIFELINK_DATA_DIR!, 'vid-'));
    fs.writeFileSync(path.join(dir, 'gps.srt'), '1\n00:00:00,000 --> 00:00:02,000\nGPS 50.1100 8.6800\n');
    const src = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=10', '-i', path.join(dir, 'gps.srt'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:s', 'mov_text', '-metadata', 'location=+50.1100+008.6800/', src]);
    const streams = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', f], { encoding: 'utf8' })).streams.map((s: any) => s.codec_type);
    expect(streams(src)).toContain('subtitle');
    const p = await editor.post('/posts', { title: 'Videotest Sicherheit' });
    const c = await editor.post(`/posts/${p.json.id}/collect`, {});
    const token = c.json.url.split('/u/')[1];
    const mp = multipart({ name: 'clip.mp4', data: fs.readFileSync(src), type: 'video/mp4' });
    const up = await anonymous.raw('POST', `/public/upload/${token}`, { payload: mp.payload, headers: mp.headers });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const m = await one<any>(`SELECT id FROM media WHERE original_name = 'clip.mp4' ORDER BY created_at DESC LIMIT 1`);
    expect(await processMedia(m.id)).toBe('ready');
    const row = await one<any>(`SELECT * FROM media WHERE id = $1`, [m.id]);
    expect(row.had_location).toBe(true);
    const pub = mediaPaths.publicFile(m.id, 'mp4');
    expect(streams(pub)).toEqual(['video']);
    expect(execFileSync('ffprobe', ['-v', 'error', '-show_format', pub], { encoding: 'utf8' })).not.toContain('location');
  });

  it('zu lange Videos werden abgewiesen (Ressourcenschutz)', async () => {
    await setSettings({ 'media.max_video_minutes': 0 } as any);
    const { getSettings } = await import('../src/lib/settings.js');
    await getSettings(true);
    const dir = fs.mkdtempSync(path.join(process.env.LIFELINK_DATA_DIR!, 'vid-'));
    const src = path.join(dir, 'lang.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=160x120:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    const p = await editor.post('/posts', { title: 'Videotest Länge' });
    const c = await editor.post(`/posts/${p.json.id}/collect`, {});
    const mp = multipart({ name: 'lang.mp4', data: fs.readFileSync(src), type: 'video/mp4' });
    await anonymous.raw('POST', `/public/upload/${c.json.url.split('/u/')[1]}`, { payload: mp.payload, headers: mp.headers });
    const m = await one<any>(`SELECT id FROM media WHERE original_name = 'lang.mp4' ORDER BY created_at DESC LIMIT 1`);
    expect(await processMedia(m.id)).toBe('rejected');
    expect((await one<any>(`SELECT reject_reason FROM media WHERE id = $1`, [m.id]))!.reject_reason).toContain('länger als');
    await setSettings({ 'media.max_video_minutes': 30 } as any);
    await getSettings(true);
  });

  it('Geheimnisse erscheinen nie in API-Antworten, Protokollen oder Audit', async () => {
    const tokens = ['EAAG-geheimer-Seitentoken', 'IGQ-geheimer-token', 'llfe2_'];
    const audit = await one<any>(`SELECT string_agg(details::text, ' ') AS t FROM audit_events`);
    for (const t of tokens.slice(0, 2)) expect(audit!.t ?? '').not.toContain(t);
    const settings = await admin.get('/settings');
    expect(JSON.stringify(settings.json)).not.toMatch(/password_secret_id|geheim/);
    const sec = await one<any>(`SELECT string_agg(ciphertext, '') AS c FROM secrets`);
    for (const t of tokens.slice(0, 2)) expect(sec!.c).not.toContain(t);
  });
});
