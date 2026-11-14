import { many, one, pool, type Queryable } from '../db/pool.js';
import { loadRuntimeConnection, markConnectionUsed } from '../engine/connections.js';
import { enqueue } from '../engine/queue.js';
import { wpRequest } from '../connectors/wordpress.js';
import { toStepError } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { log } from '../lib/log.js';

export type BannerView = 'entwurf' | 'geplant' | 'aktiv' | 'abgelaufen' | 'deaktiviert';

export interface BannerRow {
  id: string;
  connection_id: string;
  revision: number;
  title: string;
  text: string;
  label: string;
  color: string;
  priority: string;
  starts_at: Date | null;
  ends_at: Date | null;
  pages: string[];
  link_url: string | null;
  link_text: string | null;
  state: 'draft' | 'published' | 'deactivated';
  source: string;
  source_label: string;
  sync_status: string;
  sync_error: string | null;
  synced_revision: number | null;
  last_synced_at: Date | null;
}

export function bannerView(b: Pick<BannerRow, 'state' | 'starts_at' | 'ends_at'>, now = Date.now()): BannerView {
  if (b.state === 'draft') return 'entwurf';
  if (b.state === 'deactivated') return 'deaktiviert';
  if (b.ends_at && new Date(b.ends_at).getTime() <= now) return 'abgelaufen';
  if (b.starts_at && new Date(b.starts_at).getTime() > now) return 'geplant';
  return 'aktiv';
}

function payload(b: BannerRow) {
  return {
    revision: b.revision,
    title: b.title.slice(0, 120),
    text: b.text.slice(0, 600),
    color: b.color,
    label: b.label.slice(0, 30),
    priority: b.priority,
    starts_at: (b.starts_at ?? new Date()).toISOString(),
    ends_at: b.ends_at ? b.ends_at.toISOString() : null,
    pages: b.pages,
    link_url: b.link_url || null,
    link_text: b.link_text || null,
  };
}

/**
 * Überträgt den aktuellen Stand eines Banners an WordPress (Upsert bzw. Deaktivierung).
 * Bei Fehlern bleibt der Status „ausstehend“ und ein Job versucht es erneut.
 */
export async function syncBanner(id: string, opts: { throwOnError?: boolean } = {}): Promise<boolean> {
  const b = await one<BannerRow>('SELECT * FROM banners WHERE id = $1', [id]);
  if (!b || b.state === 'draft') return true;
  try {
    const conn = await loadRuntimeConnection(b.connection_id);
    if (!conn) throw new Error('Verbindung fehlt.');
    if (b.state === 'deactivated') await wpRequest(conn, 'DELETE', `/banners/${b.id}`);
    else await wpRequest(conn, 'PUT', `/banners/${b.id}`, payload(b));
    await pool.query(`UPDATE banners SET sync_status = 'synced', sync_error = NULL, synced_revision = $2, last_synced_at = now() WHERE id = $1 AND revision = $2`, [b.id, b.revision]);
    await markConnectionUsed(b.connection_id, true);
    return true;
  } catch (e) {
    const err = toStepError(e);
    await pool.query(`UPDATE banners SET sync_status = 'error', sync_error = $2 WHERE id = $1`, [b.id, err.message.slice(0, 500)]);
    await markConnectionUsed(b.connection_id, false, err.message);
    await enqueue('banner.sync', { bannerId: b.id }, { dedupKey: `banner.sync:${b.id}`, maxAttempts: 12, runAt: new Date(Date.now() + 30_000) });
    log('warn', 'wordpress', `Banner-Synchronisation fehlgeschlagen: ${err.message}`, { banner: b.id });
    if (opts.throwOnError) throw err;
    return false;
  }
}

export async function bumpAndSync(id: string, db: Queryable = pool) {
  await db.query(`UPDATE banners SET revision = revision + 1, sync_status = CASE WHEN state = 'draft' THEN 'none' ELSE 'pending' END, updated_at = now() WHERE id = $1`, [id]);
}

