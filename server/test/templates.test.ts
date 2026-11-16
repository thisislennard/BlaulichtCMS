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
import { bundledFont } from '../src/templates/fonts.js';
import { processMedia } from '../src/media/process.js';
import { executeRun } from '../src/automations/engine.js';

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
let editor: Client;

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
  editor = await acceptInvite('redaktion@example.org', ['editor'], 'Robin');
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

describe('Befüllbare Bildvorlagen (#209)', () => {
  let tplId: string;
  let fontKey: string;
  let logoAsset: string;
  let photoId: string;
  let layout: any;

  /** Foto in eine Sammlung hochladen und wie der Worker prüfen */
  async function photo(collectionId: string) {
    const up = await admin.upload(`/collections/${collectionId}/media`, 'foto.jpg', await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2050a0' } }).jpeg().toBuffer(), 'image/jpeg');
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(await processMedia(up.json.media.id)).toBe('ready');
    return up.json.media.id as string;
  }

  it('Schriften: mitgelieferte sind da; eigene nur mit Lizenzangabe und Bestätigung, Inhalt muss eine Schrift sein', async () => {
    const list = await viewer.get('/design-fonts');
    expect(list.status).toBe(200);
    expect(list.json.fonts.filter((f: any) => f.bundled).length).toBeGreaterThanOrEqual(6);
    expect(list.json.formats.map((f: any) => `${f.width}x${f.height}`)).toEqual(expect.arrayContaining(['1080x1080', '1080x1350', '1080x1920', '1200x630']));
    const ttf = fs.readFileSync(bundledFont('atkinson-bold')!.file);
    const send = (fields: Record<string, string>, data = ttf, name = 'eigene.ttf') => {
      const boundary = `----bc${crypto.randomBytes(8).toString('hex')}`;
      const parts = [
        ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: font/ttf\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ];
      return admin.raw('POST', '/design-fonts', Buffer.concat(parts), { 'content-type': `multipart/form-data; boundary=${boundary}` });
    };
    expect((await send({ confirm: 'true' })).json.message).toMatch(/Lizenz/);
    expect((await send({ license: 'SIL Open Font License' })).json.message).toMatch(/bestätigen/);
    expect((await send({ license: 'OFL', confirm: 'true' }, Buffer.from('keine Schrift'))).status).toBe(400);
    const ok = await send({ license: 'SIL Open Font License 1.1', confirm: 'true' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ family: 'Atkinson Hyperlegible', weight: 700 });
    fontKey = ok.json.key;
    expect((await send({ license: 'OFL', confirm: 'true' })).status).toBe(409);
    expect((await viewer.get('/design-fonts')).json.fonts.find((f: any) => f.key === fontKey)).toMatchObject({ bundled: false, license: 'SIL Open Font License 1.1' });
  });

  it('Bildvorlage anlegen: Story-Format mit Startlayout und Vorschaubild', async () => {
    const r = await editor.post('/design-templates', { title: 'Story Übung', kind: 'image', width: 1080, height: 1920, tags: ['Story'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    tplId = r.json.id;
    const d = (await viewer.get(`/design-templates/${tplId}`)).json;
    expect(d.kind).toBe('image');
    expect(d.layout).toMatchObject({ width: 1080, height: 1920 });
    expect(d.layout.elements.map((e: any) => e.type)).toEqual(['image', 'text', 'text']);
    expect(d.has_preview).toBe(true);
    layout = d.layout;
  });

  it('Bilder der Vorlage: SVG-Logo wird bereinigt; Layout prüft Schriften und Bilder', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" onload="alert(1)"><script>alert(1)</script><rect width="200" height="100" fill="#ffffff"/></svg>`;
    const a = await editor.upload(`/design-templates/${tplId}/assets`, 'logo.svg', Buffer.from(svg), 'image/svg+xml');
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    logoAsset = a.json.id;
    const got = await viewer.get(`/design-templates/${tplId}/assets/${logoAsset}`);
    expect(got.raw.toString()).not.toMatch(/script|onload/);
    layout = {
      ...layout,
      elements: [...layout.elements.map((e: any) => (e.id === 'titel' ? { ...e, font: fontKey, minSize: 60, maxLines: 2 } : e)), { id: 'logo', type: 'logo', label: 'Logo', x: 40, y: 40, w: 200, h: 100, assetId: logoAsset }],
    };
    expect((await editor.raw('PUT', `/design-templates/${tplId}/layout`, { layout: { ...layout, elements: [{ ...layout.elements[1], font: 'gibt-es-nicht' }] } })).status).toBe(400);
    expect((await editor.raw('PUT', `/design-templates/${tplId}/layout`, { layout: { ...layout, elements: [{ id: 'l', type: 'logo', label: 'Fremd', x: 0, y: 0, w: 10, h: 10, assetId: crypto.randomUUID() }] } })).status).toBe(400);
    expect((await viewer.raw('PUT', `/design-templates/${tplId}/layout`, { layout })).status).toBe(403);
    const saved = await editor.raw('PUT', `/design-templates/${tplId}/layout`, { layout });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // Schrift in Verwendung lässt sich nicht löschen
    expect((await admin.del(`/design-fonts/${fontKey.slice(7)}`)).status).toBe(409);
  });

  it('Vorschau im Editor und beim Ausfüllen (JPEG); gekürzte Texte werden gemeldet; Rechte', async () => {
    const lp = await editor.post(`/design-templates/${tplId}/layout-preview`, { layout, values: { titel: 'Kurz' } });
    expect(lp.status).toBe(200);
    expect(lp.headers['content-type']).toBe('image/jpeg');
    expect((await viewer.post(`/design-templates/${tplId}/fill-preview`, { values: {} })).status).toBe(403);
    const long = await editor.post(`/design-templates/${tplId}/fill-preview`, { values: { titel: 'Sehr langer Titel '.repeat(30) } });
    expect(long.status).toBe(200);
    expect(long.headers['x-text-truncated']).toBe('titel');
    const short = await editor.post(`/design-templates/${tplId}/fill-preview`, { values: { titel: 'Übung' } });
    expect(short.headers['x-text-truncated']).toBe('');
    const meta = await sharp(short.raw).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.height).toBe(900);
  });

  it('Erzeugen: Bild mit Foto landet geprüft und ausgewählt in „Bilder aus Vorlagen“, mit Alternativtext', async () => {
    const col = await admin.post('/collections', { title: 'Fotos Übung', createLink: false });
    photoId = await photo(col.json.collection.id);
    const g = await editor.post(`/design-templates/${tplId}/generate`, { values: { titel: 'Großübung am Samstag', text: 'Sa., 21.11. · 10 Uhr' }, images: { foto: { mediaId: photoId, focusX: 0.3, zoom: 1.5 } }, altText: 'Großübung am Samstag, 21.11. um 10 Uhr' });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(g.json.media).toMatchObject({ status: 'ready', kind: 'image', width: 1080, height: 1920, selection: 'selected', alt_text: 'Großübung am Samstag, 21.11. um 10 Uhr' });
    expect(g.json.collection.title).toBe('Bilder aus Vorlagen');
    const sys = await one<any>(`SELECT id FROM collections WHERE system_key = 'design-templates'`);
    expect(sys!.id).toBe(g.json.collection.id);
    expect((await admin.get(`/media/${g.json.media.id}/preview`)).status).toBe(200);
    // zweites Bild: dieselbe Systemsammlung
    const g2 = await editor.post(`/design-templates/${tplId}/generate`, { values: {}, images: {} });
    expect(g2.json.collection.id).toBe(sys!.id);
    expect((await many<any>(`SELECT action FROM audit_events WHERE action = 'design_template.image_generated'`)).length).toBe(2);
  });

  it('Beitragseditor: Bild landet in der Sammlung des Beitrags; Pflicht-Bild und fremde Medien werden geprüft', async () => {
    const p = await editor.post('/posts', { title: 'Einladung zur Übung', kind: 'event' });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const postId = p.json.id ?? p.json.post?.id;
    const col = await admin.post('/collections', { title: 'Beitragsfotos', postId, createLink: false });
    const g = await editor.post(`/design-templates/${tplId}/generate`, { values: { titel: 'Einladung' }, images: { foto: { mediaId: photoId } }, postId });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(g.json.collection.id).toBe(col.json.collection.id);
    // Bild-Platzhalter als Pflicht → ohne Bild abgelehnt
    const req = { ...layout, elements: layout.elements.map((e: any) => (e.type === 'image' ? { ...e, required: true } : e)) };
    expect((await editor.raw('PUT', `/design-templates/${tplId}/layout`, { layout: req })).status).toBe(200);
    const missing = await editor.post(`/design-templates/${tplId}/generate`, { values: {}, images: {} });
    expect(missing.status).toBe(400);
    expect(missing.json.message).toMatch(/Bild wählen/);
    expect((await editor.post(`/design-templates/${tplId}/generate`, { values: {}, images: { foto: { mediaId: crypto.randomUUID() } } })).status).toBe(400);
    // Dateivorlage lässt sich nicht befüllen
    const files = await editor.post('/design-templates', { title: 'Nur Dateien' });
    expect((await editor.post(`/design-templates/${files.json.id}/generate`, { values: {} })).status).toBe(400);
  });
});

describe('Workflows: Bild aus Vorlage erzeugen (#210)', () => {
  it('Testlauf zeigt eine Vorschau ohne etwas anzulegen; aktiver Lauf legt Bild und Beitrag mit Bild an', async () => {
    const tpl = await admin.post('/design-templates', { title: 'Story Termin', kind: 'image', width: 1080, height: 1920 });
    expect(tpl.status).toBe(200);
    // Katalog nennt die Bildvorlage samt Textfeldern
    const cat = await admin.get('/automations/catalog');
    const entry = cat.json.imageTemplates.find((t: any) => t.id === tpl.json.id);
    expect(entry.texts.map((x: any) => x.id)).toEqual(['titel', 'text']);
    expect(cat.json.nodeTypes.some((t: any) => t.type === 'image')).toBe(true);

    const input = await admin.post('/automation-inputs', { name: 'Termin von Hand', kind: 'manual', config: { fields: [{ key: 'titel', label: 'Titel', example: 'Übung' }, { key: 'beginn', label: 'Beginn', example: 'Sa., 10 Uhr' }] } });
    expect(input.status, JSON.stringify(input.json)).toBe(200);
    const output = await admin.post('/automation-outputs', { name: 'Beitrag Termin', kind: 'post', config: { kind: 'event', title: '{{titel}}', body: 'Beginn: {{beginn}}' } });
    expect(output.status, JSON.stringify(output.json)).toBe(200);
    const au = await admin.post('/automations', { name: 'Termin mit Bild', description: '' });
    const d = await admin.get(`/automations/${au.json.id}`);
    const graph = {
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { inputId: input.json.id } },
        { id: 'img', type: 'image', position: { x: 320, y: 0 }, data: { templateId: tpl.json.id, texts: { titel: '{{titel}}', text: 'Beginn: {{beginn}}' }, altText: '{{titel}} – {{beginn}}' } },
        { id: 'out', type: 'output', position: { x: 640, y: 0 }, data: { outputId: output.json.id } },
      ],
      edges: [
        { id: 'e1', source: 'in', sourceHandle: 'out', target: 'img' },
        { id: 'e2', source: 'img', sourceHandle: 'out', target: 'out' },
      ],
    };
    const saved = await admin.raw('PUT', `/automations/${au.json.id}`, { name: 'Termin mit Bild', description: '', graph, baseHash: d.json.draft_hash });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const mediaBefore = (await one<any>(`SELECT count(*)::int AS n FROM media`))!.n;
    const test = await admin.post(`/automations/${au.json.id}/test`, { payload: { titel: 'Großübung', beginn: 'Sa., 10 Uhr' } });
    expect(test.status, JSON.stringify(test.json)).toBe(200);
    expect(test.json.status, JSON.stringify(test.json.steps)).toBe('succeeded');
    const step = test.json.steps.find((s: any) => s.node_id === 'img');
    expect(step.info).toMatch(/Testlauf: würde ein Bild aus „Story Termin“/);
    expect(step.output.log).toMatchObject({ vorschau: true, texte: { titel: 'Großübung', text: 'Beginn: Sa., 10 Uhr' } });
    expect(test.json.steps.find((s: any) => s.node_id === 'out').info).toMatch(/mit dem Bild aus der Vorlage/);
    const prev = await admin.get(`/automation-runs/${test.json.id}/image-preview/img`);
    expect(prev.status).toBe(200);
    expect(prev.headers['content-type']).toBe('image/jpeg');
    expect((await warnAuthor.get(`/automation-runs/${test.json.id}/image-preview/img`)).status).toBe(403);
    expect((await one<any>(`SELECT count(*)::int AS n FROM media`))!.n).toBe(mediaBefore);

    // Aktiv: manueller Start → Bild in den Medien, Beitrag mit Bild als Titelbild und Alternativtext
    expect((await admin.post(`/automations/${au.json.id}/activate`)).status).toBe(200);
    const run = await admin.post(`/automations/${au.json.id}/run`, { inputNodeId: 'in', payload: { titel: 'Übung Nord', beginn: 'So., 9 Uhr' } });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(await executeRun(run.json.runId)).toBe('succeeded');
    const detail = await admin.get(`/automation-runs/${run.json.runId}`);
    const img = detail.json.steps.find((s: any) => s.node_id === 'img');
    const mediaId = img.output.produced.bild_id;
    expect(mediaId).toMatch(/^[0-9a-f-]{36}$/);
    const m = await one<any>(`SELECT status, kind, alt_text, selection, width, height FROM media WHERE id = $1`, [mediaId]);
    expect(m).toMatchObject({ status: 'ready', kind: 'image', alt_text: 'Übung Nord – So., 9 Uhr', selection: 'selected', width: 1080, height: 1920 });
    const post = await one<any>(`SELECT r.media_ids, r.cover_id, r.media_alt FROM post_revisions r JOIN posts p ON p.id = r.post_id WHERE p.title = 'Übung Nord'`);
    expect(post!.media_ids).toEqual([mediaId]);
    expect(post!.cover_id).toBe(mediaId);
    expect(post!.media_alt).toEqual({ [mediaId]: 'Übung Nord – So., 9 Uhr' });
  });
});
