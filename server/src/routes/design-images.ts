import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { SizeLimitError, streamToTemp } from '../media/storage.js';
import { cleanFileName, detectFormat, ensureDir, sanitizeSvg, SvgRejected } from '../templates/files.js';
import { customFontDir, customFontPath, FontRejected, readFontInfo } from '../templates/fonts.js';
import { FORMAT_PRESETS, layoutSchema, type Layout } from '../templates/layout.js';
import { assetPath, cleanLayout, cleanValues, generateIntoMedia, invalidateFonts, loadFonts, previewJpeg, refreshImagePreview, renderFromTemplate, resolveImages } from '../templates/images.js';
import { malwareCheck } from './design-templates.js';
import { sendFileResponse } from './files.js';

/*
 * Befüllbare Bildvorlagen (#209): Schriften, Bilder der Vorlage, Layout-Editor mit Live-Vorschau, Ausfüllen mit
 * Vorschau und Erzeugen in die Medien (auch aus dem Beitragseditor).
 */

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_FONT_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_ASSET_EDGE = 4000;

const imageChoice = z.object({ mediaId: z.uuid(), focusX: z.number().min(0).max(1).default(0.5), focusY: z.number().min(0).max(1).default(0.5), zoom: z.number().min(1).max(4).default(1) });
const fillBody = z.object({
  values: z.record(z.string(), z.string().max(2000)).default({}),
  images: z.record(z.string(), imageChoice.nullable()).default({}),
});

async function imageTemplate(id: string): Promise<{ t: any; layout: Layout }> {
  const t = await one<any>(`SELECT id, title, kind, layout FROM design_templates WHERE id = $1`, [id]);
  if (!t) throw notFound('Vorlage nicht gefunden.');
  if (t.kind !== 'image' || !t.layout) throw badRequest('Diese Vorlage ist keine befüllbare Bildvorlage.');
  return { t, layout: layoutSchema.parse(t.layout) };
}

const truncatedHeader = (texts: Record<string, { truncated: boolean }>) =>
  Object.entries(texts)
    .filter(([, v]) => v.truncated)
    .map(([k]) => k)
    .join(',');

async function sendPreview(reply: any, png: Buffer, texts: Record<string, { truncated: boolean }>) {
  reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
  reply.header('x-text-truncated', truncatedHeader(texts));
  return reply.send(await previewJpeg(png));
}

