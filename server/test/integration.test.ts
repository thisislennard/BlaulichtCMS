import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import AdmZip from 'adm-zip';
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
import { config } from '../src/config.js';

/**
 * Durchlauf von Meilenstein 1 gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL).
 * Die Datenbank wird zu Beginn komplett geleert. Die Bridge wird durch direkte API-Aufrufe ersetzt.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';

class Client {
  cookie = '';
  constructor(private app: FastifyInstance, private ip?: string) {}
  async raw(method: string, url: string, opts: { body?: unknown; payload?: Buffer; headers?: Record<string, string> } = {}) {
    const json = opts.body !== undefined;
    const res = await this.app.inject({
      method: method as any,
      ...(this.ip ? { remoteAddress: this.ip } : {}),
      url: url.startsWith('/api/') || url.startsWith('/healthz') ? url : `/api/v1${url}`,
      payload: json ? JSON.stringify(opts.body) : opts.payload,
      headers: {
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
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
  const boundary = `----blaulichtcms${crypto.randomBytes(8).toString('hex')}`;
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
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
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
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    const setup = { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' };
    expect((await admin.post('/auth/setup', { ...setup, token: 'falsch' })).status).toBe(403);
    expect((await admin.post('/auth/setup', { ...setup, publicUrl: 'ftp://x' })).status).toBe(400);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: setup });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await admin.post('/auth/setup', setup);
    expect(ok.status).toBe(200);
    expect(ok.json.next).toBe('mfa_setup');
    // Zweiter Setup-Versuch ist gesperrt
    expect((await new Client(app).post('/auth/setup', setup)).status).toBe(403);
    // Neue Installation: 2FA-Pflicht für Medienverwaltung ist an (#140)
    expect((await admin.get('/auth/state')).status).toBe(200);
    expect((await one<any>(`SELECT value FROM settings WHERE key = 'security.require_2fa_media'`))).toBeNull();
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    const me = await admin.get('/auth/me');
    expect(me.json.instance.organization).toBe('Musterorganisation');
    expect(me.json.instance.publicUrl).toBe('https://blaulichtcms.example.org');
  });

  it('sperrt nach zu vielen Fehlversuchen', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.post('/auth/login', { email: 'admin@example.org', password: 'falsch' })).status).toBe(401);
    // Gesperrt: dieselbe 401-Antwort wie bei falschem Passwort, auch mit richtigem Passwort (#124)
    const locked = await c.post('/auth/login', { email: 'admin@example.org', password: PASSWORD });
    const unknown = await c.post('/auth/login', { email: 'niemand@example.org', password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.json).toEqual(unknown.json);
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'auth.login' AND result = 'failed' ORDER BY id DESC OFFSET 1 LIMIT 1`))!.details.grund).toBe('gesperrt');
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
    expect(inv.json.link.startsWith('https://blaulichtcms.example.org/einladung/')).toBe(true);
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
    expect(c.json.url.startsWith('https://blaulichtcms.example.org/u/')).toBe(true);
    collectionId = c.json.collectionId;
    linkId = c.json.linkId;
    linkToken = c.json.url.split('/u/')[1];
    const info = await anonymous.get(`/public/upload/${linkToken}`);
    expect(info.status).toBe(200);
    expect(info.json.collection.title).toBe('Übung am Wochenende');
    expect(info.json.organization).toBe('Musterorganisation');
    // Informationspflichten (#96): Angaben fehlen → Erinnerung nur für angemeldete Verwaltung
    expect(info.json.privacy).toMatchObject({ controller: '', policy_url: '', ip_retention_days: 30 });
    expect(info.json.setup_hint).toBe(false);
    expect((await admin.get(`/public/upload/${linkToken}`)).json.setup_hint).toBe(true);
    expect((await admin.patch('/settings', { 'privacy.policy_url': 'javascript:alert(1)' })).status).toBe(400);
    expect(
      (await admin.patch('/settings', { 'privacy.controller': 'Musterorganisation, Hauptstraße 1, 12345 Musterstadt', 'privacy.policy_url': 'https://example.org/datenschutz', 'privacy.upload_notice': 'Rechtsgrundlage: Art. 6 Abs. 1 lit. e DSGVO.' })).status,
    ).toBe(200);
    const withPrivacy = await admin.get(`/public/upload/${linkToken}`);
    expect(withPrivacy.json.setup_hint).toBe(false);
    expect(withPrivacy.json.privacy).toMatchObject({ controller: 'Musterorganisation, Hauptstraße 1, 12345 Musterstadt', policy_url: 'https://example.org/datenschutz', notice: 'Rechtsgrundlage: Art. 6 Abs. 1 lit. e DSGVO.' });
    expect((await admin.get('/auth/me')).json.instance.privacy).toMatchObject({ incomplete: false, policy_url: 'https://example.org/datenschutz' });
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
    // media.strip_location (Standard an): auch das Original ist ohne GPS, Bilddaten bleiben (#119)
    expect(ready.location_stripped_at).not.toBeNull();
    const orig = await sharp(mediaPaths.original(m.id)).metadata();
    expect(orig.width).toBe(640);
    expect(orig.exif && (orig.exif.includes(Buffer.from([0x88, 0x25])) || orig.exif.includes(Buffer.from([0x25, 0x88])))).toBeFalsy();
    // Öffentliche Fassung mit neutralem Namen, Original mit Originalnamen (#137)
    expect((await editor.get(`/media/${m.id}/public`)).headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${m.id}.jpg`);
    const prev = await editor.get(`/media/${m.id}/preview`);
    expect(prev.status).toBe(200);
    expect(prev.headers['content-type']).toBe('image/webp');
  });

  it('weist falsche Dateitypen nach Inhaltsprüfung ab', async () => {
    const mp = multipart({ name: 'foto.jpg', data: Buffer.from('#!/bin/sh\necho kein Bild\n'), type: 'image/jpeg' }, { clientKey: 'client-key-0002' });
    expect((await anonymous.raw('POST', `/public/upload/${linkToken}`, mp)).status).toBe(200);
    await processAllQuarantine();
    const bad = await one<any>(`SELECT * FROM media WHERE client_key = 'client-key-0002'`);
    // Gesperrt statt gelöscht (Medien wie LiFeOS 7): Datei bleibt in der Quarantäne
    expect(bad.status).toBe('blocked');
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
    expect(r.json.error).toBe('link_unavailable');
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

describe('BlaulichtCMS Bridge und WordPress-Veröffentlichung', () => {
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
    expect(bridgeKey.startsWith('bcb_')).toBe(true);
    // Code ist verbraucht
    expect((await anonymous.post('/bridge/pair', { code, site_url: 'https://wp.example.org' })).status).toBe(401);
    expect((await anonymous.get('/bridge/status', { authorization: `Bearer ${bridgeKey}` })).json.site_name).toBe('Testwebsite');
    expect((await anonymous.get('/bridge/status', { authorization: 'Bearer bcb_xxxxxxxxxxxx_falschfalschfalschfalsch' })).status).toBe(401);
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
    const media = await anonymous.get(job.media[0].url.replace('https://blaulichtcms.example.org', ''), auth);
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

  it('öffentliches /healthz und /auth/state verraten weder Version noch Details (#125)', async () => {
    const outside = new Client(app, '203.0.113.7');
    const h = await outside.get('/healthz');
    expect(h.status).toBe(200);
    expect(h.json.version).toBeUndefined();
    expect(h.json.checks.database).toEqual({ ok: true });
    expect(JSON.stringify(h.json)).not.toMatch(/Migrationen|GB frei|aktiv/);
    // Lokaler Aufruf über den Proxy weitergereicht zählt nicht als lokal
    const proxied = await anonymous.get('/healthz', { 'x-forwarded-for': '203.0.113.7' });
    expect(proxied.json.version).toBeUndefined();
    // Aufruf aus dem Container selbst (Docker-Healthcheck) bekommt die Details
    const local = await anonymous.get('/healthz');
    expect(local.json.version).toBeTruthy();
    expect(local.json.checks.schema.detail).toMatch(/Migrationen/);
    const st = await outside.get('/auth/state');
    expect(st.json.version).toBeUndefined();
    expect(st.json.suggestedPublicUrl).toBeNull();
  });

  it('Sicherheits-Kopfzeilen: CSP ohne unsafe-inline für Stylesheets, Permissions-Policy (#132)', async () => {
    const r = await anonymous.get('/auth/state');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toMatch(/style-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src-elem 'self'(;|$)/);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const pp = String(r.headers['permissions-policy']);
    for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) expect(pp).toContain(f);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('Fortsetzbarer Upload (M2)', () => {
  // Testvideo mit Standort-Metadaten; größer als mehrere Upload-Teile (30 kB).
  let videoData: Buffer | undefined;
  const video = () => {
    if (videoData) return videoData;
    if (process.env.TEST_VIDEO) return (videoData = fs.readFileSync(process.env.TEST_VIDEO));
    const file = path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'test-video.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=640x480:rate=25', '-c:v', 'libx264', '-b:v', '600k', '-pix_fmt', 'yuv420p', '-metadata', 'location=+50.1100+008.6800/', file]);
    videoData = fs.readFileSync(file);
    expect(videoData.length).toBeGreaterThan(100_000);
    return videoData;
  };
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
    fs.appendFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'media', 'tmp', `upload-${s.json.id}.part`), data.subarray(chunk, chunk + 5_000));
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
    const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'media', 'public', `${m.id}.mp4`)]).toString();
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
    // Fremde Exporte sieht nur, wer „Medien verwalten“ hat (#94)
    expect((await approver.get(`/exports/${r.json.id}`)).status).toBe(404);
    expect((await approver.get(`/exports/${r.json.id}/download`)).status).toBe(404);
    await pool.query(`UPDATE exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.json.id]);
    await cleanupExports();
    expect(fs.existsSync(exportPath(r.json.id))).toBe(false);
    expect((await editor.get(`/exports/${r.json.id}/download`)).status).toBe(404);
  });
});

describe('Sammeldownload der Originale (#94)', () => {
  it('verlangt „Medien verwalten“ beim Anlegen und beim Herunterladen', async () => {
    // Freigabe hat media.read, aber nicht media.manage
    expect((await approver.post(`/collections/${collectionId}/exports`, { selection: 'all', variant: 'original' })).status).toBe(403);
    const pub = await approver.post(`/collections/${collectionId}/exports`, { selection: 'all', variant: 'public' });
    expect(pub.status).toBe(200);
    const { buildExport } = await import('../src/media/exports.js');
    await buildExport(pub.json.id);
    // Eigener Export der öffentlichen Fassung: erlaubt
    expect((await approver.get(`/exports/${pub.json.id}`)).status).toBe(200);
    expect((await approver.get(`/exports/${pub.json.id}/download`)).status).toBe(200);
    // Original-Export einer berechtigten Person: nicht für die Freigabe
    const orig = await editor.post(`/collections/${collectionId}/exports`, { selection: 'all', variant: 'original' });
    expect(orig.status).toBe(200);
    await buildExport(orig.json.id);
    expect((await approver.get(`/exports/${orig.json.id}/download`)).status).toBe(404);
    expect((await editor.get(`/exports/${orig.json.id}/download`)).status).toBe(200);
    // Auch wenn der Original-Export der Person selbst gehört, aber das Recht inzwischen fehlt
    const approverId = (await one<any>(`SELECT id FROM users WHERE email = 'freigabe@example.org'`)).id;
    await pool.query(`UPDATE exports SET created_by = $2 WHERE id = $1`, [orig.json.id, approverId]);
    expect((await approver.get(`/exports/${orig.json.id}/download`)).status).toBe(403);
  });
});

describe('Schadsoftwareprüfung mit ClamAV (#133)', () => {
  it('verwirft Treffer, hält Dateien bei nicht erreichbarer Prüfung in der Quarantäne und lässt saubere durch', async () => {
    const net = await import('node:net');
    const { config } = await import('../src/config.js');
    // clamd-Stellvertreter: Inhalt mit „EICAR-TEST“ ist ein Treffer
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) sock.end(buf.includes('EICAR-TEST') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const upload = async (key: string, data: Buffer) => {
      const mp = multipart({ name: `${key}.jpg`, data, type: 'image/jpeg' }, { clientKey: key });
      expect((await editor.raw('POST', `/collections/${collectionId}/media`, mp)).status).toBe(200);
      return (await one<any>(`SELECT id FROM media WHERE client_key = $1`, [key])).id as string;
    };
    try {
      config.clamav.host = '127.0.0.1';
      config.clamav.port = port;
      // Treffer: Datei weg, abgewiesen, Audit
      const bad = await upload('clam-bad-0001', Buffer.concat([await photoWithGps(), Buffer.from('EICAR-TEST')]));
      expect(await processMedia(bad)).toBe('rejected');
      const b = await one<any>(`SELECT * FROM media WHERE id = $1`, [bad]);
      expect(b.status).toBe('rejected');
      expect(b.reject_reason).toMatch(/Schadsoftware erkannt \(Eicar-Test-Signature\)/);
      expect(fs.existsSync(mediaPaths.quarantine(bad))).toBe(false);
      expect(await one(`SELECT 1 FROM audit_events WHERE action = 'media.malware_found' AND object_id = $1`, [bad])).not.toBeNull();
      // Sauber: normale Verarbeitung
      const good = await upload('clam-good-0001', await photoWithGps());
      expect(await processMedia(good)).toBe('ready');
      // Prüfung nicht erreichbar: bleibt in der Quarantäne
      config.clamav.port = 1;
      const wait = await upload('clam-wait-0001', await photoWithGps());
      expect(await processMedia(wait)).toBe('deferred');
      expect((await one<any>(`SELECT status FROM media WHERE id = $1`, [wait])).status).toBe('quarantine');
      expect(fs.existsSync(mediaPaths.quarantine(wait))).toBe(true);
      // wieder erreichbar → wird verarbeitet
      config.clamav.port = port;
      expect(await processMedia(wait)).toBe('ready');
    } finally {
      config.clamav.host = '';
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Personen und sensible Inhalte: Markierung, Unkenntlichmachen, Freigabe-Prüfung (#118)', () => {
  it('erzeugt eine neue öffentliche Fassung, lässt das Original unverändert und verlangt die Prüfung bei der Freigabe', async () => {
    // Rauschbild 200×100: unbearbeitet hohe Streuung, verpixelt deutlich weniger
    const noise = await sharp(crypto.randomBytes(200 * 100 * 3), { raw: { width: 200, height: 100, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const mp = multipart({ name: 'personen.jpg', data: noise, type: 'image/jpeg' }, { clientKey: 'privacy-0001' });
    expect((await editor.raw('POST', `/collections/${collectionId}/media`, mp)).status).toBe(200);
    await processAllQuarantine();
    const m = await one<any>(`SELECT * FROM media WHERE client_key = 'privacy-0001'`);
    expect(m.status).toBe('ready');
    const stdev = async (left: number, width: number) => {
      const st = await sharp(await sharp(mediaPaths.publicFile(m.id, 'jpg')).extract({ left, top: 0, width, height: 100 }).png().toBuffer()).stats();
      return st.channels[0].stdev;
    };
    expect(await stdev(0, 100)).toBeGreaterThan(40);
    // Ohne „Medien verwalten“ nicht erlaubt
    expect((await publisher.raw('PATCH', `/media/${m.id}/privacy`, { body: { flags: ['persons'] } })).status).toBe(403);
    const r = await editor.patch(`/media/${m.id}/privacy`, { flags: ['persons', 'health'], redactions: [{ x: 0, y: 0, w: 0.5, h: 1, mode: 'pixelate' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.media.sensitive_flags).toEqual(['persons', 'health']);
    expect(r.json.media.public_rev).toBe(1);
    expect(await stdev(0, 96)).toBeLessThan(25);
    expect(await stdev(104, 96)).toBeGreaterThan(40);
    // Original bytegleich
    expect(crypto.createHash('sha256').update(fs.readFileSync(mediaPaths.original(m.id))).digest('hex')).toBe(m.sha256);
    // Zuschnitt auf die rechte Hälfte
    const c = await editor.patch(`/media/${m.id}/privacy`, { crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
    expect(c.status).toBe(200);
    expect((await sharp(mediaPaths.publicFile(m.id, 'jpg')).metadata()).width).toBe(100);
    expect((await editor.patch(`/media/${m.id}/privacy`, { crop: null })).status).toBe(200);
    expect((await sharp(mediaPaths.publicFile(m.id, 'jpg')).metadata()).width).toBe(200);
    // „Ohne Ton“ nur für Videos
    expect((await editor.patch(`/media/${m.id}/privacy`, { stripAudio: true })).status).toBe(400);
    // Freigabe: markierte Medien verlangen die bestätigte Datenschutz-Prüfung
    const p = await editor.post('/posts', { title: 'Datenschutz-Prüfung (fiktiv)' });
    let d = (await editor.get(`/posts/${p.json.id}`)).json;
    await editor.put(`/posts/${p.json.id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Text', excerpt: '', mediaIds: [m.id] });
    d = (await editor.get(`/posts/${p.json.id}`)).json;
    expect(d.media[0].sensitive_flags).toEqual(['persons', 'health']);
    await editor.post(`/posts/${p.json.id}/submit`, { revision: d.revision.number });
    const dec = { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' };
    const no = await approver.post(`/posts/${p.json.id}/decision`, dec);
    expect(no.status).toBe(400);
    expect(no.json.error).toBe('privacy_check_required');
    expect((await approver.post(`/posts/${p.json.id}/decision`, { ...dec, privacyChecked: true })).status).toBe(200);
    const au = await one<any>(`SELECT details FROM audit_events WHERE action = 'post.approved' AND object_id = $1`, [p.json.id]);
    expect(au.details.datenschutz_geprueft).toBe(true);
    // Nach der Freigabe keine Änderung der öffentlichen Fassung mehr, Markierungen schon
    expect((await editor.patch(`/media/${m.id}/privacy`, { redactions: [] })).status).toBe(409);
    expect((await editor.patch(`/media/${m.id}/privacy`, { flags: ['persons'] })).status).toBe(200);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'media.privacy' AND object_id = $1`, [m.id])).not.toBeNull();
  });
});

describe('Standortdaten aus älteren Originalen entfernen (#119)', () => {
  it('lässt Originale bei ausgeschalteter Einstellung unverändert und bereinigt sie nach dem Einschalten im Hintergrund', async () => {
    const { getSettings } = await import('../src/lib/settings.js');
    const { enqueuePendingLocationStrips, stripStoredOriginal } = await import('../src/media/process.js');
    await setSettings({ 'media.strip_location': false });
    await getSettings(true);
    try {
      const mp = multipart({ name: 'alt.jpg', data: await photoWithGps(), type: 'image/jpeg' }, { clientKey: 'strip-later-0001' });
      expect((await editor.raw('POST', `/collections/${collectionId}/media`, mp)).status).toBe(200);
      await processAllQuarantine();
      const m = await one<any>(`SELECT * FROM media WHERE client_key = 'strip-later-0001'`);
      expect(m.status).toBe('ready');
      expect(m.location_stripped_at).toBeNull();
      const exifGps = async () => {
        const e = (await sharp(mediaPaths.original(m.id)).metadata()).exif;
        return !!e && (e.includes(Buffer.from([0x88, 0x25])) || e.includes(Buffer.from([0x25, 0x88])));
      };
      expect(await exifGps()).toBe(true);
      await setSettings({ 'media.strip_location': true });
      await getSettings(true);
      expect(await enqueuePendingLocationStrips()).toBeGreaterThanOrEqual(1);
      const job = await one<any>(`SELECT * FROM jobs WHERE dedup_key = $1`, [`media.strip_location:${m.id}`]);
      expect(job.status).toBe('queued');
      // kein doppelter Auftrag
      await enqueuePendingLocationStrips();
      expect((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE dedup_key = $1`, [`media.strip_location:${m.id}`])).n).toBe(1);
      await stripStoredOriginal(m.id);
      const after = await one<any>(`SELECT * FROM media WHERE id = $1`, [m.id]);
      expect(after.location_stripped_at).not.toBeNull();
      expect(after.location_strip_error).toBeNull();
      expect(await exifGps()).toBe(false);
      expect((await editor.get(`/collections/${collectionId}`)).json.media.find((x: any) => x.id === m.id).location_stripped).toBe(true);
      await pool.query(`DELETE FROM jobs WHERE kind = 'media.strip_location'`);
    } finally {
      await setSettings({ 'media.strip_location': true });
      await getSettings(true);
    }
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

  it('zieht einen veröffentlichten Beitrag zurück (ohne neue Freigabe) – auf allen Websites (#98)', async () => {
    // Neuere Fassung auf eine dritte Website: der Beitrag steht danach auf zwei Websites
    const s3 = await admin.post('/sites', { name: 'Dritte Testwebsite' });
    const key3 = (await anonymous.post('/bridge/pair', { code: s3.json.pairingCode, site_url: 'https://drei.example.org' })).json.key;
    const auth3 = { authorization: `Bearer ${key3}` };
    let d = await cur();
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Einsatz Musterstraße', body: 'Interner Langtext.', siteId: s3.json.site.id, variants: { wordpress: { body: 'Text für die dritte Website.' } } });
    d = await cur();
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    const j3 = (await anonymous.get('/bridge/jobs', auth3)).json.jobs;
    expect(j3).toHaveLength(1);
    await anonymous.post(`/bridge/jobs/${j3[0].id}/result`, { status: 'published', remote_id: 9, url: 'https://drei.example.org/einsatz/' }, auth3);

    expect((await editor.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' })).status).toBe(403);
    const u = await publisher.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' });
    expect(u.status).toBe(200);
    expect(u.json.sites).toBe(2);
    expect((await publisher.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' })).json.duplicate).toBe(true);
    const jobs = (await anonymous.get('/bridge/jobs', auth())).json.jobs;
    expect(jobs[0].type).toBe('post.unpublish');
    expect(Array.isArray(jobs[0].media_ids)).toBe(true);
    await anonymous.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_id: 7, remote_status: 'draft' }, auth());
    const jobs3 = (await anonymous.get('/bridge/jobs', auth3)).json.jobs;
    expect(jobs3).toHaveLength(1);
    expect(jobs3[0].type).toBe('post.unpublish');
    await anonymous.post(`/bridge/jobs/${jobs3[0].id}/result`, { status: 'published', remote_id: 9, remote_status: 'draft' }, auth3);
    // Nichts mehr veröffentlicht → kein weiterer Rückzug möglich
    expect((await publisher.post(`/posts/${pid}/unpublish`, { reason: 'Fehler im Text' })).status).toBe(400);
    expect((await cur()).state).toBe('deactivated');
    const list = (await editor.get('/posts')).json.find((p: any) => p.id === pid);
    expect(list.state).toBe('deactivated');
  });

  it('widerrufene oder veraltete Freigabe: kein Wiederholen, keine Auslieferung (#52)', async () => {
    const p = await editor.post('/posts', { title: 'Freigabe-Widerruf (fiktiv)' });
    const id2 = p.json.id;
    const get = async () => (await editor.get(`/posts/${id2}`)).json;
    let d = await get();
    await editor.put(`/posts/${id2}/revision`, { baseRevision: d.revision.number, title: 'Freigabe-Widerruf (fiktiv)', body: 'Text.', siteId: site2 });
    const approveAndPublish = async () => {
      d = await get();
      await editor.post(`/posts/${id2}/submit`, { revision: d.revision.number });
      expect((await approver.post(`/posts/${id2}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(200);
      const pub = await publisher.post(`/posts/${id2}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
      expect(pub.status).toBe(200);
      return one<any>(`SELECT id FROM publications WHERE post_id = $1 AND action = 'publish' ORDER BY created_at DESC LIMIT 1`, [id2]);
    };
    // (a) Auftrag fehlgeschlagen → Widerruf bricht ihn ab → Wiederholen nicht mehr möglich
    const pub1 = await approveAndPublish();
    await pool.query(`UPDATE publications SET status = 'failed', error = 'Test' WHERE id = $1`, [pub1!.id]);
    const rv = await approver.post(`/posts/${id2}/approval/revoke`, {});
    expect(rv.status).toBe(200);
    expect(rv.json.canceled).toBe(1);
    expect((await one<any>(`SELECT status FROM publications WHERE id = $1`, [pub1!.id]))!.status).toBe('canceled');
    expect((await publisher.post(`/publications/${pub1!.id}/retry`, {})).status).toBe(400);
    // (b) Auftrag fehlgeschlagen, inzwischen neue Fassung → Wiederholen verweigert (veraltete Fassung)
    const pub2 = await approveAndPublish();
    await pool.query(`UPDATE publications SET status = 'failed', error = 'Test' WHERE id = $1`, [pub2!.id]);
    d = await get();
    await editor.put(`/posts/${id2}/revision`, { baseRevision: d.revision.number, title: 'Freigabe-Widerruf (fiktiv)', body: 'Neuer Text.', siteId: site2 });
    const retry = await publisher.post(`/publications/${pub2!.id}/retry`, {});
    expect(retry.status).toBe(409);
    expect(retry.json.error).toBe('not_approved');
    // (c) Wartender Auftrag, neue Fassung → Bridge bekommt ihn nicht, er wird abgebrochen
    const pub3 = await approveAndPublish();
    d = await get();
    await editor.put(`/posts/${id2}/revision`, { baseRevision: d.revision.number, title: 'Freigabe-Widerruf (fiktiv)', body: 'Noch ein Text.', siteId: site2 });
    const jobs = (await anonymous.get('/bridge/jobs', auth())).json.jobs;
    expect(jobs.find((j: any) => j.id === pub3!.id)).toBeUndefined();
    expect((await one<any>(`SELECT status FROM publications WHERE id = $1`, [pub3!.id]))!.status).toBe('canceled');
  });

  it('Widerruf und gleichzeitige Abholung laufen nacheinander; Rückmeldung trotz Widerruf beauftragt den Rückzug (#145)', async () => {
    const p = await editor.post('/posts', { title: 'Widerruf während Abholung (fiktiv)' });
    const id3 = p.json.id;
    let d = (await editor.get(`/posts/${id3}`)).json;
    await editor.put(`/posts/${id3}/revision`, { baseRevision: d.revision.number, title: 'Widerruf während Abholung (fiktiv)', body: 'Text.', siteId: site2 });
    d = (await editor.get(`/posts/${id3}`)).json;
    await editor.post(`/posts/${id3}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${id3}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    const pub = await publisher.post(`/posts/${id3}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    // Abholung durch die Bridge läuft (Zeile gesperrt, noch nicht bestätigt) – der Widerruf muss warten und sieht dann „sent“
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE publications SET status = 'sent', fetched_at = now(), attempts = attempts + 1 WHERE id = $1`, [pub.json.id]);
      const revoke = approver.post(`/posts/${id3}/approval/revoke`, {});
      await new Promise((r) => setTimeout(r, 300));
      await client.query('COMMIT');
      const rv = await revoke;
      expect(rv.status).toBe(400);
      expect(rv.json.message).toContain('läuft bereits');
    } finally {
      client.release();
    }
    // Wird die Freigabe dennoch widerrufen (z. B. direkt in der Datenbank), führt die Erfolgsmeldung zum Rückzug
    await pool.query(`UPDATE approvals SET revoked_at = now() WHERE post_id = $1 AND revoked_at IS NULL`, [id3]);
    const res = await anonymous.post(`/bridge/jobs/${pub.json.id}/result`, { status: 'published', remote_id: 11, url: 'https://zwei.example.org/widerruf/' }, auth());
    expect(res.status).toBe(200);
    expect(res.json.unpublish).toBeTruthy();
    const un = await one<any>(`SELECT status, action FROM publications WHERE id = $1`, [res.json.unpublish]);
    expect(un).toMatchObject({ status: 'queued', action: 'unpublish' });
    const jobs = (await anonymous.get('/bridge/jobs', auth())).json.jobs;
    expect(jobs.find((j: any) => j.id === res.json.unpublish)?.type).toBe('post.unpublish');
    await anonymous.post(`/bridge/jobs/${res.json.unpublish}/result`, { status: 'published', remote_id: 11, remote_status: 'draft' }, auth());
  });

  it('ein nie bestätigter Auftrag wird nach 10 Abholungen fehlgeschlagen statt endlos ausgeliefert (#67)', async () => {
    const p = await one<any>(
      `UPDATE publications SET status = 'sent', attempts = 10, fetched_at = now() - interval '1 hour'
        WHERE id = (SELECT id FROM publications WHERE status = 'canceled' AND site_id = $1 ORDER BY created_at DESC LIMIT 1) RETURNING id`,
      [site2],
    );
    const jobs = (await anonymous.get('/bridge/jobs', auth())).json.jobs;
    expect(jobs.find((j: any) => j.id === p!.id)).toBeUndefined();
    expect((await one<any>(`SELECT status FROM publications WHERE id = $1`, [p!.id]))!.status).toBe('failed');
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
    // Nicht eingereicht → keine Freigabe (#147)
    const early = await approver.post(`/banners/${bid}/approve`, { contentHash: st.content_hash });
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('not_submitted');
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

describe('WordPress: Kategorien, Autor, Darstellung der Hinweise, Meldung der Bridge (#186)', () => {
  let siteId = '';
  let key = '';
  let pid = '';
  const auth = () => ({ authorization: `Bearer ${key}` });
  const cur = async () => (await editor.get(`/posts/${pid}`)).json;

  it('nimmt die Meldung der Bridge an und zeigt sie auf der Website-Karte', async () => {
    const s = await admin.post('/sites', { name: 'Kategorien-Testseite' });
    siteId = s.json.site.id;
    // Kopplung direkt in der Datenbank – POST /bridge/pair ist auf 10 je Minute begrenzt und gehört anderen Tests
    const prefix = crypto.randomBytes(6).toString('hex');
    key = `bcb_${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
    await pool.query(`UPDATE wp_sites SET status = 'active', key_prefix = $2, key_hash = $3, pairing_code_hash = NULL, site_url = 'https://kat.example.org', paired_at = now() WHERE id = $1`, [siteId, prefix, crypto.createHash('sha256').update(key).digest('hex')]);
    const report = {
      categories: [
        { id: 3, name: 'Einsätze', parent: 0 },
        { id: 9, name: 'Brandeinsätze', parent: 3 },
      ],
      cron: { mode: 'self', wp_cron_disabled: true, healthy: true, hint: '' },
      auto_update: true,
      author_mode: 'person',
      display: { info: 'banner', warning: 'popup', danger: 'both' },
      banner_auto: true,
      unbekannt: 'wird ignoriert',
    };
    const r = await anonymous.post('/bridge/report', report, auth());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, send_author: false });
    // Ohne gültigen Schlüssel keine Meldung, ungültige Werte werden abgewiesen
    expect((await anonymous.post('/bridge/report', report)).status).toBe(401);
    expect((await anonymous.post('/bridge/report', { cron: { mode: 'irgendwas' } }, auth())).status).toBe(400);
    const site = (await admin.get('/sites')).json.find((x: any) => x.id === siteId);
    expect(site.report.categories).toHaveLength(2);
    expect(site.report.cron.mode).toBe('self');
    expect(site.report.display.warning).toBe('popup');
    expect(site.report.unbekannt).toBeUndefined();
    expect(site.report_at).toBeTruthy();
    // Kategorien auch im Katalog der Automationen (Auswahl im Ausgang „Beitrag“)
    const cat = (await admin.get('/automations/catalog')).json;
    expect(cat.sites.find((x: any) => x.id === siteId).categories.map((c: any) => c.id)).toEqual([3, 9]);
  });

  it('Autorenname übertragen: nur mit Recht, Vorgabe aus', async () => {
    expect((await editor.put(`/sites/${siteId}/options`, { sendAuthor: true })).status).toBe(403);
    const r = await admin.put(`/sites/${siteId}/options`, { sendAuthor: true });
    expect(r.status).toBe(200);
    expect(r.json.send_author).toBe(true);
    expect((await anonymous.post('/bridge/report', {}, auth())).json.send_author).toBe(true);
  });

  it('Kategorie ist Teil der Fassung und geht mit Autor an die Bridge', async () => {
    const p = await editor.post('/posts', { title: 'Brand in Lagerhalle' });
    pid = p.json.id;
    let d = await cur();
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Brand in Lagerhalle', body: 'Text.', siteId, variants: { wordpress: { categories: [9, 3, 9] } } });
    d = await cur();
    expect(d.revision.variants.wordpress.categories).toEqual([3, 9]);
    const hashBefore = d.revision.content_hash;
    // Gleiche Auswahl in anderer Reihenfolge ist keine Änderung
    const same = await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Brand in Lagerhalle', body: 'Text.', siteId, variants: { wordpress: { categories: [9, 3] } } });
    expect(same.json.changed).toBe(false);
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: hashBefore, decision: 'approved' });
    // Andere Kategorie → neue Fassung, Freigabe entfällt
    const ch = await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Brand in Lagerhalle', body: 'Text.', siteId, variants: { wordpress: { categories: [3] } } });
    expect(ch.json.changed).toBe(true);
    expect(ch.json.approvalInvalidated).toBe(true);
    d = await cur();
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    const job = (await anonymous.get('/bridge/jobs', auth())).json.jobs.find((j: any) => j.blaulichtcms_post_id === pid);
    expect(job.post.categories).toEqual([3]);
    expect(job.author.name).toBe('Robin');
    expect(job.author.key).toMatch(/^[a-f0-9]{32}$/);
    // Schlüssel ist nicht die Konto-ID
    const uid = (await one<any>(`SELECT created_by FROM posts WHERE id = $1`, [pid]))!.created_by;
    expect(job.author.key).not.toContain(String(uid).replace(/-/g, '').slice(0, 12));
    await anonymous.post(`/bridge/jobs/${job.id}/result`, { status: 'published', remote_id: 11, url: 'https://kat.example.org/brand/' }, auth());
  });

  it('ohne „Autorenname übertragen“ geht kein Name an die Website', async () => {
    await admin.put(`/sites/${siteId}/options`, { sendAuthor: false });
    let d = await cur();
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Brand in Lagerhalle', body: 'Text, ergänzt.', siteId, variants: {} });
    d = await cur();
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    const job = (await anonymous.get('/bridge/jobs', auth())).json.jobs.find((j: any) => j.blaulichtcms_post_id === pid);
    expect(job.author).toBeUndefined();
    expect(job.post.categories).toBeUndefined();
    await anonymous.post(`/bridge/jobs/${job.id}/result`, { status: 'published', remote_id: 11, url: 'https://kat.example.org/brand/' }, auth());
  });

  it('Darstellung eines Hinweises ist Teil der Fassung und geht an die Bridge', async () => {
    const ends = new Date(Date.now() + 2 * 3600_000).toISOString();
    const b = await editor.post('/banners', { siteId, title: 'Unwetter', tone: 'danger', priority: 3, endsAt: ends, display: 'popup' });
    expect(b.status).toBe(200);
    expect(b.json.display).toBe('popup');
    expect((await editor.post('/banners', { siteId, title: 'Falsch', endsAt: ends, display: 'blinken' })).status).toBe(400);
    const list = async () => (await editor.get('/banners')).json.find((x: any) => x.id === b.json.id);
    let st = await list();
    await editor.post(`/banners/${st.id}/submit`);
    await approver.post(`/banners/${st.id}/approve`, { contentHash: st.content_hash });
    // Nur die Darstellung ändern → neue Fassung
    const u = await editor.put(`/banners/${st.id}`, { siteId, title: 'Unwetter', tone: 'danger', priority: 3, startsAt: st.starts_at, endsAt: st.ends_at, display: 'both' });
    expect(u.json.changed).toBe(true);
    st = await list();
    expect(st.state).toBe('draft');
    await editor.post(`/banners/${st.id}/submit`);
    await approver.post(`/banners/${st.id}/approve`, { contentHash: st.content_hash });
    await publisher.post(`/banners/${st.id}/publish`, { contentHash: st.content_hash });
    const job = (await anonymous.get('/bridge/jobs', auth())).json.jobs.find((j: any) => j.type === 'banner.upsert' && j.banner.id === st.id);
    expect(job.banner.display).toBe('both');
    // Ohne feste Darstellung bleibt die Prüfsumme im bisherigen Format (bestehende Freigaben gelten weiter)
    const { bannerHash } = await import('../src/routes/banners.js');
    const row = { site_id: siteId, title: 'x', text: '', tone: 'info', priority: 2, starts_at: ends, ends_at: ends, link_url: null, link_text: null };
    expect(bannerHash({ ...row, display: 'auto' })).toBe(bannerHash(row));
    expect(bannerHash({ ...row, display: 'popup' })).not.toBe(bannerHash(row));
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

  it('speichert Dashboards persönlich und als Rollenvorlage (Kennzahlen, Spalten, Handy)', async () => {
    const def = await editor.get('/dashboard/layout');
    expect(def.json.source).toBe('default');
    expect(def.json.layout.version).toBe(2);
    expect(def.json.layout.columns.map((c: any) => c.weight)).toEqual([5, 3]);
    // Rechte: Redaktion sieht die Kennzahl „Verbindungsfehler“ nicht, die Administration schon; Vorlagenliste nur für die Administration
    expect(def.json.widgets).toContain('badge_unreviewed');
    expect(def.json.widgets).not.toContain('badge_connection_errors');
    expect(def.json.layout.badges).not.toContain('badge_connection_errors');
    expect(def.json.templates).toBeUndefined();
    const adminDef = await admin.get('/dashboard/layout');
    expect(adminDef.json.widgets).toContain('badge_connection_errors');
    expect(adminDef.json.layout.badges).toContain('badge_connection_errors');
    expect(adminDef.json.templates).toEqual([]);

    const layout = { badges: ['badge_ready', 'badge_connection_errors', 'badge_approvals'], columns: [{ weight: 2, widgets: ['rss'] }, { weight: 5, widgets: ['approvals', 'media'] }, { weight: 3, widgets: [] }], mobile: ['approvals'] };
    // Vorlagen nur durch die Administration, nur für bekannte Rollen
    expect((await editor.put('/dashboard/layout', { scope: 'role', role: 'editor', layout })).status).toBe(403);
    expect((await editor.put('/dashboard/layout', { scope: 'all', layout })).status).toBe(403);
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'gibt-es-nicht', layout })).status).toBe(400);
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'editor', layout })).status).toBe(200);
    expect((await admin.get('/dashboard/layout')).json.templates).toEqual(['editor']);
    // Die Vorlage enthält alle Widgets; ausgeliefert wird nur, was die Person sehen darf
    const stored = (await one<any>(`SELECT value FROM settings WHERE key = 'dashboard.layouts'`))!.value;
    expect(stored.editor.badges).toEqual(layout.badges);
    const role = await editor.get('/dashboard/layout');
    expect(role.json.source).toBe('role');
    expect(role.json.layout).toEqual({ version: 2, badges: ['badge_ready', 'badge_approvals'], columns: layout.columns, mobile: ['approvals'] });
    // Andere Rollen bleiben beim Standard, bis es eine Vorlage für alle gibt
    expect((await publisher.get('/dashboard/layout')).json.source).toBe('default');
    expect((await admin.put('/dashboard/layout', { scope: 'all', layout: { badges: [], columns: [{ weight: 3, widgets: ['sites'] }], mobile: [] } })).status).toBe(200);
    const pub = await publisher.get('/dashboard/layout');
    expect(pub.json.source).toBe('shared');
    expect(pub.json.layout.columns).toEqual([{ weight: 3, widgets: ['sites'] }]);
    expect((await editor.get('/dashboard/layout')).json.source).toBe('role');

    // Persönlich speichern: alles in einem Aufruf; Unbekanntes und Unerlaubtes fällt still weg
    const mineBody = { badges: ['badge_connection_errors', 'badge_uploads', 'gibt-es-nicht'], columns: [{ weight: 5, widgets: ['rss', 'gibt-es-nicht', 'badge_uploads'] }, { weight: 2, widgets: ['uploads'] }], mobile: ['rss', 'gibt-es-nicht'] };
    const saved = await editor.put('/dashboard/layout', { scope: 'personal', layout: mineBody });
    expect(saved.status).toBe(200);
    const mine = await editor.get('/dashboard/layout');
    expect(mine.json.source).toBe('personal');
    expect(mine.json.layout).toEqual({ version: 2, badges: ['badge_uploads'], columns: [{ weight: 5, widgets: ['rss'] }, { weight: 2, widgets: ['uploads'] }], mobile: ['rss'] });
    expect(saved.json.layout).toEqual(mine.json.layout);
    const pref = await one<any>(`SELECT preferences->'dashboard' AS d FROM users WHERE email = 'redaktion@example.org'`);
    expect(JSON.stringify(pref!.d)).not.toMatch(/connection_errors|gibt-es-nicht/);

    // Formfehler werden abgewiesen, der gespeicherte Stand bleibt
    const bad = async (l: any) => (await editor.put('/dashboard/layout', { scope: 'personal', layout: l })).status;
    expect(await bad({ ...mineBody, columns: Array.from({ length: 5 }, () => ({ weight: 3, widgets: [] })) })).toBe(400);
    expect(await bad({ ...mineBody, columns: [{ weight: 4, widgets: [] }] })).toBe(400);
    expect(await bad({ ...mineBody, columns: [{ weight: 3, widgets: ['rss'] }, { weight: 3, widgets: ['rss'] }] })).toBe(400);
    expect(await bad({ ...mineBody, columns: [] })).toBe(400);
    expect(await bad({ badges: [] })).toBe(400);
    expect(await bad('kaputt')).toBe(400);
    expect((await editor.get('/dashboard/layout')).json.layout).toEqual(mine.json.layout);

    // Layout aus der Zeit vor 0.2.4 in der Datenbank: wird beim Laden umgestellt, ohne die Daten anzufassen
    const legacy = { desktop: [{ id: 'rss', size: 'l' }, { id: 'approvals', size: 's' }, { id: 'weg', size: 'm' }], mobile: ['approvals'] };
    await pool.query(`UPDATE users SET preferences = preferences || jsonb_build_object('dashboard', $1::jsonb) WHERE email = 'redaktion@example.org'`, [JSON.stringify(legacy)]);
    const old = await editor.get('/dashboard/layout');
    expect(old.json.source).toBe('personal');
    expect(old.json.layout.columns).toEqual([{ weight: 5, widgets: ['rss'] }, { weight: 3, widgets: ['approvals'] }]);
    expect(old.json.layout.mobile).toEqual(['approvals']);
    expect(old.json.layout.badges).toEqual(['badge_approvals', 'badge_unreviewed', 'badge_ready', 'badge_banners', 'badge_uploads']);
    // … und eine ältere Oberfläche darf im alten Format speichern
    expect((await editor.put('/dashboard/layout', { scope: 'personal', layout: legacy })).status).toBe(200);
    expect((await editor.get('/dashboard/layout')).json.layout.columns).toEqual(old.json.layout.columns);
    // Alte Vorlage in den Einstellungen
    await setSettings({ 'dashboard.layouts': { ...stored, '*': legacy } } as any);
    expect((await publisher.get('/dashboard/layout')).json.layout.columns).toEqual(old.json.layout.columns);

    // Zurücksetzen auf die Vorlage; Vorlagen wieder entfernen
    await editor.put('/dashboard/layout', { scope: 'personal', layout: null });
    expect((await editor.get('/dashboard/layout')).json.source).toBe('role');
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'editor', layout: null })).status).toBe(200);
    expect((await editor.get('/dashboard/layout')).json.source).toBe('shared');
    expect((await admin.put('/dashboard/layout', { scope: 'all', layout: null })).status).toBe(200);
    expect((await editor.get('/dashboard/layout')).json.source).toBe('default');
    expect((await admin.get('/dashboard/layout')).json.templates).toEqual([]);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'dashboard.shared_saved'`)).not.toBeNull();

    // Daten: Verbindungsfehler nur mit dem Recht „Verbindungen verwalten“
    const d = await editor.get('/dashboard');
    expect(Array.isArray(d.json.rss)).toBe(true);
    expect(d.json.confirmedAt).toBeTruthy();
    expect(d.json.connectionErrors).toBeUndefined();
    expect(typeof (await admin.get('/dashboard')).json.connectionErrors).toBe('number');
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
    const f = path.join(process.env.BLAULICHTCMS_DATA_DIR!, `pdf-${crypto.randomUUID()}.pdf`);
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
      // Kein Reverse-DNS auf die Client-IP: unter Windows dauert er für 127.0.0.1 teils fast 2 s – länger als das kurze
      // Socket-Timeout dieser Tests (1,5 s), dann scheitert der Versand vor dem Gruß („Greeting never received“)
      disableReverseLookup: true,
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
    process.env.BLAULICHTCMS_SMTP_TIMEOUT_MS = '1500';
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
    // Ohne Verschlüsselung keine Anmeldung; Versandeinstellungen nicht über die allgemeine Route (#100)
    expect((await admin.put('/warning-settings', { host: '127.0.0.1', port, security: 'none', user: 'postfach', password: 'geheim', from: 'blaulichtcms@example.org', testMode: true, testRecipient: TEST_BOX })).status).toBe(400);
    expect((await admin.put('/warning-settings', { host: '127.0.0.1', port, security: 'foo', user: '', from: 'blaulichtcms@example.org', testMode: true, testRecipient: TEST_BOX })).status).toBe(400);
    expect((await admin.patch('/settings', { 'smtp.security': 'foo' })).status).toBe(400);
    expect((await admin.patch('/settings', { 'warnings.test_mode': false })).status).toBe(400);
    const s = await admin.put('/warning-settings', { host: '127.0.0.1', port, security: 'none', user: '', from: 'blaulichtcms@example.org', testMode: true, testRecipient: TEST_BOX });
    expect(s.status).toBe(200);
  });

  it('zeigt ohne Lese-Rechte keine Dashboard-Widgets – auch nicht aus Vorlagen oder eigenen Angaben', async () => {
    // „Warnentwurf“ hat weder „Beiträge ansehen“ noch „Medien sichten“
    const lone = author;
    const full = { badges: ['badge_approvals', 'badge_unreviewed', 'badge_connection_errors'], columns: [{ weight: 5, widgets: ['media', 'approvals'] }, { weight: 3, widgets: ['rss', 'uploads'] }], mobile: ['media', 'rss'] };
    const empty = { version: 2, badges: [], columns: [{ weight: 5, widgets: [] }, { weight: 3, widgets: [] }], mobile: [] };
    const def = await lone.get('/dashboard/layout');
    expect(def.json.widgets).toEqual([]);
    expect(def.json.layout.badges).toEqual([]);
    expect(def.json.layout.columns.flatMap((c: any) => c.widgets)).toEqual([]);
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'warning_author', layout: full })).status).toBe(200);
    const tpl = await lone.get('/dashboard/layout');
    expect(tpl.json.source).toBe('role');
    expect(tpl.json.layout).toEqual(empty);
    expect((await lone.put('/dashboard/layout', { scope: 'personal', layout: full })).status).toBe(200);
    const mine = await lone.get('/dashboard/layout');
    expect(mine.json.source).toBe('personal');
    expect(mine.json.layout).toEqual(empty);
    const d = (await lone.get('/dashboard')).json;
    expect(Object.keys(d)).toEqual(['confirmedAt']);
    await lone.put('/dashboard/layout', { scope: 'personal', layout: null });
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'warning_author', layout: null })).status).toBe(200);
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

  it('Vier-Augen-Prinzip: eigener oder selbst eingereichter Warnentwurf nicht selbst freigebbar (#153)', async () => {
    await admin.patch('/settings', { 'editorial.four_eyes': true });
    try {
      const c = await warnApprover.post('/warnings', { kind: 'initial' });
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      const wid = c.json.id;
      let d = (await warnApprover.get(`/warnings/${wid}`)).json;
      expect((await warnApprover.put(`/warnings/${wid}/revision`, { baseRevision: d.revision.number, data: { ...d.revision.data, ...data }, responsibilityIds: [respId], keywordId: null, answers: {} })).status).toBe(200);
      d = (await warnApprover.get(`/warnings/${wid}`)).json;
      expect((await warnApprover.post(`/warnings/${wid}/level`, { revision: d.revision.number, level: 3, reason: 'Fiktive Lage ohne Stichwort.' })).status).toBe(200);
      d = (await warnApprover.get(`/warnings/${wid}`)).json;
      expect((await warnApprover.post(`/warnings/${wid}/submit`, { revision: d.revision.number })).status).toBe(200);
      const own = await warnApprover.post(`/warnings/${wid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
      expect(own.status).toBe(403);
      // Entwurf von anderer Person, Stufe von der freigebenden Person bestätigt: erlaubt, aber nicht, wenn sie selbst einreicht
      const c2 = await author.post('/warnings', { kind: 'initial' });
      const w2 = c2.json.id;
      await saveRev(w2, { data, responsibilityIds: [respId], keywordId: null });
      d = await detail(w2);
      expect((await warnApprover.post(`/warnings/${w2}/level`, { revision: d.revision.number, level: 3, reason: 'Fiktive Lage ohne Stichwort.' })).status).toBe(200);
      d = await detail(w2);
      expect((await warnApprover.post(`/warnings/${w2}/submit`, { revision: d.revision.number })).status).toBe(200);
      expect((await warnApprover.post(`/warnings/${w2}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(403);
      await one(`UPDATE warning_revisions SET submitted_by = (SELECT id FROM users WHERE email = 'warnentwurf@example.org') WHERE warning_id = $1`, [w2]);
      expect((await warnApprover.post(`/warnings/${w2}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(200);
    } finally {
      await admin.patch('/settings', { 'editorial.four_eyes': false });
    }
  });

  it('gleichzeitige Freigaben: genau eine Freigabe und eine PDF-Datei (#179)', async () => {
    const wid = (await author.post('/warnings', { kind: 'initial' })).json.id;
    await saveRev(wid, { data, responsibilityIds: [respId], keywordId: null });
    let d = await detail(wid);
    await warnApprover.post(`/warnings/${wid}/level`, { revision: d.revision.number, level: 3, reason: 'Fiktive Lage ohne Stichwort.' });
    d = await detail(wid);
    expect((await author.post(`/warnings/${wid}/submit`, { revision: d.revision.number })).status).toBe(200);
    const body = { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' };
    const res = await Promise.all([warnApprover.post(`/warnings/${wid}/decision`, body), warnApprover.post(`/warnings/${wid}/decision`, body)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await one<any>(`SELECT count(*)::int AS n FROM warning_approvals WHERE warning_id = $1 AND decision = 'approved'`, [wid]))!.n).toBe(1);
    expect(fs.readdirSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'warnings', wid))).toHaveLength(1);
    // Die Datenbank verhindert eine zweite Freigabe derselben Fassung auch ohne die Sperre
    const a = (await one<any>(`SELECT * FROM warning_approvals WHERE warning_id = $1`, [wid]))!;
    await expect(pool.query(`INSERT INTO warning_approvals (warning_id, revision_id, content_hash, decision) VALUES ($1,$2,$3,'approved')`, [wid, a.revision_id, a.content_hash])).rejects.toThrow(/warning_approvals_active_uq/);
  });

  it('Liste: Zustand aus einer Abfrage stimmt mit der Einzelansicht überein (#184)', async () => {
    const list = (await author.get('/warnings')).json;
    expect(list.length).toBeGreaterThan(3);
    for (const w of list) expect(w.state, w.case_no).toBe((await detail(w.id)).state);
    expect(list[0]).not.toHaveProperty('rev_hash');
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
    expect(inbox[0].raw.replace(/\r?\n /g, ' ')).toMatch(new RegExp(`X-BlaulichtCMS-Pdf-Sha256:\\s+${d.approval.pdf_sha256}`, 'i'));
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
  const graph: { posts: any[]; calls: string[]; failNext: null | 'reject' | 'server_after_create'; containers: Record<string, string>; imageUrls: string[] } = { posts: [], calls: [], failNext: null, containers: {}, imageUrls: [] };
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
          if (p.get('image_url')) graph.imageUrls.push(p.get('image_url')!);
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
    process.env.BLAULICHTCMS_META_GRAPH_URL = `${base}/fb`;
    process.env.BLAULICHTCMS_IG_GRAPH_URL = `${base}/ig`;
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
    expect(fe2Token).toMatch(/^bcfe2_/);
    const d = await admin.get(`/connections/${fe2Id}`);
    expect(JSON.stringify(d.json)).not.toContain(fe2Token);
    expect(d.json.inbound_url).toBe(`https://blaulichtcms.example.org/api/v1/inbound/fe2/${fe2Id}`);
    // Aktivieren ohne Test geht nicht
    expect((await admin.post(`/connections/${fe2Id}/activate`)).status).toBe(409);
    const t1 = await admin.post(`/connections/${fe2Id}/test`);
    expect(t1.json.ok).toBe(false);
  });

  it('FE2: Authentisierung, Vorschau vor Aktivierung, Allowlist ohne vertrauliche Inhalte', async () => {
    expect((await inbound(alarm('E-1'), 'bcfe2_falsch')).status).toBe(401);
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
    expect((await inbound(alarm('E-102'))).status).toBe(401);
    // … und verlangt einen neuen Test mit einer Meldung über den neuen Schlüssel, bevor wieder Entwürfe entstehen
    expect((await admin.post(`/connections/${fe2Id}/activate`)).status).toBe(409);
    expect((await inbound(alarm('E-102'), rot.json.token, { 'x-blaulichtcms-test': '1' })).json.outcome).toBe('test');
    expect((await admin.post(`/connections/${fe2Id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${fe2Id}/activate`)).status).toBe(200);
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
    const tokensBefore = (await one<any>(`SELECT count(*)::int AS n FROM media_tokens`))!.n;
    const t = await admin.post(`/connections/${igId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(graph.calls.filter((x) => x === 'POST /ig/IG1/media_publish').length).toBe(0);
    expect(t.json.account.username).toBe('test_konto');
    // Testbild ist das eingebaute neutrale Bild, kein Upload (#95)
    expect(graph.imageUrls.length).toBe(1);
    const testPath = new URL(graph.imageUrls[0]).pathname;
    expect(testPath).toBe('/api/v1/connection-test-image.jpg');
    expect((await one<any>(`SELECT count(*)::int AS n FROM media_tokens`))!.n).toBe(tokensBefore);
    const ti = await anonymous.raw('GET', '/connection-test-image.jpg');
    expect(ti.status).toBe(200);
    expect(ti.headers['content-type']).toContain('image/jpeg');
    await admin.post(`/connections/${igId}/activate`);
  });

  it('Kanäle sind Teil der Fassung; nur betroffener Kanal wird wiederholt; unbekanntes Ergebnis wird zuerst geprüft', async () => {
    const { runSocialPublication } = await import('../src/connections/social.js');
    const p = await editor.post('/posts', { title: 'Tag der offenen Tür (fiktiv)', kind: 'event' });
    spPostId = p.json.id;
    const img = await one<any>(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' AND has_public AND deleted_at IS NULL AND cardinality(sensitive_flags) = 0 ORDER BY created_at, id LIMIT 1`);
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

  it('Zurückziehen auf sozialen Kanälen: Facebook per API gelöscht, Instagram von Hand mit Bestätigung (#114)', async () => {
    expect((await editor.post(`/posts/${spPostId}/social/remove`, { reason: 'Personenbezug entfernen' })).status).toBe(403);
    const fbRow = await one<any>(`SELECT sp.remote_id FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1 AND c.kind = 'facebook' AND sp.status = 'published'`, [spPostId]);
    const r = await publisher.post(`/posts/${spPostId}/social/remove`, { reason: 'Personenbezug entfernen' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const fb = r.json.items.find((x: any) => x.kind === 'facebook');
    const ig = r.json.items.find((x: any) => x.kind === 'instagram');
    expect(fb.result).toBe('removed');
    expect(graph.calls).toContain(`DELETE /fb/${fbRow.remote_id}`);
    expect(ig.result).toBe('manual');
    expect(ig.url).toContain('instagram.example');
    const d = (await publisher.get(`/posts/${spPostId}`)).json;
    expect(d.social.find((s: any) => s.kind === 'instagram').removal_status).toBe('manual');
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action IN ('social.removed','social.removal_manual') AND object_id = $1`, [spPostId]))!.n).toBe(2);
    expect((await publisher.post(`/social-publications/${ig.id}/confirm-removed`)).status).toBe(200);
    expect((await publisher.post(`/social-publications/${ig.id}/confirm-removed`)).status).toBe(400);
    expect((await publisher.post(`/posts/${spPostId}/social/remove`, { reason: 'Nochmal' })).status).toBe(400);
  });

  it('Instagram-Wiederholung legt bei abgelaufenem Container einen neuen an (#149)', async () => {
    const { runSocialPublication } = await import('../src/connections/social.js');
    const p = await editor.post('/posts', { title: 'Container-Test (fiktiv)' });
    const img = await one<any>(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' AND has_public AND deleted_at IS NULL AND cardinality(sensitive_flags) = 0 ORDER BY created_at, id LIMIT 1`);
    let d = (await editor.get(`/posts/${p.json.id}`)).json;
    await editor.put(`/posts/${p.json.id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Container-Test.', excerpt: '', mediaIds: [img.id], socialTargets: [igId] });
    d = (await editor.get(`/posts/${p.json.id}`)).json;
    await editor.post(`/posts/${p.json.id}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${p.json.id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    const appr = await one<any>(`SELECT id FROM approvals WHERE revision_id = $1 AND decision = 'approved' AND revoked_at IS NULL`, [d.revision.id]);
    // Fehlgeschlagener früherer Versuch mit verfallenem Container (Testdienst meldet unbekannte Container als ERROR)
    const sp = await one<any>(
      `INSERT INTO social_publications (post_id, revision_id, approval_id, connection_id, marker, status, container_id, error) VALUES ($1,$2,$3,$4,'m','failed','C-ALT','Instagram-Container nicht bereit (Status EXPIRED).') RETURNING id`,
      [p.json.id, d.revision.id, appr.id, igId],
    );
    expect((await publisher.post(`/social-publications/${sp.id}/retry`)).status).toBe(200);
    await runSocialPublication(sp.id);
    const row = await one<any>(`SELECT * FROM social_publications WHERE id = $1`, [sp.id]);
    expect(row.status, row.error).toBe('published');
    expect(row.container_id).not.toBe('C-ALT');
    // Container mit Status ERROR wird ebenfalls ersetzt
    await pool.query(`UPDATE social_publications SET status = 'failed', container_id = 'C900', remote_id = NULL WHERE id = $1`, [sp.id]);
    const before = graph.calls.filter((x) => x === 'POST /ig/IG1/media').length;
    await publisher.post(`/social-publications/${sp.id}/retry`);
    await runSocialPublication(sp.id);
    expect((await one<any>(`SELECT status FROM social_publications WHERE id = $1`, [sp.id]))!.status).toBe('published');
    expect(graph.calls.filter((x) => x === 'POST /ig/IG1/media').length).toBe(before + 1);
  });

  it('Manueller Export und zeitlich begrenzte Medien-URL', async () => {
    const p = await editor.post('/posts', { title: 'Export-Test (fiktiv)' });
    const img = await one<any>(`SELECT id FROM media WHERE status = 'ready' AND kind = 'image' AND has_public AND deleted_at IS NULL AND cardinality(sensitive_flags) = 0 ORDER BY created_at, id LIMIT 1`);
    let d = (await editor.get(`/posts/${p.json.id}`)).json;
    await editor.put(`/posts/${p.json.id}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Text für den Export.', excerpt: '', mediaIds: [img.id] });
    d = (await editor.get(`/posts/${p.json.id}`)).json;
    expect((await publisher.get(`/posts/${p.json.id}/social-export`)).status).toBe(409);
    await editor.post(`/posts/${p.json.id}/submit`, { revision: d.revision.number });
    await approver.post(`/posts/${p.json.id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    const ex = await publisher.get(`/posts/${p.json.id}/social-export`);
    expect(ex.json.facebook).toContain('Text für den Export.');
    expect(ex.json.files.length).toBe(1);
    // Neutraler Dateiname aus dem Beitragstitel statt Originalname (#137)
    expect(ex.json.files[0].name).toBe('export-test-fiktiv-1.jpg');
    const path = new URL(ex.json.files[0].url).pathname;
    const f = await anonymous.raw('GET', path);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toContain('image/jpeg');
    await pool.query(`UPDATE media_tokens SET expires_at = now() - interval '1 second'`);
    expect((await anonymous.raw('GET', path)).status).toBe(404);
  });

  let wfId = '';
  it('Warnfeed: nur HTTPS-Quellen (http nur für localhost), kein Auto-Banner bei Altbestand mit http (#108)', async () => {
    expect((await admin.post('/connections', { kind: 'warnfeed', name: 'Unverschlüsselt', config: { format: 'cap', url: 'http://warn.example.invalid/cap.xml' } })).status).toBe(400);
    expect((await admin.post('/connections', { kind: 'warnfeed', name: 'NINA-Spiegel', config: { format: 'nina', baseUrl: 'http://warn.example.invalid/api' } })).status).toBe(400);
    // Altbestand: http-Quelle mit eingeschalteten automatischen Bannern
    const site = await one<any>(`SELECT id FROM wp_sites WHERE status = 'active' LIMIT 1`);
    const old = await one<any>(
      `INSERT INTO connections (kind, name, status, config) VALUES ('warnfeed', 'Alt-Feed (http)', 'active', $1) RETURNING *`,
      [JSON.stringify({ format: 'cap', url: 'http://warn.example.invalid/cap.xml', autoBanner: true, bannerSiteId: site.id, review: { approvedAt: new Date().toISOString() } })],
    );
    const { autoBannerAllowed, refreshWarnfeed } = await import('../src/connections/warnfeed.js');
    expect(autoBannerAllowed(old)).toBe(false);
    await refreshWarnfeed(old).catch(() => null); // Abruf scheitert (Adresse existiert nicht), Abschalten passiert vorher
    const after = await one<any>(`SELECT config FROM connections WHERE id = $1`, [old.id]);
    expect(after.config.autoBanner).toBe(false);
    expect((await admin.get(`/connections/${old.id}`)).json.insecure_source).toBe(true);
    await pool.query(`UPDATE connections SET status = 'revoked' WHERE id = $1`, [old.id]);
  });

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
    // Noch gelieferte Warnungen gelten als gesehen (Löschfrist, #180)
    expect((await one<any>(`SELECT last_seen_at FROM official_warnings WHERE connection_id = $1 AND identifier = 'W-2'`, [wfId]))!.last_seen_at).toBeTruthy();
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
    expect(new URL(start.json.url).searchParams.get('redirect_uri')).toBe('https://blaulichtcms.example.org/api/v1/connections/oauth/callback');
    // Gefälschter state wird abgewiesen
    const bad = await anonymous.raw('GET', `/connections/oauth/callback?state=${c.json.id}.falsch&code=x`);
    expect(bad.status).toBe(302);
    expect(decodeURIComponent(bad.headers.location as string)).toContain('ungültig');
    const s2 = await admin.post(`/connections/${c.json.id}/oauth/start`);
    const state2 = new URL(s2.json.url).searchParams.get('state')!;
    void state;
    const cb = await anonymous.raw('GET', `/connections/oauth/callback?state=${encodeURIComponent(state2)}&code=abc`);
    expect(cb.status).toBe(302);
    expect(decodeURIComponent(cb.headers.location as string)).toMatch(/Angemeldet – bitte (die gefundene Seite|eine von \d+ Seiten) wählen/);
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
    const offer = (k: string, v = '0.3.0') => anonymous.get('/bridge/update', { authorization: `Bearer ${k}`, 'x-blaulichtcms-bridge-version': v });
    expect((await offer(live.key)).json.available).toBe(false);
    expect((await offer(test.key)).json.available).toBe(false);
    expect((await editor.put(`/sites/${test.id}/update-channel`, { channel: 'test' })).status).toBe(403);
    await admin.put(`/sites/${test.id}/update-channel`, { channel: 'test' });
    const o = (await offer(test.key)).json;
    expect(o.available).toBe(true);
    expect(o.version).toBe('0.9.1');
    expect(o.package).toMatch(/^https:\/\/blaulichtcms\.example\.org\/api\/v1\/bridge\/update\/package\?/);
    const path = new URL(o.package).pathname + new URL(o.package).search;
    const dl = await anonymous.raw('GET', path);
    expect(dl.status).toBe(200);
    expect(crypto.createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(o.sha256);
    expect((await anonymous.raw('GET', path.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).status).toBe(403);
    // Freigabe ohne Rückmeldung der Testwebsite mit der neuen Version → abgelehnt
    const rel = await admin.post('/sites/bridge-release', { version: '0.9.1', note: 'Auf Testseite geprüft.' });
    expect(rel.status).toBe(409);
    // Testwebsite meldet nach dem Update die neue Version (Kopplung blieb erhalten)
    expect((await offer(test.key, '0.9.1')).status).toBe(200);
    expect((await admin.post('/sites/bridge-release', { version: '0.9.1', note: 'Auf Testseite geprüft, Theme unverändert.' })).status).toBe(200);
    expect((await offer(live.key)).json.available).toBe(true);
    const st = (await admin.get('/sites/bridge-release')).json;
    expect(st.releases[0].tested_on_name).toBe('Update-Testseite');
    // Code-Signatur (#107): ohne hinterlegten Schlüssel Rückfallbetrieb, sonst gültig signiert
    expect(['not_configured', 'valid']).toContain(st.bundled.signature.state);
    expect(o.signed).toBe(st.bundled.signature.state === 'valid');
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
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'mig-'));
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
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'vid-'));
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
    // media.strip_location: auch das Original ohne Standort-Metadaten und Daten-/Untertitelspuren (#119)
    expect(row.location_stripped_at).not.toBeNull();
    expect(streams(mediaPaths.original(m.id))).toEqual(['video']);
    expect(execFileSync('ffprobe', ['-v', 'error', '-show_format', mediaPaths.original(m.id)], { encoding: 'utf8' })).not.toContain('location');
  });

  it('öffentliche Fassung und Vorschau nutzen nur die erste Videospur und eine Tonspur (#150)', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'vid-'));
    const src = path.join(dir, 'zwei.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=160x120:rate=5', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=240x320:rate=5', '-f', 'lavfi', '-i', 'sine=duration=1', '-f', 'lavfi', '-i', 'sine=duration=1:frequency=880', '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    const streams = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', f], { encoding: 'utf8' })).streams;
    expect(streams(src).filter((s: any) => s.codec_type === 'video')).toHaveLength(2);
    const p = await editor.post('/posts', { title: 'Videotest Spuren' });
    const c = await editor.post(`/posts/${p.json.id}/collect`, {});
    const token = c.json.url.split('/u/')[1];
    const mp = multipart({ name: 'zwei.mp4', data: fs.readFileSync(src), type: 'video/mp4' });
    expect((await anonymous.raw('POST', `/public/upload/${token}`, { payload: mp.payload, headers: mp.headers })).status).toBe(200);
    const m = await one<any>(`SELECT id FROM media WHERE original_name = 'zwei.mp4' ORDER BY created_at DESC LIMIT 1`);
    expect(await processMedia(m.id)).toBe('ready');
    const pub = streams(mediaPaths.publicFile(m.id, 'mp4'));
    expect(pub.map((s: any) => s.codec_type)).toEqual(['video', 'audio']);
    expect(pub[0].width).toBe(160);
    // Vorschau aus der ersten (querformatigen) Spur, nicht aus der größeren zweiten (hochformatigen)
    const prev = await sharp(mediaPaths.preview(m.id)).metadata();
    expect(prev.width!).toBeGreaterThan(prev.height!);
    // Ohne Ton veröffentlichen (#118): Umverpacken im Hintergrund, danach nur noch die Videospur
    const na = await editor.patch(`/media/${m.id}/privacy`, { stripAudio: true });
    expect(na.status).toBe(200);
    expect(na.json.rendering).toBe(true);
    expect((await editor.patch(`/media/${m.id}/privacy`, { redactions: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] })).status).toBe(400);
    const { renderPublic } = await import('../src/media/privacy.js');
    expect(await renderPublic(m.id)).toBe(true);
    expect(streams(mediaPaths.publicFile(m.id, 'mp4')).map((s: any) => s.codec_type)).toEqual(['video']);
    await pool.query(`DELETE FROM jobs WHERE kind = 'media.render_public'`);
  });

  it('zu lange Videos werden abgewiesen (Ressourcenschutz)', async () => {
    await setSettings({ 'media.max_video_minutes': 0 } as any);
    const { getSettings } = await import('../src/lib/settings.js');
    await getSettings(true);
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'vid-'));
    const src = path.join(dir, 'lang.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=160x120:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    const p = await editor.post('/posts', { title: 'Videotest Länge' });
    const c = await editor.post(`/posts/${p.json.id}/collect`, {});
    const mp = multipart({ name: 'lang.mp4', data: fs.readFileSync(src), type: 'video/mp4' });
    await anonymous.raw('POST', `/public/upload/${c.json.url.split('/u/')[1]}`, { payload: mp.payload, headers: mp.headers });
    const m = await one<any>(`SELECT id FROM media WHERE original_name = 'lang.mp4' ORDER BY created_at DESC LIMIT 1`);
    expect(await processMedia(m.id)).toBe('blocked');
    expect((await one<any>(`SELECT reject_reason, reject_step FROM media WHERE id = $1`, [m.id]))).toMatchObject({ reject_step: 'limits' });
    expect((await one<any>(`SELECT reject_reason FROM media WHERE id = $1`, [m.id]))!.reject_reason).toContain('länger als');
    await setSettings({ 'media.max_video_minutes': 30 } as any);
    await getSettings(true);
  });

  it('Geheimnisse erscheinen nie in API-Antworten, Protokollen oder Audit', async () => {
    const tokens = ['EAAG-geheimer-Seitentoken', 'IGQ-geheimer-token', 'bcfe2_'];
    const audit = await one<any>(`SELECT string_agg(details::text, ' ') AS t FROM audit_events`);
    for (const t of tokens.slice(0, 2)) expect(audit!.t ?? '').not.toContain(t);
    const settings = await admin.get('/settings');
    expect(JSON.stringify(settings.json)).not.toMatch(/password_secret_id|geheim/);
    const sec = await one<any>(`SELECT string_agg(ciphertext, '') AS c FROM secrets`);
    for (const t of tokens.slice(0, 2)) expect(sec!.c).not.toContain(t);
  });
});

describe('Einmaliger Medienimport (M4, Austauschformat)', () => {
  it('Probelauf ohne Schreiben, Prüfsummen, Übernahme, Mengenabgleich, Altlink-Weiterleitung, keine Duplikate', async () => {
    const imp = await import('../src/ops/import.js');
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'import-'));
    fs.mkdirSync(path.join(dir, 'files'));
    const files: any[] = [];
    for (let i = 0; i < 3; i++) {
      const buf = await sharp({ create: { width: 400 + i, height: 300, channels: 3, background: { r: 40 * i, g: 90, b: 160 } } }).jpeg().toBuffer();
      fs.writeFileSync(path.join(dir, 'files', `bild-${i}.jpg`), buf);
      files.push({ ref: `m${i}`, file: `files/bild-${i}.jpg`, original_name: `bild-${i}.jpg`, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), selection: i === 0 ? 'selected' : 'pending' });
    }
    const manifest = {
      format: 'blaulichtcms-import/1',
      source: 'testquelle',
      collections: [
        { ref: 'c1', title: 'Übernommene Sammlung (fiktiv)', media: files.slice(0, 2), links: [{ ref: 'l1', token: 'alter-link-token-0001', expires_at: new Date(Date.now() + 5 * 86400_000).toISOString() }, { ref: 'l2', token: 'alter-link-token-0002', expires_at: new Date(Date.now() - 86400_000).toISOString() }] },
        // Altsystem kennt nur die Prüfsumme des Tokens (wie LiFeOS)
        { ref: 'c2', title: 'Zweite Sammlung (fiktiv)', media: files.slice(2), links: [{ ref: 'l3', token_sha256: crypto.createHash('sha256').update('alter-link-token-0003').digest('hex'), expires_at: new Date(Date.now() + 3 * 86400_000).toISOString() }] },
      ],
    };
    // Fehlerhafte Prüfsumme → Probelauf meldet Problem, Übernahme verweigert
    const bad = structuredClone(manifest);
    bad.collections[0].media[1].sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(bad));
    const colsBefore = (await one<any>(`SELECT count(*)::int AS n FROM collections`))!.n;
    const inv0 = await imp.inventory(dir);
    expect(inv0.report.problems[0]).toContain('Prüfsumme weicht ab');
    await expect(imp.commitImport(dir)).rejects.toThrow(/Probelauf/);
    expect((await one<any>(`SELECT count(*)::int AS n FROM collections`))!.n).toBe(colsBefore);
    // Ungültiges Datum → schon der Probelauf bricht mit klarer Meldung ab (#154)
    const badDate = structuredClone(manifest);
    badDate.collections[0].links[0].expires_at = '2026-13-01';
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(badDate));
    await expect(imp.inventory(dir)).rejects.toThrow(/Manifest ungültig.*expires_at/);
    await expect(imp.commitImport(dir)).rejects.toThrow(/Manifest ungültig/);
    expect((await one<any>(`SELECT count(*)::int AS n FROM collections`))!.n).toBe(colsBefore);
    // Altlink mit Frist in ferner Zukunft wird auf die Höchstdauer gekürzt (#154)
    manifest.collections[1].links[0].expires_at = new Date(Date.now() + 4 * 365 * 86400_000).toISOString();
    // Korrektes Manifest
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const inv = await imp.inventory(dir);
    expect(inv.report).toMatchObject({ collections: 2, media: 3, links: { total: 3, stillValid: 2, expiredOrRevoked: 1, capped: 1 }, problems: [] });
    expect((await one<any>(`SELECT count(*)::int AS n FROM collections`))!.n).toBe(colsBefore);
    const r = await imp.commitImport(dir);
    expect(r.created).toEqual({ collections: 2, media: 3, links: 2, skippedExisting: 0 });
    await processAllQuarantine();
    const v = await imp.verifyImport(dir);
    expect(v.ok).toBe(true);
    expect(v.collections.map((c) => c.ready)).toEqual([2, 1]);
    expect((await one<any>(`SELECT selection FROM media WHERE client_key = 'import:testquelle:m0'`))!.selection).toBe('selected');
    // Wiederholung legt nichts doppelt an
    const again = await imp.commitImport(dir);
    expect(again.created).toEqual({ collections: 0, media: 0, links: 0, skippedExisting: 3 });
    // Altlink → befristete Weiterleitung auf den neuen Link
    const legacy = (t: string) => app.inject({ method: 'GET', url: `/l/${t}` }).then((r) => ({ status: r.statusCode, headers: r.headers }));
    const fwd = await legacy('alter-link-token-0001');
    expect(fwd.status).toBe(302);
    expect(fwd.headers.location).toMatch(/^https:\/\/blaulichtcms\.example\.org\/u\/[A-Za-z0-9_-]+$/);
    const newToken = (fwd.headers.location as string).split('/u/')[1];
    expect((await anonymous.get(`/public/upload/${newToken}`)).status).toBe(200);
    expect((await legacy('alter-link-token-0002')).status).toBe(410);
    const fwd3 = await legacy('alter-link-token-0003');
    expect(fwd3.status).toBe(302);
    expect((await anonymous.get(`/public/upload/${(fwd3.headers.location as string).split('/u/')[1]}`)).status).toBe(200);
    const capped = await one<any>(`SELECT l.expires_at FROM upload_links l JOIN legacy_links g ON g.link_id = l.id WHERE g.old_token_hash = $1`, [crypto.createHash('sha256').update('alter-link-token-0003').digest('hex')]);
    expect(new Date(capped.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 90 * 86400_000 + 60_000);
    await pool.query(`UPDATE legacy_links SET expires_at = now() - interval '1 second'`);
    expect((await legacy('alter-link-token-0001')).status).toBe(410);
    const runs = await one<any>(`SELECT count(*)::int AS n FROM import_runs WHERE source = 'testquelle'`);
    expect(runs!.n).toBeGreaterThanOrEqual(5);
  });
});

describe('Auftragswarteschlange (Lease)', () => {
  it('laufende Aufträge werden per Heartbeat gehalten und vom eigenen Worker nie doppelt beansprucht', async () => {
    const q = await import('../src/jobs/queue.js');
    await pool.query(`UPDATE jobs SET status = 'done' WHERE status IN ('queued','running')`);
    const id = await q.enqueue('test.lang', {}, { dedupKey: 'lease-test' });
    const [job] = await q.claimJobs(1);
    expect(String(job!.id)).toBe(String(id));
    // Lease abgelaufen, Auftrag läuft aber noch in diesem Worker → nicht erneut vergeben
    await pool.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await q.claimJobs(1, [job!.id])).toHaveLength(0);
    // Heartbeat verlängert die Lease → auch ohne Ausschlussliste nicht vergeben
    await q.heartbeatJob(job!.id);
    expect(await q.claimJobs(1)).toHaveLength(0);
    // Wartungsmodus: abgelaufene Lease (abgestürzter Worker) wird freigegeben
    await pool.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await q.requeueExpiredLeases();
    expect((await one<any>(`SELECT status FROM jobs WHERE id = $1`, [id]))!.status).toBe('queued');
    await pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [id]);
  });
});

describe('Upload-Sitzungen: Nebenläufigkeit und Kontingent (#56, #57)', () => {
  const put = (url: string, data: Buffer) => editor.raw('PUT', url, { payload: data, headers: { 'content-type': 'application/octet-stream' } });

  it('zwei gleichzeitige Teile am selben Offset: nur einer wird angehängt, der andere bekommt 409', async () => {
    const data = crypto.randomBytes(60_000);
    const s = await editor.post(`/collections/${collectionId}/upload-sessions`, { clientKey: 'parallel-key-0001', name: 'parallel.bin', size: data.length });
    expect(s.status).toBe(200);
    const url = `/collections/${collectionId}/upload-sessions/${s.json.id}?offset=0`;
    const [a, b] = await Promise.all([put(url, data.subarray(0, 30_000)), put(url, data.subarray(0, 30_000))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const st = await editor.get(`/collections/${collectionId}/upload-sessions/${s.json.id}`);
    expect(st.json.received).toBe(30_000);
    await pool.query(`DELETE FROM upload_sessions WHERE id = $1`, [s.json.id]);
  });

  it('offene Sitzungen zählen gegen das Dateikontingent der Sammlung', async () => {
    const before = await one<any>(`SELECT max_files FROM collections WHERE id = $1`, [collectionId]);
    const used = (await one<any>(`SELECT count(*)::int AS n FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected'`, [collectionId]))!.n;
    await pool.query(`UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE collection_id = $1 AND media_id IS NULL`, [collectionId]);
    await pool.query(`UPDATE collections SET max_files = $2 WHERE id = $1`, [collectionId, used + 1]);
    try {
      const first = await editor.post(`/collections/${collectionId}/upload-sessions`, { clientKey: 'quota-key-0001', name: 'a.bin', size: 1000 });
      expect(first.status).toBe(200);
      const second = await editor.post(`/collections/${collectionId}/upload-sessions`, { clientKey: 'quota-key-0002', name: 'b.bin', size: 1000 });
      expect(second.status).toBe(409);
      expect(second.json.error).toBe('collection_full');
    } finally {
      await pool.query(`UPDATE collections SET max_files = $2 WHERE id = $1`, [collectionId, before!.max_files]);
      await pool.query(`DELETE FROM upload_sessions WHERE client_key LIKE 'quota-key-%'`);
    }
  });

  const usedBytes = async () =>
    Number(
      (await one<any>(
        `SELECT (SELECT COALESCE(sum(size_bytes),0) FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected')
              + (SELECT COALESCE(sum(size_bytes),0) FROM upload_sessions WHERE collection_id = $1 AND media_id IS NULL AND expires_at > now()) AS b`,
        [collectionId],
      ))!.b,
    );

  it('parallele Sitzungsanlagen überschreiten das Byte-Kontingent nicht (#151)', async () => {
    const before = await one<any>(`SELECT max_bytes FROM collections WHERE id = $1`, [collectionId]);
    await pool.query(`UPDATE collections SET max_bytes = $2 WHERE id = $1`, [collectionId, (await usedBytes()) + 1500]);
    try {
      const rs = await Promise.all([1, 2, 3, 4].map((i) => editor.post(`/collections/${collectionId}/upload-sessions`, { clientKey: `bytes-key-000${i}`, name: `b${i}.bin`, size: 1000 })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 413)).toHaveLength(3);
    } finally {
      await pool.query(`UPDATE collections SET max_bytes = $2 WHERE id = $1`, [collectionId, before!.max_bytes]);
      await pool.query(`DELETE FROM upload_sessions WHERE client_key LIKE 'bytes-key-%'`);
    }
  });

  it('der Abschluss prüft das Byte-Kontingent unter Sperre (#151)', async () => {
    const { finalizeUpload } = await import('../src/routes/media.js');
    const before = await one<any>(`SELECT * FROM collections WHERE id = $1`, [collectionId]);
    await pool.query(`UPDATE collections SET max_bytes = $2 WHERE id = $1`, [collectionId, (await usedBytes()) + 10]);
    const tmp = path.join(mediaPaths.tmp(), 'finalize-quota-test');
    fs.writeFileSync(tmp, crypto.randomBytes(100));
    try {
      const err = await finalizeUpload({
        collection: { id: collectionId, max_files: 100000, max_bytes: 0 },
        linkId: null,
        userId: null,
        maxFileBytes: 1e9,
        actor: { id: null, name: 'Test', type: 'system' } as any,
        stored: { tmpPath: tmp, size: 100, sha256: 'x'.repeat(64) },
        name: 'zu-gross.bin',
        declaredType: '',
        note: '',
        clientKey: 'finalize-quota-0001',
      }).catch((e) => e);
      expect(err.code).toBe('collection_full');
      expect(await one(`SELECT 1 FROM media WHERE client_key = 'finalize-quota-0001'`)).toBeNull();
      expect(fs.existsSync(tmp)).toBe(false);
    } finally {
      await pool.query(`UPDATE collections SET max_bytes = $2 WHERE id = $1`, [collectionId, before!.max_bytes]);
    }
  });

  it('endgültiger Abschlussfehler entfernt die Sitzung samt Teildatei (#152)', async () => {
    const before = await one<any>(`SELECT max_bytes FROM collections WHERE id = $1`, [collectionId]);
    const data = crypto.randomBytes(2000);
    const s = await editor.post(`/collections/${collectionId}/upload-sessions`, { clientKey: 'final-fail-0001', name: 'voll.bin', size: data.length });
    expect(s.status).toBe(200);
    // Zwischenzeitlich ist die Sammlung voll (z. B. paralleler Abschluss)
    await pool.query(`UPDATE collections SET max_bytes = $2 WHERE id = $1`, [collectionId, (await usedBytes()) - 1]);
    try {
      const r = await put(`/collections/${collectionId}/upload-sessions/${s.json.id}?offset=0`, data);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('collection_full');
      expect(await one(`SELECT 1 FROM upload_sessions WHERE id = $1`, [s.json.id])).toBeNull();
      expect(fs.existsSync(path.join(mediaPaths.tmp(), `upload-${s.json.id}.part`))).toBe(false);
    } finally {
      await pool.query(`UPDATE collections SET max_bytes = $2 WHERE id = $1`, [collectionId, before!.max_bytes]);
      await pool.query(`DELETE FROM upload_sessions WHERE client_key = 'final-fail-0001'`);
    }
  });
});

describe('Warnfeed-Gebietsfilter (#60)', () => {
  it('kürzt ARS nur entlang der Ebenen und trifft keine Nachbarkreise', async () => {
    const { arsPrefix, inArea } = await import('../src/connections/warnfeed.js');
    expect(arsPrefix('053700000000')).toBe('05370');
    expect(arsPrefix('100000000000')).toBe('10');
    expect(arsPrefix('064360000000')).toBe('06436');
    expect(arsPrefix('064360008008')).toBe('064360008008');
    expect(arsPrefix('809190000')).toBe('809190000'); // Warncell bleibt unverändert
    const w = (g: string) => ({ geocodes: [g], areas: [] }) as any;
    expect(inArea(w('053700012012'), { codes: ['053700000000'] })).toBe(true);
    expect(inArea(w('053740012012'), { codes: ['053700000000'] })).toBe(false);
    expect(inArea(w('150010000000'), { codes: ['100000000000'] })).toBe(false);
  });
});

describe('Sicherungen (#62, #77)', () => {
  it('höchstens eine laufende Sicherung; Entschlüsseln gestreamt mit Prüfung des Auth-Tags', async () => {
    const b = await import('../src/ops/backup.js');
    const { deriveKey } = await import('../src/lib/crypto.js');
    // Sperre: eine laufende Sicherung blockiert die nächste, ohne pg_dump zu starten
    await pool.query(`INSERT INTO backups (file_name, status, trigger) VALUES ('test-laeuft.bcbk','running','manual')`);
    await expect(b.runBackup('manual', null)).rejects.toBeInstanceOf(b.BackupRunningError);
    await pool.query(`DELETE FROM backups WHERE file_name = 'test-laeuft.bcbk'`);
    // Rundweg: Datei im Sicherungsformat erzeugen und gestreamt entschlüsseln
    const plain = crypto.randomBytes(3 * 1024 * 1024 + 7);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', deriveKey('backup'), iv);
    const enc = Buffer.concat([Buffer.from('BCBK1'), iv, c.update(plain), c.final(), c.getAuthTag()]);
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'bk-'));
    fs.writeFileSync(path.join(dir, 'a.bcbk'), enc);
    await b.decryptBackup(path.join(dir, 'a.bcbk'), path.join(dir, 'a.dump'));
    expect(fs.readFileSync(path.join(dir, 'a.dump')).equals(plain)).toBe(true);
    // Manipuliert → Fehler, keine Zieldatei
    enc[100] ^= 0xff;
    fs.writeFileSync(path.join(dir, 'b.bcbk'), enc);
    await expect(b.decryptBackup(path.join(dir, 'b.bcbk'), path.join(dir, 'b.dump'))).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'b.dump'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'b.dump.part'))).toBe(false);
  });
});

describe('Zwei-Faktor-Anmeldung: Replay, Recovery-Code, Kontosperre (#64, #78)', () => {
  let ipN = 0;
  const fresh = () => new Client(app, `10.9.${Math.floor(++ipN / 200)}.${ipN % 200}`);
  it('Code nur einmal gültig, Recovery-Code nur einmal, Fehlversuche sperren das Konto trotz neuer Passwortanmeldung', async () => {
    const { hashPassword } = await import('../src/auth/passwords.js');
    const { generateTotpSecret, totpAt } = await import('../src/auth/totp.js');
    const { encrypt, sha256Hex } = await import('../src/lib/crypto.js');
    const secret = generateTotpSecret();
    const u = await one<any>(
      `INSERT INTO users (email, name, password_hash, roles, totp_enabled, recovery_codes) VALUES ('mfa@example.org','MFA-Test',$1,'{editor}',true,$2) RETURNING id`,
      [await hashPassword(PASSWORD), [sha256Hex('RECOVERY-0001')]],
    );
    await pool.query(`UPDATE users SET totp_secret_enc = $2 WHERE id = $1`, [u.id, encrypt(secret, `totp:${u.id}`)]);
    const login = async () => {
      const c = fresh();
      expect((await c.post('/auth/login', { email: 'mfa@example.org', password: PASSWORD })).json.next).toBe('mfa');
      return c;
    };
    const code = totpAt(secret, Math.floor(Date.now() / 30_000));
    // Zwei parallele Anfragen mit demselben Code: genau eine gelingt
    const [c1, c2] = [await login(), await login()];
    const res = await Promise.all([c1.post('/auth/mfa', { code }), c2.post('/auth/mfa', { code })]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 401]);
    // Recovery-Code einmal
    expect((await (await login()).post('/auth/mfa', { code: 'recovery-0001' })).status).toBe(200);
    expect((await (await login()).post('/auth/mfa', { code: 'recovery-0001' })).status).toBe(401);
    // Fehlversuche über mehrere Passwortanmeldungen hinweg → Sperre (Passworterfolg setzt sie nicht zurück)
    await pool.query(`UPDATE users SET mfa_failed = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    for (let i = 0; i < 4; i++) expect((await (await login()).post('/auth/mfa', { code: '000000' })).status).toBe(401);
    const last = await login();
    expect((await last.post('/auth/mfa', { code: '000000' })).status).toBe(401);
    expect((await last.post('/auth/mfa', { code: totpAt(secret, Math.floor(Date.now() / 30_000) + 1) })).status).toBe(423);
    expect((await fresh().post('/auth/login', { email: 'mfa@example.org', password: PASSWORD })).status).toBe(401);
  });

  it('parallele falsche Passwörter zählen alle (#78)', async () => {
    await pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = 'mfa@example.org'`);
    await Promise.all(Array.from({ length: 5 }, () => fresh().post('/auth/login', { email: 'mfa@example.org', password: 'falsch-falsch' })));
    expect((await one<any>(`SELECT locked_until FROM users WHERE email = 'mfa@example.org'`))!.locked_until).not.toBeNull();
  });
});

describe('Kontosperre ohne gezieltes Aussperren (#110)', () => {
  let ipN = 0;
  const fresh = () => new Client(app, `10.11.${Math.floor(++ipN / 200)}.${ipN % 200}`);
  it('Fehlversuche von unbekannten Geräten sperren nur unbekannte Geräte; bekannte Geräte zählen für sich', async () => {
    const { hashPassword } = await import('../src/auth/passwords.js');
    const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ('geraet@example.org','Geräte-Test',$1,'{viewer}') RETURNING id`, [await hashPassword(PASSWORD)]);
    const creds = { email: 'geraet@example.org', password: PASSWORD };
    const known = fresh();
    expect((await known.post('/auth/login', creds)).json.next).toBe('done');
    expect(known.cookie).toContain('bc_device=');
    // Angreifer ohne Geräte-Cookie: fünf Fehlversuche → unbekannte Geräte gesperrt, Admins benachrichtigt
    for (let i = 0; i < 5; i++) expect((await fresh().post('/auth/login', { ...creds, password: 'falsch-falsch' })).status).toBe(401);
    expect((await fresh().post('/auth/login', creds)).status).toBe(401);
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE permission = 'user.lock' AND title LIKE '%geraet@example.org%'`))!.n).toBe(1);
    // Das bekannte Gerät meldet sich trotzdem an
    expect((await known.post('/auth/login', creds)).json.next).toBe('done');
    // Ein gefälschtes Geräte-Cookie zählt nicht
    const forged = fresh();
    forged.cookie = `bc_device=${u.id}.AAAAAAAAAAAA.${Math.floor(Date.now() / 1000)}.${'x'.repeat(32)}`;
    expect((await forged.post('/auth/login', creds)).status).toBe(401);
    // Fehlversuche am bekannten Gerät sperren nur dieses Gerät
    for (let i = 0; i < 5; i++) expect((await known.post('/auth/login', { ...creds, password: 'falsch-falsch' })).status).toBe(401);
    expect((await known.post('/auth/login', creds)).status).toBe(401);
    // Admin hebt beide Sperren auf
    expect((await admin.post(`/users/${u.id}/unlock`)).status).toBe(200);
    expect((await known.post('/auth/login', creds)).json.next).toBe('done');
    expect((await fresh().post('/auth/login', creds)).json.next).toBe('done');
  });
});

describe('Passwortbestätigung in der Sitzung zählt zur Sperre (#99)', () => {
  it('falsche Passwörter bei Passwortwechsel und 2FA-Abschaltung werden gezählt, auditiert und sperren', async () => {
    const { hashPassword } = await import('../src/auth/passwords.js');
    const { generateTotpSecret, totpAt } = await import('../src/auth/totp.js');
    const { encrypt } = await import('../src/lib/crypto.js');
    const secret = generateTotpSecret();
    const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles, totp_enabled) VALUES ('bestaetigen@example.org','Bestätigen-Test',$1,'{viewer}',true) RETURNING id`, [await hashPassword(PASSWORD)]);
    await pool.query(`UPDATE users SET totp_secret_enc = $2 WHERE id = $1`, [u.id, encrypt(secret, `totp:${u.id}`)]);
    const c = new Client(app, '10.12.0.1');
    expect((await c.post('/auth/login', { email: 'bestaetigen@example.org', password: PASSWORD })).json.next).toBe('mfa');
    expect((await c.post('/auth/mfa', { code: totpAt(secret, Math.floor(Date.now() / 30_000)) })).status).toBe(200);
    // 2FA abschalten verlangt zusätzlich einen Code
    const noCode = await c.post('/auth/mfa/disable', { password: PASSWORD });
    expect(noCode.json.error).toBe('code_required');
    for (let i = 0; i < 5; i++) expect((await c.post('/auth/password', { current: 'falsch-falsch', next: 'Neues-Passwort-sicher-2026' })).status).toBe(400);
    expect((await c.post('/auth/password', { current: PASSWORD, next: 'Neues-Passwort-sicher-2026' })).status).toBe(423);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.confirm' AND result = 'failed' AND object_id = $1`, [u.id]))!.n).toBe(5);
    await pool.query(`DELETE FROM auth_throttle WHERE user_id = $1`, [u.id]);
    await pool.query(`UPDATE users SET locked_until = NULL WHERE id = $1`, [u.id]);
    const other = new Client(app, '10.12.0.2');
    await other.post('/auth/login', { email: 'bestaetigen@example.org', password: PASSWORD });
    await other.post('/auth/mfa', { code: totpAt(secret, Math.floor(Date.now() / 30_000) + 1) });
    const off = await c.post('/auth/mfa/disable', { password: PASSWORD, code: totpAt(secret, Math.floor(Date.now() / 30_000) - 1) });
    // Code -1 ist älter als der zuletzt benutzte (+1) → Wiederverwendung abgewiesen
    expect(off.status).toBe(400);
    await pool.query(`UPDATE users SET totp_last_counter = NULL WHERE id = $1`, [u.id]);
    expect((await c.post('/auth/mfa/disable', { password: PASSWORD, code: totpAt(secret, Math.floor(Date.now() / 30_000)) })).status).toBe(200);
    // Andere Sitzungen sind beendet
    expect((await other.get('/auth/me')).status).toBe(401);
  });
});

describe('Kritische Änderungen mit erneuter Bestätigung (#109)', () => {
  it('2FA-Reset, Admin-Rechte, Passwort-Link für Admins und Sicherheitseinstellungen verlangen eine frische Bestätigung', async () => {
    const target = await one<any>(`SELECT id FROM users WHERE email = 'geraet@example.org'`);
    const adminId = (await one<any>(`SELECT id FROM users WHERE email = 'admin@example.org'`))!.id;
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE user_id = $1`, [adminId]);
    const r1 = await admin.post(`/users/${target.id}/reset-2fa`);
    expect(r1.status).toBe(403);
    expect(r1.json.error).toBe('reauth_required');
    expect((await admin.patch(`/users/${target.id}`, { roles: ['viewer', 'platform_admin'] })).json.error).toBe('reauth_required');
    expect((await admin.patch('/settings', { 'security.lockout_minutes': 20 })).json.error).toBe('reauth_required');
    expect((await admin.post(`/users/${adminId}/link`)).json.error).toBe('reauth_required');
    // Nicht-kritische Änderungen gehen weiter ohne Bestätigung
    expect((await admin.patch('/settings', { 'general.instance_name': 'BlaulichtCMS' })).status).toBe(200);
    expect((await admin.post(`/users/${target.id}/link`)).status).toBe(200);
    // Falsches Passwort zählt, richtiges gilt für einige Minuten
    expect((await admin.post('/auth/reauth', { password: 'falsch-falsch' })).status).toBe(400);
    expect((await admin.post('/auth/reauth', { password: PASSWORD })).json.validMinutes).toBe(10);
    expect((await admin.post(`/users/${target.id}/reset-2fa`)).status).toBe(200);
    expect((await admin.patch('/settings', { 'security.lockout_minutes': 15 })).status).toBe(200);
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE '%Zwei-Faktor%'`, [target.id]))!.n).toBe(1);
    await pool.query(`UPDATE users SET failed_logins = 0 WHERE id = $1`, [adminId]);
    await pool.query(`DELETE FROM auth_throttle WHERE user_id = $1`, [adminId]);
  });
});

describe('2FA-Einrichtung in voller Sitzung nur mit Bestätigung (#144)', () => {
  it('verlangt eine frische Bestätigung und beendet danach andere Sitzungen', async () => {
    const { hashPassword } = await import('../src/auth/passwords.js');
    const { totpAt } = await import('../src/auth/totp.js');
    const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ('einrichten@example.org','Einrichten-Test',$1,'{viewer}') RETURNING id`, [await hashPassword(PASSWORD)]);
    const c = new Client(app, '10.13.0.1');
    const other = new Client(app, '10.13.0.2');
    for (const x of [c, other]) expect((await x.post('/auth/login', { email: 'einrichten@example.org', password: PASSWORD })).json.next).toBe('done');
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE user_id = $1`, [u.id]);
    expect((await c.get('/auth/mfa/setup')).json.error).toBe('reauth_required');
    expect((await c.post('/auth/mfa/setup', { code: '123456' })).json.error).toBe('reauth_required');
    expect((await c.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    const setup = await c.get('/auth/mfa/setup');
    expect(setup.status).toBe(200);
    const done = await c.post('/auth/mfa/setup', { code: totpAt(setup.json.secret, Math.floor(Date.now() / 30_000)) });
    expect(done.status).toBe(200);
    expect(done.json.recoveryCodes).toHaveLength(10);
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401);
    // Neue Codes (80 Bit, HMAC gespeichert) funktionieren genau einmal (#130)
    const stored = (await one<any>(`SELECT recovery_codes FROM users WHERE id = $1`, [u.id]))!.recovery_codes;
    expect(stored.every((h: string) => h.startsWith('h1:'))).toBe(true);
    const viaRecovery = async () => {
      const x = new Client(app, '10.13.0.3');
      expect((await x.post('/auth/login', { email: 'einrichten@example.org', password: PASSWORD })).json.next).toBe('mfa');
      return (await x.post('/auth/mfa', { code: done.json.recoveryCodes[0].toLowerCase() })).status;
    };
    expect(await viaRecovery()).toBe(200);
    expect(await viaRecovery()).toBe(401);
  });
});

describe('Angemeldet bleiben und gemerkte Geräte der Zwei-Faktor-Anmeldung', () => {
  /** Browser mit vollständigem Cookie-Speicher (der einfache Client ersetzt alle Cookies je Antwort). Jede Anfrage
   *  kommt von einer neuen IP – so greift die Anmelde-Drosselung je IP nicht, Sitzungen hängen ohnehin nicht an der IP. */
  let ipN = 0;
  class Browser {
    jar = new Map<string, string>();
    constructor(public ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36') {}
    async req(method: string, url: string, body?: unknown) {
      ipN++;
      const res = await app.inject({
        method: method as any,
        remoteAddress: `10.21.${Math.floor(ipN / 200)}.${ipN % 200}`,
        url: `/api/v1${url}`,
        payload: body !== undefined ? JSON.stringify(body) : undefined,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
          'user-agent': this.ua,
          cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        },
      });
      const cookies = res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[];
      for (const c of cookies) {
        if (!c.value || c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now())) this.jar.delete(c.name);
        else this.jar.set(c.name, c.value);
      }
      let json: any = null;
      try {
        json = res.json();
      } catch {
        json = res.body;
      }
      return { status: res.statusCode, json, cookies };
    }
    get = (u: string) => this.req('GET', u);
    post = (u: string, b: unknown = {}) => this.req('POST', u, b);
    del = (u: string) => this.req('DELETE', u);
    patch = (u: string, b: unknown = {}) => this.req('PATCH', u, b);
  }
  /** Eigene Admin-Sitzung (wechselnde IPs) – die gemeinsame Admin-Sitzung würde die Drosselung von /auth/reauth erreichen. */
  const adm = new Browser();
  const sessionRow = async (b: Browser) => {
    const { sha256Hex } = await import('../src/lib/crypto.js');
    return one<any>(`SELECT * FROM sessions WHERE token_hash = $1`, [sha256Hex(b.jar.get('bc_session') ?? '')]);
  };
  const activeTrusted = async (userId: string) => Number((await one<any>(`SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))!.n);
  let secret = '';
  let mfaUser = '';
  let plainUser = '';
  let mfaPassword = PASSWORD;
  /** Aktueller Code; der Replay-Schutz wird zurückgesetzt, weil der Test viele Anmeldungen in kurzer Zeit braucht. */
  const code = async () => {
    const { totpAt } = await import('../src/auth/totp.js');
    await pool.query(`UPDATE users SET totp_last_counter = NULL WHERE id = $1`, [mfaUser]);
    return totpAt(secret, Math.floor(Date.now() / 30_000));
  };
  const login = (b: Browser, remember?: boolean, email = 'vertraut@example.org', password = mfaPassword) => b.post('/auth/login', { email, password, ...(remember !== undefined ? { remember } : {}) });
  /** Anmelden mit Code und dieses Gerät für die Zwei-Faktor-Anmeldung merken. */
  const trust = async (b: Browser) => {
    expect((await login(b)).json.next).toBe('mfa');
    expect((await b.post('/auth/mfa', { code: await code(), trustDevice: true })).status).toBe(200);
  };
  const enableTotp = async () => {
    const { encrypt } = await import('../src/lib/crypto.js');
    await pool.query(`UPDATE users SET totp_enabled = true, totp_secret_enc = $2 WHERE id = $1`, [mfaUser, encrypt(secret, `totp:${mfaUser}`)]);
  };
  const adminReauth = async () => expect((await adm.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);

  beforeAll(async () => {
    const { hashPassword } = await import('../src/auth/passwords.js');
    const { generateTotpSecret } = await import('../src/auth/totp.js');
    const { sha256Hex } = await import('../src/lib/crypto.js');
    secret = generateTotpSecret();
    const hash = await hashPassword(PASSWORD);
    mfaUser = (await one<any>(`INSERT INTO users (email, name, password_hash, roles, recovery_codes, password_changed_at) VALUES ('vertraut@example.org','Vertraut-Test',$1,'{viewer}',$2, now() - interval '1 day') RETURNING id`, [hash, [sha256Hex('RECOVERY-0002')]]))!.id;
    plainUser = (await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ('bleiben@example.org','Bleiben-Test',$1,'{viewer}') RETURNING id`, [hash]))!.id;
    await enableTotp();
    expect((await adm.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
  });

  it('Anmeldeseite erfährt, ob die Funktionen an sind', async () => {
    const st = await new Browser().get('/auth/state');
    expect(st.json.remember).toEqual({ enabled: true, days: 30 });
    expect(st.json.mfaRemember).toEqual({ enabled: true, days: 30 });
  });

  it('gemerkte Sitzung übersteht Leerlauf, läuft gleitend 30 Tage, normale Sitzung endet nach Leerlauf', async () => {
    const kept = new Browser();
    const r = await login(kept, true, 'bleiben@example.org', PASSWORD);
    expect(r.json.next).toBe('done');
    const cookie = r.cookies.find((c) => c.name === 'bc_session')!;
    expect(cookie.maxAge).toBe(30 * 86400);
    let row = await sessionRow(kept);
    expect(row.remember).toBe(true);
    expect(row.device_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    const plain = new Browser();
    expect((await login(plain, false, 'bleiben@example.org', PASSWORD)).cookies.find((c) => c.name === 'bc_session')!.maxAge).toBe(12 * 3600);
    // Zwei Stunden Leerlauf (Grenze: 60 Minuten)
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1 AND revoked_at IS NULL`, [plainUser]);
    expect((await kept.get('/auth/me')).status).toBe(200);
    expect((await plain.get('/auth/me')).status).toBe(401);
    // Gleitender Ablauf: nach 20 Tagen ohne Nutzung noch gültig, beim nächsten Aufruf wieder 30 Tage (Cookie ebenso)
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '20 days', expires_at = now() + interval '10 days' WHERE id = $1`, [row.id]);
    const me = await kept.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.cookies.find((c) => c.name === 'bc_session')!.maxAge).toBe(30 * 86400);
    expect(me.cookies.find((c) => c.name === 'bc_device')).toBeTruthy();
    row = await sessionRow(kept);
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    // Kurz darauf: keine erneute Schreib-/Cookie-Runde (höchstens einmal pro Stunde)
    expect((await kept.get('/auth/me')).cookies.find((c) => c.name === 'bc_session')).toBeUndefined();
    // Abgelaufen (30 Tage ohne Nutzung) ist abgelaufen
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [row.id]);
    expect((await kept.get('/auth/me')).status).toBe(401);
    // Ohne Haken bzw. ohne Angabe: normale Sitzung
    const none = new Browser();
    await login(none, undefined, 'bleiben@example.org', PASSWORD);
    expect((await sessionRow(none)).remember).toBe(false);
  });

  it('gemerkte Sitzung gilt nur zusammen mit dem Geräte-Cookie desselben Browsers', async () => {
    const a = new Browser();
    await login(a, true, 'bleiben@example.org', PASSWORD);
    const b = new Browser();
    await login(b, false, 'bleiben@example.org', PASSWORD);
    // Sitzungs-Cookie von A ohne Geräte-Cookie
    const stolen = new Browser();
    stolen.jar.set('bc_session', a.jar.get('bc_session')!);
    expect((await stolen.get('/auth/me')).status).toBe(401);
    // … und mit dem (gültigen) Geräte-Cookie eines anderen Browsers
    const a2 = new Browser();
    await login(a2, true, 'bleiben@example.org', PASSWORD);
    const mixed = new Browser();
    mixed.jar.set('bc_session', a2.jar.get('bc_session')!);
    mixed.jar.set('bc_device', b.jar.get('bc_device')!);
    expect((await mixed.get('/auth/me')).status).toBe(401);
    // Ein solcher Versuch beendet die Sitzung (das Token ist verbrannt)
    expect((await a2.get('/auth/me')).status).toBe(401);
    expect((await sessionRow(a2)).revoked_at).not.toBeNull();
    // Normale Sitzungen sind wie bisher nicht an das Geräte-Cookie gebunden
    const plainCopy = new Browser();
    plainCopy.jar.set('bc_session', b.jar.get('bc_session')!);
    expect((await plainCopy.get('/auth/me')).status).toBe(200);
  });

  it('der Wunsch „Angemeldet bleiben“ übersteht den Zwei-Faktor-Schritt; die Zwischenstufe bleibt kurz', async () => {
    const b = new Browser();
    expect((await login(b, true)).json.next).toBe('mfa');
    const stage = await sessionRow(b);
    expect(stage).toMatchObject({ stage: 'mfa', remember: true, device_hash: null });
    expect(new Date(stage.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    // Leerlauf gilt in der Zwischenstufe weiter
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [stage.id]);
    expect((await b.post('/auth/mfa', { code: await code() })).status).toBe(401);
    expect((await login(b, true)).json.next).toBe('mfa');
    const before = b.jar.get('bc_session');
    expect((await b.post('/auth/mfa', { code: await code() })).status).toBe(200);
    expect(b.jar.get('bc_session')).not.toBe(before);
    const full = await sessionRow(b);
    expect(full).toMatchObject({ stage: 'full', remember: true });
    expect(full.device_hash).toBeTruthy();
    expect(await activeTrusted(mfaUser)).toBe(0);
    await b.post('/auth/logout');
  });

  it('gemerktes Gerät: nur dort ohne Code, nur nach App-Code, Step-up verlangt weiter den Code', async () => {
    const a = new Browser();
    await trust(a);
    expect(await activeTrusted(mfaUser)).toBe(1);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'auth.trusted_device_added' AND object_id = $1`, [mfaUser])).not.toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE 'Gerät für die Zwei-Faktor-Anmeldung gemerkt%'`, [mfaUser])).not.toBeNull();
    // Abmelden behält das gemerkte Gerät; die nächste Anmeldung braucht nur das Passwort
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('done');
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'auth.login' AND object_id = $1 ORDER BY id DESC LIMIT 1`, [mfaUser]))!.details.mfa).toBe('vertrauenswürdiges Gerät');
    expect((await one<any>(`SELECT last_used_at FROM trusted_devices WHERE user_id = $1 AND revoked_at IS NULL`, [mfaUser]))!.last_used_at).not.toBeNull();
    // Falsches Passwort bleibt falsch
    expect((await login(new Browser(), undefined, 'vertraut@example.org', 'falsch-falsch')).status).toBe(401);
    expect((await login(a, undefined, 'vertraut@example.org', 'falsch-falsch')).status).toBe(401);
    // Anderes Gerät: Code nötig; ein Wiederherstellungscode merkt kein Gerät, auch mit Haken
    const other = new Browser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    expect((await login(other)).json.next).toBe('mfa');
    expect((await other.post('/auth/mfa', { code: 'recovery-0002', trustDevice: true })).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(1);
    await other.post('/auth/logout');
    expect((await login(other)).json.next).toBe('mfa');
    // Ein gefälschtes Geräte-Cookie hilft nicht
    const forged = new Browser();
    forged.jar.set('bc_device', `${mfaUser}.AAAAAAAAAAAA.${Math.floor(Date.now() / 1000)}.${'x'.repeat(32)}`);
    expect((await login(forged)).json.next).toBe('mfa');
    // Step-up auf dem gemerkten Gerät: Passwort allein genügt nicht
    expect((await login(a)).json.next).toBe('done');
    const stepUp = await a.post('/auth/reauth', { password: mfaPassword });
    expect(stepUp.status).toBe(400);
    expect(stepUp.json.error).toBe('code_required');
    expect((await a.post('/auth/reauth', { password: mfaPassword, code: await code() })).status).toBe(200);
    // Liste im Profil: dieses Gerät erkennbar, Entfernen von einem anderen Gerät aus
    const list = await a.get('/auth/trusted-devices');
    expect(list.json).toMatchObject({ enabled: true, days: 30 });
    expect(list.json.devices).toHaveLength(1);
    expect(list.json.devices[0].current).toBe(true);
    expect(list.json.devices[0].user_agent).toContain('Chrome');
    expect(JSON.stringify(list.json)).not.toMatch(/device_hash/);
    const fromOther = new Browser();
    expect((await login(fromOther)).json.next).toBe('mfa');
    expect((await fromOther.post('/auth/mfa', { code: await code() })).status).toBe(200);
    expect((await fromOther.get('/auth/trusted-devices')).json.devices[0].current).toBe(false);
    // Fremde Konten können das Gerät nicht entfernen
    await editor.raw('DELETE', `/auth/trusted-devices/${list.json.devices[0].id}`);
    expect(await activeTrusted(mfaUser)).toBe(1);
    expect((await fromOther.del(`/auth/trusted-devices/${list.json.devices[0].id}`)).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'auth.trusted_device_removed' AND object_id = $1`, [mfaUser])).not.toBeNull();
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('mfa');
  });

  it('Sitzungsliste zeigt gemerkte Sitzungen; einzelne Sitzungen abmelden, fremde nicht', async () => {
    const a = new Browser();
    expect((await login(a, true, 'bleiben@example.org', PASSWORD)).json.next).toBe('done');
    const b = new Browser();
    expect((await login(b, false, 'bleiben@example.org', PASSWORD)).json.next).toBe('done');
    const list = (await a.get('/auth/sessions')).json as any[];
    const mine = list.find((s) => s.current);
    const theirs = list.find((s) => !s.current && !s.remember);
    expect(mine.remember).toBe(true);
    expect(mine.expires_at).toBeTruthy();
    expect(theirs).toBeTruthy();
    // Andere Person kann die Sitzung nicht beenden
    await editor.raw('DELETE', `/auth/sessions/${mine.id}`);
    expect((await a.get('/auth/me')).status).toBe(200);
    expect((await b.del(`/auth/sessions/${mine.id}`)).status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(401);
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'auth.session_revoked' ORDER BY id DESC LIMIT 1`))!.details).toMatchObject({ sitzung: mine.id, gemerkt: true });
  });

  it('Widerruf: Passwortänderung, Zwei-Faktor neu einrichten/abschalten, Überall abmelden', async () => {
    // Passwortänderung
    const a = new Browser();
    await trust(a);
    const remembered = new Browser();
    expect((await login(remembered, true)).json.next).toBe('mfa');
    expect((await remembered.post('/auth/mfa', { code: await code() })).status).toBe(200);
    expect((await a.post('/auth/password', { current: mfaPassword, next: 'Neues-Passwort-vertraut-2026' })).status).toBe(200);
    mfaPassword = 'Neues-Passwort-vertraut-2026';
    expect(await activeTrusted(mfaUser)).toBe(0);
    expect((await remembered.get('/auth/me')).status).toBe(401);
    expect((await a.get('/auth/me')).status).toBe(200);
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('mfa');
    // Zwei-Faktor abschalten
    expect((await a.post('/auth/mfa', { code: await code(), trustDevice: true })).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(1);
    expect((await a.post('/auth/mfa/disable', { password: mfaPassword, code: await code() })).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    await enableTotp();
    // Zwei-Faktor neu einrichten (über die Datenbank vorbereitet: aus, dann über die Oberfläche ein)
    await a.post('/auth/logout');
    await trust(a);
    expect(await activeTrusted(mfaUser)).toBe(1);
    await pool.query(`UPDATE users SET totp_enabled = false WHERE id = $1`, [mfaUser]);
    expect((await a.post('/auth/reauth', { password: mfaPassword })).status).toBe(200);
    const setup = await a.get('/auth/mfa/setup');
    expect(setup.status).toBe(200);
    secret = setup.json.secret;
    expect((await a.post('/auth/mfa/setup', { code: await code() })).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    // Überall abmelden
    await a.post('/auth/logout');
    await trust(a);
    expect((await a.post('/auth/logout-all')).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'auth.logout_all' ORDER BY id DESC LIMIT 1`))!.details.vertrauenswuerdige_geraete).toBe(1);
    expect((await login(a)).json.next).toBe('mfa');
  });

  it('Widerruf durch die Administration: 2FA zurücksetzen, abmelden, deaktivieren, Passwort-Link; nur mit Recht', async () => {
    const a = new Browser();
    await trust(a);
    // Ohne „Benutzer verwalten“ kein Abmelden fremder Konten
    expect((await editor.post(`/users/${mfaUser}/end-sessions`)).status).toBe(403);
    const list = (await adm.get('/users')).json.users.find((u: any) => u.id === mfaUser);
    expect(list).toMatchObject({ active_sessions: 1, trusted_devices: 1 });
    const ended = await adm.post(`/users/${mfaUser}/end-sessions`);
    expect(ended.json.trustedDevices).toBe(1);
    expect(ended.json.sessions).toBeGreaterThanOrEqual(1);
    expect((await a.get('/auth/me')).status).toBe(401);
    expect(await activeTrusted(mfaUser)).toBe(0);
    expect(await one(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Du wurdest auf allen Geräten abgemeldet'`, [mfaUser])).not.toBeNull();
    // 2FA zurücksetzen
    await trust(a);
    await adminReauth();
    expect((await adm.post(`/users/${mfaUser}/reset-2fa`)).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    await enableTotp();
    // Deaktivieren
    await trust(a);
    expect((await adm.patch(`/users/${mfaUser}`, { status: 'disabled' })).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    expect((await adm.patch(`/users/${mfaUser}`, { status: 'active' })).status).toBe(200);
    // Passwort-Link
    await trust(a);
    expect((await adm.post(`/users/${mfaUser}/link`)).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('mfa');
    await pool.query(`UPDATE invitations SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL`, [mfaUser]);
  });

  it('Abschalten in den Einstellungen beendet gemerkte Sitzungen und Geräte sofort; verkürzte Fristen greifen', async () => {
    const a = new Browser();
    await trust(a);
    const kept = new Browser();
    expect((await login(kept, true, 'bleiben@example.org', PASSWORD)).json.next).toBe('done');
    // Kürzere Frist für gemerkte Geräte gilt sofort (Gerät vor 10 Tagen gemerkt, Frist jetzt 5 Tage)
    await adminReauth();
    await pool.query(`UPDATE users SET password_changed_at = now() - interval '20 days' WHERE id = $1`, [mfaUser]);
    await pool.query(`UPDATE trusted_devices SET created_at = now() - interval '10 days' WHERE user_id = $1 AND revoked_at IS NULL`, [mfaUser]);
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('done');
    expect((await adm.patch('/settings', { 'security.mfa_remember_days': 5, 'security.remember_days': 7 })).status).toBe(200);
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('mfa');
    expect((await adm.patch('/settings', { 'security.mfa_remember_days': 30 })).status).toBe(200);
    expect((await login(a)).json.next).toBe('done');
    // Kürzere Frist für gemerkte Sitzungen: beim nächsten Aufruf auf 7 Tage gekürzt
    const short = await kept.get('/auth/me');
    expect(short.cookies.find((c) => c.name === 'bc_session')!.maxAge).toBe(7 * 86400);
    expect(new Date((await sessionRow(kept)).expires_at).getTime() - Date.now()).toBeLessThan(7.01 * 86_400_000);
    // Bereichsgrenzen
    expect((await adm.patch('/settings', { 'security.remember_days': 181 })).status).toBe(400);
    expect((await adm.patch('/settings', { 'security.mfa_remember_days': 91 })).status).toBe(400);
    // Abschalten (nur mit frischer Bestätigung)
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE id = $1`, [(await sessionRow(adm)).id]);
    expect((await adm.patch('/settings', { 'security.remember_enabled': false })).json.error).toBe('reauth_required');
    await adminReauth();
    expect((await adm.patch('/settings', { 'security.remember_enabled': false, 'security.mfa_remember_enabled': false, 'security.remember_days': 30 })).status).toBe(200);
    expect((await kept.get('/auth/me')).status).toBe(401);
    expect(await activeTrusted(mfaUser)).toBe(0);
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'settings.remember_revoked' ORDER BY id DESC LIMIT 1`))!.details).toMatchObject({ vertrauenswuerdige_geraete: 1 });
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'settings.remember_revoked' ORDER BY id DESC LIMIT 1`))!.details.gemerkte_sitzungen).toBeGreaterThanOrEqual(1);
    // Solange aus: kein Merken, Haken werden ignoriert
    expect((await adm.get('/auth/me')).status).toBe(200);
    const st = await new Browser().get('/auth/state');
    expect(st.json.remember.enabled).toBe(false);
    const again = new Browser();
    await login(again, true, 'bleiben@example.org', PASSWORD);
    expect((await sessionRow(again)).remember).toBe(false);
    await a.post('/auth/logout');
    expect((await login(a)).json.next).toBe('mfa');
    expect((await a.post('/auth/mfa', { code: await code(), trustDevice: true })).status).toBe(200);
    expect(await activeTrusted(mfaUser)).toBe(0);
    await adminReauth();
    expect((await adm.patch('/settings', { 'security.remember_enabled': true, 'security.mfa_remember_enabled': true })).status).toBe(200);
  });

  it('eine gemerkte Sitzung der Administration bleibt beim Abschalten erhalten, gilt danach aber normal', async () => {
    const b = new Browser();
    expect((await login(b, true, 'admin@example.org', PASSWORD)).json.next).toBe('done');
    expect((await b.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    expect((await b.req('PATCH', '/settings', { 'security.remember_enabled': false })).status).toBe(200);
    const row = await sessionRow(b);
    expect(row).toMatchObject({ remember: false, revoked_at: null });
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3_600_000 + 5_000);
    expect((await b.get('/auth/me')).status).toBe(200);
    expect((await b.req('PATCH', '/settings', { 'security.remember_enabled': true })).status).toBe(200);
    await b.post('/auth/logout');
    await pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id IN ($1, $2)`, [mfaUser, plainUser]);
    await pool.query(`DELETE FROM auth_throttle WHERE user_id IN ($1, $2)`, [mfaUser, plainUser]);
  });
});

describe('Argon2id: alte Hashes werden bei der Anmeldung erneuert (#129)', () => {
  it('rechnet nach erfolgreicher Anmeldung mit den aktuellen Parametern neu', async () => {
    const { hash, Algorithm } = await import('@node-rs/argon2');
    const old = await hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    await pool.query(`INSERT INTO users (email, name, password_hash, roles) VALUES ('rehash@example.org','Rehash-Test',$1,'{viewer}')`, [old]);
    expect((await new Client(app, '10.14.0.1').post('/auth/login', { email: 'rehash@example.org', password: PASSWORD })).json.next).toBe('done');
    const now = (await one<any>(`SELECT password_hash FROM users WHERE email = 'rehash@example.org'`))!.password_hash;
    expect(now).toMatch(/m=65536,t=3,p=4/);
    expect((await new Client(app, '10.14.0.2').post('/auth/login', { email: 'rehash@example.org', password: PASSWORD })).json.next).toBe('done');
  });
});

describe('Medienprüfung: gelöscht während der Prüfung, archivierte Sammlungen (#72, #80)', () => {
  it('ein währenddessen gelöschtes Medium hinterlässt keine Dateien', async () => {
    const m = await one<any>(
      `INSERT INTO media (collection_id, client_key, original_name, declared_type, size_bytes, sha256) VALUES ($1,'del-during-0001','x.jpg','image/jpeg',1,$2) RETURNING id`,
      [collectionId, '0'.repeat(64)],
    );
    fs.writeFileSync(mediaPaths.quarantine(m.id), await photoWithGps());
    await pool.query(`UPDATE media SET deleted_at = now() WHERE id = $1`, [m.id]);
    expect(await processMedia(m.id)).toBe('skipped');
    for (const p of [mediaPaths.quarantine(m.id), mediaPaths.original(m.id), mediaPaths.preview(m.id), mediaPaths.publicFile(m.id, 'jpg')]) expect(fs.existsSync(p)).toBe(false);
  });

  it('?archived=false liefert keine archivierten Sammlungen', async () => {
    const cid = (await one<any>(`INSERT INTO collections (title, max_files, max_bytes, archived_at) VALUES ('Archiviert (fiktiv)', 10, 1000000, now()) RETURNING id`))!.id;
    expect((await editor.get('/collections?archived=false')).json.some((x: any) => x.id === cid)).toBe(false);
    expect((await editor.get('/collections?archived=true')).json.some((x: any) => x.id === cid)).toBe(true);
  });
});

describe('Bridge löst die Kopplung selbst (#90)', () => {
  it('POST /bridge/unpair widerruft den Schlüssel sofort und bricht offene Aufträge ab (#146)', async () => {
    const s = await admin.post('/sites', { name: 'Entkoppel-Test' });
    const sid = s.json.site.id;
    const key = (await anonymous.post('/bridge/pair', { code: s.json.pairingCode, site_url: 'https://entkoppeln.example.org' })).json.key;
    const auth = { authorization: `Bearer ${key}` };
    expect((await anonymous.get('/bridge/jobs', auth)).status).toBe(200);
    // Geplante Veröffentlichung und offener Banner-Auftrag für diese Website (direkt angelegt)
    const rev = (await one<any>(`SELECT pb.post_id, pb.revision_id, pb.approval_id FROM publications pb WHERE pb.action = 'publish' LIMIT 1`))!;
    const pub = (await one<any>(
      `INSERT INTO publications (post_id, revision_id, approval_id, site_id, run_at) VALUES ($1,$2,$3,$4, now() + interval '1 day') RETURNING id`,
      [rev.post_id, rev.revision_id, rev.approval_id, sid],
    ))!;
    const banner = (await one<any>(`SELECT id FROM banners LIMIT 1`))!;
    const bj = (await one<any>(`INSERT INTO banner_jobs (banner_id, site_id, action, revision, payload) VALUES ($1,$2,'upsert',1,'{}') RETURNING id`, [banner.id, sid]))!;
    expect((await anonymous.post('/bridge/unpair', {}, auth)).status).toBe(200);
    expect((await anonymous.get('/bridge/jobs', auth)).status).toBe(401);
    const site = (await one<any>(`SELECT status, revoked_at, pairing_code_hash FROM wp_sites WHERE id = $1`, [sid]))!;
    expect(site.status).toBe('revoked');
    expect(site.revoked_at).not.toBeNull();
    expect(site.pairing_code_hash).toBeNull();
    const p = (await one<any>(`SELECT status, error FROM publications WHERE id = $1`, [pub.id]))!;
    expect(p.status).toBe('canceled');
    expect(p.error).toBe('Kopplung durch die Website gelöst');
    expect((await one<any>(`SELECT status FROM banner_jobs WHERE id = $1`, [bj.id]))!.status).toBe('canceled');
    expect((await admin.get('/sites')).json.find((x: any) => x.id === sid).open_jobs).toBe(0);
  });
});

describe('Audit-Lücken: verweigerte Zugriffe, falsche Schlüssel, Sitzungen, Einstellungswerte (#111)', () => {
  it('auditiert 403 gedrosselt, falsche Bridge-/FE2-Schlüssel, beendete Sitzungen und vorher/nachher bei Einstellungen', async () => {
    const { resetAuditThrottle } = await import('../src/lib/audit.js');
    resetAuditThrottle();
    const count = async (action: string, extra = '') => (await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = $1 ${extra}`, [action]))!.n;
    const deniedBefore = await count('access.denied');
    expect((await editor.get('/users')).status).toBe(403);
    expect((await editor.get('/users')).status).toBe(403);
    expect(await count('access.denied')).toBe(deniedBefore + 1);
    const denied = (await one<any>(`SELECT * FROM audit_events WHERE action = 'access.denied' ORDER BY id DESC LIMIT 1`))!;
    expect(denied.result).toBe('denied');
    expect(denied.object_label).toBe('GET /api/v1/users');
    // Bridge mit falschem Schlüssel
    const bridgeBefore = await count('bridge.auth');
    expect((await anonymous.get('/bridge/status', { authorization: 'Bearer bcb_yyyyyyyyyyyy_falschfalschfalschfalsch' })).status).toBe(401);
    expect((await anonymous.get('/bridge/status', { authorization: 'Bearer bcb_yyyyyyyyyyyy_falschfalschfalschfalsch' })).status).toBe(401);
    expect(await count('bridge.auth')).toBe(bridgeBefore + 1);
    // FE2 mit falschem Schlüssel
    const fe2 = await one<any>(`SELECT id FROM connections WHERE kind = 'fe2' AND status <> 'revoked' LIMIT 1`);
    if (fe2) {
      const fe2Before = await count('fe2.auth');
      expect((await anonymous.raw('POST', `/inbound/fe2/${fe2.id}`, { body: {}, headers: { authorization: 'Bearer bcfe2_falsch' } })).status).toBe(401);
      expect(await count('fe2.auth')).toBe(fe2Before + 1);
    }
    // Eigene Sitzung beenden
    const sessions = await admin.get('/auth/sessions');
    const other = await one<any>(
      `INSERT INTO sessions (token_hash, user_id, stage, expires_at) SELECT 'x-audit-test', id, 'full', now() + interval '1 hour' FROM users WHERE email = 'admin@example.org' RETURNING id`,
    );
    expect(sessions.status).toBe(200);
    expect((await admin.raw('DELETE', `/auth/sessions/${other!.id}`)).status).toBe(200);
    expect(await count('auth.session_revoked', `AND details->>'sitzung' = '${other!.id}'`)).toBe(1);
    // Einstellungen: vorher/nachher, unveränderte Felder fehlen
    expect((await admin.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    const before = (await admin.get('/settings')).json.settings['security.lockout_minutes'];
    expect((await admin.patch('/settings', { 'security.lockout_minutes': before + 1, 'general.instance_name': (await admin.get('/settings')).json.settings['general.instance_name'] })).status).toBe(200);
    const ch = (await one<any>(`SELECT * FROM audit_events WHERE action = 'settings.changed' ORDER BY id DESC LIMIT 1`))!;
    expect(ch.details.aenderungen).toEqual({ 'security.lockout_minutes': { vorher: before, nachher: before + 1 } });
    expect((await admin.patch('/settings', { 'security.lockout_minutes': before })).status).toBe(200);
  });
});

describe('IP-Adressen ohne Benutzerkonto nur befristet im Audit (#115)', () => {
  it('ersetzt alte IPs anonymer Einträge durch „entfernt“, Einträge mit Konto bleiben', async () => {
    const { redactAnonymousIps } = await import('../src/lib/audit.js');
    const anon = (await one<any>(`INSERT INTO audit_events (actor_name, actor_type, action, ip, at) VALUES ('Upload-Link test', 'system', 'media.uploaded', '198.51.100.9', now() - interval '31 days') RETURNING id`))!.id;
    const fresh = (await one<any>(`INSERT INTO audit_events (actor_name, actor_type, action, ip, at) VALUES ('Upload-Link test', 'system', 'media.uploaded', '198.51.100.10', now() - interval '5 days') RETURNING id`))!.id;
    const uid = (await one<any>(`SELECT id FROM users WHERE email = 'admin@example.org'`))!.id;
    const user = (await one<any>(`INSERT INTO audit_events (actor_id, actor_name, actor_type, action, ip, at) VALUES ($1, 'Alex', 'user', 'auth.login', '198.51.100.11', now() - interval '31 days') RETURNING id`, [uid]))!.id;
    expect((await admin.get('/settings')).json.settings['privacy.upload_ip_retention_days']).toBe(30);
    expect(await redactAnonymousIps(30)).toBeGreaterThanOrEqual(1);
    const ip = async (id: string) => (await one<any>(`SELECT ip FROM audit_events WHERE id = $1`, [id]))!.ip;
    expect(await ip(anon)).toBe('entfernt');
    expect(await ip(fresh)).toBe('198.51.100.10');
    expect(await ip(user)).toBe('198.51.100.11');
    expect((await admin.patch('/settings', { 'privacy.upload_ip_retention_days': 0 })).status).toBe(400);
    expect((await admin.patch('/settings', { 'privacy.upload_ip_retention_days': 7 })).status).toBe(200);
    expect(await redactAnonymousIps(7)).toBe(0);
    const older = (await one<any>(`INSERT INTO audit_events (actor_name, actor_type, action, ip, at) VALUES ('Upload-Link test', 'system', 'media.uploaded', '198.51.100.12', now() - interval '8 days') RETURNING id`))!.id;
    await redactAnonymousIps(7);
    expect(await ip(older)).toBe('entfernt');
    expect(await ip(fresh)).toBe('198.51.100.10');
    await admin.patch('/settings', { 'privacy.upload_ip_retention_days': 30 });
  });
});

describe('Audit: Hash-Kette, nur anhängen, Weiterleitung (#112)', () => {
  it('versiegelt, erkennt Änderungen und Lücken, Trigger verbieten Ändern und Löschen', async () => {
    const { sealAudit, verifyAudit } = await import('../src/lib/audit-chain.js');
    await sealAudit();
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE chain_seq IS NULL`))!.n).toBe(0);
    const ok = await admin.get('/system/audit-integrity');
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.checked).toBeGreaterThan(10);
    expect(ok.json.unsealed).toBe(0);
    expect((await editor.get('/system/audit-integrity')).status).toBe(403);
    // Anwendung darf nicht ändern oder (junge Einträge) löschen
    const victim = (await one<any>(`SELECT id, chain_seq, object_label FROM audit_events WHERE action = 'post.approved' ORDER BY id LIMIT 1`))!;
    await expect(pool.query(`UPDATE audit_events SET actor_name = 'Jemand anderes' WHERE id = $1`, [victim.id])).rejects.toThrow(/unveränderlich/);
    await expect(pool.query(`DELETE FROM audit_events WHERE id = $1`, [victim.id])).rejects.toThrow(/unveränderlich/);
    await expect(pool.query(`UPDATE audit_events SET hash = 'x' WHERE id = $1`, [victim.id])).rejects.toThrow(/unveränderlich/);
    // Wer den Trigger umgeht (Superuser), fällt bei der Prüfung auf
    await pool.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_append_only`);
    await pool.query(`UPDATE audit_events SET object_label = 'manipuliert' WHERE id = $1`, [victim.id]);
    let v = await verifyAudit(365);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.kind === 'changed' && p.id === String(victim.id))).toBe(true);
    await pool.query(`UPDATE audit_events SET object_label = $2 WHERE id = $1`, [victim.id, victim.object_label]);
    expect((await verifyAudit(365)).ok).toBe(true);
    // Eintrag mittendrin löschen
    const mid = (await one<any>(`SELECT id, chain_seq FROM audit_events WHERE chain_seq = $1`, [Number(victim.chain_seq) + 1]))!;
    await pool.query(`DELETE FROM audit_events WHERE id = $1`, [mid.id]);
    await pool.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_append_only`);
    v = await verifyAudit(365);
    expect(v.problems.some((p) => p.kind === 'gap')).toBe(true);
    const viaApi = await admin.get('/system/audit-integrity');
    expect(viaApi.json.ok).toBe(false);
    expect((await one<any>(`SELECT result FROM audit_events WHERE action = 'audit.verified' ORDER BY id DESC LIMIT 1`))!.result).toBe('failed');
  });
});

describe('Sicherheitsmeldungen (#101)', () => {
  it('meldet geänderte Sicherheitseinstellungen, gehäufte Fehlversuche, falsche Schlüssel, viele Downloads und informiert Betroffene', async () => {
    const { resetSecurityAlertThrottle } = await import('../src/lib/security-alerts.js');
    resetSecurityAlertThrottle();
    const notes = async (like: string) => (await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE $1`, [like]))!.n;
    // Sicherheitseinstellungen (mit frischer Bestätigung)
    expect((await admin.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    const before = await notes('Sicherheitseinstellungen geändert%');
    expect((await admin.patch('/settings', { 'security.alert_failed_logins': 3, 'security.alert_downloads': 2 })).status).toBe(200);
    expect(await notes('Sicherheitseinstellungen geändert%')).toBe(before + 1);
    const n = (await one<any>(`SELECT body, permission FROM notifications WHERE title LIKE 'Sicherheitseinstellungen geändert%' ORDER BY id DESC LIMIT 1`))!;
    expect(n.permission).toBe('settings.security');
    expect(n.body).toContain('security.alert_failed_logins: 20 → 3');
    // Gehäufte Fehlversuche (Schwelle 3 in 15 Minuten, alle Konten)
    const failedBefore = await notes('Gehäufte fehlgeschlagene Anmeldungen%');
    for (let i = 0; i < 3; i++) await new Client(app, `10.77.0.${i + 1}`).post('/auth/login', { email: `niemand${i}@example.org`, password: 'falsch-falsch' });
    expect(await notes('Gehäufte fehlgeschlagene Anmeldungen%')).toBe(failedBefore + 1);
    // Falscher Bridge-Schlüssel im Bridge-Format, ungültiger API-Schlüssel
    const [bridgeB, apiB, apiAuditB, dlB] = [await notes('Bridge-Anmeldung mit ungültigem Schlüssel%'), await notes('Anmeldung mit ungültigem API-Schlüssel%'), (await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'api_key.auth'`))!.n, await notes('Viele Downloads durch%')];
    await anonymous.get('/bridge/status', { authorization: 'Bearer bcb_zzzzzzzzzzzz_falschfalschfalschfalsch' });
    await anonymous.get('/bridge/status', { authorization: 'Bearer bcb_zzzzzzzzzzzz_falschfalschfalschfalsch' });
    expect(await notes('Bridge-Anmeldung mit ungültigem Schlüssel%')).toBe(bridgeB + 1);
    expect((await anonymous.get('/auth/me', { authorization: 'Bearer bc_abcdefgh_falsch' })).status).toBe(401);
    expect(await notes('Anmeldung mit ungültigem API-Schlüssel%')).toBe(apiB + 1);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'api_key.auth' AND result = 'failed'`))!.n).toBe(apiAuditB + 1);
    // Viele Original-Downloads einer Person (Schwelle 2 pro Stunde)
    for (let i = 0; i < 2; i++) await admin.get(`/media/${mediaId}/original`);
    expect(await notes('Viele Downloads durch%')).toBe(dlB + 1);
    // Betroffene Person: Passwortänderung
    const me = await editor.get('/auth/me');
    expect((await editor.post('/auth/password', { current: 'Robin-Zugang-sicher-2026', next: 'Ganz-anderes-Passwort-2026' })).status).toBe(200);
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title = 'Passwort geändert'`, [me.json.user.id]))!.n).toBe(1);
    expect((await editor.post('/auth/password', { current: 'Ganz-anderes-Passwort-2026', next: 'Robin-Zugang-sicher-2026' })).status).toBe(200);
    // Abschalten ist selbst eine Sicherheitsänderung (Bestätigung nötig)
    expect((await admin.patch('/settings', { 'security.alert_failed_logins': 20, 'security.alert_downloads': 200 })).status).toBe(200);
  });
});

describe('Getrennte Datenbankrollen (#102)', () => {
  it('Migrationen gehören blaulichtcms_owner, die Laufzeitrolle hat nur DML und kann den Audit-Schutz nicht umgehen', async () => {
    const owners = await many<{ o: string }>(`SELECT DISTINCT relowner::regrole::text AS o FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','S','v')`);
    expect(owners.map((r) => r.o)).toEqual(['blaulichtcms_owner']);
    const roles = await many<any>(`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN ('blaulichtcms_owner','blaulichtcms_app') ORDER BY rolname`);
    expect(roles).toEqual([
      { rolname: 'blaulichtcms_app', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true },
      { rolname: 'blaulichtcms_owner', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false },
    ]);
    // Als Laufzeitrolle arbeiten (die Testverbindung ist Superuser; SET ROLE legt dessen Rechte ab)
    const c = await pool.connect();
    try {
      await c.query('SET ROLE blaulichtcms_app');
      expect((await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
      await c.query(`INSERT INTO app_logs (level, source, message, details) VALUES ('info','test','Rollentest','{}')`);
      expect((await c.query(`SELECT nextval('warning_case_seq') AS n`)).rows[0].n).toBeGreaterThan(0);
      const denied = async (sql: string, re: RegExp) => {
        await c.query('SAVEPOINT s');
        await expect(c.query(sql)).rejects.toThrow(re);
        await c.query('ROLLBACK TO SAVEPOINT s');
      };
      await c.query('BEGIN');
      await denied(`ALTER TABLE audit_events DISABLE TRIGGER audit_append_only`, /owner|Eigentümer/i);
      await denied(`TRUNCATE audit_events`, /permission|Berechtigung/i);
      await denied(`SET session_replication_role = replica`, /permission|Berechtigung/i);
      await denied(`DELETE FROM audit_events`, /unveränderlich/);
      await denied(`COPY (SELECT 1) TO PROGRAM 'id'`, /permission|Berechtigung|pg_execute_server_program/i);
      await denied(`SELECT pg_read_file('postgresql.conf')`, /permission|Berechtigung/i);
      await denied(`INSERT INTO schema_migrations (name) VALUES ('999_gefaelscht.sql')`, /permission|Berechtigung/i);
      await denied(`CREATE TABLE eingeschleust (id int)`, /permission|Berechtigung/i);
      await denied(`DROP TABLE app_logs`, /owner|Eigentümer/i);
      await denied(`CREATE ROLE boese`, /permission|Berechtigung/i);
      // keine Mitgliedschaft in der Eigentümerrolle (SET ROLE selbst lässt sich hier nicht prüfen: die Sitzung ist Superuser)
      expect((await c.query(`SELECT pg_has_role('blaulichtcms_app', 'blaulichtcms_owner', 'MEMBER') AS m`)).rows[0].m).toBe(false);
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  });

  it('nach einer Wiederherstellung (Objekte des Superusers, keine Rechte) stellt der Migrationsschritt Eigentum und Rechte wieder her', async () => {
    await pool.query(`ALTER TABLE app_logs OWNER TO CURRENT_USER; REVOKE ALL ON app_logs FROM blaulichtcms_app`);
    const c = await pool.connect();
    try {
      await c.query('SET ROLE blaulichtcms_app');
      await expect(c.query('SELECT 1 FROM app_logs LIMIT 1')).rejects.toThrow(/permission|Berechtigung/i);
      await c.query('RESET ROLE');
      expect(await migrate(() => {}, undefined, { admin: true })).toEqual([]);
      await c.query('SET ROLE blaulichtcms_app');
      await c.query('SELECT 1 FROM app_logs LIMIT 1');
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
    expect((await one<any>(`SELECT tableowner FROM pg_tables WHERE tablename = 'app_logs'`))!.tableowner).toBe('blaulichtcms_owner');
  });
});

describe('Master-Schlüssel wechseln (#134)', () => {
  it('verschlüsselt Geheimnisse, Zwei-Faktor und Upload-Links neu, entfernt HMAC-Wiederherstellungscodes, bricht bei Fehlern ohne Änderung ab', async () => {
    const { reencryptDatabase } = await import('../src/ops/rotate-key.js');
    const { aad, decrypt, encrypt, masterKey, sha256Hex } = await import('../src/lib/crypto.js');
    const { recoveryCodeHash } = await import('../src/auth/totp.js');
    const { storeSecret } = await import('../src/lib/secrets.js');
    const oldKey = masterKey();
    const newKey = crypto.randomBytes(32);
    const sec = await storeSecret('setting', crypto.randomUUID(), 'geheim-123', null);
    const u = (await one<any>(
      `INSERT INTO users (email, name, password_hash, roles, totp_enabled, recovery_codes) VALUES ('rotation@example.org','Rotation','x','{editor}',true,$1) RETURNING id`,
      [[sha256Hex('ALT-0001')]],
    ))!;
    await pool.query('UPDATE users SET totp_secret_enc = $2, recovery_codes = recovery_codes || $3::text[] WHERE id = $1', [u.id, encrypt('JBSWY3DPEHPK3PXP', aad.totp(u.id)), [recoveryCodeHash(u.id, 'AAAA-BBBB-CCCC-DDDD')]]);
    const link = (await one<any>('SELECT id FROM upload_links LIMIT 1'))!;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await reencryptDatabase(c, oldKey, newKey);
      expect(r.secrets).toBeGreaterThanOrEqual(2); // inkl. Schlüssel der Audit-Kette
      expect(r.recoveryUsers.map((x) => x.email)).toContain('rotation@example.org');
      const s = (await c.query('SELECT owner_type, owner_id, version, ciphertext FROM secrets WHERE id = $1', [sec.id])).rows[0];
      expect(decrypt(s.ciphertext, aad.secret(s.owner_type, s.owner_id, s.version), newKey)).toBe('geheim-123');
      expect(() => decrypt(s.ciphertext, aad.secret(s.owner_type, s.owner_id, s.version), oldKey)).toThrow(/falscher Master-Schlüssel/);
      const uu = (await c.query('SELECT totp_secret_enc, recovery_codes FROM users WHERE id = $1', [u.id])).rows[0];
      expect(decrypt(uu.totp_secret_enc, aad.totp(u.id), newKey)).toBe('JBSWY3DPEHPK3PXP');
      expect(uu.recovery_codes).toEqual([sha256Hex('ALT-0001')]); // alte SHA-256-Codes bleiben gültig
      const l = (await c.query('SELECT token_enc FROM upload_links WHERE id = $1', [link.id])).rows[0];
      expect(decrypt(l.token_enc, aad.uploadLink(link.id), newKey)).toMatch(/^[\w-]+$/);
      await c.query('ROLLBACK');
      // Ein nicht lesbares Geheimnis: Abbruch, nichts geändert
      await c.query('BEGIN');
      await c.query(`UPDATE secrets SET ciphertext = $2 WHERE id = $1`, [sec.id, encrypt('x', 'falscher-zweck')]);
      await expect(reencryptDatabase(c, oldKey, newKey)).rejects.toThrow(/nichts wurde geändert/);
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    // nach dem Zurückrollen unverändert mit dem alten Schlüssel lesbar
    const { readSecret } = await import('../src/lib/secrets.js');
    expect(await readSecret(sec.id)).toBe('geheim-123');
  });

  it('Datenbanksicherungen werden mit dem neuen abgeleiteten Schlüssel neu verschlüsselt', async () => {
    const b = await import('../src/ops/backup.js');
    const { deriveKey } = await import('../src/lib/crypto.js');
    const oldKey = deriveKey('backup');
    const newKey = deriveKey('backup', crypto.randomBytes(32));
    const plain = crypto.randomBytes(2 * 1024 * 1024 + 3);
    const iv = crypto.randomBytes(12);
    const ci = crypto.createCipheriv('aes-256-gcm', oldKey, iv);
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'rot-'));
    const file = path.join(dir, 'a.bcbk');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('BCBK1'), iv, ci.update(plain), ci.final(), ci.getAuthTag()]));
    const sha = await b.reencryptBackup(file, oldKey, newKey);
    expect(sha).toBe(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    await expect(b.decryptBackup(file, path.join(dir, 'alt.dump'), oldKey)).rejects.toThrow();
    await b.decryptBackup(file, path.join(dir, 'neu.dump'), newKey);
    expect(fs.readFileSync(path.join(dir, 'neu.dump')).equals(plain)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['a.bcbk', 'neu.dump']);
  });
});

describe('Löschfristen und „Sammlung löschen“ (#97)', () => {
  const addMedia = async (cid: string, extra: Record<string, unknown> = {}) => {
    const m = await one<any>(
      `INSERT INTO media (collection_id, original_name, uploader_note, size_bytes, sha256, status, deleted_at, processed_at)
       VALUES ($1, 'IMG_privat.jpg', 'Name einer Person', 10, $2, $3, $4, $5) RETURNING id`,
      [cid, crypto.randomBytes(32).toString('hex'), extra.status ?? 'ready', extra.deleted_at ?? null, extra.processed_at ?? null],
    );
    fs.mkdirSync(path.dirname(mediaPaths.original(m!.id)), { recursive: true });
    fs.writeFileSync(mediaPaths.original(m!.id), 'x');
    return m!.id as string;
  };

  it('blockiert die Löschung, solange ein Beitrag die Datei verwendet, und löscht danach alles', async () => {
    const c = await admin.post('/collections', { title: 'Löschtest manuell', createLink: true });
    const cid = c.json.collection.id;
    const used = await addMedia(cid);
    const free = await addMedia(cid);
    const p = await one<any>(`INSERT INTO posts (title) VALUES ('Beitrag mit Foto') RETURNING id`);
    await pool.query(`INSERT INTO post_revisions (post_id, number, title, media_ids, content_hash) VALUES ($1, 1, 'Beitrag mit Foto', $2, 'h')`, [p!.id, [used]]);
    const blocked = await admin.raw('DELETE', `/collections/${cid}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toContain('Beitrag mit Foto');
    expect(fs.existsSync(mediaPaths.original(free))).toBe(true);
    // Ohne „Medien verwalten“ nicht erlaubt
    expect((await approver.raw('DELETE', `/collections/${cid}`)).status).toBe(403);
    await pool.query(`UPDATE posts SET archived_at = now() WHERE id = $1`, [p!.id]);
    // Standard ist der Papierkorb; sofort endgültig nur mit „Medien administrieren“ (?permanent=1)
    const ok = await admin.raw('DELETE', `/collections/${cid}?permanent=1`);
    expect(ok.status).toBe(200);
    expect(ok.json.media).toBe(2);
    expect(await one(`SELECT 1 FROM collections WHERE id = $1`, [cid])).toBeNull();
    expect(await one(`SELECT 1 FROM media WHERE id = ANY($1::uuid[])`, [[used, free]])).toBeNull();
    expect(await one(`SELECT 1 FROM upload_links WHERE collection_id = $1`, [cid])).toBeNull();
    expect(fs.existsSync(mediaPaths.original(used))).toBe(false);
    expect(fs.existsSync(mediaPaths.original(free))).toBe(false);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'collection.deleted' AND object_id = $1`, [cid])).not.toBeNull();
  });

  it('Probelauf zeigt fällige Sammlungen, der Lauf löscht sie und lässt verwendete Dateien stehen', async () => {
    const old = (await admin.post('/collections', { title: 'Alte Sammlung', createLink: false })).json.collection.id;
    const oldUsed = (await admin.post('/collections', { title: 'Alte Sammlung mit Beitrag', createLink: false })).json.collection.id;
    const fresh = (await admin.post('/collections', { title: 'Neue Sammlung', createLink: false })).json.collection.id;
    const a = await addMedia(old);
    const kept = await addMedia(oldUsed);
    const gone = await addMedia(oldUsed);
    const f = await addMedia(fresh);
    await pool.query(`UPDATE media SET created_at = now() - interval '400 days' WHERE id = ANY($1::uuid[])`, [[a, kept, gone]]);
    await pool.query(`UPDATE collections SET created_at = now() - interval '400 days', archived_at = now() - interval '380 days' WHERE id = ANY($1::uuid[])`, [[old, oldUsed]]);
    const p = await one<any>(`INSERT INTO posts (title) VALUES ('Laufender Beitrag') RETURNING id`);
    await pool.query(`INSERT INTO post_revisions (post_id, number, title, cover_id, content_hash) VALUES ($1, 1, 'Laufender Beitrag', $2, 'h')`, [p!.id, kept]);
    // gelöschte und abgewiesene Dateien älter als 30 Tage
    const softDeleted = await addMedia(fresh, { deleted_at: new Date(Date.now() - 40 * 86400_000) });
    const rejected = await addMedia(fresh, { status: 'rejected', processed_at: new Date(Date.now() - 40 * 86400_000) });
    const recentDeleted = await addMedia(fresh, { deleted_at: new Date() });

    const preview = await admin.get('/system/retention');
    expect(preview.status).toBe(200);
    expect(preview.json.dry_run).toBe(true);
    const titles = preview.json.collections.map((c: any) => c.title);
    expect(titles).toContain('Alte Sammlung');
    expect(titles).not.toContain('Neue Sammlung');
    const withPost = preview.json.collections.find((c: any) => c.title === 'Alte Sammlung mit Beitrag');
    expect(withPost).toMatchObject({ media: 1, kept: 1, used_in: ['Laufender Beitrag'] });
    expect(preview.json.categories.find((c: any) => c.key === 'media_records').count).toBeGreaterThanOrEqual(2);
    // Probelauf löscht nichts
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [a])).not.toBeNull();
    expect((await approver.post('/system/retention/run', {})).status).toBe(403);

    const run = await admin.post('/system/retention/run', {});
    expect(run.status).toBe(200);
    expect(await one(`SELECT 1 FROM collections WHERE id = $1`, [old])).toBeNull();
    expect(await one(`SELECT 1 FROM collections WHERE id = $1`, [oldUsed])).not.toBeNull();
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [kept])).not.toBeNull();
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [gone])).toBeNull();
    expect(fs.existsSync(mediaPaths.original(gone))).toBe(false);
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [f])).not.toBeNull();
    expect(await one(`SELECT 1 FROM media WHERE id = ANY($1::uuid[])`, [[softDeleted, rejected]])).toBeNull();
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [recentDeleted])).not.toBeNull();
    const ev = await one<any>(`SELECT details FROM audit_events WHERE action = 'retention.run' ORDER BY id DESC LIMIT 1`);
    expect(ev!.details.collections).toBeGreaterThanOrEqual(2);
    // Ein zweiter Lauf findet nichts mehr (die Sammlung mit verwendeter Datei bleibt außen vor)
    const again = await admin.get('/system/retention');
    expect(again.json.collections.map((c: any) => c.title)).not.toContain('Alte Sammlung mit Beitrag');
    // 0 = nie
    await setSettings({ 'privacy.collection_retention_days': 0 } as any);
    const off = await admin.get('/system/retention');
    expect(off.json.categories.find((c: any) => c.key === 'collections')).toMatchObject({ days: 0, count: 0 });
    await setSettings({ 'privacy.collection_retention_days': 365 } as any);
  });
});

describe('Löschfristen für weitere personenbezogene Daten (#116)', () => {
  it('löscht alte FE2-Meldungen, Warnvorgänge samt PDF, abgelaufene amtliche Warnungen und Upload-Links', async () => {
    const old = new Date(Date.now() - 400 * 86400_000);
    const fe2Old = await one<any>(`INSERT INTO fe2_events (event_key, received_at, updated_at) VALUES ('alt-1', $1, $1) RETURNING id`, [old]);
    const fe2New = await one<any>(`INSERT INTO fe2_events (event_key) VALUES ('neu-1') RETURNING id`);
    const tpl = await one<any>(`SELECT id FROM warning_templates LIMIT 1`);
    const root = await one<any>(`INSERT INTO warnings (case_no, kind, template_id, created_at, updated_at) VALUES ('ALT-0001', 'initial', $1, $2, $2) RETURNING id`, [tpl!.id, old]);
    const child = await one<any>(`INSERT INTO warnings (case_no, kind, template_id, parent_id, root_id, created_at, updated_at) VALUES ('ALT-0002', 'all_clear', $1, $2, $2, $3, $3) RETURNING id`, [tpl!.id, root!.id, old]);
    await pool.query(`INSERT INTO warning_revisions (warning_id, number, data, content_hash, created_at) VALUES ($1, 1, '{"callback":"Name 0123"}', 'h', $2)`, [root!.id, old]);
    const pdfDir = path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'warnings', root!.id);
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(path.join(pdfDir, 'ALT-0001.pdf'), 'pdf');
    // Vorgang mit jüngerer Aktualisierung bleibt vollständig
    const keepRoot = await one<any>(`INSERT INTO warnings (case_no, kind, template_id, created_at, updated_at) VALUES ('ALT-0003', 'initial', $1, $2, $2) RETURNING id`, [tpl!.id, old]);
    await pool.query(`INSERT INTO warnings (case_no, kind, template_id, parent_id, root_id) VALUES ('ALT-0004', 'update', $1, $2, $2)`, [tpl!.id, keepRoot!.id]);
    const conn = await one<any>(`SELECT id FROM connections LIMIT 1`);
    const ow = conn ? await one<any>(`INSERT INTO official_warnings (connection_id, identifier, expires_at, received_at) VALUES ($1, 'alt-warnung', $2, $2) RETURNING id`, [conn.id, old]) : null;
    const cid = (await admin.post('/collections', { title: 'Linkfrist', createLink: false })).json.collection.id;
    const lnk = await one<any>(`INSERT INTO upload_links (collection_id, token_hash, token_enc, expires_at, revoked_at) VALUES ($1, 'x-alt', 'enc', now() + interval '1 day', $2) RETURNING id`, [cid, old]);
    const lnkActive = await one<any>(`INSERT INTO upload_links (collection_id, token_hash, token_enc, expires_at) VALUES ($1, 'x-neu', 'enc', now() + interval '1 day') RETURNING id`, [cid]);

    const preview = await admin.get('/system/retention');
    const cat = (k: string) => preview.json.categories.find((c: any) => c.key === k);
    expect(cat('fe2_events')).toMatchObject({ days: 90 });
    expect(cat('fe2_events').count).toBeGreaterThanOrEqual(1);
    expect(cat('warnings').count).toBeGreaterThanOrEqual(1);
    expect(cat('upload_links').count).toBeGreaterThanOrEqual(1);
    expect(await one(`SELECT 1 FROM fe2_events WHERE id = $1`, [fe2Old!.id])).not.toBeNull();

    expect((await admin.post('/system/retention/run', {})).status).toBe(200);
    expect(await one(`SELECT 1 FROM fe2_events WHERE id = $1`, [fe2Old!.id])).toBeNull();
    expect(await one(`SELECT 1 FROM fe2_events WHERE id = $1`, [fe2New!.id])).not.toBeNull();
    expect(await one(`SELECT 1 FROM warnings WHERE id = ANY($1::uuid[])`, [[root!.id, child!.id]])).toBeNull();
    expect(await one(`SELECT 1 FROM warning_revisions WHERE warning_id = $1`, [root!.id])).toBeNull();
    expect(fs.existsSync(pdfDir)).toBe(false);
    expect(await one(`SELECT 1 FROM warnings WHERE id = $1`, [keepRoot!.id])).not.toBeNull();
    if (ow) expect(await one(`SELECT 1 FROM official_warnings WHERE id = $1`, [ow.id])).toBeNull();
    expect(await one(`SELECT 1 FROM upload_links WHERE id = $1`, [lnk!.id])).toBeNull();
    expect(await one(`SELECT 1 FROM upload_links WHERE id = $1`, [lnkActive!.id])).not.toBeNull();
    const ev = await one<any>(`SELECT details FROM audit_events WHERE action = 'retention.run' ORDER BY id DESC LIMIT 1`);
    expect(ev!.details.fe2_events).toBeGreaterThanOrEqual(1);
    expect(ev!.details.warnings).toBeGreaterThanOrEqual(1);
  });
});

describe('Auskunft und Löschung je Person (#141)', () => {
  it('Upload mit Vorgangsnummer, Suche über alle Bereiche, Auskunft als ZIP, Pseudonymisieren und Löschen', async () => {
    const c = await admin.post('/collections', { title: 'Anfrage-Test', createLink: true });
    const token = c.json.link.url.split('/u/')[1];
    const mp = multipart({ name: 'Erika_Mustermann_Unfall.jpg', data: await photoWithGps(), type: 'image/jpeg' }, { clientKey: 'anfrage-key-0001', note: 'Foto von Erika Mustermann', ref: 'K7M2-Q9XD' });
    expect((await anonymous.raw('POST', `/public/upload/${token}`, mp)).status).toBe(200);
    // ungültige Vorgangsnummer wird ignoriert
    const mp2 = multipart({ name: 'IMG_2.jpg', data: await photoWithGps(), type: 'image/jpeg' }, { clientKey: 'anfrage-key-0002', ref: 'bad' });
    expect((await anonymous.raw('POST', `/public/upload/${token}`, mp2)).status).toBe(200);
    expect((await one<any>(`SELECT upload_ref FROM media WHERE client_key = 'anfrage-key-0002'`))!.upload_ref).toBeNull();
    await processAllQuarantine();
    const m = await one<any>(`SELECT id, upload_ref FROM media WHERE client_key = 'anfrage-key-0001'`);
    expect(m!.upload_ref).toBe('K7M2-Q9XD');

    expect((await approver.get('/privacy/search?q=Mustermann')).status).toBe(403);
    expect((await admin.get('/privacy/search?q=ab')).status).toBe(400);
    const byRef = await admin.get('/privacy/search?q=k7m2-q9xd');
    expect(byRef.status).toBe(200);
    const hit = byRef.json.hits.find((h: any) => h.kind === 'media' && h.id === m!.id);
    expect(hit.fields.hinweis).toBe('Foto von Erika Mustermann');
    expect(hit.actions).toContain('delete');
    const byName = await admin.get('/privacy/search?q=Mustermann');
    expect(byName.json.hits.some((h: any) => h.kind === 'media' && h.id === m!.id)).toBe(true);
    const byMail = await admin.get('/privacy/search?q=example.org');
    expect(byMail.json.hits.some((h: any) => h.kind === 'user')).toBe(true);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'privacy.search' AND details->>'suchbegriff' = 'Mustermann'`)).not.toBeNull();

    const zip = await admin.raw('GET', '/privacy/export?q=K7M2-Q9XD');
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    const AdmZip = (await import('adm-zip')).default;
    const entries = new AdmZip(zip.rawPayload).getEntries().map((e: any) => e.entryName);
    expect(entries).toContain('auskunft.json');
    expect(entries.some((n: string) => n.startsWith('dateien/'))).toBe(true);

    expect((await admin.post('/privacy/action', { kind: 'media', id: m!.id, action: 'pseudonymize' })).status).toBe(200);
    const after = await one<any>(`SELECT original_name, uploader_note FROM media WHERE id = $1`, [m!.id]);
    expect(after).toEqual({ original_name: `datei-${m!.id.slice(0, 8)}.jpg`, uploader_note: '' });
    expect((await admin.get('/privacy/search?q=Mustermann')).json.hits.some((h: any) => h.kind === 'media' && h.id === m!.id)).toBe(false);

    expect((await admin.post('/privacy/action', { kind: 'media', id: m!.id, action: 'delete' })).status).toBe(200);
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [m!.id])).toBeNull();
    expect(fs.existsSync(mediaPaths.original(m!.id))).toBe(false);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'privacy.deleted' AND object_id = $1`, [m!.id])).not.toBeNull();
  });
});

describe('Datenmodell-Review 15.11.2026: Website-Widerruf und Aufträge (#162, #166, #183)', () => {
  let resolvedPost = '';
  const pairSite = async (name: string, url: string) => {
    const s = await admin.post('/sites', { name });
    const key = (await anonymous.post('/bridge/pair', { code: s.json.pairingCode, site_url: url })).json.key;
    return { id: s.json.site.id as string, auth: { authorization: `Bearer ${key}` } };
  };
  const approvedPost = async (title: string, siteId: string) => {
    const pid = (await editor.post('/posts', { title })).json.id;
    let d = (await editor.get(`/posts/${pid}`)).json;
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title, body: 'Text.', siteId });
    d = (await editor.get(`/posts/${pid}`)).json;
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    expect((await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(200);
    const pub = await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(pub.status).toBe(200);
    return { pid: pid as string, pubId: pub.json.id as string };
  };

  it('abgeholte Aufträge einer widerrufenen Website: „Ergebnis unbekannt“, kein Block des Freigabe-Widerrufs, von Hand abschließbar (#162)', async () => {
    const site = await pairSite('Widerruf-Abholung', 'https://widerruf-abholung.example.org');
    const a = await approvedPost('Abgeholt vor Widerruf (fiktiv)', site.id);
    const b = await approvedPost('Abgeholt vor Widerruf 2 (fiktiv)', site.id);
    const jobs = (await anonymous.get('/bridge/jobs', site.auth)).json.jobs;
    expect(jobs.map((j: any) => j.id).sort()).toEqual([a.pubId, b.pubId].sort());
    await pool.query(`UPDATE publications SET status = 'unknown' WHERE id = $1`, [b.pubId]);
    expect((await admin.post(`/sites/${site.id}/revoke`)).status).toBe(200);
    for (const id of [a.pubId, b.pubId]) {
      const p = (await one<any>(`SELECT status, error FROM publications WHERE id = $1`, [id]))!;
      expect(p.status).toBe('unknown');
      expect(p.error).toContain('von Hand abschließen');
    }
    // Freigabe-Widerruf ist möglich, obwohl der Auftrag offen ist
    expect((await approver.post(`/posts/${a.pid}/approval/revoke`, {})).status).toBe(200);
    // Von Hand abschließen: nur mit Recht, Ergebnis und Hinweis
    expect((await editor.post(`/publications/${a.pubId}/resolve`, { outcome: 'not_done', note: 'Auf der Website nicht vorhanden' })).status).toBe(403);
    expect((await publisher.post(`/publications/${a.pubId}/resolve`, { outcome: 'not_done', note: '' })).status).toBe(400);
    expect((await publisher.post(`/publications/${a.pubId}/resolve`, { outcome: 'not_done', note: 'Auf der Website nicht vorhanden' })).status).toBe(200);
    expect((await one<any>(`SELECT status FROM publications WHERE id = $1`, [a.pubId]))!.status).toBe('canceled');
    expect((await publisher.post(`/publications/${a.pubId}/resolve`, { outcome: 'done', note: 'Doch vorhanden' })).status).toBe(400);
    expect((await publisher.post(`/publications/${b.pubId}/resolve`, { outcome: 'done', note: 'Beitrag steht auf der Website' })).status).toBe(200);
    const d = (await publisher.get(`/posts/${b.pid}`)).json;
    resolvedPost = b.pid;
    expect(d.state).toBe('published');
    expect(d.publications[0].site_active).toBe(false);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'publication.resolved' AND details->>'auftrag' = $1`, [b.pubId])).not.toBeNull();
    // Gekoppelte Website: kein Abschluss von Hand
    // (direkt aktiv gesetzt – /bridge/pair ist auf 10 Kopplungen je Minute begrenzt)
    const liveId = (await admin.post('/sites', { name: 'Noch gekoppelt' })).json.site.id;
    await pool.query(`UPDATE wp_sites SET status = 'active', site_url = 'https://noch-gekoppelt.example.org' WHERE id = $1`, [liveId]);
    const c = await approvedPost('Noch gekoppelt (fiktiv)', liveId);
    await pool.query(`UPDATE publications SET status = 'sent', fetched_at = now() WHERE id = $1`, [c.pubId]);
    expect((await publisher.post(`/publications/${c.pubId}/resolve`, { outcome: 'done', note: 'Steht dort' })).status).toBe(400);
    await pool.query(`UPDATE publications SET status = 'failed' WHERE id = $1`, [c.pubId]);
  });

  it('nach Neu-Kopplung derselben Adresse lässt sich ein dort veröffentlichter Beitrag zurückziehen (#183)', async () => {
    // Ohne aktive Kopplung derselben Adresse: nichts erreichbar
    expect((await publisher.post(`/posts/${resolvedPost}/unpublish`, { reason: 'Widerspruch' })).status).toBe(400);
    // Neu gekoppelt (gleiche Adresse, andere Schreibweise; direkt gesetzt wegen der Kopplungsbegrenzung)
    const newId = (await admin.post('/sites', { name: 'Widerruf-Abholung neu' })).json.site.id;
    await pool.query(`UPDATE wp_sites SET status = 'active', site_url = 'https://Widerruf-Abholung.example.org/', paired_at = now() WHERE id = $1`, [newId]);
    const u = await publisher.post(`/posts/${resolvedPost}/unpublish`, { reason: 'Widerspruch' });
    expect(u.status).toBe(200);
    expect(u.json.sites).toBe(1);
    const job = (await one<any>(`SELECT site_id, action, status FROM publications WHERE id = $1`, [u.json.id]))!;
    expect(job).toMatchObject({ site_id: newId, action: 'unpublish', status: 'queued' });
    expect((await publisher.post(`/posts/${resolvedPost}/unpublish`, { reason: 'Widerspruch' })).json.duplicate).toBe(true);
    // Bridge der neuen Kopplung meldet den Rückzug → nichts mehr veröffentlicht, Beitrag zurückgezogen
    await pool.query(`UPDATE publications SET status = 'published', remote_status = 'draft', result_at = now() WHERE id = $1`, [u.json.id]);
    expect((await publisher.post(`/posts/${resolvedPost}/unpublish`, { reason: 'Widerspruch' })).status).toBe(400);
    expect((await publisher.get(`/posts/${resolvedPost}`)).json.state).toBe('deactivated');
    await pool.query(`UPDATE wp_sites SET status = 'revoked', revoked_at = now() WHERE id = $1`, [newId]);
  });

  it('Website-Widerruf während der Abholung: Aufträge landen nicht als „abgeholt“ bei einer widerrufenen Website (#166)', async () => {
    const siteId = (await admin.post('/sites', { name: 'Widerruf während Abholung' })).json.site.id;
    await pool.query(`UPDATE wp_sites SET status = 'active', site_url = 'https://widerruf-race.example.org' WHERE id = $1`, [siteId]);
    const a = await approvedPost('Widerruf während Abholung (fiktiv)', siteId);
    // Abholung läuft (Zeile gesperrt, queued → sent noch nicht bestätigt) – der Widerruf wartet und erfasst den Auftrag
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE publications SET status = 'sent', fetched_at = now(), attempts = attempts + 1 WHERE id = $1`, [a.pubId]);
      const revoke = admin.post(`/sites/${siteId}/revoke`);
      await new Promise((r) => setTimeout(r, 300));
      await client.query('COMMIT');
      expect((await revoke).status).toBe(200);
    } finally {
      client.release();
    }
    expect((await one<any>(`SELECT status FROM publications WHERE id = $1`, [a.pubId]))!.status).toBe('unknown');
  });
});

describe('Vier-Augen-Prinzip bei Beiträgen und Bannern wie bei Warnentwürfen (#169)', () => {
  it('weder Schreibende früherer Fassungen noch die einreichende Person dürfen freigeben', async () => {
    await admin.patch('/settings', { 'editorial.four_eyes': true });
    try {
      const st = async (pid: string) => (await editor.get(`/posts/${pid}`)).json;
      const decide = (c: Client, d: any, pid: string) => c.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
      // (a) Admin schreibt den Text, Redaktion ändert nur den Termin und reicht ein → Admin darf nicht freigeben
      const pid = (await admin.post('/posts', { title: 'Vier Augen (fiktiv)' })).json.id;
      let d = await st(pid);
      await admin.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Vier Augen (fiktiv)', body: 'Text der Administration.' });
      d = await st(pid);
      await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Vier Augen (fiktiv)', body: 'Text der Administration.', publishAt: new Date(Date.now() + 86_400_000).toISOString() });
      d = await st(pid);
      expect((await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number })).status).toBe(200);
      const r1 = await decide(admin, d, pid);
      expect(r1.status).toBe(403);
      // Unbeteiligte Freigabe darf
      expect((await decide(approver, d, pid)).status).toBe(200);
      // (b) Redaktion schreibt, Admin reicht ein → Admin darf nicht freigeben
      const pid2 = (await editor.post('/posts', { title: 'Vier Augen 2 (fiktiv)' })).json.id;
      d = await st(pid2);
      await editor.put(`/posts/${pid2}/revision`, { baseRevision: d.revision.number, title: 'Vier Augen 2 (fiktiv)', body: 'Text der Redaktion.' });
      d = await st(pid2);
      await admin.post(`/posts/${pid2}/submit`, { revision: d.revision.number });
      expect((await decide(admin, d, pid2)).status).toBe(403);
      expect((await decide(approver, d, pid2)).status).toBe(200);
      // (c) Banner: angelegt von der Redaktion, eingereicht von der Administration → keine der beiden gibt frei
      const siteId = (await admin.post('/sites', { name: 'Vier-Augen-Banner' })).json.site.id;
      const b = await editor.post('/banners', { siteId, title: 'Vier Augen (fiktiv)', text: 'Hinweis.', tone: 'info', priority: 1, endsAt: new Date(Date.now() + 3600_000).toISOString() });
      await admin.post(`/banners/${b.json.id}/submit`);
      const bh = (await editor.get('/banners')).json.find((x: any) => x.id === b.json.id).content_hash;
      expect((await admin.post(`/banners/${b.json.id}/approve`, { contentHash: bh })).status).toBe(403);
      expect((await approver.post(`/banners/${b.json.id}/approve`, { contentHash: bh })).status).toBe(200);
    } finally {
      await admin.patch('/settings', { 'editorial.four_eyes': false });
    }
  });
});

describe('Geheimnisse: Versionen atomar vergeben (#171)', () => {
  it('gleichzeitiges Speichern für denselben Besitzer ergibt fortlaufende Versionen ohne Fehler', async () => {
    const { storeSecret } = await import('../src/lib/secrets.js');
    const owner = '00000000-0000-0000-0000-0000000000a1';
    const metas = await Promise.all(Array.from({ length: 8 }, (_, i) => storeSecret('setting', owner, `wert-${i}`, null)));
    expect(metas.map((m) => m.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('Verbindungs-Geheimnisse atomar rotieren (#182)', () => {
  it('gleichzeitige Änderungen bauen aufeinander auf, genau eine gültige Version bleibt', async () => {
    const { updateConnectionSecrets, connectionSecrets, loadConnection } = await import('../src/connections/common.js');
    const c = await one<any>(`INSERT INTO connections (kind, name, config) VALUES ('warnfeed', 'Geheimnis-Test', '{}') RETURNING *`);
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => updateConnectionSecrets({ ...c }, { [k]: `wert-${k}` }, null)));
    const fresh = await loadConnection(c.id);
    expect(await connectionSecrets(fresh)).toEqual({ a: 'wert-a', b: 'wert-b', c: 'wert-c', d: 'wert-d' });
    const valid = await many(`SELECT id FROM secrets WHERE owner_type = 'connection' AND owner_id = $1 AND revoked_at IS NULL`, [c.id]);
    expect(valid).toHaveLength(1);
    await pool.query('DELETE FROM connections WHERE id = $1', [c.id]);
  });
});

describe('Schnittstellen nur nach erfolgreichem Test', () => {
  const okTest = () => JSON.stringify({ at: new Date().toISOString(), ok: true, steps: [{ name: 'Test', ok: true, message: 'ok' }] });
  const row = (id: string) => one<any>(`SELECT status, last_test, preview FROM connections WHERE id = $1`, [id]);

  it('FE2: Änderungen an Zuordnung oder Schlüssel halten auch aktive Verbindungen an, bis neu getestet ist', async () => {
    const c = await admin.post('/connections', { kind: 'fe2', name: 'FE2 Neutest' });
    const id = c.json.id;
    // Eigene Adresse für die Testläufe (Ratenbegrenzung je IP), gleiche Sitzung
    const tester = new Client(app, '198.51.100.31');
    tester.cookie = admin.cookie;
    let token = c.json.token;
    const send = (body: any, tok = token, headers: Record<string, string> = {}) => anonymous.raw('POST', `/inbound/fe2/${id}`, { body, headers: { authorization: `Bearer ${tok}`, ...headers } });
    expect((await send({ einsatz: { id: 'N-1', stichwort: 'F-1', ort: 'Musterstadt' } }, token, { 'x-blaulichtcms-test': '1' })).json.outcome).toBe('test');
    expect((await tester.post(`/connections/${id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);

    // Name und Schalter, die der Test nicht prüft, verlangen keinen neuen Test
    const rename = await admin.put(`/connections/${id}`, { name: 'FE2 Neutest umbenannt', config: { createDrafts: false } });
    expect(rename.json).toMatchObject({ retest: false, deactivated: false });
    expect((await row(id))!.status).toBe('active');

    // Geänderte Feldzuordnung: Entwurf, Test und Testmeldung verworfen, auditiert
    const m = await admin.put(`/connections/${id}`, { name: 'FE2 Neutest umbenannt', config: { mapping: { event_id: 'einsatz.nummer' } } });
    expect(m.json).toMatchObject({ retest: true, deactivated: true });
    const r1 = await row(id);
    expect(r1).toMatchObject({ status: 'draft', last_test: null, preview: null });
    const a = await one<any>(`SELECT details FROM audit_events WHERE action = 'connection.retest_required' AND object_id = $1::text ORDER BY id DESC LIMIT 1`, [id]);
    expect(a.details).toMatchObject({ vorher: 'aktiv', grund: 'Einstellungen geändert' });
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(409);
    // Im Entwurf legt der Eingang nichts an, er aktualisiert nur die Vorschau
    const events = async () => (await one<any>(`SELECT count(*)::int AS n FROM fe2_events WHERE connection_id = $1`, [id]))!.n;
    const n0 = await events();
    expect((await send({ einsatz: { nummer: 'N-2', stichwort: 'F-1' } })).json.outcome).toBe('test');
    expect(await events()).toBe(n0);
    expect((await tester.post(`/connections/${id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);

    // Angehalten + geänderte Einstellungen: der alte Test reicht für die erneute Aktivierung nicht
    expect((await admin.post(`/connections/${id}/disable`)).status).toBe(200);
    expect((await admin.put(`/connections/${id}`, { name: 'FE2 Neutest umbenannt', config: { mapping: { event_id: 'einsatz.id' } } })).json.retest).toBe(true);
    const disabledActivate = await admin.post(`/connections/${id}/activate`);
    expect(disabledActivate.status).toBe(409);
    expect(disabledActivate.json.message).toContain('aktuellen Einstellungen');

    // Neuer Zugangsschlüssel: erst nach einer Testmeldung über den neuen Schlüssel wieder aktivierbar
    expect((await send({ einsatz: { id: 'N-3', stichwort: 'F-1' } })).json.outcome).toBe('test');
    expect((await tester.post(`/connections/${id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);
    const rot = await admin.post(`/connections/${id}/rotate-token`);
    expect(rot.json).toMatchObject({ retest: true, deactivated: true });
    expect((await row(id))).toMatchObject({ status: 'draft', last_test: null, preview: null });
    expect((await tester.post(`/connections/${id}/test`)).json.ok).toBe(false);
    expect((await send({ einsatz: { id: 'N-4' } })).status).toBe(401);
    token = rot.json.token;
    expect((await send({ einsatz: { id: 'N-4', stichwort: 'F-1' } })).json.outcome).toBe('test');
    expect((await tester.post(`/connections/${id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);
    await pool.query('DELETE FROM connections WHERE id = $1', [id]);
  });

  it('Zugangsdaten und Einstellungen sozialer Kanäle: neuer Test vor dem (Wieder-)Aktivieren', async () => {
    const c = await admin.post('/connections', { kind: 'facebook', name: 'Facebook Neutest', config: { appId: '1111' } });
    const id = c.json.id;
    await pool.query(`UPDATE connections SET status = 'active', last_test = $2 WHERE id = $1`, [id, okTest()]);
    const s = await admin.put(`/connections/${id}/secrets`, { appSecret: 'neues-app-geheimnis' });
    expect(s.json).toMatchObject({ retest: true, deactivated: true });
    expect(await row(id)).toMatchObject({ status: 'draft', last_test: null });
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(409);
    // Angehalten mit bestandenem Test: unveränderte Einstellungen erlauben die Wiederaufnahme, geänderte nicht
    await pool.query(`UPDATE connections SET status = 'disabled', last_test = $2 WHERE id = $1`, [id, okTest()]);
    expect((await admin.put(`/connections/${id}`, { name: 'Facebook Neutest (Seite)', config: { appId: '1111' } })).json.retest).toBe(false);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);
    expect((await admin.post(`/connections/${id}/disable`)).status).toBe(200);
    const changed = await admin.put(`/connections/${id}`, { name: 'Facebook Neutest (Seite)', config: { appId: '2222' } });
    expect(changed.json).toMatchObject({ retest: true, deactivated: false });
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(409);
    const a = await one<any>(`SELECT details FROM audit_events WHERE action = 'connection.retest_required' AND object_id = $1::text ORDER BY id DESC LIMIT 1`, [id]);
    expect(a.details.vorher).toBe('angehalten');
    await pool.query('DELETE FROM connections WHERE id = $1', [id]);
  });

  it('RSS: Quelle nur nach erfolgreichem Abruf hinzufügen oder auf eine neue Adresse umstellen', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/kein-feed') {
        res.setHeader('content-type', 'text/html');
        return res.end('<html><body>Keine Meldungen</body></html>');
      }
      if (req.url === '/fehler') {
        res.statusCode = 500;
        return res.end('kaputt');
      }
      res.setHeader('content-type', 'application/rss+xml');
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Quelle ${req.url}</title><link>https://news.example.org/</link><item><guid>${req.url}-1</guid><title>Eintrag</title></item></channel></rss>`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    await setSettings({ 'security.allowed_private_hosts': ['127.0.0.1'] } as any);
    try {
      for (const bad of [`${base}/kein-feed`, `${base}/fehler`, 'http://127.0.0.1:1/nichts']) {
        const r = await editor.post('/rss/feeds', { url: bad });
        expect(r.status, bad).toBe(400);
        expect(r.json.message).toContain('Quelle nicht übernommen');
      }
      expect((await one<any>(`SELECT count(*)::int AS n FROM rss_feeds WHERE url LIKE $1`, [`${base}%`]))!.n).toBe(0);
      const add = await editor.post('/rss/feeds', { url: `${base}/eins` });
      expect(add.status).toBe(200);
      const id = add.json.feed.id;
      // Neue Adresse, die keinen Feed liefert: abgewiesen, alte Adresse bleibt
      const bad = await editor.put(`/rss/feeds/${id}`, { url: `${base}/kein-feed`, title: 'Umbenannt', intervalMin: 60 });
      expect(bad.status).toBe(400);
      expect((await one<any>(`SELECT url, title, interval_min FROM rss_feeds WHERE id = $1`, [id]))).toMatchObject({ url: `${base}/eins`, interval_min: 30 });
      // Nur Name und Intervall: ohne Abruf
      expect((await editor.put(`/rss/feeds/${id}`, { url: `${base}/eins`, title: 'Umbenannt', intervalMin: 60 })).status).toBe(200);
      const ok = await editor.put(`/rss/feeds/${id}`, { url: `${base}/zwei`, title: 'Umbenannt', intervalMin: 60 });
      expect(ok.status).toBe(200);
      expect(ok.json.added).toBe(1);
      expect(await one<any>(`SELECT url, title, interval_min FROM rss_feeds WHERE id = $1`, [id])).toMatchObject({ url: `${base}/zwei`, title: 'Umbenannt', interval_min: 60 });
      expect((await publisher.put(`/rss/feeds/${id}`, { url: `${base}/eins`, title: 'X', intervalMin: 30 })).status).toBe(403);
      await editor.raw('DELETE', `/rss/feeds/${id}`);
    } finally {
      srv.close();
    }
  });

  it('E-Mail-Versand: Testmodus aus und Änderungen im Echtbetrieb nur nach erfolgreicher Testmail mit genau diesen Werten', async () => {
    const { getSettings } = await import('../src/lib/settings.js');
    const before = await getSettings(true);
    const keep: any = {};
    for (const k of ['smtp.host', 'smtp.port', 'smtp.security', 'smtp.user', 'smtp.from', 'smtp.password_secret_id', 'smtp.verified', 'warnings.test_mode', 'warnings.test_recipient']) keep[k] = (before as any)[k];
    const { SMTPServer } = await import('smtp-server');
    const received: string[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      disableReverseLookup: true,
      logger: false,
      onData(stream: any, session: any, cb: any) {
        stream.on('data', () => {});
        stream.on('end', () => (received.push(session.envelope.rcptTo.map((r: any) => r.address).join(',')), cb()));
      },
    } as any);
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    const port = (smtp.server.address() as any).port;
    // Eigene Adresse für die Testmails (Ratenbegrenzung je IP), gleiche Sitzung
    const mailer = new Client(app, '198.51.100.24');
    mailer.cookie = admin.cookie;
    try {
      const base = { host: '127.0.0.1', port, security: 'none', user: '', from: 'blaulichtcms@example.org', testRecipient: 'testpostfach@example.org' };
      expect((await admin.put('/warning-settings', { ...base, testMode: true })).status).toBe(200);
      const off = await admin.put('/warning-settings', { ...base, testMode: false });
      expect(off.status).toBe(409);
      expect(off.json.message).toContain('Testmail');
      // Fehlgeschlagene Testmail (falscher Port) zählt nicht
      expect((await mailer.post('/warning-settings/test-mail', { to: 'pruefung@example.org', ...base, port: 1 })).status).toBe(502);
      expect((await admin.put('/warning-settings', { ...base, testMode: false })).status).toBe(409);
      // Testmail mit den (noch nicht gespeicherten) Formularwerten
      expect((await admin.put('/warning-settings', { ...base, from: 'alt@example.org', testMode: true })).status).toBe(200);
      const t = await mailer.post('/warning-settings/test-mail', { to: 'pruefung@example.org', ...base });
      expect(t.status, JSON.stringify(t.json)).toBe(200);
      expect(t.json.verified_at).toBeTruthy();
      expect(received).toContain('pruefung@example.org');
      expect((await admin.put('/warning-settings', { ...base, testMode: false })).status).toBe(200);
      expect((await getSettings(true))['warnings.test_mode']).toBe(false);
      // Im Echtbetrieb: geänderte Versandeinstellungen nur nach neuer Testmail; Testmodus einschalten geht immer
      expect((await admin.put('/warning-settings', { ...base, from: 'neu@example.org', testMode: false })).status).toBe(409);
      expect((await admin.put('/warning-settings', { ...base, testRecipient: 'anderes-postfach@example.org', testMode: false })).status).toBe(200);
      expect((await admin.put('/warning-settings', { ...base, from: 'neu@example.org', testMode: true })).status).toBe(200);
      // Veralteter Nachweis (> 60 Minuten) reicht nicht
      expect((await mailer.post('/warning-settings/test-mail', { to: 'pruefung@example.org', ...base, from: 'neu@example.org' })).status).toBe(200);
      const v = (await getSettings(true))['smtp.verified']!;
      await setSettings({ 'smtp.verified': { ...v, at: new Date(Date.now() - 2 * 3600_000).toISOString() } } as any);
      expect((await admin.put('/warning-settings', { ...base, from: 'neu@example.org', testMode: false })).status).toBe(409);
      // #100 bleibt: ohne Verschlüsselung keine Anmeldung, auch nicht für die Testmail
      expect((await mailer.post('/warning-settings/test-mail', { to: 'pruefung@example.org', ...base, user: 'postfach', password: 'geheim' })).status).toBe(400);
      // Gespeichertes Passwort geht nicht an einen anderen Server
      expect((await admin.put('/warning-settings', { ...base, security: 'starttls', user: 'postfach', password: 'geheim', testMode: true })).status).toBe(200);
      const other = await mailer.post('/warning-settings/test-mail', { to: 'pruefung@example.org', ...base, host: 'localhost', security: 'starttls', user: 'postfach' });
      expect(other.status).toBe(400);
      expect(other.json.message).toContain('Passwort');
      expect((await admin.patch('/settings', { 'smtp.verified': null })).status).toBe(400);
    } finally {
      smtp.close();
      await setSettings(keep);
    }
  });
});

describe('SMTP-Passwort: alte Versionen werden widerrufen (#172)', () => {
  it('ein neues Passwort widerruft das bisherige Geheimnis', async () => {
    const { getSettings } = await import('../src/lib/settings.js');
    const before = await getSettings(true);
    const keep: any = {};
    for (const k of ['smtp.host', 'smtp.port', 'smtp.security', 'smtp.user', 'smtp.from', 'smtp.password_secret_id', 'warnings.test_mode', 'warnings.test_recipient']) keep[k] = (before as any)[k];
    const body = { host: 'smtp.example.org', port: 587, security: 'starttls', user: 'postfach', from: 'blaulichtcms@example.org', testMode: true, testRecipient: '' };
    expect((await admin.put('/warning-settings', { ...body, password: 'erstes-passwort' })).status).toBe(200);
    const first = (await getSettings(true))['smtp.password_secret_id'];
    expect((await admin.put('/warning-settings', { ...body, password: 'zweites-passwort' })).status).toBe(200);
    const second = (await getSettings(true))['smtp.password_secret_id'];
    expect(second).not.toBe(first);
    expect((await one<any>('SELECT revoked_at FROM secrets WHERE id = $1', [first]))!.revoked_at).not.toBeNull();
    expect((await one<any>('SELECT revoked_at FROM secrets WHERE id = $1', [second]))!.revoked_at).toBeNull();
    await setSettings(keep);
  });
});

describe('Benachrichtigungen als gelesen markieren (#173)', () => {
  it('übergeht gelöschte und fremde IDs statt mit 500 zu scheitern', async () => {
    const other = await one<any>(`SELECT id FROM users WHERE email <> 'admin@example.org' LIMIT 1`);
    const own = await one<any>(`INSERT INTO notifications (permission, kind, title) VALUES (NULL, 'info', 'Für alle') RETURNING id`);
    const foreign = await one<any>(`INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'info', 'Nur für jemand anderen') RETURNING id`, [other!.id]);
    const gone = await one<any>(`INSERT INTO notifications (kind, title) VALUES ('info', 'Gleich weg') RETURNING id`);
    await pool.query('DELETE FROM notifications WHERE id = $1', [gone!.id]);
    const r = await admin.post('/notifications/read', { ids: [Number(own!.id), Number(foreign!.id), Number(gone!.id)] });
    expect(r.status).toBe(200);
    const reads = await many<any>(`SELECT notification_id FROM notification_reads WHERE notification_id = ANY($1::bigint[])`, [[own!.id, foreign!.id]]);
    expect(reads.map((x) => String(x.notification_id))).toEqual([String(own!.id)]);
  });
});

describe('Gleichzeitige Einladung derselben Adresse (#174)', () => {
  it('liefert einmal 200 und einmal 409 statt 500', async () => {
    const results = await Promise.all([1, 2, 3].map(() => admin.post('/users/invite', { email: 'Doppelt@Example.org', roles: ['viewer'] })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(results.find((r) => r.status === 409)!.json.message).toContain('schon ein Konto');
  });
});

describe('Upload-Sitzung nach Löschen der Datei (#176)', () => {
  it('erneuter Upload derselben Datei wird nicht als „vollständig“ gemeldet', async () => {
    const col = (await admin.post('/collections', { title: 'Sitzung nach Löschen', createLink: false })).json.collection;
    const data = await photoWithGps();
    const base = `/collections/${col.id}/upload-sessions`;
    const put = (url: string, d: Buffer) => admin.raw('PUT', url, { payload: d, headers: { 'content-type': 'application/octet-stream' } });
    const s = await admin.post(base, { clientKey: 'geloescht-key-01', name: 'foto.jpg', size: data.length, type: 'image/jpeg' });
    const done = await put(`${base}/${s.json.id}?offset=0`, data);
    expect(done.json.complete).toBe(true);
    const mediaId = done.json.media.id;
    expect((await admin.raw('DELETE', `/media/${mediaId}`)).status).toBe(200);
    expect(await one('SELECT 1 FROM upload_sessions WHERE media_id = $1', [mediaId])).toBeNull();
    const again = await admin.post(base, { clientKey: 'geloescht-key-01', name: 'foto.jpg', size: data.length, type: 'image/jpeg' });
    expect(again.status).toBe(200);
    expect(again.json.complete).toBe(false);
    expect(again.json.received).toBe(0);
    const redo = await put(`${base}/${again.json.id}?offset=0`, data);
    expect(redo.json.complete).toBe(true);
    expect(redo.json.media.id).not.toBe(mediaId);
    // Altbestand: Sitzung zeigt noch auf eine weich gelöschte Datei → Status-Abfrage meldet 410, Neuanmeldung klappt
    await pool.query('UPDATE media SET deleted_at = now() WHERE id = $1', [redo.json.media.id]);
    expect((await admin.get(`${base}/${again.json.id}`)).status).toBe(410);
    expect((await admin.post(base, { clientKey: 'geloescht-key-01', name: 'foto.jpg', size: data.length, type: 'image/jpeg' })).json.complete).toBe(false);
  });
});

describe('Upload-Abschluss nach Löschen der Sammlung (#178)', () => {
  it('meldet 410 statt Fremdschlüssel-Fehler und entfernt die temporäre Datei', async () => {
    const { finalizeUpload } = await import('../src/routes/media.js');
    const tmp = path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'finalize-gone.tmp');
    fs.writeFileSync(tmp, 'x');
    const ctx: any = { collection: { id: crypto.randomUUID(), max_files: 10, max_bytes: 1000 }, linkId: null, userId: null, maxFileBytes: 1000, actor: { id: null, name: 'Test', type: 'system' } };
    await expect(finalizeUpload({ ...ctx, stored: { tmpPath: tmp, size: 1, sha256: 'a'.repeat(64) }, name: 'x.jpg', declaredType: 'image/jpeg', note: '', clientKey: 'gone-key-00001' })).rejects.toMatchObject({ status: 410, code: 'collection_gone' });
    expect(fs.existsSync(tmp)).toBe(false);
    const col = (await admin.post('/collections', { title: 'Gleich geschlossen', createLink: false })).json.collection;
    await pool.query('UPDATE collections SET archived_at = now() WHERE id = $1', [col.id]);
    fs.writeFileSync(tmp, 'x');
    await expect(finalizeUpload({ ...ctx, collection: { id: col.id, max_files: 10, max_bytes: 1000 }, stored: { tmpPath: tmp, size: 1, sha256: 'a'.repeat(64) }, name: 'x.jpg', declaredType: 'image/jpeg', note: '', clientKey: 'gone-key-00002' })).rejects.toMatchObject({ status: 410, code: 'link_closed' });
  });
});

describe('Import: Sammlungs-Marker ohne Platzhalter (#177)', () => {
  it('„einsatz_1“ trifft nicht die Sammlung „einsatz-1“', async () => {
    const imp = await import('../src/ops/import.js');
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'import-marker-'));
    const manifest = { format: 'blaulichtcms-import/1', source: 'markerquelle', collections: [{ ref: 'einsatz-1', title: 'Einsatz Bindestrich', media: [] }] };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    await imp.commitImport(dir);
    manifest.collections.push({ ref: 'einsatz_1', title: 'Einsatz Unterstrich', media: [] });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const r = await imp.commitImport(dir);
    expect(r.created.collections).toBe(1);
    const notes = await many<any>(`SELECT title FROM collections WHERE note LIKE '%[import:markerquelle:%' ORDER BY title`);
    expect(notes.map((n) => n.title)).toEqual(['Einsatz Bindestrich', 'Einsatz Unterstrich']);
  });
});

describe('Banner-Änderung: Ende vor gespeichertem Start (#181)', () => {
  it('liefert einen Validierungsfehler statt eines internen Fehlers', async () => {
    const siteId = (await admin.post('/sites', { name: 'Banner-Zeitraum' })).json.site.id;
    const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const base = { siteId, title: 'Zeitraum (fiktiv)', text: 'Hinweis.', tone: 'info', priority: 2 };
    const b = await editor.post('/banners', { ...base, startsAt, endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(b.status).toBe(200);
    const r = await editor.put(`/banners/${b.json.id}`, { ...base, endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('Das Ende muss nach dem Start liegen.');
    expect((await editor.put(`/banners/${b.json.id}`, { ...base, endsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() })).status).toBe(200);
  });
});

describe('Automatische Banner nur für gekoppelte Websites (#168)', () => {
  it('Prüfung beim Speichern, Abschalten beim Abruf und beim Website-Widerruf', async () => {
    const siteId = (await admin.post('/sites', { name: 'Banner-Ziel (Warnfeed)' })).json.site.id;
    const review = { approvedAt: new Date().toISOString() };
    const cfg = { format: 'cap', url: 'https://warn.example.invalid/cap.xml', autoBanner: true, bannerSiteId: siteId, review };
    const c = (await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('warnfeed', 'Banner-Ziel-Feed', 'active', $1) RETURNING *`, [JSON.stringify(cfg)]))!;
    // Speichern: Website noch nicht gekoppelt → abgelehnt (erstes Speichern ergänzt Standardwerte und verwirft die Prüfung)
    await admin.put(`/connections/${c.id}`, { name: 'Banner-Ziel-Feed', config: {} });
    await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [c.id, JSON.stringify({ review })]);
    const put = await admin.put(`/connections/${c.id}`, { name: 'Banner-Ziel-Feed', config: { autoBanner: true, bannerSiteId: siteId } });
    expect(put.status).toBe(400);
    expect(put.json.message).toContain('nicht gekoppelt');
    // Abruf: nicht gekoppelte Website → automatische Banner aus (vor dem Abruf, der hier scheitert)
    const { refreshWarnfeed } = await import('../src/connections/warnfeed.js');
    await pool.query(`UPDATE connections SET config = config || '{"autoBanner": true}'::jsonb WHERE id = $1`, [c.id]);
    await refreshWarnfeed((await one<any>(`SELECT * FROM connections WHERE id = $1`, [c.id]))!).catch(() => null);
    expect((await one<any>(`SELECT config FROM connections WHERE id = $1`, [c.id]))!.config.autoBanner).toBe(false);
    // Website-Widerruf schaltet automatische Banner der Feeds ab, die auf sie zeigen
    await pool.query(`UPDATE wp_sites SET status = 'active' WHERE id = $1`, [siteId]);
    await pool.query(`UPDATE connections SET config = config || '{"autoBanner": true}'::jsonb WHERE id = $1`, [c.id]);
    expect((await admin.post(`/sites/${siteId}/revoke`)).status).toBe(200);
    expect((await one<any>(`SELECT config FROM connections WHERE id = $1`, [c.id]))!.config.autoBanner).toBe(false);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'connection.auto_banner_disabled' AND object_id = $1 AND details->>'grund' LIKE 'Kopplung%'`, [c.id])).not.toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE '%Banner-Ziel-Feed%automatische Banner abgeschaltet'`)).not.toBeNull();
    await pool.query(`UPDATE connections SET status = 'revoked' WHERE id = $1`, [c.id]);
  });
});

/** Geprüftes Foto in einer eigenen Sammlung (für die Tests des Datenmodell-Reviews). */
async function readyPhoto(title: string, key: string) {
  const col = (await admin.post('/collections', { title, createLink: false })).json.collection;
  const data = await photoWithGps();
  const base = `/collections/${col.id}/upload-sessions`;
  const s = await admin.post(base, { clientKey: key, name: 'foto.jpg', size: data.length, type: 'image/jpeg' });
  const done = await admin.raw('PUT', `${base}/${s.json.id}?offset=0`, { payload: data, headers: { 'content-type': 'application/octet-stream' } });
  const id = done.json.media.id as string;
  await processMedia(id);
  expect((await one<any>(`SELECT status, has_public FROM media WHERE id = $1`, [id]))).toMatchObject({ status: 'ready', has_public: true });
  return { id, collectionId: col.id as string };
}

describe('Render-Auftrag nach Löschen der Datei (#164)', () => {
  it('legt die öffentliche Fassung nicht wieder an, wenn die Datei währenddessen gelöscht wurde', async () => {
    const { renderPublic } = await import('../src/media/privacy.js');
    const { id } = await readyPhoto('Render nach Löschen', 'render-geloescht-1');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM media WHERE id = $1', [id]);
      const render = renderPublic(id);
      await new Promise((r) => setTimeout(r, 1500));
      await client.query('COMMIT');
      fs.rmSync(mediaPaths.original(id), { force: true }); // wie removeMediaFiles der Löschung
      expect(await render).toBe(false);
    } finally {
      client.release();
    }
    expect(fs.existsSync(mediaPaths.publicFile(id, 'jpg'))).toBe(false);
  });
});

describe('Sammeldownload nach Löschen (#163)', () => {
  it('laufender Export verwirft sein ZIP, wenn der Datensatz währenddessen gelöscht wurde', async () => {
    const { buildExport, exportPath } = await import('../src/media/exports.js');
    const { collectionId } = await readyPhoto('Export während Löschung', 'export-race-0001');
    const r = await admin.post(`/collections/${collectionId}/exports`, { selection: 'all', variant: 'original' });
    expect(r.status).toBe(200);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE media IN ACCESS EXCLUSIVE MODE'); // Export hängt nach „running“ beim Lesen der Medien
      const build = buildExport(r.json.id);
      await new Promise((res) => setTimeout(res, 500));
      expect((await one<any>(`SELECT status FROM exports WHERE id = $1`, [r.json.id]))!.status).toBe('running');
      await client.query('DELETE FROM exports WHERE id = $1', [r.json.id]);
      await client.query('COMMIT');
      await build;
    } finally {
      client.release();
    }
    expect(fs.existsSync(exportPath(r.json.id))).toBe(false);
  });

  it('Datenschutz-Löschung einer Datei verwirft fertige Sammeldownloads mit dieser Datei', async () => {
    const { buildExport, exportPath, cleanupExports } = await import('../src/media/exports.js');
    const { id, collectionId } = await readyPhoto('Export und Datenschutz', 'export-privacy-01');
    const r = await admin.post(`/collections/${collectionId}/exports`, { selection: 'all', variant: 'original' });
    await buildExport(r.json.id);
    expect(fs.existsSync(exportPath(r.json.id))).toBe(true);
    expect((await admin.post('/privacy/action', { kind: 'media', id, action: 'delete' })).status).toBe(200);
    expect((await one<any>(`SELECT status FROM exports WHERE id = $1`, [r.json.id]))!.status).toBe('expired');
    expect(fs.existsSync(exportPath(r.json.id))).toBe(false);
    // Verwaiste ZIP-Datei ohne Datensatz wird nach 1 h aufgeräumt
    const orphan = exportPath(crypto.randomUUID());
    fs.writeFileSync(orphan, 'PK');
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(orphan, old, old);
    await cleanupExports();
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe('Datenschutz-Änderung während des Renderns (#165)', () => {
  it('rendert mit dem neuen Stand nach, statt die überholte Fassung zu übernehmen', async () => {
    const { renderPublic } = await import('../src/media/privacy.js');
    const { id } = await readyPhoto('Änderung während Render', 'render-aenderung-1');
    const rev0 = (await one<any>(`SELECT public_rev FROM media WHERE id = $1`, [id]))!.public_rev;
    const client = await pool.connect();
    let render: Promise<boolean>;
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM media WHERE id = $1 FOR UPDATE', [id]);
      render = renderPublic(id); // rendert ohne Zuschnitt und wartet dann auf die Zeilensperre
      await new Promise((r) => setTimeout(r, 1500));
      await client.query(`UPDATE media SET crop = '{"x":0,"y":0,"w":0.5,"h":0.5}' WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await render!).toBe(true);
    const meta = await sharp(mediaPaths.publicFile(id, 'jpg')).metadata();
    expect([meta.width, meta.height]).toEqual([320, 240]);
    expect((await one<any>(`SELECT public_rev FROM media WHERE id = $1`, [id]))!.public_rev).toBe(rev0 + 1);
    const leftovers = fs.readdirSync(path.dirname(mediaPaths.publicFile(id, 'jpg'))).filter((f) => f.startsWith(id) && f.endsWith('.neu'));
    expect(leftovers).toEqual([]);
  });
});

describe('Gelöschte Dateien in freigegebenen Fassungen (#167)', () => {
  it('sperrt Veröffentlichung und Auslieferung mit klarer Meldung, statt ohne Bilder zu veröffentlichen', async () => {
    const { approvalStillValid } = await import('../src/lib/approval.js');
    const siteId = (await admin.post('/sites', { name: 'Fehlende Dateien' })).json.site.id;
    await pool.query(`UPDATE wp_sites SET status = 'active', site_url = 'https://fehlende-dateien.example.org' WHERE id = $1`, [siteId]);
    const { id: mediaId } = await readyPhoto('Fehlende Dateien', 'fehlend-key-0001');
    const pid = (await editor.post('/posts', { title: 'Mit Foto (fiktiv)' })).json.id;
    let d = (await editor.get(`/posts/${pid}`)).json;
    expect((await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Mit Foto (fiktiv)', body: 'Text.', siteId, mediaIds: [mediaId], coverId: mediaId })).status).toBe(200);
    d = (await editor.get(`/posts/${pid}`)).json;
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    expect((await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(200);
    expect(d.missing_media).toBe(0);
    // Archiviert, Löschfrist löscht die Datei endgültig, Beitrag wird wieder aufgenommen
    await editor.patch(`/posts/${pid}`, { archived: true });
    await pool.query('DELETE FROM media WHERE id = $1', [mediaId]);
    const un = await editor.patch(`/posts/${pid}`, { archived: false });
    expect(un.json.missingMedia).toBe(1);
    d = (await editor.get(`/posts/${pid}`)).json;
    expect(d.missing_media).toBe(1);
    const pub = await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(pub.status).toBe(409);
    expect(pub.json.error).toBe('media_missing');
    const aid = (await one<any>(`SELECT id FROM approvals WHERE post_id = $1 AND decision = 'approved'`, [pid]))!.id;
    expect((await one<any>(`SELECT ${approvalStillValid('x')} AS ok FROM (SELECT $1::uuid AS approval_id) x`, [aid]))!.ok).toBe(false);
    // Neue Fassung ohne die Datei lässt sich speichern
    expect((await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: 'Mit Foto (fiktiv)', body: 'Text.', siteId, mediaIds: [], coverId: null })).status).toBe(200);
    expect((await editor.get(`/posts/${pid}`)).json.missing_media).toBe(0);
    await pool.query(`UPDATE wp_sites SET status = 'revoked', revoked_at = now() WHERE id = $1`, [siteId]);
  });
});

describe('Storys, Threads, X und Teilen von Hand (#188, #189)', () => {
  // Lokaler Ersatz für Graph API (Facebook/Instagram), Threads-API und X-API – es geht nichts an echte Dienste.
  let mock: import('node:http').Server;
  let base = '';
  const calls: { method: string; path: string; params: URLSearchParams; body: string; headers: Record<string, any> }[] = [];
  const state = { igContainers: {} as Record<string, string>, xLevel: 'read-write', xSigOk: true, stories: [] as any[] };
  const X_SECRETS = { apiKey: 'x-api-key-test', apiSecret: 'x-api-secret-test-geheim', accessToken: '123-x-access-token-test', accessTokenSecret: 'x-access-secret-test-geheim' };
  let fbId = '';
  let igId = '';
  let thId = '';
  let xApiId = '';
  let xManId = '';
  let waId = '';
  let postId = '';
  // Eigene Adresse für die Verwaltung: Verbindungstests sind je Adresse auf 10 je Minute begrenzt
  let adm: Client;

  beforeAll(async () => {
    adm = new Client(app, '10.77.0.1');
    adm.cookie = admin.cookie;
    const { oauth1Sign } = await import('../src/connections/x.js');
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const u = new URL(req.url!, 'http://x');
        const params = new URLSearchParams(req.method === 'GET' || req.method === 'DELETE' ? u.search : body);
        calls.push({ method: req.method!, path: u.pathname, params, body, headers: req.headers });
        const json = (code: number, v: any, headers: Record<string, string> = {}) => {
          res.writeHead(code, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(v));
        };
        const p = u.pathname;
        // Facebook
        if (p === '/fb/PAGE2' && req.method === 'GET') return json(200, { id: 'PAGE2', name: 'Story-Seite (fiktiv)' });
        if (p === '/fb/PAGE2/feed' && req.method === 'POST') return json(200, { id: `PAGE2_${calls.length}` });
        if (p.startsWith('/fb/PAGE2_') && req.method === 'DELETE') return json(200, { success: true });
        if (p === '/fb/PAGE2/photos') return json(200, { id: 'PHOTO1' });
        if (p === '/fb/PAGE2/photo_stories') {
          state.stories.push({ post_id: 'FBSTORY1', media_id: params.get('photo_id'), creation_time: Math.floor(Date.now() / 1000) });
          return json(200, { success: true, post_id: 'FBSTORY1' });
        }
        if (p === '/fb/PAGE2/stories') return json(200, { data: state.stories });
        // Instagram
        if (p === '/ig/me') return json(200, { user_id: 'IG2', username: 'story_konto', account_type: 'BUSINESS' });
        if (p === '/ig/IG2/content_publishing_limit') return json(200, { data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
        if (p === '/ig/IG2/media' && req.method === 'POST') {
          const id = `SC${Object.keys(state.igContainers).length + 1}`;
          state.igContainers[id] = 'FINISHED';
          return json(200, { id });
        }
        if (p === '/ig/IG2/media_publish') {
          state.igContainers[params.get('creation_id')!] = 'PUBLISHED';
          return json(200, { id: `SM${calls.length}` });
        }
        if (/^\/ig\/SC\d+$/.test(p)) return json(200, { status_code: state.igContainers[p.slice(4)] ?? 'ERROR' });
        if (/^\/ig\/SM\d+$/.test(p)) return json(200, { permalink: `https://instagram.example/p/${p.slice(4)}` });
        // Threads
        if (p === '/th/oauth/access_token' && req.method === 'POST') return json(200, { access_token: 'TH-KURZ-TOKEN', user_id: 'TH1' });
        if (p === '/th/access_token') return json(200, { access_token: 'TH-LANG-TOKEN-geheim', token_type: 'bearer', expires_in: 5_184_000 });
        if (p === '/th/refresh_access_token') return json(200, { access_token: 'TH-VERLAENGERT-geheim', token_type: 'bearer', expires_in: 5_184_000 });
        if (p === '/th/v1.0/me') return json(200, { id: 'TH1', username: 'threads_test' });
        if (p === '/th/v1.0/TH1/threads_publishing_limit') return json(200, { data: [{ quota_usage: 0, config: { quota_total: 250 } }] });
        if (p === '/th/v1.0/TH1/threads' && req.method === 'POST') return json(200, { id: `TC${calls.length}` });
        if (p === '/th/v1.0/TH1/threads' && req.method === 'GET') return json(200, { data: [] });
        if (/^\/th\/v1\.0\/TC\d+$/.test(p)) return json(200, { status: 'FINISHED' });
        if (p === '/th/v1.0/TH1/threads_publish') return json(200, { id: 'TP1' });
        if (p === '/th/v1.0/TP1') return json(200, { permalink: 'https://threads.example/@threads_test/post/TP1' });
        // X: Signatur mit den bekannten Testgeheimnissen nachrechnen
        if (p.startsWith('/x/')) {
          const h = String(req.headers.authorization ?? '');
          const kv = Object.fromEntries([...h.replace(/^OAuth /, '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
          const expected = oauth1Sign(req.method!, `${base}${req.url}`, { consumerKey: X_SECRETS.apiKey, consumerSecret: X_SECRETS.apiSecret, token: X_SECRETS.accessToken, tokenSecret: X_SECRETS.accessTokenSecret }, {}, { nonce: kv.oauth_nonce, timestamp: Number(kv.oauth_timestamp) }).signature;
          if (kv.oauth_signature !== expected) {
            state.xSigOk = false;
            return json(401, { title: 'Unauthorized', detail: 'Signatur falsch (Test)' });
          }
          if (p === '/x/2/users/me') return json(200, { data: { id: '42', username: 'x_test', name: 'X Test' } }, { 'x-access-level': state.xLevel });
          if (p === '/x/2/media/upload') return json(200, { data: { id: 'XMEDIA1', media_key: '3_1' } });
          if (p === '/x/2/tweets' && req.method === 'POST') return json(201, { data: { id: 'TW1', text: JSON.parse(body).text } });
          if (p === '/x/2/tweets/TW1' && req.method === 'DELETE') return json(200, { data: { deleted: true } });
        }
        json(404, { error: { message: `unbekannt ${p}` } });
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(mock.address() as any).port}`;
    process.env.BLAULICHTCMS_META_GRAPH_URL = `${base}/fb`;
    process.env.BLAULICHTCMS_IG_GRAPH_URL = `${base}/ig`;
    process.env.BLAULICHTCMS_THREADS_GRAPH_URL = `${base}/th/v1.0`;
    process.env.BLAULICHTCMS_X_API_URL = `${base}/x`;
  });
  afterAll(() => {
    mock?.close();
    delete process.env.BLAULICHTCMS_THREADS_GRAPH_URL;
    delete process.env.BLAULICHTCMS_X_API_URL;
  });

  it('Facebook und Instagram: Test meldet Storys', async () => {
    fbId = (await adm.post('/connections', { kind: 'facebook', name: 'Story-Seite', config: { appId: '1' } })).json.id;
    await adm.put(`/connections/${fbId}/secrets`, { pageToken: 'EAAG-story-seitentoken' });
    await adm.put(`/connections/${fbId}`, { name: 'Story-Seite', config: { pageId: 'PAGE2' } });
    const t = await adm.post(`/connections/${fbId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.capabilities.stories).toBe(true);
    expect((await adm.post(`/connections/${fbId}/activate`)).status).toBe(200);
    igId = (await adm.post('/connections', { kind: 'instagram', name: 'Story-Konto', config: { appId: '1' } })).json.id;
    await adm.put(`/connections/${igId}/secrets`, { token: 'IGQ-story-token' });
    const t2 = await adm.post(`/connections/${igId}/test`);
    expect(t2.json.ok, JSON.stringify(t2.json)).toBe(true);
    expect(t2.json.capabilities.stories).toBe(true);
    expect((await adm.post(`/connections/${igId}/activate`)).status).toBe(200);
  });

  it('Threads: Anmeldung über OAuth, Test ohne Veröffentlichung, Token verschlüsselt', async () => {
    expect((await editor.post('/connections', { kind: 'threads', name: 'Threads' })).status).toBe(403);
    thId = (await adm.post('/connections', { kind: 'threads', name: 'Threads-Profil (Test)', config: { appId: '777' } })).json.id;
    expect((await adm.post(`/connections/${thId}/oauth/start`)).status).toBe(400);
    await adm.put(`/connections/${thId}/secrets`, { appSecret: 'threads-app-geheimnis' });
    const start = await adm.post(`/connections/${thId}/oauth/start`);
    expect(start.status).toBe(200);
    const url = new URL(start.json.url);
    expect(url.origin + url.pathname).toBe('https://threads.com/oauth/authorize');
    // threads_manage_insights für die Reichweite (#218) wird mit angefragt, ist aber keine Voraussetzung
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish,threads_manage_insights');
    expect(url.searchParams.get('client_id')).toBe('777');
    const back = await anonymous.raw('GET', `/connections/oauth/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=CODE1`);
    expect(back.status).toBe(302);
    expect(decodeURIComponent(String(back.headers.location))).toContain('Mit Threads verbunden');
    const v = (await adm.get(`/connections/${thId}`)).json;
    expect(v.secrets_set).toEqual(expect.arrayContaining(['appSecret', 'token']));
    expect(JSON.stringify(v)).not.toContain('TH-LANG-TOKEN');
    expect(v.config.userId).toBe('TH1');
    expect(v.config.tokenExpiresAt).toBeTruthy();
    expect(v.oauth_redirect).toContain('/api/v1/connections/oauth/callback');
    const t = await adm.post(`/connections/${thId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.capabilities.link).toBe(true);
    expect(calls.some((c) => c.path === '/th/v1.0/TH1/threads_publish')).toBe(false);
    expect((await adm.post(`/connections/${thId}/activate`)).status).toBe(200);
    // Verlängern der Anmeldung kurz vor Ablauf (Worker, täglich)
    const { refreshThreadsTokens } = await import('../src/connections/threads.js');
    await pool.query(`UPDATE connections SET config = config || '{"tokenExpiresAt":"${new Date(Date.now() + 3 * 86_400_000).toISOString()}"}' WHERE id = $1`, [thId]);
    expect(await refreshThreadsTokens()).toBe(1);
    const { connectionSecrets } = await import('../src/connections/common.js');
    expect((await connectionSecrets((await one<any>(`SELECT * FROM connections WHERE id = $1`, [thId]))!)).token).toBe('TH-VERLAENGERT-geheim');
  });

  it('X: Teilen von Hand ohne Zugangsdaten; X-API mit OAuth 1.0a und Prüfung des Schreibrechts', async () => {
    xManId = (await adm.post('/connections', { kind: 'x', name: 'X von Hand' })).json.id;
    const tm = await adm.post(`/connections/${xManId}/test`);
    expect(tm.json.ok).toBe(true);
    expect(tm.json.capabilities.manual).toBe(true);
    expect((await adm.post(`/connections/${xManId}/activate`)).status).toBe(200);

    xApiId = (await adm.post('/connections', { kind: 'x', name: 'X über API', config: { mode: 'api' } })).json.id;
    expect((await adm.post(`/connections/${xApiId}/test`)).json.ok).toBe(false);
    expect((await adm.put(`/connections/${xApiId}/secrets`, X_SECRETS)).status).toBe(200);
    state.xLevel = 'read';
    const ro = await adm.post(`/connections/${xApiId}/test`);
    expect(ro.json.ok).toBe(false);
    expect(ro.json.steps.find((s: any) => s.name === 'Schreibrecht').message).toContain('Read and write');
    state.xLevel = 'read-write';
    const t = await adm.post(`/connections/${xApiId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.account.username).toBe('x_test');
    expect(state.xSigOk).toBe(true);
    const v = (await adm.get(`/connections/${xApiId}`)).json;
    expect(JSON.stringify(v)).not.toContain('geheim');
    expect(v.secrets_set.sort()).toEqual(['accessToken', 'accessTokenSecret', 'apiKey', 'apiSecret']);
    expect((await adm.post(`/connections/${xApiId}/activate`)).status).toBe(200);
    // Wechsel der Betriebsart verlangt einen neuen Test
    const sw = await adm.put(`/connections/${xManId}`, { name: 'X von Hand', config: { mode: 'api' } });
    expect(sw.json.retest).toBe(true);
    await adm.put(`/connections/${xManId}`, { name: 'X von Hand', config: { mode: 'manual' } });
    await adm.post(`/connections/${xManId}/test`);
    expect((await adm.post(`/connections/${xManId}/activate`)).status).toBe(200);
  });

  it('WhatsApp-Kanal: nur Teilen von Hand, Kanaladresse geprüft', async () => {
    expect((await adm.post('/connections', { kind: 'whatsapp', name: 'Kanal', config: { channelUrl: 'https://evil.example/channel/x' } })).status).toBe(400);
    waId = (await adm.post('/connections', { kind: 'whatsapp', name: 'WhatsApp-Kanal (Test)', config: { channelUrl: 'https://whatsapp.com/channel/0029TestKanal' } })).json.id;
    const t = await adm.post(`/connections/${waId}/test`);
    expect(t.json.ok).toBe(true);
    expect(t.json.steps[0].message).toContain('keine Schnittstelle');
    expect((await adm.post(`/connections/${waId}/activate`)).status).toBe(200);
    // Die Redaktion sieht die Kanäle mit Kennzeichen „von Hand“
    const list = (await editor.get('/connections')).json;
    expect(list.find((c: any) => c.id === waId).manual).toBe(true);
    expect(list.find((c: any) => c.id === xApiId).manual).toBe(false);
  });

  it('Format je Kanal ist Teil der Fassung; Storys nur für Facebook/Instagram', async () => {
    const { id: mediaId } = await readyPhoto('Story-Bilder', 'story-key-0001');
    postId = (await editor.post('/posts', { title: 'Brandschutztag (fiktiv)' })).json.id;
    let d = (await editor.get(`/posts/${postId}`)).json;
    const targets = [fbId, igId, thId, xApiId, xManId, waId];
    const bad = await editor.put(`/posts/${postId}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Wir laden ein.', mediaIds: [mediaId], socialTargets: targets, socialFormats: { [thId]: 'story' } });
    expect(bad.status).toBe(400);
    const ok = await editor.put(`/posts/${postId}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Wir laden ein.', mediaIds: [mediaId], socialTargets: targets, socialFormats: { [fbId]: 'story', [igId]: 'both', [xApiId]: 'feed' }, variants: { x: { body: 'Kurz für X' } } });
    expect(ok.json.changed).toBe(true);
    d = (await editor.get(`/posts/${postId}`)).json;
    expect(d.revision.social_formats).toEqual({ [fbId]: 'story', [igId]: 'both' });
    // Nur das Format ändern → neue Fassung
    const fmt = await editor.put(`/posts/${postId}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Wir laden ein.', mediaIds: [mediaId], socialTargets: targets, socialFormats: { [fbId]: 'story', [igId]: 'story' }, variants: { x: { body: 'Kurz für X' } } });
    expect(fmt.json.changed).toBe(true);
    const back = await editor.put(`/posts/${postId}/revision`, { baseRevision: fmt.json.number, title: d.revision.title, body: 'Wir laden ein.', mediaIds: [mediaId], socialTargets: targets, socialFormats: { [fbId]: 'story', [igId]: 'both' }, variants: { x: { body: 'Kurz für X' } } });
    expect(back.json.changed).toBe(true);
    d = (await editor.get(`/posts/${postId}`)).json;
    const check = (await editor.get(`/posts/${postId}/social-check`)).json;
    expect(check.find((c: any) => c.id === igId).formats).toEqual(['feed', 'story']);
    expect(check.find((c: any) => c.id === fbId).issues.join(' ')).toContain('9:16');
    expect(check.find((c: any) => c.id === waId).manual).toBe(true);
    expect(check.find((c: any) => c.id === waId).text).toContain('*Brandschutztag (fiktiv)*');
    await editor.post(`/posts/${postId}/submit`, { revision: d.revision.number });
    expect((await approver.post(`/posts/${postId}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(200);
  });

  it('Veröffentlichen: Storys, Threads und X über die Schnittstellen, X von Hand und WhatsApp „zum Teilen bereit“', async () => {
    const { runSocialPublication } = await import('../src/connections/social.js');
    const d = (await publisher.get(`/posts/${postId}`)).json;
    const r = await publisher.post(`/posts/${postId}/social`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items.length).toBe(7);
    const ready = r.json.items.filter((x: any) => x.status === 'ready');
    expect(ready.map((x: any) => x.connection_id).sort()).toEqual([xManId, waId].sort());
    // Kanäle ohne Schnittstelle landen nie in der Warteschlange
    expect((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'social.publish' AND payload->>'id' = ANY($1)`, [ready.map((x: any) => x.id)]))!.n).toBe(0);
    for (const it of r.json.items.filter((x: any) => x.status === 'queued')) await runSocialPublication(it.id);
    const rows = await many<any>(`SELECT sp.*, c.kind FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1 ORDER BY c.kind, sp.format`, [postId]);
    for (const row of rows.filter((x) => !['ready'].includes(x.status))) expect(row.status, `${row.kind}/${row.format}: ${row.error}`).toBe('published');
    // Facebook-Story: Foto unveröffentlicht hochgeladen und als Story veröffentlicht
    const photo = calls.find((c) => c.path === '/fb/PAGE2/photos')!;
    expect(photo.params.get('published')).toBe('false');
    expect(calls.find((c) => c.path === '/fb/PAGE2/photo_stories')!.params.get('photo_id')).toBe('PHOTO1');
    // Instagram: ein Container als Story (ohne Bildunterschrift), einer als Beitrag
    const igPosts = calls.filter((c) => c.path === '/ig/IG2/media' && c.method === 'POST' && c.params.get('media_type') === 'STORIES');
    expect(igPosts.length).toBe(1);
    expect(igPosts[0].params.get('caption')).toBeNull();
    // Story-Fassung des Bildes: 1080 × 1920
    const storyUrl = new URL(photo.params.get('url')!);
    const img = await anonymous.raw('GET', storyUrl.pathname);
    expect(img.status).toBe(200);
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    // Threads: Bildbeitrag mit Text
    const th = calls.find((c) => c.path === '/th/v1.0/TH1/threads' && c.method === 'POST' && c.params.get('media_type') === 'IMAGE')!;
    expect(th.params.get('text')).toContain('Brandschutztag');
    expect(rows.find((x) => x.kind === 'threads').remote_url).toContain('threads.example');
    // X über die API: Bild hochgeladen (base64 im JSON), Beitrag mit Medien-ID, signiert
    const up = calls.find((c) => c.path === '/x/2/media/upload')!;
    expect(JSON.parse(up.body).media_category).toBe('tweet_image');
    const tw = JSON.parse(calls.find((c) => c.path === '/x/2/tweets' && c.method === 'POST')!.body);
    expect(tw).toEqual({ text: 'Kurz für X', media: { media_ids: ['XMEDIA1'] } });
    expect(state.xSigOk).toBe(true);
    expect(rows.find((x) => x.kind === 'x' && x.status === 'published').remote_url).toBe('https://x.com/x_test/status/TW1');
    // Hinweis „zum Teilen bereit“ an die Veröffentlichung
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Zum Teilen bereit (WhatsApp-Kanal (Test))%'`)).not.toBeNull();
  });

  it('Teilen von Hand: vorbereiteter Text, Öffnen-Adresse, als geteilt markieren (auditiert)', async () => {
    const items = (await publisher.get(`/posts/${postId}`)).json.social;
    const xi = items.find((s: any) => s.kind === 'x' && s.status === 'ready');
    const wi = items.find((s: any) => s.kind === 'whatsapp');
    expect((await editor.get(`/social-publications/${xi.id}/share`)).status).toBe(403);
    const xs = (await publisher.get(`/social-publications/${xi.id}/share`)).json;
    expect(xs.text).toBe('Kurz für X');
    expect(xs.openUrl).toBe('https://x.com/intent/post?text=Kurz%20f%C3%BCr%20X');
    expect(xs.files.length).toBe(1);
    const ws = (await publisher.get(`/social-publications/${wi.id}/share`)).json;
    expect(ws.openUrl).toBe('https://whatsapp.com/channel/0029TestKanal');
    expect(ws.text.startsWith('*Brandschutztag (fiktiv)*')).toBe(true);
    expect((await publisher.post(`/social-publications/${xi.id}/mark-shared`, { url: 'http://unsicher.example' })).status).toBe(400);
    expect((await publisher.post(`/social-publications/${xi.id}/mark-shared`, { url: 'https://x.com/x_test/status/99' })).status).toBe(200);
    expect((await publisher.post(`/social-publications/${xi.id}/mark-shared`, {})).status).toBe(400);
    expect((await publisher.post(`/social-publications/${wi.id}/mark-shared`, {})).status).toBe(200);
    const after = (await publisher.get(`/posts/${postId}`)).json.social;
    expect(after.find((s: any) => s.id === xi.id)).toMatchObject({ status: 'published', remote_url: 'https://x.com/x_test/status/99' });
    expect(after.find((s: any) => s.id === wi.id).shared_at).toBeTruthy();
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'social.shared_manually' AND object_id = $1`, [postId]))!.n).toBe(2);
    // Über die Schnittstelle veröffentlichte Aufträge lassen sich nicht „von Hand teilen“
    const api = after.find((s: any) => s.kind === 'x' && !s.shared_at);
    expect((await publisher.get(`/social-publications/${api.id}/share`)).status).toBe(400);
  });

  it('Zurückziehen: X (API) wird gelöscht, Storys, Threads und von Hand Geteiltes von Hand', async () => {
    const r = await publisher.post(`/posts/${postId}/social/remove`, { reason: 'Test zurückziehen' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const res = r.json.items as any[];
    expect(res.find((x) => x.kind === 'x' && x.result === 'removed')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/x/2/tweets/TW1')).toBe(true);
    const manual = res.filter((x) => x.result === 'manual');
    expect(manual.length).toBe(6);
    expect(manual.some((x) => /Storys lassen sich/.test(x.message))).toBe(true);
    expect(manual.some((x) => /Von Hand geteilt/.test(x.message))).toBe(true);
    expect(manual.some((x) => x.kind === 'threads' && /Threads erlaubt kein Löschen/.test(x.message))).toBe(true);
  });

  it('Automationen: soziale Kanäle samt Story im Beitragsausgang vorauswählen', async () => {
    const bad = await adm.post('/automation-outputs', { name: 'Story Threads', kind: 'post', config: { title: 'X', socialTargets: [{ connectionId: thId, format: 'story' }] } });
    expect(bad.status).toBe(400);
    const ok = await adm.post('/automation-outputs', { name: 'Beitrag mit Story', kind: 'post', config: { title: 'Einsatz {{stichwort}}', variants: { x: { body: 'Einsatz {{stichwort}}' } }, socialTargets: [{ connectionId: igId, format: 'both' }, { connectionId: waId, format: 'feed' }] } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.config.socialTargets).toEqual([{ connectionId: igId, format: 'both' }, { connectionId: waId, format: 'feed' }]);
    const cat = (await adm.get('/automations/catalog')).json;
    expect(cat.socialChannels.find((c: any) => c.id === waId).manual).toBe(true);
    await adm.raw('DELETE', `/automation-outputs/${ok.json.id}`);
  });
});

describe('Mastodon und Bluesky (#215)', () => {
  // Lokaler Stellvertreter für eine Mastodon-Instanz (/api, /oauth) und einen Bluesky-Server (/xrpc) – nichts geht an echte Dienste.
  let mock: import('node:http').Server;
  let base = '';
  const calls: { method: string; path: string; body: Buffer; headers: Record<string, any>; query: URLSearchParams }[] = [];
  const st = { statuses: [] as any[], records: [] as any[], scheduledDeleted: 0, idem: new Map<string, string>(), mediaPending: true };
  let mdId = '';
  let bsId = '';
  let postId = '';
  let adm: Client;

  beforeAll(async () => {
    adm = new Client(app, '10.77.0.2');
    adm.cookie = admin.cookie;
    mock = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url!, 'http://x');
        calls.push({ method: req.method!, path: u.pathname, body, headers: req.headers, query: u.searchParams });
        const json = (code: number, v: any) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        };
        const p = u.pathname;
        const form = new URLSearchParams(String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded') ? body.toString() : '');
        const authed = req.headers.authorization === 'Bearer MD-TOKEN-geheim';
        // Mastodon
        if (p === '/api/v1/apps' && req.method === 'POST') return json(200, { client_id: 'MDCLIENT', client_secret: 'md-client-secret-geheim', scopes: form.get('scopes')?.split(' ') });
        if (p === '/oauth/token' && req.method === 'POST') return form.get('code') === 'MDCODE' && form.get('client_secret') === 'md-client-secret-geheim' ? json(200, { access_token: 'MD-TOKEN-geheim', token_type: 'Bearer' }) : json(400, { error: 'invalid_grant' });
        if (p === '/api/v2/instance') return json(200, { domain: 'social.example', version: '4.5.0', configuration: { statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 }, media_attachments: { description_limit: 1500 } } });
        if (p.startsWith('/api/') && !authed) return json(401, { error: 'The access token is invalid' });
        if (p === '/api/v1/accounts/verify_credentials') return json(200, { id: 'MDA1', acct: 'feuerwehr', username: 'feuerwehr', display_name: 'Feuerwehr (fiktiv)', url: 'https://social.example/@feuerwehr' });
        if (p === '/api/v1/apps/verify_credentials') return json(200, { name: 'BlaulichtCMS', scopes: ['read:accounts', 'read:statuses', 'write:statuses', 'write:media'] });
        if (p === '/api/v1/statuses' && req.method === 'POST') {
          if (form.get('scheduled_at')) return json(200, { id: 'SCH1', scheduled_at: form.get('scheduled_at'), params: { text: form.get('status') } });
          const key = String(req.headers['idempotency-key'] ?? '');
          const known = st.idem.get(key);
          if (known) return json(200, st.statuses.find((s) => s.id === known));
          const s = { id: `MS${st.statuses.length + 1}`, url: `https://social.example/@feuerwehr/MS${st.statuses.length + 1}`, created_at: new Date().toISOString(), content: `<p>${(form.get('status') ?? '').replace(/&/g, '&amp;').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`, form: Object.fromEntries([...form.keys()].map((k) => [k, form.getAll(k)])), reblogs_count: 3, favourites_count: 7, replies_count: 1 };
          st.statuses.push(s);
          st.idem.set(key, s.id);
          return json(200, s);
        }
        if (p === '/api/v1/scheduled_statuses/SCH1' && req.method === 'DELETE') {
          st.scheduledDeleted++;
          return json(200, {});
        }
        if (p === '/api/v2/media' && req.method === 'POST') return json(st.mediaPending ? 202 : 200, { id: 'MEDIA1', url: st.mediaPending ? null : 'https://social.example/m/1' });
        if (p === '/api/v1/media/MEDIA1' && req.method === 'GET') return json(200, { id: 'MEDIA1', url: 'https://social.example/m/1' });
        if (p === '/api/v1/media/MEDIA1' && req.method === 'DELETE') return json(200, {});
        if (p === '/api/v1/accounts/MDA1/statuses') return json(200, st.statuses.slice().reverse());
        if (/^\/api\/v1\/statuses\/MS\d+$/.test(p) && req.method === 'DELETE') return json(200, {});
        if (/^\/api\/v1\/statuses\/MS\d+$/.test(p)) {
          const found = st.statuses.find((s) => p.endsWith(`/${s.id}`));
          return found ? json(200, found) : json(404, { error: 'Record not found' });
        }
        // Bluesky
        if (p === '/xrpc/com.atproto.server.createSession') {
          const b = JSON.parse(body.toString() || '{}');
          if (b.password !== 'abcd-efgh-ijkl-mnop') return json(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' });
          return json(200, { accessJwt: 'BS-JWT-geheim', refreshJwt: 'BS-REFRESH', did: 'did:plc:test123', handle: 'feuerwehr.bsky.social', active: true });
        }
        if (p.startsWith('/xrpc/com.atproto.repo.') && req.headers.authorization !== 'Bearer BS-JWT-geheim') return json(401, { error: 'AuthenticationRequired' });
        if (p === '/xrpc/com.atproto.repo.uploadBlob') return json(200, { blob: { $type: 'blob', ref: { $link: `bafkrei${calls.length}` }, mimeType: req.headers['content-type'], size: body.length } });
        if (p === '/xrpc/com.atproto.repo.createRecord') {
          const b = JSON.parse(body.toString());
          const uri = `at://did:plc:test123/app.bsky.feed.post/3k${st.records.length + 1}`;
          st.records.push({ uri, cid: 'bafy', value: b.record });
          return json(200, { uri, cid: 'bafy' });
        }
        if (p === '/xrpc/com.atproto.repo.listRecords') return json(200, { records: st.records.slice().reverse() });
        if (p === '/xrpc/com.atproto.repo.deleteRecord') return json(200, {});
        if (p === '/xrpc/app.bsky.feed.getPosts') return json(200, { posts: u.searchParams.getAll('uris').map((uri) => ({ uri, likeCount: 5, repostCount: 2, replyCount: 1, quoteCount: 0 })) });
        json(404, { error: `unbekannt ${p}` });
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(mock.address() as any).port}`;
    process.env.BLAULICHTCMS_MASTODON_TEST_HOSTS = '127.0.0.1';
    process.env.BLAULICHTCMS_BSKY_TEST_SERVICE = base;
    process.env.BLAULICHTCMS_BSKY_APPVIEW_URL = base;
  });
  afterAll(() => {
    mock?.close();
    delete process.env.BLAULICHTCMS_MASTODON_TEST_HOSTS;
    delete process.env.BLAULICHTCMS_BSKY_TEST_SERVICE;
    delete process.env.BLAULICHTCMS_BSKY_APPVIEW_URL;
  });

  it('Mastodon: Instanz frei wählbar (nur https), App-Registrierung und OAuth, Test ohne öffentlichen Beitrag', async () => {
    expect((await adm.post('/connections', { kind: 'mastodon', name: 'Mastodon', config: { instance: 'http://social.example' } })).status).toBe(400);
    expect((await adm.post('/connections', { kind: 'mastodon', name: 'Mastodon', config: { instance: 'https://social.example/@feuerwehr' } })).status).toBe(400);
    mdId = (await adm.post('/connections', { kind: 'mastodon', name: 'Mastodon (Test)', config: { instance: base, visibility: 'unlisted' } })).json.id;
    expect((await adm.post(`/connections/${mdId}/test`)).json.ok).toBe(false);
    const start = await adm.post(`/connections/${mdId}/oauth/start`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const url = new URL(start.json.url);
    expect(url.origin + url.pathname).toBe(`${base}/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe('MDCLIENT');
    expect(url.searchParams.get('scope')).toBe('read:accounts read:statuses write:statuses write:media');
    const reg = calls.find((c) => c.path === '/api/v1/apps')!;
    expect(new URLSearchParams(reg.body.toString()).get('redirect_uris')).toContain('/api/v1/connections/oauth/callback');
    // Zweites Verbinden registriert nicht erneut
    const again = new URL((await adm.post(`/connections/${mdId}/oauth/start`)).json.url);
    expect(calls.filter((c) => c.path === '/api/v1/apps').length).toBe(1);
    // Nur die letzte begonnene Anmeldung gilt
    expect(decodeURIComponent(String((await anonymous.raw('GET', `/connections/oauth/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=MDCODE`)).headers.location))).toContain('ungültig');
    const back = await anonymous.raw('GET', `/connections/oauth/callback?state=${encodeURIComponent(again.searchParams.get('state')!)}&code=MDCODE`);
    expect(decodeURIComponent(String(back.headers.location))).toContain('Mit Mastodon verbunden');
    const v = (await adm.get(`/connections/${mdId}`)).json;
    expect(v.secrets_set.sort()).toEqual(['clientSecret', 'token']);
    expect(JSON.stringify(v)).not.toContain('geheim');
    const t = await adm.post(`/connections/${mdId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.capabilities).toMatchObject({ text: true, image: true, alt_text: true, max_characters: 500 });
    // Geplanter Testbeitrag wurde sofort gelöscht, nie ein echter Beitrag
    expect(st.scheduledDeleted).toBe(1);
    expect(st.statuses.length).toBe(0);
    expect((await adm.post(`/connections/${mdId}/activate`)).status).toBe(200);
    // Zugangstoken statt OAuth ist ebenfalls möglich; nur das Feld „token“ ist erlaubt
    expect((await adm.put(`/connections/${mdId}/secrets`, { clientSecret: 'x' })).status).toBe(400);
  });

  it('Bluesky: App-Passwort, Test lädt nur ein Testbild hoch', async () => {
    bsId = (await adm.post('/connections', { kind: 'bluesky', name: 'Bluesky (Test)', config: { identifier: '@feuerwehr.bsky.social', service: base } })).json.id;
    expect((await adm.get(`/connections/${bsId}`)).json.config.identifier).toBe('feuerwehr.bsky.social');
    await adm.put(`/connections/${bsId}/secrets`, { appPassword: 'falsch-falsch' });
    const bad = await adm.post(`/connections/${bsId}/test`);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.steps[0].message).toContain('App-Passwort');
    await adm.put(`/connections/${bsId}/secrets`, { appPassword: 'abcd-efgh-ijkl-mnop' });
    const t = await adm.post(`/connections/${bsId}/test`);
    expect(t.json.ok, JSON.stringify(t.json)).toBe(true);
    expect(t.json.account.username).toBe('feuerwehr.bsky.social');
    expect(st.records.length).toBe(0);
    expect(JSON.stringify((await adm.get(`/connections/${bsId}`)).json)).not.toContain('abcd-efgh');
    expect((await adm.post(`/connections/${bsId}/activate`)).status).toBe(200);
  });

  it('Beitrag mit Inhaltswarnung, Zeichenzählung und Veröffentlichung nach Freigabe', async () => {
    const { runSocialPublication } = await import('../src/connections/social.js');
    const { id: mediaId } = await readyPhoto('Mastodon-Bluesky-Bilder', 'md-bs-key-0001');
    // Alternativtext aus der Medienverwaltung (#217) geht an Mastodon (description) und Bluesky (alt)
    expect((await admin.patch(`/media/${mediaId}`, { altText: 'Drehleiter vor dem Gerätehaus' })).json.alt_text).toBe('Drehleiter vor dem Gerätehaus');
    postId = (await editor.post('/posts', { title: 'Tag der offenen Tür (fiktiv)' })).json.id;
    let d = (await editor.get(`/posts/${postId}`)).json;
    const long = 'Wir laden herzlich ein. '.repeat(30);
    const save = await editor.put(`/posts/${postId}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: long, mediaIds: [mediaId], socialTargets: [mdId, bsId], variants: { mastodon: { cw: 'Hinweis: Übung mit Rauch' } } });
    expect(save.json.changed, JSON.stringify(save.json)).toBe(true);
    d = (await editor.get(`/posts/${postId}`)).json;
    expect(d.revision.variants.mastodon).toEqual({ cw: 'Hinweis: Übung mit Rauch' });
    const check = (await editor.get(`/posts/${postId}/social-check`)).json;
    const md = check.find((c: any) => c.id === mdId);
    const bs = check.find((c: any) => c.id === bsId);
    expect(md.issues.join(' ')).toContain('gekürzt');
    expect(bs.issues.join(' ')).toContain('300 Zeichen');
    const { mastodonLength, blueskyLength } = await import('../src/connections/channels.js');
    expect(mastodonLength(md.text) + mastodonLength('Hinweis: Übung mit Rauch')).toBeLessThanOrEqual(500);
    expect(blueskyLength(bs.text)).toBeLessThanOrEqual(300);
    await editor.post(`/posts/${postId}/submit`, { revision: d.revision.number });
    // Vor der Freigabe wird nichts veröffentlicht
    expect((await publisher.post(`/posts/${postId}/social`, { revision: d.revision.number, contentHash: d.revision.content_hash })).status).toBe(409);
    expect((await approver.post(`/posts/${postId}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' })).status).toBe(200);
    const r = await publisher.post(`/posts/${postId}/social`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const it of r.json.items) await runSocialPublication(it.id);
    const rows = await many<any>(`SELECT sp.*, c.kind FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1`, [postId]);
    for (const row of rows) expect(row.status, `${row.kind}: ${row.error}`).toBe('published');
    // Mastodon: Bild hochgeladen (202 → Abfrage bis fertig), Sichtbarkeit, Inhaltswarnung, Sprache, Idempotency-Key
    const status = st.statuses[0];
    expect(status.form['media_ids[]']).toEqual(['MEDIA1']);
    expect(calls.find((c) => c.path === '/api/v2/media' && c.body.includes('Drehleiter vor dem Ger'))).toBeTruthy();
    expect(status.form.visibility).toEqual(['unlisted']);
    expect(status.form.spoiler_text).toEqual(['Hinweis: Übung mit Rauch']);
    expect(status.form.language).toEqual(['de']);
    expect(calls.some((c) => c.path === '/api/v1/media/MEDIA1' && c.method === 'GET')).toBe(true);
    const sp = rows.find((x) => x.kind === 'mastodon');
    expect(calls.find((c) => c.path === '/api/v1/statuses' && c.method === 'POST' && !new URLSearchParams(c.body.toString()).get('scheduled_at'))!.headers['idempotency-key']).toBe(`blaulichtcms-${sp.id}`);
    expect(sp.remote_url).toBe('https://social.example/@feuerwehr/MS1');
    // Bluesky: Bild als Blob, Beitrag mit Bild-Embed (alt ist Pflichtfeld), Sprache
    const rec = st.records[0].value;
    expect(rec.$type).toBe('app.bsky.feed.post');
    expect(rec.embed.$type).toBe('app.bsky.embed.images');
    expect(rec.embed.images[0].alt).toBe('Drehleiter vor dem Gerätehaus');
    expect(rec.embed.images[0].aspectRatio.width).toBeGreaterThan(0);
    expect(rec.langs).toEqual(['de']);
    expect(rows.find((x) => x.kind === 'bluesky').remote_url).toBe('https://bsky.app/profile/feuerwehr.bsky.social/post/3k1');
  });

  it('Unklarer Ausgang: Wiedererkennung statt doppeltem Beitrag', async () => {
    const { runSocialPublication } = await import('../src/connections/social.js');
    const rows = await many<any>(`SELECT sp.*, c.kind FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1`, [postId]);
    await pool.query(`UPDATE social_publications SET status = 'unknown', remote_id = NULL, remote_url = NULL WHERE post_id = $1`, [postId]);
    for (const row of rows) await runSocialPublication(row.id);
    const after = await many<any>(`SELECT sp.*, c.kind FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1`, [postId]);
    for (const row of after) expect(row.status, `${row.kind}: ${row.error}`).toBe('published');
    expect(after.find((x) => x.kind === 'mastodon').remote_id).toBe('MS1');
    expect(after.find((x) => x.kind === 'bluesky').remote_id).toBe('at://did:plc:test123/app.bsky.feed.post/3k1');
    expect(st.statuses.length).toBe(1);
    expect(st.records.length).toBe(1);
  });

  it('Reichweite (#218): Abruf nach 1 h, 24 h und 7 Tagen, nur Zahlen, Übersicht, Dashboard und Rechte', async () => {
    const { runDueInsights, stageFor } = await import('../src/connections/insights.js');
    expect(stageFor(new Date(Date.now() - 30 * 60_000))).toBe(0);
    expect(stageFor(new Date(Date.now() - 2 * 3600_000))).toBe(1);
    expect(stageFor(new Date(Date.now() - 8 * 86_400_000))).toBe(3);
    // Frisch veröffentlicht: noch nichts fällig
    await runDueInsights();
    expect((await many<any>(`SELECT insights_stage FROM social_publications WHERE post_id = $1`, [postId])).every((r) => r.insights_stage === 0)).toBe(true);
    // Nach zwei Stunden: Stufe 1 für beide Kanäle
    await pool.query(`UPDATE social_publications SET published_at = now() - interval '2 hours' WHERE post_id = $1`, [postId]);
    const r1 = await runDueInsights();
    expect(r1.fetched, JSON.stringify(r1)).toBe(2);
    let rows = await many<any>(`SELECT sp.*, c.kind FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1`, [postId]);
    expect(rows.find((x) => x.kind === 'mastodon')).toMatchObject({ insights_stage: 1, insights: { reposts: 3, likes: 7, replies: 1 } });
    expect(rows.find((x) => x.kind === 'bluesky')).toMatchObject({ insights_stage: 1, insights: { likes: 5, reposts: 2, replies: 1, quotes: 0 } });
    // Bluesky-Zahlen kommen ohne Anmeldung von der öffentlichen Schnittstelle
    const gp = calls.filter((c) => c.path === '/xrpc/app.bsky.feed.getPosts');
    expect(gp.length).toBe(1);
    expect(gp[0].headers.authorization).toBeUndefined();
    // Gleicher Lauf erneut: nichts doppelt
    expect((await runDueInsights()).fetched).toBe(0);
    // Verspätet nach 8 Tagen: direkt letzte Stufe, danach keine Abrufe mehr
    await pool.query(`UPDATE social_publications SET published_at = now() - interval '8 days' WHERE post_id = $1`, [postId]);
    expect((await runDueInsights()).fetched).toBe(2);
    rows = await many<any>(`SELECT insights_stage FROM social_publications WHERE post_id = $1`, [postId]);
    expect(rows.every((r) => r.insights_stage === 3)).toBe(true);
    expect((await runDueInsights()).fetched).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM social_insights si JOIN social_publications sp ON sp.id = si.publication_id WHERE sp.post_id = $1`, [postId]))!.n).toBe(4);
    // Je Beitrag samt Verlauf; nur Zahlen, keine Personen
    const per = (await editor.get(`/posts/${postId}/insights`)).json.items;
    expect(per.find((x: any) => x.kind === 'mastodon').history.map((h: any) => h.stage)).toEqual([1, 3]);
    expect(per.find((x: any) => x.kind === 'mastodon').interactions).toBe(11);
    expect(Object.keys(per[0].insights).every((k) => ['views', 'reach', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'saves', 'clicks'].includes(k))).toBe(true);
    // Übersicht (Zeitraum, Kanal, Top-Beiträge)
    await pool.query(`UPDATE social_publications SET published_at = now() - interval '3 days' WHERE post_id = $1`, [postId]);
    const o = (await publisher.get('/insights?days=7')).json;
    expect(o.channels.map((c: any) => c.kind).sort()).toEqual(expect.arrayContaining(['bluesky', 'mastodon']));
    expect(o.top[0]).toMatchObject({ post_id: postId, interactions: 19 });
    expect((await publisher.get('/insights?days=7&kind=bluesky')).json.channels.map((c: any) => c.kind)).toEqual(['bluesky']);
    // Dashboard-Kachel
    const dash = (await editor.get('/dashboard')).json;
    expect(dash.insights.top.some((t: any) => t.post_id === postId)).toBe(true);
    expect((await editor.get('/dashboard/layout')).json.widgets).toContain('insights');
    // Im Beitrag: Zahlen je Kanal nur mit „Reichweite ansehen“
    expect((await editor.get(`/posts/${postId}`)).json.social.find((x: any) => x.kind === 'mastodon').insights.likes).toBe(7);
    // Eigene Adresse: Einladungen annehmen ist je Adresse begrenzt
    const inv = await admin.post('/users/invite', { email: 'nur-beitraege@example.org', roles: ['media_manager'] });
    const noRight = new Client(app, '10.77.0.4');
    expect((await noRight.post(`/auth/invite/${inv.json.link.split('/einladung/')[1]}`, { name: 'Alex', password: 'Alex-Zugang-sicher-2026' })).json.next).toBe('done');
    expect((await noRight.get('/insights')).status).toBe(403);
    expect((await noRight.get(`/posts/${postId}/insights`)).status).toBe(403);
    expect((await noRight.get(`/posts/${postId}`)).json.social[0].insights).toBeNull();
    expect((await noRight.get('/dashboard')).json.insights).toBeUndefined();
  });

  it('Reichweite: ausgeschalteter Abruf zählt nur die Stufe weiter, Fehler je Beitrag werden festgehalten', async () => {
    const { runDueInsights } = await import('../src/connections/insights.js');
    // Abruf ausschalten verlangt keinen neuen Test
    const sw = await adm.put(`/connections/${bsId}`, { name: 'Bluesky (Test)', config: { insights: false } });
    expect(sw.json.retest).toBe(false);
    await pool.query(`UPDATE social_publications SET insights_stage = 0, published_at = now() - interval '2 hours' WHERE post_id = $1`, [postId]);
    const before = calls.filter((c) => c.path === '/xrpc/app.bsky.feed.getPosts').length;
    await runDueInsights();
    expect(calls.filter((c) => c.path === '/xrpc/app.bsky.feed.getPosts').length).toBe(before);
    const b = await one<any>(`SELECT sp.insights_stage FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1 AND c.kind = 'bluesky'`, [postId]);
    expect(b.insights_stage).toBe(1);
    await adm.put(`/connections/${bsId}`, { name: 'Bluesky (Test)', config: { insights: true } });
    // Mastodon-Beitrag inzwischen gelöscht: Fehler je Beitrag, Stufe zählt weiter (kein Dauerabruf)
    st.statuses.length = 0;
    await pool.query(`UPDATE social_publications SET published_at = now() - interval '25 hours' WHERE post_id = $1`, [postId]);
    await runDueInsights();
    const m = await one<any>(`SELECT sp.insights_stage, sp.insights_error, sp.insights FROM social_publications sp JOIN connections c ON c.id = sp.connection_id WHERE sp.post_id = $1 AND c.kind = 'mastodon'`, [postId]);
    expect(m.insights_stage).toBe(2);
    expect(m.insights_error).toBeTruthy();
    expect(m.insights.likes).toBe(7);
  });

  it('Zurückziehen: Mastodon und Bluesky über die Schnittstelle gelöscht', async () => {
    const r = await publisher.post(`/posts/${postId}/social/remove`, { reason: 'Test zurückziehen' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items.map((x: any) => `${x.kind}:${x.result}`).sort()).toEqual(['bluesky:removed', 'mastodon:removed']);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/statuses/MS1')).toBe(true);
    const del = calls.find((c) => c.path === '/xrpc/com.atproto.repo.deleteRecord')!;
    expect(JSON.parse(del.body.toString())).toEqual({ repo: 'did:plc:test123', collection: 'app.bsky.feed.post', rkey: '3k1' });
  });

  it('Workflow-Ausgang „Beitrag“: Mastodon und Bluesky vorauswählbar, eigene Texte', async () => {
    const ok = await adm.post('/automation-outputs', { name: 'Beitrag Mastodon/Bluesky', kind: 'post', config: { title: 'Einsatz {{stichwort}}', variants: { mastodon: { body: 'Einsatz {{stichwort}}', cw: 'Einsatz' }, bluesky: { body: 'Einsatz {{stichwort}}' } }, socialTargets: [{ connectionId: mdId, format: 'feed' }, { connectionId: bsId, format: 'feed' }] } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await adm.post('/automation-outputs', { name: 'Story Mastodon', kind: 'post', config: { title: 'X', socialTargets: [{ connectionId: mdId, format: 'story' }] } })).status).toBe(400);
    const cat = (await adm.get('/automations/catalog')).json;
    expect(cat.socialChannels.map((c: any) => c.kind)).toEqual(expect.arrayContaining(['mastodon', 'bluesky']));
    await adm.raw('DELETE', `/automation-outputs/${ok.json.id}`);
  });

  it('Zugangsdaten bleiben beim Ziel: andere Instanz bzw. anderer Server oder anderes Konto verwirft sie (#234)', async () => {
    const { connectionSecrets, loadConnection, updateConnectionSecrets } = await import('../src/connections/common.js');
    // zweite „Instanz“, die alles mitschreibt
    const seen: string[] = [];
    const other = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"nein"}');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherBase = `http://127.0.0.1:${(other.address() as any).port}`;
    try {
      // Mastodon: Token und App-Geheimnis gespeichert, App auf der Instanz registriert
      const md = (await adm.post('/connections', { kind: 'mastodon', name: 'Mastodon (Ziel)', config: { instance: base } })).json.id;
      await adm.put(`/connections/${md}/secrets`, { token: 'MD-TOKEN-geheim' });
      await updateConnectionSecrets(await loadConnection(md), { clientSecret: 'md-client-secret-geheim' }, null);
      await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [md, JSON.stringify({ clientId: 'MDCLIENT', appInstance: base, appRedirect: 'x' })]);
      // Änderung ohne neues Ziel: Zugangsdaten bleiben
      expect((await adm.put(`/connections/${md}`, { name: 'Mastodon (Ziel)', config: { instance: base, visibility: 'private' } })).json.secretsDiscarded).toEqual([]);
      expect((await adm.get(`/connections/${md}`)).json.secrets_set.sort()).toEqual(['clientSecret', 'token']);
      // neue Instanz – auch wenn das Formular die alte App-Registrierung mitschickt: Token und App-Geheimnis verworfen
      const r = await adm.put(`/connections/${md}`, { name: 'Mastodon (Ziel)', config: { instance: otherBase, clientId: 'MDCLIENT', appInstance: otherBase, appRedirect: 'x' } });
      expect(r.json.secretsDiscarded.sort()).toEqual(['clientSecret', 'token']);
      const v = (await adm.get(`/connections/${md}`)).json;
      expect(v.secrets_set).toEqual([]);
      expect(v.config).not.toHaveProperty('clientId');
      expect(v.config).not.toHaveProperty('appInstance');
      expect(await connectionSecrets(await loadConnection(md))).toEqual({});
      expect((await adm.post(`/connections/${md}/test`)).json.ok).toBe(false);
      expect(seen.filter((s) => /geheim|Bearer/.test(s))).toEqual([]);
      const ev = await one<any>(`SELECT details FROM audit_events WHERE action = 'connection.updated' AND object_id = $1 ORDER BY id DESC LIMIT 1`, [md]);
      expect(ev!.details.zugangsdaten_verworfen.sort()).toEqual(['clientSecret', 'token']);

      // Bluesky: anderer Server (PDS) oder anderes Konto – das App-Passwort geht nie an das neue Ziel
      const bs = (await adm.post('/connections', { kind: 'bluesky', name: 'Bluesky (Ziel)', config: { identifier: 'feuerwehr.bsky.social', service: base } })).json.id;
      await adm.put(`/connections/${bs}/secrets`, { appPassword: 'abcd-efgh-ijkl-mnop' });
      expect((await adm.put(`/connections/${bs}`, { name: 'Bluesky (Ziel)', config: { identifier: '@Feuerwehr.bsky.social', language: 'en' } })).json.secretsDiscarded).toEqual([]);
      expect((await adm.put(`/connections/${bs}`, { name: 'Bluesky (Ziel)', config: { service: 'https://pds.example.org' } })).json.secretsDiscarded).toEqual(['appPassword']);
      const t = await adm.post(`/connections/${bs}/test`);
      expect(t.json.ok).toBe(false);
      expect(t.json.steps[0].message).toContain('App-Passwort hinterlegen');
      await adm.put(`/connections/${bs}`, { name: 'Bluesky (Ziel)', config: { service: base } });
      await adm.put(`/connections/${bs}/secrets`, { appPassword: 'abcd-efgh-ijkl-mnop' });
      expect((await adm.put(`/connections/${bs}`, { name: 'Bluesky (Ziel)', config: { identifier: 'anderes-konto.bsky.social' } })).json.secretsDiscarded).toEqual(['appPassword']);
      expect((await adm.get(`/connections/${bs}`)).json.secrets_set).toEqual([]);
      for (const id of [md, bs]) await adm.raw('DELETE', `/connections/${id}`, {});
    } finally {
      other.close();
    }
  });
});

describe('Barrierefreiheit: Alternativtext je Bild (#217)', () => {
  let siteKey = '';
  let siteId2 = '';
  let pid = '';
  let img1 = '';
  let img2 = '';
  const auth = () => ({ authorization: `Bearer ${siteKey}` });
  // Eigene Adresse für die Bridge (Kopplung und Abruf sind je Adresse begrenzt)
  let br: Client;
  beforeAll(() => {
    br = new Client(app, '10.77.0.3');
  });
  const cur = async () => (await editor.get(`/posts/${pid}`)).json;

  it('Alternativtext ist Teil der Fassung und landet in der Medienverwaltung', async () => {
    const s = await admin.post('/sites', { name: 'Barrierefreie Testwebsite' });
    siteId2 = s.json.site.id;
    const pair = await br.post('/bridge/pair', { code: s.json.pairingCode, site_url: 'https://barrierefrei.example.org' });
    expect(pair.status, JSON.stringify(pair.json)).toBe(200);
    siteKey = pair.json.key;
    img1 = (await readyPhoto('Alt-Bilder 1', 'alt-key-0001')).id;
    img2 = (await readyPhoto('Alt-Bilder 2', 'alt-key-0002')).id;
    pid = (await editor.post('/posts', { title: 'Rauchmelder-Aktion (fiktiv)' })).json.id;
    let d = await cur();
    const base = { title: d.revision.title, body: 'Wir verteilen Rauchmelder.', mediaIds: [img1], coverId: img1, siteId: siteId2 };
    const r1 = await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, ...base });
    d = await cur();
    expect(d.accessibility).toEqual({ applies: true, missing: [img1], required: false });
    const hashWithout = d.revision.content_hash;
    // Alternativtext ergänzen → neue Fassung (Prüfsumme ändert sich), Medienverwaltung übernimmt ihn
    const r2 = await editor.put(`/posts/${pid}/revision`, { baseRevision: r1.json.number, ...base, mediaAlt: { [img1]: '  Zwei Einsatzkräfte  zeigen einen Rauchmelder ', [img2]: 'nicht in der Fassung' } });
    expect(r2.json.changed).toBe(true);
    d = await cur();
    expect(d.revision.content_hash).not.toBe(hashWithout);
    expect(d.revision.media_alt).toEqual({ [img1]: 'Zwei Einsatzkräfte zeigen einen Rauchmelder' });
    expect(d.accessibility.missing).toEqual([]);
    expect(d.media[0].alt_text).toBe('Zwei Einsatzkräfte zeigen einen Rauchmelder');
    // Gleicher Text erneut gespeichert → keine neue Fassung
    expect((await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, ...base, mediaAlt: { [img1]: 'Zwei Einsatzkräfte zeigen einen Rauchmelder' } })).json.changed).toBe(false);
    // Ein vorhandener Text in der Medienverwaltung wird nicht überschrieben
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, ...base, mediaAlt: { [img1]: 'Anderer Text nur für diese Fassung' } });
    expect((await one<any>(`SELECT alt_text FROM media WHERE id = $1`, [img1]))!.alt_text).toBe('Zwei Einsatzkräfte zeigen einen Rauchmelder');
  });

  it('Freigabe: Pflicht blockiert ohne Alternativtext, sonst Warnung; Bridge erhält den Text der Fassung', async () => {
    let d = await cur();
    await editor.put(`/posts/${pid}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Wir verteilen Rauchmelder.', mediaIds: [img1, img2], coverId: img1, siteId: siteId2, mediaAlt: d.revision.media_alt });
    d = await cur();
    expect(d.accessibility.missing).toEqual([img2]);
    await editor.post(`/posts/${pid}/submit`, { revision: d.revision.number });
    expect((await admin.patch('/settings', { 'editorial.alt_text_required': true })).status).toBe(200);
    expect((await cur()).accessibility.required).toBe(true);
    const blocked = await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error).toBe('alt_text_required');
    // Zurückweisen geht immer
    await admin.patch('/settings', { 'editorial.alt_text_required': false });
    const ok = await approver.post(`/posts/${pid}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'approved' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await publisher.post(`/posts/${pid}/publish`, { revision: d.revision.number, contentHash: d.revision.content_hash });
    const jr = await br.get('/bridge/jobs', auth());
    expect(jr.status, JSON.stringify(jr.json)).toBe(200);
    const jobs = jr.json.jobs;
    expect(jobs).toHaveLength(1);
    // Bild 1: Text der Fassung (nicht der aus der Medienverwaltung); Bild 2 ohne Text: wie bisher der Titel
    expect(jobs[0].media.map((m: any) => m.alt)).toEqual(['Anderer Text nur für diese Fassung', 'Rauchmelder-Aktion (fiktiv) – Bild 2']);
    await br.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_id: 99, url: 'https://barrierefrei.example.org/rauchmelder/' }, auth());
  });

  it('Medienverwaltung: Alternativtext nur mit „Medien ordnen“ änderbar; Beiträge ohne Ziel brauchen keinen', async () => {
    expect((await publisher.patch(`/media/${img2}`, { altText: 'x' })).status).toBe(403);
    expect((await admin.patch(`/media/${img2}`, { altText: 'Rauchmelder an der Zimmerdecke' })).status).toBe(200);
    const p2 = (await editor.post('/posts', { title: 'Intern (fiktiv)' })).json.id;
    const d = (await editor.get(`/posts/${p2}`)).json;
    await editor.put(`/posts/${p2}/revision`, { baseRevision: d.revision.number, title: d.revision.title, body: 'Nur intern.', mediaIds: [img2] });
    const a = (await editor.get(`/posts/${p2}`)).json.accessibility;
    expect(a.applies).toBe(false);
  });
});

describe('Keine Empfängeradressen im Audit (#185)', () => {
  it('Versand und Zuständigkeiten protokollieren Anzahl, Zuständigkeit und Domains statt Adressen', async () => {
    const rows = await many<any>(`SELECT action, details FROM audit_events WHERE action IN ('warning.send_requested', 'warning.responsibility_created', 'warning.responsibility_updated')`);
    expect(rows.some((r) => r.action === 'warning.send_requested')).toBe(true);
    expect(rows.some((r) => r.action === 'warning.responsibility_created')).toBe(true);
    for (const r of rows) expect(JSON.stringify(r.details), r.action).not.toContain('@');
    const send = rows.find((r) => r.action === 'warning.send_requested')!;
    expect(send.details.empfaenger_anzahl).toBe(1);
    expect(send.details.zustaendigkeiten.length).toBeGreaterThan(0);
  });
});

describe('Datenschutzerklärung und Impressum (#187)', () => {
  it('öffentlich ohne Anmeldung lesbar, nur mit settings.privacy änderbar, verlinkt als Datenschutzerklärung', async () => {
    const before = (await admin.get('/settings')).json.settings;
    await admin.patch('/settings', { 'legal.privacy_text': '', 'legal.imprint_text': '', 'privacy.policy_url': '' });
    expect((await anonymous.get('/public/legal')).json).toEqual({ privacy: false, imprint: false });
    expect((await anonymous.get('/public/legal/datenschutz')).json.text).toBe('');
    expect((await anonymous.get('/public/legal/unbekannt')).status).toBe(400);
    expect((await editor.patch('/settings', { 'legal.imprint_text': 'Nicht erlaubt' })).status).toBe(403);
    const text = ['# Datenschutzerklärung', '', '<script>alert(1)</script> [Link](javascript:alert(1))'].join('\n');
    expect((await admin.patch('/settings', { 'legal.privacy_text': text, 'legal.imprint_text': 'Angaben gemäß § 5 DDG' })).status).toBe(200);
    expect((await anonymous.get('/public/legal')).json).toEqual({ privacy: true, imprint: true });
    const d = await anonymous.get('/public/legal/datenschutz');
    expect(d.status).toBe(200);
    // Rohtext (Markdown); die Oberfläche stellt ihn ohne HTML dar
    expect(d.json.text).toBe(text);
    expect((await anonymous.get('/public/legal/impressum')).json.text).toBe('Angaben gemäß § 5 DDG');
    // Ohne eigene Adresse verweist die Datenschutzerklärung der Upload-Seite auf die eigene Seite
    const me = await admin.get('/auth/me');
    expect(me.json.instance.privacy.policy_url).toMatch(/\/datenschutz$/);
    // Höchstlänge
    await admin.patch('/settings', { 'legal.imprint_text': 'x'.repeat(30_000) });
    expect((await anonymous.get('/public/legal/impressum')).json.text.length).toBe(20_000);
    await admin.patch('/settings', { 'legal.privacy_text': before['legal.privacy_text'] ?? '', 'legal.imprint_text': before['legal.imprint_text'] ?? '', 'privacy.policy_url': before['privacy.policy_url'] });
  });
});

describe('Rückmeldungen bei Fehlern (#194)', () => {
  it('429 nennt die Wartezeit im Header und im Inhalt', async () => {
    let last: any = null;
    for (let i = 0; i < 125 && last?.statusCode !== 429; i++) last = await app.inject({ method: 'GET', url: '/api/v1/public/legal' });
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    const body = last.json();
    expect(body.error).toBe('rate_limited');
    expect(body.details.retryAfter).toBe(Number(last.headers['retry-after']));
    expect(body.message).toMatch(/Sekunden warten/);
  });

  it('ungültiger Alt-Link und unbekannte API-Adresse antworten verständlich', async () => {
    const l = await app.inject({ method: 'GET', url: '/l/gibtesnichtmehr123' });
    expect(l.statusCode).toBe(410);
    expect(l.headers['content-type']).toMatch(/text\/html/);
    expect(l.body).toContain('Link ungültig');
    expect(l.body).not.toContain('<script');
    const a = await anonymous.get('/gibt/es/nicht');
    expect(a.status).toBe(404);
    expect(a.json.error).toBe('not_found');
  });
});

describe('Löschfrist amtlicher Warnungen: noch gelieferte bleiben (#180)', () => {
  it('löscht erst, wenn abgelaufen und seit der Frist nicht mehr in der Quelle', async () => {
    const conn = (await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('warnfeed', 'Löschfrist-Feed', 'draft', '{"format":"cap","url":"https://warn.example.invalid/cap.xml"}') RETURNING id`))!;
    const ins = (identifier: string, lastSeen: string | null) =>
      one<any>(
        `INSERT INTO official_warnings (connection_id, identifier, msg_type, headline, effective_at, received_at, last_seen_at, in_area)
         VALUES ($1,$2,'Alert','Dauerlage (fiktiv)', now() - interval '200 days', now() - interval '200 days', ${lastSeen ?? 'NULL'}, true) RETURNING id`,
        [conn.id, identifier],
      );
    const running = (await ins('DAUER-1', `now() - interval '5 minutes'`))!;
    const gone = (await ins('DAUER-2', `now() - interval '100 days'`))!;
    const legacy = (await ins('DAUER-3', null))!;
    const { runRetention } = await import('../src/lib/retention.js');
    await runRetention({ dryRun: false });
    expect(await one(`SELECT 1 FROM official_warnings WHERE id = $1`, [running.id])).not.toBeNull();
    expect(await one(`SELECT 1 FROM official_warnings WHERE id = $1`, [gone.id])).toBeNull();
    expect(await one(`SELECT 1 FROM official_warnings WHERE id = $1`, [legacy.id])).toBeNull();
    await pool.query(`DELETE FROM official_warnings WHERE connection_id = $1`, [conn.id]);
    await pool.query(`UPDATE connections SET status = 'revoked' WHERE id = $1`, [conn.id]);
  });
});

describe('Feuersoftware Connect als zweite Einsatzquelle', () => {
  // Lokaler Ersatz für die Öffentliche Connect Schnittstelle – es wird nichts an Feuersoftware gesendet
  const KEY = 'fs-geheimer-api-key-2026';
  // Einsätze von vor einer Stunde (übernommen werden nur die der letzten 24 Stunden)
  const START = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3600_000).toISOString();
  const START_LOCAL = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(START));
  let srv: import('node:http').Server;
  const fake: { calls: { path: string; auth: string }[]; mode: 'ok' | '429' | '500' | 'html'; ops: any[] } = { calls: [], mode: 'ok', ops: [] };
  const op = (id: string, ric: string, extra: any = {}) => ({
    Id: id,
    Start: START,
    End: null,
    Keyword: 'B3 Wohnungsbrand',
    Category: 'Brand',
    Facts: 'VERTRAULICH Person bewusstlos, Max Mustermann',
    Ric: ric,
    Number: '4711-2026',
    Reporter: { Name: 'Erika Musterfrau', PhoneNumber: '0123 456789' },
    Address: { Street: 'Hauptstraße', HouseNumber: '12', City: 'Musterstadt', District: 'Nord', CityWithDistrict: 'Musterstadt - Nord', StreetWithHouseNumber: 'Hauptstraße 12', Lat: 50.1, Lng: 8.6, ZipCode: '12345' },
    ...extra,
  });
  let id = '';
  const tester = () => {
    const t = new Client(app, '198.51.100.77');
    t.cookie = admin.cookie;
    return t;
  };
  const row = () => one<any>(`SELECT * FROM connections WHERE id = $1`, [id]);

  beforeAll(async () => {
    const http = await import('node:http');
    srv = http.createServer((req, res) => {
      fake.calls.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? '') });
      if (req.headers.authorization !== `bearer ${KEY}`) {
        res.writeHead(401);
        return res.end('Unauthorized');
      }
      if (fake.mode === '429') {
        res.writeHead(429, { 'retry-after': '120' });
        return res.end('Too many requests');
      }
      if (fake.mode === '500') {
        res.writeHead(503);
        return res.end();
      }
      if (fake.mode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>Wartung</html>');
      }
      if (req.url === '/operation?onlyLatest=true') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(fake.ops));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.BLAULICHTCMS_FEUERSOFTWARE_URL = `http://127.0.0.1:${(srv.address() as any).port}`;
    fake.ops = [
      op('FS-1', 'Musterwehr Vollalarm'),
      op('FS-2', 'Nachbarwehr', { Keyword: 'TH 1', Category: 'Hilfeleistung', Address: { City: 'Nachbarort', Street: 'Ringstraße' } }),
      // Kleingeschriebene Feldnamen (camelCase) werden ebenso erkannt
      { id: 'FS-3', start: START, keyword: 'B2 Kleinbrand', category: 'Brand', ric: 'Musterwehr Vollalarm, Drehleiter', address: { city: 'Musterstadt', street: 'Gartenweg', houseNumber: '3' } },
      // Älter als 24 Stunden: wird nie übernommen, auch wenn die RIC passt
      op('FS-ALT', 'Musterwehr Vollalarm', { Start: new Date(Date.now() - 3 * 86400_000).toISOString(), Keyword: 'B1 Altfall' }),
    ];
  });
  afterAll(() => {
    srv?.close();
    delete process.env.BLAULICHTCMS_FEUERSOFTWARE_URL;
  });

  it('Verbinden, Fehlerzuordnung (401), Test mit Filter und Vorschau ohne Adresse', async () => {
    const c = await admin.post('/connections', { kind: 'feuersoftware', name: 'Feuersoftware Leitstelle (Test)' });
    expect(c.status).toBe(200);
    expect(c.json.token).toBeNull();
    id = c.json.id;
    const d = await admin.get(`/connections/${id}`);
    expect(d.json).toMatchObject({ kind: 'feuersoftware', status: 'draft', config: { intervalSeconds: 120, rics: [], keywords: [], createDrafts: true } });
    expect(d.json.intervals).toEqual([60, 120, 180, 300]);
    // Unzulässiger Abstand (häufiger als das Limit erlaubt)
    expect((await admin.put(`/connections/${id}`, { name: 'Feuersoftware Leitstelle (Test)', config: { intervalSeconds: 30 } })).status).toBe(400);
    // Ohne Schlüssel: Test scheitert am ersten Schritt, ohne Abruf
    const t0 = await tester().post(`/connections/${id}/test`);
    expect(t0.json.ok).toBe(false);
    expect(t0.json.steps[0].message).toContain('Öffentliche Connect Schnittstelle');
    expect(fake.calls).toHaveLength(0);
    // Falscher Schlüssel → 401 mit verständlicher Meldung
    expect((await admin.put(`/connections/${id}/secrets`, { apiKey: 'falscher-schluessel' })).status).toBe(200);
    const t1 = await tester().post(`/connections/${id}/test`);
    expect(t1.json.ok).toBe(false);
    expect(t1.json.steps[1].message).toMatch(/abgelehnt \(401\).*Öffentliche Connect Schnittstelle/);
    expect(fake.calls[0]).toMatchObject({ path: '/operation?onlyLatest=true', auth: 'bearer falscher-schluessel' });
    // Richtiger Schlüssel, Filter auf die eigene RIC
    await admin.put(`/connections/${id}/secrets`, { apiKey: KEY });
    await admin.put(`/connections/${id}`, { name: 'Feuersoftware Leitstelle (Test)', config: { rics: ['Musterwehr Vollalarm'] } });
    const t2 = await tester().post(`/connections/${id}/test`);
    expect(t2.json.ok).toBe(true);
    expect(t2.json.steps.map((s: any) => s.name)).toEqual(['API-Key', 'Einsätze abrufen', 'Filter (RIC, Stichwort)']);
    expect(t2.json.steps[1].message).toContain('4 Einsatz/Einsätze gelesen, davon 3 aus den letzten 24 Stunden');
    expect(t2.json.steps[2].message).toContain('2 von 3 passen');
    expect(t2.json.steps[2].message).toContain('RICs der Einsätze: Musterwehr Vollalarm, Nachbarwehr, Drehleiter');
    const pv = (await admin.get(`/connections/${id}`)).json;
    expect(pv.preview).toMatchObject({ total: 3, matched: 2 });
    expect(pv.preview.operations[0]).toMatchObject({ title: 'B3 Wohnungsbrand in Musterstadt - Nord', matched: true, area: 'Musterstadt - Nord' });
    expect(pv.preview.operations[2]).toMatchObject({ title: 'B2 Kleinbrand in Musterstadt', matched: true });
    const shown = JSON.stringify(pv);
    for (const secret of ['Hauptstraße', 'Gartenweg', 'Mustermann', 'Musterfrau', '0123 456789', '4711-2026', KEY]) expect(shown).not.toContain(secret);
    // Kein Entwurf vor der Aktivierung
    expect((await one<any>(`SELECT count(*)::int AS n FROM fe2_events WHERE connection_id = $1`, [id]))!.n).toBe(0);
  });

  it('nur aktive Verbindungen fragen ab; je Einsatz genau ein Entwurf ohne Adresse, auch nach Neustart und Löschung', async () => {
    const { pollFeuersoftware, pollDueFeuersoftware } = await import('../src/connections/feuersoftware.js');
    const before = fake.calls.length;
    expect((await pollFeuersoftware(id)).skipped).toContain('nicht aktiv');
    await pollDueFeuersoftware();
    expect(fake.calls.length).toBe(before);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);
    // Der Test eben zählt als Abruf – der reguläre Abruf wartet den Abstand ab
    await pollDueFeuersoftware();
    expect(fake.calls.length).toBe(before);
    await pool.query(`UPDATE connections SET last_poll_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    await pollDueFeuersoftware();
    expect(fake.calls.length).toBe(before + 1);
    const events = await many<any>(`SELECT * FROM fe2_events WHERE connection_id = $1 ORDER BY event_key`, [id]);
    expect(events.map((e) => e.event_key)).toEqual([`${id}:FS-1`, `${id}:FS-3`]);
    expect(events.every((e) => e.source === 'feuersoftware' && e.post_id)).toBe(true);
    const rev = await one<any>(`SELECT * FROM post_revisions WHERE post_id = $1`, [events[0].post_id]);
    expect(rev.title).toBe('B3 Wohnungsbrand in Musterstadt - Nord');
    expect(rev.body).toContain('Automatischer Entwurf aus Feuersoftware Connect');
    expect(rev.body).toContain('Ort: Musterstadt - Nord');
    // Alarmzeit in der Zeitzone der Instanz
    expect(rev.body).toContain(START_LOCAL);
    expect(await one(`SELECT 1 FROM fe2_events WHERE event_key = $1`, [`${id}:FS-ALT`])).toBeNull();
    // Nur die Inhaltsfelder prüfen: IDs (UUIDs) und Zeitstempel könnten zufällig z. B. „0123“ oder „50.1“ enthalten
    const stored = JSON.stringify(events.map((e) => ({ keyword: e.keyword, title: e.title, fields: e.fields }))) + rev.title + rev.body + rev.excerpt;
    for (const secret of ['Hauptstraße', '12345', 'Mustermann', 'Musterfrau', '0123', '4711-2026', 'VERTRAULICH', '50.1']) expect(stored).not.toContain(secret);
    const logs = await one<any>(`SELECT count(*)::int AS n FROM app_logs WHERE message ILIKE ANY($1) OR details::text ILIKE ANY($1)`, [['%Hauptstraße%', '%Mustermann%', `%${KEY}%`, '%FS-1%']]);
    expect(logs!.n).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'feuersoftware.draft_created'`))!.n).toBe(2);
    // Erneuter Abruf (z. B. nach einem Neustart): keine Duplikate
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    expect(await pollFeuersoftware(id)).toMatchObject({ seen: 3, matched: 2, created: 0 });
    // Gelöschter Einsatz (z. B. Datenschutz-Anfrage) wird nicht erneut angelegt
    const del = await admin.post('/privacy/action', { kind: 'fe2_event', id: events[0].id, action: 'delete' });
    expect(del.status).toBe(200);
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    expect(await pollFeuersoftware(id)).toMatchObject({ created: 0 });
    expect(await one(`SELECT 1 FROM fe2_events WHERE event_key = $1`, [`${id}:FS-1`])).toBeNull();
    // Ende des Einsatzes aktualisiert den unbearbeiteten Entwurf (Folgeereignis)
    fake.ops[2] = { ...fake.ops[2], end: '2026-11-14T19:00:00Z' };
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    await pollFeuersoftware(id);
    expect((await one<any>(`SELECT status, sequence FROM fe2_events WHERE event_key = $1`, [`${id}:FS-3`]))).toMatchObject({ status: 'closed', sequence: 2 });
    // Zwei gleichzeitige Abrufe: nur einer fragt ab
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    const n = fake.calls.length;
    const both = await Promise.all([pollFeuersoftware(id), pollFeuersoftware(id)]);
    expect(fake.calls.length).toBe(n + 1);
    expect(both.filter((r) => r.skipped)).toHaveLength(1);
  });

  it('429 mit Retry-After: Pause wird eingehalten; nach drei Fehlschlägen Meldung, bei Erfolg aufgehoben', async () => {
    const { pollFeuersoftware, pollDueFeuersoftware } = await import('../src/connections/feuersoftware.js');
    fake.mode = '429';
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    const r = await pollFeuersoftware(id);
    expect(r.error).toContain('Zu viele Abfragen (429)');
    expect(r.error).toContain('120 s');
    const c1 = await row();
    expect(c1.consecutive_failures).toBe(1);
    const wait = new Date(c1.retry_after_until).getTime() - Date.now();
    expect(wait).toBeGreaterThan(100_000);
    expect(wait).toBeLessThanOrEqual(121_000);
    expect(c1.last_error).toContain('429');
    // Während der Pause kein Abruf – weder regulär noch über „Jetzt abrufen“
    const n = fake.calls.length;
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    await pollDueFeuersoftware();
    expect(fake.calls.length).toBe(n);
    const manual = await admin.post(`/connections/${id}/refresh`);
    expect(manual.status).toBe(409);
    expect(manual.json.message).toContain('Pause');
    expect(fake.calls.length).toBe(n);
    // Serverfehler und Nicht-JSON zählen als Fehlschlag; beim dritten in Folge wird die Verwaltung benachrichtigt
    fake.mode = '500';
    await pool.query(`UPDATE connections SET last_poll_at = NULL, retry_after_until = NULL WHERE id = $1`, [id]);
    expect((await pollFeuersoftware(id)).error).toContain('Serverfehler (503)');
    const alerts = () => one<any>(`SELECT count(*)::int AS n FROM notifications WHERE link = $1 AND title LIKE '%gestört'`, [`/verbindungen/${id}`]).then((x) => x!.n);
    expect(await alerts()).toBe(0);
    fake.mode = 'html';
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    expect((await pollFeuersoftware(id)).error).toContain('kein JSON');
    expect((await row()).consecutive_failures).toBe(3);
    expect(await alerts()).toBe(1);
    expect((await admin.get('/connections')).json.find((x: any) => x.id === id).last_error).toContain('kein JSON');
    // Erfolg hebt Zähler, Fehler und Meldung auf
    fake.mode = 'ok';
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    expect((await pollFeuersoftware(id)).error).toBeUndefined();
    expect(await row()).toMatchObject({ consecutive_failures: 0, last_error: null, retry_after_until: null });
    expect(await alerts()).toBe(0);
    expect(await one(`SELECT 1 FROM notifications WHERE link = $1 AND title LIKE '%wieder erreichbar'`, [`/verbindungen/${id}`])).not.toBeNull();
    // „Jetzt abrufen“ (auditiert); gleich danach nochmals: zu früh
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    const now = await admin.post(`/connections/${id}/refresh`);
    expect(now.status).toBe(200);
    expect(now.json).toMatchObject({ seen: 3, matched: 2 });
    expect((await admin.post(`/connections/${id}/refresh`)).status).toBe(409);
  });

  it('neuer Test nur bei Filter- oder Schlüsseländerung; Löschfrist gilt wie bei FE2', async () => {
    const iv = await admin.put(`/connections/${id}`, { name: 'Feuersoftware Leitstelle (Test)', config: { intervalSeconds: 300, createDrafts: true } });
    expect(iv.json).toMatchObject({ retest: false, deactivated: false });
    expect((await row()).status).toBe('active');
    const kw = await admin.put(`/connections/${id}`, { name: 'Feuersoftware Leitstelle (Test)', config: { keywords: ['B3'] } });
    expect(kw.json).toMatchObject({ retest: true, deactivated: true });
    expect(await row()).toMatchObject({ status: 'draft', last_test: null, preview: null });
    const { pollFeuersoftware } = await import('../src/connections/feuersoftware.js');
    expect((await pollFeuersoftware(id)).skipped).toContain('nicht aktiv');
    expect((await tester().post(`/connections/${id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);
    const sec = await admin.put(`/connections/${id}/secrets`, { apiKey: KEY });
    expect(sec.json).toMatchObject({ retest: true, deactivated: true });
    // Löschfrist: Einsatzmeldungen aus Feuersoftware fallen unter dieselbe Frist wie FE2-Meldungen
    await pool.query(`UPDATE fe2_events SET received_at = now() - interval '400 days', updated_at = now() - interval '400 days' WHERE connection_id = $1`, [id]);
    const { runRetention } = await import('../src/lib/retention.js');
    const rep = await runRetention({ dryRun: false });
    expect(rep.categories.find((c) => c.key === 'fe2_events')!.label).toContain('Feuersoftware');
    expect((await one<any>(`SELECT count(*)::int AS n FROM fe2_events WHERE connection_id = $1`, [id]))!.n).toBe(0);
    // … und auch danach kein erneutes Anlegen (Prüfsummen bleiben 30 Tage)
    expect((await one<any>(`SELECT count(*)::int AS n FROM connection_seen_events WHERE connection_id = $1`, [id]))!.n).toBe(2);
    expect((await tester().post(`/connections/${id}/test`)).json.ok).toBe(true);
    expect((await admin.post(`/connections/${id}/activate`)).status).toBe(200);
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [id]);
    expect(await pollFeuersoftware(id)).toMatchObject({ created: 0 });
    await admin.post(`/connections/${id}/disable`);
  });
});

describe('Verbindungen löschen', () => {
  it('nie benutzt: endgültig samt Geheimnissen; nur mit Recht; auditiert', async () => {
    const c = await admin.post('/connections', { kind: 'facebook', name: 'Facebook ungenutzt', config: { appId: '1' } });
    const id = c.json.id;
    await admin.put(`/connections/${id}/secrets`, { appSecret: 'ungenutztes-geheimnis-1', pageToken: 'ungenutzter-token-2' });
    expect((await one<any>(`SELECT count(*)::int AS n FROM secrets WHERE owner_type = 'connection' AND owner_id = $1`, [id]))!.n).toBeGreaterThan(0);
    expect((await admin.get(`/connections/${id}`)).json.usage).toMatchObject({ used: false, publications: 0 });
    expect((await editor.raw('DELETE', `/connections/${id}`, { body: {} })).status).toBe(403);
    const d = await admin.raw('DELETE', `/connections/${id}`, { body: {} });
    expect(d.status).toBe(200);
    expect(d.json.mode).toBe('deleted');
    expect(await one(`SELECT 1 FROM connections WHERE id = $1`, [id])).toBeNull();
    expect((await one<any>(`SELECT count(*)::int AS n FROM secrets WHERE owner_type = 'connection' AND owner_id = $1`, [id]))!.n).toBe(0);
    const a = await one<any>(`SELECT details FROM audit_events WHERE action = 'connection.deleted' AND object_id = $1::text`, [id]);
    expect(a.details).toMatchObject({ art: 'facebook', endgueltig: true });
    expect((await admin.get(`/connections/${id}`)).status).toBe(404);
  });

  it('benutzt: widerrufen, Geheimnisse gelöscht, ausgeblendet; Bezüge zeigen „Verbindung gelöscht“', async () => {
    const fb = await one<any>(`SELECT c.id, c.name, sp.post_id FROM connections c JOIN social_publications sp ON sp.connection_id = c.id WHERE c.kind = 'facebook' AND c.deleted_at IS NULL LIMIT 1`);
    expect(fb).not.toBeNull();
    await pool.query(`UPDATE connections SET status = 'active' WHERE id = $1`, [fb.id]);
    expect((await admin.get(`/connections/${fb.id}`)).json.usage.used).toBe(true);
    const d = await admin.raw('DELETE', `/connections/${fb.id}`, { body: {} });
    expect(d.status).toBe(200);
    expect(d.json.mode).toBe('hidden');
    const row = await one<any>(`SELECT status, secret_id, deleted_at, deleted_by FROM connections WHERE id = $1`, [fb.id]);
    expect(row).toMatchObject({ status: 'revoked', secret_id: null });
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).not.toBeNull();
    expect((await one<any>(`SELECT count(*)::int AS n FROM secrets WHERE owner_type = 'connection' AND owner_id = $1`, [fb.id]))!.n).toBe(0);
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'connection.deleted' AND object_id = $1::text`, [fb.id])).details).toMatchObject({ endgueltig: false });
    // Ausgeblendet – auch für die Redaktion; „Gelöschte anzeigen“ nur für die Administration
    expect((await admin.get('/connections')).json.some((x: any) => x.id === fb.id)).toBe(false);
    expect((await editor.get('/connections')).json.some((x: any) => x.id === fb.id)).toBe(false);
    expect((await editor.get('/connections?deleted=1')).json.some((x: any) => x.id === fb.id)).toBe(false);
    const all = (await admin.get('/connections?deleted=1')).json;
    expect(all.find((x: any) => x.id === fb.id).deleted_at).toBeTruthy();
    expect((await admin.get(`/connections/${fb.id}`)).json.deleted_at).toBeTruthy();
    // Bezüge bleiben, zeigen aber „Verbindung gelöscht“
    const p = (await editor.get(`/posts/${fb.post_id}`)).json;
    expect(p.social.length).toBeGreaterThan(0);
    expect(p.social.filter((s: any) => s.kind === 'facebook').every((s: any) => s.connection_name === 'Verbindung gelöscht')).toBe(true);
    expect(p.social.some((s: any) => s.connection_name === 'Verbindung gelöscht')).toBe(true);
    // Keine weiteren Aktionen an einer gelöschten Verbindung
    expect((await admin.post(`/connections/${fb.id}/activate`)).status).toBe(404);
    expect((await admin.put(`/connections/${fb.id}/secrets`, { pageToken: 'neu-123456' })).status).toBe(404);
    expect((await admin.raw('DELETE', `/connections/${fb.id}`, { body: {} })).status).toBe(404);
  });

  it('Abrufe ignorieren gelöschte Verbindungen', async () => {
    const fs = (await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('feuersoftware', 'Feuersoftware gelöscht', 'active', '{"intervalSeconds":60}') RETURNING id`))!;
    await pool.query(`INSERT INTO connection_seen_events (connection_id, ref_hash) VALUES ($1, 'x')`, [fs.id]);
    expect((await admin.raw('DELETE', `/connections/${fs.id}`, { body: {} })).json.mode).toBe('hidden');
    const { pollFeuersoftware } = await import('../src/connections/feuersoftware.js');
    expect((await pollFeuersoftware(fs.id)).skipped).toContain('nicht aktiv');
    const wf = (await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('warnfeed', 'Warnfeed gelöscht', 'active', '{"format":"cap","url":"https://warn.example.invalid/cap.xml"}') RETURNING id`))!;
    await pool.query(`INSERT INTO official_warnings (connection_id, identifier) VALUES ($1, 'geloescht-1')`, [wf.id]);
    expect((await admin.raw('DELETE', `/connections/${wf.id}`, { body: {} })).json.mode).toBe('hidden');
    const ow = (await admin.get('/official-warnings')).json.find((w: any) => w.identifier === 'geloescht-1');
    expect(ow.source).toBe('Warnfeed gelöscht (Verbindung gelöscht)');
    expect((await one<any>(`SELECT count(*)::int AS n FROM connections WHERE id = ANY($1) AND status = 'revoked'`, [[fs.id, wf.id]]))!.n).toBe(2);
  });
});

describe('Warnvorgänge löschen, amtliche Warnungen ausblenden', () => {
  let authorA: { client: Client; userId: string };
  let authorB: { client: Client; userId: string };
  let approverX: { client: Client; userId: string };
  const pdf = (id: string) => path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'warnings', id);
  const create = async (c: Client, body: any) => {
    const r = await c.post('/warnings', body);
    expect(r.status).toBe(200);
    fs.mkdirSync(pdf(r.json.id), { recursive: true });
    fs.writeFileSync(path.join(pdf(r.json.id), 'x.pdf'), 'pdf');
    return r.json as { id: string; case_no: string };
  };
  const approve = async (id: string) => {
    const rev = (await one<any>(`SELECT r.id, r.content_hash FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision WHERE w.id = $1`, [id]))!;
    return (await one<any>(`INSERT INTO warning_approvals (warning_id, revision_id, content_hash, decision, pdf_file) VALUES ($1,$2,$3,'approved','x.pdf') RETURNING id`, [id, rev.id, rev.content_hash]))!.id as string;
  };
  const send = async (id: string, status = 'accepted') => {
    const rev = (await one<any>(`SELECT r.id FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision WHERE w.id = $1`, [id]))!;
    const aid = await approve(id);
    return (await one<any>(`INSERT INTO warning_sends (warning_id, revision_id, approval_id, recipients, intended_recipients, test_mode, subject, status) VALUES ($1,$2,$3,'{test@example.invalid}','{stelle@example.invalid}',true,'Betreff',$4) RETURNING id`, [id, rev.id, aid, status]))!.id as string;
  };
  const gone = async (ids: string[]) => (await one<any>(`SELECT count(*)::int AS n FROM warnings WHERE id = ANY($1::uuid[])`, [ids]))!.n === 0;

  // Eigene Adresse je Konto: die Einladungsannahme ist je IP begrenzt, andere Abschnitte laden ebenfalls ein
  const invite = async (email: string, roles: string[], name: string, ip: string) => {
    const inv = await admin.post('/users/invite', { email, roles });
    const c = new Client(app, ip);
    const acc = await c.post(`/auth/invite/${inv.json.link.split('/einladung/')[1]}`, { name, password: `${name}-Zugang-sicher-2026` });
    expect(acc.json.next).toBe('done');
    return { client: c, userId: inv.json.user.id as string };
  };
  beforeAll(async () => {
    authorA = await invite('loeschen-a@example.org', ['warning_author'], 'Ari', '198.51.100.91');
    authorB = await invite('loeschen-b@example.org', ['warning_author'], 'Bo', '198.51.100.92');
    approverX = await invite('loeschen-x@example.org', ['warning_approver'], 'Xen', '198.51.100.93');
  });

  it('Entwurf: nur Ersteller oder Freigabe-Recht; Erstmeldung löscht den Baum, Aktualisierung nur sich selbst', async () => {
    const root = await create(authorA.client, { kind: 'initial' });
    await authorA.client.put(`/warnings/${root.id}/revision`, { baseRevision: 1, data: { headline: 'Vertrauliche Lage Musterstraße', callback: 'Rückruf Erika 0123 456' } });
    const upd = await create(authorA.client, { kind: 'update', parentId: root.id });
    const clear = await create(authorA.client, { kind: 'all_clear', parentId: upd.id });
    // Aktualisierung löschen: nur sie und die Entwarnung, die auf ihr aufbaut
    const chk = (await authorA.client.get(`/warnings/${upd.id}/delete-check`)).json;
    expect(chk).toMatchObject({ level: 'draft', allowed: true, reasonRequired: false });
    expect(chk.tree.map((t: any) => t.case_no)).toEqual([upd.case_no, clear.case_no]);
    // Fremder Entwurf: kein Recht
    expect((await authorB.client.get(`/warnings/${upd.id}/delete-check`)).json.allowed).toBe(false);
    expect((await authorB.client.raw('DELETE', `/warnings/${upd.id}`, { body: {} })).status).toBe(403);
    const d1 = await authorA.client.raw('DELETE', `/warnings/${upd.id}`, { body: {} });
    expect(d1.json).toMatchObject({ ok: true, deleted: 2 });
    expect(await gone([upd.id, clear.id])).toBe(true);
    expect(await gone([root.id])).toBe(false);
    expect(fs.existsSync(pdf(upd.id))).toBe(false);
    // Erstmeldung: ganzer Baum; Freigabe-Recht darf fremde Entwürfe löschen
    const upd2 = await create(authorA.client, { kind: 'update', parentId: root.id });
    expect((await approverX.client.get(`/warnings/${root.id}/delete-check`)).json.tree).toHaveLength(2);
    const d2 = await approverX.client.raw('DELETE', `/warnings/${root.id}`, { body: { reason: 'Versehentlich angelegt' } });
    expect(d2.json.deleted).toBe(2);
    expect(await gone([root.id, upd2.id])).toBe(true);
    expect(await one(`SELECT 1 FROM warning_revisions WHERE warning_id = ANY($1::uuid[])`, [[root.id, upd2.id]])).toBeNull();
    expect(fs.existsSync(pdf(root.id))).toBe(false);
    // Audit: nur Vorgangsnummern, Person und Grund – keine Inhalte
    const a = await one<any>(`SELECT actor_name, object_label, details FROM audit_events WHERE action = 'warning.deleted' AND object_id = $1::text`, [root.id]);
    expect(a).toMatchObject({ object_label: root.case_no, details: { vorgaenge: [root.case_no, upd2.case_no], stand: 'Entwurf', grund: 'Versehentlich angelegt' } });
    expect(JSON.stringify(a)).not.toMatch(/Musterstraße|Erika|0123/);
  });

  it('freigegeben: nur mit Freigabe-Recht; versandt: nur Administration mit Begründung; laufender Versand sperrt', async () => {
    const w1 = await create(authorA.client, { kind: 'initial' });
    await approve(w1.id);
    expect((await authorA.client.get(`/warnings/${w1.id}/delete-check`)).json).toMatchObject({ level: 'approved', allowed: false });
    expect((await authorA.client.raw('DELETE', `/warnings/${w1.id}`, { body: {} })).status).toBe(403);
    expect((await approverX.client.raw('DELETE', `/warnings/${w1.id}`, { body: {} })).status).toBe(200);
    expect(await gone([w1.id])).toBe(true);

    const w2 = await create(authorA.client, { kind: 'initial' });
    const sid = await send(w2.id);
    await pool.query(`INSERT INTO warning_sends_body (send_id, body) VALUES ($1, 'Rückruf Erika')`, [sid]);
    expect((await approverX.client.get(`/warnings/${w2.id}/delete-check`)).json).toMatchObject({ level: 'sent', allowed: false, reasonRequired: true });
    expect((await approverX.client.raw('DELETE', `/warnings/${w2.id}`, { body: { reason: 'Test' } })).status).toBe(403);
    const noReason = await admin.raw('DELETE', `/warnings/${w2.id}`, { body: {} });
    expect(noReason.status).toBe(400);
    expect(noReason.json.message).toContain('begründen');
    expect((await admin.raw('DELETE', `/warnings/${w2.id}`, { body: { reason: 'Übungsvorgang, versehentlich an das Testpostfach' } })).status).toBe(200);
    expect(await gone([w2.id])).toBe(true);
    expect(await one(`SELECT 1 FROM warning_sends WHERE id = $1`, [sid])).toBeNull();
    expect(await one(`SELECT 1 FROM warning_sends_body WHERE send_id = $1`, [sid])).toBeNull();
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'warning.deleted' AND object_id = $1::text`, [w2.id])).details).toMatchObject({ stand: 'versandt', grund: 'Übungsvorgang, versehentlich an das Testpostfach' });

    const w3 = await create(authorA.client, { kind: 'initial' });
    await send(w3.id, 'sending');
    const running = await admin.raw('DELETE', `/warnings/${w3.id}`, { body: { reason: 'Versand läuft noch' } });
    expect(running.status).toBe(409);
    expect(await gone([w3.id])).toBe(false);
  });

  it('amtliche Warnung ausblenden: aus der Liste, nie neu angelegt, Banner beendet, auditiert', async () => {
    let xml = '';
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as any).port}/cap.xml`;
      xml = `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>AUSBLENDEN-1</identifier><sender>test@example.invalid</sender><sent>2026-11-15T10:00:00+01:00</sent><status>Actual</status><msgType>Alert</msgType><info><language>de-DE</language><event>Sturm</event><severity>Moderate</severity><headline>Sturmböen (fiktiv)</headline><expires>${new Date(Date.now() + 3600_000).toISOString()}</expires><area><areaDesc>Musterkreis</areaDesc></area></info></alert>`;
      const conn = (await one<any>(`INSERT INTO connections (kind, name, status, config, private_target, private_approved_at) VALUES ('warnfeed', 'Ausblenden-Feed', 'active', $1, '127.0.0.1', now()) RETURNING *`, [JSON.stringify({ format: 'cap', url })]))!;
      const { refreshWarnfeed } = await import('../src/connections/warnfeed.js');
      expect((await refreshWarnfeed(conn)).added).toBe(1);
      const w = (await one<any>(`SELECT * FROM official_warnings WHERE connection_id = $1`, [conn.id]))!;
      const site = await one<any>(`SELECT id FROM wp_sites LIMIT 1`);
      const banner = site ? (await one<any>(`INSERT INTO banners (site_id, title, ends_at, content_hash, approved_hash, approved_at) VALUES ($1, 'Sturmböen (fiktiv)', now() + interval '1 hour', 'h', 'h', now()) RETURNING id`, [site.id]))! : null;
      if (banner) await pool.query(`UPDATE official_warnings SET banner_id = $2 WHERE id = $1`, [w.id, banner.id]);
      expect((await editor.get('/official-warnings')).json.some((x: any) => x.id === w.id)).toBe(true);
      expect((await anonymous.post(`/official-warnings/${w.id}/dismiss`)).status).toBe(401);
      const r = await editor.post(`/official-warnings/${w.id}/dismiss`);
      expect(r.status).toBe(200);
      expect(r.json.bannerEnded).toBe(!!banner);
      if (banner) expect((await one<any>(`SELECT ended_at FROM banners WHERE id = $1`, [banner.id]))!.ended_at).not.toBeNull();
      expect((await editor.get('/official-warnings')).json.some((x: any) => x.id === w.id)).toBe(false);
      expect((await editor.post(`/official-warnings/${w.id}/dismiss`)).status).toBe(404);
      expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'official_warning.dismissed' AND object_id = $1::text`, [w.id])).details).toMatchObject({ kennung: 'AUSBLENDEN-1' });
      // Späterer Abruf: nicht neu angelegt, bleibt ausgeblendet, keine neue Benachrichtigung
      const notes = async () => (await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE '%Sturmböen (fiktiv)%'`))!.n;
      const n0 = await notes();
      expect((await refreshWarnfeed(conn)).added).toBe(0);
      expect((await one<any>(`SELECT count(*)::int AS n FROM official_warnings WHERE connection_id = $1 AND identifier = 'AUSBLENDEN-1'`, [conn.id]))!.n).toBe(1);
      expect((await one<any>(`SELECT dismissed_at, last_seen_at FROM official_warnings WHERE id = $1`, [w.id]))!.dismissed_at).not.toBeNull();
      expect(await notes()).toBe(n0);
      await pool.query(`UPDATE connections SET status = 'revoked' WHERE id = $1`, [conn.id]);
    } finally {
      srv.close();
    }
  });
});

describe('FE2: Schlüssel in der Adresse (Option)', () => {
  it('nur eingeschaltet gültig, eigener Schlüssel, Vergleich über Prüfsumme; nie in Protokoll, Audit oder Meldungen', async () => {
    const c = await admin.post('/connections', { kind: 'fe2', name: 'FE2 Adresse' });
    const id = c.json.id;
    const bearer = c.json.token;
    const sender = new Client(app, '198.51.100.140');
    const viaPath = (tok: string, headers: Record<string, string> = {}) => sender.raw('POST', `/inbound/fe2/${id}/${tok}`, { body: { einsatz: { id: 'P-1', stichwort: 'F-1', ort: 'Musterstadt' } }, headers: { 'x-blaulichtcms-test': '1', ...headers } });
    // Standard aus: Adresse mit Schlüssel gilt nicht – auch nicht mit dem richtigen Kopfzeilen-Schlüssel im Pfad
    expect((await admin.get(`/connections/${id}`)).json).toMatchObject({ config: { keyInPath: false }, inbound_url_with_key: null });
    expect((await viaPath(bearer)).status).toBe(401);
    // Einschalten verlangt einen neuen Test und erzeugt einen eigenen Schlüssel
    const on = await admin.put(`/connections/${id}`, { name: 'FE2 Adresse', config: { keyInPath: true } });
    expect(on.json.retest).toBe(true);
    const d = (await admin.get(`/connections/${id}`)).json;
    expect(d.inbound_url_with_key).toMatch(new RegExp(`/api/v1/inbound/fe2/${id}/bcfe2p_[A-Za-z0-9_-]{20,}$`));
    expect(d.secrets_set).not.toContain('pathToken');
    const pathKey = d.inbound_url_with_key.split('/').pop();
    expect(pathKey).not.toBe(bearer);
    // Nur die Verwaltung sieht die Adresse mit Schlüssel
    expect((await editor.get(`/connections/${id}`)).status).toBe(403);
    expect(JSON.stringify((await editor.get('/connections')).json)).not.toContain(pathKey);

    delete process.env.BLAULICHTCMS_NO_DB_LOG;
    try {
      const ok = await viaPath(pathKey);
      expect(ok.status).toBe(200);
      expect(ok.json.outcome).toBe('test');
      expect((await viaPath(`${pathKey}x`)).status).toBe(401);
      expect((await viaPath('bcfe2p_falsch')).status).toBe(401);
      // Kopfzeile funktioniert weiter
      expect((await anonymous.raw('POST', `/inbound/fe2/${id}`, { body: { einsatz: { id: 'P-2' } }, headers: { authorization: `Bearer ${bearer}`, 'x-blaulichtcms-test': '1' } })).json.outcome).toBe('test');
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.env.BLAULICHTCMS_NO_DB_LOG = '1';
    }
    const like = [`%${pathKey}%`, `%${pathKey.slice(7, 30)}%`];
    expect((await one<any>(`SELECT count(*)::int AS n FROM app_logs WHERE message ILIKE ANY($1) OR details::text ILIKE ANY($1)`, [like]))!.n).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE object_label ILIKE ANY($1) OR details::text ILIKE ANY($1) OR actor_name ILIKE ANY($1)`, [like]))!.n).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title ILIKE ANY($1) OR body ILIKE ANY($1) OR link ILIKE ANY($1)`, [like]))!.n).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM app_logs WHERE source = 'fe2' AND message LIKE 'Testmeldung empfangen%'`))!.n).toBeGreaterThan(0);
    const fail = await one<any>(`SELECT details FROM audit_events WHERE action = 'fe2.auth' AND object_id = $1::text ORDER BY id DESC LIMIT 1`, [id]);
    expect(fail.details).toMatchObject({ grund: 'Schlüssel falsch', weg: 'Adresse' });
    const { redactPath } = await import('../src/app.js');
    expect(redactPath(`/api/v1/inbound/fe2/${id}/${pathKey}?x=1`)).toBe(`/api/v1/inbound/fe2/${id}/***`);
    expect(redactPath(`/api/v1/inbound/fe2/${id}`)).toBe(`/api/v1/inbound/fe2/${id}`);
    expect(redactPath('/api/v1/public/upload/geheim/teil')).toBe('/api/v1/public/upload/***/teil');

    // Neuer Zugangsschlüssel erneuert auch die Adresse
    const rot = await admin.post(`/connections/${id}/rotate-token`);
    const pathKey2 = (await admin.get(`/connections/${id}`)).json.inbound_url_with_key.split('/').pop();
    expect(pathKey2).not.toBe(pathKey);
    expect((await viaPath(pathKey)).status).toBe(401);
    expect((await viaPath(pathKey2)).status).toBe(200);
    expect((await anonymous.raw('POST', `/inbound/fe2/${id}`, { body: { einsatz: { id: 'P-3' } }, headers: { authorization: `Bearer ${rot.json.token}`, 'x-blaulichtcms-test': '1' } })).status).toBe(200);
    // Ausschalten: Adresse mit Schlüssel gilt sofort nicht mehr, der Pfad-Schlüssel ist gelöscht
    await admin.put(`/connections/${id}`, { name: 'FE2 Adresse', config: { keyInPath: false } });
    expect((await viaPath(pathKey2)).status).toBe(401);
    expect((await admin.get(`/connections/${id}`)).json.inbound_url_with_key).toBeNull();
    // Wieder einschalten: neuer Schlüssel, der alte gilt nicht
    await admin.put(`/connections/${id}`, { name: 'FE2 Adresse', config: { keyInPath: true } });
    const pathKey3 = (await admin.get(`/connections/${id}`)).json.inbound_url_with_key.split('/').pop();
    expect(pathKey3).not.toBe(pathKey2);
    expect((await viaPath(pathKey2)).status).toBe(401);
  });
});

/* ---------------------------- Medien wie LiFeOS (Pakete 1–10) ---------------------------- */

/** Neue Sammlung mit Link über die API; liefert IDs und Token. */
async function mediaFixture(c: Client, title: string, link: Record<string, unknown> = {}) {
  const col = (await c.post('/collections', { title, createLink: false })).json.collection;
  const l = await c.post(`/collections/${col.id}/links`, link);
  expect(l.status).toBe(200);
  return { col, link: l.json, token: String(l.json.url ?? '').split('/u/')[1] ?? '' };
}

async function uploadPublic(token: string, name: string, data: Buffer, fields: Record<string, string> = {}) {
  return anonymous.raw('POST', `/public/upload/${token}`, multipart({ name, data, type: 'image/jpeg' }, { clientKey: `k-${crypto.randomBytes(6).toString('hex')}`, ...fields }));
}

describe('Empfangsprotokoll eingehender Verbindungen', () => {
  // Lokale Ersatzdienste für CAP-Quelle und Feuersoftware Connect – nichts geht an echte Dienste
  let srv: import('node:http').Server;
  let base = '';
  const state: { cap: 'ok' | '503'; fs: 'ok' | '503'; alerts: any[]; ops: any[] } = { cap: 'ok', fs: 'ok', alerts: [], ops: [] };
  const FS_KEY = 'fs-protokoll-schluessel-2026';
  const START = new Date(Date.now() - 3600_000).toISOString();
  const alert = (id: string, area: string, code: string) => ({
    identifier: id,
    sender: 'opendata@dwd.de',
    sent: new Date().toISOString(),
    status: 'Actual',
    msgType: 'Alert',
    info: [{ language: 'de-DE', event: 'STURMBÖEN', severity: 'Moderate', urgency: 'Immediate', headline: `Amtliche WARNUNG vor STURMBÖEN (${area})`, description: 'Fiktive Testwarnung.', expires: new Date(Date.now() + 3 * 3600_000).toISOString(), area: [{ areaDesc: area, geocode: [{ valueName: 'ARS', value: code }] }] }],
  });
  const op = (id: string, ric: string, extra: any = {}) => ({
    Id: id,
    Start: START,
    Keyword: 'B3 Wohnungsbrand',
    Category: 'Brand',
    Facts: 'VERTRAULICH Person bewusstlos',
    Ric: ric,
    Number: '4711-2026',
    Reporter: { Name: 'Erika Musterfrau', PhoneNumber: '0123 456789' },
    Address: { Street: 'Hauptstraße', HouseNumber: '12', City: 'Musterstadt', District: 'Nord', CityWithDistrict: 'Musterstadt - Nord', StreetWithHouseNumber: 'Hauptstraße 12', Lat: 50.123, Lng: 8.654, ZipCode: '12345' },
    ...extra,
  });
  let wf: any;
  let fsId = '';
  let fe2Id = '';
  let fe2Token = '';
  const receipts = async (id: string, q = '') => admin.get(`/connections/${id}/receipts${q}`);
  const items = async (id: string, rid: string, q = '') => (await admin.get(`/connections/${id}/receipts/${rid}/items${q}`)).json.items as any[];
  /** Alles, was zu einer Verbindung im Empfangsprotokoll gespeichert ist (Einträge, Meldungen, Rohdaten); UUIDs ausgeblendet, damit Zufallsziffern nicht als Treffer zählen */
  const stored = async (id: string) =>
    JSON.stringify(
      await many<any>(
        `SELECT r.error, r.summary, i.reason, i.info, b.body FROM connection_receipts r
           LEFT JOIN connection_receipt_items i ON i.receipt_id = r.id LEFT JOIN connection_receipt_raws b ON b.hash = i.raw_hash WHERE r.connection_id = $1`,
        [id],
      ),
    ).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/cap.json') {
        if (state.cap === '503') {
          res.writeHead(503);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state.alerts));
      }
      if (req.headers.authorization !== `bearer ${FS_KEY}`) {
        res.writeHead(401);
        return res.end();
      }
      if (state.fs === '503') {
        res.writeHead(503);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.ops));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
    process.env.BLAULICHTCMS_FEUERSOFTWARE_URL = base;
    state.alerts = [alert('PROTOKOLL-1', 'Gemeinde Musterstadt', '099990001001'), alert('PROTOKOLL-2', 'Gemeinde Nachbarort', '099980002002')];
    wf = (await one<any>(
      `INSERT INTO connections (kind, name, status, config, private_target, private_approved_at) VALUES ('warnfeed', 'Protokoll-Feed', 'active', $1, '127.0.0.1', now()) RETURNING *`,
      [JSON.stringify({ format: 'cap', url: `${base}/cap.json`, areaFilter: { codes: [], names: ['Musterstadt'] } })],
    ))!;
  });
  afterAll(() => {
    srv?.close();
    delete process.env.BLAULICHTCMS_FEUERSOFTWARE_URL;
  });

  it('Warnfeed: jeder Abruf mit allen Meldungen, Entscheidung und Grund – auch herausgefilterte und Fehler', async () => {
    const { refreshWarnfeed } = await import('../src/connections/warnfeed.js');
    expect(await refreshWarnfeed(wf, { trigger: 'manual' })).toEqual({ total: 2, added: 2 });
    const r1 = (await receipts(wf.id)).json;
    expect(r1.total).toBe(1);
    expect(r1.retention_days).toBe(7);
    expect(r1.items[0]).toMatchObject({ trigger: 'manual', trigger_label: '„Jetzt abrufen“', ok: true, received: 2, accepted: 1, filtered: 1, errors: 0, http_status: 200 });
    expect(r1.items[0].duration_ms).toBeGreaterThanOrEqual(0);
    const it1 = await items(wf.id, r1.items[0].id);
    const byId = (id: string) => it1.find((i) => i.info.identifier === id);
    expect(byId('PROTOKOLL-1')).toMatchObject({ decision: 'accepted', decision_label: 'übernommen', has_raw: true, info: { provider: 'Deutscher Wetterdienst', msgType: 'Alert', severity: 'Moderate', areas: ['Gemeinde Musterstadt'], inArea: true } });
    expect(byId('PROTOKOLL-1').reason).toContain('Ortsname „Musterstadt“ in „Gemeinde Musterstadt“');
    expect(byId('PROTOKOLL-2')).toMatchObject({ decision: 'filtered', info: { inArea: false } });
    expect(byId('PROTOKOLL-2').reason).toMatch(/^Gebiet passt nicht: Orte der Meldung Gemeinde Nachbarort – eingestellt Musterstadt\. Gespeichert als „außerhalb des Gebiets“/);
    // Rohdaten vollständig, wie geliefert (öffentliche Daten)
    const raw = await admin.get(`/connections/${wf.id}/receipts/${r1.items[0].id}/items/${byId('PROTOKOLL-2').id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.json).toMatchObject({ redacted: false, truncated: false });
    expect(JSON.parse(raw.json.body)).toEqual(state.alerts[1]);
    // Zweiter Abruf: beide schon bekannt, Rohdaten nur einmal gespeichert
    await refreshWarnfeed(wf);
    const r2 = (await receipts(wf.id)).json.items[0];
    expect(r2).toMatchObject({ trigger: 'scheduled', received: 2, accepted: 0, filtered: 0 });
    expect((await items(wf.id, r2.id)).map((i) => i.decision)).toEqual(['known', 'known']);
    expect((await one<any>(`SELECT count(DISTINCT i.raw_hash)::int AS n FROM connection_receipt_items i JOIN connection_receipts r ON r.id = i.receipt_id WHERE r.connection_id = $1`, [wf.id]))!.n).toBe(2);
    // Ausgeblendete Meldung
    const w1 = (await one<any>(`SELECT id FROM official_warnings WHERE connection_id = $1 AND identifier = 'PROTOKOLL-1'`, [wf.id]))!;
    expect((await editor.post(`/official-warnings/${w1.id}/dismiss`)).status).toBe(200);
    await refreshWarnfeed(wf);
    const r3 = (await receipts(wf.id)).json.items[0];
    expect((await items(wf.id, r3.id)).find((i) => i.info.identifier === 'PROTOKOLL-1')).toMatchObject({ decision: 'dismissed', decision_label: 'ausgeblendet' });
    // Fehlerhafter Abruf: Fehlermeldung, HTTP-Status
    state.cap = '503';
    await expect(refreshWarnfeed(wf)).rejects.toThrow('HTTP 503');
    state.cap = 'ok';
    const r4 = (await receipts(wf.id)).json.items[0];
    expect(r4).toMatchObject({ ok: false, error: expect.stringMatching(/^HTTP 503 von 127\.0\.0\.1/), http_status: 503, received: 0 });
    // Die Liste der amtlichen Warnungen nennt die Verbindung (Link „Was ist angekommen?“)
    expect((await editor.get('/official-warnings')).json.find((w: any) => w.identifier === 'PROTOKOLL-2')).toMatchObject({ connection_id: wf.id });
  });

  it('Filter, Seiten und Recht „Verbindungen verwalten“', async () => {
    const all = (await receipts(wf.id)).json;
    expect(all.total).toBe(4);
    expect(all.items.map((r: any) => r.trigger)).toEqual(['scheduled', 'scheduled', 'scheduled', 'manual']);
    expect((await receipts(wf.id, '?filter=accepted')).json.total).toBe(1);
    expect((await receipts(wf.id, '?filter=filtered')).json.total).toBe(2);
    expect((await receipts(wf.id, '?filter=error')).json.items.map((r: any) => r.ok)).toEqual([false]);
    const p2 = (await receipts(wf.id, '?limit=1&page=2')).json;
    expect(p2).toMatchObject({ total: 4, page: 2, limit: 1 });
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].id).toBe(all.items[1].id);
    const first = all.items[3];
    expect((await items(wf.id, first.id, '?filter=filtered')).map((i) => i.info.identifier)).toEqual(['PROTOKOLL-2']);
    expect((await items(wf.id, first.id, '?filter=accepted')).map((i) => i.info.identifier)).toEqual(['PROTOKOLL-1']);
    // Ohne Recht: nichts
    expect((await editor.get(`/connections/${wf.id}/receipts`)).status).toBe(403);
    expect((await editor.get(`/connections/${wf.id}/receipts/${first.id}/items`)).status).toBe(403);
    const it0 = (await items(wf.id, first.id))[0];
    expect((await editor.get(`/connections/${wf.id}/receipts/${first.id}/items/${it0.id}/raw`)).status).toBe(403);
    expect((await anonymous.get(`/connections/${wf.id}/receipts`)).status).toBe(401);
    // Fremde Verbindung: Eintrag passt nicht
    const other = (await one<any>(`INSERT INTO connections (kind, name, config) VALUES ('warnfeed', 'Anderer Feed', '{}') RETURNING id`))!;
    expect((await admin.get(`/connections/${other.id}/receipts/${first.id}/items`)).status).toBe(404);
    expect((await admin.get(`/connections/${other.id}/receipts/${first.id}/items/${it0.id}/raw`)).status).toBe(404);
  });

  it('FE2: eingehende Meldungen samt Fehlversuchen, Rohdaten nur geschwärzt', async () => {
    const c = await admin.post('/connections', { kind: 'fe2', name: 'FE2 Protokoll (Test)' });
    fe2Id = c.json.id;
    fe2Token = c.json.token;
    const send = (body: any, tok = fe2Token, headers: Record<string, string> = {}) => anonymous.raw('POST', `/inbound/fe2/${fe2Id}`, { body, headers: { authorization: `Bearer ${tok}`, ...headers } });
    const alarm = (id: string, extra: any = {}) => ({
      einsatz: { id, stichwort: 'F-WALD-2', stichwort_text: 'Waldbrand mittel', ort: 'Musterstadt', ortsteil: 'Nord', alarmzeit: '2026-11-14T10:00', einheiten: ['HLF 1'], status: 'offen', strasse: 'Hauptstraße 12', koordinaten: { lat: 50.123, lng: 8.654 }, ...extra },
      meldung: { alarmtext: 'VERTRAULICH Person Max Mustermann Tel 0123 456789', anrufer: { name: 'Erika Musterfrau', telefon: '0171 2345678' } },
    });
    expect((await send(alarm('PR-1'), fe2Token, { 'x-blaulichtcms-test': '1' })).json.outcome).toBe('test');
    let r = (await receipts(fe2Id)).json.items[0];
    expect(r).toMatchObject({ trigger: 'test', ok: true, http_status: 200, received: 1 });
    let its = await items(fe2Id, r.id);
    expect(its[0]).toMatchObject({ decision: 'test', info: { eventId: 'PR-1', keyword: 'F-WALD-2', place: 'Musterstadt, Nord', alarmTime: expect.stringMatching(/^2026-11-14T/) } });
    const raw = (await admin.get(`/connections/${fe2Id}/receipts/${r.id}/items/${its[0].id}/raw`)).json;
    expect(raw.redacted).toBe(true);
    const body = JSON.parse(raw.body);
    expect(body.einsatz).toMatchObject({ id: 'PR-1', stichwort: 'F-WALD-2', ort: 'Musterstadt', koordinaten: '‹entfernt: Koordinate›' });
    expect(body.meldung.alarmtext).toMatch(/^‹ausgeblendet: Text, \d+ Zeichen›$/);
    // Aktiv: neu, unverändert, Aktualisierung
    await pool.query(`UPDATE connections SET status = 'active' WHERE id = $1`, [fe2Id]);
    expect((await send(alarm('PR-2'))).json.outcome).toBe('created');
    expect((await send(alarm('PR-2'))).json.outcome).toBe('duplicate');
    expect((await send(alarm('PR-2', { status: 'beendet' }))).json.outcome).toBe('updated');
    const list = (await receipts(fe2Id)).json.items.slice(0, 3);
    const decisions = [];
    for (const x of list) decisions.push((await items(fe2Id, x.id))[0].decision);
    expect(decisions).toEqual(['updated', 'known', 'accepted']);
    expect(list[2].trigger).toBe('inbound');
    // Ohne Einsatz-ID: 400, Fehler mit Grund
    expect((await send({ einsatz: { stichwort: 'F-1' } })).status).toBe(400);
    r = (await receipts(fe2Id)).json.items[0];
    expect(r).toMatchObject({ ok: false, http_status: 400, error: 'Keine Einsatz-ID gefunden – Zuordnung prüfen.' });
    expect((await items(fe2Id, r.id))[0]).toMatchObject({ decision: 'error', reason: expect.stringContaining('Einsatz-ID') });
    // Falscher Schlüssel: ohne Inhalt, höchstens ein Eintrag je Minute
    const n0 = (await receipts(fe2Id)).json.total;
    expect((await send(alarm('PR-3'), 'bcfe2_falsch')).status).toBe(401);
    expect((await send(alarm('PR-3'), 'bcfe2_falsch')).status).toBe(401);
    const after = (await receipts(fe2Id)).json;
    expect(after.total).toBe(n0 + 1);
    expect(after.items[0]).toMatchObject({ ok: false, http_status: 401, received: 0 });
    expect(await items(fe2Id, after.items[0].id)).toEqual([]);
    // Nichts Personenbezogenes und kein Schlüssel in den gespeicherten Daten
    const all = await stored(fe2Id);
    expect(all).toContain('F-WALD-2');
    for (const secret of ['Hauptstraße', 'Mustermann', 'Musterfrau', '0123 456789', '0171', 'VERTRAULICH', '50.123', '8.654', fe2Token, 'bcfe2_falsch']) expect(all).not.toContain(secret);
  });

  it('Feuersoftware: Abruf mit Filtergründen (RIC, älter als 24 Stunden), Fehler mit HTTP-Status, Rohdaten geschwärzt', async () => {
    const { updateConnectionSecrets } = await import('../src/connections/common.js');
    const { pollFeuersoftware } = await import('../src/connections/feuersoftware.js');
    const c = (await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('feuersoftware', 'Connect Protokoll', 'active', $1) RETURNING *`, [JSON.stringify({ intervalSeconds: 120, rics: ['Musterwehr Vollalarm'], keywords: [], createDrafts: true })]))!;
    fsId = c.id;
    await updateConnectionSecrets(c, { apiKey: FS_KEY }, null);
    state.ops = [op('PFS-1', 'Musterwehr Vollalarm'), op('PFS-2', 'Nachbarwehr', { Keyword: 'TH 1' }), op('PFS-ALT', 'Musterwehr Vollalarm', { Start: new Date(Date.now() - 3 * 86400_000).toISOString() })];
    expect(await pollFeuersoftware(fsId, { force: true })).toMatchObject({ seen: 2, matched: 1, created: 1 });
    const r = (await receipts(fsId)).json.items[0];
    expect(r).toMatchObject({ trigger: 'manual', ok: true, http_status: 200, received: 3, accepted: 1, filtered: 2 });
    const its = await items(fsId, r.id);
    const by = (id: string) => its.find((i) => i.info.eventId === id);
    expect(by('PFS-1')).toMatchObject({ decision: 'accepted', info: { keyword: 'B3 Wohnungsbrand', place: 'Musterstadt - Nord', ric: 'Musterwehr Vollalarm' } });
    expect(by('PFS-1').reason).toContain('RIC „Musterwehr Vollalarm“ passt');
    expect(by('PFS-2')).toMatchObject({ decision: 'filtered', reason: 'RIC nicht in der Liste: „Nachbarwehr“ – eingestellt „Musterwehr Vollalarm“.' });
    expect(by('PFS-ALT')).toMatchObject({ decision: 'filtered', reason: expect.stringMatching(/^Älter als 24 Stunden/) });
    const raw = JSON.parse((await admin.get(`/connections/${fsId}/receipts/${r.id}/items/${by('PFS-1').id}/raw`)).json.body);
    expect(raw).toMatchObject({ Id: 'PFS-1', Keyword: 'B3 Wohnungsbrand', Address: { City: 'Musterstadt', Lat: '‹entfernt: Koordinate›' } });
    // Fehler: Serverfehler mit Status
    state.fs = '503';
    await pool.query(`UPDATE connections SET last_poll_at = NULL WHERE id = $1`, [fsId]);
    expect((await pollFeuersoftware(fsId, { force: true })).error).toContain('Serverfehler (503)');
    state.fs = 'ok';
    expect((await receipts(fsId)).json.items[0]).toMatchObject({ ok: false, http_status: 503, trigger: 'manual', error: expect.stringContaining('Serverfehler (503)') });
    const all = await stored(fsId);
    for (const secret of ['Hauptstraße', '4711-2026', 'bewusstlos', 'VERTRAULICH', 'Musterfrau', '0123 456789', '12345', '50.123', '8.654', FS_KEY]) expect(all).not.toContain(secret);
  });

  it('Obergrenze je Verbindung und Löschfrist samt Rohdaten', async () => {
    const { RECEIPT_CAP } = await import('../src/connections/receipts.js');
    const { refreshWarnfeed } = await import('../src/connections/warnfeed.js');
    await pool.query(
      `INSERT INTO connection_receipts (connection_id, trigger, ok, created_at) SELECT $1, 'scheduled', true, now() - interval '2 days' - make_interval(secs => g) FROM generate_series(1, $2::int) g`,
      [wf.id, RECEIPT_CAP],
    );
    await refreshWarnfeed(wf);
    const count = async () => (await one<any>(`SELECT count(*)::int AS n FROM connection_receipts WHERE connection_id = $1`, [wf.id]))!.n;
    expect(await count()).toBe(RECEIPT_CAP);
    // Die echten Abrufe sind die neuesten und bleiben
    expect((await receipts(wf.id)).json.items[0].received).toBe(2);
    // Löschfrist: älter als 7 Tage → weg, samt Meldungen; Rohdaten ohne Bezug danach ebenfalls
    const newest = (await receipts(wf.id)).json.items[0].id;
    await pool.query(`UPDATE connection_receipts SET created_at = now() - interval '8 days' WHERE connection_id = $1`, [wf.id]);
    await pool.query(`UPDATE connection_receipt_raws SET last_used_at = now() - interval '2 hours'`);
    const { runRetention } = await import('../src/lib/retention.js');
    const preview = await runRetention({ dryRun: true });
    expect(preview.categories.find((c) => c.key === 'connection_receipts')).toMatchObject({ days: 7, count: RECEIPT_CAP });
    await runRetention({ dryRun: false });
    expect(await count()).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM connection_receipt_items WHERE receipt_id = $1`, [newest]))!.n).toBe(0);
    // Rohdaten der Warnmeldungen sind weg; die der anderen Verbindungen (inzwischen ebenfalls älter markiert) bleiben, solange sie noch verwendet werden
    expect((await one<any>(`SELECT count(*)::int AS n FROM connection_receipt_raws b WHERE b.body LIKE '%PROTOKOLL-%'`))!.n).toBe(0);
    expect((await one<any>(`SELECT count(*)::int AS n FROM connection_receipt_raws b WHERE b.body LIKE '%PFS-1%'`))!.n).toBeGreaterThan(0);
    // Verbindung endgültig löschen entfernt ihr Protokoll mit
    const tmp = (await one<any>(`INSERT INTO connections (kind, name, config) VALUES ('warnfeed', 'Nie benutzt', '{}') RETURNING id`))!;
    await pool.query(`INSERT INTO connection_receipts (connection_id, trigger, ok) VALUES ($1, 'test', false)`, [tmp.id]);
    expect((await admin.raw('DELETE', `/connections/${tmp.id}`)).json.mode).toBe('deleted');
    expect((await one<any>(`SELECT count(*)::int AS n FROM connection_receipts WHERE connection_id = $1`, [tmp.id]))!.n).toBe(0);
  });
});

describe('Medien wie LiFeOS 1: Upload-Seite und Link-Bedienung', () => {
  it('Gültigkeit in Stunden oder bis Termin, mit Höchstdauer', async () => {
    const col = (await editor.post('/collections', { title: 'Link-Bedienung', createLink: true, linkHours: 6 })).json;
    const exp = new Date(col.link.expires_at).getTime();
    expect(Math.abs(exp - (Date.now() + 6 * 3600_000))).toBeLessThan(60_000);
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect((await editor.post(`/collections/${col.collection.id}/links`, { expiresAt: soon })).status).toBe(400);
    const far = new Date(Date.now() + 400 * 86400_000).toISOString();
    expect((await editor.post(`/collections/${col.collection.id}/links`, { expiresAt: far })).status).toBe(400);
    const date = new Date(Date.now() + 2 * 86400_000).toISOString();
    const l = await editor.post(`/collections/${col.collection.id}/links`, { expiresAt: date, welcomeText: 'Willkommen beim Sommerfest!' });
    expect(new Date(l.json.expires_at).toISOString()).toBe(date);
    // Begrüßungstext je Link hat Vorrang, Kameraknöpfe und Erfolgstext kommen aus den Einstellungen
    const info = await anonymous.get(`/public/upload/${l.json.url.split('/u/')[1]}`);
    expect(info.json.welcome_text).toBe('Willkommen beim Sommerfest!');
    expect(info.json.camera_buttons).toBe(true);
    expect(info.json.done_text).toBeNull();
    await admin.patch('/settings', { 'media.camera_buttons': false, 'media.done_text': 'Danke fürs Mitmachen!' });
    const info2 = await anonymous.get(`/public/upload/${l.json.url.split('/u/')[1]}`);
    expect(info2.json).toMatchObject({ camera_buttons: false, done_text: 'Danke fürs Mitmachen!' });
    await admin.patch('/settings', { 'media.camera_buttons': true, 'media.done_text': '' });
  });

  it('Pausieren, Fortsetzen, Verlängern, Termin, Neu erzeugen – mit Audit und einheitlicher Meldung', async () => {
    const { col, link, token } = await mediaFixture(editor, 'Pausen-Test', { hours: 24, label: 'Aushang' });
    expect((await publisher.post(`/upload-links/${link.id}/pause`)).status).toBe(403);
    const paused = await editor.post(`/upload-links/${link.id}/pause`);
    expect(paused.json.state).toBe('paused');
    // Link und QR-Code bleiben für den Aushang abrufbar
    expect(paused.json.url).toContain('/u/');
    const r = await anonymous.get(`/public/upload/${token}`);
    expect(r.status).toBe(410);
    expect(r.json.error).toBe('link_unavailable');
    const unknown = await anonymous.get(`/public/upload/unbekannt-unbekannt-9999`);
    expect(unknown.status).toBe(404);
    expect(unknown.json.message).toBe(r.json.message);
    expect((await uploadPublic(token, 'p.jpg', await photoWithGps())).status).toBe(410);
    expect((await editor.post(`/upload-links/${link.id}/resume`)).json.state).toBe('active');
    expect((await anonymous.get(`/public/upload/${token}`)).status).toBe(200);
    // Verlängern ab dem bisherigen Ablauf
    const ext = await editor.post(`/upload-links/${link.id}/extend`, { hours: 24 });
    expect(new Date(ext.json.expires_at).getTime() - new Date(link.expires_at).getTime()).toBeGreaterThan(23 * 3600_000);
    // „Bis Termin“ auch früher
    const earlier = new Date(Date.now() + 3600_000).toISOString();
    expect(new Date((await editor.patch(`/upload-links/${link.id}`, { expiresAt: earlier })).json.expires_at).toISOString()).toBe(earlier);
    // Abgelaufen: Fortsetzen nur nach Verlängern
    await pool.query(`UPDATE upload_links SET expires_at = now() - interval '1 minute', paused_at = now() WHERE id = $1`, [link.id]);
    expect((await editor.post(`/upload-links/${link.id}/resume`)).status).toBe(400);
    expect((await editor.post(`/upload-links/${link.id}/extend`, { hours: 6 })).json.state).toBe('paused');
    await editor.post(`/upload-links/${link.id}/resume`);
    // Neu erzeugen: alter Token ungültig, neuer gültig, Einstellungen bleiben
    const re = await editor.post(`/upload-links/${link.id}/regenerate`);
    const newToken = re.json.url.split('/u/')[1];
    expect(newToken).not.toBe(token);
    expect(re.json.label).toBe('Aushang');
    expect((await anonymous.get(`/public/upload/${token}`)).status).toBe(404);
    expect((await anonymous.get(`/public/upload/${newToken}`)).status).toBe(200);
    const acts = (await many<any>(`SELECT action FROM audit_events WHERE object_id = $1 ORDER BY id`, [link.id])).map((a) => a.action);
    for (const a of ['upload_link.created', 'upload_link.paused', 'upload_link.resumed', 'upload_link.extended', 'upload_link.updated', 'upload_link.regenerated']) expect(acts).toContain(a);
    // Widerrufene Links lassen sich nicht mehr ändern
    await editor.post(`/upload-links/${link.id}/revoke`);
    expect((await editor.post(`/upload-links/${link.id}/resume`)).status).toBe(400);
    expect((await editor.post(`/upload-links/${link.id}/regenerate`)).status).toBe(400);
    expect((await editor.get(`/collections/${col.id}`)).json.links[0]).toMatchObject({ state: 'revoked', url: null, created_by_name: 'Robin' });
  });

  it('„Link nur einmal anzeigen“ speichert nur die Prüfsumme', async () => {
    await admin.patch('/settings', { 'media.link_show_once': true });
    const { col, link, token } = await mediaFixture(editor, 'Nur einmal');
    expect(link.shown_once).toBe(true);
    expect(token.length).toBeGreaterThan(10);
    expect((await one<any>(`SELECT token_enc FROM upload_links WHERE id = $1`, [link.id])).token_enc).toBeNull();
    const again = (await editor.get(`/collections/${col.id}`)).json.links[0];
    expect(again).toMatchObject({ url: null, url_hidden: true, state: 'active' });
    expect((await anonymous.get(`/public/upload/${token}`)).status).toBe(200);
    // Neu erzeugen liefert den neuen Link genau einmal
    const re = await editor.post(`/upload-links/${link.id}/regenerate`);
    expect(re.json.shown_once).toBe(true);
    expect((await anonymous.get(`/public/upload/${re.json.url.split('/u/')[1]}`)).status).toBe(200);
    await admin.patch('/settings', { 'media.link_show_once': false });
  });
});

describe('Medien wie LiFeOS 2: Galerie-Komfort', () => {
  let col: any;
  let ids: string[] = [];
  it('Duplikat-Hinweis über die Prüfsumme, Anzeigename, Beschreibung, interne Notiz und Details', async () => {
    const f = await mediaFixture(editor, 'Galerie');
    col = f.col;
    // Eindeutiger Inhalt: photoWithGps() wird in anderen Tests schon hochgeladen (wäre sonst Duplikat einer älteren Datei)
    const photo = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg({ quality: 77 }).toBuffer();
    await uploadPublic(f.token, 'a.jpg', photo);
    await uploadPublic(f.token, 'b.jpg', photo);
    await uploadPublic(f.token, 'c.jpg', await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 10, g: 90, b: 200 } } }).jpeg().toBuffer());
    await processAllQuarantine();
    const media = (await editor.get(`/collections/${col.id}`)).json.media;
    ids = media.map((m: any) => m.id);
    const a = media.find((m: any) => m.original_name === 'a.jpg');
    const b = media.find((m: any) => m.original_name === 'b.jpg');
    expect(b.duplicate_of).toBe(a.id);
    expect(a.duplicate_of).toBeNull();
    expect((await publisher.patch(`/media/${a.id}`, { displayName: 'Nein' })).status).toBe(403);
    const u = await editor.patch(`/media/${a.id}`, { displayName: 'Drehleiter am Abend', description: 'Übung mit Drehleiter', internalNote: 'Rückfrage bei Max Mustermann' });
    expect(u.json).toMatchObject({ display_name: 'Drehleiter am Abend', description: 'Übung mit Drehleiter', internal_note: 'Rückfrage bei Max Mustermann' });
    const d = await publisher.get(`/media/${b.id}/details`);
    expect(d.status).toBe(200);
    expect(d.json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.json.duplicates.map((x: any) => x.id)).toContain(a.id);
    expect(d.json.posts).toEqual([]);
    // Neue Freitexte sind Teil der Datenschutzsuche und werden beim Pseudonymisieren geleert
    const hits = (await admin.get(`/privacy/search?q=${encodeURIComponent('Max Mustermann')}`)).json.hits;
    const hit = hits.find((h: any) => h.kind === 'media' && h.id === a.id);
    expect(hit.fields.interne_notiz).toBe('Rückfrage bei Max Mustermann');
    expect((await admin.post('/privacy/action', { kind: 'media', id: a.id, action: 'pseudonymize' })).status).toBe(200);
    expect(await one<any>(`SELECT display_name, description, internal_note FROM media WHERE id = $1`, [a.id])).toEqual({ display_name: '', description: '', internal_note: '' });
  });

  it('Sammelaktionen: Sichtung, Zurückstellen, ZIP der markierten, Löschen mit Beitragsschutz', async () => {
    expect((await publisher.post('/media/bulk', { ids, action: 'selection', selection: 'selected' })).status).toBe(403);
    expect((await editor.post('/media/bulk', { ids, action: 'selection', selection: 'on_hold' })).json.updated).toBe(3);
    expect((await editor.get(`/collections/${col.id}`)).json.media.every((m: any) => m.selection === 'on_hold')).toBe(true);
    const ex = await editor.post(`/collections/${col.id}/exports`, { selection: 'ids', ids: ids.slice(0, 2) });
    expect(ex.json.files).toBe(2);
    // Datei in einem Beitrag: Sammelaktion „Löschen“ wird ganz abgelehnt
    const p = await editor.post('/posts', { title: 'Galerie-Beitrag', kind: 'news' });
    const post = (await editor.get(`/posts/${p.json.id}`)).json;
    expect((await editor.put(`/posts/${p.json.id}/revision`, { title: "Galerie-Beitrag", body: "Text", mediaIds: [ids[2]], baseRevision: post.revision.number })).status).toBe(200);
    const blocked = await editor.post('/media/bulk', { ids, action: 'delete' });
    expect(blocked.status).toBe(400);
    expect(blocked.json.message).toMatch(/Galerie-Beitrag/);
    expect((await one<any>(`SELECT count(*)::int AS n FROM media WHERE id = ANY($1) AND deleted_at IS NULL`, [ids])).n).toBe(3);
    expect((await editor.get(`/media/${ids[2]}/details`)).json.posts[0]).toMatchObject({ title: 'Galerie-Beitrag', current: true });
    const del = await editor.post('/media/bulk', { ids: ids.slice(0, 2), action: 'delete' });
    expect(del.json.updated).toBe(2);
    expect((await many<any>(`SELECT action FROM audit_events WHERE action = 'media.deleted' AND object_id = ANY($1)`, [ids.slice(0, 2)])).length).toBe(2);
  });

  it('Sichtung mit Versionsprüfung: gleichzeitiges Sichten liefert 409 statt „letzter gewinnt“', async () => {
    const m = await one<any>(`SELECT id, selection_version FROM media WHERE id = $1`, [ids[2]]);
    const ok = await editor.post('/media/selection', { ids: [m.id], selection: 'selected', versions: { [m.id]: m.selection_version } });
    expect(ok.status).toBe(200);
    expect(ok.json.versions[m.id]).toBe(m.selection_version + 1);
    const stale = await admin.post('/media/selection', { ids: [m.id], selection: 'skipped', versions: { [m.id]: m.selection_version } });
    expect(stale.status).toBe(409);
    expect(stale.json.message).toMatch(/Robin/);
    expect((await one<any>(`SELECT selection FROM media WHERE id = $1`, [m.id])).selection).toBe('selected');
    // Ohne Versionsangabe (Kachel-Knöpfe) gilt die Entscheidung wie bisher
    expect((await admin.post('/media/selection', { ids: [m.id], selection: 'skipped' })).json.updated).toBe(1);
  });
});

describe('Medien wie LiFeOS 3: Ordner, Verschieben/Kopieren, Schlagworte, Suche, ZIP mit Struktur', () => {
  let col: any;
  let other: any;
  let folderA = '';
  let folderB = '';
  let ids: string[] = [];
  const img = (r: number) => sharp({ create: { width: 200, height: 150, channels: 3, background: { r, g: 120, b: 40 } } }).jpeg().toBuffer();

  it('Ordner anlegen, umbenennen, verschachteln – ohne Kreise; Upload-Link mit Zielordner', async () => {
    col = (await editor.post('/collections', { title: 'Ordner-Test', createLink: false, eventDate: '2026-07-04' })).json.collection;
    expect(col.event_date).toBeTruthy();
    expect((await publisher.post(`/collections/${col.id}/folders`, { name: 'Nein' })).status).toBe(403);
    folderA = (await editor.post(`/collections/${col.id}/folders`, { name: 'Einsatz' })).json.id;
    folderB = (await editor.post(`/collections/${col.id}/folders`, { name: 'Drohne', parentId: folderA })).json.id;
    expect((await editor.post(`/collections/${col.id}/folders`, { name: '  ' })).status).toBe(400);
    expect((await editor.patch(`/folders/${folderA}`, { parentId: folderB })).status).toBe(400);
    expect((await editor.patch(`/folders/${folderB}`, { name: 'Drohne/Luft' })).json.name).toBe('Drohne Luft');
    const l = await editor.post(`/collections/${col.id}/links`, { folderId: folderB });
    expect(l.json.folder_id).toBe(folderB);
    const token = l.json.url.split('/u/')[1];
    await uploadPublic(token, 'luft.jpg', await img(11));
    await uploadPublic(token, '=HYPERLINK(1).jpg', await img(12));
    // Fremder Ordner als Ziel wird abgelehnt
    other = (await editor.post('/collections', { title: 'Ziel-Sammlung', createLink: false })).json.collection;
    expect((await editor.post(`/collections/${other.id}/links`, { folderId: folderA })).status).toBe(400);
    await processAllQuarantine();
    const detail = (await editor.get(`/collections/${col.id}`)).json;
    expect(detail.folders.map((f: any) => f.name).sort()).toEqual(['Drohne Luft', 'Einsatz']);
    expect(detail.media.every((m: any) => m.folder_id === folderB)).toBe(true);
    ids = detail.media.map((m: any) => m.id);
    const audits = (await many<any>(`SELECT action FROM audit_events WHERE object_type = 'folder' AND object_id = ANY($1)`, [[folderA, folderB]])).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['folder.created', 'folder.renamed']));
  });

  it('Schlagworte je Datei und als Sammelaktion, Filter in der Suche', async () => {
    expect((await editor.put(`/media/${ids[0]}/tags`, { tags: ['Drehleiter', ' Nacht ', 'drehleiter'] })).json.tags).toEqual(['drehleiter', 'nacht']);
    expect((await editor.post('/media/tags', { ids, add: ['übung'], remove: ['nacht'] })).json.updated).toBe(2);
    const tags = (await publisher.get('/media-tags')).json.map((t: any) => t.name);
    expect(tags).toEqual(expect.arrayContaining(['drehleiter', 'übung']));
    expect(tags).not.toContain('nacht');
    const s = await publisher.get(`/media/search?tag=${encodeURIComponent('Übung')}&collection=${col.id}`);
    expect(s.json.total).toBe(2);
    expect(s.json.items[0].collection_title).toBe('Ordner-Test');
    expect((await publisher.get(`/media/search?q=HYPERLINK`)).json.items.map((m: any) => m.id)).toHaveLength(1);
    expect((await publisher.get(`/media/search?q=luft&kind=video`)).json.total).toBe(0);
    expect((await publisher.get(`/media/search?perPage=50`)).status).toBe(400);
    const paged = await publisher.get(`/collections?paged=1&q=${encodeURIComponent('Ordner-T')}`);
    expect(paged.json.items.map((c: any) => c.title)).toEqual(['Ordner-Test']);
    expect(paged.json.total).toBe(1);
  });

  it('ZIP mit Ordnerstruktur und metadaten.csv ohne Formel-Injektion; öffentliche Fassung ohne Hochladenden-Angaben', async () => {
    const { buildExport } = await import('../src/media/exports.js');
    const r = await editor.post(`/collections/${col.id}/exports`, { selection: 'folder', folderId: folderA, withCsv: true });
    expect(r.json.files).toBe(2);
    await buildExport(r.json.id);
    const zip = new AdmZip((await editor.get(`/exports/${r.json.id}/download`)).rawPayload);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names.filter((n) => n.startsWith('Einsatz/Drohne Luft/'))).toHaveLength(2);
    const csv = zip.readAsText('metadaten.csv');
    expect(csv).toMatch(/^﻿datei;anzeigename/);
    expect(csv).not.toMatch(/originalname|HYPERLINK/);
    expect(csv).toMatch(/übung/);
    // Originale: Originalname mit Formel wird entschärft
    const r2 = await editor.post(`/collections/${col.id}/exports`, { selection: 'all', variant: 'original', withCsv: true, withFolders: false });
    await buildExport(r2.json.id);
    const csv2 = new AdmZip((await editor.get(`/exports/${r2.json.id}/download`)).rawPayload).readAsText('metadaten.csv');
    expect(csv2).toMatch(/;'=HYPERLINK\(1\)\.jpg;/);
  });

  it('Verschieben behält die ID (Beitrag bleibt gültig), Kopieren übernimmt Datenschutz-Entscheidungen, Kontingent wird geprüft', async () => {
    await editor.patch(`/media/${ids[0]}/privacy`, { flags: ['persons'] });
    const moved = await editor.post('/media/move', { ids: [ids[0]], collectionId: other.id });
    expect(moved.json.moved).toBe(1);
    const m = await one<any>(`SELECT collection_id, folder_id FROM media WHERE id = $1`, [ids[0]]);
    expect(m).toEqual({ collection_id: other.id, folder_id: null });
    expect((await many<any>(`SELECT action FROM audit_events WHERE action = 'media.moved' AND object_id = $1`, [ids[0]])).length).toBe(1);
    const copy = await editor.post('/media/copy', { ids: [ids[0]], collectionId: col.id, folderId: folderA });
    expect(copy.json.copied).toBe(1);
    const c = await one<any>(`SELECT * FROM media WHERE id = $1`, [copy.json.ids[0]]);
    expect(c).toMatchObject({ collection_id: col.id, folder_id: folderA, selection: 'pending', duplicate_of: ids[0], status: 'ready' });
    expect(c.sensitive_flags).toEqual(['persons']);
    expect(fs.existsSync(mediaPaths.original(c.id))).toBe(true);
    expect(fs.existsSync(mediaPaths.publicFile(c.id, 'jpg'))).toBe(true);
    expect((await editor.get(`/collections/${col.id}`)).json.media.find((x: any) => x.id === c.id).tags).toEqual(['drehleiter', 'übung']);
    // Kontingent der Zielsammlung
    await pool.query(`UPDATE collections SET max_files = 1 WHERE id = $1`, [other.id]);
    expect((await editor.post('/media/move', { ids: [ids[1]], collectionId: other.id })).status).toBe(409);
    await pool.query(`UPDATE collections SET archived_at = now() WHERE id = $1`, [other.id]);
    expect((await editor.post('/media/copy', { ids: [ids[1]], collectionId: other.id })).status).toBe(400);
    expect((await publisher.post('/media/move', { ids: [ids[1]], collectionId: col.id })).status).toBe(403);
    // Titelbild frei wählbar
    expect((await editor.patch(`/collections/${col.id}`, { coverMediaId: c.id })).json.cover_media_id).toBe(c.id);
    expect((await editor.patch(`/collections/${col.id}`, { coverMediaId: ids[0] })).status).toBe(400);
  });
});

describe('Medien wie LiFeOS 4: Papierkorb', () => {
  let col: any;
  let media: string[] = [];
  let folder = '';
  let mediaManager: Client;
  it('Datei in den Papierkorb: Dateien bleiben, Wiederherstellen mit „Medien verwalten“, endgültig nur mit „Medien administrieren“', async () => {
    mediaManager = (await acceptInvite('medienpflege@example.org', ['media_manager'], 'Pia')).client;
    const f = await mediaFixture(mediaManager, 'Papierkorb-Test');
    col = f.col;
    for (let i = 0; i < 3; i++) await uploadPublic(f.token, `p${i}.jpg`, await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 30 + i, g: 0, b: 0 } } }).jpeg().toBuffer());
    await processAllQuarantine();
    media = (await mediaManager.get(`/collections/${col.id}`)).json.media.map((m: any) => m.id);
    expect((await mediaManager.raw('DELETE', `/media/${media[0]}`)).status).toBe(200);
    expect(fs.existsSync(mediaPaths.original(media[0]))).toBe(true);
    expect((await mediaManager.get(`/collections/${col.id}`)).json.media.map((m: any) => m.id)).not.toContain(media[0]);
    expect((await publisher.get(`/media/${media[0]}/preview`)).status).toBe(404);
    expect((await mediaManager.get(`/media/${media[0]}/preview`)).status).toBe(200);
    const trash = await mediaManager.get('/trash');
    expect(trash.json.days).toBe(30);
    expect(trash.json.media.find((m: any) => m.id === media[0])).toMatchObject({ deleted_by_name: 'Pia' });
    expect((await publisher.get('/trash')).status).toBe(403);
    expect((await mediaManager.post('/trash/purge', { type: 'media', id: media[0] })).status).toBe(403);
    expect((await mediaManager.post('/trash/restore', { type: 'media', id: media[0] })).status).toBe(200);
    expect((await mediaManager.get(`/collections/${col.id}`)).json.media.map((m: any) => m.id)).toContain(media[0]);
    expect((await many<any>(`SELECT action FROM audit_events WHERE object_id = $1 AND action IN ('media.deleted','media.restored')`, [media[0]])).length).toBe(2);
    // Endgültig: Datensatz und Dateien weg
    await mediaManager.raw('DELETE', `/media/${media[0]}`);
    expect((await admin.post('/trash/purge', { type: 'media', id: media[0] })).status).toBe(200);
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [media[0]])).toBeNull();
    expect(fs.existsSync(mediaPaths.original(media[0]))).toBe(false);
  });

  it('Ordner kommt samt Inhalt in den Papierkorb und zusammen zurück; Links mit Zielordner laden wieder oben', async () => {
    folder = (await mediaManager.post(`/collections/${col.id}/folders`, { name: 'Weg damit' })).json.id;
    const sub = (await mediaManager.post(`/collections/${col.id}/folders`, { name: 'Unter', parentId: folder })).json.id;
    await mediaManager.post('/media/move', { ids: [media[1]], collectionId: col.id, folderId: sub });
    const l = await mediaManager.post(`/collections/${col.id}/links`, { folderId: folder });
    const del = await mediaManager.raw('DELETE', `/folders/${folder}`);
    expect(del.json).toMatchObject({ folders: 2, media: 1 });
    expect((await one<any>(`SELECT folder_id FROM upload_links WHERE id = $1`, [l.json.id])).folder_id).toBeNull();
    const t = (await mediaManager.get('/trash')).json;
    expect(t.folders.map((x: any) => x.name)).toEqual(['Weg damit']);
    expect(t.media.map((x: any) => x.id)).not.toContain(media[1]);
    expect((await mediaManager.post('/trash/restore', { type: 'folder', id: folder })).json.media).toBe(1);
    expect(await one<any>(`SELECT folder_id, deleted_at FROM media WHERE id = $1`, [media[1]])).toEqual({ folder_id: sub, deleted_at: null });
  });

  it('Sammlung in den Papierkorb: Links gesperrt, Wiederherstellen, Löschfrist leert den Papierkorb', async () => {
    const token = (await mediaManager.get(`/collections/${col.id}`)).json.links[0].url.split('/u/')[1];
    expect((await mediaManager.raw('DELETE', `/collections/${col.id}`)).json.trash).toBe(true);
    expect((await anonymous.get(`/public/upload/${token}`)).status).toBe(410);
    expect((await mediaManager.get(`/collections?paged=1&q=Papierkorb-Test`)).json.total).toBe(0);
    expect((await publisher.get(`/collections/${col.id}`)).status).toBe(404);
    expect((await mediaManager.get(`/collections/${col.id}`)).json.collection.deleted_at).toBeTruthy();
    expect((await mediaManager.raw('DELETE', `/collections/${col.id}?permanent=1`)).status).toBe(403);
    expect((await mediaManager.post('/trash/restore', { type: 'collection', id: col.id })).status).toBe(200);
    expect((await anonymous.get(`/public/upload/${token}`)).status).toBe(200);
    // Löschfrist: Datei und Sammlung im Papierkorb, älter als die Frist
    await mediaManager.raw('DELETE', `/media/${media[2]}`);
    await mediaManager.raw('DELETE', `/collections/${col.id}`);
    await pool.query(`UPDATE media SET deleted_at = now() - interval '31 days' WHERE id = $1`, [media[2]]);
    await pool.query(`UPDATE collections SET deleted_at = now() - interval '31 days' WHERE id = $1`, [col.id]);
    const preview = await admin.get('/system/retention');
    expect(preview.json.categories.find((c: any) => c.key === 'trash').count).toBeGreaterThanOrEqual(1);
    await admin.post('/system/retention/run', {});
    expect(await one(`SELECT 1 FROM collections WHERE id = $1`, [col.id])).toBeNull();
    expect(fs.existsSync(mediaPaths.original(media[2]))).toBe(false);
    expect(fs.existsSync(mediaPaths.original(media[1]))).toBe(false);
  });
});

describe('Medien wie LiFeOS 5: Benachrichtigungen', () => {
  it('neue Dateien gebündelt an die Person, die den Link angelegt hat; stummschaltbar', async () => {
    const f = await mediaFixture(editor, 'Hinweis-Test');
    await uploadPublic(f.token, 'n1.jpg', await sharp({ create: { width: 90, height: 60, channels: 3, background: { r: 5, g: 5, b: 200 } } }).jpeg().toBuffer());
    await processAllQuarantine();
    let n = (await editor.get('/notifications')).json.notifications.find((x: any) => x.category === 'media_new' && x.link === `/medien/${f.col.id}`);
    expect(n).toMatchObject({ title: 'Neue Datei in „Hinweis-Test“', count: 1, read: false });
    // Nur für die anlegende Person, nicht für alle mit „Medien verwalten“
    expect((await admin.get('/notifications')).json.notifications.some((x: any) => x.id === n.id)).toBe(false);
    await editor.post('/notifications/read', { ids: [n.id] });
    await uploadPublic(f.token, 'n2.jpg', await sharp({ create: { width: 91, height: 60, channels: 3, background: { r: 5, g: 6, b: 200 } } }).jpeg().toBuffer());
    await processAllQuarantine();
    n = (await editor.get('/notifications')).json.notifications.find((x: any) => x.id === n.id);
    expect(n).toMatchObject({ title: '2 neue Dateien in „Hinweis-Test“', count: 2, read: false });
    // Interne Uploads lösen keinen Hinweis aus
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE category = 'media_new' AND link = $1`, [`/medien/${f.col.id}`])).n).toBe(1);
    expect((await editor.patch('/auth/preferences', { mutedNotifications: ['media_new'] })).status).toBe(200);
    expect((await editor.get('/notifications')).json.notifications.some((x: any) => x.category === 'media_new')).toBe(false);
    expect((await editor.patch('/auth/preferences', { mutedNotifications: ['erfunden'] })).status).toBe(400);
    await editor.patch('/auth/preferences', { mutedNotifications: [] });
  });

  it('Kontingent erreicht, Link läuft bald ab (einmal), Speicher knapp nur für „Medien administrieren“', async () => {
    const { checkExpiringLinks, checkStorage } = await import('../src/lib/media-notify.js');
    const f = await mediaFixture(editor, 'Kontingent-Test', { maxFiles: 1, hours: 48 });
    expect((await uploadPublic(f.token, 'k1.jpg', await sharp({ create: { width: 92, height: 60, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer())).status).toBe(200);
    const quota = (await editor.get('/notifications')).json.notifications.find((x: any) => x.title === 'Upload-Link voll: „Kontingent-Test“');
    expect(quota).toBeTruthy();
    // 48-h-Link: Hinweis ab 12 h Restlaufzeit (ein Viertel), hier 30 Minuten vor Ablauf
    await pool.query(`UPDATE upload_links SET expires_at = now() + interval '30 minutes' WHERE id = $1`, [f.link.id]);
    await checkExpiringLinks();
    await checkExpiringLinks();
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE group_key = $1`, [`media:expiring:${f.link.id}`])).n).toBe(1);
    // Verlängern setzt den Hinweis zurück
    await editor.post(`/upload-links/${f.link.id}/extend`, { hours: 24 });
    expect((await one<any>(`SELECT expiring_notified_at FROM upload_links WHERE id = $1`, [f.link.id])).expiring_notified_at).toBeNull();
    await setSettings({ 'media.storage_warn_gb': 100000 });
    await checkStorage();
    await checkStorage();
    expect((await one<any>(`SELECT count(*)::int AS n, max(count) AS c FROM notifications WHERE group_key = 'media:storage'`))).toMatchObject({ n: 1 });
    expect((await admin.get('/notifications')).json.notifications.some((x: any) => x.category === 'media_storage')).toBe(true);
    expect((await editor.get('/notifications')).json.notifications.some((x: any) => x.category === 'media_storage')).toBe(false);
    await setSettings({ 'media.storage_warn_gb': 10 });
  });
});

describe('Medien wie LiFeOS 6: Erweiterte Link-Optionen', () => {
  const jpeg = (r: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g: 33, b: 77 } } }).jpeg().toBuffer();
  const session = (c: Client, token: string, body: Record<string, unknown>) =>
    c.post(`/public/upload/${token}/sessions`, { clientKey: `s-${crypto.randomBytes(6).toString('hex')}`, name: 'foto.jpg', size: 1000, type: 'image/jpeg', ...body });

  it('abgefragte Angaben (aus/optional/Pflicht) und Bestätigung; Datenschutzsuche, Löschen je Link und Löschfrist', async () => {
    const f = await mediaFixture(editor, 'Angaben-Test', { fields: { name: 'required', email: 'optional', note: 'off' }, consentRequired: true, consentText: 'Ich habe die Fotos selbst gemacht.' });
    expect(f.link.fields).toMatchObject({ name: 'required', email: 'optional', note: 'off', place: 'off' });
    const info = await anonymous.get(`/public/upload/${f.token}`);
    expect(info.json).toMatchObject({ consent_required: true, consent_text: 'Ich habe die Fotos selbst gemacht.', uploader_months: 12 });
    expect((await session(anonymous, f.token, { consent: true })).json.message).toMatch(/Name/);
    expect((await session(anonymous, f.token, { uploader: { name: 'Erika Beispiel' } })).json.message).toMatch(/Bestätigung/);
    expect((await session(anonymous, f.token, { uploader: { name: 'Erika Beispiel', email: 'kaputt' }, consent: true })).status).toBe(400);
    // Abgeschaltete Felder (Hinweis, Ort) werden verworfen
    const mp = multipart({ name: 'mit-angaben.jpg', data: await jpeg(1), type: 'image/jpeg' }, { clientKey: 'angaben-0001', name: 'Erika Beispiel', email: 'erika@example.org', place: 'Marktplatz', note: 'geheim', consent: 'true', ref: 'ABCD-EFGH' });
    expect((await anonymous.raw('POST', `/public/upload/${f.token}`, mp)).status).toBe(200);
    const m = await one<any>(`SELECT * FROM media WHERE client_key = 'angaben-0001'`);
    expect(m.uploader).toEqual({ name: 'Erika Beispiel', email: 'erika@example.org' });
    expect(m.uploader_note).toBe('');
    expect(m.consent_at).not.toBeNull();
    await processAllQuarantine();
    expect((await editor.get(`/media/${m.id}/details`)).json.uploader.name).toBe('Erika Beispiel');
    expect((await publisher.get(`/media/${m.id}/details`)).json.uploader).toBeNull();
    const hit = (await admin.get(`/privacy/search?q=erika%40example.org`)).json.hits.find((h: any) => h.id === m.id);
    expect(hit.fields).toMatchObject({ name: 'Erika Beispiel', email: 'erika@example.org' });
    // Löschfrist: nach privacy.uploader_months werden die Angaben entfernt, die Datei bleibt
    await pool.query(`UPDATE media SET created_at = now() - interval '13 months' WHERE id = $1`, [m.id]);
    const preview = await admin.get('/system/retention');
    expect(preview.json.categories.find((c: any) => c.key === 'uploader').count).toBeGreaterThanOrEqual(1);
    await admin.post('/system/retention/run', {});
    expect(await one<any>(`SELECT uploader, deleted_at FROM media WHERE id = $1`, [m.id])).toEqual({ uploader: null, deleted_at: null });
    await pool.query(`UPDATE media SET uploader = '{"name":"X"}', created_at = now() WHERE id = $1`, [m.id]);
    expect((await editor.post(`/upload-links/${f.link.id}/clear-uploader`)).json.media).toBe(1);
    expect((await one<any>(`SELECT uploader FROM media WHERE id = $1`, [m.id])).uploader).toBeNull();
  });

  it('Passwort: Seite erst nach Eingabe, Freigabe nur für diesen Link, neues Passwort beendet Freigaben', async () => {
    const f = await mediaFixture(editor, 'Passwort-Test', { password: 'kurz' }).catch(() => null);
    expect(f).toBeNull();
    const g = await mediaFixture(editor, 'Passwort-Test', { password: 'Sommerfest-2026' });
    expect(g.link.has_password).toBe(true);
    const visitor = new Client(app, '10.20.0.9');
    const locked = await visitor.get(`/public/upload/${g.token}`);
    expect(locked.status).toBe(401);
    expect(locked.json.error).toBe('password_required');
    expect(JSON.stringify(locked.json)).not.toContain('Passwort-Test');
    expect((await session(visitor, g.token, {})).status).toBe(401);
    expect((await visitor.post(`/public/upload/${g.token}/unlock`, { password: 'falsch-falsch' })).status).toBe(401);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'upload_link.password_failed' AND object_id = $1`, [g.link.id])).not.toBeNull();
    expect((await visitor.post(`/public/upload/${g.token}/unlock`, { password: 'Sommerfest-2026' })).status).toBe(200);
    expect((await visitor.get(`/public/upload/${g.token}`)).status).toBe(200);
    expect((await session(visitor, g.token, {})).status).toBe(200);
    await editor.patch(`/upload-links/${g.link.id}`, { password: 'Neues-Passwort-2026' });
    expect((await visitor.get(`/public/upload/${g.token}`)).status).toBe(401);
    await editor.patch(`/upload-links/${g.link.id}`, { removePassword: true });
    expect((await new Client(app).get(`/public/upload/${g.token}`)).status).toBe(200);
  });

  it('Grenzen je Link: Dateien je Upload, Uploads, Gesamtgröße, schließen bei Grenze; erlaubte Typen je Link', async () => {
    const f = await mediaFixture(editor, 'Grenzen-Test', { maxFilesPerUpload: 1, maxUploads: 2, closeWhenFull: false });
    expect((await session(anonymous, f.token, { ref: 'AAAA-AAAA' })).status).toBe(200);
    const second = await session(anonymous, f.token, { ref: 'AAAA-AAAA' });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('upload_full');
    expect((await session(anonymous, f.token, { ref: 'BBBB-BBBB' })).status).toBe(200);
    const third = await session(anonymous, f.token, { ref: 'CCCC-CCCC' });
    expect(third.json.error).toBe('link_full');
    expect((await anonymous.get(`/public/upload/${f.token}`)).json.remaining_uploads).toBe(0);
    // „Schließen bei Grenze“: der Link gilt dann als voll und die Seite ist nicht mehr erreichbar
    await editor.patch(`/upload-links/${f.link.id}`, { closeWhenFull: true });
    expect((await anonymous.get(`/public/upload/${f.token}`)).status).toBe(410);
    expect((await editor.get(`/collections/${f.col.id}`)).json.links[0].state).toBe('full');
    expect((await session(anonymous, f.token, { ref: 'DDDD-DDDD' })).status).toBe(410);
    // Gesamtgröße
    const g = await mediaFixture(editor, 'Gesamtgröße-Test', { maxTotalMb: 1 });
    expect((await session(anonymous, g.token, { size: 900_000 })).status).toBe(200);
    expect((await session(anonymous, g.token, { size: 300_000 })).json.error).toBe('link_full');
    // Erlaubte Typen je Link: nur PNG → JPEG wird bei der Prüfung abgewiesen; accept passt sich an
    const h = await mediaFixture(editor, 'Typen-Test', { allowedTypes: ['png'] });
    expect(h.link.allowed_types).toEqual(['png']);
    expect((await anonymous.get(`/public/upload/${h.token}`)).json).toMatchObject({ accept: 'image/png', types: 'PNG' });
    await uploadPublic(h.token, 'falsch.jpg', await jpeg(2));
    await processAllQuarantine();
    const bad = await one<any>(`SELECT status, reject_reason FROM media WHERE upload_link_id = $1`, [h.link.id]);
    expect(bad.status).not.toBe('ready');
    expect(bad.reject_reason).toMatch(/JPEG ist für diesen Upload nicht erlaubt.*PNG/);
    expect((await editor.post(`/collections/${h.col.id}/links`, { allowedTypes: ['exe'] })).status).toBe(400);
    expect((await admin.patch('/settings', { 'media.allowed_types': [] })).status).toBe(400);
  });
});

describe('Medien wie LiFeOS 7: gesperrte Dateien, Sicherheitsereignisse, Aufträge, „Medien administrieren“', () => {
  it('gesperrte Datei bleibt in der Quarantäne; erneut prüfen und endgültig löschen nur mit „Medien administrieren“', async () => {
    const f = await mediaFixture(editor, 'Sperr-Test');
    const mp = multipart({ name: 'kein-bild.jpg', data: Buffer.from('#!/bin/sh\necho kein Bild\n'), type: 'image/jpeg' }, { clientKey: 'sperr-0001' });
    expect((await anonymous.raw('POST', `/public/upload/${f.token}`, mp)).status).toBe(200);
    await processAllQuarantine();
    const m = await one<any>(`SELECT * FROM media WHERE client_key = 'sperr-0001'`);
    expect(m).toMatchObject({ status: 'blocked', reject_step: 'type' });
    expect(fs.existsSync(mediaPaths.quarantine(m.id))).toBe(true);
    expect((await editor.get(`/media/${m.id}/preview`)).status).toBe(404);
    const ev = await one<any>(`SELECT * FROM public_security_events WHERE event = 'file_rejected' AND media_id = $1`, [m.id]);
    expect(ev.link_id).toBe(f.link.id);
    // Rechte: Redaktion/Medienverwaltung haben „Medien administrieren“ nicht
    expect((await editor.post(`/media/${m.id}/recheck`)).status).toBe(403);
    expect((await editor.get('/media-admin/blocked')).status).toBe(403);
    expect((await admin.get('/media-admin/blocked')).json.find((x: any) => x.id === m.id)).toMatchObject({ reject_step: 'type', file_present: true, collection_title: 'Sperr-Test' });
    // Trotzdem freigeben nur bei reinem Dekodierbefund
    expect((await admin.post(`/media/${m.id}/force-release`, { reason: 'Test der Sperre' })).status).toBe(400);
    expect((await admin.post(`/media/${m.id}/recheck`)).status).toBe(200);
    expect((await one<any>(`SELECT status FROM media WHERE id = $1`, [m.id])).status).toBe('quarantine');
    expect(await processMedia(m.id)).toBe('blocked');
    expect((await admin.post('/media-admin/recheck-all')).json.count).toBeGreaterThanOrEqual(1);
    await processAllQuarantine();
    // Fehlgeschlagener Auftrag lässt sich wiederholen
    const job = await one<any>(`INSERT INTO jobs (kind, payload, status, attempts, last_error) VALUES ('media.process', $1, 'dead', 5, 'Testfehler') RETURNING id`, [JSON.stringify({ mediaId: m.id })]);
    expect((await admin.get('/media-admin/jobs')).json.some((j: any) => j.id === job.id)).toBe(true);
    expect((await admin.post(`/media-admin/jobs/${job.id}/retry`)).status).toBe(200);
    expect((await one<any>(`SELECT status, attempts FROM jobs WHERE id = $1`, [job.id]))).toEqual({ status: 'queued', attempts: 0 });
    await pool.query(`DELETE FROM jobs WHERE id = $1`, [job.id]);
    await pool.query(`UPDATE media SET status = 'blocked' WHERE id = $1`, [m.id]);
    expect((await admin.post(`/media/${m.id}/purge`)).status).toBe(200);
    expect(await one(`SELECT 1 FROM media WHERE id = $1`, [m.id])).toBeNull();
    expect(fs.existsSync(mediaPaths.quarantine(m.id))).toBe(false);
  });

  it('„Trotzdem freigeben“ nur für Videos mit Dekodierbefund – mit Begründung, Audit und Sicherheitsmeldung', async () => {
    const f = await mediaFixture(editor, 'Freigabe-Test');
    const m = await one<any>(
      `INSERT INTO media (collection_id, upload_link_id, original_name, declared_type, size_bytes, sha256, status, reject_step, reject_reason, processed_at)
       VALUES ($1,$2,'drohne.mp4','video/mp4',32,$3,'blocked','decode','Video nicht fehlerfrei dekodierbar',now()) RETURNING id`,
      [f.col.id, f.link.id, crypto.randomBytes(32).toString('hex')],
    );
    // minimale MP4-Kennung (ftyp-Box)
    fs.mkdirSync(path.dirname(mediaPaths.quarantine(m.id)), { recursive: true });
    fs.writeFileSync(mediaPaths.quarantine(m.id), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2mp41'), Buffer.alloc(16)]));
    expect((await admin.post(`/media/${m.id}/force-release`, { reason: 'x' })).status).toBe(400);
    expect((await admin.post(`/media/${m.id}/force-release`, { reason: 'Eigene Drohne, Wiedergabe geprüft' })).status).toBe(200);
    expect(await one<any>(`SELECT status, skip_decode, released_at IS NOT NULL AS released FROM media WHERE id = $1`, [m.id])).toEqual({ status: 'quarantine', skip_decode: true, released: true });
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'media.force_released' AND object_id = $1`, [m.id])).not.toBeNull();
    expect(await one(`SELECT 1 FROM public_security_events WHERE event = 'force_released' AND media_id = $1`, [m.id])).not.toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Video trotz Prüfbefund freigegeben%'`)).not.toBeNull();
    await pool.query(`DELETE FROM jobs WHERE payload->>'mediaId' = $1`, [m.id]);
    await pool.query(`UPDATE media SET status = 'blocked' WHERE id = $1`, [m.id]);
  });

  it('Sicherheitsereignisse der Upload-Seiten: ungültige Links, Passwort, Rate-Limit – ohne Klar-IP; Löschfrist', async () => {
    const { resetSecurityEventThrottle } = await import('../src/lib/public-security.js');
    resetSecurityEventThrottle();
    const f = await mediaFixture(editor, 'Ereignis-Test', { password: 'Ereignis-Passwort-1' });
    await editor.post(`/upload-links/${f.link.id}/pause`);
    const visitor = new Client(app, '10.77.0.5');
    expect((await visitor.get(`/public/upload/${f.token}`)).status).toBe(410);
    expect((await visitor.get(`/public/upload/${f.token}`)).status).toBe(410);
    const hits = await many<any>(`SELECT * FROM public_security_events WHERE event = 'link_unavailable_hit' AND link_id = $1`, [f.link.id]);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toBe('pausiert');
    expect(hits[0].ip_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(hits)).not.toContain('10.77.0.5');
    await editor.post(`/upload-links/${f.link.id}/resume`);
    for (let i = 0; i < 11; i++) await visitor.post(`/public/upload/${f.token}/unlock`, { password: `falsch-${i}` });
    await new Promise((r) => setTimeout(r, 200));
    const kinds = (await many<any>(`SELECT DISTINCT event FROM public_security_events WHERE link_id = $1`, [f.link.id])).map((r) => r.event);
    expect(kinds).toEqual(expect.arrayContaining(['link_unavailable_hit', 'password_failed', 'rate_limited']));
    const list = await admin.get(`/media-admin/security-events?link=${f.link.id}`);
    expect(list.json.items[0]).toMatchObject({ link_label: '', collection_title: 'Ereignis-Test' });
    expect((await editor.get('/media-admin/security-events')).status).toBe(403);
    await pool.query(`UPDATE public_security_events SET at = now() - interval '400 days' WHERE link_id = $1`, [f.link.id]);
    await admin.post('/system/retention/run', {});
    expect(await one(`SELECT 1 FROM public_security_events WHERE link_id = $1`, [f.link.id])).toBeNull();
  });
});

describe('Medien wie LiFeOS 8: Prüftiefe und Formate', () => {
  const upload = async (token: string, name: string, data: Buffer, type: string) => {
    const mp = multipart({ name, data, type }, { clientKey: `fmt-${crypto.randomBytes(6).toString('hex')}` });
    expect((await anonymous.raw('POST', `/public/upload/${token}`, mp)).status).toBe(200);
    await processAllQuarantine();
    return one<any>(`SELECT * FROM media WHERE original_name = $1 ORDER BY created_at DESC LIMIT 1`, [name]);
  };

  it('AVIF und unbewegtes GIF werden geprüft und umgerechnet; animierte Bilder nur mit Einstellung; Pixelgrenze einstellbar', async () => {
    const f = await mediaFixture(editor, 'Formate-Test');
    const avif = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 0, g: 140, b: 70 } } }).avif().toBuffer();
    const a = await upload(f.token, 'bild.avif', avif, 'image/avif');
    expect(a).toMatchObject({ status: 'ready', mime: 'image/avif', width: 120, has_public: true });
    const gif = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 0, b: 0 } } }).gif().toBuffer();
    expect((await upload(f.token, 'still.gif', gif, 'image/gif')).status).toBe('ready');
    // Animiertes GIF (zwei Bilder)
    const frame = (r: number) => sharp({ create: { width: 30, height: 20, channels: 3, background: { r, g: 0, b: 0 } } }).raw().toBuffer();
    const anim = await sharp(Buffer.concat([await frame(10), await frame(250)]), { raw: { width: 30, height: 40, channels: 3, pageHeight: 20 } } as any).gif({ loop: 0 }).toBuffer();
    const blocked = await upload(f.token, 'anim.gif', anim, 'image/gif');
    expect(blocked).toMatchObject({ status: 'blocked', reject_step: 'type' });
    expect(blocked.reject_reason).toMatch(/Animierte Bilder/);
    await setSettings({ 'media.allow_animated': true });
    expect((await upload(f.token, 'anim2.gif', anim, 'image/gif')).status).toBe('ready');
    await setSettings({ 'media.allow_animated': false, 'media.max_image_mp': 1 });
    const big = await sharp({ create: { width: 1500, height: 1000, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
    const b = await upload(f.token, 'gross.jpg', big, 'image/jpeg');
    expect(b).toMatchObject({ status: 'blocked', reject_step: 'limits' });
    expect(b.reject_reason).toMatch(/1 Megapixel/);
    await setSettings({ 'media.max_image_mp': 40 });
    expect((await admin.patch('/settings', { 'media.max_image_mp': 0 })).status).toBe(400);
  });

  it('Video-Dekodierprüfung: beschädigtes Video wird gesperrt, „Trotzdem freigeben“ verarbeitet es ohne Dekodierprüfung; 3GP', async () => {
    const f = await mediaFixture(editor, 'Video-Prüftiefe');
    const dir = fs.mkdtempSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'dec-'));
    const src = path.join(dir, 'ok.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=25', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', src]);
    const data = fs.readFileSync(src);
    // Mitte der Bilddaten überschreiben: Aufbau bleibt lesbar, Dekodieren meldet Fehler
    for (let i = Math.floor(data.length * 0.45); i < Math.floor(data.length * 0.6); i += 7) data[i] = 0xff;
    const bad = await upload(f.token, 'kaputt.mp4', data, 'video/mp4');
    expect(bad).toMatchObject({ status: 'blocked', reject_step: 'decode' });
    expect((await admin.post(`/media/${bad.id}/force-release`, { reason: 'Wiedergabe von Hand geprüft' })).status).toBe(200);
    expect(await processMedia(bad.id)).toBe('ready');
    // 3GP mit H.264/AAC
    const g = path.join(dir, 'clip.3gp');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=176x144:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', '3gp', g]);
    expect((await upload(f.token, 'clip.3gp', fs.readFileSync(g), 'video/3gpp')).status).toBe('ready');
    // Längere Kante begrenzt
    await setSettings({ 'media.max_video_edge': 320 });
    const wide = path.join(dir, 'breit.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=640x360:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', wide]);
    expect(await upload(f.token, 'breit.mp4', fs.readFileSync(wide), 'video/mp4')).toMatchObject({ status: 'blocked', reject_step: 'limits' });
    await setSettings({ 'media.max_video_edge': 7680 });
  });
});

describe('Medien wie LiFeOS 9: Speicherübersicht, Frist und Höchstgröße der ZIP-Downloads', () => {
  it('zeigt Verbrauch je Art, Sammlung und Ordner, Papierkorb, Quarantäne und freien Platz – nur für „Medien administrieren“', async () => {
    const st = await admin.get('/media-admin/storage');
    expect(st.status).toBe(200);
    expect(st.json.ready.files).toBeGreaterThan(0);
    expect(st.json.by_kind.map((k: any) => k.kind)).toContain('image');
    expect(st.json.by_collection.length).toBeGreaterThan(0);
    expect(st.json).toHaveProperty('trash');
    expect(st.json).toHaveProperty('blocked');
    expect(st.json.warn_gb).toBe(10);
    const col = st.json.by_collection.find((c: any) => c.title === 'Ordner-Test');
    const detail = await admin.get(`/media-admin/storage?collection=${col.id}`);
    expect(detail.json.folders.map((f: any) => f.name)).toEqual(expect.arrayContaining(['Einsatz']));
    expect((await editor.get('/media-admin/storage')).status).toBe(403);
  });

  it('ZIP: Verfügbarkeit in Stunden und Höchstgröße einstellbar', async () => {
    const f = await mediaFixture(editor, 'ZIP-Grenzen');
    await uploadPublic(f.token, 'z.jpg', await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 3, g: 4, b: 5 } } }).jpeg().toBuffer());
    await processAllQuarantine();
    await setSettings({ 'media.export_hours': 2 });
    const ex = await editor.post(`/collections/${f.col.id}/exports`, { selection: 'all' });
    const row = await one<any>(`SELECT expires_at FROM exports WHERE id = $1`, [ex.json.id]);
    expect(Math.abs(new Date(row.expires_at).getTime() - (Date.now() + 2 * 3600_000))).toBeLessThan(60_000);
    await setSettings({ 'media.export_hours': 24, 'media.export_max_gb': 1 });
    await pool.query(`UPDATE media SET size_bytes = 2147483648 WHERE collection_id = $1`, [f.col.id]);
    const big = await editor.post(`/collections/${f.col.id}/exports`, { selection: 'all' });
    expect(big.status).toBe(400);
    expect(big.json.message).toMatch(/größer als 1 GB/);
    await setSettings({ 'media.export_max_gb': 20 });
  });
});

describe('Medien wie LiFeOS 10: Gestaltung der Upload-Seite', () => {
  let imageId = '';
  it('Bilder werden neu kodiert (ohne Standort) und öffentlich nur über ihre ID ausgeliefert', async () => {
    const up = multipart({ name: 'logo.jpg', data: await photoWithGps(), type: 'image/jpeg' });
    expect((await publisher.raw('POST', '/media/design-images', up)).status).toBe(403);
    const r = await editor.raw('POST', '/media/design-images', up);
    expect(r.status).toBe(200);
    imageId = r.json.id;
    const img = await anonymous.get(`/public/design-images/${imageId}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(img.rawPayload).metadata()).exif).toBeUndefined();
    const bad = multipart({ name: 'x.jpg', data: Buffer.from('kein Bild'), type: 'image/jpeg' });
    expect((await editor.raw('POST', '/media/design-images', bad)).status).toBe(400);
  });

  it('Standard nur mit „Medien administrieren“, Prüfung der Bausteine, Platzhalter, je Link überschreibbar', async () => {
    const def = await editor.get('/media/design');
    expect(def.json.design).toEqual({ accent: 'rot', header: true, blocks: [{ type: 'welcome' }, { type: 'upload' }] });
    const design = {
      accent: 'blau',
      header: false,
      blocks: [
        { type: 'banner', image: imageId, alt: 'Fahrzeughalle', height: 'l' },
        { type: 'heading', text: 'Fotos vom {thema} am {datum}', size: 'l' },
        { type: 'text', text: '<script>alert(1)</script>\nZweite Zeile' },
        { type: 'upload' },
      ],
    };
    expect((await editor.put('/media/design', { design })).status).toBe(403);
    expect((await admin.put('/media/design', { design: { ...design, blocks: [...design.blocks, { type: 'upload' }] } })).status).toBe(400);
    expect((await admin.put('/media/design', { design: { ...design, accent: '#ff00ff' } })).status).toBe(400);
    expect((await admin.put('/media/design', { design: { ...design, blocks: [{ type: 'banner', image: crypto.randomUUID() }, { type: 'upload' }] } })).status).toBe(400);
    expect((await admin.put('/media/design', { design: { ...design, blocks: [{ type: 'iframe', src: 'x' }, { type: 'upload' }] } })).status).toBe(400);
    expect((await admin.put('/media/design', { design })).status).toBe(200);
    expect((await admin.patch('/settings', { 'media.upload_design': null })).status).toBe(400);
    const col = (await editor.post('/collections', { title: 'Sommerfest', createLink: true, eventDate: '2026-07-04' })).json;
    const token = col.link.url.split('/u/')[1];
    const info = (await anonymous.get(`/public/upload/${token}`)).json;
    expect(info.design.accent).toBe('blau');
    expect(info.design.blocks[1].text).toBe('Fotos vom Sommerfest am 04.07.2026');
    // Texte bleiben Text (die Oberfläche stellt sie nie als HTML dar)
    expect(info.design.blocks[2].text).toBe('<script>alert(1)</script>\nZweite Zeile');
    // Eigene Gestaltung je Link durch „Medien verwalten“
    const own = { accent: 'gruen', header: true, blocks: [{ type: 'upload' }, { type: 'note', text: 'Danke!', style: 'info' }] };
    expect((await editor.put(`/upload-links/${col.link.id}/design`, { design: own })).status).toBe(200);
    expect((await anonymous.get(`/public/upload/${token}`)).json.design).toMatchObject({ accent: 'gruen', header: true });
    expect((await editor.get(`/upload-links/${col.link.id}/design`)).json.own.accent).toBe('gruen');
    expect((await editor.put(`/upload-links/${col.link.id}/design`, { design: null })).status).toBe(200);
    expect((await anonymous.get(`/public/upload/${token}`)).json.design.accent).toBe('blau');
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'design.updated'`)).not.toBeNull();
    // Nicht verwendete Bilder (älter als ein Tag) räumt der Hintergrunddienst auf; verwendete bleiben
    const { cleanupDesignImages } = await import('../src/routes/media-design.js');
    const unused = (await editor.raw('POST', '/media/design-images', multipart({ name: 'u.png', data: await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), type: 'image/png' }))).json.id;
    await pool.query(`UPDATE design_images SET created_at = now() - interval '2 days'`);
    await cleanupDesignImages();
    expect(await one(`SELECT 1 FROM design_images WHERE id = $1`, [unused])).toBeNull();
    expect(await one(`SELECT 1 FROM design_images WHERE id = $1`, [imageId])).not.toBeNull();
    await admin.put('/media/design', { design: null });
  });
});

describe('In-App-Updates aus GitHub-Releases', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-upd-it-'));
  const key = crypto.generateKeyPairSync('ed25519');
  const otherKey = crypto.generateKeyPairSync('ed25519');
  const pubFile = path.join(work, 'test.pub');
  fs.writeFileSync(pubFile, key.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64') + '\n');
  const lock = { name: 'blaulichtcms', lockfileVersion: 3, packages: { '': {}, server: { dependencies: { dummy: '^1' } }, 'node_modules/dummy': { version: '1.0.0', integrity: 'sha512-dummy' } } };
  // „Laufender Code“ für Abhängigkeiten: kleine package-lock.json und node_modules statt des ganzen Repositorys
  const runtime = path.join(work, 'runtime');
  fs.mkdirSync(path.join(runtime, 'node_modules', 'dummy'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node_modules', 'dummy', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(runtime, 'package-lock.json'), JSON.stringify(lock));

  type Release = { version: string; zip: Buffer; sha: string; sig: string; notes: string };
  function buildRelease(version: string, opts: { minImage?: string; lock?: unknown; signWith?: crypto.KeyObject; cliOutput?: string; versionFile?: string } = {}): Release {
    const z = new AdmZip();
    const add = (name: string, data: string | Buffer) => z.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    add('VERSION', `${opts.versionFile ?? version}\n`);
    add('manifest.json', JSON.stringify({ name: 'blaulichtcms', version, minImageVersion: opts.minImage ?? '0.1.0', requires: { nodeMajor: 24, postgresMajor: 18 } }));
    add('package.json', '{"name":"blaulichtcms","private":true}');
    add('package-lock.json', JSON.stringify(opts.lock ?? lock));
    add('server/package.json', '{"name":"@blaulichtcms/server"}');
    add('server/update-signing-key.pub', fs.readFileSync(pubFile));
    for (const f of ['api', 'worker', 'main']) add(`server/dist/${f}.js`, '// Testpaket\n');
    add('server/dist/cli.js', `console.log(${JSON.stringify(opts.cliOutput ?? `ok ${version}`)});\n`);
    add('server/migrations/001_grundstand.sql', 'SELECT 1;\n');
    add('web/package.json', '{"name":"@blaulichtcms/web"}');
    add('web/dist/index.html', '<!doctype html><title>Test</title>');
    add('wordpress-plugin/blaulichtcms-bridge/blaulichtcms-bridge.php', '<?php\n');
    const zip = z.toBuffer();
    const sha = crypto.createHash('sha256').update(zip).digest('hex');
    const sig = crypto.sign(null, Buffer.from(`BlaulichtCMS-Update-Signatur v1\n${sha}`), opts.signWith ?? key.privateKey).toString('base64');
    // Versionshinweise wie von scripts/build-release.mjs: der Satz zur Mindestversion des Images steht am Ende
    const notes = `## Neu\n\n- Testeintrag${opts.minImage ? `\n\n---\n\nInstallation: Einstellungen → Updates (signiert). Neue Image-Basis nötig ab Mindestversion ${opts.minImage}.` : ''}`;
    return { version, zip, sha, sig: `# Signatur\n${sig}\n`, notes };
  }

  // Stellvertreter der GitHub-API: releases/latest, Asset-API mit 302 auf einen „Speicher“-Pfad
  let mode: 'none' | 'release' = 'none';
  let release: Release | null = null;
  const seen: { path: string; auth: string | null; accept: string | null }[] = [];
  const fake = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: (req.headers.authorization as string) ?? null, accept: (req.headers.accept as string) ?? null });
    const url = req.url ?? '';
    if (url === '/repos/beispiel/blaulichtcms/releases/latest') {
      if (mode === 'none' || !release) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not Found"}');
      const name = `blaulichtcms-update-v${release.version}.zip`;
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          tag_name: `v${release.version}`,
          name: `BlaulichtCMS ${release.version}`,
          body: release.notes,
          published_at: '2026-11-15T10:00:00Z',
          html_url: 'https://github.com/beispiel/blaulichtcms/releases/tag/v' + release.version,
          assets: [
            { id: 11, name, size: release.zip.length },
            { id: 12, name: `${name}.sha256`, size: 100 },
            { id: 13, name: `${name}.sig`, size: 120 },
          ],
        }),
      );
    }
    const asset = /^\/repos\/beispiel\/blaulichtcms\/releases\/assets\/(\d+)$/.exec(url);
    if (asset) return res.writeHead(302, { location: `/speicher/${asset[1]}?signiert=1` }).end();
    const store = /^\/speicher\/(\d+)\?signiert=1$/.exec(url);
    if (store && release) {
      const name = `blaulichtcms-update-v${release.version}.zip`;
      const body = store[1] === '11' ? release.zip : store[1] === '12' ? Buffer.from(`${release.sha}  ${name}\n`) : Buffer.from(release.sig);
      return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
    }
    res.writeHead(404).end();
  });
  let apiUrl = '';
  const sent: unknown[] = [];

  beforeAll(async () => {
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    apiUrl = `http://127.0.0.1:${(fake.address() as any).port}`;
    process.env.BLAULICHTCMS_TEST_UPDATE_PUBKEY = pubFile;
    process.env.BLAULICHTCMS_TEST_UPDATE_RUNTIME_ROOT = runtime;
  });
  afterAll(async () => {
    const { setActivationSenderForTests } = await import('../src/updates/installer.js');
    setActivationSenderForTests(null);
    delete process.env.BLAULICHTCMS_TEST_UPDATE_PUBKEY;
    delete process.env.BLAULICHTCMS_TEST_UPDATE_RUNTIME_ROOT;
    await new Promise((r) => fake.close(r));
  });

  const base = () => ({ enabled: true, repo: 'beispiel/blaulichtcms', apiUrl, checkHours: 6 });

  it('Einstellungen: eigene Seite, Bestätigung, Prüfung, Token optional und nie in Antworten', async () => {
    const info = await admin.get('/updates');
    expect(info.status).toBe(200);
    expect(info.json.settings).toEqual({ enabled: true, repo: 'thisislennard/BlaulichtCMS', apiUrl: 'https://api.github.com', checkHours: 6, tokenSet: false });
    expect(info.json.current).toBe(config.version);
    expect(info.json.signingKey).toBe('ok');
    // Nicht über die allgemeinen Einstellungen
    expect(Object.keys((await admin.get('/settings')).json.settings).some((k) => k.startsWith('updates.'))).toBe(false);
    expect((await admin.patch('/settings', { 'updates.repo': 'x/y' })).status).toBe(400);
    // Ohne frische Bestätigung keine Änderung
    const adminId = (await admin.get('/auth/me')).json.user.id;
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE user_id = $1`, [adminId]);
    expect((await admin.put('/updates/settings', { ...base(), apiUrl: 'https://api.github.com', checkHours: 12 })).json.error).toBe('reauth_required');
    // Unverändert speichern braucht keine Bestätigung
    expect((await admin.put('/updates/settings', { enabled: true, repo: 'thisislennard/BlaulichtCMS', apiUrl: 'https://api.github.com', checkHours: 6 })).status).toBe(200);
    expect((await admin.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    for (const bad of [{ repo: 'ohne-schraegstrich' }, { repo: 'a/b/c' }, { checkHours: 0 }, { checkHours: 169 }, { apiUrl: 'http://api.github.com' }, { apiUrl: 'https://nutzer:pw@api.github.com' }, { token: 'mit leerzeichen' }]) {
      expect((await admin.put('/updates/settings', { ...base(), apiUrl: 'https://api.github.com', ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    // Öffentliches Repository: ohne Token speicherbar
    expect((await admin.put('/updates/settings', { enabled: true, repo: 'thisislennard/BlaulichtCMS', apiUrl: 'https://api.github.com', checkHours: 12 })).json.tokenSet).toBe(false);
    // Token speichern: verschlüsselt, nie zurückgegeben
    const token = 'ghp_TestTokenNurFuerDieIntegration0123456789';
    const r = await admin.put('/updates/settings', { enabled: true, repo: 'thisislennard/BlaulichtCMS', apiUrl: 'https://api.github.com', checkHours: 12, token });
    expect(r.json).toMatchObject({ ok: true, tokenSet: true });
    const after = await admin.get('/updates');
    expect(after.json.settings.tokenSet).toBe(true);
    expect(JSON.stringify(after.json)).not.toContain(token);
    expect(JSON.stringify((await admin.get('/settings')).json)).not.toContain(token);
    const sid = (await one<any>(`SELECT value FROM settings WHERE key = 'updates.token_secret_id'`))!.value;
    const sec = (await one<any>(`SELECT ciphertext FROM secrets WHERE id = $1`, [sid]))!;
    expect(sec.ciphertext).not.toContain(token);
    // Audit: Änderungen ja, Token nie
    const ev = await many<any>(`SELECT details FROM audit_events WHERE action = 'updates.settings_changed' ORDER BY id`);
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(ev)).not.toContain(token);
    expect(ev[ev.length - 1].details.token).toBe('neu gesetzt');
    expect(ev[0].details.aenderungen['updates.check_hours']).toEqual({ vorher: 6, nachher: 12 });
    // Anderer API-Host: Token wird verworfen und muss neu eingegeben werden
    const moved = await admin.put('/updates/settings', base());
    expect(moved.json).toMatchObject({ tokenSet: false, tokenCleared: true });
    expect((await one<any>(`SELECT revoked_at FROM secrets WHERE id = $1`, [sid]))!.revoked_at).not.toBeNull();
    expect((await many<any>(`SELECT details FROM audit_events WHERE action = 'updates.settings_changed' ORDER BY id DESC LIMIT 1`))[0].details.token).toMatch(/API-Host/);
  });

  it('Prüfung gegen den GitHub-Stellvertreter: 404, ältere und neuere Version, eine Benachrichtigung je Version', async () => {
    mode = 'none';
    let c = await admin.post('/updates/check');
    expect(c.json).toMatchObject({ ok: true, latest: null, available: false });
    release = buildRelease('0.0.9');
    mode = 'release';
    c = await admin.post('/updates/check');
    expect(c.json).toMatchObject({ ok: true, available: false });
    expect(c.json.latest.version).toBe('0.0.9');
    release = buildRelease('9.9.9');
    await pool.query(`DELETE FROM notifications WHERE title LIKE 'Update verfügbar%'`);
    c = await admin.post('/updates/check');
    expect(c.json).toMatchObject({ ok: true, available: true });
    expect((await admin.post('/updates/check')).json.available).toBe(true);
    const n = await many<any>(`SELECT * FROM notifications WHERE title = 'Update verfügbar: Version 9.9.9'`);
    expect(n).toHaveLength(1);
    expect(n[0].permission).toBe('update.install');
    const info = await admin.get('/updates');
    expect(info.json).toMatchObject({ available: true, lastCheckError: null });
    expect(info.json.latest.notes).toContain('Testeintrag');
    expect(info.json.imageUpdate).toBeNull();
    // Braucht das Release ein neueres Image (Satz in den Versionshinweisen), zeigen Oberfläche und Benachrichtigung das
    // schon vor der Installation – samt Weg über install.sh am Host
    // (direkt statt über POST /updates/check – dessen Abfragelimit von 6 je Minute braucht der Rest dieses Tests)
    const { checkForUpdate } = await import('../src/updates/github.js');
    release = buildRelease('9.9.10', { minImage: '9.9.10' });
    await checkForUpdate();
    expect((await admin.get('/updates')).json.imageUpdate).toEqual({ minImageVersion: '9.9.10', imageVersion: config.version });
    const ni = await one<any>(`SELECT body FROM notifications WHERE title = 'Update verfügbar: Version 9.9.10'`);
    expect(ni.body).toMatch(/neues Docker-Image \(mindestens 9\.9\.10.*install\.sh/);
    release = buildRelease('9.9.9', { minImage: '0.1.0' });
    await checkForUpdate();
    expect((await admin.get('/updates')).json.imageUpdate).toBeNull();
    // Keine Anmeldung ohne Token
    expect(seen.filter((s) => s.path.includes('/releases/latest')).every((s) => s.auth === null)).toBe(true);
    // Fehlerhafte Quelle: Fehler wird gemerkt
    await admin.put('/updates/settings', { ...base(), repo: 'beispiel/gibtsnicht' });
    mode = 'release';
    const e = await admin.post('/updates/check');
    expect(e.json.ok).toBe(true);
    expect(e.json.latest).toBeNull();
    await admin.put('/updates/settings', base());
  });

  it('Download: Token nur an die API, Weiterleitung zum Speicher ohne Authorization', async () => {
    await admin.put('/updates/settings', { ...base(), token: 'ghp_ZweiterTestToken0123456789abcdefghij' });
    release = buildRelease('9.9.9');
    const { downloadRelease, fetchLatestRelease } = await import('../src/updates/github.js');
    seen.length = 0;
    const info = await fetchLatestRelease();
    const file = path.join(work, 'dl.zip');
    const dl = await downloadRelease(info!, file);
    expect(dl.sha256).toBe(release.sha);
    expect(fs.readFileSync(file).equals(release.zip)).toBe(true);
    const api = seen.filter((s) => s.path.startsWith('/repos/'));
    const store = seen.filter((s) => s.path.startsWith('/speicher/'));
    expect(api.length).toBe(4);
    expect(api.every((s) => s.auth === 'Bearer ghp_ZweiterTestToken0123456789abcdefghij')).toBe(true);
    expect(api.filter((s) => s.path.includes('/assets/')).every((s) => s.accept === 'application/octet-stream')).toBe(true);
    expect(store.length).toBe(3);
    expect(store.every((s) => s.auth === null)).toBe(true);
    await admin.put('/updates/settings', { ...base(), clearToken: true });
    expect((await admin.get('/updates')).json.settings.tokenSet).toBe(false);
  });

  it('Installation: nur mit Supervisor, Signatur, neuere Version, passende Abhängigkeiten und Image', async () => {
    const { setActivationSenderForTests, waitForInstall } = await import('../src/updates/installer.js');
    const { readPending } = await import('../src/updates/releases.js');
    expect((await admin.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    // Ohne Supervisor (Entwicklungsbetrieb) wird nichts angefangen
    let r = await admin.post('/updates/install', {});
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/Supervisor/);
    setActivationSenderForTests((m) => (sent.push(m), true));
    // Vorabprüfung braucht einen ruhigen Stand
    await pool.query(`UPDATE jobs SET status = 'done' WHERE status = 'running'`);
    await pool.query(`UPDATE publications SET status = 'unknown' WHERE status = 'sent'`);
    await pool.query(`UPDATE social_publications SET status = 'unknown' WHERE status = 'publishing'`);
    await pool.query(`UPDATE warning_sends SET status = 'unknown' WHERE status IN ('queued','sending')`);
    await setSettings({ 'system.maintenance': null });

    const failing = async (rel: Release, re: RegExp) => {
      release = rel;
      const res = await admin.post('/updates/install', { version: rel.version });
      expect(res.status, JSON.stringify(res.json)).toBe(202);
      await waitForInstall();
      const st = (await admin.get('/updates/status')).json.state;
      expect(st.phase).toBe('failed');
      expect(st.error).toMatch(re);
      expect((await one<any>(`SELECT value FROM settings WHERE key = 'system.maintenance'`))?.value ?? null).toBeNull();
      expect(readPending(process.env.BLAULICHTCMS_DATA_DIR!)).toBeNull();
      const h = await one<any>(`SELECT * FROM update_history ORDER BY id DESC LIMIT 1`);
      expect(h).toMatchObject({ status: 'failed', to_version: rel.version, from_version: config.version });
    };
    await failing(buildRelease('9.9.9', { signWith: otherKey.privateKey }), /Signatur des Update-Pakets ist ungültig/);
    const tampered = buildRelease('9.9.9');
    await failing({ ...tampered, sha: crypto.createHash('sha256').update('anders').digest('hex') }, /SHA-256-Prüfsumme stimmt nicht/);
    await failing(buildRelease('9.9.9', { versionFile: '9.9.8' }), /enthält Version 9\.9\.8/);
    await failing(buildRelease('9.9.9', { minImage: '9.0.0' }), /neueres Docker-Image.*install\.sh/);
    await failing(buildRelease('9.9.9', { lock: { ...lock, packages: { ...lock.packages, 'node_modules/dummy': { version: '2.0.0', integrity: 'sha512-neu' } } } }), /Image-Update nötig.*dummy/);
    await failing(buildRelease('9.9.9', { cliOutput: 'kaputt' }), /Rauchtest/);
    expect(sent).toEqual([]);
    // Gleiche und ältere Version werden gar nicht erst begonnen
    for (const v of [config.version, '0.0.9']) {
      release = buildRelease(v);
      r = await admin.post('/updates/install', {});
      expect(r.status).toBe(400);
      expect(r.json.message).toMatch(/nicht neuer/);
    }
    // Erwartete Version passt nicht mehr zum neuesten Release
    release = buildRelease('9.9.9');
    expect((await admin.post('/updates/install', { version: '9.9.8' })).json.message).toMatch(/inzwischen 9\.9\.9/);
    // Kein angehefteter Schlüssel: abgelehnt
    process.env.BLAULICHTCMS_TEST_UPDATE_PUBKEY = path.join(work, 'fehlt.pub');
    await failing(buildRelease('9.9.9'), /kein öffentlicher Signaturschlüssel/);
    process.env.BLAULICHTCMS_TEST_UPDATE_PUBKEY = pubFile;
    // Ohne frische Bestätigung keine Installation
    const adminId = (await admin.get('/auth/me')).json.user.id;
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE user_id = $1`, [adminId]);
    expect((await admin.post('/updates/install', {})).json.error).toBe('reauth_required');
    expect((await admin.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    // Andere Rollen dürfen nicht installieren
    expect((await editor.post('/updates/install', {})).status).toBe(403);
  });

  it('Installation bis zum Umschaltauftrag, danach Ergebnis des Supervisors im Protokoll', async () => {
    const { waitForInstall, recordActivationResult } = await import('../src/updates/installer.js');
    const { readPending, releasesDir, writeActivation } = await import('../src/updates/releases.js');
    const dataDir = process.env.BLAULICHTCMS_DATA_DIR!;
    release = buildRelease('9.9.9');
    const backupsBefore = Number((await one<any>(`SELECT count(*)::int AS n FROM backups WHERE status = 'ok'`))!.n);
    const r = await admin.post('/updates/install', { version: '9.9.9' });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ started: true, version: '9.9.9', from: config.version });
    // Während der Installation: zweiter Start abgewiesen
    const again = await admin.post('/updates/install', {});
    expect([400, 429]).toContain(again.status);
    await waitForInstall();
    const st = (await admin.get('/updates/status')).json.state;
    expect(st.error).toBeNull();
    expect(st.phase).toBe('activating');
    expect(sent).toEqual([{ type: 'activate-release', version: '9.9.9' }]);
    const dir = path.join(releasesDir(dataDir), '9.9.9');
    expect(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim()).toBe('9.9.9');
    expect(fs.existsSync(path.join(dir, 'node_modules', 'dummy', 'index.js'))).toBe(true);
    expect(fs.readdirSync(releasesDir(dataDir)).filter((d) => d.startsWith('.'))).toEqual([]);
    const pending = readPending(dataDir)!;
    expect(pending).toMatchObject({ version: '9.9.9', from: config.version, sha256: release.sha, maintenanceSetByUpdate: true, actorName: 'Alex Admin' });
    expect(Number((await one<any>(`SELECT count(*)::int AS n FROM backups WHERE status = 'ok'`))!.n)).toBe(backupsBefore + 1);
    expect(fs.existsSync(path.join(dataDir, 'backups', pending.backupFile!))).toBe(true);
    expect((await one<any>(`SELECT value FROM settings WHERE key = 'system.maintenance'`))!.value.reason).toMatch(/9\.9\.9/);
    const actions = (await many<any>(`SELECT action, result FROM audit_events WHERE action LIKE 'update.%' ORDER BY id`)).map((a) => `${a.action}:${a.result}`);
    expect(actions).toContain('update.activation_requested:ok');
    expect(actions).toContain('update.install:failed');
    // Sicherheitsmeldung zum Start
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Update auf Version 9.9.9 gestartet%'`)).not.toBeNull();

    // Supervisor meldet Erfolg: API übernimmt ins Protokoll und beendet den Wartungsmodus
    writeActivation(dataDir, { ...pending, status: 'activated', version: '9.9.9', from: '0.1.0', message: 'Migrationen: 029_update_history.sql', restored: false });
    expect(await recordActivationResult()).toEqual({ status: 'activated', version: '9.9.9' });
    expect(await recordActivationResult()).toBeNull();
    expect((await one<any>(`SELECT value FROM settings WHERE key = 'system.maintenance'`))?.value ?? null).toBeNull();
    expect(readPending(dataDir)).toBeNull();
    let h = (await admin.get('/updates')).json.history[0];
    expect(h).toMatchObject({ status: 'activated', from_version: '0.1.0', to_version: '9.9.9', actor_name: 'Alex Admin', backup_file: pending.backupFile });
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Update auf Version 9.9.9 abgeschlossen'`)).not.toBeNull();

    // Rückweg: Meldung mit Grund, Sicherheitsmeldung, Wartungsmodus aus
    await setSettings({ 'system.maintenance': { since: new Date().toISOString(), byName: 'Alex Admin', reason: 'Update auf Version 9.9.9' } });
    writeActivation(dataDir, { ...pending, status: 'rolled_back', version: '9.9.9', from: '0.1.0', message: 'Migration der Version 9.9.9 fehlgeschlagen: Testfehler. Es läuft wieder 0.1.0. Datenbank aus der Sicherung zurückgespielt.', restored: true });
    await recordActivationResult();
    h = (await admin.get('/updates')).json.history[0];
    expect(h).toMatchObject({ status: 'rolled_back', restored: true });
    expect(h.message).toMatch(/Testfehler/);
    expect((await one<any>(`SELECT value FROM settings WHERE key = 'system.maintenance'`))?.value ?? null).toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Update auf Version 9.9.9 zurückgerollt'`)).not.toBeNull();
    expect((await many<any>(`SELECT action FROM audit_events WHERE action IN ('update.activated','update.rolled_back')`)).length).toBe(2);
    // Lesen ohne „System verwalten“: kein Zugriff für die Redaktion
    expect((await editor.get('/updates')).status).toBe(403);
    await admin.put('/updates/settings', { enabled: true, repo: 'thisislennard/BlaulichtCMS', apiUrl: 'https://api.github.com', checkHours: 6 });
  });

  it('Rückweg-Wiederherstellung spielt die Sicherung zurück und verwirft spätere Änderungen', async () => {
    const { runBackup } = await import('../src/ops/backup.js');
    const { restoreBackupForRollback } = await import('../src/ops/restore.js');
    const b = await runBackup('manual', null);
    await pool.query(`CREATE TABLE nach_dem_update (id int)`);
    await pool.query(`INSERT INTO app_logs (level, source, message, details) VALUES ('info','test','nach der Sicherung','{}')`);
    const before = Number((await one<any>(`SELECT count(*)::int AS n FROM schema_migrations`))!.n);
    await restoreBackupForRollback(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'backups', b.fileName));
    // Eigene Verbindung: die des Pools wurden beim Zurückspielen getrennt
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      expect((await c.query(`SELECT to_regclass('public.nach_dem_update') AS t`)).rows[0].t).toBeNull();
      expect((await c.query(`SELECT count(*)::int AS n FROM app_logs WHERE message = 'nach der Sicherung'`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n).toBe(before);
      expect((await c.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'public_vor_rueckweg_%'`)).rows[0].n).toBe(0);
      // Die Sicherung war beim Erstellen noch „laufend“ – nach dem Zurückspielen ist sie als fertig vermerkt
      expect((await c.query(`SELECT status FROM backups WHERE file_name = $1`, [b.fileName])).rows[0].status).toBe('ok');
      expect((await c.query(`SELECT count(*)::int AS n FROM backups WHERE status = 'running'`)).rows[0].n).toBe(0);
      // Rollen und Rechte setzt der folgende Migrationsschritt neu
      await migrate(() => {}, undefined, { admin: true });
    } finally {
      await c.end();
    }
  });
});

describe('Zugangsdaten nie im Klartext (#190)', () => {
  it('nach allen Verbindungen, Einstellungen und Quellen dieser Suite liegt kein Zugangsdatum im Klartext', async () => {
    const { findPlaintextSecrets } = await import('../src/lib/secret-audit.js');
    // Eigene Verbindung: der Pool wurde beim Zurückspielen der Sicherung getrennt
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      expect((await c.query(`SELECT count(*)::int AS n FROM connections`)).rows[0].n).toBeGreaterThan(0);
      expect(await findPlaintextSecrets(c as any)).toEqual([]);
    } finally {
      await c.end();
    }
  });
});
