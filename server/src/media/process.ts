import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileTypeFromFile } from 'file-type';
import sharp, { type Metadata } from 'sharp';
import { one, pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { mediaPaths, moveFile } from './storage.js';

/** Zugelassene Formate – geprüft wird der Dateiinhalt, nicht Dateiname oder angegebener Typ. */
export const ALLOWED: Record<string, { kind: 'image' | 'video'; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/heic': { kind: 'image', ext: 'heic' },
  'image/heif': { kind: 'image', ext: 'heif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', ext: 'webm' },
};

export const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm';

// Höchstens 40 Megapixel dekodieren (Schutz vor „Dekompressionsbomben“)
const MAX_PIXELS = 40_000_000;
// Threads je Bild begrenzen: parallel laufen ohnehin mehrere Aufträge (Einstellung „Parallele Hintergrundaufträge“)
sharp.concurrency(Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2))));
sharp.cache(false);

class Rejected extends Error {}

/** Enthält der EXIF-Block einen Verweis auf GPS-Daten (Tag 0x8825)? */
function exifHasGps(exif?: Buffer): boolean {
  if (!exif) return false;
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString().slice(0, 200_000)));
    p.stderr.on('data', (d) => (stderr += d.toString().slice(0, 20_000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: 'nicht verfügbar' });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function processImage(id: string, file: string, mime: string) {
  if (mime === 'image/heic' || mime === 'image/heif') {
    // HEIC kann ohne lizenzpflichtigen Decoder nicht geprüft/umgerechnet werden: intern verfügbar, ohne Vorschau.
    return { width: null, height: null, hadLocation: false, hasPreview: false, hasPublic: false, takenAt: null };
  }
  let meta: Metadata;
  try {
    meta = await sharp(file, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  } catch (e) {
    throw new Rejected(`Bild ist beschädigt oder zu groß (${(e as Error).message.slice(0, 120)}).`);
  }
  if (!meta.width || !meta.height) throw new Rejected('Bildgröße konnte nicht gelesen werden.');
  try {
    // Einmal dekodieren, zwei Ausgaben: Vorschau (WebP) und öffentliche Fassung (JPEG ohne EXIF/XMP/IPTC)
    const base = sharp(file, { limitInputPixels: MAX_PIXELS, failOn: 'error', sequentialRead: true }).rotate();
    await Promise.all([
      base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, effort: 3 }).toFile(mediaPaths.preview(id)),
      base.clone().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toFile(mediaPaths.publicFile(id, 'jpg')),
    ]);
  } catch (e) {
    throw new Rejected(`Bild konnte nicht verarbeitet werden (${(e as Error).message.slice(0, 120)}).`);
  }
  const swap = (meta.orientation ?? 1) >= 5;
  return {
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
    hadLocation: exifHasGps(meta.exif),
    hasPreview: true,
    hasPublic: true,
    takenAt: null,
  };
}

async function processVideo(id: string, file: string, ext: string) {
  const probe = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], 60_000);
  if (probe.code === -1 && probe.stderr === 'nicht verfügbar') {
    log('warn', 'media', 'ffprobe fehlt – Video wird ohne Inhaltsprüfung abgewiesen.');
    throw new Rejected('Videos können auf dieser Installation nicht geprüft werden (ffprobe fehlt).');
  }
  if (probe.code !== 0) throw new Rejected('Video ist beschädigt oder hat ein unbekanntes Format.');
  let info: any;
  try {
    info = JSON.parse(probe.stdout);
  } catch {
    throw new Rejected('Videoinformationen konnten nicht gelesen werden.');
  }
  const v = (info.streams ?? []).find((s: any) => s.codec_type === 'video');
  if (!v) throw new Rejected('Datei enthält keine Videospur.');
  const tags = JSON.stringify(info.format?.tags ?? {}).toLowerCase();
  const hadLocation = tags.includes('location') || tags.includes('xyz');
  // Vorschau aus dem ersten Bild, öffentliche Fassung ohne Metadaten (Spuren nur umverpackt)
  const frame = mediaPaths.preview(id) + '.png';
  const fr = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=1200:1200:force_original_aspect_ratio=decrease', frame], 120_000);
  let hasPreview = false;
  if (fr.code === 0 && fs.existsSync(frame)) {
    await sharp(frame).webp({ quality: 75 }).toFile(mediaPaths.preview(id));
    hasPreview = true;
  }
  fs.rmSync(frame, { force: true });
  const outExt = ext === 'webm' ? 'webm' : 'mp4';
  const pub = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', ...(outExt === 'mp4' ? ['-movflags', '+faststart'] : []), mediaPaths.publicFile(id, outExt)], 600_000);
  return { width: v.width ?? null, height: v.height ?? null, hadLocation, hasPreview, hasPublic: pub.code === 0, takenAt: null };
}

/**
 * Prüft eine Datei aus der Quarantäne: Typ anhand des Inhalts, Dekodierbarkeit, Vorschau,
 * öffentliche Fassung ohne Standortdaten. Erst danach wird sie sichtbar („ready“).
 */
export async function processMedia(id: string): Promise<'ready' | 'rejected' | 'skipped'> {
  const row = await one<any>(`SELECT id, status FROM media WHERE id = $1`, [id]);
  if (!row || row.status !== 'quarantine') return 'skipped';
  const file = mediaPaths.quarantine(id);
  if (!fs.existsSync(file)) {
    await pool.query(`UPDATE media SET status = 'rejected', reject_reason = 'Datei fehlt in der Quarantäne.', processed_at = now() WHERE id = $1`, [id]);
    return 'rejected';
  }
  try {
    const ft = await fileTypeFromFile(file);
    const allowed = ft ? ALLOWED[ft.mime] : undefined;
    if (!ft || !allowed) throw new Rejected(`Dateiformat ${ft?.mime ?? 'unbekannt'} ist nicht erlaubt. Erlaubt sind Fotos (JPEG, PNG, WebP, HEIC) und Videos (MP4, MOV, WebM).`);
    const r = allowed.kind === 'image' ? await processImage(id, file, ft.mime) : await processVideo(id, file, allowed.ext);
    moveFile(file, mediaPaths.original(id));
    await pool.query(
      `UPDATE media SET status = 'ready', mime = $2, kind = $3, width = $4, height = $5, had_location = $6, has_preview = $7, has_public = $8, processed_at = now() WHERE id = $1`,
      [id, ft.mime, allowed.kind, r.width, r.height, r.hadLocation, r.hasPreview, r.hasPublic],
    );
    return 'ready';
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    fs.rmSync(file, { force: true });
    fs.rmSync(mediaPaths.preview(id), { force: true });
    await pool.query(`UPDATE media SET status = 'rejected', reject_reason = $2, processed_at = now() WHERE id = $1`, [id, e.message.slice(0, 300)]);
    log('info', 'media', `Datei abgewiesen: ${e.message}`, { media: id });
    return 'rejected';
  }
}
