import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { config } from '../src/config.js';
import { SIGNATURE_CONTEXT } from '../src/updates/signing.js';
import {
  HOST_PICKUP_MS,
  hostDir,
  hostHelperView,
  hostRequestLine,
  parseHelperInfo,
  parseHostRequest,
  parseHostStatus,
  recordHostResult,
} from '../src/updates/host-helper.js';
import { readZipEntry, verifyReleasePackage } from '../../scripts/host-update-verify.mjs';

/**
 * Image-Updates aus der App über den Update-Helfer am Host (#226): Anfrage-/Statusdateien, Prüfungen, Routen,
 * Protokoll. Der Host-Teil selbst (scripts/host-update-helper.sh, install.sh --unattended) wird mit einem
 * Docker-Stellvertreter trocken getestet (docs/technik.md).
 */

const ROOT = path.resolve(__dirname, '..', '..');
const uuid = () => crypto.randomUUID();
const nextVersion = () => {
  const [a, b, c] = config.version.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
};

describe('Update-Helfer: Anfrage und Status (Bausteine)', () => {
  it('die Anfrage-Zeile passt genau zum Muster, das der Helfer am Host verlangt', () => {
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'host-update-helper.sh'), 'utf8');
    const uuidRe = /^UUID='([^']+)'$/m.exec(sh)![1];
    const raw = /^RE="(.+)"$/m.exec(sh)![1].replace(/\\"/g, '"').replaceAll('$UUID', uuidRe);
    const re = new RegExp(raw);
    const r = { v: 1 as const, id: uuid(), version: '1.2.3', requestedAt: new Date().toISOString(), userId: uuid() };
    expect(re.test(hostRequestLine(r).trim())).toBe(true);
    expect(re.test(hostRequestLine({ ...r, userId: '' }).trim())).toBe(true);
    // Zusätzliche Felder, andere Reihenfolge oder Befehle passen nie
    expect(re.test(JSON.stringify({ ...r, cmd: 'rm -rf /' }))).toBe(false);
    expect(re.test(JSON.stringify({ id: r.id, v: 1, version: r.version, requestedAt: r.requestedAt, userId: r.userId }))).toBe(false);
    expect(re.test(hostRequestLine(r).trim().replace('1.2.3', '1.2.3;id'))).toBe(false);
    expect(() => hostRequestLine({ ...r, version: '1.2' })).toThrow();
    expect(() => hostRequestLine({ ...r, id: 'x' })).toThrow();
    expect(() => hostRequestLine({ ...r, requestedAt: 'gestern' })).toThrow();
  });

  it('liest nur gültige Anfragen in genau dieser Form', () => {
    const r = { v: 1 as const, id: uuid(), version: '0.6.0', requestedAt: '2026-11-17T10:00:00.000Z', userId: '' };
    expect(parseHostRequest(hostRequestLine(r))).toEqual(r);
    expect(parseHostRequest(JSON.stringify({ ...r, extra: 1 }))).toBeNull();
    expect(parseHostRequest('{kaputt')).toBeNull();
    expect(parseHostRequest('x'.repeat(2000))).toBeNull();
    expect(parseHostRequest(null)).toBeNull();
  });

  it('Statusdatei: Schema, Grenzen, Steuerzeichen; Unbekanntes wird verworfen', () => {
    const ok = { v: 1, requestId: uuid(), userId: uuid(), state: 'running', phase: 'build', step: '6/8 Image bauen', targetVersion: '0.6.0', fromVersion: '0.5.0', image: '', backupFile: '', message: '', startedAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:01:00Z', finishedAt: '', logTail: 'a\r\nb\u0007c', fremd: 'x' };
    const s = parseHostStatus(JSON.stringify(ok))!;
    expect(s).toMatchObject({ state: 'running', phase: 'build', targetVersion: '0.6.0', finishedAt: null, logTail: 'a\nbc' });
    expect(s).not.toHaveProperty('fremd');
    expect(parseHostStatus(JSON.stringify({ ...ok, state: 'gelöscht' }))).toBeNull();
    expect(parseHostStatus(JSON.stringify({ ...ok, phase: 'irgendwas' }))).toBeNull();
    expect(parseHostStatus(JSON.stringify({ ...ok, v: 2 }))).toBeNull();
    expect(parseHostStatus('kein json')).toBeNull();
    const odd = parseHostStatus(JSON.stringify({ ...ok, requestId: '../x', targetVersion: '1.0; rm', message: 'm'.repeat(5000), logTail: 'L'.repeat(20_000) + 'ENDE' }))!;
    expect(odd.requestId).toBeNull();
    expect(odd.targetVersion).toBeNull();
    expect(odd.message).toHaveLength(1000);
    expect(odd.logTail).toHaveLength(12_000);
    expect(odd.logTail.endsWith('ENDE')).toBe(true);
    expect(parseHelperInfo('{"v":1,"helperVersion":1,"installedAt":"2026-11-17T10:00:00Z"}')).toEqual({ helperVersion: 1, installedAt: '2026-11-17T10:00:00Z' });
    expect(parseHelperInfo('{"v":1,"helperVersion":"1"}')).toBeNull();
    expect(parseHelperInfo('[]')).toBeNull();
  });
});

