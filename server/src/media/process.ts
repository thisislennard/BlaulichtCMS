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
import { noticeNewMedia } from '../lib/media-notify.js';
import { effectiveTypes, typeByMime, typeLabels } from './types.js';
import { logPublicEvent } from '../lib/public-security.js';
import { enqueueFaceDetection } from './faces.js';

/** Zugelassene Formate – geprüft wird der Dateiinhalt, nicht Dateiname oder angegebener Typ. */
export const ALLOWED: Record<string, { kind: 'image' | 'video'; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/heic': { kind: 'image', ext: 'heic' },
  'image/heif': { kind: 'image', ext: 'heif' },
  'image/avif': { kind: 'image', ext: 'avif' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'video/3gpp': { kind: 'video', ext: '3gp' },
  'video/3gpp2': { kind: 'video', ext: '3gp' },
};

/** Zugelassene Video- und Audiocodecs (wie LiFeOS); eingebettete Titelbilder zählen nicht. */
export const VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'av1', 'vp8', 'vp9', 'prores', 'h263']);
export const AUDIO_CODECS = new Set(['aac', 'mp3', 'alac', 'pcm_s16le', 'pcm_s24le', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'amr_nb', 'amr_wb']);

/** Bildgrenze aus den Einstellungen (Megapixel → Pixel), Schutz vor „Dekompressionsbomben“. */
export async function imagePixelLimit(): Promise<number> {
  return Math.max(1, Number((await getSettings())['media.max_image_mp']) || 40) * 1_000_000;
}

/**
 * Dekodierprüfung wie LiFeOS: Videos bis `fullSeconds` Bild für Bild; längere: den Anfang Bild für Bild und über die
 * ganze Länge alle Schlüsselbilder. Liefert die ffprobe-Zusatzargumente je Durchlauf.
 */
export function decodePlan(duration: number, fullSeconds: number): string[][] {
  if (duration <= fullSeconds) return [[]];
  return [['-read_intervals', `%+${fullSeconds}`], ['-skip_frame', 'nokey']];
}

/**
 * Fehlermeldungen eines Dekodierlaufs: Meldungen der Audio-Parser (z. B. „[opus @ …] Error parsing Opus packet header“
 * bei WebM vom Handy) sperren nicht – geprüft wird die Videospur.
 */
export function decodeErrors(stderr: string, streams: any[]): string[] {
  const audioTags = streams.filter((s) => s?.codec_type === 'audio').map((s) => `[${s.codec_name} @`);
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !audioTags.some((t) => l.startsWith(t)));
}

export const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm';

// Höchstens 40 Megapixel dekodieren (Schutz vor „Dekompressionsbomben“)
export const MAX_PIXELS = 40_000_000;
const MAX_VIDEO_PIXELS = 7680 * 4320;
// Threads je Bild begrenzen: parallel laufen ohnehin mehrere Aufträge (Einstellung „Parallele Hintergrundaufträge“)
sharp.concurrency(Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2))));
sharp.cache(false);

/**
 * Prüfbefund: Die Datei wird gesperrt (bleibt in der Quarantäne, „Erneut prüfen“ möglich). `step` sagt, welche Prüfung
 * angeschlagen hat: type (Dateityp), structure (Aufbau), limits (Länge/Auflösung), decode (Dekodierprüfung).
 */
export class Rejected extends Error {
  constructor(
    message: string,
    public step: 'type' | 'structure' | 'limits' | 'decode' = 'structure',
  ) {
    super(message);
  }
}

