import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import type { Actor } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { ensureMediaDirs, mediaPaths } from '../media/storage.js';
import { finalizeUpload, loadPublicLink, mediaPayload, uploadAllowance, type UploadContext } from './media.js';

/**
 * Fortsetzbarer Upload in Teilen (Chunks). Ablauf je Datei:
 *   POST  …/sessions            { clientKey, name, size, type, note } → { id, received, complete }
 *   PUT   …/sessions/:id?offset=N   Rohdaten (application/octet-stream, max. 16 MB je Teil)
 *   GET   …/sessions/:id            → { received, complete }
 * Bricht die Verbindung ab, fragt der Client den Stand ab und sendet ab „received“ weiter.
 * Dieselbe Datei (gleicher Client-Schlüssel) wird nie doppelt angelegt.
 */
export const MAX_CHUNK = 16 * 1024 * 1024;
const partPath = (id: string) => path.join(mediaPaths.tmp(), `upload-${id}.part`);
const clientKeyRe = /^[A-Za-z0-9_-]{8,80}$/;

const createBody = z.object({
  clientKey: z.string().regex(clientKeyRe),
  name: z.string().trim().min(1).max(250),
  size: z.number().int().min(1),
  type: z.string().max(100).default(''),
  note: z.string().max(500).default(''),
});

function sessionPayload(s: any, media?: any) {
  return { id: s.id, received: Number(s.received_bytes), size: Number(s.size_bytes), complete: !!s.media_id, media: media ? mediaPayload(media) : undefined };
}

async function createSession(ctx: UploadContext, body: z.infer<typeof createBody>) {
  // Schon vollständig hochgeladen (z. B. nach Abbruch der letzten Antwort)? → als Duplikat melden
  const existingMedia = await one<any>(`SELECT * FROM media WHERE collection_id = $1 AND client_key = $2 AND deleted_at IS NULL`, [ctx.collection.id, body.clientKey]);
  if (existingMedia) return { id: null, received: Number(existingMedia.size_bytes), size: Number(existingMedia.size_bytes), complete: true, duplicate: true };
  const existing = await one<any>(`SELECT * FROM upload_sessions WHERE collection_id = $1 AND client_key = $2`, [ctx.collection.id, body.clientKey]);
  if (existing) {
    if (Number(existing.size_bytes) !== body.size) throw new AppError(409, 'session_mismatch', 'Für diese Datei läuft bereits ein Upload mit anderer Größe.');
    // Teil-Datei und Datenbankstand abgleichen (z. B. nach Neustart)
    const onDisk = fs.existsSync(partPath(existing.id)) ? fs.statSync(partPath(existing.id)).size : 0;
    if (onDisk !== Number(existing.received_bytes)) {
      await pool.query('UPDATE upload_sessions SET received_bytes = $2 WHERE id = $1', [existing.id, onDisk]);
      existing.received_bytes = onDisk;
    }
    return sessionPayload(existing);
  }
  const limit = await uploadAllowance(ctx);
  if (body.size > limit) throw new AppError(413, 'file_too_large', limit < ctx.maxFileBytes ? 'Die Datei passt nicht mehr in den verbleibenden Speicher der Sammlung.' : `Datei ist größer als ${Math.round(limit / 1024 / 1024)} MB.`);
  const s = await one<any>(
    `INSERT INTO upload_sessions (collection_id, upload_link_id, user_id, client_key, file_name, declared_type, note, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (collection_id, client_key) DO NOTHING RETURNING *`,
    [ctx.collection.id, ctx.linkId, ctx.userId, body.clientKey, body.name.replace(/[\u0000-\u001f\\/]/g, '_'), body.type, body.note, body.size],
  );
  if (!s) return sessionPayload(await one<any>(`SELECT * FROM upload_sessions WHERE collection_id = $1 AND client_key = $2`, [ctx.collection.id, body.clientKey]));
  ensureMediaDirs();
  fs.writeFileSync(partPath(s.id), Buffer.alloc(0), { mode: 0o600 });
  return sessionPayload(s);
}

/** Einen Teil anhängen. Nur in Reihenfolge; ein falscher Offset liefert 409 mit dem tatsächlichen Stand. */
async function appendChunk(ctx: UploadContext, sessionId: string, offset: number, req: FastifyRequest) {
  const s = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1 AND collection_id = $2`, [sessionId, ctx.collection.id]);
  if (!s) throw notFound('Upload-Sitzung nicht gefunden.');
  if (s.media_id) return sessionPayload(s, await one('SELECT * FROM media WHERE id = $1', [s.media_id]));
  const file = partPath(s.id);
  const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (offset !== have) {
    (req.body as any)?.resume?.();
    throw new AppError(409, 'offset_mismatch', 'Teil passt nicht zum bisherigen Stand.', { received: have });
  }
  const size = Number(s.size_bytes);
  const stream = req.body as NodeJS.ReadableStream;
  let written = 0;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'a' });
    stream.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > MAX_CHUNK || have + written > size) {
        stream.removeAllListeners('data');
        out.destroy();
        reject(new AppError(413, 'chunk_too_large', 'Teil ist zu groß.'));
        return;
      }
      if (!out.write(chunk)) {
        (stream as any).pause();
        out.once('drain', () => (stream as any).resume());
      }
    });
    stream.on('end', () => out.end(() => resolve()));
    stream.on('error', (e) => (out.destroy(), reject(e)));
    out.on('error', reject);
  }).catch(async (e) => {
    // Bei Abbruch nur vollständig geschriebene Daten behalten (Datei auf geschriebenen Stand kürzen ist nicht nötig:
    // der nächste Abgleich nutzt die tatsächliche Dateigröße)
    throw e;
  });
  const received = fs.statSync(file).size;
  await pool.query('UPDATE upload_sessions SET received_bytes = $2, updated_at = now() WHERE id = $1', [s.id, received]);
  if (received < size) return { id: s.id, received, size, complete: false };

  // Vollständig: Prüfsumme bilden und wie jeden Upload in die Quarantäne übernehmen
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve()).on('error', reject));
  const res = await finalizeUpload({ ...ctx, stored: { tmpPath: file, size: received, sha256: hash.digest('hex') }, name: s.file_name, declaredType: s.declared_type, note: s.note, clientKey: s.client_key });
  await pool.query('UPDATE upload_sessions SET media_id = $2, updated_at = now() WHERE id = $1', [s.id, res.media.id]);
  return { id: s.id, received, size, complete: true, duplicate: res.duplicate, media: res.media };
}

async function status(collectionId: string, sessionId: string) {
  const s = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1 AND collection_id = $2`, [sessionId, collectionId]);
  if (!s) throw notFound('Upload-Sitzung nicht gefunden.');
  const file = partPath(s.id);
  const received = s.media_id ? Number(s.size_bytes) : fs.existsSync(file) ? fs.statSync(file).size : 0;
  return { id: s.id, received, size: Number(s.size_bytes), complete: !!s.media_id };
}

