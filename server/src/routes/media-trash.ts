import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit, type Actor } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { purgeCollection, usedMedia } from '../lib/retention.js';
import { getSettings } from '../lib/settings.js';
import { invalidateExportsFor, removeExportFiles } from '../media/exports.js';
import { descendants } from '../media/folders.js';
import { removeMediaFiles } from '../media/storage.js';
import { mediaPayload } from './media.js';
import { loadFolders } from './media-organize.js';

/*
 * Papierkorb wie LiFeOS (Paket 4). Löschen verschiebt Dateien, Ordner (samt Inhalt) und Sammlungen in den Papierkorb;
 * die Dateien bleiben bis zur Frist `privacy.deleted_media_days` (Standard 30 Tage) erhalten und lassen sich mit
 * „Medien verwalten“ wiederherstellen. Endgültig löschen (einzeln oder „Papierkorb leeren“) darf „Medien administrieren“;
 * nach Ablauf der Frist erledigt das die Löschfrist (lib/retention.ts). Dateien in der aktuellen Fassung eines Beitrags
 * lassen sich wie bisher nicht löschen.
 */

/** Wird eine der Dateien in der aktuellen Fassung eines Beitrags verwendet? → 400 mit Titel. */
export async function assertNotUsed(ids: string[], db: any = pool) {
  if (!ids.length) return;
  const used = await one<any>(
    `SELECT p.title, m.original_name FROM post_revisions r JOIN posts p ON p.id = r.post_id JOIN media m ON m.id = ANY($1::uuid[]) AND (r.media_ids @> ARRAY[m.id] OR r.cover_id = m.id)
      WHERE r.number = p.current_revision LIMIT 1`,
    [ids],
    db,
  );
  if (used) throw badRequest(ids.length === 1 ? `Die Datei wird im Beitrag „${used.title}“ verwendet. Bitte zuerst dort entfernen.` : `„${used.original_name}“ wird im Beitrag „${used.title}“ verwendet. Bitte zuerst dort entfernen oder die Datei aus der Auswahl nehmen.`);
}

