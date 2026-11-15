import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { fileTypeFromFile } from 'file-type';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { EVENT_LABELS, logPublicEvent } from '../lib/public-security.js';
import { securityAlert } from '../lib/security-alerts.js';
import { enqueue } from '../jobs/queue.js';
import { mediaPaths } from '../media/storage.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { mediaPayload } from './media.js';
import { purgeMedia } from './media-trash.js';

/*
 * Verwaltung der Medien („Medien administrieren“, Paket 7): gesperrte Dateien erneut prüfen, „Trotzdem freigeben“
 * (nur Videos mit reinem Dekodierbefund; Typ, Aufbau und Grenzen werden weiter geprüft), endgültig löschen;
 * Sicherheitsereignisse der Upload-Seiten; fehlgeschlagene Medienaufträge wiederholen.
 */

/** Gesperrte Datei zurück in die Prüfung (Datei liegt noch in der Quarantäne). */
async function requeue(id: string, opts: { skipDecode?: boolean; userId?: string | null } = {}) {
  const r = await one<any>(
    `UPDATE media SET status = 'quarantine', reject_reason = NULL, reject_step = NULL, processed_at = NULL,
            skip_decode = $2, released_by = CASE WHEN $2 THEN $3::uuid ELSE released_by END, released_at = CASE WHEN $2 THEN now() ELSE released_at END
      WHERE id = $1 AND status = 'blocked' AND deleted_at IS NULL RETURNING id, original_name, upload_link_id`,
    [id, !!opts.skipDecode, opts.userId ?? null],
  );
  if (!r) return null;
  await enqueue('media.process', { mediaId: id }, { dedupKey: `media.process:${id}` });
  return r;
}

