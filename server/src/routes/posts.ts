import crypto from 'node:crypto';
import { WRITABLE_SQL } from '../connections/common.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { createCollection, createUploadLink, freshLinkUrl, uploadLinkUrl } from './media.js';
import { approvalStillValid, assertMediaPresent, assertPrivacyChecked, missingMediaCount, privacyAudit, privacyFindings } from '../lib/approval.js';
import { ALT_MAX, altCheck, cleanMediaAlt } from '../lib/accessibility.js';
import { foldSql, searchTerms } from './search.js';
import { postChecklist } from '../lib/post-checklist.js';
import { decidedBy, refreshApprovalNotice } from '../approvals/notices.js';

export const POST_KINDS = ['news', 'incident', 'event', 'situation'] as const;

/** Adresse der Freigabe-Ansicht einer Fassung (#216) – Ziel der Benachrichtigung „Freigabe erbeten“. */
export const reviewLink = (postId: string, revision: number) => `/freigabe/beitrag/${postId}?fassung=${revision}`;

export interface ChannelText {
  title?: string;
  body?: string;
  excerpt?: string;
  /** Nur WordPress (#186): Kategorie-IDs der Website; leer = Standardkategorie der Bridge */
  categories?: number[];
  /** Nur Mastodon (#215): Inhaltswarnung (spoiler_text), optional */
  cw?: string;
}
export type Variants = Partial<Record<'wordpress' | 'facebook' | 'instagram' | 'threads' | 'x' | 'whatsapp' | 'mastodon' | 'bluesky', ChannelText>>;

/** Kategorie-IDs geordnet und ohne Doppelte – gleiche Auswahl ergibt dieselbe Prüfsumme. */
export function wpCategoryList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31))].sort((a, b) => a - b).slice(0, 20);
}

function cleanVariants(v: Variants | null | undefined): Variants {
  const out: Variants = {};
  for (const [k, t] of Object.entries(v ?? {})) {
    const c: ChannelText = {};
    if (t?.title?.trim()) c.title = t.title;
    if (t?.body?.trim()) c.body = t.body;
    if (t?.excerpt?.trim()) c.excerpt = t.excerpt;
    if (k === 'mastodon' && t?.cw?.trim()) c.cw = t.cw;
    const cats = wpCategoryList(t?.categories);
    if (k === 'wordpress' && cats.length) c.categories = cats;
    if (Object.keys(c).length) (out as any)[k] = c;
  }
  return out;
}

/**
 * Prüfsumme einer Fassung: Text, Medien (in Reihenfolge), Titelbild, Website, Texte je Netzwerk und Termin.
 * Ohne Texte je Netzwerk und Termin bleibt das Format der ersten Version erhalten (bestehende Freigaben bleiben gültig).
 */
export function revisionHash(r: { title: string; body: string; excerpt: string; media_ids: string[]; cover_id: string | null; site_id: string | null; variants?: Variants | null; publish_at?: string | Date | null; social_targets?: string[] | null; social_formats?: Record<string, string> | null; media_alt?: Record<string, string> | null }): string {
  const base: unknown[] = [r.title, r.body, r.excerpt, r.media_ids, r.cover_id ?? null, r.site_id ?? null];
  const v = cleanVariants(r.variants);
  const at = r.publish_at ? new Date(r.publish_at).toISOString() : null;
  const social = [...(r.social_targets ?? [])].sort();
  if (Object.keys(v).length || at || social.length) base.push(v, at);
  // Soziale Netzwerke sind Teil der Fassung (Änderung → neue Freigabe); ohne sie bleibt das alte Format
  if (social.length) base.push(social);
  // Formate je Netzwerk (Story, #188) – nur wenn vom Standard „Beitrag“ abweichend, sonst bleibt das alte Format
  const formats = cleanFormats(r.social_formats, r.social_targets ?? []);
  if (Object.keys(formats).length) base.push(Object.fromEntries(Object.entries(formats).sort(([a], [b]) => a.localeCompare(b))));
  // Alternativtexte je Bild (#217) – nur wenn vorhanden, sonst bleibt das alte Format
  const alt = cleanMediaAlt(r.media_alt, r.media_ids ?? []);
  if (Object.keys(alt).length) base.push({ alt });
  return crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex');
}

/** Formate je Netzwerk: nur gewählte Netzwerke und nur Abweichungen vom Standard „feed“. */
export function cleanFormats(f: Record<string, string> | null | undefined, targets: string[]): Record<string, 'story' | 'both'> {
  const out: Record<string, 'story' | 'both'> = {};
  for (const [k, v] of Object.entries(f ?? {})) if (targets.includes(k) && (v === 'story' || v === 'both')) out[k] = v;
  return out;
}

/** Text, der an ein Netzwerk geht: Text je Netzwerk, sonst Grundtext. */
export function textFor(rev: { title: string; body: string; excerpt: string; variants?: Variants | null }, channel: 'wordpress'): Required<Omit<ChannelText, 'categories' | 'cw'>> {
  const v = (rev.variants ?? {})[channel] ?? {};
  return { title: v.title?.trim() ? v.title : rev.title, body: v.body?.trim() ? v.body : rev.body, excerpt: v.excerpt?.trim() ? v.excerpt : rev.excerpt };
}

export type PostState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'unknown' | 'deactivated';

/** Status eines Beitrags – immer bezogen auf die aktuelle Fassung. */
/**
 * Was von einem Beitrag noch öffentlich ist (vor dem Löschen): je aktiver Website der letzte wirksame Auftrag
 * (veröffentlicht, unterwegs oder ungeklärt bzw. ein noch nicht bestätigter Rückzug) und Social-Posts, die
 * veröffentlicht, unterwegs oder ungeklärt und nicht als entfernt bestätigt sind.
 */