/** Dateien in den Papierkorb (einzeln oder Sammelaktion). */
export async function trashMedia(ids: string[], actor: Actor, userId: string | null): Promise<{ deleted: number }> {
  await assertNotUsed(ids);
  const batch = crypto.randomUUID();
  const rows = await many<any>(
    `UPDATE media SET deleted_at = now(), deleted_by = $2, trash_batch = $3 WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL RETURNING id, original_name`,
    [ids, userId, batch],
  );
  if (!rows.length) return { deleted: 0 };
  // Upload-Sitzungen entkoppeln (#176): sonst meldet ein erneuter Upload derselben Datei „vollständig“
  await pool.query('DELETE FROM upload_sessions WHERE media_id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
  for (const m of rows) await audit(actor, 'media.deleted', { type: 'media', id: m.id, label: m.original_name }, { papierkorb: true });
  return { deleted: rows.length };
}

/** Dateien endgültig löschen (Datensatz, Dateien, Sammeldownloads mit diesen Dateien). */
export async function purgeMedia(ids: string[], actor: Actor, reason: string) {
  if (!ids.length) return 0;
  const { rows, exportIds } = await tx(async (db) => {
    const rows = await many<any>(`DELETE FROM media WHERE id = ANY($1::uuid[]) RETURNING id, original_name`, [ids], db);
    await db.query(`DELETE FROM jobs WHERE status = 'queued' AND payload->>'mediaId' = ANY($1::text[])`, [rows.map((r) => r.id)]);
    const exportIds = await invalidateExportsFor(rows.map((r) => r.id), db);
    return { rows, exportIds };
  });
  for (const r of rows) {
    removeMediaFiles(r.id);
    await audit(actor, 'media.purged', { type: 'media', id: r.id, label: r.original_name }, { grund: reason });
  }
  for (const e of exportIds) removeExportFiles(e);
  return rows.length;
}

/** Platz in der Sammlung für wiederhergestellte Dateien? */
async function assertRoom(db: any, collectionId: string, ids: string[]) {
  const c = await one<any>(`SELECT max_files, max_bytes FROM collections WHERE id = $1 FOR UPDATE`, [collectionId], db);
  const add = await one<any>(`SELECT count(*)::int AS n, COALESCE(sum(size_bytes),0) AS bytes FROM media WHERE id = ANY($1::uuid[]) AND status <> 'rejected'`, [ids], db);
  const used = await one<any>(`SELECT count(*)::int AS n, COALESCE(sum(size_bytes),0) AS bytes FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected'`, [collectionId], db);
  if (used.n + add.n > c.max_files || Number(used.bytes) + Number(add.bytes) > Number(c.max_bytes)) throw new AppError(409, 'collection_full', 'In der Sammlung ist nicht mehr genug Platz, um wiederherzustellen.');
}

export async function mediaTrashRoutes(app: FastifyInstance) {
  /* Übersicht: Sammlungen, Ordner (samt Inhalt) und einzeln gelöschte Dateien */
  app.get('/trash', { preHandler: requireAuth('media.trash') }, async () => {
    const days = Math.max(0, Number((await getSettings())['privacy.deleted_media_days']) || 0);
    const purgeAt = (d: string | Date) => (days ? new Date(new Date(d).getTime() + days * 86400_000).toISOString() : null);
    const collections = await many<any>(
      `SELECT c.id, c.title, c.deleted_at, u.name AS deleted_by_name, (SELECT count(*)::int FROM media m WHERE m.collection_id = c.id) AS media_count
         FROM collections c LEFT JOIN users u ON u.id = c.deleted_by WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC LIMIT 500`,
    );
    const folders = await many<any>(
      `SELECT f.id, f.name, f.collection_id, c.title AS collection_title, f.deleted_at, u.name AS deleted_by_name,
              (SELECT count(*)::int FROM media m WHERE m.trash_batch = f.trash_batch) AS media_count
         FROM collection_folders f JOIN collections c ON c.id = f.collection_id LEFT JOIN users u ON u.id = f.deleted_by
        WHERE f.deleted_at IS NOT NULL AND c.deleted_at IS NULL
          AND (f.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM collection_folders p WHERE p.id = f.parent_id AND p.trash_batch = f.trash_batch))
        ORDER BY f.deleted_at DESC LIMIT 500`,
    );
    const media = await many<any>(
      `SELECT m.*, c.title AS collection_title, u.name AS deleted_by_name FROM media m JOIN collections c ON c.id = m.collection_id LEFT JOIN users u ON u.id = m.deleted_by
        WHERE m.deleted_at IS NOT NULL AND c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM collection_folders f WHERE f.trash_batch = m.trash_batch)
        ORDER BY m.deleted_at DESC LIMIT 1000`,
    );
    return {
      days,
      collections: collections.map((c) => ({ ...c, purge_at: purgeAt(c.deleted_at) })),
      folders: folders.map((f) => ({ ...f, purge_at: purgeAt(f.deleted_at) })),
      media: media.map((m) => ({ ...mediaPayload(m), deleted_at: m.deleted_at, deleted_by_name: m.deleted_by_name, collection_title: m.collection_title, purge_at: purgeAt(m.deleted_at) })),
    };
  });

  /* Ordner samt Unterordnern und Dateien in den Papierkorb */
  app.delete('/folders/:id', { preHandler: requireAuth('media.trash') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const f = await one<any>(`SELECT * FROM collection_folders WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!f) throw notFound('Ordner nicht gefunden.');
    const folders = (await loadFolders(f.collection_id)).filter((x) => !x.deleted_at);
    const all = [id, ...descendants(folders, id)];
    const mediaIds = (await many<any>(`SELECT id FROM media WHERE folder_id = ANY($1::uuid[]) AND deleted_at IS NULL`, [all])).map((r) => r.id);
    await assertNotUsed(mediaIds);
    const batch = crypto.randomUUID();
    const userId = req.auth!.user?.id ?? null;
    await tx(async (db) => {
      await db.query(`UPDATE collection_folders SET deleted_at = now(), deleted_by = $2, trash_batch = $3 WHERE id = ANY($1::uuid[])`, [all, userId, batch]);
      await db.query(`UPDATE media SET deleted_at = now(), deleted_by = $2, trash_batch = $3 WHERE id = ANY($1::uuid[])`, [mediaIds, userId, batch]);
      await db.query('DELETE FROM upload_sessions WHERE media_id = ANY($1::uuid[])', [mediaIds]);
      // Links mit diesem Zielordner laden wieder auf die oberste Ebene
      await db.query(`UPDATE upload_links SET folder_id = NULL WHERE folder_id = ANY($1::uuid[])`, [all]);
    });
    await audit(req.auth!.actor, 'folder.deleted', { type: 'folder', id, label: f.name }, { sammlung: f.collection_id, unterordner: all.length - 1, dateien: mediaIds.length, papierkorb: true });
    return { ok: true, folders: all.length, media: mediaIds.length };
  });

  /* Wiederherstellen (Datei, Ordner samt Inhalt, Sammlung) */
  app.post('/trash/restore', { preHandler: requireAuth('media.trash') }, async (req) => {
    const b = z.object({ type: z.enum(['media', 'folder', 'collection']), id: z.uuid() }).parse(req.body ?? {});
    const actor = req.auth!.actor;
    if (b.type === 'collection') {
      const c = await one<any>(`UPDATE collections SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, title`, [b.id]);
      if (!c) throw notFound('Nicht im Papierkorb.');
      await audit(actor, 'collection.restored', { type: 'collection', id: c.id, label: c.title });
      return { ok: true };
    }
    if (b.type === 'folder') {
      const f = await one<any>(`SELECT f.*, c.deleted_at AS c_deleted FROM collection_folders f JOIN collections c ON c.id = f.collection_id WHERE f.id = $1 AND f.deleted_at IS NOT NULL`, [b.id]);
      if (!f) throw notFound('Nicht im Papierkorb.');
      if (f.c_deleted) throw conflict('Bitte zuerst die Sammlung wiederherstellen.');
      const n = await tx(async (db) => {
        const ids = (await many<any>(`SELECT id FROM media WHERE trash_batch = $1`, [f.trash_batch], db)).map((r) => r.id);
        await assertRoom(db, f.collection_id, ids);
        await db.query(`UPDATE collection_folders SET deleted_at = NULL, deleted_by = NULL, trash_batch = NULL WHERE trash_batch = $1`, [f.trash_batch]);
        // Elternordner inzwischen weg (oder selbst im Papierkorb)? Dann auf die oberste Ebene
        await db.query(`UPDATE collection_folders SET parent_id = NULL WHERE id = $1 AND parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collection_folders p WHERE p.id = collection_folders.parent_id AND p.deleted_at IS NULL)`, [f.id]);
        await db.query(`UPDATE media SET deleted_at = NULL, deleted_by = NULL, trash_batch = NULL, client_key = NULL WHERE id = ANY($1::uuid[])`, [ids]);
        return ids.length;
      });
      await audit(actor, 'folder.restored', { type: 'folder', id: f.id, label: f.name }, { dateien: n, papierkorb: true });
      return { ok: true, media: n };
    }
    const m = await one<any>(`SELECT m.*, c.deleted_at AS c_deleted FROM media m JOIN collections c ON c.id = m.collection_id WHERE m.id = $1 AND m.deleted_at IS NOT NULL`, [b.id]);
    if (!m) throw notFound('Nicht im Papierkorb.');
    if (m.c_deleted) throw conflict('Bitte zuerst die Sammlung wiederherstellen.');
    await tx(async (db) => {
      await assertRoom(db, m.collection_id, [m.id]);
      // Ordner inzwischen im Papierkorb/gelöscht → oberste Ebene; Client-Schlüssel leeren (Eindeutigkeit je Sammlung)
      await db.query(
        `UPDATE media SET deleted_at = NULL, deleted_by = NULL, trash_batch = NULL, client_key = NULL,
                folder_id = CASE WHEN EXISTS (SELECT 1 FROM collection_folders f WHERE f.id = media.folder_id AND f.deleted_at IS NULL) THEN folder_id END
          WHERE id = $1`,
        [m.id],
      );
    });
    await audit(actor, 'media.restored', { type: 'media', id: m.id, label: m.original_name });
    return { ok: true };
  });

  /* Endgültig löschen – nur „Medien administrieren“ */
  app.post('/trash/purge', { preHandler: requireAuth('media.admin') }, async (req) => {
    const b = z.object({ type: z.enum(['media', 'folder', 'collection']), id: z.uuid() }).parse(req.body ?? {});
    const actor = req.auth!.actor;
    if (b.type === 'collection') {
      const c = await one<any>(`SELECT id FROM collections WHERE id = $1 AND deleted_at IS NOT NULL`, [b.id]);
      if (!c) throw notFound('Nicht im Papierkorb.');
      const r = await purgeCollection(b.id, actor, 'manual');
      return { ok: true, media: r.media };
    }
    if (b.type === 'folder') {
      const f = await one<any>(`SELECT * FROM collection_folders WHERE id = $1 AND deleted_at IS NOT NULL`, [b.id]);
      if (!f) throw notFound('Nicht im Papierkorb.');
      const ids = (await many<any>(`SELECT id FROM media WHERE trash_batch = $1`, [f.trash_batch])).map((r) => r.id);
      const n = await purgeMedia(ids, actor, 'Papierkorb');
      await pool.query(`DELETE FROM collection_folders WHERE trash_batch = $1`, [f.trash_batch]);
      await audit(actor, 'folder.purged', { type: 'folder', id: f.id, label: f.name }, { dateien: n });
      return { ok: true, media: n };
    }
    const m = await one<any>(`SELECT id FROM media WHERE id = $1 AND deleted_at IS NOT NULL`, [b.id]);
    if (!m) throw notFound('Nicht im Papierkorb.');
    await purgeMedia([b.id], actor, 'Papierkorb');
    return { ok: true, media: 1 };
  });

  /* Papierkorb leeren – nur „Medien administrieren“ */
  app.post('/trash/empty', { preHandler: requireAuth('media.admin'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const actor = req.auth!.actor;
    const ids = (await many<any>(`SELECT m.id FROM media m JOIN collections c ON c.id = m.collection_id WHERE m.deleted_at IS NOT NULL AND c.deleted_at IS NULL LIMIT 10000`)).map((r) => r.id);
    const media = await purgeMedia(ids, actor, 'Papierkorb geleert');
    const folders = (await pool.query(`DELETE FROM collection_folders f WHERE f.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media m WHERE m.folder_id = f.id)`)).rowCount ?? 0;
    let collections = 0;
    for (const c of await many<any>(`SELECT id FROM collections WHERE deleted_at IS NOT NULL LIMIT 100`)) {
      try {
        await purgeCollection(c.id, actor, 'manual');
        collections++;
      } catch {
        /* Datei in einem laufenden Beitrag: bleibt stehen */
      }
    }
    await audit(actor, 'trash.emptied', { type: 'trash', label: 'Papierkorb' }, { dateien: media, ordner: folders, sammlungen: collections });
    return { ok: true, media, folders, collections };
  });
}

/** Sammlung in den Papierkorb (statt sofort zu löschen). Verwendete Dateien blockieren wie bisher. */
export async function trashCollection(id: string, actor: Actor, userId: string | null) {
  const c = await one<any>(`SELECT id, title, deleted_at FROM collections WHERE id = $1`, [id]);
  if (!c) throw notFound('Sammlung nicht gefunden.');
  if (c.deleted_at) return { ok: true, media: 0 };
  const used = await usedMedia([id]);
  if (used.size) {
    const titles = [...new Set([...used.values()].flat())];
    throw conflict(
      `${used.size} Datei(en) werden in ${titles.length === 1 ? 'dem Beitrag' : 'den Beiträgen'} ${titles.map((t) => `„${t}“`).join(', ')} verwendet. ` +
        'Bitte die Dateien dort aus der Fassung nehmen oder den Beitrag archivieren (bei veröffentlichten Beiträgen vorher zurückziehen) und dann erneut löschen.',
      { beitraege: titles },
    );
  }
  await pool.query(`UPDATE collections SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, userId]);
  const n = (await one<any>(`SELECT count(*)::int AS n FROM media WHERE collection_id = $1 AND deleted_at IS NULL`, [id]))!.n;
  await audit(actor, 'collection.trashed', { type: 'collection', id, label: c.title }, { dateien: n });
  return { ok: true, media: n };
}
