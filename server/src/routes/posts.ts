import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { createCollection, createUploadLink, uploadLinkUrl } from './media.js';

export const POST_KINDS = ['news', 'incident', 'event', 'situation'] as const;

/** Prüfsumme einer Fassung: Text, Medien (in Reihenfolge), Titelbild und Zielkanal. */
export function revisionHash(r: { title: string; body: string; excerpt: string; media_ids: string[]; cover_id: string | null; site_id: string | null }): string {
  const canonical = JSON.stringify([r.title, r.body, r.excerpt, r.media_ids, r.cover_id ?? null, r.site_id ?? null]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export type PostState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'publishing' | 'published' | 'failed' | 'unknown';

/** Status eines Beitrags – immer bezogen auf die aktuelle Fassung. */
export async function postState(postId: string, db: Queryable = pool) {
  const cur = await one<any>(
    `SELECT r.* FROM post_revisions r JOIN posts p ON p.id = r.post_id AND r.number = p.current_revision WHERE p.id = $1`,
    [postId],
    db,
  );
  if (!cur) return null;
  const approval = await one<any>(
    `SELECT a.*, u.name AS decided_by_name FROM approvals a LEFT JOIN users u ON u.id = a.decided_by
      WHERE a.revision_id = $1 AND a.revoked_at IS NULL ORDER BY a.decided_at DESC LIMIT 1`,
    [cur.id],
    db,
  );
  const validApproval = approval && approval.decision === 'approved' && approval.content_hash === cur.content_hash ? approval : null;
  const pub = await one<any>(`SELECT * FROM publications WHERE revision_id = $1 ORDER BY created_at DESC LIMIT 1`, [cur.id], db);
  let state: PostState = 'draft';
  if (cur.submitted_at) state = 'in_review';
  if (approval?.decision === 'rejected' && (!cur.submitted_at || new Date(approval.decided_at) >= new Date(cur.submitted_at))) state = 'rejected';
  if (validApproval) state = 'approved';
  if (validApproval && pub) {
    state = pub.status === 'published' ? 'published' : pub.status === 'failed' ? 'failed' : pub.status === 'unknown' ? 'unknown' : pub.status === 'canceled' ? 'approved' : 'publishing';
  }
  return { current: cur, approval, validApproval, publication: pub, state };
}

/**
 * Status aller Beiträge in EINER Abfrage (statt mehrerer Abfragen je Beitrag).
 * Logik identisch zu postState(): bezogen auf die aktuelle Fassung.
 */
export const POST_STATE_SQL = `
  SELECT p.id, p.kind, p.current_revision, p.updated_at, p.archived_at,
         r.id AS revision_id, r.title AS rev_title, r.site_id, r.submitted_at, r.created_by AS rev_created_by,
         u.name AS updated_by_name, s.name AS site_name,
         (SELECT count(*)::int FROM collections c WHERE c.post_id = p.id) AS collection_count,
         a.decision AS a_decision, a.decided_at AS a_decided_at, (a.content_hash = r.content_hash) AS a_valid,
         pb.status AS pb_status, pb.remote_url AS pb_url,
         CASE
           WHEN a.decision = 'approved' AND a.content_hash = r.content_hash AND pb.status = 'published' THEN 'published'
           WHEN a.decision = 'approved' AND a.content_hash = r.content_hash AND pb.status = 'failed' THEN 'failed'
           WHEN a.decision = 'approved' AND a.content_hash = r.content_hash AND pb.status = 'unknown' THEN 'unknown'
           WHEN a.decision = 'approved' AND a.content_hash = r.content_hash AND pb.status IN ('queued','sent') THEN 'publishing'
           WHEN a.decision = 'approved' AND a.content_hash = r.content_hash THEN 'approved'
           WHEN a.decision = 'rejected' AND (r.submitted_at IS NULL OR a.decided_at >= r.submitted_at) THEN 'rejected'
           WHEN r.submitted_at IS NOT NULL THEN 'in_review'
           ELSE 'draft'
         END AS state
    FROM posts p
    JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
    LEFT JOIN users u ON u.id = p.updated_by
    LEFT JOIN wp_sites s ON s.id = r.site_id
    LEFT JOIN LATERAL (SELECT decision, decided_at, content_hash FROM approvals WHERE revision_id = r.id AND revoked_at IS NULL ORDER BY decided_at DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT status, remote_url FROM publications WHERE revision_id = r.id ORDER BY created_at DESC LIMIT 1) pb ON true`;

async function loadMedia(ids: string[]) {
  if (!ids.length) return [];
  const rows = await many<any>(`SELECT id, original_name, kind, mime, width, height, has_preview, has_public, status, deleted_at FROM media WHERE id = ANY($1)`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

const revisionInput = z.object({
  baseRevision: z.number().int().min(1),
  title: z.string().trim().min(2).max(200),
  body: z.string().max(50_000).default(''),
  excerpt: z.string().max(1_000).default(''),
  mediaIds: z.array(z.uuid()).max(100).default([]),
  coverId: z.uuid().nullable().default(null),
  siteId: z.uuid().nullable().default(null),
  changeNote: z.string().trim().max(300).default(''),
});

export async function postRoutes(app: FastifyInstance) {
  app.get('/posts', { preHandler: requireAuth('post.read') }, async (req) => {
    const q = z.object({ state: z.string().max(20).optional(), archived: z.coerce.boolean().default(false) }).parse(req.query);
    const rows = await many<any>(`${POST_STATE_SQL} WHERE ($1::boolean OR p.archived_at IS NULL) ORDER BY p.updated_at DESC LIMIT 300`, [q.archived]);
    const out = rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      title: p.rev_title,
      current_revision: p.current_revision,
      updated_at: p.updated_at,
      updated_by_name: p.updated_by_name,
      site_name: p.site_name,
      collection_count: p.collection_count,
      state: p.state as PostState,
      published_url: p.state === 'published' ? p.pb_url : null,
      archived: !!p.archived_at,
    }));
    return q.state ? out.filter((p) => p.state === q.state) : out;
  });

  app.post('/posts', { preHandler: requireAuth('post.edit') }, async (req) => {
    const body = z.object({ title: z.string().trim().min(2).max(200), kind: z.enum(POST_KINDS).default('news') }).parse(req.body);
    const userId = req.auth!.user?.id ?? null;
    const post = await tx(async (db) => {
      const p = await one<any>(`INSERT INTO posts (kind, title, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING *`, [body.kind, body.title, userId], db);
      const rev = { title: body.title, body: '', excerpt: '', media_ids: [] as string[], cover_id: null, site_id: null };
      await db.query(
        `INSERT INTO post_revisions (post_id, number, title, body, excerpt, media_ids, cover_id, site_id, content_hash, created_by) VALUES ($1,1,$2,'','','{}',NULL,NULL,$3,$4)`,
        [p.id, body.title, revisionHash(rev), userId],
      );
      await audit(req.auth!.actor, 'post.created', { type: 'post', id: p.id, label: body.title }, { art: body.kind }, 'ok', db);
      return p;
    });
    return post;
  });

  app.get('/posts/:id', { preHandler: requireAuth('post.read') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const post = await one<any>(`SELECT p.*, u.name AS created_by_name FROM posts p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [id]);
    if (!post) throw notFound('Beitrag nicht gefunden.');
    const st = (await postState(id))!;
    const revisions = await many<any>(
      `SELECT r.id, r.number, r.title, r.change_note, r.created_at, r.submitted_at, u.name AS created_by_name,
              (SELECT a.decision FROM approvals a WHERE a.revision_id = r.id AND a.revoked_at IS NULL ORDER BY a.decided_at DESC LIMIT 1) AS decision
         FROM post_revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.post_id = $1 ORDER BY r.number DESC`,
      [id],
    );
    const publications = await many<any>(
      `SELECT pb.*, s.name AS site_name, r.number AS revision_number, u.name AS created_by_name
         FROM publications pb JOIN wp_sites s ON s.id = pb.site_id JOIN post_revisions r ON r.id = pb.revision_id LEFT JOIN users u ON u.id = pb.created_by
        WHERE pb.post_id = $1 ORDER BY pb.created_at DESC`,
      [id],
    );
    const approvals = await many<any>(
      `SELECT a.id, a.decision, a.note, a.decided_at, a.revoked_at, r.number AS revision_number, u.name AS decided_by_name
         FROM approvals a JOIN post_revisions r ON r.id = a.revision_id LEFT JOIN users u ON u.id = a.decided_by WHERE a.post_id = $1 ORDER BY a.decided_at DESC`,
      [id],
    );
    const collections = await many<any>(
      `SELECT c.id, c.title, (SELECT count(*)::int FROM media m WHERE m.collection_id = c.id AND m.status = 'ready' AND m.deleted_at IS NULL) AS media_count,
              (SELECT count(*)::int FROM media m WHERE m.collection_id = c.id AND m.status = 'ready' AND m.deleted_at IS NULL AND m.selection = 'selected') AS selected_count
         FROM collections c WHERE c.post_id = $1 ORDER BY c.created_at`,
      [id],
    );
    const cur = st.current;
    return {
      post: { id: post.id, kind: post.kind, created_at: post.created_at, created_by_name: post.created_by_name, archived: !!post.archived_at, current_revision: post.current_revision },
      state: st.state,
      revision: {
        id: cur.id,
        number: cur.number,
        title: cur.title,
        body: cur.body,
        excerpt: cur.excerpt,
        media_ids: cur.media_ids,
        cover_id: cur.cover_id,
        site_id: cur.site_id,
        content_hash: cur.content_hash,
        submitted_at: cur.submitted_at,
        created_at: cur.created_at,
        created_by: cur.created_by,
      },
      media: await loadMedia(cur.media_ids),
      approval: st.validApproval ? { decided_by_name: st.validApproval.decided_by_name, decided_at: st.validApproval.decided_at, note: st.validApproval.note } : null,
      lastDecision: st.approval ? { decision: st.approval.decision, note: st.approval.note, decided_by_name: st.approval.decided_by_name, decided_at: st.approval.decided_at } : null,
      revisions,
      approvals,
      publications: publications.map((p) => ({
        id: p.id,
        site_name: p.site_name,
        revision_number: p.revision_number,
        status: p.status,
        remote_url: p.remote_url,
        remote_id: p.remote_id,
        error: p.error,
        created_at: p.created_at,
        fetched_at: p.fetched_at,
        result_at: p.result_at,
        created_by_name: p.created_by_name,
      })),
      collections,
    };
  });

  /** Speichern: erzeugt nur dann eine neue Fassung, wenn sich Inhalt, Medien oder Zielkanal ändern. */
  app.put('/posts/:id/revision', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = revisionInput.parse(req.body);
    const userId = req.auth!.user?.id ?? null;
    const media = await loadMedia(body.mediaIds);
    if (media.length !== new Set(body.mediaIds).size || media.some((m: any) => m.status !== 'ready' || m.deleted_at)) throw badRequest('Mindestens eine ausgewählte Datei ist nicht (mehr) verfügbar.');
    if (body.coverId && !body.mediaIds.includes(body.coverId)) throw badRequest('Das Titelbild muss zu den Medien des Beitrags gehören.');
    if (body.siteId) {
      const site = await one<any>(`SELECT status FROM wp_sites WHERE id = $1`, [body.siteId]);
      if (!site || site.status === 'revoked') throw badRequest('Der gewählte Zielkanal ist nicht verfügbar.');
    }
    const result = await tx(async (db) => {
      const post = await one<any>('SELECT * FROM posts WHERE id = $1 FOR UPDATE', [id], db);
      if (!post) throw notFound('Beitrag nicht gefunden.');
      if (post.current_revision !== body.baseRevision) {
        throw conflict(`Der Beitrag wurde inzwischen geändert (aktuell Fassung ${post.current_revision}). Bitte neu laden.`, { current: post.current_revision });
      }
      const cur = await one<any>('SELECT * FROM post_revisions WHERE post_id = $1 AND number = $2', [id, post.current_revision], db);
      const next = { title: body.title, body: body.body, excerpt: body.excerpt, media_ids: body.mediaIds, cover_id: body.coverId, site_id: body.siteId };
      const hash = revisionHash(next);
      if (hash === cur.content_hash) return { changed: false, number: cur.number };
      const number = cur.number + 1;
      await db.query(
        `INSERT INTO post_revisions (post_id, number, title, body, excerpt, media_ids, cover_id, site_id, content_hash, change_note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, number, body.title, body.body, body.excerpt, body.mediaIds, body.coverId, body.siteId, hash, body.changeNote, userId],
      );
      await db.query('UPDATE posts SET current_revision = $2, title = $3, updated_at = now(), updated_by = $4 WHERE id = $1', [id, number, body.title, userId]);
      const hadApproval = await one(`SELECT 1 FROM approvals WHERE revision_id = $1 AND decision = 'approved' AND revoked_at IS NULL`, [cur.id], db);
      await audit(req.auth!.actor, 'post.revised', { type: 'post', id, label: body.title }, { fassung: number, freigabe_entfaellt: !!hadApproval }, 'ok', db);
      return { changed: true, number, approvalInvalidated: !!hadApproval };
    });
    return result;
  });

  app.patch('/posts/:id', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ kind: z.enum(POST_KINDS).optional(), archived: z.boolean().optional() }).parse(req.body);
    const p = await one<any>(
      `UPDATE posts SET kind = COALESCE($2, kind), archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, body.kind ?? null, body.archived ?? null],
    );
    if (!p) throw notFound();
    await audit(req.auth!.actor, 'post.updated', { type: 'post', id, label: p.title }, body);
    return { ok: true };
  });

  app.post('/posts/:id/submit', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { revision } = z.object({ revision: z.number().int().min(1) }).parse(req.body);
    const st = await postState(id);
    if (!st) throw notFound();
    if (st.current.number !== revision) throw conflict('Es gibt eine neuere Fassung. Bitte neu laden.');
    if (st.validApproval) throw badRequest('Diese Fassung ist bereits freigegeben.');
    if (!st.current.body.trim()) throw badRequest('Bitte zuerst einen Text schreiben.');
    await pool.query('UPDATE post_revisions SET submitted_at = now(), submitted_by = $2 WHERE id = $1', [st.current.id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'post.submitted', { type: 'post', id, label: st.current.title }, { fassung: revision });
    await notify({ kind: 'info', title: `Freigabe erbeten: ${st.current.title}`.slice(0, 200), body: `Fassung ${revision}`, link: `/beitraege/${id}`, permission: 'post.approve' });
    return { ok: true };
  });

  /** Freigabe bzw. Zurückweisung einer konkreten Fassung (Prüfsumme muss passen). */
  app.post('/posts/:id/decision', { preHandler: requireAuth('post.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ revision: z.number().int().min(1), contentHash: z.string().length(64), decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).default('') }).parse(req.body);
    const s = await getSettings();
    const userId = req.auth!.user?.id ?? null;
    const res = await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (st.current.number !== body.revision || st.current.content_hash !== body.contentHash) throw conflict('Die Fassung hat sich geändert. Bitte die aktuelle Fassung prüfen.');
      if (st.validApproval) throw badRequest('Diese Fassung ist bereits freigegeben.');
      if (body.decision === 'rejected' && !body.note) throw badRequest('Bitte kurz begründen, warum die Fassung zurückgewiesen wird.');
      if (s['editorial.four_eyes'] && body.decision === 'approved' && st.current.created_by && st.current.created_by === userId) {
        throw forbidden('Vier-Augen-Prinzip: Die eigene Fassung kann nicht selbst freigegeben werden.');
      }
      const a = await one<any>(
        `INSERT INTO approvals (post_id, revision_id, content_hash, decision, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, st.current.id, st.current.content_hash, body.decision, body.note, userId],
        db,
      );
      if (body.decision === 'rejected') await db.query('UPDATE post_revisions SET submitted_at = NULL WHERE id = $1', [st.current.id]);
      await audit(req.auth!.actor, body.decision === 'approved' ? 'post.approved' : 'post.rejected', { type: 'post', id, label: st.current.title }, { fassung: body.revision, pruefsumme: body.contentHash.slice(0, 12) }, 'ok', db);
      return { a, title: st.current.title, author: st.current.submitted_by ?? st.current.created_by };
    });
    if (res.author) {
      await notify({ kind: body.decision === 'approved' ? 'success' : 'warning', title: `${body.decision === 'approved' ? 'Freigegeben' : 'Zurückgewiesen'}: ${res.title}`.slice(0, 200), body: body.note, link: `/beitraege/${id}`, userId: res.author });
    }
    return { ok: true, approvalId: res.a.id };
  });

  app.post('/posts/:id/approval/revoke', { preHandler: requireAuth('post.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const st = await postState(id);
    if (!st?.validApproval) throw badRequest('Es gibt keine gültige Freigabe.');
    if (st.publication && ['queued', 'sent'].includes(st.publication.status)) throw badRequest('Die Veröffentlichung läuft bereits. Bitte zuerst den Auftrag abbrechen.');
    await pool.query('UPDATE approvals SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [st.validApproval.id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'post.approval_revoked', { type: 'post', id, label: st.current.title }, { fassung: st.current.number });
    return { ok: true };
  });

  /** Veröffentlichung beauftragen: nur mit gültiger Freigabe genau dieser Fassung. */
  app.post('/posts/:id/publish', { preHandler: requireAuth('post.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ revision: z.number().int().min(1), contentHash: z.string().length(64) }).parse(req.body);
    const pub = await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (st.current.number !== body.revision || st.current.content_hash !== body.contentHash) throw conflict('Die Fassung hat sich geändert. Eine erneute Freigabe ist nötig.');
      if (!st.validApproval) throw new AppError(409, 'not_approved', 'Diese Fassung ist nicht freigegeben.');
      if (!st.current.site_id) throw badRequest('Für diese Fassung ist kein Zielkanal gewählt. Ohne Zielkanal bleibt der Beitrag intern freigegeben.');
      const site = await one<any>('SELECT * FROM wp_sites WHERE id = $1', [st.current.site_id], db);
      if (!site || site.status !== 'active') throw badRequest('Die Website ist nicht (mehr) gekoppelt.');
      const existing = await one<any>(`SELECT * FROM publications WHERE revision_id = $1 AND site_id = $2 AND status IN ('queued','sent','published','unknown')`, [st.current.id, site.id], db);
      if (existing) return { publication: existing, duplicate: true, title: st.current.title };
      const p = await one<any>(
        `INSERT INTO publications (post_id, revision_id, approval_id, site_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, st.current.id, st.validApproval.id, site.id, req.auth!.user?.id ?? null],
        db,
      );
      await audit(req.auth!.actor, 'publication.requested', { type: 'post', id, label: st.current.title }, { fassung: body.revision, website: site.name, auftrag: p.id }, 'ok', db);
      return { publication: p, duplicate: false, title: st.current.title };
    });
    return { id: pub.publication.id, status: pub.publication.status, duplicate: pub.duplicate };
  });

  app.post('/publications/:id/cancel', { preHandler: requireAuth('post.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await one<any>(`UPDATE publications SET status = 'canceled', result_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [id]);
    if (!p) throw badRequest('Nur noch nicht abgeholte Aufträge können abgebrochen werden.');
    await audit(req.auth!.actor, 'publication.canceled', { type: 'post', id: p.post_id }, { auftrag: id });
    return { ok: true };
  });

  /** Nach bestätigtem Fehler erneut beauftragen (nur dieser Kanal). */
  app.post('/publications/:id/retry', { preHandler: requireAuth('post.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await one<any>(`UPDATE publications SET status = 'queued', error = NULL, fetched_at = NULL WHERE id = $1 AND status = 'failed' RETURNING *`, [id]);
    if (!p) throw badRequest('Nur fehlgeschlagene Aufträge können erneut gestartet werden. Bei „Ergebnis unbekannt“ prüft die Bridge zuerst die Website.');
    await audit(req.auth!.actor, 'publication.retried', { type: 'post', id: p.post_id }, { auftrag: id });
    return { ok: true };
  });

  /** „Fotos und Videos sammeln“: verknüpfte Sammlung samt Upload-Link in einem Schritt. */
  app.post('/posts/:id/collect', { preHandler: requireAnyAuth('post.edit', 'media.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!req.auth!.permissions.has('media.manage')) throw forbidden('Zum Anlegen einer Sammlung fehlt das Recht „Medien verwalten“.');
    const body = z.object({ days: z.number().int().min(1).max(90).optional() }).parse(req.body ?? {});
    const post = await one<any>('SELECT p.id, r.title FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision WHERE p.id = $1', [id]);
    if (!post) throw notFound();
    const userId = req.auth!.user?.id ?? null;
    const { c, l } = await tx(async (db) => {
      const c = await createCollection(req.auth!.actor, userId, { title: post.title, purpose: 'Fotos und Videos für den Beitrag', postId: id }, db);
      const l = await createUploadLink(req.auth!.actor, userId, c.id, { days: body.days, label: 'Beitrag' }, db);
      return { c, l };
    });
    return { collectionId: c.id, linkId: l.id, url: await uploadLinkUrl(req, l.token_enc, l.id), expires_at: l.expires_at };
  });
}
