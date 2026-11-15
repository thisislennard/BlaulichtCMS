import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import type { Actor } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { ensureMediaDirs, freeBytes, mediaPaths } from '../media/storage.js';
import { finalizeUpload, mediaPayload, publicRateLimit, publicUploadContext, publicUploaderFrom, UPLOAD_REF_RE, uploadAllowance, withPublicEvents, type UploadContext } from './media.js';
import { assertLinkRoom } from '../media/public-link.js';
import { assertFolder } from './media-organize.js';

/**
 * Fortsetzbarer Upload in Teilen (Chunks). Ablauf je Datei:
 *   POST  …/sessions            { clientKey, name, size, type, note } → { id, received, complete }
 *   PUT   …/sessions/:id?offset=N   Rohdaten (application/octet-stream, max. 16 MB je Teil)
 *   GET   …/sessions/:id            → { received, complete }
 * Bricht die Verbindung ab, fragt der Client den Stand ab und sendet ab „received“ weiter.
 * Dieselbe Datei (gleicher Client-Schlüssel) wird nie doppelt angelegt.
 */
export const MAX_CHUNK = 16 * 1024 * 1024;
const partPath = (id: string) => mediaPaths.uploadPart(id);
const clientKeyRe = /^[A-Za-z0-9_-]{8,80}$/;

const createBody = z.object({
  clientKey: z.string().regex(clientKeyRe),
  name: z.string().trim().min(1).max(250),
  size: z.number().int().min(1, 'Die Datei ist leer.'),
  type: z.string().max(100).default(''),
  note: z.string().max(500).default(''),
  /** Vorgangsnummer der Upload-Seite (#141), z. B. „K7M2-Q9XD“ */
  ref: z.string().regex(UPLOAD_REF_RE).optional(),
  /** Zielordner (nur interner Upload; öffentlich gilt der Zielordner des Links) */
  folderId: z.uuid().optional(),
  /** Abgefragte Angaben der Hochladenden (je nach Link) und Bestätigung */
  uploader: z.object({ name: z.string().max(200).optional(), email: z.string().max(300).optional(), place: z.string().max(300).optional(), date: z.string().max(20).optional() }).optional(),
  consent: z.boolean().optional(),
});

function sessionPayload(s: any, media?: any) {
  return { id: s.id, received: Number(s.received_bytes), size: Number(s.size_bytes), complete: !!s.media_id, media: media ? mediaPayload(media) : undefined };
}

/**
 * Abgeschlossene Sitzung, deren Datei inzwischen (weich) gelöscht wurde (#176): Sitzung entfernen, damit derselbe
 * Client-Schlüssel neu hochladen kann, statt „vollständig“ gemeldet zu bekommen. Gibt true zurück, wenn entfernt.
 */
async function staleFinishedSession(s: any): Promise<boolean> {
  if (!s.media_id) return false;
  const alive = await one(`SELECT 1 FROM media WHERE id = $1 AND deleted_at IS NULL`, [s.media_id]);
  if (alive) return false;
  await pool.query('DELETE FROM upload_sessions WHERE id = $1', [s.id]);
  fs.rmSync(partPath(s.id), { force: true });
  return true;
}