export async function postLive(postId: string, db: Queryable = pool): Promise<{ kind: 'website' | 'social'; id: string; label: string }[]> {
  const sites = await many<any>(
    `SELECT * FROM (
       SELECT DISTINCT ON (pb.site_id) pb.id, pb.action, pb.status, s.name
         FROM publications pb JOIN wp_sites s ON s.id = pb.site_id AND s.status = 'active'
        WHERE pb.post_id = $1 AND pb.status NOT IN ('canceled','failed')
        ORDER BY pb.site_id, pb.created_at DESC) x
      WHERE (x.action = 'publish' AND x.status IN ('published','sent','unknown')) OR (x.action = 'unpublish' AND x.status IN ('queued','sent','unknown'))`,
    [postId],
    db,
  );
  const social = await many<any>(
    `SELECT sp.id, c.name FROM social_publications sp JOIN connections c ON c.id = sp.connection_id
      WHERE sp.post_id = $1 AND sp.status IN ('publishing','published','unknown') AND sp.removed_at IS NULL`,
    [postId],
    db,
  );
  return [
    ...sites.map((s) => ({ kind: 'website' as const, id: s.id, label: `Website „${s.name}“` })),
    ...social.map((s) => ({ kind: 'social' as const, id: s.id, label: `„${s.name}“` })),
  ];
}

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
  const pub = await one<any>(`SELECT * FROM publications WHERE revision_id = $1 AND action = 'publish' ORDER BY created_at DESC LIMIT 1`, [cur.id], db);
  const latest = await one<any>(`SELECT * FROM publications WHERE post_id = $1 ORDER BY created_at DESC LIMIT 1`, [postId], db);
  let state: PostState = 'draft';
  if (cur.submitted_at) state = 'in_review';
  if (approval?.decision === 'rejected' && (!cur.submitted_at || new Date(approval.decided_at) >= new Date(cur.submitted_at))) state = 'rejected';
  if (validApproval) state = 'approved';
  if (validApproval && pub) {
    state =
      pub.status === 'published' ? 'published'
      : pub.status === 'failed' ? 'failed'
      : pub.status === 'unknown' ? 'unknown'
      : pub.status === 'canceled' ? 'approved'
      : pub.status === 'queued' && new Date(pub.run_at) > new Date() ? 'scheduled'
      : 'publishing';
  }
  if (latest?.action === 'unpublish' && latest.status === 'published') state = 'deactivated';
  return { current: cur, approval, validApproval, publication: pub, latest, state };
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
           WHEN lp.action = 'unpublish' AND lp.status = 'published' THEN 'deactivated'
           WHEN a.decision = 'approved' AND a.content_hash = r.content_hash AND pb.status = 'queued' AND pb.run_at > now() THEN 'scheduled'
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
    LEFT JOIN LATERAL (SELECT status, remote_url, run_at FROM publications WHERE revision_id = r.id AND action = 'publish' ORDER BY created_at DESC LIMIT 1) pb ON true
    LEFT JOIN LATERAL (SELECT status, action FROM publications WHERE post_id = p.id ORDER BY created_at DESC LIMIT 1) lp ON true`;

/**
 * Vier-Augen-Prinzip (#169, wie bei Warnentwürfen #153): Wer bis zu dieser Fassung Inhalte geschrieben (Text,
 * Texte je Netzwerk, Medien, Titelbild) oder die Fassung eingereicht hat, darf sie nicht freigeben. Nur Termin, Website
 * oder soziale Netzwerke zu ändern zählt nicht als Schreiben. Gemeinsam genutzt von der Entscheidung und der
 * Freigabe-Ansicht (#216), damit beide dieselbe Regel anwenden.
 */
export async function fourEyesBlocked(postId: string, number: number, submittedBy: string | null, userId: string, db: Queryable = pool): Promise<boolean> {
  if (submittedBy === userId) return true;
  const own = await one<any>(`SELECT 1 WHERE ${postAuthoredSql('$1::uuid', '$2::int', '$3::uuid')}`, [postId, number, userId], db);
  return !!own;
}

/**
 * SQL-Bedingung „hat bis zu dieser Fassung Inhalte geschrieben“ (siehe fourEyesBlocked) – gemeinsam für die Entscheidung
 * und die Freigaben-Liste (#251), damit beide dieselbe Regel anwenden. Parameter sind SQL-Ausdrücke.
 */
export const postAuthoredSql = (postId: string, number: string, userId: string) => `EXISTS (
  SELECT 1 FROM post_revisions ar LEFT JOIN post_revisions ap ON ap.post_id = ar.post_id AND ap.number = ar.number - 1
   WHERE ar.post_id = ${postId} AND ar.number <= ${number} AND ar.created_by = ${userId}
     AND (ap.id IS NULL OR ar.title IS DISTINCT FROM ap.title OR ar.body IS DISTINCT FROM ap.body OR ar.excerpt IS DISTINCT FROM ap.excerpt
          OR ar.media_ids IS DISTINCT FROM ap.media_ids OR ar.cover_id IS DISTINCT FROM ap.cover_id OR ar.variants IS DISTINCT FROM ap.variants))`;

async function loadMedia(ids: string[]) {
  if (!ids.length) return [];
  const rows = await many<any>(
    `SELECT id, original_name, kind, mime, width, height, has_preview, has_public, status, deleted_at, sensitive_flags, (jsonb_array_length(redactions) > 0 OR crop IS NOT NULL) AS redacted, strip_audio, public_rev, alt_text,
            face_status, (SELECT count(*) FROM jsonb_array_elements(face_proposals) p WHERE p->>'status' = 'open')::int AS faces_open
       FROM media WHERE id = ANY($1)`,
    [ids],
  );
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
  variants: z
    .object({
      wordpress: z.object({ title: z.string().max(200).optional(), body: z.string().max(50_000).optional(), excerpt: z.string().max(1_000).optional(), categories: z.array(z.number().int().positive()).max(20).optional() }).optional(),
      facebook: z.object({ body: z.string().max(60_000).optional() }).optional(),
      instagram: z.object({ body: z.string().max(2_200).optional() }).optional(),
      threads: z.object({ body: z.string().max(2_000).optional() }).optional(),
      x: z.object({ body: z.string().max(2_000).optional() }).optional(),
      whatsapp: z.object({ body: z.string().max(60_000).optional() }).optional(),
      mastodon: z.object({ body: z.string().max(5_000).optional(), cw: z.string().max(500).optional() }).optional(),
      bluesky: z.object({ body: z.string().max(2_000).optional() }).optional(),
    })
    .default({}),
  socialTargets: z.array(z.uuid()).max(10).default([]),
  /** Format je Netzwerk (#188): feed (Standard), story oder both – Storys gibt es für Facebook und Instagram. */
  socialFormats: z.record(z.uuid(), z.enum(['feed', 'story', 'both'])).default({}),
  /** Alternativtext je Bild (#217) – Teil der Fassung */
  mediaAlt: z.record(z.uuid(), z.string().max(ALT_MAX * 2)).default({}),
  publishAt: z.iso.datetime({ offset: true }).nullable().default(null),
  changeNote: z.string().trim().max(300).default(''),
});

export async function postRoutes(app: FastifyInstance) {
  app.get('/posts', { preHandler: requireAuth('post.view') }, async (req) => {
    const q = z
      .object({
        state: z.string().max(20).optional(),
        archived: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default(false),
        // Suche in Titel, Text und Kurzfassung der aktuellen Fassung (#260), wie die Suche (Strg K) ohne Groß-/Klein-
        // schreibung und mit vereinheitlichten Umlauten; alle Wörter müssen vorkommen
        q: z.string().trim().max(100).optional(),
      })
      .parse(req.query);
    const params: unknown[] = [q.archived];
    const terms = q.q ? searchTerms(q.q) : [];
    const hay = foldSql(`r.title || ' ' || coalesce(r.body, '') || ' ' || coalesce(r.excerpt, '')`);
    const conds = terms.map((t) => (params.push(`%${t}%`), `${hay} LIKE $${params.length}`));
    // Ziele der Liste (#260): Website und soziale Netzwerke der aktuellen Fassung samt Stand, geplanter Zeitpunkt
    const rows = await many<any>(
      `SELECT x.*, r.publish_at, p.updated_by,
              (SELECT run_at FROM publications WHERE revision_id = x.revision_id AND action = 'publish' ORDER BY created_at DESC LIMIT 1) AS pb_run_at,
              (SELECT coalesce(json_agg(json_build_object('kind', c.kind, 'name', c.name,
                        'status', (SELECT sp.status FROM social_publications sp WHERE sp.revision_id = x.revision_id AND sp.connection_id = c.id ORDER BY sp.created_at DESC LIMIT 1))
                      ORDER BY c.kind, c.name), '[]'::json)
                 FROM connections c WHERE c.id = ANY(r.social_targets) AND c.deleted_at IS NULL) AS social
         FROM (${POST_STATE_SQL} WHERE ($1::boolean OR p.archived_at IS NULL)) x
         JOIN post_revisions r ON r.id = x.revision_id
         JOIN posts p ON p.id = x.id
        ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
        ORDER BY x.updated_at DESC LIMIT 300`,
      params,
    );
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
      updated_by: p.updated_by ?? null,
      social: (p.social ?? []) as { kind: string; name: string; status: string | null }[],
      // geplant: Auftrag mit späterem Termin bzw. Termin der Fassung, solange noch nicht veröffentlicht
      scheduled_at: p.state === 'scheduled' ? p.pb_run_at : p.publish_at && !['published', 'publishing', 'deactivated'].includes(p.state) && new Date(p.publish_at) > new Date() ? p.publish_at : null,
    }));
    return q.state ? out.filter((p) => p.state === q.state) : out;
  });

  app.post('/posts', { preHandler: requireAuth('post.create') }, async (req) => {
    const body = z.object({ title: z.string().trim().min(2).max(200), kind: z.enum(POST_KINDS).default('news'), templateId: z.uuid().nullable().optional() }).parse(req.body);
    const userId = req.auth!.user?.id ?? null;
    const tpl = body.templateId ? await one<any>('SELECT * FROM post_templates WHERE id = $1 AND archived_at IS NULL', [body.templateId]) : null;
    if (body.templateId && !tpl) throw notFound('Vorlage nicht gefunden.');
    const post = await tx(async (db) => {
      const kind = tpl?.kind ?? body.kind;
      const p = await one<any>(`INSERT INTO posts (kind, title, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING *`, [kind, body.title, userId], db);
      const rev = { title: body.title, body: tpl?.body ?? '', excerpt: tpl?.excerpt ?? '', media_ids: [] as string[], cover_id: null, site_id: null };
      await db.query(
        `INSERT INTO post_revisions (post_id, number, title, body, excerpt, media_ids, cover_id, site_id, content_hash, created_by) VALUES ($1,1,$2,$3,$4,'{}',NULL,NULL,$5,$6)`,
        [p.id, body.title, rev.body, rev.excerpt, revisionHash(rev), userId],
      );
      await audit(req.auth!.actor, 'post.created', { type: 'post', id: p.id, label: body.title }, { art: kind, vorlage: tpl?.name ?? null }, 'ok', db);
      return p;
    });
    return post;
  });

  app.get('/posts/:id', { preHandler: requireAuth('post.view') }, async (req) => {
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
      `SELECT pb.*, s.name AS site_name, s.status AS site_status, r.number AS revision_number, u.name AS created_by_name
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
              (SELECT count(*)::int FROM media m WHERE m.collection_id = c.id AND m.status = 'ready' AND m.deleted_at IS NULL AND m.selection = 'selected') AS selected_count,
              (SELECT count(*)::int FROM media m WHERE m.collection_id = c.id AND m.status = 'ready' AND m.deleted_at IS NULL AND m.selection = 'pending') AS pending_count,
              -- Ausgewählte Dateien (#262): „n ausgewählt, noch nicht übernommen“ im nächsten Schritt
              (SELECT COALESCE(array_agg(m.id ORDER BY m.created_at), '{}') FROM media m WHERE m.collection_id = c.id AND m.status = 'ready' AND m.deleted_at IS NULL AND m.selection = 'selected') AS selected_ids
         FROM collections c WHERE c.post_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at`,
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
        variants: cur.variants ?? {},
        social_targets: cur.social_targets ?? [],
        social_formats: cur.social_formats ?? {},
        media_alt: cur.media_alt ?? {},
        publish_at: cur.publish_at,
        content_hash: cur.content_hash,
        submitted_at: cur.submitted_at,
        created_at: cur.created_at,
        created_by: cur.created_by,
      },
      media: await loadMedia(cur.media_ids),
      /** Inzwischen gelöschte Dateien der Fassung (#167): Veröffentlichen ist dann gesperrt. */
      missing_media: await missingMediaCount(cur),
      /** Barrierefreiheit (#217): Bilder ohne Alternativtext und ob die Freigabe dann blockiert ist */
      accessibility: await altCheck(cur),
      approval: st.validApproval ? { decided_by_name: st.validApproval.decided_by_name, decided_at: st.validApproval.decided_at, note: st.validApproval.note } : null,
      lastDecision: st.approval ? { decision: st.approval.decision, note: st.approval.note, decided_by_name: st.approval.decided_by_name, decided_at: st.approval.decided_at } : null,
      revisions,
      approvals,
      publications: publications.map((p) => ({
        id: p.id,
        action: p.action,
        run_at: p.run_at,
        site_name: p.site_name,
        site_active: p.site_status === 'active',
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
      social: await many<any>(
        `SELECT sp.id, sp.status, sp.format, sp.remote_url, sp.remote_id, sp.error, sp.error_class, sp.attempts, sp.created_at, sp.published_at, sp.shared_at,
                CASE WHEN $2 THEN sp.insights END AS insights, CASE WHEN $2 THEN sp.insights_at END AS insights_at, CASE WHEN $2 THEN sp.insights_error END AS insights_error, CASE WHEN $2 THEN sp.insights_stage END AS insights_stage, (SELECT name FROM users WHERE id = sp.shared_by) AS shared_by_name, sp.removal_status, sp.removal_error, sp.removed_at, CASE WHEN c.deleted_at IS NOT NULL THEN 'Verbindung gelöscht' ELSE c.name END AS connection_name, c.kind, r.number AS revision_number
           FROM social_publications sp JOIN connections c ON c.id = sp.connection_id JOIN post_revisions r ON r.id = sp.revision_id WHERE sp.post_id = $1 ORDER BY sp.created_at DESC`,
        [id, req.auth!.permissions.has('insights.view')],
      ),
    };
  });

  /** Speichern: erzeugt nur dann eine neue Fassung, wenn sich Inhalt, Medien oder Website ändern. */
  app.put('/posts/:id/revision', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = revisionInput.parse(req.body);
    const userId = req.auth!.user?.id ?? null;
    const media = await loadMedia(body.mediaIds);
    if (media.length !== new Set(body.mediaIds).size || media.some((m: any) => m.status !== 'ready' || m.deleted_at)) throw badRequest('Mindestens eine ausgewählte Datei ist nicht (mehr) verfügbar.');
    if (body.coverId && !body.mediaIds.includes(body.coverId)) throw badRequest('Das Titelbild muss zu den Medien des Beitrags gehören.');
    if (body.siteId) {
      const site = await one<any>(`SELECT status FROM wp_sites WHERE id = $1`, [body.siteId]);
      if (!site || site.status === 'revoked') throw badRequest('Die gewählte Website ist nicht verfügbar.');
    }
    if (body.socialTargets.length) {
      const ok = await many<any>(`SELECT id, kind FROM connections WHERE id = ANY($1) AND kind IN ('facebook','instagram','threads','x','whatsapp','mastodon','bluesky') AND status IN ('tested','active') AND ${WRITABLE_SQL}`, [body.socialTargets]);
      if (ok.length !== new Set(body.socialTargets).size) throw badRequest('Mindestens ein gewähltes soziales Netzwerk ist nicht verfügbar.');
      const noStory = ok.filter((c) => !['facebook', 'instagram'].includes(c.kind) && ['story', 'both'].includes(body.socialFormats[c.id]));
      if (noStory.length) throw badRequest('Storys gibt es nur für Facebook-Seiten und Instagram-Konten.');
    }
    const { wasSubmitted, ...result } = await tx(async (db) => {
      const post = await one<any>('SELECT * FROM posts WHERE id = $1 FOR UPDATE', [id], db);
      if (!post) throw notFound('Beitrag nicht gefunden.');
      if (post.current_revision !== body.baseRevision) {
        throw conflict(`Der Beitrag wurde inzwischen geändert (aktuell Fassung ${post.current_revision}). Bitte neu laden.`, { current: post.current_revision });
      }
      const cur = await one<any>('SELECT * FROM post_revisions WHERE post_id = $1 AND number = $2', [id, post.current_revision], db);
      const variants = cleanVariants(body.variants as Variants);
      const socialTargets = [...new Set(body.socialTargets)];
      const socialFormats = cleanFormats(body.socialFormats, socialTargets);
      // Alternativtexte nur für Bilder der Fassung
      const mediaAlt = cleanMediaAlt(body.mediaAlt, media.filter((m: any) => m.kind === 'image').map((m: any) => m.id));
      const next = { title: body.title, body: body.body, excerpt: body.excerpt, media_ids: body.mediaIds, cover_id: body.coverId, site_id: body.siteId, variants, publish_at: body.publishAt, social_targets: socialTargets, social_formats: socialFormats, media_alt: mediaAlt };
      const hash = revisionHash(next);
      if (hash === cur.content_hash) return { changed: false, number: cur.number, wasSubmitted: false };
      const number = cur.number + 1;
      await db.query(
        `INSERT INTO post_revisions (post_id, number, title, body, excerpt, media_ids, cover_id, site_id, content_hash, change_note, created_by, variants, publish_at, social_targets, social_formats, media_alt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, number, body.title, body.body, body.excerpt, body.mediaIds, body.coverId, body.siteId, hash, body.changeNote, userId, JSON.stringify(variants), body.publishAt, socialTargets, JSON.stringify(socialFormats), JSON.stringify(mediaAlt)],
      );
      // Wiederverwenden (#217): Alternativtexte landen in der Medienverwaltung, wo dort noch keiner steht
      for (const [mid, text] of Object.entries(mediaAlt)) await db.query(`UPDATE media SET alt_text = $2 WHERE id = $1 AND alt_text = ''`, [mid, text]);
      await db.query('UPDATE posts SET current_revision = $2, title = $3, updated_at = now(), updated_by = $4 WHERE id = $1', [id, number, body.title, userId]);
      const hadApproval = await one(`SELECT 1 FROM approvals WHERE revision_id = $1 AND decision = 'approved' AND revoked_at IS NULL`, [cur.id], db);
      await audit(req.auth!.actor, 'post.revised', { type: 'post', id, label: body.title }, { fassung: number, freigabe_entfaellt: !!hadApproval }, 'ok', db);
      return { changed: true, number, approvalInvalidated: !!hadApproval, wasSubmitted: !!cur.submitted_at };
    });
    // Die eingereichte Fassung ist überholt – ihre Freigabe-Anfrage ist erledigt (#253)
    if (wasSubmitted) await refreshApprovalNotice('post', { note: `neue Fassung ${result.number} gespeichert` });
    return result;
  });

  app.patch('/posts/:id', { preHandler: requireAnyAuth('post.edit', 'post.archive') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ kind: z.enum(POST_KINDS).optional(), archived: z.boolean().optional() }).parse(req.body);
    if (body.kind !== undefined && !req.auth!.permissions.has('post.edit')) throw forbidden('Zum Ändern der Art fehlt das Recht „Beiträge bearbeiten“.');
    if (body.archived !== undefined && !req.auth!.permissions.has('post.archive')) throw forbidden('Zum Archivieren fehlt das Recht „Beiträge archivieren“.');
    const p = await one<any>(
      `UPDATE posts SET kind = COALESCE($2, kind), archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, body.kind ?? null, body.archived ?? null],
    );
    if (!p) throw notFound();
    await audit(req.auth!.actor, 'post.updated', { type: 'post', id, label: p.title }, body);
    if (body.archived !== undefined) await refreshApprovalNotice('post', { note: 'archiviert' });
    // Beim Ent-Archivieren melden, wenn Dateien der aktuellen Fassung inzwischen gelöscht wurden (#167)
    if (body.archived === false) {
      const st = await postState(id);
      const missing = st ? await missingMediaCount(st.current) : 0;
      return { ok: true, missingMedia: missing };
    }
    return { ok: true };
  });

  /**
   * Prüfliste der aktuellen Fassung (#262): fehlende Ziele, Titelbild, Alternativtexte, Datenschutz-Prüfung, Formate und
   * Zeichengrenzen je Netzwerk – aus denselben Prüfungen wie Freigabe und Veröffentlichen (lib/post-checklist.ts).
   */
  app.get('/posts/:id/checklist', { preHandler: requireAuth('post.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const st = await postState(id);
    if (!st) throw notFound('Beitrag nicht gefunden.');
    return { revision: st.current.number, ...(await postChecklist(id, st.current)) };
  });

  app.post('/posts/:id/submit', { preHandler: requireAuth('post.submit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { revision } = z.object({ revision: z.number().int().min(1) }).parse(req.body);
    const st = await postState(id);
    if (!st) throw notFound();
    if (st.current.number !== revision) throw conflict('Es gibt eine neuere Fassung. Bitte neu laden.');
    if (st.validApproval) throw badRequest('Diese Fassung ist bereits freigegeben.');
    if (!st.current.body.trim()) throw badRequest('Bitte zuerst einen Text schreiben.');
    // Prüfliste (#262): Einreichen nur, wenn die Freigabe nicht ohnehin scheitern würde (gelöschte Dateien,
    // Alternativtext als Pflicht); Hinweise blockieren nicht
    const check = await postChecklist(id, st.current);
    if (check.blocking) {
      const blocking = check.items.filter((i) => i.level === 'blocking');
      throw new AppError(400, 'submit_blocked', `Einreichen nicht möglich: ${blocking.map((i) => i.title).join(' · ')}.`, { items: blocking });
    }
    await pool.query('UPDATE post_revisions SET submitted_at = now(), submitted_by = $2 WHERE id = $1', [st.current.id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'post.submitted', { type: 'post', id, label: st.current.title }, { fassung: revision });
    // Eine Meldung je Art (#253): einzeln mit Link auf die Freigabe-Ansicht (#216, Push mit Aktionsknöpfen), bei mehreren
    // offenen Fassungen gebündelt mit Link auf die Freigaben-Liste
    await refreshApprovalNotice('post', { added: [id] });
    return { ok: true };
  });

  /**
   * Freigabe-Ansicht (#216): alles, was zum Entscheiden über eine eingereichte Fassung nötig ist, kompakt für das
   * Handy – Vorschau je Netzwerk, Medien, Änderungen zur letzten freigegebenen (sonst vorigen) Fassung und der Stand der
   * Anfrage (offen, entschieden, überholt, zurückgezogen). Entschieden wird weiterhin über POST /posts/:id/decision mit
   * allen Regeln (Prüfsumme, Vier-Augen, Datenschutz-Prüfung, Sitzung mit Zwei-Faktor).
   */
  app.get('/posts/:id/review', { preHandler: requireAuth('approval.post') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { fassung } = z.object({ fassung: z.coerce.number().int().min(1).max(100_000).optional() }).parse(req.query);
    const post = await one<any>(`SELECT id, kind, archived_at FROM posts WHERE id = $1`, [id]);
    if (!post) throw notFound('Beitrag nicht gefunden.');
    const st = (await postState(id))!;
    const cur = st.current;
    const requested = fassung ?? cur.number;
    const reqRev = requested === cur.number ? cur : await one<any>(`SELECT * FROM post_revisions WHERE post_id = $1 AND number = $2`, [id, requested]);
    if (!reqRev) throw notFound('Diese Fassung gibt es nicht.');
    const lastDecision = await one<any>(
      `SELECT a.decision, a.note, a.decided_at, a.revoked_at, u.name AS decided_by_name FROM approvals a LEFT JOIN users u ON u.id = a.decided_by
        WHERE a.revision_id = $1 ORDER BY a.decided_at DESC LIMIT 1`,
      [reqRev.id],
    );
    // Stand der Anfrage für genau die angefragte Fassung
    let request: 'pending' | 'approved' | 'rejected' | 'superseded' | 'withdrawn' | 'revoked';
    if (requested !== cur.number) request = 'superseded';
    else if (st.validApproval || ['scheduled', 'publishing', 'published', 'failed', 'unknown', 'deactivated'].includes(st.state)) request = 'approved';
    else if (st.state === 'rejected') request = 'rejected';
    else if (cur.submitted_at) request = 'pending';
    else if (lastDecision?.decision === 'approved' && lastDecision.revoked_at) request = 'revoked';
    else request = 'withdrawn';
    const userId = req.auth!.user?.id ?? null;
    const s = await getSettings();
    const blocked = request === 'pending' && !!userId && !!s['editorial.four_eyes'] && (await fourEyesBlocked(id, cur.number, cur.submitted_by ?? null, userId));
    // Vergleichsstand: letzte freigegebene frühere Fassung, sonst die vorige
    const base =
      (await one<any>(
        `SELECT r.* FROM post_revisions r WHERE r.post_id = $1 AND r.number < $2
            AND EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id = r.id AND a.decision = 'approved')
          ORDER BY r.number DESC LIMIT 1`,
        [id, reqRev.number],
      )) ?? (reqRev.number > 1 ? await one<any>(`SELECT * FROM post_revisions WHERE post_id = $1 AND number = $2`, [id, reqRev.number - 1]) : null);
    const baseApproved = base ? !!(await one(`SELECT 1 FROM approvals WHERE revision_id = $1 AND decision = 'approved'`, [base.id])) : false;
    const names = await many<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [[reqRev.submitted_by, reqRev.created_by].filter(Boolean)]);
    const nameOf = (uid: string | null) => names.find((n) => n.id === uid)?.name ?? null;
    const targets = (reqRev.social_targets ?? []) as string[];
    const connections = targets.length
      ? await many<any>(`SELECT id, kind, CASE WHEN deleted_at IS NOT NULL THEN 'Verbindung gelöscht' ELSE name END AS name FROM connections WHERE id = ANY($1::uuid[])`, [targets])
      : [];
    const site = reqRev.site_id ? await one<any>(`SELECT name, site_url FROM wp_sites WHERE id = $1`, [reqRev.site_id]) : null;
    const pick = (r: any) => ({
      number: r.number as number,
      title: r.title as string,
      body: r.body as string,
      excerpt: r.excerpt as string,
      variants: cleanVariants(r.variants),
      media_ids: (r.media_ids ?? []) as string[],
      cover_id: r.cover_id as string | null,
      site_id: r.site_id as string | null,
      social_targets: (r.social_targets ?? []) as string[],
      publish_at: r.publish_at,
    });
    return {
      post: { id, kind: post.kind, archived: !!post.archived_at, current_revision: cur.number },
      state: st.state,
      request,
      revision: {
        ...pick(reqRev),
        id: reqRev.id,
        content_hash: reqRev.content_hash,
        social_formats: reqRev.social_formats ?? {},
        change_note: reqRev.change_note,
        created_at: reqRev.created_at,
        created_by_name: nameOf(reqRev.created_by),
        submitted_at: reqRev.submitted_at,
        submitted_by_name: nameOf(reqRev.submitted_by),
      },
      base: base ? { ...pick(base), approved: baseApproved } : null,
      decision: lastDecision ? { decision: lastDecision.decision, note: lastDecision.note, decided_at: lastDecision.decided_at, decided_by_name: lastDecision.decided_by_name, revoked: !!lastDecision.revoked_at } : null,
      media: await loadMedia([...new Set([...(reqRev.media_ids ?? []), ...(reqRev.cover_id ? [reqRev.cover_id] : [])])]),
      missing_media: await missingMediaCount(reqRev),
      /** Barrierefreiheit (#217): Bilder ohne Alternativtext – Hinweis bzw. Sperre im Freigabe-Dialog wie im Beitrag */
      accessibility: await altCheck(reqRev),
      site,
      connections,
      schedule_passed: !!reqRev.publish_at && new Date(reqRev.publish_at) < new Date() && request === 'pending',
      four_eyes_blocked: blocked,
      can_decide: request === 'pending' && !post.archived_at,
    };
  });

  /** Freigabe bzw. Zurückweisung einer konkreten Fassung (Prüfsumme muss passen). */
  app.post('/posts/:id/decision', { preHandler: requireAuth('approval.post') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ revision: z.number().int().min(1), contentHash: z.string().length(64), decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).default(''), privacyChecked: z.boolean().default(false), via: z.enum(['editor', 'review', 'push']).default('editor') }).parse(req.body);
    const s = await getSettings();
    const userId = req.auth!.user?.id ?? null;
    const res = await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (st.current.number !== body.revision || st.current.content_hash !== body.contentHash) throw conflict('Die Fassung hat sich geändert. Bitte die aktuelle Fassung prüfen.');
      if (st.validApproval) throw badRequest('Diese Fassung ist bereits freigegeben.');
      if (!st.current.submitted_at) throw conflict('Diese Fassung wurde noch nicht zur Freigabe eingereicht.');
      if (body.decision === 'rejected' && !body.note) throw badRequest('Bitte kurz begründen, warum die Fassung zurückgewiesen wird.');
      if (body.decision === 'approved') await assertMediaPresent(st.current, db);
      // Barrierefreiheit (#217): ohne Alternativtext je Bild nur, wenn die Einstellung das zulässt (sonst Warnung im Dialog)
      if (body.decision === 'approved') {
        const alt = await altCheck(st.current, db);
        if (alt.required && alt.missing.length) throw new AppError(400, 'alt_text_required', `${alt.missing.length === 1 ? 'Ein Bild hat' : `${alt.missing.length} Bilder haben`} noch keinen Alternativtext. Bitte im Beitrag unter „Medien“ ergänzen, speichern und erneut einreichen.`, { missing: alt.missing });
      }
      // Vier-Augen-Prinzip (#169): siehe fourEyesBlocked
      if (s['editorial.four_eyes'] && body.decision === 'approved' && userId && (await fourEyesBlocked(id, st.current.number, st.current.submitted_by ?? null, userId, db))) {
        throw forbidden('Vier-Augen-Prinzip: Wer am Beitrag geschrieben oder die Fassung eingereicht hat, kann sie nicht selbst freigeben.');
      }
      // Markierte Medien (erkennbare Personen, Verletzte/Gesundheitsdaten, Kennzeichen, sensibel): Freigabe nur mit
      // ausdrücklich bestätigter Datenschutz-Prüfung (#118, Art. 9 DSGVO, KUG)
      // Offene Gesichtsvorschläge (#214) verlangen dieselbe Prüfung: die Suche hat Gesichter gefunden, die noch niemand
      // übernommen oder verworfen hat.
      // Gemeinsame Prüfung für alle Veröffentlichungswege (lib/approval.ts, auch Einsatzliste #241)
      const privacy = await privacyFindings(st.current.media_ids, db);
      if (body.decision === 'approved') assertPrivacyChecked(privacy, body.privacyChecked);
      const a = await one<any>(
        `INSERT INTO approvals (post_id, revision_id, content_hash, decision, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, st.current.id, st.current.content_hash, body.decision, body.note, userId],
        db,
      );
      if (body.decision === 'rejected') await db.query('UPDATE post_revisions SET submitted_at = NULL WHERE id = $1', [st.current.id]);
      await audit(req.auth!.actor, body.decision === 'approved' ? 'post.approved' : 'post.rejected', { type: 'post', id, label: st.current.title }, { fassung: body.revision, pruefsumme: body.contentHash.slice(0, 12), ...(body.via !== 'editor' ? { ansicht: body.via === 'push' ? 'Freigabe-Ansicht (aus Push-Mitteilung)' : 'Freigabe-Ansicht' } : {}), ...(body.decision === 'approved' ? privacyAudit(privacy) : {}) }, 'ok', db);
      return { a, title: st.current.title, author: st.current.submitted_by ?? st.current.created_by };
    });
    if (res.author) {
      await notify({ kind: body.decision === 'approved' ? 'success' : 'warning', title: `${body.decision === 'approved' ? 'Freigegeben' : 'Zurückgewiesen'}: ${res.title}`.slice(0, 200), body: body.note, link: `/beitraege/${id}`, userId: res.author, category: 'decision' });
    }
    // Anfrage erledigt – zählt bei niemandem mehr als ungelesen (#253)
    await refreshApprovalNotice('post', { note: decidedBy(body.decision, req.auth!.actor.name) });
    return { ok: true, approvalId: res.a.id };
  });

  app.post('/posts/:id/approval/revoke', { preHandler: requireAuth('approval.post') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const res = await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st?.validApproval) throw badRequest('Es gibt keine gültige Freigabe.');
      const aid = st.validApproval.id;
      // Aufträge dieser Freigabe sperren (#145): Eine gleichzeitige Abholung durch die Bridge (queued → sent) läuft so
      // entweder ganz vorher (dann sieht die Prüfung unten „sent“) oder danach (dann überspringt sie die gesperrten Zeilen)
      await db.query(`SELECT id FROM publications WHERE approval_id = $1 FOR UPDATE`, [aid]);
      await db.query(`SELECT id FROM social_publications WHERE approval_id = $1 FOR UPDATE`, [aid]);
      // Bereits an die Website übergebene Aufträge laufen ggf. gerade – nicht stillschweigend widerrufen
      // Aufträge widerrufener Websites zählen nicht (#162): Die Website kann nichts mehr melden; sie bleiben „Ergebnis
      // unbekannt“ und werden im Beitrag von Hand abgeschlossen
      const inFlight = await one<any>(
        `SELECT 1 FROM publications pb JOIN wp_sites s ON s.id = pb.site_id AND s.status = 'active'
          WHERE pb.approval_id = $1 AND pb.action = 'publish' AND pb.status IN ('sent','unknown') LIMIT 1`,
        [aid],
        db,
      );
      if (inFlight) throw badRequest('Die Veröffentlichung läuft bereits oder ihr Ergebnis ist ungeklärt. Bitte das Ergebnis abwarten.');
      const socialInFlight = await one<any>(`SELECT 1 FROM social_publications WHERE approval_id = $1 AND status IN ('publishing','unknown') LIMIT 1`, [aid], db);
      if (socialInFlight) throw badRequest('Eine Veröffentlichung in sozialen Netzwerken läuft bereits oder ist ungeklärt. Bitte das Ergebnis abwarten.');
      await db.query('UPDATE approvals SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [aid, req.auth!.user?.id ?? null]);
      // Noch nicht ausgeführte oder fehlgeschlagene Aufträge dieser Freigabe abbrechen (sonst später per Wiederholen veröffentlichbar)
      const c1 = await db.query(`UPDATE publications SET status = 'canceled', error = 'Freigabe widerrufen', result_at = now() WHERE approval_id = $1 AND action = 'publish' AND status IN ('queued','failed')`, [aid]);
      const c2 = await db.query(`UPDATE social_publications SET status = 'canceled', error = 'Freigabe widerrufen', updated_at = now() WHERE approval_id = $1 AND status IN ('queued','failed','ready')`, [aid]);
      await audit(req.auth!.actor, 'post.approval_revoked', { type: 'post', id, label: st.current.title }, { fassung: st.current.number, abgebrochen: (c1.rowCount ?? 0) + (c2.rowCount ?? 0) }, 'ok', db);
      return { canceled: (c1.rowCount ?? 0) + (c2.rowCount ?? 0) };
    });
    // Die Fassung bleibt eingereicht und wartet wieder auf Freigabe: eine offene Meldung zählt sie mit
    await refreshApprovalNotice('post');
    return { ok: true, canceled: res.canceled };
  });

  /** Veröffentlichung beauftragen: nur mit gültiger Freigabe genau dieser Fassung. */
  app.post('/posts/:id/publish', { preHandler: requireAuth('publish.website') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ revision: z.number().int().min(1), contentHash: z.string().length(64) }).parse(req.body);
    const pub = await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (st.current.number !== body.revision || st.current.content_hash !== body.contentHash) throw conflict('Die Fassung hat sich geändert. Eine erneute Freigabe ist nötig.');
      if (!st.validApproval) throw new AppError(409, 'not_approved', 'Diese Fassung ist nicht freigegeben.');
      await assertMediaPresent(st.current, db);
      if (!st.current.site_id) throw badRequest('Für diese Fassung ist keine Website gewählt. Ohne Website bleibt der Beitrag intern freigegeben.');
      const site = await one<any>('SELECT * FROM wp_sites WHERE id = $1', [st.current.site_id], db);
      if (!site || site.status !== 'active') throw badRequest('Die Website ist nicht (mehr) gekoppelt.');
      const existing = await one<any>(`SELECT * FROM publications WHERE revision_id = $1 AND site_id = $2 AND action = 'publish' AND status IN ('queued','sent','published','unknown')`, [st.current.id, site.id], db);
      if (existing) return { publication: existing, duplicate: true, title: st.current.title };
      // Geplanter Termin ist Teil der freigegebenen Fassung; vorher holt die Bridge den Auftrag nicht ab
      const runAt = st.current.publish_at && new Date(st.current.publish_at) > new Date() ? st.current.publish_at : new Date();
      const p = await one<any>(
        `INSERT INTO publications (post_id, revision_id, approval_id, site_id, created_by, run_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, st.current.id, st.validApproval.id, site.id, req.auth!.user?.id ?? null, runAt],
        db,
      );
      await audit(req.auth!.actor, 'publication.requested', { type: 'post', id, label: st.current.title }, { fassung: body.revision, website: site.name, auftrag: p.id, geplant: runAt }, 'ok', db);
      return { publication: p, duplicate: false, title: st.current.title };
    });
    return { id: pub.publication.id, status: pub.publication.status, run_at: pub.publication.run_at, duplicate: pub.duplicate };
  });

  /**
   * Veröffentlichten Beitrag zurückziehen (WordPress: Entwurf, die übernommenen Medien werden aus der Mediathek gelöscht).
   * Gilt für **jede** aktive Website, auf der der Beitrag noch steht – auch wenn eine frühere Fassung auf eine andere
   * Website ging (#98). Braucht keine neue Freigabe. Wurde eine Website widerrufen und dieselbe WordPress-Instanz (gleiche
   * Adresse) neu gekoppelt, geht der Rückzug an die neue Kopplung (#183) – die Bridge findet den Beitrag über die
   * BlaulichtCMS-Beitrags-ID, unabhängig von der Kopplung.
   */
  app.post('/posts/:id/unpublish', { preHandler: requireAuth('publish.unpublish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const res = await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      // Je erreichbarer Website der letzte bestätigte Vorgang: steht dort eine Veröffentlichung (kein späterer Rückzug),
      // ist sie live. Erreichbar = die Website selbst, wenn aktiv, sonst eine aktive Neu-Kopplung mit derselben Adresse
      // (#183); Vorgänge der alten und der neuen Kopplung zählen dann gemeinsam.
      const live = await many<any>(
        `SELECT * FROM (
           SELECT DISTINCT ON (t.id) pb.*, t.id AS target_site_id, rv.title
             FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id JOIN wp_sites s ON s.id = pb.site_id
             JOIN LATERAL (
               SELECT t.id FROM wp_sites t
                WHERE t.status = 'active' AND (t.id = s.id OR (s.site_url IS NOT NULL AND lower(rtrim(t.site_url, '/')) = lower(rtrim(s.site_url, '/'))))
                ORDER BY (t.id = s.id) DESC, t.paired_at DESC NULLS LAST LIMIT 1) t ON true
            WHERE pb.post_id = $1 AND pb.status = 'published' ORDER BY t.id, pb.result_at DESC, pb.created_at DESC) x
          WHERE x.action = 'publish'
          ORDER BY x.result_at DESC`,
        [id],
        db,
      );
      const open = await many<any>(`SELECT * FROM publications WHERE post_id = $1 AND action = 'unpublish' AND status IN ('queued','sent','unknown') ORDER BY created_at`, [id], db);
      const todo = live.filter((l) => !open.some((o) => o.site_id === l.target_site_id));
      if (!todo.length) {
        if (open.length) return { publications: open, duplicate: true };
        throw badRequest('Der Beitrag ist auf keiner Website veröffentlicht.');
      }
      const created: any[] = [];
      for (const last of todo) {
        const p = await one<any>(
          `INSERT INTO publications (post_id, revision_id, approval_id, site_id, created_by, action, error) VALUES ($1,$2,$3,$4,$5,'unpublish',NULL) RETURNING *`,
          [id, last.revision_id, last.approval_id, last.target_site_id, req.auth!.user?.id ?? null],
          db,
        );
        created.push(p);
        await audit(req.auth!.actor, 'publication.unpublish_requested', { type: 'post', id, label: last.title }, { grund: reason, auftrag: p.id, website_id: last.target_site_id, ...(last.target_site_id !== last.site_id ? { veroeffentlicht_ueber: last.site_id, hinweis: 'Website neu gekoppelt (gleiche Adresse)' } : {}) }, 'ok', db);
      }
      return { publications: created, duplicate: false };
    });
    return { id: res.publications[0].id, ids: res.publications.map((p: any) => p.id), sites: res.publications.length, duplicate: res.duplicate };
  });

  /* ------------------------------ Redaktionelle Vorlagen ------------------------------ */

  const tplBody = z.object({ name: z.string().trim().min(2).max(100), kind: z.enum(POST_KINDS).default('news'), title: z.string().max(200).default(''), body: z.string().max(50_000).default(''), excerpt: z.string().max(1_000).default('') });

  app.get('/templates', { preHandler: requireAuth('post.view') }, async () =>
    many<any>(`SELECT t.*, u.name AS created_by_name FROM post_templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.archived_at IS NULL ORDER BY t.name`),
  );
  app.post('/templates', { preHandler: requireAuth('post.templates') }, async (req) => {
    const b = tplBody.parse(req.body);
    const t = await one<any>(`INSERT INTO post_templates (name, kind, title, body, excerpt, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [b.name, b.kind, b.title, b.body, b.excerpt, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'template.created', { type: 'template', id: t.id, label: t.name });
    return t;
  });
  app.put('/templates/:id', { preHandler: requireAuth('post.templates') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = tplBody.parse(req.body);
    const t = await one<any>(`UPDATE post_templates SET name = $2, kind = $3, title = $4, body = $5, excerpt = $6, updated_at = now() WHERE id = $1 RETURNING *`, [id, b.name, b.kind, b.title, b.body, b.excerpt]);
    if (!t) throw notFound();
    await audit(req.auth!.actor, 'template.updated', { type: 'template', id, label: t.name });
    return t;
  });
  app.delete('/templates/:id', { preHandler: requireAuth('post.templates') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await one<any>(`UPDATE post_templates SET archived_at = now() WHERE id = $1 RETURNING name`, [id]);
    if (!t) throw notFound();
    await audit(req.auth!.actor, 'template.archived', { type: 'template', id, label: t.name });
    return { ok: true };
  });

  /**
   * Abbrechen vor der Veröffentlichung: Eine eingereichte Fassung zurückziehen bzw. eine noch nicht veröffentlichte
   * Freigabe zurücknehmen – der Beitrag ist danach wieder ein Entwurf. Wer einreichen darf, darf auch abbrechen; das
   * nimmt nie eine Veröffentlichung vor, sondern verhindert sie nur.
   */
  app.post('/posts/:id/withdraw', { preHandler: requireAuth('post.submit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await tx(async (db) => {
      await db.query('SELECT 1 FROM posts WHERE id = $1 FOR UPDATE', [id]);
      const st = await postState(id, db);
      if (!st) throw notFound();
      if (!['in_review', 'approved'].includes(st.state)) throw badRequest('Abbrechen geht nur, solange die Fassung eingereicht oder freigegeben, aber noch nicht veröffentlicht ist.');
      if (st.validApproval) {
        const aid = st.validApproval.id;
        await db.query(`SELECT id FROM publications WHERE approval_id = $1 FOR UPDATE`, [aid]);
        await db.query(`SELECT id FROM social_publications WHERE approval_id = $1 FOR UPDATE`, [aid]);
        const busy = await one<any>(
          `SELECT 1 FROM publications WHERE approval_id = $1 AND action = 'publish' AND status IN ('queued','sent','unknown','published')
           UNION ALL SELECT 1 FROM social_publications WHERE approval_id = $1 AND status IN ('queued','publishing','unknown','published') LIMIT 1`,
          [aid],
          db,
        );
        if (busy) throw badRequest('Für diese Freigabe läuft bereits eine Veröffentlichung. Bitte zuerst den Auftrag abbrechen bzw. zurückziehen.');
        await db.query('UPDATE approvals SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [aid, req.auth!.user?.id ?? null]);
        await db.query(`UPDATE social_publications SET status = 'canceled', error = 'Abgebrochen', updated_at = now() WHERE approval_id = $1 AND status IN ('failed','ready')`, [aid]);
      }
      await db.query('UPDATE post_revisions SET submitted_at = NULL, submitted_by = NULL WHERE id = $1', [st.current.id]);
      await audit(req.auth!.actor, 'post.withdrawn', { type: 'post', id, label: st.current.title }, { fassung: st.current.number, freigabe_zurueckgenommen: !!st.validApproval }, 'ok', db);
    });
    await refreshApprovalNotice('post', { note: 'zurückgezogen' });
    return { ok: true };
  });

  /**
   * Beitrag löschen (Recht „Beiträge löschen“): endgültig mit allen Fassungen, Freigaben und Aufträgen – aber nur, wenn
   * nichts mehr öffentlich ist. Noch auf einer (aktiven) Website oder in einem sozialen Netzwerk sichtbare
   * Veröffentlichungen müssen vorher zurückgezogen bzw. entfernt werden; die Antwort nennt sie. Sammlungen, Medien und
   * Presseanfragen bleiben erhalten (ohne Bezug zum Beitrag). Das Audit-Protokoll behält Titel und Zeitpunkt.
   */
  app.delete('/posts/:id', { preHandler: requireAuth('post.delete') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const res = await tx(async (db) => {
      const p = await one<any>(`SELECT p.id, r.title, p.current_revision FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision WHERE p.id = $1 FOR UPDATE OF p`, [id], db);
      if (!p) throw notFound('Beitrag nicht gefunden.');
      const live = await postLive(id, db);
      if (live.length) throw new AppError(409, 'post_live', `Der Beitrag ist noch veröffentlicht: ${live.map((l) => l.label).join(', ')}. Bitte zuerst zurückziehen bzw. entfernen.`, { live });
      await db.query(`DELETE FROM posts WHERE id = $1`, [id]);
      await audit(req.auth!.actor, 'post.deleted', { type: 'post', id, label: p.title }, { fassungen: p.current_revision }, 'ok', db);
      return p;
    });
    await refreshApprovalNotice('post', { note: 'gelöscht' });
    return { ok: true, title: res.title };
  });

  app.post('/publications/:id/cancel', { preHandler: requireAuth('publish.website') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await one<any>(`UPDATE publications SET status = 'canceled', result_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [id]);
    if (!p) throw badRequest('Nur noch nicht abgeholte Aufträge können abgebrochen werden.');
    await audit(req.auth!.actor, 'publication.canceled', { type: 'post', id: p.post_id }, { auftrag: id });
    return { ok: true };
  });

  /**
   * Auftrag einer widerrufenen Website von Hand abschließen (#162): Die Website kann das Ergebnis nie mehr melden.
   * Die Redaktion prüft auf der Website, ob der Auftrag ausgeführt wurde, und hält das Ergebnis fest (mit Audit).
   * „Ausgeführt“ → 'published' (bei Rückzug: zurückgezogen), „nicht ausgeführt“ → 'canceled'.
   */
  app.post('/publications/:id/resolve', { preHandler: requireAuth('publish.website') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ outcome: z.enum(['done', 'not_done']), note: z.string().trim().min(3).max(300) }).parse(req.body);
    const p = await tx(async (db) => {
      const cur = await one<any>(
        `SELECT pb.*, s.status AS site_status, s.name AS site_name, rv.title FROM publications pb JOIN wp_sites s ON s.id = pb.site_id JOIN post_revisions rv ON rv.id = pb.revision_id
          WHERE pb.id = $1 FOR UPDATE OF pb`,
        [id],
        db,
      );
      if (!cur) throw notFound();
      if (!['sent', 'unknown'].includes(cur.status)) throw badRequest('Nur abgeholte Aufträge mit offenem Ergebnis können von Hand abgeschlossen werden.');
      if (cur.site_status === 'active') throw badRequest('Die Website ist gekoppelt und meldet das Ergebnis selbst. Bitte abwarten.');
      const done = b.outcome === 'done';
      const label = cur.action === 'unpublish' ? (done ? 'zurückgezogen' : 'nicht zurückgezogen') : done ? 'veröffentlicht' : 'nicht veröffentlicht';
      await db.query(
        `UPDATE publications SET status = $2, remote_status = CASE WHEN $2 = 'published' THEN 'von Hand bestätigt' ELSE remote_status END, error = $3, result_at = now() WHERE id = $1`,
        [id, done ? 'published' : 'canceled', `Von Hand abgeschlossen: ${label} – ${b.note}`.slice(0, 1000)],
      );
      await audit(req.auth!.actor, 'publication.resolved', { type: 'post', id: cur.post_id, label: cur.title }, { auftrag: id, website: cur.site_name, ergebnis: label, hinweis: b.note }, 'ok', db);
      return cur;
    });
    return { ok: true, post_id: p.post_id };
  });

  /** Nach bestätigtem Fehler erneut beauftragen (nur dieser Kanal). */
  app.post('/publications/:id/retry', { preHandler: requireAuth('publish.website') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await one<any>(
      `UPDATE publications pb SET status = 'queued', error = NULL, fetched_at = NULL, run_at = GREATEST(run_at, now())
        WHERE id = $1 AND status = 'failed' AND (action <> 'publish' OR ${approvalStillValid('pb')}) RETURNING *`,
      [id],
    );
    if (!p && (await one(`SELECT 1 FROM publications WHERE id = $1 AND status = 'failed' AND action = 'publish'`, [id]))) {
      throw new AppError(409, 'not_approved', 'Die Freigabe gilt nicht mehr (widerrufen oder neuere Fassung). Bitte die aktuelle Fassung freigeben und neu veröffentlichen.');
    }
    if (!p) throw badRequest('Nur fehlgeschlagene Aufträge können erneut gestartet werden. Bei „Ergebnis unbekannt“ prüft die Bridge zuerst die Website.');
    await audit(req.auth!.actor, 'publication.retried', { type: 'post', id: p.post_id }, { auftrag: id });
    return { ok: true };
  });

  /** „Fotos sammeln“: verknüpfte Sammlung samt Upload-Link in einem Schritt. */
  app.post('/posts/:id/collect', { preHandler: requireAuth('media.collections') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ days: z.number().int().min(1).max(3650).optional() }).parse(req.body ?? {});
    // Die Sammlung entsteht samt Upload-Link
    if (!req.auth!.permissions.has('media.links')) throw forbidden('Zum Erstellen des Upload-Links fehlt das Recht „Upload-Links verwalten“.');
    const post = await one<any>('SELECT p.id, r.title FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision WHERE p.id = $1', [id]);
    if (!post) throw notFound();
    const userId = req.auth!.user?.id ?? null;
    // Mehrfaches Klicken legt keine zweite Sammlung an: vorhandene, nicht archivierte Sammlung mit gültigem Link verwenden
    const existing = await one<any>(
      `SELECT c.id AS cid, l.id, l.token_enc, l.expires_at FROM collections c JOIN upload_links l ON l.collection_id = c.id
        WHERE c.post_id = $1 AND c.archived_at IS NULL AND l.revoked_at IS NULL AND l.paused_at IS NULL AND l.expires_at > now() AND l.upload_count < l.max_files
          AND l.token_enc IS NOT NULL
        ORDER BY l.created_at DESC LIMIT 1`,
      [id],
    );
    if (existing) return { collectionId: existing.cid, linkId: existing.id, url: await uploadLinkUrl(req, existing.token_enc, existing.id), expires_at: existing.expires_at, reused: true };
    const { c, l } = await tx(async (db) => {
      const c = await createCollection(req.auth!.actor, userId, { title: post.title, purpose: 'Fotos und Videos für den Beitrag', postId: id }, db);
      const l = await createUploadLink(req.auth!.actor, userId, c.id, { days: body.days, label: 'Beitrag' }, db);
      return { c, l };
    });
    return { collectionId: c.id, linkId: l.id, url: await freshLinkUrl(req, l._token), expires_at: l.expires_at };
  });
}
