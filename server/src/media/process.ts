import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileTypeFromFile } from 'file-type';
import sharp, { type Metadata } from 'sharp';
import { one, pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { mediaPaths, moveFile, removeMediaFiles } from './storage.js';
import { scrubImage } from './scrub.js';
import { scanFile, ScannerUnavailable } from './clamav.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { securityAlert } from '../lib/security-alerts.js';

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
export const MAX_PIXELS = 40_000_000;
const MAX_VIDEO_PIXELS = 7680 * 4320;
// Threads je Bild begrenzen: parallel laufen ohnehin mehrere Aufträge (Einstellung „Parallele Hintergrundaufträge“)
sharp.concurrency(Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2))));
sharp.cache(false);

export class Rejected extends Error {}

/**
 * Wählt die Videospur für Vorschau und öffentliche Fassung und prüft alle Videospuren gegen die Auflösungsgrenze
 * (#150). Eingebettete Titelbilder (disposition.attached_pic) zählen nicht als Videospur. Geprüft wird jede Spur –
 * sonst ließe sich die Grenze mit einer kleinen ersten und einer riesigen zweiten Spur umgehen.
 * @returns die erste echte Videospur (ffprobe-Objekt mit `index`)
 */
export function pickVideoStream(streams: any[], maxPixels = MAX_VIDEO_PIXELS): any {
  const videos = (streams ?? []).filter((s: any) => s?.codec_type === 'video' && !s?.disposition?.attached_pic);
  if (!videos.length) throw new Rejected('Datei enthält keine Videospur.');
  for (const s of videos) {
    const w = Number(s.width ?? 0);
    const h = Number(s.height ?? 0);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w * h > maxPixels) throw new Rejected('Videoauflösung ist zu hoch (höchstens 8K).');
  }
  const v = videos[0];
  if (!Number.isInteger(v.index)) throw new Rejected('Videoinformationen konnten nicht gelesen werden.');
  return v;
}

/** Enthält der EXIF-Block einen Verweis auf GPS-Daten (Tag 0x8825)? */
function exifHasGps(exif?: Buffer): boolean {
  if (!exif) return false;
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

export function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
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
    // Standort unbekannt (null) – iPhone-HEIC enthält meist GPS im Original (#74)
    return { width: null, height: null, hadLocation: null, hasPreview: false, hasPublic: false, takenAt: null };
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
  const v = pickVideoStream(info.streams ?? []);
  // Ressourcenschutz: Länge und Auflösung begrenzen
  const maxMin = (await getSettings())['media.max_video_minutes'];
  const duration = Number(info.format?.duration ?? v.duration ?? 0);
  if (duration > maxMin * 60) throw new Rejected(`Video ist länger als ${maxMin} Minuten.`);
  // Datenspuren (z. B. GPS-Telemetrie von Action-Kameras) und Untertitel gelten als Metadaten
  const dataStreams = (info.streams ?? []).filter((s: any) => !['video', 'audio'].includes(s.codec_type));
  const tags = JSON.stringify(info.format?.tags ?? {}).toLowerCase();
  const hadLocation = tags.includes('location') || tags.includes('xyz') || dataStreams.some((s: any) => /gpmd|gps|camm|meta/i.test(`${s.codec_tag_string ?? ''} ${s.codec_name ?? ''} ${JSON.stringify(s.tags ?? {})}`));
  // Vorschau aus dem ersten Bild, öffentliche Fassung ohne Metadaten (Spuren nur umverpackt)
  const frame = mediaPaths.preview(id) + '.png';
  // Immer die geprüfte Spur verwenden: ohne -map wählt ffmpeg die Spur mit der höchsten Auflösung (#150)
  const fr = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', `0:${v.index}`, '-frames:v', '1', '-vf', 'scale=1200:1200:force_original_aspect_ratio=decrease', frame], 120_000);
  let hasPreview = false;
  if (fr.code === 0 && fs.existsSync(frame)) {
    await sharp(frame).webp({ quality: 75 }).toFile(mediaPaths.preview(id));
    hasPreview = true;
  }
  fs.rmSync(frame, { force: true });
  const outExt = ext === 'webm' ? 'webm' : 'mp4';
  const pub = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', `0:${v.index}`, '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', ...(outExt === 'mp4' ? ['-movflags', '+faststart'] : []), mediaPaths.publicFile(id, outExt)], 600_000);
  // Abgebrochene/fehlgeschlagene Umverpackung hinterlässt sonst eine Teildatei (#73)
  if (pub.code !== 0) fs.rmSync(mediaPaths.publicFile(id, outExt), { force: true });
  return { width: v.width ?? null, height: v.height ?? null, hadLocation, hasPreview, hasPublic: pub.code === 0, takenAt: null };
}