/** Alles entfernen, was bei der Prüfung entstanden ist – außer der Datei in der Quarantäne (gesperrte Dateien). */
export function removeDerivedFiles(id: string) {
  for (const p of [mediaPaths.original(id), mediaPaths.preview(id), mediaPaths.preview(id) + '.png', ...['jpg', 'mp4', 'webm', 'png'].map((e) => mediaPaths.publicFile(id, e))]) fs.rmSync(p, { force: true });
}

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
    if (!Number.isFinite(w) || !Number.isFinite(h) || w * h > maxPixels) throw new Rejected('Videoauflösung ist zu hoch (höchstens 8K).', 'limits');
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
  const s = await getSettings();
  const limit = await imagePixelLimit();
  let meta: Metadata;
  try {
    meta = await sharp(file, { limitInputPixels: limit, failOn: 'error' }).metadata();
  } catch (e) {
    const big = /pixel limit/i.test((e as Error).message);
    throw new Rejected(big ? `Bild ist größer als ${s['media.max_image_mp']} Megapixel.` : `Bild ist beschädigt oder zu groß (${(e as Error).message.slice(0, 120)}).`, big ? 'limits' : 'decode');
  }
  if (!meta.width || !meta.height) throw new Rejected('Bildgröße konnte nicht gelesen werden.');
  // Animierte Bilder (GIF, WebP, PNG, AVIF mit mehreren Bildern) nur mit Einstellung; verarbeitet wird das erste Bild
  if ((meta.pages ?? 1) > 1 && !s['media.allow_animated']) throw new Rejected('Animierte Bilder sind nicht erlaubt (Einstellungen → Medien & Upload).', 'type');
  try {
    // Einmal dekodieren, zwei Ausgaben: Vorschau (WebP) und öffentliche Fassung (JPEG ohne EXIF/XMP/IPTC)
    const base = sharp(file, { limitInputPixels: limit, failOn: 'error', sequentialRead: true }).rotate();
    await Promise.all([
      base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, effort: 3 }).toFile(mediaPaths.preview(id)),
      base.clone().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toFile(mediaPaths.publicFile(id, 'jpg')),
    ]);
  } catch (e) {
    throw new Rejected(`Bild konnte nicht verarbeitet werden (${(e as Error).message.slice(0, 120)}).`, 'decode');
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

/** Dekodierprüfung mit ffprobe -count_frames (ohne Muxer – ffmpeg -f null sperrte Handyvideos mit variabler Bildrate). */
async function decodeCheck(file: string, streams: any[], duration: number) {
  const s = await getSettings();
  const timeout = Math.max(60, Number(s['media.check_timeout_s']) || 1800) * 1000;
  for (const extra of decodePlan(duration, Number(s['media.full_decode_seconds']) || 60)) {
    const r = await run('ffprobe', ['-v', 'error', ...extra, '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file], timeout);
    if (r.code === -1 && r.stderr === 'nicht verfügbar') throw new Rejected('Videos können auf dieser Installation nicht geprüft werden (ffprobe fehlt).');
    if (r.code === -1) throw new Rejected('Zeitüberschreitung beim Dekodieren.', 'decode');
    const errors = decodeErrors(r.stderr, streams);
    if (r.code !== 0 || errors.length) throw new Rejected(`Video nicht fehlerfrei dekodierbar (${(errors[0] ?? `Exit ${r.code}`).replace(file, '<datei>').slice(0, 120)}).`, 'decode');
    let frames = 0;
    try {
      frames = Number(JSON.parse(r.stdout || '{}').streams?.[0]?.nb_read_frames ?? 0);
    } catch {
      frames = 0;
    }
    if (!(frames > 0)) throw new Rejected('Video enthält keine dekodierbaren Bilder.', 'decode');
  }
}

async function processVideo(id: string, file: string, ext: string, opts: { skipDecode?: boolean } = {}) {
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
  const s = await getSettings();
  // Codecs wie LiFeOS: nur bekannte Video- und Audiocodecs (eingebettete Titelbilder ausgenommen)
  for (const st of info.streams ?? []) {
    if (st.codec_type === 'video' && !st.disposition?.attached_pic && !VIDEO_CODECS.has(st.codec_name)) throw new Rejected(`Videocodec ${String(st.codec_name).slice(0, 20)} ist nicht erlaubt.`);
    if (st.codec_type === 'audio' && !AUDIO_CODECS.has(st.codec_name)) throw new Rejected(`Audiocodec ${String(st.codec_name).slice(0, 20)} ist nicht erlaubt.`);
  }
  // Ressourcenschutz: Länge und Auflösung (längere Kante) begrenzen
  const maxMin = s['media.max_video_minutes'];
  const duration = Number(info.format?.duration ?? v.duration ?? 0);
  if (duration > maxMin * 60) throw new Rejected(`Video ist länger als ${maxMin} Minuten.`, 'limits');
  const edge = Number(s['media.max_video_edge']) || 7680;
  if (Math.max(Number(v.width) || 0, Number(v.height) || 0) > edge) throw new Rejected(`Videoauflösung ist zu hoch (längere Kante höchstens ${edge} Pixel).`, 'limits');
  // Dekodierprüfung (abschaltbar; entfällt bei „Trotzdem freigeben“)
  if (s['media.video_full_decode'] && !opts.skipDecode) await decodeCheck(file, info.streams ?? [], duration);
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
  const pub = await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', `0:${v.index}`, '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', ...(outExt === 'mp4' ? ['-movflags', '+faststart'] : []), mediaPaths.publicFile(id, outExt)], Math.max(600, Number(s['media.check_timeout_s']) || 1800) * 1000);
  // Abgebrochene/fehlgeschlagene Umverpackung hinterlässt sonst eine Teildatei (#73)
  if (pub.code !== 0) fs.rmSync(mediaPaths.publicFile(id, outExt), { force: true });
  return { width: v.width ?? null, height: v.height ?? null, hadLocation, hasPreview, hasPublic: pub.code === 0, takenAt: null };
}

/**
 * Prüft eine Datei aus der Quarantäne: Typ anhand des Inhalts, Dekodierbarkeit, Vorschau,
 * öffentliche Fassung ohne Standortdaten. Erst danach wird sie sichtbar („ready“).
 */
export async function processMedia(id: string): Promise<'ready' | 'rejected' | 'blocked' | 'skipped' | 'deferred'> {
  const row = await one<any>(
    `SELECT m.id, m.status, m.original_name, m.created_at, m.upload_link_id, m.skip_decode, l.allowed_types AS link_types FROM media m LEFT JOIN upload_links l ON l.id = m.upload_link_id WHERE m.id = $1`,
    [id],
  );
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
    // Erlaubte Typen: global (media.allowed_types) und je Upload-Link (Paket 6)
    const types = effectiveTypes((await getSettings())['media.allowed_types'], row.link_types ?? null);
    const def = ft ? typeByMime(ft.mime) : undefined;
    const allowed = ft && def && types.includes(def.key) ? ALLOWED[ft.mime] : undefined;
    if (!ft || !allowed) {
      const what = !ft ? 'Das Dateiformat wurde nicht erkannt und ist deshalb nicht erlaubt.' : def ? `Der Dateityp ${def.label.replace(/ \(.*\)$/, '')} ist für diesen Upload nicht erlaubt.` : `Das Dateiformat ${ft.mime} ist nicht erlaubt.`;
      throw new Rejected(`${what} Erlaubt sind: ${typeLabels(types)}.`, 'type');
    }
    // „Trotzdem freigeben“ (nur Videos mit reinem Dekodierbefund): Typ, Aufbau und Grenzen werden weiter geprüft
    const r = allowed.kind === 'image' ? await processImage(id, file, ft.mime) : await processVideo(id, file, allowed.ext, { skipDecode: !!row.skip_decode });
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
    await markDuplicate(id);
    await noticeNewMedia(id);
    // Gesichtsvorschläge (#214): nur Bilder mit öffentlicher Fassung; die Suche läuft als eigener Auftrag
    if (allowed.kind === 'image' && r.hasPublic && (await getSettings())['media.face_detect']) {
      await enqueueFaceDetection(id).catch((e) => log('warn', 'media', `Gesichtssuche nicht eingeplant: ${(e as Error).message}`, { media: id }));
    }
    return 'ready';
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    // Gesperrt statt gelöscht (wie LiFeOS): Die Datei bleibt in der Quarantäne (nie ausgeliefert), Vorschau und halbe
    // öffentliche Fassung werden entfernt (#73). Erneut prüfen, trotzdem freigeben (Video, nur Dekodierbefund) oder
    // endgültig löschen darf „Medien administrieren“; nach media.blocked_days löscht die Löschfrist.
    removeDerivedFiles(id);
    const r = await pool.query(`UPDATE media SET status = 'blocked', reject_reason = $2, reject_step = $3, processed_at = now() WHERE id = $1 AND status = 'quarantine'`, [id, e.message.slice(0, 300), e.step]);
    log('info', 'media', `Datei gesperrt (${e.step}): ${e.message}`, { media: id });
    if (r.rowCount) await logPublicEvent('file_rejected', { linkId: row.upload_link_id, mediaId: id, detail: `${e.step}: ${e.message}`, throttle: false });
    return 'blocked';
  }
}

/**
 * Duplikat-Hinweis wie LiFeOS: gleiche Prüfsumme (SHA-256) wie eine ältere, nicht gelöschte Datei – gleich in welcher
 * Sammlung. Gespeichert wird beides weiterhin; die Oberfläche zeigt nur einen Hinweis mit Verweis auf das Original.
 */
export async function markDuplicate(id: string) {
  await pool.query(
    `UPDATE media m SET duplicate_of = (
        SELECT o.id FROM media o WHERE o.sha256 = m.sha256 AND o.id <> m.id AND o.deleted_at IS NULL AND o.status <> 'rejected' AND o.created_at <= m.created_at
         ORDER BY o.created_at, o.id LIMIT 1)
      WHERE m.id = $1`,
    [id],
  );
}

const VIDEO_FORMAT: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/3gpp2': '3g2' };

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
        const meta = await sharp(tmp, { limitInputPixels: await imagePixelLimit(), failOn: 'error' }).metadata();
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
    // Schadsoftware: Datei sofort löschen, nie freigebbar (bleibt „rejected“, nicht „blocked“)
    removeMediaFiles(row.id);
    await logPublicEvent('file_rejected', { mediaId: row.id, detail: `Schadsoftware: ${r.signature}`, throttle: false });
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
