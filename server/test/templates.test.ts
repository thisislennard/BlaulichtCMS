import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { templatePaths } from '../src/templates/files.js';

/**
 * Designvorlagen (#208–#210) gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL): Bibliothek mit Kategorien,
 * Formaten, Versionen, Download-Zähler, Rechten und sicherer SVG-Behandlung. Die Datenbank wird zu Beginn geleert.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await this.app.inject({
      method: method as any,
      url: `/api/v1${url}`,
      payload: body === undefined ? undefined : isBuf ? (body as Buffer) : JSON.stringify(body),
      headers: { ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
  del = (u: string) => this.raw('DELETE', u, {});
  upload(u: string, name: string, data: Buffer, type = 'application/octet-stream') {
    const boundary = `----bc${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return this.raw('POST', u, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  }
}

let admin: Client;
let viewer: Client;
let warnAuthor: Client;

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return c;
}

const png = (w = 64, h = 48, color = '#c00000') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
  const { ensureSetupToken } = await import('../src/routes/auth.js');
  await ensureSetupToken();
  const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
  expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
  expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
  viewer = await acceptInvite('lesen@example.org', ['viewer'], 'Lea');
  warnAuthor = await acceptInvite('warn@example.org', ['warning_author'], 'Wim');
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Designvorlagen: Bibliothek (#208)', () => {
  let tplId: string;
  let catId: string;
  let pngFile: string;
  let v1Png: string;

  it('Rechte: Lesezugriff sieht die Bibliothek, darf aber nichts ändern; ohne Recht kein Zugriff', async () => {
    expect((await viewer.get('/design-templates')).status).toBe(200);
    expect((await viewer.post('/design-templates', { title: 'Nicht erlaubt' })).status).toBe(403);
    expect((await viewer.post('/design-template-categories', { name: 'Social' })).status).toBe(403);
    expect((await warnAuthor.get('/design-templates')).status).toBe(403);
    expect((await new Client(app).get('/design-templates')).status).toBe(401);
  });

  it('Kategorien anlegen (eindeutiger Name), Vorlage mit Hinweisen und Schlagworten anlegen', async () => {
    const c = await admin.post('/design-template-categories', { name: 'Social Media' });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    catId = c.json.id;
    expect((await admin.post('/design-template-categories', { name: 'social media' })).status).toBe(409);
    const t = await admin.post('/design-templates', { title: 'Logo der Organisation', description: 'Logo in allen Formaten', usageNote: 'Nur unverändert verwenden.', categoryId: catId, tags: ['Logo', 'logo', 'Druck'] });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    tplId = t.json.id;
    const d = await viewer.get(`/design-templates/${tplId}`);
    expect(d.json).toMatchObject({ title: 'Logo der Organisation', usage_note: 'Nur unverändert verwenden.', category: { id: catId, name: 'Social Media' }, tags: ['logo', 'Druck'], current_version: 1, has_preview: false });
    expect(d.json.versions).toHaveLength(1);
  });

  it('Dateien: Endung und Inhalt müssen passen; PNG erzeugt automatisch ein Vorschaubild', async () => {
    const bad = await admin.upload(`/design-templates/${tplId}/files`, 'logo.png', Buffer.from('%PDF-1.7 kein PNG'));
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/passt nicht/);
    const exe = await admin.upload(`/design-templates/${tplId}/files`, 'tool.exe', Buffer.from('MZ....'));
    expect(exe.status).toBe(400);
    expect(exe.json.message).toMatch(/nicht erlaubt/);
    const ok = await admin.upload(`/design-templates/${tplId}/files`, 'logo.png', await png(), 'image/png');
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.format).toBe('png');
    pngFile = ok.json.id;
    v1Png = pngFile;
    const pdf = await admin.upload(`/design-templates/${tplId}/files`, 'logo.pdf', Buffer.from('%PDF-1.7\n%%EOF\n'));
    expect(pdf.status).toBe(200);
    const zip = await admin.upload(`/design-templates/${tplId}/files`, 'logo-offen.idml', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]));
    expect(zip.status).toBe(200);
    expect(fs.existsSync(templatePaths.preview(tplId))).toBe(true);
    const list = await viewer.get('/design-templates');
    const item = list.json.templates.find((x: any) => x.id === tplId);
    expect(item.has_preview).toBe(true);
    expect(item.formats.map((f: any) => f.key).sort()).toEqual(['pdf', 'png', 'zip']);
    const prev = await viewer.get(`/design-templates/${tplId}/preview`);
    expect(prev.status).toBe(200);
    expect(prev.headers['content-type']).toBe('image/webp');
  });

  it('SVG wird bereinigt (Skripte, Ereignisse, externe Verweise) und mit Sandbox ausgeliefert; DOCTYPE wird abgelehnt', async () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40" onload="alert(1)"><script>alert(2)</script><rect width="40" height="40" fill="red" style="fill:url(https://evil.example/x)"/><image xlink:href="https://evil.example/a.png"/><foreignObject><p>x</p></foreignObject><a href="javascript:alert(3)"><text y="20">Hallo</text></a></svg>`;
    const r = await admin.upload(`/design-templates/${tplId}/files`, 'logo.svg', Buffer.from(evil), 'image/svg+xml');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const dl = await viewer.get(`/design-templates/files/${r.json.id}`);
    expect(dl.status).toBe(200);
    const text = dl.raw.toString('utf8');
    expect(text).toContain('<rect');
    expect(text).toContain('Hallo');
    for (const bad of ['script', 'onload', 'evil.example', 'foreignObject', 'javascript:']) expect(text, bad).not.toContain(bad);
    expect(dl.headers['content-security-policy']).toMatch(/sandbox/);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect((await admin.upload(`/design-templates/${tplId}/files`, 'xxe.svg', Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'))).status).toBe(400);
  });

  it('Download zählt je Datei und Vorlage; Name bleibt erhalten', async () => {
    const before = (await viewer.get(`/design-templates/${tplId}`)).json.download_count;
    const dl = await viewer.get(`/design-templates/files/${pngFile}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('logo.png');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    const d = (await viewer.get(`/design-templates/${tplId}`)).json;
    expect(d.download_count).toBe(before + 1);
    expect(d.versions[0].files.find((f: any) => f.id === pngFile).download_count).toBe(1);
  });

  it('Versionen: neue Version ist leer und aktuell, ältere bleiben abrufbar und unveränderlich', async () => {
    const v = await admin.post(`/design-templates/${tplId}/versions`, { note: 'Neues Logo 2026' });
    expect(v.json.number).toBe(2);
    const blue = await admin.upload(`/design-templates/${tplId}/files`, 'logo-2026.png', await png(80, 40, '#0040c0'), 'image/png');
    expect(blue.status).toBe(200);
    const d = (await viewer.get(`/design-templates/${tplId}`)).json;
    expect(d.current_version).toBe(2);
    expect(d.versions.map((x: any) => [x.number, x.current, x.files.length])).toEqual([
      [2, true, 1],
      [1, false, 4],
    ]);
    expect(d.versions[0].note).toBe('Neues Logo 2026');
    // ältere Version: abrufbar, aber nicht änderbar
    expect((await viewer.get(`/design-templates/files/${v1Png}`)).status).toBe(200);
    expect((await admin.del(`/design-templates/files/${v1Png}`)).status).toBe(409);
    expect((await admin.del(`/design-templates/files/${blue.json.id}`)).status).toBe(200);
  });

  it('Suche und Filter nach Text, Schlagwort, Kategorie und Format', async () => {
    const other = await admin.post('/design-templates', { title: 'Plakat Tag der offenen Tür', tags: ['Veranstaltung'] });
    expect(other.status).toBe(200);
    const ids = async (qs: string) => (await viewer.get(`/design-templates${qs}`)).json.templates.map((t: any) => t.title);
    expect(await ids('?q=druck')).toEqual(['Logo der Organisation']);
    expect(await ids('?q=Veranstaltung')).toEqual(['Plakat Tag der offenen Tür']);
    expect(await ids(`?category=${catId}`)).toEqual(['Logo der Organisation']);
    expect(await ids('?category=none')).toEqual(['Plakat Tag der offenen Tür']);
    expect(await ids('?q=%25')).toEqual([]);
  });

  it('Eigenes Vorschaubild, Kategorie löschen lässt Vorlage bestehen, Löschen entfernt Dateien; alles im Audit', async () => {
    const up = await admin.upload(`/design-templates/${tplId}/preview`, 'vorschau.jpg', await sharp({ create: { width: 30, height: 30, channels: 3, background: '#00ff00' } }).jpeg().toBuffer(), 'image/jpeg');
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect((await viewer.get(`/design-templates/${tplId}`)).json.preview_source).toBe('upload');
    expect((await admin.del(`/design-template-categories/${catId}`)).status).toBe(200);
    expect((await viewer.get(`/design-templates/${tplId}`)).json.category).toBeNull();
    const files = await many<any>(`SELECT id FROM design_template_files WHERE template_id = $1`, [tplId]);
    expect(files.length).toBeGreaterThan(0);
    expect((await admin.del(`/design-templates/${tplId}`)).status).toBe(200);
    for (const f of files) expect(fs.existsSync(templatePaths.file(f.id))).toBe(false);
    expect(fs.existsSync(templatePaths.preview(tplId))).toBe(false);
    const actions = (await many<any>(`SELECT action FROM audit_events WHERE action LIKE 'design_template.%'`)).map((a) => a.action);
    for (const a of ['design_template.created', 'design_template.file_uploaded', 'design_template.version_created', 'design_template.file_deleted', 'design_template.preview_uploaded', 'design_template.category_deleted', 'design_template.deleted']) expect(actions).toContain(a);
    expect(await one(`SELECT 1 FROM design_templates WHERE id = $1`, [tplId])).toBeNull();
  });
});