/**
 * Prüft eine Datei aus der Quarantäne: Typ anhand des Inhalts, Dekodierbarkeit, Vorschau,
 * öffentliche Fassung ohne Standortdaten. Erst danach wird sie sichtbar („ready“).
 */
export async function processMedia(id: string): Promise<'ready' | 'rejected' | 'skipped' | 'deferred'> {
  const row = await one<any>(`SELECT id, status, original_name, created_at FROM media WHERE id = $1`, [id]);
  if (!row || row.status !== 'quarantine') return 'skipped';
  const file = mediaPaths.quarantine(id);
  if (!fs.existsSync(file)) {
    await pool.query(`UPDATE media SET status = 'rejected', reject_reason = 'Datei fehlt in der Quarantäne.', processed_at = now() WHERE id = $1`, [id]);
    return 'rejected';
  }
  // Schadsoftwareprüfung zuerst – noch bevor Decoder (sharp, ffmpeg) die Datei öffnen (#133)
  const scan = await malwareScan(row, file);
  if (scan !== 'clean') return scan;
  try {
    const ft = await fileTypeFromFile(file);
    const allowed = ft ? ALLOWED[ft.mime] : undefined;
    if (!ft || !allowed) throw new Rejected(`${ft ? `Das Dateiformat ${ft.mime} ist nicht erlaubt.` : 'Das Dateiformat wurde nicht erkannt und ist deshalb nicht erlaubt.'} Erlaubt sind Fotos (JPEG, PNG, WebP, HEIC) und Videos (MP4, MOV, WebM).`);
    const r = allowed.kind === 'image' ? await processImage(id, file, ft.mime) : await processVideo(id, file, allowed.ext);
    // Erst nach der öffentlichen Fassung: Standort- und Gerätedaten auch aus dem Original entfernen (#119)
    const strip = (await getSettings())['media.strip_location'] ? await stripLocation(file, ft.mime, allowed.kind) : null;
    const hadLocation = r.hadLocation === null ? (strip?.ok ? strip.gps : null) : r.hadLocation || !!strip?.gps;
    moveFile(file, mediaPaths.original(id));
    // Nur übernehmen, wenn das Medium währenddessen nicht gelöscht wurde – sonst alle erzeugten Dateien entfernen,
    // damit kein Original mit Standortdaten liegen bleibt (#72)
    const done = await pool.query(
      `UPDATE media SET status = 'ready', mime = $2, kind = $3, width = $4, height = $5, had_location = $6, has_preview = $7, has_public = $8, processed_at = now(),
              location_stripped_at = CASE WHEN $9 THEN now() END, location_strip_error = $10
        WHERE id = $1 AND status = 'quarantine' AND deleted_at IS NULL`,
      [id, ft.mime, allowed.kind, r.width, r.height, hadLocation, r.hasPreview, r.hasPublic, !!strip?.ok, strip && !strip.ok ? strip.error : null],
    );
    if (!done.rowCount) {
      removeMediaFiles(id);
      return 'skipped';
    }
    return 'ready';
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    // Alles entfernen, was bis hierhin entstanden ist (Quarantäne, Vorschau, ggf. halbe öffentliche Fassung) (#73)
    removeMediaFiles(id);
    await pool.query(`UPDATE media SET status = 'rejected', reject_reason = $2, processed_at = now() WHERE id = $1`, [id, e.message.slice(0, 300)]);
    log('info', 'media', `Datei abgewiesen: ${e.message}`, { media: id });
    return 'rejected';
  }
}

const VIDEO_FORMAT: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