describe('Update-Helfer: Echtheitsprüfung des Release-Pakets (scripts/host-update-verify.mjs)', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const pub = `# Testschlüssel\n${keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64')}\n`;
  const commit = 'a'.repeat(40);
  const makeZip = async (manifest: Record<string, unknown>) => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('0.6.0\n'), 'VERSION');
    z.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json', { compress: true });
    z.end();
    const chunks: Buffer[] = [];
    for await (const c of z.outputStream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const sign = (zip: Buffer, key = keys.privateKey) => `# Signatur\n${crypto.sign(null, Buffer.from(SIGNATURE_CONTEXT + crypto.createHash('sha256').update(zip).digest('hex')), key).toString('base64')}\n`;

  it('gültig nur mit passender Signatur, Version und Commit des Tags', async () => {
    const zip = await makeZip({ name: 'blaulichtcms', version: '0.6.0', commit });
    expect(JSON.parse(readZipEntry(zip, 'manifest.json').toString()).commit).toBe(commit);
    expect(verifyReleasePackage({ zip, sig: sign(zip), pub, version: '0.6.0', commit })).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyReleasePackage({ zip, sig: sign(zip, other.privateKey), pub, version: '0.6.0', commit })).toThrow(/Signatur .* ungültig/);
    expect(() => verifyReleasePackage({ zip, sig: sign(zip), pub, version: '0.6.1', commit })).toThrow(/Version 0\.6\.0, erwartet 0\.6\.1/);
    expect(() => verifyReleasePackage({ zip, sig: sign(zip), pub, version: '0.6.0', commit: 'b'.repeat(40) })).toThrow(/Commit/);
    const tampered = Buffer.from(zip);
    tampered[10] ^= 1;
    expect(() => verifyReleasePackage({ zip: tampered, sig: sign(zip), pub, version: '0.6.0', commit })).toThrow(/ungültig/);
    expect(() => verifyReleasePackage({ zip, sig: 'kurz', pub, version: '0.6.0', commit })).toThrow(/Format/);
    expect(() => verifyReleasePackage({ zip, sig: sign(zip), pub: 'kein Schlüssel', version: '0.6.0', commit })).toThrow(/Signaturschlüssel/);
    const foreign = await makeZip({ name: 'anderes', version: '0.6.0', commit });
    expect(() => verifyReleasePackage({ zip: foreign, sig: sign(foreign), pub, version: '0.6.0', commit })).toThrow(/kein BlaulichtCMS-Release/);
  });
});

/* ------------------------------------------------------------------------------------------ Routen */

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
    return { status: res.statusCode, json };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  del = (u: string) => this.raw('DELETE', u, {});
}

