import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { cleanFolderName, depthAfterMove, FOLDER_MAX_DEPTH, wouldCycle, type FolderNode } from '../media/folders.js';
import { freeBytes, mediaPaths } from '../media/storage.js';
import { effectiveTypes, TYPE_DEFS } from '../media/types.js';
import { mediaPayload } from './media.js';

/*
 * Ordnen wie LiFeOS (Paket 3): Ordner innerhalb einer Sammlung, Verschieben/Kopieren zwischen Sammlungen und Ordnern,
 * Schlagworte und die Mediensuche über alle Sammlungen. Medien behalten beim Verschieben ihre ID – Beitragsfassungen
 * und Freigaben bleiben stabil.
 */

/** Schlagwort normalisieren: Kleinschreibung, einfache Leerzeichen, 1–40 Zeichen. */
export function cleanTag(raw: string): string | null {
  const t = String(raw ?? '').replace(/[\u0000-\u001f,;]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
  return t || null;
}

export async function loadFolders(collectionId: string, db: any = pool): Promise<(FolderNode & { deleted_at: string | null; archived_at: string | null })[]> {
  return many<any>(`SELECT id, parent_id, name, deleted_at, archived_at FROM collection_folders WHERE collection_id = $1`, [collectionId], db);
}

/** Zielordner prüfen: gehört zur Sammlung und liegt nicht im Papierkorb. */
export async function assertFolder(collectionId: string, folderId: string | null | undefined, db: any = pool) {
  if (!folderId) return null;
  const f = await one<any>(`SELECT id FROM collection_folders WHERE id = $1 AND collection_id = $2 AND deleted_at IS NULL`, [folderId, collectionId], db);
  if (!f) throw badRequest('Der Zielordner gehört nicht zu dieser Sammlung oder wurde gelöscht.');
  return f.id as string;
}

/** Schlagworte (Namen) anlegen bzw. finden; liefert die IDs. */
async function tagIds(names: string[], db: any): Promise<string[]> {
  const clean = [...new Set(names.map(cleanTag).filter((t): t is string => !!t))].slice(0, 30);
  const ids: string[] = [];
  for (const n of clean) {
    const r = await one<any>(`INSERT INTO media_tags (name) VALUES ($1) ON CONFLICT ((lower(name))) DO UPDATE SET name = media_tags.name RETURNING id`, [n], db);
    ids.push(r.id);
  }
  return ids;
}

/** Schlagworte ohne Verwendung entfernen. */
async function pruneTags(db: any = pool) {
  await db.query(`DELETE FROM media_tags t WHERE NOT EXISTS (SELECT 1 FROM media_tag_links l WHERE l.tag_id = t.id)`);
}

/** Datei kopieren (Copy-on-Write, wo das Dateisystem es kann) – nie als Hardlink, weil öffentliche Fassungen neu geschrieben werden. */
function copyIfExists(from: string, to: string) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to.replace(/[\\/][^\\/]+$/, ''), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
}

const idsBody = z.array(z.uuid()).min(1).max(1000);

