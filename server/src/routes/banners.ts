import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';

/**
 * Hinweis-Banner: Entwurf → Freigabe genau dieser Fassung → Veröffentlichen an eine Website.
 * Start und Ablauf setzt die Bridge lokal durch – auch ohne Verbindung zu BlaulichtCMS und bei aktivem Seitencache.
 */
export const BANNER_DISPLAYS = ['auto', 'banner', 'popup', 'both'] as const;
export type BannerDisplay = (typeof BANNER_DISPLAYS)[number];

export function bannerHash(b: { title: string; text: string; tone: string; priority: number; starts_at: string | Date; ends_at: string | Date; link_url: string | null; link_text: string | null; site_id: string; display?: string | null }) {
  const base: unknown[] = [b.site_id, b.title, b.text, b.tone, b.priority, new Date(b.starts_at).toISOString(), new Date(b.ends_at).toISOString(), b.link_url ?? null, b.link_text ?? null];
  // Darstellung (#186) ist Teil der Fassung; ohne feste Darstellung bleibt das bisherige Format (bestehende Freigaben gelten)
  if (b.display && b.display !== 'auto') base.push(b.display);
  return crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex');
}

export function bannerPayload(b: any) {
  return {
    id: b.id,
    revision: b.revision,
    title: b.title,
    text: b.text,
    tone: b.tone,
    priority: b.priority,
    starts_at: new Date(b.starts_at).toISOString(),
    ends_at: new Date(b.ends_at).toISOString(),
    link_url: b.link_url,
    link_text: b.link_text,
    /** auto = nach Schweregrad, wie in der Bridge eingestellt (#186) */
    display: (b.display ?? 'auto') as BannerDisplay,
  };
}

export type BannerState = 'draft' | 'in_review' | 'approved' | 'publishing' | 'scheduled' | 'live' | 'expired' | 'ended' | 'failed';

function bannerState(b: any, job: any): BannerState {
  const now = Date.now();
  if (b.ended_at) return 'ended';
  const approved = b.approved_hash && b.approved_hash === b.content_hash;
  if (!approved) return b.submitted_at ? 'in_review' : 'draft';
  if (!job || job.revision !== b.revision || job.action !== 'upsert') return 'approved';
  if (job.status === 'failed') return 'failed';
  if (job.status !== 'done') return 'publishing';
  if (new Date(b.ends_at).getTime() <= now) return 'expired';
  if (new Date(b.starts_at).getTime() > now) return 'scheduled';
  return 'live';
}