export async function designImageRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- Schriften */

  app.get('/design-fonts', { preHandler: requireAuth('templates.view') }, async () => {
    const fonts = [...(await loadFonts()).values()].map((f) => ({ key: f.key, label: f.label, family: f.family, weight: f.weight, italic: f.italic, bundled: f.bundled, license: f.license }));
    return { fonts, formats: FORMAT_PRESETS };
  });

  /* Eigene Schrift (TTF/OTF) mit Lizenzhinweis hochladen */
  app.post('/design-fonts', { preHandler: requireAuth('templates.manage'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const parts = req.parts({ limits: { fileSize: MAX_FONT_BYTES, files: 1, fields: 4 } });
    const fields: Record<string, string> = {};
    let stored: Awaited<ReturnType<typeof streamToTemp>> | null = null;
    let name = '';
    try {
      for await (const p of parts) {
        if (p.type === 'file') {
          name = cleanFileName(p.filename);
          try {
            stored = await streamToTemp(p.file, MAX_FONT_BYTES);
          } catch (e) {
            if (e instanceof SizeLimitError) throw badRequest('Die Schriftdatei ist zu groß (höchstens 10 MB).');
            throw e;
          }
        } else fields[p.fieldname] = String(p.value ?? '');
      }
      if (!stored) throw badRequest('Keine Datei empfangen.');
      await malwareCheck(req, stored.tmpPath, name);
      const license = (fields.license ?? '').trim();
      if (license.length < 3) throw badRequest('Bitte die Lizenz der Schrift angeben (z. B. „SIL Open Font License“ oder „Lizenz der Organisation“).');
      if (fields.confirm !== 'true') throw badRequest('Bitte bestätigen, dass die Schrift für diese Zwecke verwendet werden darf.');
      const buf = fs.readFileSync(stored.tmpPath);
      let info;
      try {
        info = readFontInfo(buf);
      } catch (e) {
        if (e instanceof FontRejected) throw badRequest(e.message);
        throw e;
      }
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (await one(`SELECT 1 FROM design_fonts WHERE sha256 = $1`, [sha])) throw conflict('Diese Schrift ist schon vorhanden.');
      const id = crypto.randomUUID();
      fs.mkdirSync(customFontDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(customFontPath(id, info.format), buf, { mode: 0o600 });
      await pool.query(
        `INSERT INTO design_fonts (id, family, subfamily, full_name, weight, italic, format, license, size_bytes, sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, info.family, info.subfamily, info.fullName, info.weight, info.italic, info.format, license.slice(0, 500), buf.length, sha, req.auth!.user?.id ?? null],
      );
      invalidateFonts();
      await audit(req.auth!.actor, 'design_template.font_uploaded', { type: 'design_font', id, label: info.fullName }, { datei: name, lizenz: license.slice(0, 120) });
      return { key: `custom:${id}`, family: info.family, subfamily: info.subfamily, weight: info.weight, italic: info.italic };
    } finally {
      if (stored) fs.rmSync(stored.tmpPath, { force: true });
    }
  });

  app.delete('/design-fonts/:id', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const f = await one<any>(`SELECT id, full_name, format FROM design_fonts WHERE id = $1`, [id]);
    if (!f) throw notFound('Schrift nicht gefunden.');
    const used = await many<any>(`SELECT title FROM design_templates WHERE layout::text LIKE $1`, [`%"custom:${id}"%`]);
    if (used.length) throw conflict(`Die Schrift wird noch verwendet: ${used.map((u) => `„${u.title}“`).join(', ')}.`);
    await pool.query(`DELETE FROM design_fonts WHERE id = $1`, [id]);
    fs.rmSync(customFontPath(id, f.format), { force: true });
    invalidateFonts();
    await audit(req.auth!.actor, 'design_template.font_deleted', { type: 'design_font', id, label: f.full_name });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- Bilder der Vorlage (Hintergrund, Logo) */

  app.post('/design-templates/:id/assets', { preHandler: requireAuth('templates.manage'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await one<any>(`SELECT id, title FROM design_templates WHERE id = $1`, [id]);
    if (!t) throw notFound('Vorlage nicht gefunden.');
    const part = await req.file({ limits: { fileSize: MAX_ASSET_BYTES, files: 1, fields: 2 } });
    if (!part) throw badRequest('Keine Datei empfangen.');
    let stored;
    try {
      stored = await streamToTemp(part.file, MAX_ASSET_BYTES);
    } catch (e) {
      if (e instanceof SizeLimitError) throw badRequest('Das Bild ist zu groß (höchstens 20 MB).');
      throw e;
    }
    try {
      const det = detectFormat(cleanFileName(part.filename), stored.head);
      if (!det.format || !['png', 'jpeg', 'webp', 'svg'].includes(det.format.key)) throw badRequest('Erlaubt sind PNG, JPEG, WebP und SVG.');
      await malwareCheck(req, stored.tmpPath, part.filename);
      const assetId = crypto.randomUUID();
      let mime: string;
      let width: number | undefined;
      let height: number | undefined;
      let size: number;
      if (det.format.key === 'svg') {
        let clean: string;
        try {
          clean = sanitizeSvg(fs.readFileSync(stored.tmpPath, 'utf8'));
        } catch (e) {
          if (e instanceof SvgRejected) throw badRequest(e.message);
          throw e;
        }
        try {
          const m = await sharp(Buffer.from(clean), { limitInputPixels: MAX_PIXELS }).metadata();
          width = m.width;
          height = m.height;
        } catch {
          throw badRequest('Die SVG-Datei lässt sich nicht darstellen.');
        }
        mime = 'image/svg+xml';
        const out = assetPath(assetId, mime);
        ensureDir(out);
        fs.writeFileSync(out, clean, { mode: 0o600 });
        size = Buffer.byteLength(clean);
      } else {
        // Neu kodieren: gedreht, höchstens 4000 px, ohne Metadaten; PNG nur mit Transparenz
        let meta;
        try {
          meta = await sharp(stored.tmpPath, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
        } catch {
          throw badRequest('Die Datei ist kein gültiges Bild oder zu groß.');
        }
        mime = meta.hasAlpha ? 'image/png' : 'image/jpeg';
        const out = assetPath(assetId, mime);
        ensureDir(out);
        const pipe = sharp(stored.tmpPath, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().resize({ width: MAX_ASSET_EDGE, height: MAX_ASSET_EDGE, fit: 'inside', withoutEnlargement: true });
        const res = meta.hasAlpha ? await pipe.png({ compressionLevel: 9 }).toFile(out) : await pipe.jpeg({ quality: 90, mozjpeg: true }).toFile(out);
        width = res.width;
        height = res.height;
        size = res.size;
      }
      await pool.query(`INSERT INTO design_template_assets (id, template_id, mime, width, height, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [assetId, id, mime, width ?? null, height ?? null, size, req.auth!.user?.id ?? null]);
      await audit(req.auth!.actor, 'design_template.asset_uploaded', { type: 'design_template', id, label: t.title }, { bild: assetId, typ: mime });
      return { id: assetId, mime, width, height };
    } finally {
      fs.rmSync(stored.tmpPath, { force: true });
    }
  });

  app.get('/design-templates/:id/assets/:assetId', { preHandler: requireAuth('templates.view') }, async (req, reply) => {
    const { id, assetId } = z.object({ id: z.uuid(), assetId: z.uuid() }).parse(req.params);
    const a = await one<any>(`SELECT id, mime FROM design_template_assets WHERE id = $1 AND template_id = $2`, [assetId, id]);
    if (!a) throw notFound('Bild nicht gefunden.');
    if (a.mime === 'image/svg+xml') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    return sendFileResponse(reply, assetPath(a.id, a.mime), a.mime, undefined, { immutable: true });
  });

  /* ---------------------------------------------------------------- Layout (Editor) */

  app.put('/design-templates/:id/layout', { preHandler: requireAuth('templates.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await one<any>(`SELECT id, title, kind FROM design_templates WHERE id = $1`, [id]);
    if (!t) throw notFound('Vorlage nicht gefunden.');
    if (t.kind !== 'image') throw badRequest('Diese Vorlage ist keine befüllbare Bildvorlage.');
    const layout = await cleanLayout(id, (req.body as any)?.layout);
    await pool.query(`UPDATE design_templates SET layout = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, JSON.stringify(layout), req.auth!.user?.id ?? null]);
    // Nicht mehr verwendete Bilder der Vorlage aufräumen (frische bleiben einen Tag – evtl. offener Editor)
    const used = new Set([layout.background.assetId, ...layout.elements.map((e) => (e.type === 'logo' ? e.assetId : null))].filter(Boolean) as string[]);
    for (const a of await many<any>(`SELECT id, mime FROM design_template_assets WHERE template_id = $1 AND created_at < now() - interval '1 day'`, [id])) {
      if (used.has(a.id)) continue;
      await pool.query(`DELETE FROM design_template_assets WHERE id = $1`, [a.id]);
      fs.rmSync(assetPath(a.id, a.mime), { force: true });
    }
    await audit(req.auth!.actor, 'design_template.layout_saved', { type: 'design_template', id, label: t.title }, { elemente: layout.elements.length, format: `${layout.width}x${layout.height}` });
    await refreshImagePreview(id);
    return { layout };
  });

  /* Vorschau eines (noch nicht gespeicherten) Layouts im Editor */
  app.post('/design-templates/:id/layout-preview', { preHandler: requireAuth('templates.manage'), config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await one(`SELECT 1 FROM design_templates WHERE id = $1`, [id]))) throw notFound('Vorlage nicht gefunden.');
    const body = z.object({ layout: z.any(), values: z.record(z.string(), z.string().max(2000)).default({}) }).parse(req.body ?? {});
    const layout = await cleanLayout(id, body.layout);
    const r = await renderFromTemplate(id, layout, cleanValues(layout, body.values), {}, true);
    return sendPreview(reply, r.png, r.texts);
  });

  /* ---------------------------------------------------------------- Ausfüllen */

  app.post('/design-templates/:id/fill-preview', { preHandler: requireAuth('templates.use'), config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { layout } = await imageTemplate(id);
    const body = fillBody.parse(req.body ?? {});
    const r = await renderFromTemplate(id, layout, cleanValues(layout, body.values), await resolveImages(layout, body.images), true);
    return sendPreview(reply, r.png, r.texts);
  });

  app.post('/design-templates/:id/generate', { preHandler: requireAuth('templates.use'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = fillBody.extend({ collectionId: z.uuid().nullable().default(null), postId: z.uuid().nullable().default(null), altText: z.string().max(1000).default('') }).parse(req.body ?? {});
    await imageTemplate(id);
    return generateIntoMedia({ templateId: id, values: body.values, images: body.images, collectionId: body.collectionId, postId: body.postId, altText: body.altText, actor: req.auth!.actor, userId: req.auth!.user?.id ?? null });
  });
}