export async function mediaAdminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAuth('media.admin') };

  /*
   * Speicherübersicht (Paket 9): Verbrauch je Sammlung, Ordner und Art, Papierkorb, Quarantäne/gesperrt, Sammeldownloads,
   * freier Platz und Warnschwelle. Grundlage sind die Größen der hochgeladenen Dateien (Originale); Vorschauen und
   * öffentliche Fassungen kommen etwa 5–15 % dazu.
   */
  app.get('/media-admin/storage', admin, async (req) => {
    const { collection } = z.object({ collection: z.uuid().optional() }).parse(req.query);
    const s = await getSettings();
    let disk: { free: number; total: number } | null = null;
    try {
      const st = fs.statfsSync(config.dataDir);
      disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch {
      disk = null;
    }
    if (collection) {
      const folders = await many<any>(
        `SELECT f.id, f.name, f.parent_id, count(m.id)::int AS files, COALESCE(sum(m.size_bytes),0)::bigint AS bytes
           FROM collection_folders f LEFT JOIN media m ON m.folder_id = f.id AND m.deleted_at IS NULL AND m.status <> 'rejected'
          WHERE f.collection_id = $1 AND f.deleted_at IS NULL GROUP BY f.id ORDER BY bytes DESC`,
        [collection],
      );
      const top = await one<any>(`SELECT count(*)::int AS files, COALESCE(sum(size_bytes),0)::bigint AS bytes FROM media WHERE collection_id = $1 AND folder_id IS NULL AND deleted_at IS NULL AND status <> 'rejected'`, [collection]);
      return { folders: folders.map((f) => ({ ...f, bytes: Number(f.bytes) })), top: { files: top.files, bytes: Number(top.bytes) } };
    }
    const sum = async (where: string) => {
      const r = await one<any>(`SELECT count(*)::int AS files, COALESCE(sum(size_bytes),0)::bigint AS bytes FROM media WHERE ${where}`);
      return { files: r.files, bytes: Number(r.bytes) };
    };
    const byKind = await many<any>(
      `SELECT COALESCE(kind, 'unbekannt') AS kind, count(*)::int AS files, COALESCE(sum(size_bytes),0)::bigint AS bytes FROM media WHERE deleted_at IS NULL AND status = 'ready' GROUP BY 1 ORDER BY bytes DESC`,
    );
    const byCollection = await many<any>(
      `SELECT c.id, c.title, c.archived_at IS NOT NULL AS archived, c.max_bytes, count(m.id)::int AS files, COALESCE(sum(m.size_bytes),0)::bigint AS bytes
         FROM collections c LEFT JOIN media m ON m.collection_id = c.id AND m.deleted_at IS NULL AND m.status <> 'rejected'
        WHERE c.deleted_at IS NULL GROUP BY c.id ORDER BY bytes DESC LIMIT 50`,
    );
    const exportsRow = await one<any>(`SELECT count(*)::int AS files, COALESCE(sum(size_bytes),0)::bigint AS bytes FROM exports WHERE status = 'ready'`);
    return {
      disk,
      min_free_gb: s['media.min_free_gb'],
      warn_gb: s['media.storage_warn_gb'],
      ready: await sum(`deleted_at IS NULL AND status = 'ready'`),
      checking: await sum(`deleted_at IS NULL AND status = 'quarantine'`),
      blocked: await sum(`deleted_at IS NULL AND status = 'blocked'`),
      trash: await sum(`deleted_at IS NOT NULL AND status <> 'rejected'`),
      exports: { files: exportsRow.files, bytes: Number(exportsRow.bytes) },
      by_kind: byKind.map((k) => ({ ...k, bytes: Number(k.bytes) })),
      by_collection: byCollection.map((c) => ({ ...c, bytes: Number(c.bytes), max_bytes: Number(c.max_bytes) })),
    };
  });

  /* Gesperrte Dateien über alle Sammlungen */
  app.get('/media-admin/blocked', admin, async () => {
    const rows = await many<any>(
      `SELECT m.*, c.title AS collection_title, l.label AS link_label FROM media m JOIN collections c ON c.id = m.collection_id LEFT JOIN upload_links l ON l.id = m.upload_link_id
        WHERE m.status = 'blocked' AND m.deleted_at IS NULL ORDER BY m.processed_at DESC NULLS LAST LIMIT 500`,
    );
    return rows.map((m) => ({ ...mediaPayload(m), reject_step: m.reject_step, collection_title: m.collection_title, link_label: m.link_label, processed_at: m.processed_at, file_present: fs.existsSync(mediaPaths.quarantine(m.id)) }));
  });

  app.post('/media/:id/recheck', admin, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!fs.existsSync(mediaPaths.quarantine(id))) throw conflict('Die Datei liegt nicht mehr in der Quarantäne und lässt sich nicht erneut prüfen.');
    const r = await requeue(id);
    if (!r) throw notFound('Keine gesperrte Datei.');
    await audit(req.auth!.actor, 'media.rechecked', { type: 'media', id, label: r.original_name });
    return { ok: true };
  });

  app.post('/media-admin/recheck-all', { ...admin, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const ids = (await many<any>(`SELECT id FROM media WHERE status = 'blocked' AND deleted_at IS NULL LIMIT 2000`)).map((r) => r.id).filter((id) => fs.existsSync(mediaPaths.quarantine(id)));
    let n = 0;
    for (const id of ids) if (await requeue(id)) n++;
    await audit(req.auth!.actor, 'media.rechecked', { type: 'media', label: `${n} Datei(en)` }, { alle: true });
    return { ok: true, count: n };
  });

  /* Trotzdem freigeben: nur Videos, deren einziger Befund die Dekodierprüfung ist – Typ, Aufbau und Grenzen bleiben */
  app.post('/media/:id/force-release', admin, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5, 'Bitte kurz begründen (mindestens 5 Zeichen).').max(500) }).parse(req.body ?? {});
    const m = await one<any>(`SELECT * FROM media WHERE id = $1 AND status = 'blocked' AND deleted_at IS NULL`, [id]);
    if (!m) throw notFound('Keine gesperrte Datei.');
    if (m.reject_step !== 'decode') throw badRequest('„Trotzdem freigeben“ gibt es nur für Dateien, die ausschließlich an der Dekodierprüfung gescheitert sind.');
    const file = mediaPaths.quarantine(id);
    if (!fs.existsSync(file)) throw conflict('Die Datei liegt nicht mehr in der Quarantäne.');
    const ft = await fileTypeFromFile(file);
    if (!ft?.mime.startsWith('video/')) throw badRequest('„Trotzdem freigeben“ gibt es nur für Videos.');
    await requeue(id, { skipDecode: true, userId: req.auth!.user?.id ?? null });
    await audit(req.auth!.actor, 'media.force_released', { type: 'media', id, label: m.original_name }, { befund: m.reject_reason, begruendung: reason });
    await logPublicEvent('force_released', { linkId: m.upload_link_id, mediaId: id, detail: reason, throttle: false });
    await securityAlert('media_force_released', {
      title: `Video trotz Prüfbefund freigegeben von ${req.auth!.actor.name}`,
      body: `„${m.original_name}“ war bei der Dekodierprüfung aufgefallen (${m.reject_reason ?? 'ohne Angabe'}). Begründung: ${reason}. Typ, Aufbau und Grenzen werden weiter geprüft.`,
      link: `/medien/${m.collection_id}`,
      throttleKey: id,
    });
    return { ok: true };
  });

  /* Gesperrte oder abgewiesene Datei endgültig löschen */
  app.post('/media/:id/purge', admin, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const m = await one<any>(`SELECT id FROM media WHERE id = $1 AND status IN ('blocked', 'rejected')`, [id]);
    if (!m) throw notFound('Keine gesperrte oder abgewiesene Datei.');
    await purgeMedia([id], req.auth!.actor, 'gesperrt');
    return { ok: true };
  });

  /* Sicherheitsereignisse der öffentlichen Upload-Seiten */
  app.get('/media-admin/security-events', admin, async (req) => {
    const q = z
      .object({ event: z.enum(Object.keys(EVENT_LABELS) as [string, ...string[]]).optional(), link: z.uuid().optional(), page: z.coerce.number().int().min(1).max(10000).default(1) })
      .parse(req.query);
    const where = `($1::text IS NULL OR e.event = $1) AND ($2::uuid IS NULL OR e.link_id = $2)`;
    const total = (await one<any>(`SELECT count(*)::int AS n FROM public_security_events e WHERE ${where}`, [q.event ?? null, q.link ?? null]))!.n;
    const rows = await many<any>(
      `SELECT e.*, l.label AS link_label, c.id AS collection_id, c.title AS collection_title
         FROM public_security_events e LEFT JOIN upload_links l ON l.id = e.link_id LEFT JOIN collections c ON c.id = l.collection_id
        WHERE ${where} ORDER BY e.at DESC, e.id DESC LIMIT 100 OFFSET $3`,
      [q.event ?? null, q.link ?? null, (q.page - 1) * 100],
    );
    return { items: rows.map((r) => ({ ...r, label: EVENT_LABELS[r.event as keyof typeof EVENT_LABELS] ?? r.event })), total, page: q.page, pages: Math.max(1, Math.ceil(total / 100)), labels: EVENT_LABELS };
  });

  /* Fehlgeschlagene Medienaufträge (Prüfung, Bereinigung, öffentliche Fassung, ZIP) */
  app.get('/media-admin/jobs', admin, async () =>
    many<any>(
      `SELECT j.id, j.kind, j.status, j.attempts, j.max_attempts, j.last_error, j.updated_at, j.payload,
              m.original_name, m.collection_id
         FROM jobs j LEFT JOIN media m ON m.id::text = j.payload->>'mediaId'
        WHERE j.kind IN ('media.process', 'media.strip_location', 'media.render_public', 'export.zip') AND (j.status = 'dead' OR (j.status = 'queued' AND j.attempts > 0))
        ORDER BY j.updated_at DESC LIMIT 200`,
    ),
  );

  app.post('/media-admin/jobs/:id/retry', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const j = await one<any>(`SELECT * FROM jobs WHERE id = $1 AND kind IN ('media.process', 'media.strip_location', 'media.render_public', 'export.zip')`, [id]);
    if (!j) throw notFound('Auftrag nicht gefunden.');
    if (j.status !== 'dead' && j.status !== 'queued') throw conflict('Der Auftrag läuft gerade.');
    // Prüfauftrag einer gesperrten Datei: Datei zurück in die Prüfung
    if (j.kind === 'media.process' && j.payload?.mediaId) await pool.query(`UPDATE media SET status = 'quarantine', reject_reason = NULL, reject_step = NULL WHERE id = $1 AND status = 'blocked'`, [j.payload.mediaId]);
    if (j.kind === 'export.zip' && j.payload?.exportId) await pool.query(`UPDATE exports SET status = 'queued', error = NULL WHERE id = $1 AND status = 'failed'`, [j.payload.exportId]);
    await pool.query(`UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`, [id]);
    await pool.query("SELECT pg_notify('blaulichtcms_jobs', $1)", [j.kind]);
    await audit(req.auth!.actor, 'job.retried', { type: 'job', id, label: j.kind });
    return { ok: true };
  });
}