export async function mediaOrganizeRoutes(app: FastifyInstance) {
  /* ------------------------------------------ Ordner ------------------------------------------ */

  app.get('/collections/:id/folders', { preHandler: requireAuth('media.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return many<any>(
      `SELECT f.id, f.parent_id, f.name, f.sort_order, f.archived_at, f.created_at,
              (SELECT count(*)::int FROM media m WHERE m.folder_id = f.id AND m.deleted_at IS NULL) AS media_count
         FROM collection_folders f WHERE f.collection_id = $1 AND f.deleted_at IS NULL ORDER BY f.sort_order, lower(f.name)`,
      [id],
    );
  });

  app.post('/collections/:id/folders', { preHandler: requireAuth('media.organize') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ name: z.string().max(200), parentId: z.uuid().nullable().optional() }).parse(req.body ?? {});
    let name: string;
    try {
      name = cleanFolderName(body.name);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const c = await one<any>(`SELECT id, title, archived_at FROM collections WHERE id = $1`, [id]);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    const parent = await assertFolder(id, body.parentId);
    if (parent) {
      const folders = await loadFolders(id);
      if (depthAfterMove([...folders, { id: 'neu', parent_id: parent, name }], 'neu', parent) > FOLDER_MAX_DEPTH) throw badRequest(`Höchstens ${FOLDER_MAX_DEPTH} Ordnerebenen.`);
    }
    const f = await one<any>(
      `INSERT INTO collection_folders (collection_id, parent_id, name, sort_order, created_by)
       VALUES ($1,$2,$3, (SELECT COALESCE(max(sort_order),0)+1 FROM collection_folders WHERE collection_id = $1), $4) RETURNING *`,
      [id, parent, name, req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'folder.created', { type: 'folder', id: f.id, label: name }, { sammlung: id, ueber: parent });
    return f;
  });

  app.patch('/folders/:id', { preHandler: requireAuth('media.organize') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ name: z.string().max(200).optional(), parentId: z.uuid().nullable().optional(), archived: z.boolean().optional() }).parse(req.body ?? {});
    const cur = await one<any>(`SELECT * FROM collection_folders WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!cur) throw notFound('Ordner nicht gefunden.');
    let name: string | null = null;
    if (body.name !== undefined) {
      try {
        name = cleanFolderName(body.name);
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    }
    if (body.parentId !== undefined) {
      await assertFolder(cur.collection_id, body.parentId);
      const folders = (await loadFolders(cur.collection_id)).filter((f) => !f.deleted_at);
      if (wouldCycle(folders, id, body.parentId)) throw badRequest('Ein Ordner lässt sich nicht in sich selbst oder einen seiner Unterordner verschieben.');
      if (depthAfterMove(folders, id, body.parentId) > FOLDER_MAX_DEPTH) throw badRequest(`Höchstens ${FOLDER_MAX_DEPTH} Ordnerebenen.`);
    }
    const f = await one<any>(
      `UPDATE collection_folders SET name = COALESCE($2, name), parent_id = CASE WHEN $3 THEN $4::uuid ELSE parent_id END,
              archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [id, name, body.parentId !== undefined, body.parentId ?? null, body.archived ?? null],
    );
    const action = body.parentId !== undefined ? 'folder.moved' : body.archived !== undefined ? (body.archived ? 'folder.archived' : 'folder.restored') : 'folder.renamed';
    await audit(req.auth!.actor, action, { type: 'folder', id, label: f.name }, { sammlung: f.collection_id, ...(name && name !== cur.name ? { vorher: cur.name } : {}) });
    return f;
  });

  /* ---------------------------------------- Schlagworte ---------------------------------------- */

  app.get('/media-tags', { preHandler: requireAuth('media.view') }, async () =>
    many<any>(
      `SELECT t.id, t.name, count(m.id)::int AS count FROM media_tags t JOIN media_tag_links l ON l.tag_id = t.id JOIN media m ON m.id = l.media_id AND m.deleted_at IS NULL
        GROUP BY t.id ORDER BY lower(t.name)`,
    ),
  );

  /* Schlagworte einer Datei setzen */
  app.put('/media/:id/tags', { preHandler: requireAuth('media.organize') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { tags } = z.object({ tags: z.array(z.string().max(100)).max(30) }).parse(req.body ?? {});
    const m = await one<any>(`SELECT id, original_name FROM media WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!m) throw notFound('Datei nicht gefunden.');
    const names = await tx(async (db) => {
      const ids = await tagIds(tags, db);
      await db.query(`DELETE FROM media_tag_links WHERE media_id = $1 AND NOT (tag_id = ANY($2::uuid[]))`, [id, ids]);
      for (const t of ids) await db.query(`INSERT INTO media_tag_links (media_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, t]);
      await pruneTags(db);
      return (await many<any>(`SELECT t.name FROM media_tag_links l JOIN media_tags t ON t.id = l.tag_id WHERE l.media_id = $1 ORDER BY lower(t.name)`, [id], db)).map((r) => r.name);
    });
    await audit(req.auth!.actor, 'media.tagged', { type: 'media', id, label: m.original_name }, { schlagworte: names });
    return { tags: names };
  });

  /* Sammel-Tagging: Schlagworte hinzufügen und/oder entfernen */
  app.post('/media/tags', { preHandler: requireAuth('media.organize') }, async (req) => {
    const body = z.object({ ids: idsBody, add: z.array(z.string().max(100)).max(30).default([]), remove: z.array(z.string().max(100)).max(30).default([]) }).parse(req.body ?? {});
    const r = await tx(async (db) => {
      const live = (await many<any>(`SELECT id FROM media WHERE id = ANY($1) AND deleted_at IS NULL`, [body.ids], db)).map((x) => x.id);
      const add = await tagIds(body.add, db);
      for (const t of add) await db.query(`INSERT INTO media_tag_links (media_id, tag_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`, [live, t]);
      const rem = body.remove.map(cleanTag).filter(Boolean);
      if (rem.length) await db.query(`DELETE FROM media_tag_links l USING media_tags t WHERE t.id = l.tag_id AND l.media_id = ANY($1) AND lower(t.name) = ANY($2::text[])`, [live, rem]);
      await pruneTags(db);
      return live.length;
    });
    await audit(req.auth!.actor, 'media.tagged', { type: 'media', label: `${r} Datei(en)` }, { hinzu: body.add, entfernt: body.remove, sammelaktion: true, ids: body.ids.slice(0, 50) });
    return { updated: r };
  });

  /* ------------------------------------ Verschieben/Kopieren ------------------------------------ */

  const targetBody = z.object({ ids: idsBody, collectionId: z.uuid(), folderId: z.uuid().nullable().optional() });

  /** Zielsammlung sperren und Kontingent für zusätzliche Dateien/Bytes prüfen. */
  async function lockTarget(db: any, collectionId: string, addCount: number, addBytes: number) {
    const c = await one<any>(`SELECT id, title, archived_at, max_files, max_bytes FROM collections WHERE id = $1 FOR UPDATE`, [collectionId], db);
    if (!c) throw notFound('Zielsammlung nicht gefunden.');
    if (c.archived_at) throw badRequest('Die Zielsammlung ist archiviert.');
    if (addCount > 0) {
      const used = await one<any>(
        `SELECT count(*)::int AS n, COALESCE(sum(size_bytes),0) AS bytes FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected'`,
        [collectionId],
        db,
      );
      if (used.n + addCount > c.max_files) throw new AppError(409, 'collection_full', `Die Zielsammlung hat nicht genug Platz (höchstens ${c.max_files} Dateien).`);
      if (Number(used.bytes) + addBytes > Number(c.max_bytes)) throw new AppError(409, 'collection_full', 'Der Speicherplatz der Zielsammlung reicht nicht.');
    }
    return c;
  }

  app.post('/media/move', { preHandler: requireAuth('media.organize') }, async (req) => {
    const body = targetBody.parse(req.body ?? {});
    const res = await tx(async (db) => {
      const media = await many<any>(`SELECT id, collection_id, size_bytes, status, original_name FROM media WHERE id = ANY($1) AND deleted_at IS NULL`, [body.ids], db);
      if (!media.length) throw notFound('Keine Dateien gefunden.');
      const incoming = media.filter((m) => m.collection_id !== body.collectionId && m.status !== 'rejected');
      const c = await lockTarget(db, body.collectionId, incoming.length, incoming.reduce((n, m) => n + Number(m.size_bytes), 0));
      const folder = await assertFolder(body.collectionId, body.folderId, db);
      // Client-Schlüssel nur innerhalb einer Sammlung eindeutig: beim Wechsel der Sammlung leeren
      await db.query(
        `UPDATE media m SET folder_id = $3, client_key = CASE WHEN m.collection_id = $2 THEN m.client_key END, collection_id = $2,
                sort_order = (SELECT COALESCE(max(sort_order),0) FROM media WHERE collection_id = $2) + x.ord
           FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS ord FROM media WHERE id = ANY($1)) x
          WHERE m.id = x.id AND m.deleted_at IS NULL`,
        [media.map((m) => m.id), body.collectionId, folder],
      );
      return { moved: media, title: c.title, folder };
    });
    for (const m of res.moved) await audit(req.auth!.actor, 'media.moved', { type: 'media', id: m.id, label: m.original_name }, { von: m.collection_id, nach: body.collectionId, ordner: res.folder });
    return { moved: res.moved.length };
  });

  app.post('/media/copy', { preHandler: requireAuth('media.organize') }, async (req) => {
    const body = targetBody.parse(req.body ?? {});
    const s = await getSettings();
    const free = freeBytes();
    const media = await many<any>(`SELECT * FROM media WHERE id = ANY($1) AND deleted_at IS NULL AND status = 'ready'`, [body.ids]);
    if (!media.length) throw badRequest('Kopieren lassen sich nur geprüfte Dateien.');
    const bytes = media.reduce((n, m) => n + Number(m.size_bytes), 0);
    if (free !== null && free - bytes * 2 < s['media.min_free_gb'] * 1024 ** 3) throw new AppError(507, 'storage_full', 'Für die Kopien ist nicht genug Speicher frei.');
    const created: { id: string; from: string; name: string }[] = [];
    await tx(async (db) => {
      await lockTarget(db, body.collectionId, media.length, bytes);
      const folder = await assertFolder(body.collectionId, body.folderId, db);
      for (const m of media) {
        const nid = crypto.randomUUID();
        // Datenschutz-Entscheidungen (Markierungen, Bereiche, Zuschnitt, ohne Ton, Gesichtsvorschläge) gelten für den Inhalt und kommen mit;
        // die Sichtung beginnt neu. Vorgangsnummer und Hinweis bleiben, damit Betroffenenanfragen auch Kopien finden.
        await db.query(
          `INSERT INTO media (id, collection_id, folder_id, upload_link_id, uploaded_by, uploader_note, original_name, declared_type, mime, kind, size_bytes, sha256,
                              width, height, taken_at, had_location, status, has_preview, has_public, processed_at, sort_order, upload_ref,
                              sensitive_flags, redactions, crop, strip_audio, public_rev, location_stripped_at, location_strip_error,
                              face_proposals, face_status, face_checked_at, face_model, face_error,
                              display_name, description, internal_note, duplicate_of)
           SELECT $2, $3, $4, upload_link_id, uploaded_by, uploader_note, original_name, declared_type, mime, kind, size_bytes, sha256,
                  width, height, taken_at, had_location, 'ready', has_preview, has_public, now(),
                  (SELECT COALESCE(max(sort_order),0)+1 FROM media WHERE collection_id = $3), upload_ref,
                  sensitive_flags, redactions, crop, strip_audio, public_rev, location_stripped_at, location_strip_error,
                  face_proposals, CASE WHEN face_status = 'queued' THEN NULL ELSE face_status END, face_checked_at, face_model, face_error,
                  display_name, description, internal_note, $1
             FROM media WHERE id = $1`,
          [m.id, nid, body.collectionId, folder],
        );
        await db.query(`INSERT INTO media_tag_links (media_id, tag_id) SELECT $2, tag_id FROM media_tag_links WHERE media_id = $1 ON CONFLICT DO NOTHING`, [m.id, nid]);
        created.push({ id: nid, from: m.id, name: m.original_name });
      }
      // Dateien noch in der Transaktion kopieren: schlägt das fehl, entsteht keine Medienzeile ohne Datei
      for (const x of created) {
        copyIfExists(mediaPaths.original(x.from), mediaPaths.original(x.id));
        copyIfExists(mediaPaths.preview(x.from), mediaPaths.preview(x.id));
        for (const ext of ['jpg', 'mp4', 'webm']) copyIfExists(mediaPaths.publicFile(x.from, ext), mediaPaths.publicFile(x.id, ext));
      }
    }).catch((e) => {
      for (const x of created) for (const p of [mediaPaths.original(x.id), mediaPaths.preview(x.id), ...['jpg', 'mp4', 'webm'].map((e2) => mediaPaths.publicFile(x.id, e2))]) fs.rmSync(p, { force: true });
      throw e;
    });
    for (const x of created) await audit(req.auth!.actor, 'media.copied', { type: 'media', id: x.id, label: x.name }, { von: x.from, sammlung: body.collectionId });
    return { copied: created.length, ids: created.map((x) => x.id) };
  });

  /* Dateitypen für die Link-Optionen: alle bekannten, mit „global erlaubt“ */
  app.get('/media/types', { preHandler: requireAuth('media.view') }, async () => {
    const allowed = effectiveTypes((await getSettings())['media.allowed_types'], null);
    return TYPE_DEFS.map((t) => ({ key: t.key, label: t.label, kind: t.kind, allowed: allowed.includes(t.key) }));
  });

  /* --------------------------------- Mediensuche über alle Sammlungen --------------------------------- */

  app.get('/media/search', { preHandler: requireAuth('media.view') }, async (req) => {
    const q = z
      .object({
        q: z.string().trim().max(100).optional(),
        kind: z.enum(['image', 'video']).optional(),
        selection: z.enum(['pending', 'selected', 'skipped', 'on_hold']).optional(),
        status: z.enum(['ready', 'problems']).default('ready'),
        tag: z.string().max(100).optional(),
        collection: z.uuid().optional(),
        via: z.enum(['link', 'intern']).optional(),
        flagged: z.enum(['1', 'true']).optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        perPage: z.coerce.number().int().refine((n) => [48, 96, 192].includes(n)).default(48),
      })
      .parse(req.query);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const tag = q.tag ? cleanTag(q.tag) : null;
    const where = `m.deleted_at IS NULL AND c.deleted_at IS NULL
        AND (CASE WHEN $1 = 'ready' THEN m.status = 'ready' ELSE m.status <> 'ready' END)
        AND ($2::text IS NULL OR m.original_name ILIKE $2 OR m.display_name ILIKE $2 OR m.description ILIKE $2 OR m.uploader_note ILIKE $2 OR c.title ILIKE $2 OR m.upload_ref = upper($9))
        AND ($3::text IS NULL OR m.kind = $3)
        AND ($4::text IS NULL OR m.selection = $4)
        AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM media_tag_links l JOIN media_tags t ON t.id = l.tag_id WHERE l.media_id = m.id AND lower(t.name) = $5))
        AND ($6::uuid IS NULL OR m.collection_id = $6)
        AND ($7::date IS NULL OR m.created_at >= $7::date)
        AND ($8::date IS NULL OR m.created_at < $8::date + 1)
        AND ($10::text IS NULL OR ($10 = 'link') = (m.uploaded_by IS NULL))
        AND (NOT $11::boolean OR cardinality(m.sensitive_flags) > 0)`;
    const params = [q.status, like, q.kind ?? null, q.selection ?? null, tag, q.collection ?? null, q.from ?? null, q.to ?? null, q.q ?? '', q.via ?? null, !!q.flagged];
    const total = (await one<any>(`SELECT count(*)::int AS n FROM media m JOIN collections c ON c.id = m.collection_id WHERE ${where}`, params))!.n;
    const rows = await many<any>(
      `SELECT m.*, c.title AS collection_title, u.name AS uploaded_by_name,
              (SELECT array_agg(t.name ORDER BY lower(t.name)) FROM media_tag_links l JOIN media_tags t ON t.id = l.tag_id WHERE l.media_id = m.id) AS tags
         FROM media m JOIN collections c ON c.id = m.collection_id LEFT JOIN users u ON u.id = m.uploaded_by
        WHERE ${where} ORDER BY m.created_at DESC, m.id LIMIT $12 OFFSET $13`,
      [...params, q.perPage, (q.page - 1) * q.perPage],
    );
    return { items: rows.map((m) => ({ ...mediaPayload(m), collection_title: m.collection_title })), total, page: q.page, pages: Math.max(1, Math.ceil(total / q.perPage)) };
  });
}