async function createSession(ctx: UploadContext, body: z.infer<typeof createBody>, extra: { uploader?: Record<string, string> | null; consentAt?: Date | null } = {}) {
  // Schon vollständig hochgeladen (z. B. nach Abbruch der letzten Antwort)? → als Duplikat melden
  const existingMedia = await one<any>(`SELECT * FROM media WHERE collection_id = $1 AND client_key = $2 AND deleted_at IS NULL`, [ctx.collection.id, body.clientKey]);
  if (existingMedia) return { id: null, received: Number(existingMedia.size_bytes), size: Number(existingMedia.size_bytes), complete: true, duplicate: true };
  let existing = await one<any>(`SELECT * FROM upload_sessions WHERE collection_id = $1 AND client_key = $2`, [ctx.collection.id, body.clientKey]);
  if (existing && (await staleFinishedSession(existing))) existing = null;
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
  // Prüfen und Anlegen unter der Sammlungssperre: parallele Sitzungsanlagen sehen sonst alle denselben Rest (#151)
  const s = await tx(async (db) => {
    await db.query(`SELECT 1 FROM collections WHERE id = $1 FOR UPDATE`, [ctx.collection.id]);
    if (ctx.linkId) {
      // Link-Kontingent ebenfalls unter Sperre: übernommene Dateien plus offene Sitzungen über diesen Link
      const l = await one<any>(
        `SELECT l.upload_count, l.max_files, (SELECT count(*)::int FROM upload_sessions s WHERE s.upload_link_id = l.id AND s.media_id IS NULL AND s.expires_at > now()) AS open
           FROM upload_links l WHERE l.id = $1`,
        [ctx.linkId],
        db,
      );
      if (l && l.upload_count + l.open >= l.max_files) throw new AppError(409, 'link_full', 'Über diesen Link wurden bereits alle erlaubten Dateien hochgeladen.');
      // Weitere Grenzen des Links (Uploads, Dateien je Upload, Gesamtgröße)
      if (ctx.link) await assertLinkRoom(db, ctx.link, { ref: body.ref ?? null, size: body.size });
    }
    const limit = await uploadAllowance(ctx, db);
    if (body.size > limit) throw new AppError(413, 'file_too_large', limit < ctx.maxFileBytes ? 'Die Datei passt nicht mehr in den verbleibenden Speicher der Sammlung.' : `Datei ist größer als ${Math.round(limit / 1024 / 1024)} MB.`);
    return one<any>(
      `INSERT INTO upload_sessions (collection_id, upload_link_id, user_id, client_key, file_name, declared_type, note, size_bytes, upload_ref, folder_id, uploader, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (collection_id, client_key) DO NOTHING RETURNING *`,
      [ctx.collection.id, ctx.linkId, ctx.userId, body.clientKey, body.name.replace(/[\u0000-\u001f\\/]/g, '_'), body.type, body.note, body.size, body.ref ?? null, ctx.folderId ?? null, extra.uploader ? JSON.stringify(extra.uploader) : null, extra.consentAt ?? null],
      db,
    );
  });
  if (!s) return sessionPayload(await one<any>(`SELECT * FROM upload_sessions WHERE collection_id = $1 AND client_key = $2`, [ctx.collection.id, body.clientKey]));
  ensureMediaDirs();
  fs.writeFileSync(partPath(s.id), Buffer.alloc(0), { mode: 0o600 });
  return sessionPayload(s);
}

/**
 * Teile derselben Sitzung nacheinander verarbeiten (#56): Wiederholt ein Handy einen Teil, während der erste PUT noch
 * läuft, würden sonst beide an dieselbe Datei anhängen. Ein Prozess-Mutex genügt – die API läuft im Container als
 * genau ein Prozess. Der wartende Aufruf sieht danach den neuen Stand und bekommt 409 mit dem tatsächlichen Offset.
 */
const sessionLocks = new Map<string, Promise<void>>();
async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  sessionLocks.set(id, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(id) === chain) sessionLocks.delete(id);
  }
}

/** Einen Teil anhängen. Nur in Reihenfolge; ein falscher Offset liefert 409 mit dem tatsächlichen Stand. */
function appendChunk(ctx: UploadContext, sessionId: string, offset: number, req: FastifyRequest) {
  return withSessionLock(sessionId, () => appendChunkLocked(ctx, sessionId, offset, req));
}

