import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { claimJobs, completeJob } from '../src/jobs/queue.js';
import { backupDir } from '../src/ops/backup.js';
import { uploadBackup, uploadVolumeStream } from '../src/ops/offsite.js';
import { runDrill } from '../src/ops/drill.js';
import { checkSmbAccount, parseSmbLs, parseUnc, smbQuote } from '../src/ops/smb.js';

/**
 * Sicherung außer Haus auf eine SMB-Freigabe (smbclient) gegen eine echte PostgreSQL-Datenbank.
 *
 * - Lokal (ohne smbclient, z. B. Windows): ein Stellvertreter (test/fixtures/fake-smbclient.mjs) spielt die Freigabe
 *   auf einem Ordner.
 * - In der CI mit echtem Samba-Server und echtem smbclient, wenn gesetzt: BLAULICHTCMS_SMB_TEST_SHARE (\\server\freigabe),
 *   BLAULICHTCMS_SMB_TEST_LOCAL (Ordner der Freigabe auf diesem Rechner), BLAULICHTCMS_SMB_TEST_USER/_PASSWORD.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = !!process.env.BLAULICHTCMS_SMB_TEST_SHARE;
let SHARE = '';
let LOCAL = '';
let USER = '';
let DOMAIN = '';
let PASS = '';
let logFile = '';

describe('SMB: Bausteine', () => {
  it('UNC-Pfad: Server, Freigabe, Ordner; auch mit „/“ oder smb://; unzulässige Zeichen abgewiesen', () => {
    expect(parseUnc('\\\\10.112.10.50\\dfs\\Backups\\BlaulichtCMS\\')).toEqual({ url: '\\\\10.112.10.50\\dfs\\Backups\\BlaulichtCMS', server: '10.112.10.50', share: 'dfs', dir: ['Backups', 'BlaulichtCMS'] });
    expect(parseUnc('//nas.example.org/Sicherung').url).toBe('\\\\nas.example.org\\Sicherung');
    expect(parseUnc('smb://nas/Sicherung/Feuerwehr Archiv').dir).toEqual(['Feuerwehr Archiv']);
    expect(parseUnc('\\\\nas\\Freigabe$\\Übergabe').share).toBe('Freigabe$');
    expect(() => parseUnc('nas\\freigabe')).toThrow(/UNC-Pfad/);
    expect(() => parseUnc('\\\\nas')).toThrow(/Freigabe/);
    expect(() => parseUnc('\\\\nas;rm\\x')).toThrow(/Servername/);
    expect(() => parseUnc('\\\\nas\\x\\a;put b')).toThrow(/Ordnername/);
    expect(() => parseUnc('\\\\nas\\x\\..\\y')).toThrow(/Ordnername/);
    expect(() => parseUnc('\\\\nas\\x\\"q"')).toThrow(/Ordnername/);
  });

  it('Konto: kein „%“, Domäne nicht doppelt; Skriptwerte ohne Trennzeichen', () => {
    expect(() => checkSmbAccount('feuerwehr.example', 'sicherung')).not.toThrow();
    expect(() => checkSmbAccount('', 'FW\\sicherung')).not.toThrow();
    expect(() => checkSmbAccount('FW', 'FW\\sicherung')).toThrow(/nicht in beiden/);
    expect(() => checkSmbAccount('', 'name%passwort')).toThrow(/Benutzername/);
    expect(() => checkSmbAccount('a;b', 'x')).toThrow(/Domäne/);
    expect(smbQuote('blaulichtcms-2026-11-19-03-00-00-abcdef.bcbk')).toBe('"blaulichtcms-2026-11-19-03-00-00-abcdef.bcbk"');
    expect(() => smbQuote('a"; del *')).toThrow();
    expect(() => smbQuote('x; y')).toThrow();
  });

  it('liest die Ausgabe von ls (Datei, Ordner, Leerzeilen, Platzangabe)', () => {
    const out = [
      '  .                                   D        0  Wed Nov 19 10:00:00 2026',
      '  ..                                  D        0  Wed Nov 19 10:00:00 2026',
      '  blaulichtcms-2026-11-19-22-30-01-abcdef.bcbk      A  1234567  Wed Nov 19 22:30:01 2026',
      '  volume                              D        0  Tue Nov  4 08:05:09 2026',
      '',
      '\t\t12345678 blocks of size 1024. 1234567 blocks available',
    ].join('\n');
    const files = parseSmbLs(out);
    expect(files.map((f) => [f.name, f.size, f.directory])).toEqual([
      ['blaulichtcms-2026-11-19-22-30-01-abcdef.bcbk', 1234567, false],
      ['volume', 0, true],
    ]);
    expect(files[0].modified).toMatch(/^2026-11-19T/);
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */

let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';

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
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
}

