import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

/**
 * Private Medienablage unter /data/media – nie im Webroot, Auslieferung nur über geprüfte API-Routen.
 *   quarantine/<id>       frisch hochgeladen, ungeprüft
 *   originals/<aa>/<id>   geprüftes Original (unverändert, inkl. Metadaten, nur intern)
 *   previews/<id>.webp    Vorschaubild für die Oberfläche
 *   public/<id>.<ext>     öffentliche Fassung ohne Standort- und Kameradaten (für Kanäle)
 */
export const mediaPaths = {
  root: () => config.mediaDir,
  quarantine: (id: string) => path.join(config.mediaDir, 'quarantine', id),
  original: (id: string) => path.join(config.mediaDir, 'originals', id.slice(0, 2), id),
  preview: (id: string) => path.join(config.mediaDir, 'previews', `${id}.webp`),
  publicFile: (id: string, ext: string) => path.join(config.mediaDir, 'public', `${id}.${ext}`),
  tmp: () => path.join(config.mediaDir, 'tmp'),
};

export function ensureMediaDirs() {
  for (const d of ['quarantine', 'originals', 'previews', 'public', 'tmp']) {
    fs.mkdirSync(path.join(config.mediaDir, d), { recursive: true, mode: 0o700 });
  }
}

export class SizeLimitError extends Error {}

/** Schreibt einen Stream in eine temporäre Datei, zählt Bytes und bildet SHA-256 – mit harter Obergrenze. */
export async function streamToTemp(stream: Readable, maxBytes: number): Promise<{ tmpPath: string; size: number; sha256: string; head: Buffer }> {
  ensureMediaDirs();
  const tmpPath = path.join(mediaPaths.tmp(), `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const headChunks: Buffer[] = [];
  let headLen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new SizeLimitError(`Datei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB.`));
      hash.update(chunk);
      if (headLen < 4100) {
        headChunks.push(chunk);
        headLen += chunk.length;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, fs.createWriteStream(tmpPath, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    throw e;
  }
  // @fastify/multipart kürzt Dateien über dem Limit, statt einen Fehler zu werfen
  if ((stream as any).truncated) {
    fs.rmSync(tmpPath, { force: true });
    throw new SizeLimitError(`Datei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  return { tmpPath, size, sha256: hash.digest('hex'), head: Buffer.concat(headChunks).subarray(0, 4100) };
}

export function moveFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

export function removeMediaFiles(id: string) {
  for (const p of [mediaPaths.quarantine(id), mediaPaths.original(id), mediaPaths.preview(id), mediaPaths.publicFile(id, 'jpg'), mediaPaths.publicFile(id, 'mp4'), mediaPaths.publicFile(id, 'webm'), mediaPaths.publicFile(id, 'png')]) {
    fs.rmSync(p, { force: true });
  }
}

export function freeBytes(): number | null {
  try {
    const st = fs.statfsSync(config.dataDir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}
