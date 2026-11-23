import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { publicBase } from '../lib/urls.js';
import { log } from '../lib/log.js';
import { interactions, type Metrics } from '../connections/insights.js';
import { PAGE_SYNC_KINDS, pageSyncEnabled, runPageSync, socialImageDir } from '../connections/page-sync.js';

/**
 * Seitenstatistik und Social-Feed. Die Daten liefert der Seitenabgleich (connections/page-sync.ts).
 *  - Seitenstatistik: Kennzahlen je Tag und Top-Beiträge je Facebook-Seite bzw. Instagram-Konto („Reichweite ansehen“).
 *  - Social-Feed: freigegebene Seitenbeiträge als RSS (geheime Adresse) und für das Website-Widget der Bridge
 *    („Social-Feed verwalten“). Bilder werden aus dem lokalen Speicher ausgeliefert, nie von Meta nachgeladen.
 */

const IMAGE_RE = /^[0-9a-f-]{36}\.webp$/;
const TOKEN_RE = /^bsf_[A-Za-z0-9_-]{40,}$/;

export interface FeedItem {
  id: string;
  kind: string;
  connection: string;
  posted_at: string;
  message: string;
  permalink: string | null;
  image: { file: string; width: number | null; height: number | null } | null;
}

/** Einstellungen des Social-Feeds. */
export async function feedConfig() {
  return (await one<any>(`SELECT * FROM social_feed_config WHERE id = 1`)) ?? { enabled: false, connection_ids: [], max_items: 12, rss_token_hash: null };
}

/** Freigegebene Beiträge für RSS und Website (neueste zuerst). Leer, wenn der Feed ausgeschaltet ist. */
export async function feedItems(limit?: number): Promise<FeedItem[]> {
  const cfg = await feedConfig();
  if (!cfg.enabled || !cfg.connection_ids?.length) return [];
  const rows = await many<any>(
    `SELECT p.id, p.kind, c.name AS connection, p.posted_at, p.message, p.permalink, p.image_file, p.image_width, p.image_height
       FROM social_page_posts p JOIN connections c ON c.id = p.connection_id
      WHERE p.connection_id = ANY($1) AND c.deleted_at IS NULL AND p.removed_at IS NULL AND NOT p.hidden
      ORDER BY p.posted_at DESC LIMIT $2`,
    [cfg.connection_ids, Math.min(limit ?? cfg.max_items, 50)],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    connection: r.connection,
    posted_at: new Date(r.posted_at).toISOString(),
    message: r.message,
    permalink: r.permalink,
    image: r.image_file ? { file: r.image_file, width: r.image_width, height: r.image_height } : null,
  }));
}

/** Stand des Feeds als Prüfsumme: Die Bridge holt den Feed nur, wenn er sich geändert hat. */
export function feedRevision(items: FeedItem[]): string {
  return sha256Hex(JSON.stringify(items.map((i) => [i.id, i.posted_at, i.message, i.permalink, i.image?.file ?? null, i.connection]))).slice(0, 32);
}

const xml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const html = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const NET_LABEL: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram' };

/** Titel eines Feed-Eintrags: erste Zeile des Textes (gekürzt), sonst „Beitrag auf …“. */
export function itemTitle(i: Pick<FeedItem, 'message' | 'kind'>): string {
  const line = i.message.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!line) return `Beitrag auf ${NET_LABEL[i.kind] ?? i.kind}`;
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}