let admin: Client;
const freshReauth = () => pool.query(`UPDATE sessions SET reauth_at = now()`);
/** Zielordner: Unterordner „Sicherung“ gibt es, „BlaulichtCMS“ legt der Test an */
const unc = () => `${SHARE}\\Sicherung\\BlaulichtCMS`;
const localDir = () => path.join(LOCAL, 'Sicherung', 'BlaulichtCMS');
const cfg = (over: Record<string, unknown> = {}) => ({ kind: 'smb', url: unc(), domain: DOMAIN, username: USER, password: PASS, enabled: true, keepDaily: 2, keepWeekly: 0, keepMonthly: 0, drillInterval: 'weekly', ...over });

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

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  if (REAL) {
    SHARE = process.env.BLAULICHTCMS_SMB_TEST_SHARE!;
    LOCAL = process.env.BLAULICHTCMS_SMB_TEST_LOCAL!;
    USER = process.env.BLAULICHTCMS_SMB_TEST_USER ?? '';
    PASS = process.env.BLAULICHTCMS_SMB_TEST_PASSWORD ?? '';
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smb-'));
    LOCAL = path.join(root, 'bctest');
    SHARE = '\\\\nas.example\\bctest';
    USER = 'sicherung';
    DOMAIN = 'feuerwehr.example';
    PASS = 'Freigabe-Passwort-2026!';
    logFile = path.join(root, 'aufrufe.log');
    Object.assign(process.env, {
      BLAULICHTCMS_SMBCLIENT_FAKE: path.join(here, 'fixtures', 'fake-smbclient.mjs'),
      FAKE_SMB_ROOT: root,
      FAKE_SMB_SERVER: 'nas.example',
      FAKE_SMB_USER: `${DOMAIN}\\${USER}`,
      FAKE_SMB_PASS: PASS,
      FAKE_SMB_LOG: logFile,
    });
  }
  fs.mkdirSync(path.join(LOCAL, 'Sicherung'), { recursive: true });
  fs.rmSync(localDir(), { recursive: true, force: true });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
  if (!REAL) fs.rmSync(path.dirname(LOCAL), { recursive: true, force: true });
});

