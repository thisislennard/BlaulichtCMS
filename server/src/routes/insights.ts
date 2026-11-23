import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { notFound } from '../lib/errors.js';
import { SOCIAL_KINDS } from '../connections/channels.js';
import { interactions, METRIC_KEYS, type Metrics } from '../connections/insights.js';
import { itemTitle } from './social-page.js';

/** Summen je Kennzahl (null, wenn kein Beitrag den Wert liefert). */
function sum(list: (Metrics | null | undefined)[]): Metrics {
  const out: Metrics = {};
  for (const k of METRIC_KEYS) {
    const vals = list.map((m) => m?.[k]).filter((v): v is number => typeof v === 'number');
    if (vals.length) out[k] = vals.reduce((a, b) => a + b, 0);
  }
  return out;
}

/**
 * Reichweite (#218): Übersicht über einen Zeitraum (nach Veröffentlichung), je Netzwerk und Top-Beiträge, sowie die
 * Zahlen eines Beitrags. Nur zusammengefasste Zahlen – keine Personen. Recht: „Reichweite ansehen“.
 */
export async function insightsOverview(days: number, kind: string | null, limit = 10, source: 'blaulichtcms' | 'all' = 'blaulichtcms') {
  const rows = await many<any>(
    `SELECT sp.id, sp.post_id, sp.insights, sp.insights_at, sp.insights_stage, sp.insights_error, sp.published_at, sp.remote_url,
            c.kind, CASE WHEN c.deleted_at IS NOT NULL THEN 'Verbindung gelöscht' ELSE c.name END AS connection_name, p.title
       FROM social_publications sp JOIN connections c ON c.id = sp.connection_id JOIN posts p ON p.id = sp.post_id
      WHERE sp.status = 'published' AND sp.format = 'feed' AND sp.shared_at IS NULL AND sp.published_at >= now() - make_interval(days => $1)
        AND ($2::text IS NULL OR c.kind = $2)
      ORDER BY sp.published_at DESC LIMIT 2000`,
    [days, kind],
  );
  // „Alle Seitenbeiträge“: dazu die direkt auf der Plattform erstellten Beiträge aus dem Seitenabgleich (Beiträge aus
  // BlaulichtCMS sind dort mit ihrer Veröffentlichung verknüpft und werden nicht doppelt gezählt)
  if (source === 'all') {
    const page = await many<any>(
      `SELECT p.id, p.message, p.metrics, p.metrics_at, p.metrics_error, p.posted_at, p.permalink, c.kind, c.name AS connection_name
         FROM social_page_posts p JOIN connections c ON c.id = p.connection_id
        WHERE p.publication_id IS NULL AND p.removed_at IS NULL AND c.deleted_at IS NULL AND p.posted_at >= now() - make_interval(days => $1)
          AND ($2::text IS NULL OR c.kind = $2)
        ORDER BY p.posted_at DESC LIMIT 2000`,
      [days, kind],
    );
    for (const p of page)
      rows.push({ id: p.id, post_id: null, page_post_id: p.id, insights: p.metrics, insights_at: p.metrics_at, insights_stage: null, insights_error: p.metrics_error, published_at: p.posted_at, remote_url: p.permalink, kind: p.kind, connection_name: p.connection_name, title: itemTitle({ message: p.message ?? '', kind: p.kind }) });
  }
  const withData = rows.filter((r) => r.insights);
  const channels = SOCIAL_KINDS.map((k) => {
    const list = rows.filter((r) => r.kind === k);
    const data = list.filter((r) => r.insights);
    return { kind: k, publications: list.length, measured: data.length, totals: sum(data.map((r) => r.insights)), interactions: data.reduce((a, r) => a + interactions(r.insights), 0) };
  }).filter((c) => c.publications > 0);
  // Top-Beiträge: Interaktionen über alle Netzwerke eines Beitrags zusammen
  const byPost = new Map<string, { post_id: string | null; page_post_id?: string; title: string; channels: { kind: string; name: string; url: string | null; insights: Metrics | null }[]; interactions: number; views: number | null; published_at: string }>();
  for (const r of rows) {
    const key = r.post_id ?? `page:${r.page_post_id}`;
    const e = byPost.get(key) ?? { post_id: r.post_id, page_post_id: r.page_post_id, title: r.title, channels: [] as { kind: string; name: string; url: string | null; insights: Metrics | null }[], interactions: 0, views: null as number | null, published_at: r.published_at };
    e.channels.push({ kind: r.kind, name: r.connection_name, url: r.remote_url, insights: r.insights });
    e.interactions += interactions(r.insights);
    if (typeof r.insights?.views === 'number') e.views = (e.views ?? 0) + r.insights.views;
    if (r.published_at < e.published_at) e.published_at = r.published_at;
    byPost.set(key, e);
  }
  const top = [...byPost.values()].filter((p) => p.channels.some((c) => c.insights)).sort((a, b) => b.interactions - a.interactions || (b.views ?? 0) - (a.views ?? 0)).slice(0, limit);
  return {
    days,
    publications: rows.length,
    measured: withData.length,
    pending: rows.filter((r) => !r.insights && !r.insights_error).length,
    errors: rows.filter((r) => r.insights_error).length,
    totals: sum(withData.map((r) => r.insights)),
    interactions: withData.reduce((a, r) => a + interactions(r.insights), 0),
    channels,
    top,
  };
}

export async function insightRoutes(app: FastifyInstance) {
  app.get('/insights', { preHandler: requireAuth('insights.view') }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), kind: z.enum(SOCIAL_KINDS as [string, ...string[]]).optional(), source: z.enum(['blaulichtcms', 'all']).default('blaulichtcms') }).parse(req.query ?? {});
    return insightsOverview(q.days, q.kind ?? null, 20, q.source);
  });

  /** Zahlen je Netzwerk eines Beitrags samt Verlauf (nach 1 h, 24 h, 7 Tagen). */
  app.get('/posts/:id/insights', { preHandler: requireAuth('insights.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await one(`SELECT 1 FROM posts WHERE id = $1`, [id]))) throw notFound();
    const items = await many<any>(
      `SELECT sp.id, sp.format, sp.status, sp.shared_at, sp.published_at, sp.remote_url, sp.insights, sp.insights_at, sp.insights_stage, sp.insights_error, c.kind,
              CASE WHEN c.deleted_at IS NOT NULL THEN 'Verbindung gelöscht' ELSE c.name END AS connection_name,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('stage', si.stage, 'fetched_at', si.fetched_at, 'metrics', si.metrics) ORDER BY si.fetched_at) FROM social_insights si WHERE si.publication_id = sp.id), '[]') AS history
         FROM social_publications sp JOIN connections c ON c.id = sp.connection_id
        WHERE sp.post_id = $1 AND sp.status = 'published' ORDER BY sp.published_at`,
      [id],
    );
    return { items: items.map((i) => ({ ...i, interactions: interactions(i.insights) })) };
  });
}