/**
 * Entfernt Standort- und identifizierende Metadaten aus einem Original (#119, Einstellung `media.strip_location`).
 * - Bilder: verlustfrei über scrub.ts (Bilddaten bleiben bytegleich), danach Kontrolle, dass das Bild lesbar ist und
 *   keinen GPS-Block mehr hat.
 * - Videos: verlustfreies Umverpacken ohne Metadaten, Kapitel, Daten- und Untertitelspuren (GPS-Telemetrie); alle
 *   Bild- und Tonspuren bleiben.
 * Die Datei wird nur ersetzt, wenn alles geklappt hat; sonst bleibt sie unverändert und der Grund wird gemeldet.
 */
export async function stripLocation(file: string, mime: string, kind: 'image' | 'video'): Promise<{ ok: boolean; gps: boolean | null; error?: string }> {
  const tmp = `${file}.strip`;
  try {
    if (kind === 'image') {
      const r = scrubImage(fs.readFileSync(file), mime);
      if (!r.changed) return { ok: true, gps: r.gps };
      fs.writeFileSync(tmp, r.data, { mode: 0o600 });
      if (mime !== 'image/heic' && mime !== 'image/heif') {
        const meta = await sharp(tmp, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
        if (exifHasGpsPointer(meta.exif) || meta.xmp) throw new Error('Standortdaten nach der Bereinigung noch vorhanden.');
      }
      fs.renameSync(tmp, file);
      return { ok: true, gps: r.gps };
    }
    const fmt = VIDEO_FORMAT[mime];
    if (!fmt) return { ok: false, gps: null, error: 'Format wird nicht bereinigt.' };
    const out = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0:v', '-map', '0:a?', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', ...(fmt === 'webm' ? [] : ['-movflags', '+faststart']), '-f', fmt, tmp], 600_000);
    if (out.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error(`Umverpacken fehlgeschlagen (${out.stderr.trim().slice(0, 120) || out.code}).`);
    fs.renameSync(tmp, file);
    return { ok: true, gps: null };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    log('warn', 'media', `Standortdaten konnten nicht aus dem Original entfernt werden: ${(e as Error).message}`);
    return { ok: false, gps: null, error: (e as Error).message.slice(0, 300) };
  }
}

/** Genauer als exifHasGps: wertet die TIFF-Struktur aus (Eintrag 0x8825 in IFD0). */
function exifHasGpsPointer(exif?: Buffer): boolean {
  if (!exif) return false;
  const off = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0;
  const le = exif.toString('latin1', off, off + 2) === 'II';
  try {
    const r16 = (o: number) => (le ? exif.readUInt16LE(off + o) : exif.readUInt16BE(off + o));
    const r32 = (o: number) => (le ? exif.readUInt32LE(off + o) : exif.readUInt32BE(off + o));
    const ifd0 = r32(4);
    for (let i = 0; i < r16(ifd0); i++) if (r16(ifd0 + 2 + i * 12) === 0x8825) return true;
    return false;
  } catch {
    return exifHasGps(exif);
  }
}

/** Bereinigt ein bereits gespeichertes Original nachträglich (Auftrag „media.strip_location“, #119). */
export async function stripStoredOriginal(id: string): Promise<void> {
  const m = await one<any>(`SELECT id, mime, kind, had_location FROM media WHERE id = $1 AND status = 'ready' AND deleted_at IS NULL AND location_stripped_at IS NULL`, [id]);
  if (!m || !m.kind) return;
  const file = mediaPaths.original(id);
  if (!fs.existsSync(file)) {
    await pool.query(`UPDATE media SET location_strip_error = 'Original fehlt.' WHERE id = $1`, [id]);
    return;
  }
  const r = await stripLocation(file, m.mime, m.kind);
  const upd = await pool.query(
    `UPDATE media SET location_stripped_at = CASE WHEN $2 THEN now() END, location_strip_error = $3,
            had_location = CASE WHEN had_location IS NULL AND $2 THEN $4::boolean ELSE had_location END
      WHERE id = $1 AND deleted_at IS NULL`,
    [id, r.ok, r.ok ? null : r.error ?? 'unbekannt', r.gps],
  );
  // Währenddessen gelöscht? Dann kein Original zurücklassen
  if (!upd.rowCount) removeMediaFiles(id);
}