describe(`Sicherung außer Haus auf eine SMB-Freigabe (${REAL ? 'echter Samba-Server' : 'Stellvertreter'})`, () => {
  it('richtet das Konto ein', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
  });

  it('Verbindungstest: falsches Passwort erkannt; richtiges legt den Ordner an und räumt die Probedatei weg', async () => {
    const bad = await admin.post('/backups/offsite/test', { kind: 'smb', url: unc(), domain: DOMAIN, username: USER, password: 'falsch' });
    expect(bad.status).toBe(200);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/Anmeldung abgelehnt/);
    const invalid = await admin.post('/backups/offsite/test', { kind: 'smb', url: 'https://nas/x', username: USER, password: PASS });
    expect(invalid.status).toBe(400);
    const ok = await admin.post('/backups/offsite/test', { kind: 'smb', url: unc(), domain: DOMAIN, username: USER, password: PASS });
    expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
    expect(ok.json.steps.map((s: any) => s.step)).toEqual(['Ordner angelegt', 'Anmeldung, Freigabe und Ordner', 'Probedatei schreiben', 'Zurücklesen und Prüfsumme vergleichen', 'Probedatei löschen']);
    expect(fs.existsSync(localDir())).toBe(true);
    expect(fs.readdirSync(localDir())).toEqual([]);
    expect(fs.readdirSync(backupDir()).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('Einschalten mit Passwortbestätigung und Test; Passwort nie auf der Kommandozeile oder im Klartext gespeichert', async () => {
    await freshReauth();
    const r = await admin.put('/backups/offsite', cfg());
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.config).toMatchObject({ enabled: true, kind: 'smb', url: unc().replace(/\\+$/, ''), domain: DOMAIN, username: USER, password_set: true });
    expect(JSON.stringify(r.json)).not.toContain(PASS);
    expect(JSON.stringify(await many(`SELECT * FROM backup_offsite`))).not.toContain(PASS);
    if (logFile) {
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).not.toContain(PASS);
      expect(log).toContain('"-U","feuerwehr.example\\\\sicherung"');
    }
    // Gespeichertes Passwort nur für dieselbe Art, denselben Server und dasselbe Konto
    const otherServer = await admin.post('/backups/offsite/test', { kind: 'smb', url: '\\\\anderer.example\\bctest\\x', domain: DOMAIN, username: USER });
    expect(otherServer.status).toBe(400);
    expect(otherServer.json.message).toMatch(/Passwort neu eingeben/);
    const otherUser = await admin.post('/backups/offsite/test', { kind: 'smb', url: unc(), domain: DOMAIN, username: 'jemand' });
    expect(otherUser.status).toBe(400);
    const otherKind = await admin.post('/backups/offsite/test', { kind: 'webdav', url: 'https://nas.example/x/', username: USER });
    expect(otherKind.status).toBe(400);
    // ohne Passwort, gleiches Ziel: gespeichertes wird verwendet
    const same = await admin.post('/backups/offsite/test', { kind: 'smb', url: unc(), domain: DOMAIN, username: USER });
    expect(same.json.ok, JSON.stringify(same.json)).toBe(true);
  });

  it('nach jeder Sicherung: hochladen, Prüfsumme kontrollieren, umbenennen, Aufbewahrung – fremde Dateien bleiben', async () => {
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) fs.writeFileSync(path.join(localDir(), `blaulichtcms-${d}-03-00-00-aaaaaa.bcbk`), 'alt');
    fs.writeFileSync(path.join(localDir(), 'notizen.txt'), 'fremd');
    const b = await admin.post('/backups', {});
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    await drain();
    const row = await one<any>(`SELECT * FROM backups WHERE id = $1`, [b.json.id]);
    expect(row.offsite_status, row.offsite_error).toBe('ok');
    const remote = fs.readFileSync(path.join(localDir(), row.file_name));
    expect(sha(remote)).toBe(row.sha256);
    const names = fs.readdirSync(localDir());
    expect(names.some((n) => n.endsWith('.part'))).toBe(false);
    expect(names).toContain('notizen.txt');
    expect(names).toContain('blaulichtcms-2026-01-03-03-00-00-aaaaaa.bcbk');
    expect(names).not.toContain('blaulichtcms-2026-01-01-03-00-00-aaaaaa.bcbk');
    const list = await admin.get('/backups/offsite/files');
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.files.map((f: any) => f.name)).toContain(row.file_name);
    expect(list.json.files.find((f: any) => f.name === row.file_name).size).toBe(remote.length);
    expect(list.json.files.map((f: any) => f.name)).not.toContain('notizen.txt');
    expect(list.json.volumes).toEqual([]);
  });

  it('Probe-Wiederherstellung von der Freigabe', async () => {
    await freshReauth();
    const r = await admin.post('/backups/drills', { source: 'offsite' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await drain();
    const d = await one<any>(`SELECT * FROM restore_drills WHERE id = $1`, [r.json.id]);
    expect(d.status, d.error).toBe('ok');
    expect(d.source).toBe('offsite');
  });

  it('Notfall: Sicherung von der Freigabe zurück auf den Server holen', async () => {
    const row = await one<any>(`SELECT * FROM backups WHERE offsite_status = 'ok' ORDER BY finished_at DESC LIMIT 1`);
    fs.rmSync(path.join(backupDir(), row.file_name));
    const r = await admin.post('/backups/offsite/fetch', { name: row.file_name });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(sha(fs.readFileSync(path.join(backupDir(), row.file_name)))).toBe(row.sha256);
    expect((fs.statSync(path.join(backupDir(), row.file_name)).mode & 0o077) === 0 || process.platform === 'win32').toBe(true);
  });

  it('Volume-Sicherung vom Host: Größe und Prüfsumme müssen passen, landet in volume\\ ohne Reste', async () => {
    const data = crypto.randomBytes(300_000);
    const name = 'blaulichtcms-2026-11-19-031500.tar.gz.enc';
    await expect(uploadVolumeStream(name, data.length, 'a'.repeat(64), Readable.from([data]))).rejects.toThrow(/Größe bzw. Prüfsumme/);
    const r = await uploadVolumeStream(name, data.length, sha(data), Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]));
    expect(r).toEqual({ removed: 0 });
    expect(sha(fs.readFileSync(path.join(localDir(), 'volume', name)))).toBe(sha(data));
    expect(fs.readdirSync(path.join(localDir(), 'volume')).filter((n) => n.endsWith('.part'))).toEqual([]);
    expect(fs.readdirSync(backupDir()).filter((f) => f.startsWith('.'))).toEqual([]);
    const list = await admin.get('/backups/offsite/files');
    expect(list.json.volumes.map((f: any) => f.name)).toEqual([name]);
  });

  it.skipIf(REAL)('beschädigte Rückleseprobe: Übertragung scheitert, nichts bleibt als Sicherung liegen', async () => {
    process.env.FAKE_SMB_CORRUPT = '1';
    try {
      const b = await admin.post('/backups', {});
      await drain();
      const row = await one<any>(`SELECT * FROM backups WHERE id = $1`, [b.json.id]);
      expect(row.offsite_status).toBe('failed');
      expect(row.offsite_error).toMatch(/Prüfsumme/);
      expect(fs.readdirSync(localDir())).not.toContain(row.file_name);
      expect(fs.readdirSync(localDir()).some((n) => n.endsWith('.part'))).toBe(false);
    } finally {
      delete process.env.FAKE_SMB_CORRUPT;
    }
  });

  it('Ausschalten und Sicherungen auf der Freigabe löschen – nur Dateien von BlaulichtCMS', async () => {
    await freshReauth();
    const off = await admin.put('/backups/offsite', { ...cfg({ password: undefined }), enabled: false, oldTarget: 'delete' });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json.config.enabled).toBe(false);
    expect(fs.readdirSync(localDir()).filter((n) => n.startsWith('blaulichtcms-'))).toEqual([]);
    expect(fs.readdirSync(path.join(localDir(), 'volume'))).toEqual([]);
    expect(fs.readdirSync(localDir())).toContain('notizen.txt');
    const audit = await many<any>(`SELECT * FROM audit_events WHERE action LIKE 'backup.offsite%' ORDER BY at`);
    expect(audit.length).toBeGreaterThan(2);
    expect(JSON.stringify(audit)).not.toContain(PASS);
  });
});
