import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { claimJobs, completeJob } from '../src/jobs/queue.js';
import { httpRequest, normalizeFingerprint, peekCertificate } from '../src/lib/http.js';
import { sealAudit } from '../src/lib/audit-chain.js';
import { backupDir } from '../src/ops/backup.js';
import { normalizeDavUrl, parseMultistatus, retentionPlan, uploadBackup, uploadVolumeStream } from '../src/ops/offsite.js';
import { dropProbeDatabase, openProbePool, probeUrl, runDrill, scheduleDrill } from '../src/ops/drill.js';
import { systemStatus } from '../src/routes/system.js';
import { config } from '../src/config.js';

/**
 * Sicherung außer Haus (WebDAV) und Probe-Wiederherstellung (#212) gegen eine echte PostgreSQL-Datenbank. Ein lokaler
 * Stellvertreter spielt das NAS (WebDAV im Speicher, Basic-Anmeldung).
 */

describe('Sicherung außer Haus: Bausteine', () => {
  const n = (d: string, h = '03-00-00') => `blaulichtcms-${d}-${h}-abcdef.bcbk`;

  it('Aufbewahrung täglich/wöchentlich/monatlich, neueste bleibt, fremde Dateien nie', () => {
    const names: string[] = [];
    // 120 Tage täglich eine Sicherung, am 2026-11-16 zwei
    for (let i = 0; i < 120; i++) names.push(n(new Date(Date.UTC(2026, 10, 16) - i * 86_400_000).toISOString().slice(0, 10)));
    names.push(n('2026-11-16', '15-00-00'));
    names.push('notizen.txt', 'blaulichtcms-2026-11-01-030000.tar.gz.enc.part');
    const plan = retentionPlan(names, { daily: 7, weekly: 4, monthly: 3 });
    expect(plan.keep).toContain(n('2026-11-16', '15-00-00'));
    expect(plan.keep).not.toContain(n('2026-11-16'));
    expect(plan.remove).toContain(n('2026-11-16'));
    // 7 Tage + bis zu 4 Wochen + 3 Monate (Überschneidungen zählen einmal)
    expect(plan.keep.length).toBeGreaterThanOrEqual(8);
    expect(plan.keep.length).toBeLessThanOrEqual(14);
    expect(plan.keep).toContain(n('2026-09-30'));
    expect(plan.keep).not.toContain(n('2026-08-15'));
    expect([...plan.keep, ...plan.remove]).not.toContain('notizen.txt');
    expect(plan.keep.length + plan.remove.length).toBe(121);
    // Nur eine Sicherung: bleibt immer
    expect(retentionPlan([n('2020-01-01')], { daily: 1, weekly: 0, monthly: 0 }).remove).toEqual([]);
  });

  it('Adresse: nur https, ohne Zugangsdaten, Abfrage oder Anker; Pfad endet auf /', () => {
    expect(normalizeDavUrl('https://nas.local:5006/sicherung/blaulichtcms')).toBe('https://nas.local:5006/sicherung/blaulichtcms/');
    expect(() => normalizeDavUrl('http://nas.local:5005/x/')).toThrow(/https/);
    expect(() => normalizeDavUrl('https://u:p@nas.local/x/')).toThrow(/eigenen Feldern/);
    expect(() => normalizeDavUrl('https://nas.local/x/?a=1')).toThrow(/Abfrage/);
    expect(() => normalizeDavUrl('kein-url')).toThrow(/vollständige Adresse/);
  });

  it('liest PROPFIND-Antworten mit beliebigen Namensraum-Präfixen', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/sicherung/blaulichtcms/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><D:href>/sicherung/blaulichtcms/blaulichtcms-2026-11-16-03-00-00-abcdef.bcbk</D:href><D:propstat><D:prop><D:getcontentlength>1234</D:getcontentlength><D:getlastmodified>Mon, 16 Nov 2026 03:00:05 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
      <response xmlns="DAV:"><href>https://nas.local:5006/sicherung/blaulichtcms/Mein%20Ordner/</href></response>
    </D:multistatus>`;
    const files = parseMultistatus(xml, 'https://nas.local:5006/sicherung/blaulichtcms/');
    expect(files.map((f) => f.name)).toEqual(['blaulichtcms-2026-11-16-03-00-00-abcdef.bcbk', 'Mein Ordner']);
    expect(files[0].size).toBe(1234);
    expect(files[0].modified).toBe('2026-11-16T03:00:05.000Z');
  });

  it('Probedatenbank: nur Namen nach Muster, gleiche Verbindung', () => {
    expect(probeUrl('postgresql://blaulichtcms@localhost/blaulichtcms?host=%2Ftmp%2Fblaulichtcms-pg', 'blaulichtcms_probe_0a1b2c3d')).toBe('postgresql://blaulichtcms@localhost/blaulichtcms_probe_0a1b2c3d?host=%2Ftmp%2Fblaulichtcms-pg');
    expect(() => probeUrl('postgresql://x@h/db', 'blaulichtcms')).toThrow();
  });

  it('Zertifikat per Fingerabdruck: passt → Anfrage geht durch; passt nicht → nichts wird gesendet', async () => {
    let openssl = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cert-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=nas.test'], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    } catch {
      openssl = false;
    }
    if (!openssl) return; // ohne openssl (nur lokal möglich) übersprungen; die CI hat openssl
    const seen: string[] = [];
    const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
      seen.push(String(req.headers.authorization ?? ''));
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(srv.address() as any).port}/`;
    try {
      const cert = await peekCertificate(url, { allowPrivateHosts: ['127.0.0.1'] });
      expect(cert.trusted).toBe(false);
      expect(cert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(cert.subject).toContain('nas.test');
      // ohne Fingerabdruck: abgewiesen
      await expect(httpRequest({ method: 'GET', url, allowPrivateHosts: ['127.0.0.1'], headers: { authorization: 'Basic geheim' } })).rejects.toThrow(/Zertifikat/);
      // mit passendem Fingerabdruck (auch in anderer Schreibweise)
      const ok = await httpRequest({ method: 'GET', url, allowPrivateHosts: ['127.0.0.1'], tlsFingerprint256: cert.fingerprint256.replace(/:/g, '').toLowerCase(), headers: { authorization: 'Basic geheim' } });
      expect(ok.text()).toBe('ok');
      expect(seen).toEqual(['Basic geheim']);
      // mit falschem: abgewiesen, ohne dass die Anfrage (samt Zugangsdaten) den Server erreicht
      const wrong = normalizeFingerprint('AA'.repeat(32));
      await expect(httpRequest({ method: 'GET', url, allowPrivateHosts: ['127.0.0.1'], tlsFingerprint256: wrong, headers: { authorization: 'Basic geheim' } })).rejects.toThrow(/Fingerabdruck/);
      expect(seen).toEqual(['Basic geheim']);
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */

let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
const DAV_USER = 'sicherung';
const DAV_PASS = 'NAS-Passwort-2026!';

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
}

/** WebDAV-Stellvertreter: Dateien und Ordner im Speicher. */
const files = new Map<string, Buffer>();
const dirs = new Set<string>(['/']);
const requests: { method: string; url: string; auth: string }[] = [];
let corruptGets = false;
/** GET liefert mehr als die Datei (fehlerhaftes Ziel, #240) */
let oversizeGets = false;
let server: http.Server;
let base = '';

function davServer() {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      requests.push({ method: req.method ?? '', url: p, auth: String(req.headers.authorization ?? '') });
      if (req.headers.authorization !== `Basic ${Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString('base64')}`) return res.writeHead(401, { 'www-authenticate': 'Basic realm="nas"' }).end();
      const body = Buffer.concat(chunks);
      const parent = p.replace(/[^/]+\/?$/, '');
      switch (req.method) {
        case 'PROPFIND': {
          const dir = p.endsWith('/') ? p : `${p}/`;
          if (!dirs.has(dir)) return res.writeHead(404).end();
          const entries = req.headers.depth === '0' ? [] : [...files.keys()].filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes('/'));
          const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${encodeURI(dir)}</d:href></d:response>${entries
            .map((f) => `<d:response><d:href>${encodeURI(f)}</d:href><d:propstat><d:prop><d:getcontentlength>${files.get(f)!.length}</d:getcontentlength></d:prop></d:propstat></d:response>`)
            .join('')}</d:multistatus>`;
          return res.writeHead(207, { 'content-type': 'application/xml' }).end(xml);
        }
        case 'MKCOL':
          if (!dirs.has(parent)) return res.writeHead(409).end();
          dirs.add(p.endsWith('/') ? p : `${p}/`);
          return res.writeHead(201).end();
        case 'PUT':
          if (!dirs.has(parent)) return res.writeHead(409).end();
          files.set(p, body);
          return res.writeHead(201).end();
        case 'GET': {
          const f = files.get(p);
          if (!f) return res.writeHead(404).end();
          const out = corruptGets ? Buffer.concat([f.subarray(0, f.length - 1), Buffer.from([f[f.length - 1] ^ 1])]) : oversizeGets ? Buffer.concat([f, crypto.randomBytes(200_000)]) : f;
          return res.writeHead(200, { 'content-length': String(out.length) }).end(out);
        }
        case 'MOVE': {
          const f = files.get(p);
          if (!f) return res.writeHead(404).end();
          const dest = decodeURIComponent(new URL(String(req.headers.destination)).pathname);
          files.delete(p);
          files.set(dest, f);
          return res.writeHead(201).end();
        }
        case 'DELETE':
          files.delete(p);
          return res.writeHead(204).end();
        default:
          return res.writeHead(405).end();
      }
    });
  });
}

let admin: Client;
let editor: Client;
const freshReauth = () => pool.query(`UPDATE sessions SET reauth_at = now()`);
const target = () => `${base}/sicherung/blaulichtcms/`;
const cfg = (over: Record<string, unknown> = {}) => ({ url: target(), username: DAV_USER, password: DAV_PASS, fingerprint: '', enabled: true, keepDaily: 3, keepWeekly: 0, keepMonthly: 0, drillInterval: 'weekly', ...over });

/** Worker-Ersatz: Sicherungs-Aufträge ausführen, alles andere abhaken. */
async function drain() {
  for (let i = 0; i < 10; i++) {
    const jobs = await claimJobs(20);
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.kind === 'backup.offsite') await uploadBackup(String(j.payload.backupId), { final: true }).catch(() => {});
      if (j.kind === 'backup.drill') await runDrill(String(j.payload.drillId));
      await completeJob(j.id);
    }
  }
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  server = davServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  dirs.add('/sicherung/');
  app = await buildApp();
  admin = new Client(app);
});

afterAll(async () => {
  server?.close();
  await app?.close();
  await pool.end();
});

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return c;
}

describe('Sicherung außer Haus (WebDAV) und Probe-Wiederherstellung', () => {
  it('richtet Konten ein; nur „Sicherungen erstellen“ sieht das Ziel', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    editor = await acceptInvite('redaktion@example.org', ['editor'], 'Robin');
    expect((await editor.get('/backups/offsite')).status).toBe(403);
    expect((await editor.post('/backups/drills', {})).status).toBe(403);
    const v = await admin.get('/backups/offsite');
    expect(v.status).toBe(200);
    expect(v.json.config).toMatchObject({ enabled: false, url: '', password_set: false, keep_daily: 7, drill_interval: 'weekly' });
  });

  it('Verbindungstest: falsches Passwort wird erkannt, richtiges legt den Ordner an und räumt die Probedatei weg', async () => {
    const bad = await admin.post('/backups/offsite/test', { url: target(), username: DAV_USER, password: 'falsch' });
    expect(bad.status).toBe(200);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/Anmeldung abgelehnt \(401\)/);
    const ok = await admin.post('/backups/offsite/test', { url: target(), username: DAV_USER, password: DAV_PASS });
    expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
    expect(dirs.has('/sicherung/blaulichtcms/')).toBe(true);
    expect([...files.keys()].filter((f) => f.includes('.blaulichtcms-test-'))).toEqual([]);
    expect(ok.json.steps.map((s: any) => s.step)).toContain('Zurücklesen und Prüfsumme vergleichen');
  });

  it('Einschalten nur mit frischer Passwortbestätigung und bestandenem Test; Passwort nur verschlüsselt', async () => {
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour'`);
    const r1 = await admin.put('/backups/offsite', cfg());
    expect(r1.status).toBe(403);
    expect(r1.json.error).toBe('reauth_required');
    await freshReauth();
    const r2 = await admin.put('/backups/offsite', cfg({ password: 'falsch' }));
    expect(r2.status).toBe(400);
    expect(r2.json.message ?? r2.json.error).toBeTruthy();
    const r3 = await admin.put('/backups/offsite', cfg());
    expect(r3.status, JSON.stringify(r3.json)).toBe(200);
    expect(r3.json.config).toMatchObject({ enabled: true, url: target(), username: DAV_USER, password_set: true });
    expect(JSON.stringify(r3.json)).not.toContain(DAV_PASS);
    expect(JSON.stringify(await many(`SELECT * FROM backup_offsite`))).not.toContain(DAV_PASS);
    expect(JSON.stringify(await many(`SELECT ciphertext FROM secrets`))).not.toContain(DAV_PASS);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'backup.offsite_changed'`)).toBeTruthy();
    // Gespeichertes Passwort nie für einen anderen Host oder Benutzer (sonst ließe es sich an einen eigenen Server schicken)
    const other = await admin.post('/backups/offsite/test', { url: 'http://127.0.0.1:1/andere/', username: DAV_USER });
    expect(other.status).toBe(400);
    expect(other.json.message).toMatch(/Passwort neu eingeben/);
    const otherUser = await admin.post('/backups/offsite/test', { url: target(), username: 'jemand' });
    expect(otherUser.status).toBe(400);
    // Nur Aufbewahrung ändern: ohne erneute Bestätigung möglich, Passwort bleibt
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour'`);
    const r4 = await admin.put('/backups/offsite', { ...cfg({ password: undefined }), keepDaily: 2 });
    expect(r4.status, JSON.stringify(r4.json)).toBe(200);
    expect(r4.json.config).toMatchObject({ keep_daily: 2, password_set: true });
    await freshReauth();
  });

  it('nach jeder Sicherung: hochladen, Prüfsumme kontrollieren, umbenennen, Aufbewahrung auf dem Ziel', async () => {
    // Ältere Stände und eine fremde Datei auf dem Ziel
    const dir = '/sicherung/blaulichtcms/';
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) files.set(`${dir}blaulichtcms-${d}-03-00-00-aaaaaa.bcbk`, Buffer.from('alt'));
    files.set(`${dir}notizen.txt`, Buffer.from('fremd'));
    const b = await admin.post('/backups', {});
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    expect((await one(`SELECT offsite_status FROM backups WHERE id = $1`, [b.json.id])).offsite_status).toBe('pending');
    await drain();
    const row = await one(`SELECT * FROM backups WHERE id = $1`, [b.json.id]);
    expect(row.offsite_status, row.offsite_error).toBe('ok');
    const remote = files.get(`${dir}${row.file_name}`);
    expect(remote).toBeTruthy();
    expect(crypto.createHash('sha256').update(remote!).digest('hex')).toBe(row.sha256);
    expect([...files.keys()].some((f) => f.endsWith('.part'))).toBe(false);
    // keep_daily 2: neueste + ein älterer Tag bleiben, fremde Datei bleibt
    expect(files.has(`${dir}notizen.txt`)).toBe(true);
    expect(files.has(`${dir}blaulichtcms-2026-01-03-03-00-00-aaaaaa.bcbk`)).toBe(true);
    expect(files.has(`${dir}blaulichtcms-2026-01-01-03-00-00-aaaaaa.bcbk`)).toBe(false);
    expect(requests.filter((r) => r.method === 'PUT').every((r) => r.auth.startsWith('Basic '))).toBe(true);
    const list = await admin.get('/backups/offsite/files');
    expect(list.status).toBe(200);
    expect(list.json.files.map((f: any) => f.name)).toContain(row.file_name);
    expect(list.json.files.map((f: any) => f.name)).not.toContain('notizen.txt');
    const st = await systemStatus();
    expect(st.services.find((s: any) => s.id === 'offsite')).toMatchObject({ state: 'ok' });
  });

  it('Fehler beim Hochladen: vermerkt, gemeldet, im Systemstatus rot', async () => {
    corruptGets = true;
    const b = await admin.post('/backups', {});
    await drain();
    corruptGets = false;
    const row = await one(`SELECT * FROM backups WHERE id = $1`, [b.json.id]);
    expect(row.offsite_status).toBe('failed');
    expect(row.offsite_error).toMatch(/Prüfsumme/);
    expect([...files.keys()].some((f) => f.endsWith('.part'))).toBe(false);
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Sicherung außer Haus fehlgeschlagen' AND permission = 'backup.manage'`)).toBeTruthy();
    expect((await systemStatus()).services.find((s: any) => s.id === 'offsite')).toMatchObject({ state: 'error' });
    // Erneut anstoßen → klappt
    expect((await admin.post(`/backups/${b.json.id}/offsite`, {})).status).toBe(200);
    await drain();
    expect((await one(`SELECT offsite_status FROM backups WHERE id = $1`, [b.json.id])).offsite_status).toBe('ok');
    expect((await systemStatus()).services.find((s: any) => s.id === 'offsite')).toMatchObject({ state: 'ok' });
  });

  it('Probe-Wiederherstellung: lokal und vom Ziel, in eine Wegwerf-Datenbank, mit Prüfprotokoll', async () => {
    await sealAudit();
    // Neue Sicherung mit versiegelter Kette
    const b = await admin.post('/backups', {});
    await drain();
    const local = await admin.post('/backups/drills', { source: 'local', fileName: (await one(`SELECT file_name FROM backups WHERE id = $1`, [b.json.id])).file_name });
    expect(local.status, JSON.stringify(local.json)).toBe(200);
    // Nur eine Probe gleichzeitig
    expect((await admin.post('/backups/drills', {})).status).toBe(409);
    await drain();
    const d1 = await one(`SELECT * FROM restore_drills WHERE id = $1`, [local.json.id]);
    expect(d1.status, `${d1.error} ${JSON.stringify(d1.result)}`).toBe('ok');
    expect(d1.result.tables).toBeGreaterThan(30);
    expect(d1.result.keyTables.users).toBe(2);
    expect(d1.result.audit).toMatchObject({ ok: true, keyAvailable: true, matchesLive: true });
    expect(d1.result.audit.checked).toBeGreaterThan(0);
    expect(d1.result.migration).toMatch(/^\d{3}_/);
    // Wegwerf-Datenbank ist wieder weg, keine Reste im Sicherungsordner
    expect(await many(`SELECT datname FROM pg_database WHERE datname LIKE 'blaulichtcms_probe_%'`)).toEqual([]);
    expect(fs.readdirSync(backupDir()).filter((f) => f.startsWith('.probe-'))).toEqual([]);
    // Ohne Angabe: die neueste Kopie außer Haus
    const off = await admin.post('/backups/drills', {});
    expect(off.json.source).toBe('offsite');
    await drain();
    const d2 = await one(`SELECT * FROM restore_drills WHERE id = $1`, [off.json.id]);
    expect(d2.status, d2.error).toBe('ok');
    expect(d2.result.checks.map((c: any) => c.step)).toContain('Vom Ziel außer Haus geladen');
    expect((await systemStatus()).services.find((s: any) => s.id === 'drill')).toMatchObject({ state: 'ok' });
    const list = await admin.get('/backups/drills');
    expect(list.json.length).toBe(2);
  });

  it('beschädigte Kopie auf dem Ziel: Probe schlägt fehl, Benachrichtigung, Systemstatus rot', async () => {
    const c = await one(`SELECT last_ok_file FROM backup_offsite`);
    const key = `/sicherung/blaulichtcms/${c.last_ok_file}`;
    const good = files.get(key)!;
    const bad = Buffer.from(good);
    bad[100] ^= 0xff;
    files.set(key, bad);
    const r = await admin.post('/backups/drills', { source: 'offsite', fileName: c.last_ok_file });
    await drain();
    files.set(key, good);
    const d = await one(`SELECT * FROM restore_drills WHERE id = $1`, [r.json.id]);
    expect(d.status).toBe('failed');
    expect(d.error).toMatch(/Prüfsumme|entschlüssel/i);
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Probe-Wiederherstellung fehlgeschlagen'`)).toBeTruthy();
    expect((await systemStatus()).services.find((s: any) => s.id === 'drill')).toMatchObject({ state: 'error' });
  });

  it('Notfall: Sicherung vom Ziel zurück auf den Server holen', async () => {
    const c = await one(`SELECT last_ok_file FROM backup_offsite`);
    await pool.query(`DELETE FROM backups WHERE file_name = $1`, [c.last_ok_file]);
    fs.rmSync(path.join(backupDir(), c.last_ok_file), { force: true });
    expect((await admin.post('/backups/offsite/fetch', { name: '../../etc/passwd' })).status).toBe(400);
    const f = await admin.post('/backups/offsite/fetch', { name: c.last_ok_file });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(fs.existsSync(path.join(backupDir(), c.last_ok_file))).toBe(true);
    const row = await one(`SELECT * FROM backups WHERE id = $1`, [f.json.id]);
    expect(row).toMatchObject({ status: 'ok', trigger: 'offsite', offsite_status: 'ok' });
    expect((await admin.post('/backups/offsite/fetch', { name: c.last_ok_file })).status).toBe(409);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'backup.offsite_fetched' AND result = 'ok'`)).toBeTruthy();
  });

  it('fehlerhaftes Ziel liefert mehr als die Datei: Holen bricht ab, nichts bleibt liegen (#240)', async () => {
    const c = await one(`SELECT last_ok_file FROM backup_offsite`);
    await pool.query(`DELETE FROM backups WHERE file_name = $1`, [c.last_ok_file]);
    fs.rmSync(path.join(backupDir(), c.last_ok_file), { force: true });
    oversizeGets = true;
    try {
      const f = await admin.post('/backups/offsite/fetch', { name: c.last_ok_file });
      expect(f.status).toBe(400);
      expect(f.json.message).toMatch(/größer als/);
    } finally {
      oversizeGets = false;
    }
    expect(fs.readdirSync(backupDir()).filter((n) => n.startsWith(c.last_ok_file))).toEqual([]);
    expect(await one(`SELECT 1 FROM backups WHERE file_name = $1`, [c.last_ok_file])).toBeNull();
    // wieder in Ordnung: Holen klappt
    expect((await admin.post('/backups/offsite/fetch', { name: c.last_ok_file })).status).toBe(200);
  });

  it('Volume-Sicherung vom Host: Prüfsumme muss passen, landet im Unterordner volume/ mit Aufbewahrung', async () => {
    const data = crypto.randomBytes(300_000);
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const name = 'blaulichtcms-2026-11-16-023000.tar.gz.enc';
    await expect(uploadVolumeStream(name, data.length, 'a'.repeat(64), Readable.from([data]))).rejects.toThrow(/Prüfsumme/);
    expect(files.has(`/sicherung/blaulichtcms/volume/${name}.part`)).toBe(false);
    const r = await uploadVolumeStream(name, data.length, sha, Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]));
    expect(r).toEqual({ removed: 0 });
    expect(files.get(`/sicherung/blaulichtcms/volume/${name}`)?.equals(data)).toBe(true);
    await expect(uploadVolumeStream('../x.tar.gz.enc', 1, sha, Readable.from([data]))).rejects.toThrow(/Dateiname/);
    const list = await admin.get('/backups/offsite/files');
    expect(list.json.volumes.map((f: any) => f.name)).toEqual([name]);
  });

  it('Probe-Verbindungen: vom Server beendete Verbindung bringt den Prozess nicht zu Fall (CI-Fehler 57P01)', async () => {
    // Ohne Fehler-Listener würfe pg-pool den Fehler einer ruhenden, vom Server beendeten Verbindung als ungefangene
    // Ausnahme (Vitest meldet sie als „Unhandled Error“, im Worker endete der Prozess)
    const p = openProbePool(config.adminDatabaseUrl);
    await p.query('SELECT 1');
    const killed = await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'blaulichtcms-drill' AND datname = current_database()`);
    expect(killed.rowCount).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect((await p.query('SELECT 2 AS n')).rows[0].n).toBe(2);
    await p.end();
  });

  it('Probedatenbank löschen: wartet auf die eigenen Verbindungen statt sie abzuschießen', async () => {
    const su = new pg.Client({ connectionString: config.adminDatabaseUrl });
    await su.connect();
    const name = 'blaulichtcms_probe_0a0b0c0d';
    await su.query(`CREATE DATABASE ${name}`);
    const p = openProbePool(probeUrl(config.adminDatabaseUrl, name));
    let poolErrors = 0;
    p.on('error', () => poolErrors++);
    await Promise.all([p.query('SELECT 1'), p.query('SELECT pg_sleep(0.05)')]);
    // end() meldet „fertig“, bevor die Verbindungen getrennt sind – sofort löschen wie in der Probe
    await p.end();
    await dropProbeDatabase(su, name);
    await new Promise((r) => setTimeout(r, 300));
    expect(poolErrors).toBe(0);
    expect((await su.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount).toBe(0);
    await expect(dropProbeDatabase(su, 'blaulichtcms')).rejects.toThrow(/Ungültiger Name/);
    await su.end();
  });

  it('Probe beendet nie fremde Verbindungen: laufende Datenbank und belegte alte Probe bleiben unberührt', async () => {
    const live = new pg.Client({ connectionString: config.adminDatabaseUrl, application_name: 'fremd-live' });
    await live.connect();
    const su = new pg.Client({ connectionString: config.adminDatabaseUrl });
    await su.connect();
    const old = 'blaulichtcms_probe_deadbeef';
    await su.query(`CREATE DATABASE ${old}`);
    const other = new pg.Client({ connectionString: probeUrl(config.adminDatabaseUrl, old), application_name: 'fremd-probe' });
    await other.connect();
    const errors: string[] = [];
    live.on('error', (e) => errors.push(`live: ${e.message}`));
    other.on('error', (e) => errors.push(`probe: ${e.message}`));
    const started = await admin.post('/backups/drills', { source: 'local' });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    await drain();
    const d = await one(`SELECT status, error FROM restore_drills WHERE id = $1`, [started.json.id]);
    expect(d.status, d.error).toBe('ok');
    await new Promise((r) => setTimeout(r, 300));
    expect(errors).toEqual([]);
    expect((await live.query('SELECT 1 AS n')).rows[0].n).toBe(1);
    expect((await other.query('SELECT 1 AS n')).rows[0].n).toBe(1);
    // Belegte alte Probe bleibt stehen; ist sie frei, räumt die nächste Probe sie weg
    expect((await su.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [old])).rowCount).toBe(1);
    await other.end();
    const again = await scheduleDrill('manual', null, { source: 'local' });
    await drain();
    expect((await one(`SELECT status FROM restore_drills WHERE id = $1`, [again.id])).status).toBe('ok');
    expect((await su.query(`SELECT 1 FROM pg_database WHERE datname LIKE 'blaulichtcms_probe_%'`)).rowCount).toBe(0);
    await live.end();
    await su.end();
  });

  it('Ausschalten: keine weiteren Übertragungen', async () => {
    const r = await admin.put('/backups/offsite', cfg({ enabled: false, password: undefined }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const b = await admin.post('/backups', {});
    expect((await one(`SELECT offsite_status FROM backups WHERE id = $1`, [b.json.id])).offsite_status).toBeNull();
    expect(await uploadVolumeStream('blaulichtcms-2026-11-17-023000.tar.gz.enc', 3, 'b'.repeat(64), Readable.from([Buffer.from('abc')]))).toBeNull();
    expect((await systemStatus()).services.find((s: any) => s.id === 'offsite')).toBeUndefined();
  });
});
