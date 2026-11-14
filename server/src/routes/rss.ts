import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { httpRequest } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';
import { revisionHash } from './posts.js';

/**
 * RSS- und Atom-Quellen. Abruf nur über den geschützten HTTP-Client (keine internen Adressen,
 * Größen- und Zeitlimit, Redirects geprüft). Private Ziele nur nach ausdrücklicher Freigabe
 * (Einstellung „security.allowed_private_hosts“).
 */
export interface FeedItem {
  key: string;
  title: string;
  link: string | null;
  summary: string;
  published: Date | null;
}
export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  items: FeedItem[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true, isArray: (name) => ['item', 'entry', 'link'].includes(name) });

const text = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in v) return String(v['#text']);
  return '';
};
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const date = (s: string) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

export function parseFeed(xml: string): ParsedFeed {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw badRequest('Die Adresse liefert keinen lesbaren RSS- oder Atom-Feed.');
  }
  if (doc?.rss?.channel || doc?.['rdf:RDF']) {
    const ch = doc.rss?.channel ?? doc['rdf:RDF'].channel;
    const rawItems = doc.rss?.channel?.item ?? doc['rdf:RDF']?.item ?? [];
    return {
      title: stripHtml(text(ch?.title)) || 'Unbenannter Feed',
      siteUrl: text(Array.isArray(ch?.link) ? ch.link.find((l: any) => typeof l === 'string') ?? ch.link[0] : ch?.link) || null,
      items: rawItems.slice(0, 200).map((it: any) => {
        const link = text(Array.isArray(it.link) ? it.link[0] : it.link) || null;
        const guid = text(it.guid) || link || text(it.title);
        return { key: crypto.createHash('sha256').update(guid).digest('hex'), title: stripHtml(text(it.title)) || '(ohne Titel)', link, summary: stripHtml(text(it.description) || text(it['content:encoded'])).slice(0, 600), published: date(text(it.pubDate) || text(it['dc:date'])) };
      }),
    };
  }
  if (doc?.feed) {
    const f = doc.feed;
    const linkOf = (links: any[]) => {
      const l = (links ?? []).find((x: any) => !x['@rel'] || x['@rel'] === 'alternate') ?? (links ?? [])[0];
      return l ? l['@href'] ?? text(l) : null;
    };
    return {
      title: stripHtml(text(f.title)) || 'Unbenannter Feed',
      siteUrl: linkOf(f.link),
      items: (f.entry ?? []).slice(0, 200).map((e: any) => {
        const link = linkOf(e.link);
        const id = text(e.id) || link || text(e.title);
        return { key: crypto.createHash('sha256').update(id).digest('hex'), title: stripHtml(text(e.title)) || '(ohne Titel)', link, summary: stripHtml(text(e.summary) || text(e.content)).slice(0, 600), published: date(text(e.published) || text(e.updated)) };
      }),
    };
  }
  throw badRequest('Die Adresse liefert keinen RSS- oder Atom-Feed.');
}

async function fetchFeed(url: string, cache: { etag?: string | null; lastModified?: string | null } = {}) {
  const s = await getSettings();
  const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8', 'user-agent': 'LifeLink-Feedreader/1.0' };
  if (cache.etag) headers['if-none-match'] = cache.etag;
  if (cache.lastModified) headers['if-modified-since'] = cache.lastModified;
  const res = await httpRequest({ method: 'GET', url, headers, timeoutMs: 15_000, maxResponseBytes: 3 * 1024 * 1024, maxRedirects: 3, allowPrivateHosts: (s as any)['security.allowed_private_hosts'] ?? [] });
  if (res.status === 304) return { notModified: true as const };
  if (res.status >= 400) throw new AppError(502, 'feed_http', `Die Quelle antwortet mit HTTP ${res.status}.`);
  return { notModified: false as const, feed: parseFeed(res.text()), etag: res.headers['etag'] ?? null, lastModified: res.headers['last-modified'] ?? null };
}