/** Ältere Originale ohne Bereinigung einplanen (höchstens `limit` je Lauf, ohne doppelte Aufträge). */
export async function enqueuePendingLocationStrips(limit = 200): Promise<number> {
  const r = await pool.query(
    `INSERT INTO jobs (kind, payload, dedup_key)
     SELECT 'media.strip_location', jsonb_build_object('mediaId', m.id), 'media.strip_location:' || m.id FROM media m
      WHERE m.status = 'ready' AND m.deleted_at IS NULL AND m.kind IS NOT NULL AND m.location_stripped_at IS NULL AND m.location_strip_error IS NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedup_key = 'media.strip_location:' || m.id AND j.status IN ('queued','running'))
      ORDER BY m.created_at LIMIT $1
     ON CONFLICT DO NOTHING`,
    [limit],
  );
  return r.rowCount ?? 0;
}

/** Ab so langer Wartezeit in der Quarantäne wegen nicht erreichbarer Prüfung wird die Administration informiert. */
const SCANNER_ALERT_AFTER_MS = 30 * 60_000;

/**
 * Optionale Prüfung mit ClamAV (#133). Ohne CLAMAV_HOST: keine Prüfung („clean“, bisheriges Verhalten).
 * - Treffer: Datei verwerfen, Medium abweisen, Audit und Sicherheitsmeldung.
 * - Prüfung nicht möglich (nicht erreichbar, Zeitüberschreitung, Fehler): Datei bleibt in der Quarantäne
 *   („deferred“); der Worker plant sie alle 10 Minuten erneut ein. Dauert das länger als 30 Minuten, gibt es eine
 *   Sicherheitsmeldung (gedrosselt).
 */
async function malwareScan(row: { id: string; original_name: string; created_at: Date | string }, file: string): Promise<'clean' | 'rejected' | 'deferred'> {
  const c = config.clamav;
  if (!c.host) return 'clean';
  try {
    const r = await scanFile(file, c);
    if (r.status === 'clean') return 'clean';
    removeMediaFiles(row.id);
    await pool.query(`UPDATE media SET status = 'rejected', reject_reason = $2, processed_at = now() WHERE id = $1 AND status = 'quarantine'`, [row.id, `Schadsoftware erkannt (${r.signature}). Die Datei wurde gelöscht.`.slice(0, 300)]);
    log('warn', 'media', `Schadsoftware erkannt: ${r.signature}`, { media: row.id });
    await audit({ id: null, name: 'Schadsoftwareprüfung', type: 'system' }, 'media.malware_found', { type: 'media', id: row.id, label: row.original_name }, { signatur: r.signature }, 'denied');
    await securityAlert('malware_found', {
      kind: 'error',
      title: 'Schadsoftware in einem Upload erkannt',
      body: `ClamAV hat in „${row.original_name}“ ${r.signature} gefunden. Die Datei wurde gelöscht und nicht verarbeitet. Bitte prüfen, über welchen Upload-Link sie kam (Audit-Protokoll), und den Link ggf. widerrufen.`,
      throttleKey: row.id,
    });
    return 'rejected';
  } catch (e) {
    if (!(e instanceof ScannerUnavailable)) throw e;
    log('warn', 'media', `Schadsoftwareprüfung nicht möglich, Datei bleibt in der Quarantäne: ${e.message}`, { media: row.id });
    if (Date.now() - new Date(row.created_at).getTime() > SCANNER_ALERT_AFTER_MS) {
      await securityAlert('malware_scanner', {
        title: 'Schadsoftwareprüfung nicht verfügbar – Uploads warten in der Quarantäne',
        body: `${e.message} Neue Dateien bleiben in der Quarantäne, bis ClamAV wieder prüfen kann (CLAMAV_HOST/CLAMAV_PORT, bei großen Dateien StreamMaxLength in clamd.conf).`,
        link: '/system',
        throttleKey: 'clamav',
        throttleMs: 6 * 60 * 60_000,
      });
    }
    return 'deferred';
  }
}
