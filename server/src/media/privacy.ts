import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { z } from 'zod';
import { one, tx } from '../db/pool.js';
import { imagePixelLimit, pickVideoStream, run } from './process.js';
import { mediaPaths, removeMediaFiles } from './storage.js';

/**
 * Hilfen für abgebildete Personen und Art.-9-Inhalte (#118): Markierungen aus der Sichtung, unkenntlich gemachte
 * Bereiche und Zuschnitt der öffentlichen Fassung von Bildern, Videos ohne Ton. Das Original bleibt unverändert;
 * nur die öffentliche Fassung (für Website, soziale Kanäle, Exporte) wird neu erzeugt.
 */

export const SENSITIVE_FLAGS = ['persons', 'health', 'plates', 'sensitive'] as const;
export type SensitiveFlag = (typeof SENSITIVE_FLAGS)[number];

const unit = z.number().min(0).max(1);
export const regionSchema = z
  .object({ x: unit, y: unit, w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, 'Bereich liegt außerhalb des Bildes.');
export const redactionSchema = z.object({ x: unit, y: unit, w: z.number().gt(0).max(1), h: z.number().gt(0).max(1), mode: z.enum(['pixelate', 'blur', 'box']).default('pixelate') }).refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, 'Bereich liegt außerhalb des Bildes.');
export type Region = z.infer<typeof regionSchema>;
export type Redaction = z.infer<typeof redactionSchema>;

export const privacyInput = z.object({
  flags: z.array(z.enum(SENSITIVE_FLAGS)).max(4).optional(),
  redactions: z.array(redactionSchema).max(50).optional(),
  crop: regionSchema.nullable().optional(),
  stripAudio: z.boolean().optional(),
});