const input = z
  .object({
    siteId: z.uuid(),
    title: z.string().trim().min(2).max(120),
    text: z.string().trim().max(500).default(''),
    tone: z.enum(['info', 'warning', 'danger']).default('info'),
    priority: z.number().int().min(1).max(3).default(2),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endsAt: z.iso.datetime({ offset: true }),
    linkUrl: z.url().max(500).nullable().default(null),
    linkText: z.string().trim().max(60).nullable().default(null),
    display: z.enum(BANNER_DISPLAYS).default('auto'),
  })
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt ?? Date.now()), { message: 'Das Ende muss nach dem Start liegen.', path: ['endsAt'] })
  .refine((b) => !b.linkUrl || /^https?:\/\//.test(b.linkUrl), { message: 'Nur http(s)-Links.', path: ['linkUrl'] });

/** Ende nach dem tatsächlich gespeicherten Start – sonst verletzt das UPDATE den CHECK der Tabelle (500 statt 400, #181). */
function assertEndsAfterStart(starts: string, ends: string) {
  if (new Date(ends) <= new Date(starts)) throw badRequest('Das Ende muss nach dem Start liegen.');
}

export async function enqueueBannerJob(db: any, b: any, action: 'upsert' | 'delete', userId: string | null) {
  // Ältere, noch nicht abgeholte Aufträge desselben Banners sind überholt
  await db.query(`UPDATE banner_jobs SET status = 'canceled' WHERE banner_id = $1 AND status = 'queued'`, [b.id]);
  return one<any>(
    `INSERT INTO banner_jobs (banner_id, site_id, action, revision, payload, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.id, b.site_id, action, b.revision, JSON.stringify(action === 'upsert' ? bannerPayload(b) : { id: b.id }), userId],
    db,
  );
}

export async function bannerRoutes(app: FastifyInstance) {
  app.get('/banners', { preHandler: requireAuth('banner.view') }, async () => {
    const rows = await many<any>(
      `SELECT b.*, s.name AS site_name, u.name AS approved_by_name,
              j.status AS job_status, j.revision AS job_revision, j.action AS job_action, j.result_at AS job_result_at, j.error AS job_error
         FROM banners b JOIN wp_sites s ON s.id = b.site_id LEFT JOIN users u ON u.id = b.approved_by
         LEFT JOIN LATERAL (SELECT * FROM banner_jobs WHERE banner_id = b.id AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1) j ON true
        WHERE b.ended_at IS NULL OR b.ended_at > now() - interval '30 days'
        ORDER BY (b.ends_at > now()) DESC, b.priority DESC, b.starts_at DESC LIMIT 200`,
    );
    return rows.map((b) => ({
      ...bannerPayload(b),
      site_id: b.site_id,
      site_name: b.site_name,
      content_hash: b.content_hash,
      submitted_at: b.submitted_at,
      approved_by_name: b.approved_hash === b.content_hash ? b.approved_by_name : null,
      approved_at: b.approved_hash === b.content_hash ? b.approved_at : null,
      state: bannerState(b, b.job_status ? { status: b.job_status, revision: b.job_revision, action: b.job_action } : null),
      synced_at: b.job_result_at,
      error: b.job_error,
    }));
  });

  app.post('/banners', { preHandler: requireAuth('banner.edit') }, async (req) => {
    const v = input.parse(req.body);
    const site = await one<any>(`SELECT status FROM wp_sites WHERE id = $1`, [v.siteId]);
    if (!site || site.status === 'revoked') throw badRequest('Die Website ist nicht verfügbar.');
    const starts = v.startsAt ?? new Date().toISOString();
    assertEndsAfterStart(starts, v.endsAt);
    const row = { site_id: v.siteId, title: v.title, text: v.text, tone: v.tone, priority: v.priority, starts_at: starts, ends_at: v.endsAt, link_url: v.linkUrl, link_text: v.linkText, display: v.display };
    const b = await one<any>(
      `INSERT INTO banners (site_id, title, text, tone, priority, starts_at, ends_at, link_url, link_text, content_hash, created_by, updated_by, display) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12) RETURNING *`,
      [v.siteId, v.title, v.text, v.tone, v.priority, starts, v.endsAt, v.linkUrl, v.linkText, bannerHash(row), req.auth!.user?.id ?? null, v.display],
    );
    await audit(req.auth!.actor, 'banner.created', { type: 'banner', id: b.id, label: b.title });
    return bannerPayload(b);
  });

  app.put('/banners/:id', { preHandler: requireAuth('banner.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = input.parse(req.body);
    const res = await tx(async (db) => {
      const b = await one<any>('SELECT * FROM banners WHERE id = $1 FOR UPDATE', [id], db);
      if (!b) throw notFound();
      if (b.ended_at) throw badRequest('Das Banner ist beendet.');
      const starts = v.startsAt ?? new Date(b.starts_at).toISOString();
      // Ohne neuen Start gilt der gespeicherte – das Eingabeschema prüft nur gegen „jetzt“ (#181)
      assertEndsAfterStart(starts, v.endsAt);
      const row = { site_id: v.siteId, title: v.title, text: v.text, tone: v.tone, priority: v.priority, starts_at: starts, ends_at: v.endsAt, link_url: v.linkUrl, link_text: v.linkText, display: v.display };
      const hash = bannerHash(row);
      if (hash === b.content_hash) return { changed: false, banner: b };
      const u = await one<any>(
        `UPDATE banners SET site_id = $2, title = $3, text = $4, tone = $5, priority = $6, starts_at = $7, ends_at = $8, link_url = $9, link_text = $10,
                content_hash = $11, revision = revision + 1, submitted_at = NULL, submitted_by = NULL, updated_at = now(), updated_by = $12, display = $13 WHERE id = $1 RETURNING *`,
        [id, v.siteId, v.title, v.text, v.tone, v.priority, starts, v.endsAt, v.linkUrl, v.linkText, hash, req.auth!.user?.id ?? null, v.display],
        db,
      );
      await audit(req.auth!.actor, 'banner.revised', { type: 'banner', id, label: u.title }, { fassung: u.revision, freigabe_entfaellt: b.approved_hash === b.content_hash }, 'ok', db);
      return { changed: true, banner: u };
    });
    return { changed: res.changed, ...bannerPayload(res.banner) };
  });

  app.post('/banners/:id/submit', { preHandler: requireAuth('banner.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = await one<any>(`UPDATE banners SET submitted_at = now(), submitted_by = $2 WHERE id = $1 AND ended_at IS NULL RETURNING *`, [id, req.auth!.user?.id ?? null]);
    if (!b) throw notFound();
    await audit(req.auth!.actor, 'banner.submitted', { type: 'banner', id, label: b.title }, { fassung: b.revision });
    return { ok: true };
  });

  app.post('/banners/:id/approve', { preHandler: requireAuth('approval.banner') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { contentHash } = z.object({ contentHash: z.string().length(64) }).parse(req.body);
    const s = await getSettings();
    const b = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    if (!b) throw notFound();
    if (b.content_hash !== contentHash) throw conflict('Das Banner wurde inzwischen geändert. Bitte die aktuelle Fassung prüfen.');
    // Nur eingereichte Fassungen freigeben (#147) – wie bei Beiträgen; ein gespeicherter Entwurf ist nicht zur Prüfung vorgelegt
    if (!b.submitted_at) throw new AppError(409, 'not_submitted', 'Noch nicht zur Freigabe eingereicht.');
    // Vier-Augen-Prinzip (#169): Banner haben keine Fassungshistorie – gesperrt sind, wer es angelegt, zuletzt geändert
    // oder eingereicht hat
    const uid = req.auth!.user?.id;
    if (s['editorial.four_eyes'] && uid && [b.created_by, b.updated_by, b.submitted_by].includes(uid)) {
      throw forbidden('Vier-Augen-Prinzip: Wer das Banner angelegt, geändert oder eingereicht hat, kann es nicht selbst freigeben.');
    }
    // Nur genau die geprüfte Fassung freigeben – eine Änderung zwischen Lesen und Freigabe führt zu 409 (#54)
    const upd = await pool.query(
      `UPDATE banners SET approved_hash = $3, approved_by = $2, approved_at = now() WHERE id = $1 AND content_hash = $3 AND ended_at IS NULL AND submitted_at IS NOT NULL`,
      [id, req.auth!.user?.id ?? null, contentHash],
    );
    if (!upd.rowCount) throw conflict('Das Banner wurde inzwischen geändert, beendet oder nicht mehr zur Freigabe vorgelegt. Bitte die aktuelle Fassung prüfen.');
    await audit(req.auth!.actor, 'banner.approved', { type: 'banner', id, label: b.title }, { fassung: b.revision });
    return { ok: true };
  });

  app.post('/banners/:id/publish', { preHandler: requireAuth('banner.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { contentHash } = z.object({ contentHash: z.string().length(64) }).parse(req.body);
    const job = await tx(async (db) => {
      const b = await one<any>('SELECT * FROM banners WHERE id = $1 FOR UPDATE', [id], db);
      if (!b) throw notFound();
      if (b.content_hash !== contentHash || b.approved_hash !== b.content_hash) throw conflict('Diese Fassung ist nicht freigegeben.');
      if (new Date(b.ends_at) <= new Date()) throw badRequest('Das Ende liegt in der Vergangenheit.');
      const site = await one<any>('SELECT status FROM wp_sites WHERE id = $1', [b.site_id], db);
      if (site?.status !== 'active') throw conflict(site?.status === 'pending' ? 'Die Website ist noch nicht gekoppelt – erst koppeln, dann veröffentlichen.' : 'Die Website ist nicht verfügbar.');
      const open = await one<any>(`SELECT * FROM banner_jobs WHERE banner_id = $1 AND revision = $2 AND action = 'upsert' AND status IN ('queued','sent','done')`, [id, b.revision], db);
      if (open) return open;
      const j = await enqueueBannerJob(db, b, 'upsert', req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'banner.published', { type: 'banner', id, label: b.title }, { fassung: b.revision }, 'ok', db);
      return j;
    });
    return { id: job.id, status: job.status };
  });

  /** Sofort beenden (vor dem geplanten Ablauf). Braucht keine Freigabe – Entfernen ist immer erlaubt. */
  app.post('/banners/:id/end', { preHandler: requireAuth('banner.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await tx(async (db) => {
      const b = await one<any>(`UPDATE banners SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *`, [id], db);
      if (!b) throw notFound('Banner nicht gefunden oder bereits beendet.');
      const published = await one(`SELECT 1 FROM banner_jobs WHERE banner_id = $1 AND action = 'upsert' AND status IN ('sent','done')`, [id], db);
      if (published) await enqueueBannerJob(db, b, 'delete', req.auth!.user?.id ?? null);
      else await db.query(`UPDATE banner_jobs SET status = 'canceled' WHERE banner_id = $1 AND status = 'queued'`, [id]);
      await audit(req.auth!.actor, 'banner.ended', { type: 'banner', id, label: b.title }, {}, 'ok', db);
    });
    return { ok: true };
  });
}