/** Wird vom Node „WordPress-Banner“ aufgerufen. */
export async function upsertWorkflowBanner(input: {
  connectionId: string;
  sourceKey: string;
  runId: number;
  workflowName: string;
  title: string;
  text: string;
  label: string;
  color: string;
  priority: string;
  durationMinutes: number;
  pages: string[];
  linkUrl: string | null;
  linkText: string | null;
  requireApproval: boolean;
}) {
  const now = new Date();
  const ends = input.durationMinutes > 0 ? new Date(now.getTime() + input.durationMinutes * 60_000) : null;
  const existing = await one<BannerRow>('SELECT * FROM banners WHERE connection_id = $1 AND source_key = $2', [input.connectionId, input.sourceKey]);
  const state = input.requireApproval ? (existing?.state === 'published' ? 'published' : 'draft') : 'published';
  let id: string;
  if (existing) {
    await pool.query(
      `UPDATE banners SET title=$2, text=$3, label=$4, color=$5, priority=$6, ends_at=$7, pages=$8, link_url=$9, link_text=$10,
              state = CASE WHEN state = 'deactivated' THEN $11 ELSE $11 END, source_run_id=$12, revision = revision + 1,
              sync_status = CASE WHEN $11 = 'draft' THEN 'none' ELSE 'pending' END, updated_at = now()
        WHERE id = $1`,
      [existing.id, input.title, input.text, input.label, input.color, input.priority, ends, input.pages, input.linkUrl, input.linkText, state, input.runId],
    );
    id = existing.id;
  } else {
    const row = await one<{ id: string }>(
      `INSERT INTO banners (connection_id, title, text, label, color, priority, starts_at, ends_at, pages, link_url, link_text, state, source, source_run_id, source_label, source_key, sync_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'workflow',$13,$14,$15, CASE WHEN $12 = 'draft' THEN 'none' ELSE 'pending' END) RETURNING id`,
      [input.connectionId, input.title, input.text, input.label, input.color, input.priority, now, ends, input.pages, input.linkUrl, input.linkText, state, input.runId, `Workflow: ${input.workflowName}`, input.sourceKey],
    );
    id = row!.id;
  }
  if (state === 'draft') {
    await notify({ kind: 'info', title: 'Banner wartet auf Freigabe', body: input.title, link: `/wordpress?banner=${id}`, permission: 'wordpress.publish' });
    return { banner_id: id, state: 'entwurf', ends_at: ends?.toISOString() ?? null, synced: false };
  }
  const synced = await syncBanner(id, { throwOnError: true });
  return { banner_id: id, state: 'veroeffentlicht', ends_at: ends?.toISOString() ?? null, synced };
}

export async function endWorkflowBanner(connectionId: string, sourceKey: string) {
  const b = await one<BannerRow>('SELECT * FROM banners WHERE connection_id = $1 AND source_key = $2', [connectionId, sourceKey]);
  if (!b || b.state === 'deactivated') return { deactivated: false };
  await pool.query(`UPDATE banners SET state = 'deactivated', revision = revision + 1, sync_status = 'pending', updated_at = now() WHERE id = $1`, [b.id]);
  if (b.state === 'published') await syncBanner(b.id, { throwOnError: true });
  return { deactivated: true, banner_id: b.id };
}

/** Anstehende Banner-Enden für das Dashboard. */
export async function upcomingBannerEnds(limit = 5) {
  return many<{ id: string; title: string; ends_at: Date; color: string }>(
    `SELECT id, title, ends_at, color FROM banners WHERE state = 'published' AND ends_at > now() ORDER BY ends_at LIMIT $1`,
    [limit],
  );
}

/* ----------------------------------- Beiträge -------------------------------------- */

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export async function sendPost(id: string) {
  const p = await one<any>('SELECT * FROM content_posts WHERE id = $1', [id]);
  if (!p) throw new Error('Beitrag nicht gefunden.');
  const conn = await loadRuntimeConnection(p.connection_id);
  if (!conn) throw new Error('Verbindung fehlt.');
  try {
    const res = await wpRequest(conn, 'POST', '/posts', {
      external_id: p.id,
      revision: p.revision,
      title: p.title,
      content: p.content.trim().startsWith('<') ? p.content : paragraphs(p.content),
      excerpt: p.excerpt,
      category: p.category,
      tags: p.tags,
      status: p.wp_status,
      publish_at: p.publish_at ? new Date(p.publish_at).toISOString() : null,
    });
    await pool.query(
      `UPDATE content_posts SET state = 'sent', wp_post_id = $2, wp_edit_url = $3, wp_result_status = $4, sync_status = 'synced', sync_error = NULL, last_synced_at = now() WHERE id = $1`,
      [id, res.post_id ?? null, res.edit_url ?? null, res.status ?? null],
    );
    await markConnectionUsed(p.connection_id, true);
    return res;
  } catch (e) {
    const err = toStepError(e);
    await pool.query(`UPDATE content_posts SET sync_status = 'error', sync_error = $2 WHERE id = $1`, [id, err.message.slice(0, 500)]);
    await markConnectionUsed(p.connection_id, false, err.message);
    throw err;
  }
}

export async function upsertWorkflowPost(input: {
  connectionId: string;
  sourceKey: string;
  runId: number;
  workflowName: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  status: 'draft' | 'pending' | 'future';
  publishAt: Date | null;
}) {
  const existing = await one<{ id: string }>('SELECT id FROM content_posts WHERE connection_id = $1 AND source_key = $2', [input.connectionId, input.sourceKey]);
  let id: string;
  if (existing) {
    await pool.query(
      `UPDATE content_posts SET title=$2, content=$3, category=$4, tags=$5, wp_status=$6, publish_at=$7, revision = revision + 1, source_run_id=$8, updated_at = now() WHERE id = $1`,
      [existing.id, input.title, input.content, input.category, input.tags, input.status, input.publishAt, input.runId],
    );
    id = existing.id;
  } else {
    const row = await one<{ id: string }>(
      `INSERT INTO content_posts (connection_id, title, content, category, tags, wp_status, publish_at, source, source_run_id, source_label, source_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'workflow',$8,$9,$10) RETURNING id`,
      [input.connectionId, input.title, input.content, input.category, input.tags, input.status, input.publishAt, input.runId, `Workflow: ${input.workflowName}`, input.sourceKey],
    );
    id = row!.id;
  }
  const res = await sendPost(id);
  return { post_id: res.post_id, status: res.status, edit_url: res.edit_url };
}