export interface Px {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Normierten Bereich (0..1) in Bildpunkte umrechnen – mindestens 1 px, nie außerhalb des Bildes. */
export function toPx(r: { x: number; y: number; w: number; h: number }, width: number, height: number): Px {
  const left = Math.min(width - 1, Math.max(0, Math.floor(r.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(r.y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((r.x + r.w) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((r.y + r.h) * height)));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Bereich (normiert auf das ganze Bild) in Koordinaten des zugeschnittenen Bildes (normiert) umrechnen.
 * Liefert null, wenn der Bereich ganz außerhalb des Zuschnitts liegt.
 */
export function regionInCrop<T extends { x: number; y: number; w: number; h: number }>(r: T, crop: Region | null): T | null {
  if (!crop) return r;
  const x0 = Math.max(r.x, crop.x);
  const y0 = Math.max(r.y, crop.y);
  const x1 = Math.min(r.x + r.w, crop.x + crop.w);
  const y1 = Math.min(r.y + r.h, crop.y + crop.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { ...r, x: (x0 - crop.x) / crop.w, y: (y0 - crop.y) / crop.h, w: (x1 - x0) / crop.w, h: (y1 - y0) / crop.h };
}

const OUT_MAX = 2560;

/** Öffentliche Fassung eines Bildes neu erzeugen: drehen, zuschneiden, Bereiche unkenntlich machen, verkleinern. */
export async function renderPublicImage(id: string, opts: { crop: Region | null; redactions: Redaction[] }): Promise<void> {
  const src = mediaPaths.original(id);
  const limit = await imagePixelLimit();
  const meta = await sharp(src, { limitInputPixels: limit, failOn: 'error' }).metadata();
  if (!meta.width || !meta.height) throw new Error('Bildgröße konnte nicht gelesen werden.');
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;
  // So weit verkleinern, dass der Zuschnitt höchstens OUT_MAX Bildpunkte breit/hoch wird (spart Speicher)
  const crop = opts.crop;
  const cropPxFull = crop ? toPx(crop, W, H) : { left: 0, top: 0, width: W, height: H };
  const scale = Math.min(1, OUT_MAX / Math.max(cropPxFull.width, cropPxFull.height));
  const sw = Math.max(1, Math.round(W * scale));
  const sh = Math.max(1, Math.round(H * scale));
  const full = await sharp(src, { limitInputPixels: limit, failOn: 'error' }).rotate().resize(sw, sh, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const fw = full.info.width;
  const fh = full.info.height;
  const raw = { width: fw, height: fh, channels: full.info.channels };
  // Zuschnitt
  const c = crop ? toPx(crop, fw, fh) : { left: 0, top: 0, width: fw, height: fh };
  const base = crop ? await sharp(full.data, { raw }).extract(c).raw().toBuffer({ resolveWithObject: true }) : full;
  const bw = base.info.width;
  const bh = base.info.height;
  const braw = { width: bw, height: bh, channels: base.info.channels };
  // Unkenntlich machen: Bereich ausschneiden, stark verpixeln / weichzeichnen / abdecken, zurück einsetzen
  const layers: OverlayOptions[] = [];
  for (const red of opts.redactions) {
    const r = regionInCrop(red, crop);
    if (!r) continue;
    const p = toPx(r, bw, bh);
    if (red.mode === 'box') {
      layers.push({ input: { create: { width: p.width, height: p.height, channels: 3, background: { r: 0, g: 0, b: 0 } } }, left: p.left, top: p.top });
      continue;
    }
    const part = sharp(base.data, { raw: braw }).extract(p);
    let buf: Buffer;
    if (red.mode === 'blur') {
      buf = await part.blur(Math.max(6, Math.min(p.width, p.height) / 4)).raw().toBuffer();
    } else {
      // Grobe Blöcke: etwa 8 Blöcke über die kürzere Seite, mindestens 8 px je Block
      const block = Math.max(8, Math.round(Math.min(p.width, p.height) / 8));
      const small = await part.resize(Math.max(1, Math.round(p.width / block)), Math.max(1, Math.round(p.height / block)), { fit: 'fill', kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
      buf = await sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: small.info.channels } }).resize(p.width, p.height, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer();
    }
    layers.push({ input: buf, raw: { width: p.width, height: p.height, channels: braw.channels }, left: p.left, top: p.top });
  }
  const out = mediaPaths.publicFile(id, 'jpg');
  const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.neu`; // eindeutig: Folgeauftrag kann parallel laufen (#165)
  try {
    // Ergebnis zuerst flach rechnen, dann verkleinern (composite wird sonst nach resize angewendet)
    const flat = await sharp(base.data, { raw: braw }).composite(layers).raw().toBuffer({ resolveWithObject: true });
    await sharp(flat.data, { raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels } })
      .resize({ width: OUT_MAX, height: OUT_MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(tmp);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Öffentliche Fassung eines Videos neu umverpacken (erste Videospur, wahlweise ohne Ton). */
export async function renderPublicVideo(id: string, mime: string, stripAudio: boolean): Promise<void> {
  const src = mediaPaths.original(id);
  const probe = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', src], 60_000);
  if (probe.code !== 0) throw new Error('Video konnte nicht gelesen werden.');
  const v = pickVideoStream(JSON.parse(probe.stdout).streams ?? []);
  const ext = mime === 'video/webm' ? 'webm' : 'mp4';
  const out = mediaPaths.publicFile(id, ext);
  const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.neu`; // eindeutig: Folgeauftrag kann parallel laufen (#165)
  try {
    const r = await run(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', src, '-map', `0:${v.index}`, ...(stripAudio ? ['-an'] : ['-map', '0:a:0?']), '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), '-f', ext, tmp],
      600_000,
    );
    if (r.code !== 0) throw new Error(`Öffentliche Fassung konnte nicht erzeugt werden (${r.stderr.trim().slice(0, 120)}).`);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const renderInputs = (m: any) => JSON.stringify([m.redactions ?? [], m.crop ?? null, !!m.strip_audio]);

/**
 * Öffentliche Fassung nach den gespeicherten Datenschutz-Einstellungen neu erzeugen (Auftrag „media.render_public“).
 *
 * Die Einstellungen werden am Ende unter Zeilensperre erneut gelesen (#165): Hat jemand sie während des Renderns
 * geändert (z. B. „ohne Ton“ nachträglich eingeschaltet – der zweite Auftrag fiel dem dedup_key zum Opfer), wird
 * sofort mit dem neuen Stand erneut gerendert; public_rev steigt nur für eine Fassung, die dem gespeicherten Stand
 * entspricht.
 */
export async function renderPublic(id: string): Promise<boolean> {
  for (let pass = 0; pass < 5; pass++) {
    const m = await one<any>(`SELECT id, kind, mime, has_public, redactions, crop, strip_audio FROM media WHERE id = $1 AND status = 'ready' AND deleted_at IS NULL`, [id]);
    if (!m || !m.has_public) return false;
    if (m.kind === 'image') await renderPublicImage(id, { crop: m.crop ?? null, redactions: m.redactions ?? [] });
    else await renderPublicVideo(id, m.mime, !!m.strip_audio);
    const outcome = await tx(async (db) => {
      const now = await one<any>(`SELECT redactions, crop, strip_audio FROM media WHERE id = $1 AND deleted_at IS NULL AND status = 'ready' FOR UPDATE`, [id], db);
      // Während des Renderns gelöscht (Datenschutzanfrage, DELETE /media, Löschfrist)? Die Löschung hat ihre Dateien
      // womöglich schon vor dem Umbenennen entfernt – dann die eben geschriebene Fassung selbst entfernen (#164).
      if (!now) return 'gone' as const;
      if (renderInputs(now) !== renderInputs(m)) return 'changed' as const;
      await db.query(`UPDATE media SET public_rev = public_rev + 1 WHERE id = $1`, [id]);
      return 'ok' as const;
    });
    if (outcome === 'ok') return true;
    if (outcome === 'gone') {
      await removeIfGone(id);
      return false;
    }
  }
  throw new Error('Die Datenschutz-Einstellungen wurden während des Renderns wiederholt geändert. Der Auftrag wird wiederholt.');
}

/** Dateien entfernen, wenn die Medienzeile nicht mehr existiert oder gelöscht ist (nicht bei anderem Status). */
async function removeIfGone(id: string) {
  const row = await one<{ deleted_at: Date | null }>(`SELECT deleted_at FROM media WHERE id = $1`, [id]);
  if (!row || row.deleted_at) removeMediaFiles(id);
}