async function appendChunkLocked(ctx: UploadContext, sessionId: string, offset: number, req: FastifyRequest) {
  const s = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1 AND collection_id = $2`, [sessionId, ctx.collection.id]);
  if (!s) throw notFound('Upload-Sitzung nicht gefunden.');
  if (s.media_id) {
    const m = await one('SELECT * FROM media WHERE id = $1 AND deleted_at IS NULL', [s.media_id]);
    if (m) return sessionPayload(s, m);
    await staleFinishedSession(s);
    throw new AppError(410, 'session_gone', 'Die Datei dieser Sitzung wurde inzwischen gelöscht. Bitte erneut hochladen.');
  }
  const file = partPath(s.id);
  const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (offset !== have) {
    (req.body as any)?.resume?.();
    throw new AppError(409, 'offset_mismatch', 'Teil passt nicht zum bisherigen Stand.', { received: have });
  }
  const size = Number(s.size_bytes);
  const free = freeBytes();
  if (free !== null && free < (await getSettings())['media.min_free_gb'] * 1024 ** 3) {
    (req.body as any)?.resume?.();
    throw new AppError(507, 'storage_full', 'Der Speicher von BlaulichtCMS ist fast voll. Uploads sind vorübergehend gesperrt.');
  }
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
  let res;
  try {
    res = await finalizeUpload({ ...ctx, folderId: s.folder_id ?? ctx.folderId ?? null, stored: { tmpPath: file, size: received, sha256: hash.digest('hex') }, name: s.file_name, declaredType: s.declared_type, note: s.note, uploader: s.uploader ?? null, consentAt: s.consent_at ?? null, uploadRef: s.upload_ref, clientKey: s.client_key, sessionId: s.id, keepTmpOnError: true });
  } catch (e) {
    // Endgültig (Kontingent erschöpft): Sitzung und Teildatei entfernen, sonst reserviert die Sitzung 24 h lang Platz
    // in Sammlung und Link (#152). Vorübergehende Fehler (z. B. Datenbank): Teildatei bleibt, ein leerer Teil am Ende
    // stößt den Abschluss erneut an, ohne dass die ganze Datei neu gesendet werden muss.
    if (e instanceof AppError && ['collection_full', 'link_full', 'upload_full', 'collection_gone', 'link_closed'].includes(e.code)) {
      await pool.query('DELETE FROM upload_sessions WHERE id = $1 AND media_id IS NULL', [s.id]);
      fs.rmSync(file, { force: true });
    }
    throw e;
  }
  await pool.query('UPDATE upload_sessions SET media_id = $2, updated_at = now() WHERE id = $1', [s.id, res.media.id]);
  return { id: s.id, received, size, complete: true, duplicate: res.duplicate, media: res.media };
}

async function status(collectionId: string, sessionId: string) {
  const s = await one<any>(`SELECT * FROM upload_sessions WHERE id = $1 AND collection_id = $2`, [sessionId, collectionId]);
  if (!s) throw notFound('Upload-Sitzung nicht gefunden.');
  const file = partPath(s.id);
  if (await staleFinishedSession(s)) throw new AppError(410, 'session_gone', 'Die Datei dieser Sitzung wurde inzwischen gelöscht. Bitte erneut hochladen.');
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

  const publicCtx = (token: string, req: FastifyRequest) => publicUploadContext(req, token);
  const internalCtx = async (collectionId: string, req: FastifyRequest): Promise<UploadContext> => {
    const c = await one<any>('SELECT * FROM collections WHERE id = $1', [collectionId]);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    if (c.archived_at) throw badRequest('Die Sammlung ist archiviert.');
    const s = await getSettings();
    return { collection: c, linkId: null, userId: req.auth!.user?.id ?? null, maxFileBytes: s['media.max_file_mb'] * 1024 * 1024, actor: req.auth!.actor };
  };
  const lim = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const plim = (max: number) => ({ config: { rateLimit: publicRateLimit(max) } });
  const tokenP = z.object({ token: z.string().min(10).max(100) });
  const sessP = z.object({ token: z.string().min(10).max(100), id: z.uuid() });
  const offQ = z.object({ offset: z.coerce.number().int().min(0) });

  /* Öffentlich über Upload-Link */
  app.post('/public/upload/:token/sessions', plim(120), async (req) => {
    const { token } = tokenP.parse(req.params);
    const ctx = await publicCtx(token, req);
    const body = createBody.parse(req.body);
    // Abgefragte Angaben und Bestätigung prüfen; abgeschaltete Felder werden verworfen
    const extra = publicUploaderFrom(ctx.link, { uploader: body.uploader, consent: body.consent, note: body.note });
    // Link-Kontingent (übernommene Dateien + offene Sitzungen) prüft createSession unter der Sammlungssperre (#151)
    const r = await withPublicEvents(req, ctx.link.id, () => createSession(ctx, { ...body, note: extra.note }, extra));
    return { id: r.id, received: r.received, size: r.size, complete: r.complete, duplicate: (r as any).duplicate ?? false, chunkSize: 8 * 1024 * 1024 };
  });
  app.get('/public/upload/:token/sessions/:id', plim(600), async (req) => {
    const { token, id } = sessP.parse(req.params);
    const ctx = await publicCtx(token, req);
    return status(ctx.collection.id, id);
  });
  app.put('/public/upload/:token/sessions/:id', { ...plim(600), bodyLimit: MAX_CHUNK + 1024 }, async (req) => {
    const { token, id } = sessP.parse(req.params);
    const { offset } = offQ.parse(req.query);
    const ctx = await publicCtx(token, req);
    const r = await withPublicEvents(req, ctx.link.id, () => appendChunk(ctx, id, offset, req));
    // Öffentliche Antwort ohne interne Details
    return { id: r.id, received: r.received, size: r.size, complete: r.complete, duplicate: (r as any).duplicate ?? false };
  });

  /* Angemeldet (Medienverwaltung) */
  const collP = z.object({ cid: z.uuid() });
  const collSessP = z.object({ cid: z.uuid(), id: z.uuid() });
  app.post('/collections/:cid/upload-sessions', { preHandler: requireAuth('media.manage'), ...lim(240) }, async (req) => {
    const { cid } = collP.parse(req.params);
    const body = createBody.parse(req.body);
    const ctx = await internalCtx(cid, req);
    const r = await createSession({ ...ctx, folderId: await assertFolder(cid, body.folderId) }, body);
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