/** RSS 2.0 aus den freigegebenen Beiträgen. `imageUrl` baut die öffentliche Bildadresse. */
export function buildRss(title: string, siteUrl: string, selfUrl: string, items: FeedItem[], imageUrl: (file: string) => string): string {
  const parts = items.map((i) => {
    const img = i.image ? imageUrl(i.image.file) : null;
    const body = `${i.message ? `<p>${html(i.message).replace(/\n/g, '<br>')}</p>` : ''}${img ? `<p><img src="${html(img)}" alt=""${i.image?.width ? ` width="${i.image.width}" height="${i.image.height}"` : ''}></p>` : ''}`;
    return [
      '<item>',
      `<title>${xml(itemTitle(i))}</title>`,
      i.permalink ? `<link>${xml(i.permalink)}</link>` : '',
      `<guid isPermaLink="false">${xml(i.id)}</guid>`,
      `<pubDate>${new Date(i.posted_at).toUTCString()}</pubDate>`,
      `<category>${xml(NET_LABEL[i.kind] ?? i.kind)}</category>`,
      `<description>${xml(body)}</description>`,
      img ? `<enclosure url="${xml(img)}" type="image/webp" length="0"/>` : '',
      '</item>',
    ]
      .filter(Boolean)
      .join('');
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(title)}</title><link>${xml(siteUrl)}</link><description>${xml('Beiträge aus den sozialen Netzwerken')}</description><language>de</language><atom:link href="${xml(selfUrl)}" rel="self" type="application/rss+xml"/>${parts.join('')}</channel></rss>\n`;
}

/**
 * Bilddatei aus dem lokalen Speicher ausliefern (nur bekannte Dateinamen eines vorhandenen Beitrags). `publicFeed`: nur
 * Bilder freigegebener Feed-Beiträge, öffentlich zwischenspeicherbar und von fremden Seiten ladbar (RSS-Leser im Browser).
 */
export async function sendSocialImage(reply: FastifyReply, file: string, publicFeed: boolean) {
  if (!IMAGE_RE.test(file)) throw notFound();
  const row = publicFeed ? (await feedItems(50)).find((i) => i.image?.file === file) : await one(`SELECT 1 FROM social_page_posts WHERE image_file = $1`, [file]);
  if (!row) throw notFound('Bild nicht vorhanden.');
  const full = path.join(socialImageDir(), file);
  const st = await fs.promises.stat(full).catch(() => null);
  if (!st?.isFile()) throw notFound('Bild nicht vorhanden.');
  reply.header('content-type', 'image/webp').header('content-length', st.size).header('x-content-type-options', 'nosniff');
  reply.header('cache-control', publicFeed ? 'public, max-age=86400' : 'private, max-age=31536000, immutable');
  if (publicFeed) reply.header('cross-origin-resource-policy', 'cross-origin');
  return reply.send(fs.createReadStream(full));
}

/** Seitenstatistik je Verbindung: Tageswerte im Zeitraum, aktueller Stand, Summen und Top-Beiträge. */
export async function pagesOverview(days: number) {
  const conns = await many<any>(
    `SELECT c.id, c.kind, c.name, c.status, c.config, s.posts_at, s.stats_day, s.ok, s.message, s.at
       FROM connections c LEFT JOIN social_page_sync s ON s.connection_id = c.id
      WHERE c.kind = ANY($1) AND c.deleted_at IS NULL ORDER BY c.kind, c.name`,
    [PAGE_SYNC_KINDS],
  );
  const out = [];
  for (const c of conns) {
    const series = await many<any>(
      `SELECT day::text AS day, metrics FROM social_page_stats WHERE connection_id = $1 AND day >= (current_date - $2::int) ORDER BY day`,
      [c.id, days],
    );
    const latest = await one<any>(`SELECT day::text AS day, metrics FROM social_page_stats WHERE connection_id = $1 AND metrics ? 'followers' ORDER BY day DESC LIMIT 1`, [c.id]);
    const first = series.find((s) => typeof s.metrics?.followers === 'number');
    const totals: Record<string, number> = {};
    for (const s of series) for (const [k, v] of Object.entries(s.metrics ?? {})) if (!['followers', 'fans', 'posts'].includes(k) && typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
    const posts = await many<any>(
      `SELECT p.id, p.posted_at, p.message, p.permalink, p.image_file, p.media_type, p.publication_id, p.hidden,
              COALESCE(sp.insights, p.metrics) AS metrics, sp.post_id
         FROM social_page_posts p LEFT JOIN social_publications sp ON sp.id = p.publication_id
        WHERE p.connection_id = $1 AND p.removed_at IS NULL AND p.posted_at >= now() - make_interval(days => $2)
        ORDER BY p.posted_at DESC LIMIT 500`,
      [c.id, days],
    );
    const ranked = posts
      .map((p) => ({ ...p, interactions: interactions(p.metrics as Metrics), views: typeof p.metrics?.views === 'number' ? p.metrics.views : null }))
      .sort((a, b) => b.interactions - a.interactions || (b.views ?? 0) - (a.views ?? 0));
    out.push({
      id: c.id,
      kind: c.kind,
      name: c.name,
      active: c.status === 'active',
      enabled: pageSyncEnabled(c),
      sync: c.at ? { posts_at: c.posts_at, stats_day: c.stats_day, ok: c.ok, message: c.message, at: c.at } : null,
      current: latest?.metrics ?? {},
      current_day: latest?.day ?? null,
      follower_change: typeof latest?.metrics?.followers === 'number' && first ? latest.metrics.followers - first.metrics.followers : null,
      series,
      totals,
      posts: posts.length,
      from_blaulichtcms: posts.filter((p) => p.publication_id).length,
      interactions: ranked.reduce((a, p) => a + p.interactions, 0),
      top: ranked.slice(0, 10).map((p) => ({ id: p.id, posted_at: p.posted_at, message: p.message.slice(0, 300), permalink: p.permalink, image: p.image_file, post_id: p.post_id, metrics: p.metrics, interactions: p.interactions })),
    });
  }
  return { days, connections: out };
}

let manualSync: Promise<unknown> | null = null;

export async function socialPageRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- Seitenstatistik */

  app.get('/insights/pages', { preHandler: requireAuth('insights.view') }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).parse(req.query ?? {});
    return pagesOverview(q.days);
  });

  /** Abgleich sofort anstoßen (läuft im Hintergrund; ein laufender Abgleich wird nicht verdoppelt). */
  app.post('/insights/pages/sync', { preHandler: requireAuth('insights.feed'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    if (!manualSync) {
      manualSync = runPageSync()
        .catch((e) => log('warn', 'page-sync', e.message))
        .finally(() => (manualSync = null));
      await audit(req.auth!.actor, 'social_page.sync_started', { type: 'social_page' });
    }
    return { ok: true };
  });

  /** Vorschaubild für die Oberfläche. */
  app.get('/social-images/:file', { preHandler: requireAuth('insights.view') }, async (req, reply) => {
    const { file } = z.object({ file: z.string().max(60) }).parse(req.params);
    return sendSocialImage(reply, file, false);
  });

  /* ---------------------------------------------------------------- Social-Feed */

  app.get('/social-feed', { preHandler: requireAuth('insights.feed') }, async () => {
    const cfg = await feedConfig();
    const conns = await many<any>(`SELECT id, kind, name, status, config FROM connections WHERE kind = ANY($1) AND deleted_at IS NULL ORDER BY kind, name`, [PAGE_SYNC_KINDS]);
    const posts = await many<any>(
      `SELECT p.id, p.connection_id, p.kind, p.posted_at, p.message, p.permalink, p.image_file, p.hidden, p.publication_id
         FROM social_page_posts p JOIN connections c ON c.id = p.connection_id
        WHERE c.deleted_at IS NULL AND p.removed_at IS NULL ORDER BY p.posted_at DESC LIMIT 60`,
    );
    return {
      enabled: cfg.enabled,
      connection_ids: cfg.connection_ids ?? [],
      max_items: cfg.max_items,
      rss: { active: !!cfg.rss_token_hash, created_at: cfg.rss_created_at ?? null, used_at: cfg.rss_used_at ?? null },
      connections: conns.map((c) => ({ id: c.id, kind: c.kind, name: c.name, active: c.status === 'active', sync: pageSyncEnabled(c) })),
      posts: posts.map((p) => ({ ...p, message: p.message.slice(0, 400) })),
      visible: (await feedItems()).map((i) => i.id),
    };
  });

  app.put('/social-feed', { preHandler: requireAuth('insights.feed') }, async (req) => {
    const b = z.object({ enabled: z.boolean(), connection_ids: z.array(z.uuid()).max(20), max_items: z.number().int().min(1).max(50) }).parse(req.body);
    const known = await many<{ id: string }>(`SELECT id FROM connections WHERE id = ANY($1) AND kind = ANY($2) AND deleted_at IS NULL`, [b.connection_ids, PAGE_SYNC_KINDS]);
    if (known.length !== new Set(b.connection_ids).size) throw badRequest('Unbekannte Verbindung gewählt.');
    await pool.query(`UPDATE social_feed_config SET enabled = $1, connection_ids = $2, max_items = $3, updated_at = now() WHERE id = 1`, [b.enabled, [...new Set(b.connection_ids)], b.max_items]);
    await audit(req.auth!.actor, 'social_feed.updated', { type: 'social_feed' }, { an: b.enabled, verbindungen: b.connection_ids.length, anzahl: b.max_items });
    return { ok: true };
  });

  /** Beitrag im Feed aus- oder wieder einblenden. */
  app.put('/social-feed/posts/:id', { preHandler: requireAuth('insights.feed') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ hidden: z.boolean() }).parse(req.body);
    const r = await one<any>(`UPDATE social_page_posts SET hidden = $2 WHERE id = $1 RETURNING id, left(message, 80) AS label`, [id, b.hidden]);
    if (!r) throw notFound();
    await audit(req.auth!.actor, b.hidden ? 'social_feed.post_hidden' : 'social_feed.post_shown', { type: 'social_page_post', id, label: r.label || null });
    return { ok: true };
  });

  /** RSS-Adresse erzeugen oder erneuern (die bisherige gilt danach nicht mehr). Die Adresse wird nur einmal angezeigt. */
  app.post('/social-feed/rss', { preHandler: requireAuth('insights.feed') }, async (req) => {
    const token = `bsf_${randomToken(32)}`;
    const before = await feedConfig();
    await pool.query(`UPDATE social_feed_config SET rss_token_hash = $1, rss_created_at = now(), rss_used_at = NULL, updated_at = now() WHERE id = 1`, [sha256Hex(token)]);
    await audit(req.auth!.actor, before.rss_token_hash ? 'social_feed.rss_renewed' : 'social_feed.rss_created', { type: 'social_feed' });
    return { url: `${await publicBase(req)}/api/v1/public/social/${token}.rss` };
  });

  app.delete('/social-feed/rss', { preHandler: requireAuth('insights.feed') }, async (req) => {
    const r = await pool.query(`UPDATE social_feed_config SET rss_token_hash = NULL, rss_created_at = NULL, rss_used_at = NULL, updated_at = now() WHERE id = 1 AND rss_token_hash IS NOT NULL`);
    if (r.rowCount) await audit(req.auth!.actor, 'social_feed.rss_revoked', { type: 'social_feed' });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- Öffentlich (geheime Adresse) */

  async function rssAllowed(token: string): Promise<boolean> {
    if (!TOKEN_RE.test(token)) return false;
    const cfg = await feedConfig();
    return !!cfg.enabled && !!cfg.rss_token_hash && safeEqual(cfg.rss_token_hash, sha256Hex(token));
  }
  const gone = (reply: FastifyReply) => reply.header('cache-control', 'no-store').status(404).send({ error: 'not_found', message: 'Diesen Feed gibt es nicht (mehr).' });

  app.get('/public/social/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(200) }).parse(req.params);
    const raw = token.replace(/\.rss$/i, '');
    if (!(await rssAllowed(raw))) return gone(reply);
    await pool.query(`UPDATE social_feed_config SET rss_used_at = now() WHERE id = 1 AND (rss_used_at IS NULL OR rss_used_at < now() - interval '1 hour')`);
    const s = await getSettings();
    const base = await publicBase(req);
    const name = String(s['general.organization'] || s['general.instance_name'] || 'BlaulichtCMS');
    const items = await feedItems();
    const body = buildRss(`${name} – Social-Feed`, base, `${base}/api/v1/public/social/${raw}.rss`, items, (file) => `${base}/api/v1/public/social/${raw}/images/${file}`);
    return reply.header('content-type', 'application/rss+xml; charset=utf-8').header('cache-control', 'public, max-age=600').header('x-robots-tag', 'noindex').send(body);
  });

  app.get('/public/social/:token/images/:file', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token, file } = z.object({ token: z.string().max(200), file: z.string().max(60) }).parse(req.params);
    if (!(await rssAllowed(token))) return gone(reply);
    return sendSocialImage(reply, file, true);
  });
}