async function storeItems(feedId: string, items: FeedItem[]) {
  let added = 0;
  for (const it of items) {
    const r = await pool.query(
      `INSERT INTO rss_items (feed_id, dedup_key, title, link, summary, published_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (feed_id, dedup_key) DO NOTHING`,
      [feedId, it.key, it.title.slice(0, 300), it.link?.slice(0, 1000) ?? null, it.summary, it.published],
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

/** Fälliger Abruf aller aktiven Quellen (vom Worker aufgerufen). */
export async function refreshDueFeeds() {
  const feeds = await many<any>(`SELECT * FROM rss_feeds WHERE active AND (last_fetch_at IS NULL OR last_fetch_at < now() - make_interval(mins => interval_min)) ORDER BY last_fetch_at NULLS FIRST LIMIT 20`);
  for (const f of feeds) await refreshFeed(f).catch(() => {});
}

export async function refreshFeed(f: any) {
  await pool.query('UPDATE rss_feeds SET last_fetch_at = now() WHERE id = $1', [f.id]);
  try {
    const r = await fetchFeed(f.url, { etag: f.etag, lastModified: f.last_modified });
    if (!r.notModified) {
      await storeItems(f.id, r.feed.items);
      await pool.query('UPDATE rss_feeds SET etag = $2, last_modified = $3 WHERE id = $1', [f.id, r.etag, r.lastModified]);
    }
    await pool.query('UPDATE rss_feeds SET last_success_at = now(), last_error = NULL WHERE id = $1', [f.id]);
  } catch (e) {
    await pool.query('UPDATE rss_feeds SET last_error = $2 WHERE id = $1', [f.id, (e as Error).message.slice(0, 300)]);
    log('warn', 'rss', `Feed ${f.title}: ${(e as Error).message}`);
    throw e;
  }
}

export async function rssRoutes(app: FastifyInstance) {
  app.post('/rss/preview', { preHandler: requireAuth('post.edit'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { url } = z.object({ url: z.url().max(1000) }).parse(req.body);
    const r = await fetchFeed(url);
    if (r.notModified) throw badRequest('Keine Daten.');
    return { title: r.feed.title, siteUrl: r.feed.siteUrl, count: r.feed.items.length, items: r.feed.items.slice(0, 5).map((i) => ({ title: i.title, link: i.link, published: i.published, summary: i.summary.slice(0, 200) })) };
  });

  app.get('/rss/feeds', { preHandler: requireAuth('post.read') }, async () =>
    many<any>(`SELECT f.*, (SELECT count(*)::int FROM rss_items i WHERE i.feed_id = f.id) AS item_count FROM rss_feeds f ORDER BY f.title`),
  );

  app.post('/rss/feeds', { preHandler: requireAuth('post.edit') }, async (req) => {
    const b = z.object({ url: z.url().max(1000), title: z.string().trim().max(200).optional(), intervalMin: z.number().int().min(5).max(1440).default(30) }).parse(req.body);
    if (await one('SELECT 1 FROM rss_feeds WHERE url = $1', [b.url])) throw new AppError(409, 'feed_exists', 'Diese Quelle ist bereits eingetragen.');
    const r = await fetchFeed(b.url);
    if (r.notModified) throw badRequest('Keine Daten.');
    const f = await one<any>(
      `INSERT INTO rss_feeds (url, title, site_url, interval_min, etag, last_modified, last_fetch_at, last_success_at, created_by) VALUES ($1,$2,$3,$4,$5,$6, now(), now(), $7) RETURNING *`,
      [b.url, b.title || r.feed.title, r.feed.siteUrl, b.intervalMin, r.etag, r.lastModified, req.auth!.user?.id ?? null],
    );
    const added = await storeItems(f.id, r.feed.items);
    await audit(req.auth!.actor, 'rss.feed_added', { type: 'rss_feed', id: f.id, label: f.title }, { url: b.url, eintraege: added });
    return { feed: f, added };
  });

  app.post('/rss/feeds/:id/refresh', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const f = await one<any>('SELECT * FROM rss_feeds WHERE id = $1', [id]);
    if (!f) throw notFound();
    await refreshFeed(f);
    return { ok: true };
  });

  app.delete('/rss/feeds/:id', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const f = await one<any>('DELETE FROM rss_feeds WHERE id = $1 RETURNING title', [id]);
    if (!f) throw notFound();
    await audit(req.auth!.actor, 'rss.feed_removed', { type: 'rss_feed', id, label: f.title });
    return { ok: true };
  });

  app.get('/rss/items', { preHandler: requireAuth('post.read') }, async (req) => {
    const q = z.object({ filter: z.enum(['new', 'starred', 'hidden', 'all']).default('new'), feedId: z.uuid().optional(), limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const where = q.filter === 'new' ? 'i.hidden_at IS NULL' : q.filter === 'starred' ? 'i.starred_at IS NOT NULL AND i.hidden_at IS NULL' : q.filter === 'hidden' ? 'i.hidden_at IS NOT NULL' : 'true';
    return many<any>(
      `SELECT i.*, f.title AS feed_title FROM rss_items i JOIN rss_feeds f ON f.id = i.feed_id
        WHERE ${where} AND ($1::uuid IS NULL OR i.feed_id = $1)
        ORDER BY COALESCE(i.published_at, i.fetched_at) DESC LIMIT $2`,
      [q.feedId ?? null, q.limit],
    );
  });

  app.post('/rss/items/:id', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { action } = z.object({ action: z.enum(['star', 'unstar', 'hide', 'unhide']) }).parse(req.body);
    const uid = req.auth!.user?.id ?? null;
    const sql = {
      star: 'starred_at = now(), starred_by = $2',
      unstar: 'starred_at = NULL, starred_by = NULL',
      hide: 'hidden_at = now(), hidden_by = $2',
      unhide: 'hidden_at = NULL, hidden_by = NULL',
    }[action];
    const r = await one<any>(`UPDATE rss_items SET ${sql} WHERE id = $1 RETURNING id`, action.startsWith('un') ? [id] : [id, uid]);
    if (!r) throw notFound();
    return { ok: true };
  });

  /** Eintrag als Themenidee übernehmen: Beitragsentwurf mit Original-Link. */
  app.post('/rss/items/:id/idea', { preHandler: requireAuth('post.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const it = await one<any>(`SELECT i.*, f.title AS feed_title FROM rss_items i JOIN rss_feeds f ON f.id = i.feed_id WHERE i.id = $1`, [id]);
    if (!it) throw notFound();
    if (it.idea_post_id) return { postId: it.idea_post_id, duplicate: true };
    const userId = req.auth!.user?.id ?? null;
    const body = `${it.summary ? it.summary + '\n\n' : ''}Quelle: ${it.feed_title}${it.link ? ` – ${it.link}` : ''}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const p = await one<any>(`INSERT INTO posts (kind, title, created_by, updated_by) VALUES ('news', $1, $2, $2) RETURNING id`, [it.title.slice(0, 200), userId], client);
      const rev = { title: it.title.slice(0, 200), body, excerpt: '', media_ids: [] as string[], cover_id: null, site_id: null };
      await client.query(
        `INSERT INTO post_revisions (post_id, number, title, body, excerpt, media_ids, cover_id, site_id, content_hash, created_by, change_note) VALUES ($1,1,$2,$3,'','{}',NULL,NULL,$4,$5,'Themenidee aus RSS')`,
        [p.id, rev.title, body, revisionHash(rev), userId],
      );
      await client.query('UPDATE rss_items SET idea_post_id = $2, starred_at = COALESCE(starred_at, now()) WHERE id = $1', [id, p.id]);
      await client.query('COMMIT');
      await audit(req.auth!.actor, 'rss.idea_created', { type: 'post', id: p.id, label: it.title }, { quelle: it.feed_title });
      return { postId: p.id, duplicate: false };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
}