export async function cleanupUploadSessions() {
  const old = await pool.query(`DELETE FROM upload_sessions WHERE expires_at < now() RETURNING id`);
  for (const r of old.rows) fs.rmSync(partPath(r.id), { force: true });
}

export async function uploadRoutes(app: FastifyInstance) {
  // Rohdaten-Teile als Stream annehmen (ohne Puffern im Speicher)
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const publicCtx = async (token: string, req: FastifyRequest): Promise<UploadContext & { link: any }> => {
    const l = await loadPublicLink(token);
    const s = await getSettings();
    return {
      link: l,
      collection: { id: l.c_id, max_files: l.c_max_files, max_bytes: l.c_max_bytes },
      linkId: l.id,
      userId: null,
      maxFileBytes: Math.min(Number(l.max_file_bytes), s['media.max_file_mb'] * 1024 * 1024),
      actor: { id: null, name: `Upload-Link ${l.label || l.id.slice(0, 8)}`, type: 'system', ip: req.ip } as Actor,
    };
  };
  const internalCtx = async (collectionId: string, req: FastifyRequest): Promise<UploadContext> => {
    const c = await one<any>('SELECT * FROM collections WHERE id = $1', [collectionId]);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    if (c.archived_at) throw badRequest('Die Sammlung ist archiviert.');
    const s = await getSettings();
    return { collection: c, linkId: null, userId: req.auth!.user?.id ?? null, maxFileBytes: s['media.max_file_mb'] * 1024 * 1024, actor: req.auth!.actor };
  };
  const lim = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const tokenP = z.object({ token: z.string().min(10).max(100) });
  const sessP = z.object({ token: z.string().min(10).max(100), id: z.uuid() });
  const offQ = z.object({ offset: z.coerce.number().int().min(0) });

  /* Öffentlich über Upload-Link */
  app.post('/public/upload/:token/sessions', lim(120), async (req) => {
    const { token } = tokenP.parse(req.params);
    const ctx = await publicCtx(token, req);
    const body = createBody.parse(req.body);
    const existing = await one(`SELECT 1 FROM upload_sessions WHERE collection_id = $1 AND client_key = $2`, [ctx.collection.id, body.clientKey]);
    if (!existing && ctx.link.upload_count >= ctx.link.max_files) throw new AppError(409, 'link_full', 'Über diesen Link wurden bereits alle erlaubten Dateien hochgeladen.');
    const r = await createSession(ctx, body);
    return { id: r.id, received: r.received, size: r.size, complete: r.complete, duplicate: (r as any).duplicate ?? false, chunkSize: 8 * 1024 * 1024 };
  });
  app.get('/public/upload/:token/sessions/:id', lim(600), async (req) => {
    const { token, id } = sessP.parse(req.params);
    const ctx = await publicCtx(token, req);
    return status(ctx.collection.id, id);
  });
  app.put('/public/upload/:token/sessions/:id', { ...lim(600), bodyLimit: MAX_CHUNK + 1024 }, async (req) => {
    const { token, id } = sessP.parse(req.params);
    const { offset } = offQ.parse(req.query);
    const ctx = await publicCtx(token, req);
    const r = await appendChunk(ctx, id, offset, req);
    // Öffentliche Antwort ohne interne Details
    return { id: r.id, received: r.received, size: r.size, complete: r.complete, duplicate: (r as any).duplicate ?? false };
  });

  /* Angemeldet (Medienverwaltung) */
  const collP = z.object({ cid: z.uuid() });
  const collSessP = z.object({ cid: z.uuid(), id: z.uuid() });
  app.post('/collections/:cid/upload-sessions', { preHandler: requireAuth('media.manage'), ...lim(240) }, async (req) => {
    const { cid } = collP.parse(req.params);
    const r = await createSession(await internalCtx(cid, req), createBody.parse(req.body));
    return { ...r, chunkSize: 8 * 1024 * 1024 };
  });
  app.get('/collections/:cid/upload-sessions/:id', { preHandler: requireAuth('media.manage') }, async (req) => {
    const { cid, id } = collSessP.parse(req.params);
    return status(cid, id);
  });
  app.put('/collections/:cid/upload-sessions/:id', { preHandler: requireAuth('media.manage'), bodyLimit: MAX_CHUNK + 1024, ...lim(1200) }, async (req) => {
    const { cid, id } = collSessP.parse(req.params);
    const { offset } = offQ.parse(req.query);
    return appendChunk(await internalCtx(cid, req), id, offset, req);
  });
}