const PASSWORD = 'Langes-Passwort-2026';
let app: FastifyInstance;
let admin: Client;
let editor: Client;
const dir = () => hostDir(process.env.BLAULICHTCMS_DATA_DIR!);
const freshReauth = () => pool.query(`UPDATE sessions SET reauth_at = now()`);
const writeStatus = (s: Record<string, unknown>) => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), 'status.json'), JSON.stringify({ v: 1, helperVersion: 1, userId: '', step: '', image: '', backupFile: '', message: '', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: '', logTail: '', ...s }));
};

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Update-Helfer: Anfrage aus der App (Routen, Rate-Limit, Protokoll)', () => {
  const target = nextVersion();
  const latest = () => ({ tag: `v${target}`, version: target, name: target, notes: `## ${target}\n\nNeue Image-Basis nötig ab Mindestversion ${target}.`, publishedAt: null, url: '', assets: {} });

  it('richtet Konten ein; ohne Helfer gibt es nur die Anleitung', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'updates.latest': latest() as any });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    const inv = await admin.post('/users/invite', { email: 'redaktion@example.org', roles: ['editor'] });
    editor = new Client(app);
    expect((await editor.post(`/auth/invite/${inv.json.link.split('/einladung/')[1]}`, { name: 'Robin', password: 'Robin-Zugang-sicher-2026' })).json.next).toBe('done');

    const info = await admin.get('/updates');
    expect(info.json.imageUpdate).toEqual({ minImageVersion: target, imageVersion: config.version });
    expect(info.json.hostHelper).toMatchObject({ installed: false, request: null, status: null, busy: false });
    await freshReauth();
    const r = await admin.post('/updates/host-request', { version: target });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/nicht eingerichtet/);
    expect(fs.existsSync(path.join(dir(), 'request.json'))).toBe(false);
  });

  it('mit Helfer: Bestätigung, strenge Prüfung, genau eine Anfrage-Datei, Audit und Meldung', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'helper.json'), JSON.stringify({ v: 1, helperVersion: 1, installedAt: new Date().toISOString(), appDir: '/opt/apps/blaulichtcms' }));
    expect((await admin.get('/updates')).json.hostHelper.installed).toBe(true);
    // Nur mit Recht „Updates installieren“, nur mit frischer Passwortbestätigung
    expect((await editor.post('/updates/host-request', { version: target })).status).toBe(403);
    expect((await editor.get('/updates')).status).toBe(403);
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour'`);
    expect((await admin.post('/updates/host-request', { version: target })).json.error).toBe('reauth_required');
    await freshReauth();
    // Nur die zuletzt geprüfte Version, keine Zusatzfelder, kein Downgrade
    expect((await admin.post('/updates/host-request', { version: '9.9.9' })).json.message).toMatch(/geändert/);
    expect((await admin.post('/updates/host-request', { version: target, befehl: 'x' })).status).toBe(400);
    await setSettings({ 'updates.latest': { ...latest(), version: config.version, tag: `v${config.version}`, notes: `Neue Image-Basis nötig ab Mindestversion 99.0.0.` } as any });
    expect((await admin.post('/updates/host-request', { version: config.version })).json.message).toMatch(/nicht neuer/);
    // Ohne nötiges neues Image: In-App-Update statt Helfer
    await setSettings({ 'updates.latest': { ...latest(), notes: 'Neue Image-Basis nötig ab Mindestversion 0.1.0.' } as any });
    expect((await admin.post('/updates/host-request', { version: target })).json.message).toMatch(/kein neues Image/);
    await setSettings({ 'updates.latest': latest() as any });
    expect(fs.existsSync(path.join(dir(), 'request.json'))).toBe(false);

    const ok = await admin.post('/updates/host-request', { version: target });
    expect(ok.status, JSON.stringify(ok.json)).toBe(202);
    const text = fs.readFileSync(path.join(dir(), 'request.json'), 'utf8');
    const adminId = (await admin.get('/auth/me')).json.user.id;
    expect(parseHostRequest(text)).toEqual({ v: 1, id: ok.json.id, version: target, requestedAt: expect.any(String), userId: adminId });
    expect(text.endsWith('\n') && text.trim().split('\n')).toHaveLength(1);
    expect(fs.readdirSync(dir()).filter((f) => f.startsWith('.'))).toEqual([]);
    const a = await one<any>(`SELECT action, result, details FROM audit_events WHERE action = 'update.host_requested' ORDER BY id DESC LIMIT 1`);
    expect(a).toMatchObject({ result: 'ok' });
    expect(a.details.anfrage).toBe(ok.json.id);
    expect((await many<any>(`SELECT title FROM notifications WHERE title LIKE 'Image-Update auf Version % angestoßen%'`)).length).toBe(1);

    const info = (await admin.get('/updates')).json.hostHelper;
    expect(info).toMatchObject({ busy: true, request: { id: ok.json.id, version: target, stale: false } });
    expect(info.nextRequestAt).not.toBeNull();
    // Läuft schon etwas → keine zweite Anfrage
    expect((await admin.post('/updates/host-request', { version: target })).json.message).toMatch(/läuft bereits/);
  });

  it('Helfer reagiert nicht: Anfrage wird als liegengeblieben erkannt und lässt sich zurückziehen; Rate-Limit bleibt', async () => {
    const view = await hostHelperView(Date.now() + HOST_PICKUP_MS + 1000, process.env.BLAULICHTCMS_DATA_DIR!);
    expect(view.request?.stale).toBe(true);
    expect(view.busy).toBe(false);
    expect((await editor.del('/updates/host-request')).status).toBe(403);
    const c = await admin.del('/updates/host-request');
    expect(c.json).toEqual({ ok: true, cancelled: true });
    expect(fs.existsSync(path.join(dir(), 'request.json'))).toBe(false);
    expect((await admin.del('/updates/host-request')).json.cancelled).toBe(false);
    // Eine Anfrage je 10 Minuten
    await freshReauth();
    expect((await admin.post('/updates/host-request', { version: target })).json.message).toMatch(/10 Minuten/);
    await setSettings({ 'updates.host_requested_at': new Date(Date.now() - 11 * 60_000).toISOString() });
    expect((await admin.post('/updates/host-request', { version: target })).status).toBe(202);
    fs.rmSync(path.join(dir(), 'request.json'));
  });

  it('Statusdatei des Helfers: Fortschritt, „meldet sich nicht“, Ergebnis einmalig ins Protokoll mit Meldung', async () => {
    const id = uuid();
    const adminId = (await admin.get('/auth/me')).json.user.id;
    writeStatus({ requestId: id, userId: adminId, state: 'running', phase: 'backup', step: '3. Vollständige Sicherung außerhalb des Volumes', targetVersion: target, fromVersion: config.version });
    let st = (await admin.get('/updates/status')).json.hostHelper;
    expect(st.busy).toBe(true);
    expect(st.status).toMatchObject({ state: 'running', phase: 'backup', silent: false });
    expect(await recordHostResult(process.env.BLAULICHTCMS_DATA_DIR!)).toBeNull();
    writeStatus({ requestId: id, state: 'running', phase: 'build', targetVersion: target, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    st = (await admin.get('/updates')).json.hostHelper;
    expect(st.status.silent).toBe(true);
    expect(st.busy).toBe(false);

    writeStatus({ requestId: id, userId: adminId, state: 'success', phase: 'done', targetVersion: target, fromVersion: config.version, message: `Update auf Version ${target} abgeschlossen.`, backupFile: 'blaulichtcms-2026.tar.gz.enc', finishedAt: new Date().toISOString() });
    expect(await recordHostResult(process.env.BLAULICHTCMS_DATA_DIR!)).toEqual({ state: 'success', requestId: id });
    expect(await recordHostResult(process.env.BLAULICHTCMS_DATA_DIR!)).toBeNull();
    const h = await one<any>(`SELECT h.*, u.email FROM update_history h LEFT JOIN users u ON u.id = h.actor_id ORDER BY h.id DESC LIMIT 1`);
    expect(h).toMatchObject({ status: 'activated', to_version: target, from_version: config.version, backup_file: 'blaulichtcms-2026.tar.gz.enc', email: 'admin@example.org' });
    expect(h.message).toMatch(/^Image-Update über den Update-Helfer/);
    expect(await one<any>(`SELECT kind FROM notifications WHERE title = $1`, [`Image-Update auf Version ${target} abgeschlossen`])).toMatchObject({ kind: 'success' });
    expect((await one<any>(`SELECT result FROM audit_events WHERE action = 'update.host_success'`))?.result).toBe('ok');

    const id2 = uuid();
    writeStatus({ requestId: id2, state: 'rolled_back', phase: 'done', targetVersion: target, fromVersion: config.version, message: 'Das neue Image startete nicht sauber – automatischer Rückweg erfolgreich.', finishedAt: new Date().toISOString() });
    expect((await recordHostResult(process.env.BLAULICHTCMS_DATA_DIR!))?.state).toBe('rolled_back');
    expect(await one<any>(`SELECT status, restored FROM update_history ORDER BY id DESC LIMIT 1`)).toEqual({ status: 'rolled_back', restored: true });
    expect((await admin.get('/updates')).json.history[0].status).toBe('rolled_back');

    // Abgelehnte Anfrage (z. B. falsches Format) ohne gültige Kennung: wird angezeigt, aber nicht protokolliert
    writeStatus({ requestId: '', state: 'rejected', phase: 'done', message: 'Anfrage hat nicht das erwartete Format – ignoriert.', finishedAt: new Date().toISOString() });
    expect(await recordHostResult(process.env.BLAULICHTCMS_DATA_DIR!)).toBeNull();
    expect((await admin.get('/updates')).json.hostHelper.status).toMatchObject({ state: 'rejected', requestId: null });
    // Kaputte oder übergroße Statusdatei: wird ignoriert
    fs.writeFileSync(path.join(dir(), 'status.json'), 'x'.repeat(70_000));
    expect((await admin.get('/updates')).json.hostHelper.status).toBeNull();
    // Nicht über die allgemeinen Einstellungen änderbar
    expect((await admin.raw('PATCH', '/settings', { 'updates.host_requested_at': null })).status).toBe(400);
  });
});
