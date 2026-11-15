import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { ACCENTS, BLOCK_TYPES, cleanDesign, DEFAULT_DESIGN, designImageIds, designImagePath, type Design } from '../media/design.js';
import { SizeLimitError, streamToTemp } from '../media/storage.js';
import { sendFileResponse } from './files.js';

/*
 * Gestaltung der Upload-Seite (Paket 10): Standard (media.upload_design, „Medien administrieren“) und je Link
 * („Medien verwalten“). Bilder werden beim Hochladen mit sharp neu kodiert (gedreht, höchstens 2400 px, ohne EXIF/XMP,
 * PNG nur mit Transparenz) und unter /data/media/design abgelegt; ausgeliefert werden sie öffentlich, aber nur über
 * ihre zufällige ID.
 */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const MAX_IMAGE_PIXELS = 40_000_000;

/** Standardgestaltung (gespeichert oder eingebaut). */
export async function defaultDesign(): Promise<Design> {
  const raw = (await getSettings())['media.upload_design'];
  if (raw) {
    try {
      return cleanDesign(raw);
    } catch {
      /* beschädigt → eingebauter Standard */
    }
  }
  return structuredClone(DEFAULT_DESIGN);
}

/** Wirksame Gestaltung eines Links (eigene oder Standard). */
export async function effectiveDesign(linkDesign: unknown): Promise<Design> {
  if (linkDesign) {
    try {
      return cleanDesign(linkDesign);
    } catch {
      /* beschädigt → Standard */
    }
  }
  return defaultDesign();
}

/** Prüfen, dass alle Bilder einer Gestaltung existieren. */
async function assertImages(d: Design) {
  const ids = designImageIds(d);
  if (!ids.length) return;
  const known = (await many<any>(`SELECT id FROM design_images WHERE id = ANY($1::uuid[])`, [ids])).map((r) => r.id);
  if (known.length !== ids.length) throw badRequest('Ein Bild der Gestaltung gibt es nicht (mehr). Bitte neu hochladen.');
}

/** Nicht mehr verwendete Gestaltungsbilder entfernen (älter als ein Tag – frische liegen evtl. in einem offenen Editor). */
export async function cleanupDesignImages() {
  const used = new Set(designImageIds(await defaultDesign()));
  for (const r of await many<any>(`SELECT design FROM upload_links WHERE design IS NOT NULL`)) {
    try {
      for (const id of designImageIds(cleanDesign(r.design))) used.add(id);
    } catch {
      /* beschädigt */
    }
  }
  for (const img of await many<any>(`SELECT id, mime FROM design_images WHERE created_at < now() - interval '1 day'`)) {
    if (used.has(img.id)) continue;
    fs.rmSync(designImagePath(img.id, img.mime), { force: true });
    await pool.query(`DELETE FROM design_images WHERE id = $1`, [img.id]);
  }
}

export async function mediaDesignRoutes(app: FastifyInstance) {
  const meta = { accents: ACCENTS, blockTypes: Object.fromEntries(Object.entries(BLOCK_TYPES).map(([k, v]) => [k, v.label])), maxBlocks: 30 };

  app.get('/media/design', { preHandler: requireAuth('media.manage') }, async () => ({ design: await defaultDesign(), builtin: DEFAULT_DESIGN, ...meta }));

  app.put('/media/design', { preHandler: requireAuth('media.admin') }, async (req) => {
    const { design } = z.object({ design: z.any().nullable() }).parse(req.body ?? {});
    const d = design ? cleanDesign(design) : null;
    if (d) await assertImages(d);
    await setSettings({ 'media.upload_design': d } as any, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'design.updated', { type: 'design', label: 'Standard der Upload-Seite' }, { bausteine: d?.blocks.length ?? 0, zurueckgesetzt: !d });
    return { design: d ?? DEFAULT_DESIGN };
  });

  app.get('/upload-links/:id/design', { preHandler: requireAuth('media.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const l = await one<any>(
      `SELECT l.id, l.label, l.design, l.welcome_text, c.title, c.purpose, c.note, c.event_date FROM upload_links l JOIN collections c ON c.id = l.collection_id WHERE l.id = $1`,
      [id],
    );
    if (!l) throw notFound('Link nicht gefunden.');
    return { own: l.design ? await effectiveDesign(l.design) : null, effective: await effectiveDesign(l.design), default: await defaultDesign(), link: { label: l.label, welcome_text: l.welcome_text, title: l.title, purpose: l.purpose, note: l.note, event_date: l.event_date }, ...meta };
  });

  app.put('/upload-links/:id/design', { preHandler: requireAuth('media.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { design } = z.object({ design: z.any().nullable() }).parse(req.body ?? {});
    const d = design ? cleanDesign(design) : null;
    if (d) await assertImages(d);
    const l = await one<any>(`UPDATE upload_links SET design = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id, label, collection_id`, [id, d ? JSON.stringify(d) : null]);
    if (!l) throw notFound('Link nicht gefunden oder widerrufen.');
    await audit(req.auth!.actor, 'upload_link.design', { type: 'upload_link', id, label: l.label || l.collection_id }, { bausteine: d?.blocks.length ?? 0, standard: !d });
    return { design: d };
  });

  /* Bild für die Gestaltung hochladen: neu kodiert, ohne Metadaten */
  app.post('/media/design-images', { preHandler: requireAuth('media.manage'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const part = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2 } });
    if (!part) throw badRequest('Keine Datei empfangen.');
    let stored;
    try {
      stored = await streamToTemp(part.file, MAX_IMAGE_BYTES);
    } catch (e) {
      if (e instanceof SizeLimitError) throw badRequest('Das Bild ist zu groß (höchstens 15 MB).');
      throw e;
    }
    try {
      let info: Metadata;
      try {
        info = await sharp(stored.tmpPath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).metadata();
      } catch {
        throw badRequest('Die Datei ist kein gültiges Bild oder zu groß.');
      }
      if (!['jpeg', 'png', 'webp'].includes(info.format ?? '')) throw badRequest('Erlaubt sind nur JPEG-, PNG- und WebP-Bilder.');
      const alpha = !!info.hasAlpha;
      const mime = alpha ? 'image/png' : 'image/jpeg';
      const id = crypto.randomUUID();
      const out = designImagePath(id, mime);
      fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
      const pipe = sharp(stored.tmpPath, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).rotate().resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
      const res = alpha ? await pipe.png({ compressionLevel: 9 }).toFile(out) : await pipe.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
      await pool.query(`INSERT INTO design_images (id, mime, width, height, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, mime, res.width, res.height, res.size, req.auth!.user?.id ?? null]);
      await audit(req.auth!.actor, 'design.image_uploaded', { type: 'design_image', id, label: 'Bild der Gestaltung' }, { breite: res.width, hoehe: res.height });
      return { id, url: `/api/v1/public/design-images/${id}`, width: res.width, height: res.height };
    } finally {
      fs.rmSync(stored.tmpPath, { force: true });
    }
  });

  /* Öffentlich: Bilder der Gestaltung (nur über die zufällige ID) */
  app.get('/public/design-images/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const img = await one<any>(`SELECT id, mime FROM design_images WHERE id = $1`, [id]);
    if (!img) throw notFound();
    return sendFileResponse(reply, designImagePath(img.id, img.mime), img.mime, undefined, { immutable: true });
  });
}
