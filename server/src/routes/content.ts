import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { bannerView, bumpAndSync, sendPost, syncBanner } from '../content/banners.js';

const bannerFields = z.object({
  connectionId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  text: z.string().max(600).default(''),
  label: z.string().max(30).default(''),
  color: z.enum(['rot', 'orange', 'gelb', 'blau', 'gruen', 'neutral']).default('neutral'),
  priority: z.enum(['niedrig', 'normal', 'hoch']).default('normal'),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  pages: z.array(z.string().max(40)).min(1).max(50).default(['front']),
  linkUrl: z.url().max(500).nullable().optional(),
  linkText: z.string().max(80).nullable().optional(),
});

function checkTimes(starts: string | null | undefined, ends: string | null | undefined) {
  if (starts && ends && new Date(ends) <= new Date(starts)) throw badRequest('Das Ende muss nach dem Beginn liegen.');
}

function pluginInfo() {
  const file = path.join(config.pluginDir, 'lifelink.php');
  if (!fs.existsSync(file)) return null;
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
  const version = /Version:\s*([\d.]+)/.exec(head)?.[1] ?? 'unbekannt';
  return { version, requiresWp: /Requires at least:\s*([\d.]+)/.exec(head)?.[1] ?? null, requiresPhp: /Requires PHP:\s*([\d.]+)/.exec(head)?.[1] ?? null };
}

export async function contentRoutes(app: FastifyInstance) {
  app.get('/banners', { preHandler: requireAuth('wordpress.read') }, async (req) => {
    const q = z.object({ connectionId: z.uuid().optional() }).parse(req.query);
    const rows = await many<any>(
      `SELECT b.*, c.name AS site_name, cu.name AS created_by_name FROM banners b JOIN connections c ON c.id = b.connection_id LEFT JOIN users cu ON cu.id = b.created_by
        WHERE ($1::uuid IS NULL OR b.connection_id = $1)
          AND NOT (b.state <> 'draft' AND b.ends_at < now() - interval '30 days')
        ORDER BY (b.state = 'published' AND (b.ends_at IS NULL OR b.ends_at > now())) DESC, b.updated_at DESC LIMIT 300`,
      [q.connectionId ?? null],
    );
    return rows.map((b) => ({ ...b, view: bannerView(b) }));
  });

  app.post('/banners', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const b = bannerFields.parse(req.body);
    checkTimes(b.startsAt, b.endsAt);
    const conn = await one(`SELECT id FROM connections WHERE id = $1 AND connector = 'wordpress'`, [b.connectionId]);
    if (!conn) throw badRequest('WordPress-Verbindung nicht gefunden.');
    const row = await one<any>(
      `INSERT INTO banners (connection_id, title, text, label, color, priority, starts_at, ends_at, pages, link_url, link_text, state, source, source_label, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft','manual',$12,$13,$13) RETURNING *`,
      [b.connectionId, b.title, b.text, b.label, b.color, b.priority, b.startsAt ?? null, b.endsAt ?? null, b.pages, b.linkUrl ?? null, b.linkText ?? null, `Manuell · ${req.auth!.actor.name}`, req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'banner.created', { type: 'banner', id: row.id, label: row.title });
    return { ...row, view: bannerView(row) };
  });

  app.patch('/banners/:id', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = bannerFields.omit({ connectionId: true }).partial().parse(req.body);
    const cur = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    if (!cur) throw notFound();
    if (cur.state === 'published' && !req.auth!.permissions.has('wordpress.publish')) throw badRequest('Veröffentlichte Banner dürfen nur mit Veröffentlichungsrecht geändert werden.');
    checkTimes(b.startsAt === undefined ? cur.starts_at?.toISOString() : b.startsAt, b.endsAt === undefined ? cur.ends_at?.toISOString() : b.endsAt);
    await pool.query(
      `UPDATE banners SET title = COALESCE($2, title), text = COALESCE($3, text), label = COALESCE($4, label), color = COALESCE($5, color), priority = COALESCE($6, priority),
              starts_at = CASE WHEN $7 THEN $8::timestamptz ELSE starts_at END, ends_at = CASE WHEN $9 THEN $10::timestamptz ELSE ends_at END,
              pages = COALESCE($11, pages), link_url = CASE WHEN $12 THEN $13 ELSE link_url END, link_text = CASE WHEN $12 THEN $14 ELSE link_text END, updated_by = $15
        WHERE id = $1`,
      [id, b.title ?? null, b.text ?? null, b.label ?? null, b.color ?? null, b.priority ?? null, b.startsAt !== undefined, b.startsAt ?? null, b.endsAt !== undefined, b.endsAt ?? null, b.pages ?? null, b.linkUrl !== undefined, b.linkUrl ?? null, b.linkText ?? null, req.auth!.user?.id ?? null],
    );
    await bumpAndSync(id);
    if (cur.state === 'published') await syncBanner(id);
    await audit(req.auth!.actor, 'banner.updated', { type: 'banner', id, label: b.title ?? cur.title });
    const row = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    return { ...row, view: bannerView(row) };
  });

  app.post('/banners/:id/publish', { preHandler: requireAuth('wordpress.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const cur = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    if (!cur) throw notFound();
    if (cur.ends_at && new Date(cur.ends_at).getTime() <= Date.now()) throw badRequest('Das Ende liegt in der Vergangenheit. Bitte einen neuen Zeitraum wählen.');
    await pool.query(
      `UPDATE banners SET state = 'published', starts_at = COALESCE(starts_at, now()), revision = revision + 1, sync_status = 'pending', updated_by = $2, updated_at = now() WHERE id = $1`,
      [id, req.auth!.user?.id ?? null],
    );
    const ok = await syncBanner(id);
    await audit(req.auth!.actor, cur.state === 'deactivated' ? 'banner.reactivated' : 'banner.published', { type: 'banner', id, label: cur.title }, { synchronisiert: ok });
    const row = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    return { ...row, view: bannerView(row) };
  });

  app.post('/banners/:id/deactivate', { preHandler: requireAuth('wordpress.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const cur = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    if (!cur) throw notFound();
    if (cur.state !== 'published') throw badRequest('Nur veröffentlichte Banner können deaktiviert werden.');
    await pool.query(`UPDATE banners SET state = 'deactivated', revision = revision + 1, sync_status = 'pending', updated_by = $2, updated_at = now() WHERE id = $1`, [id, req.auth!.user?.id ?? null]);
    const ok = await syncBanner(id);
    await audit(req.auth!.actor, 'banner.deactivated', { type: 'banner', id, label: cur.title }, { synchronisiert: ok });
    const row = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    return { ...row, view: bannerView(row) };
  });

  app.post('/banners/:id/sync', { preHandler: requireAuth('wordpress.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const ok = await syncBanner(id);
    const row = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    if (!row) throw notFound();
    return { ok, banner: { ...row, view: bannerView(row) } };
  });

  app.post('/banners/:id/duplicate', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one<any>(
      `INSERT INTO banners (connection_id, title, text, label, color, priority, pages, link_url, link_text, state, source, source_label, created_by, updated_by)
       SELECT connection_id, title, text, label, color, priority, pages, link_url, link_text, 'draft', 'manual', $2, $3, $3 FROM banners WHERE id = $1 RETURNING *`,
      [id, `Manuell · ${req.auth!.actor.name}`, req.auth!.user?.id ?? null],
    );
    if (!row) throw notFound();
    await audit(req.auth!.actor, 'banner.duplicated', { type: 'banner', id: row.id, label: row.title }, { quelle: id });
    return { ...row, view: bannerView(row) };
  });

  app.delete('/banners/:id', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const cur = await one<any>('SELECT * FROM banners WHERE id = $1', [id]);
    if (!cur) throw notFound();
    if (bannerView(cur) === 'aktiv' || bannerView(cur) === 'geplant') throw badRequest('Aktive oder geplante Banner zuerst deaktivieren.');
    await pool.query('DELETE FROM banners WHERE id = $1', [id]);
    await audit(req.auth!.actor, 'banner.deleted', { type: 'banner', id, label: cur.title });
    return { ok: true };
  });

  /* ----------------------------------- Beiträge ------------------------------------ */

  const postFields = z.object({
    connectionId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    content: z.string().max(200_000).default(''),
    excerpt: z.string().max(1000).default(''),
    category: z.string().max(100).default(''),
    tags: z.array(z.string().max(50)).max(20).default([]),
    wpStatus: z.enum(['draft', 'pending', 'future']).default('draft'),
    publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  });

  app.get('/posts', { preHandler: requireAuth('wordpress.read') }, async (req) => {
    const q = z.object({ connectionId: z.uuid().optional() }).parse(req.query);
    return many<any>(
      `SELECT p.*, c.name AS site_name FROM content_posts p JOIN connections c ON c.id = p.connection_id WHERE ($1::uuid IS NULL OR p.connection_id = $1) ORDER BY p.updated_at DESC LIMIT 300`,
      [q.connectionId ?? null],
    );
  });

  app.post('/posts', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const p = postFields.parse(req.body);
    if (p.wpStatus === 'future' && (!p.publishAt || new Date(p.publishAt).getTime() <= Date.now())) throw badRequest('Für geplante Beiträge einen Zeitpunkt in der Zukunft angeben.');
    const row = await one<any>(
      `INSERT INTO content_posts (connection_id, title, content, excerpt, category, tags, wp_status, publish_at, source, source_label, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10) RETURNING *`,
      [p.connectionId, p.title, p.content, p.excerpt, p.category, p.tags, p.wpStatus, p.publishAt ?? null, `Manuell · ${req.auth!.actor.name}`, req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'post.created', { type: 'post', id: row.id, label: row.title });
    return row;
  });

  app.patch('/posts/:id', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = postFields.omit({ connectionId: true }).partial().parse(req.body);
    const row = await one<any>(
      `UPDATE content_posts SET title = COALESCE($2, title), content = COALESCE($3, content), excerpt = COALESCE($4, excerpt), category = COALESCE($5, category),
              tags = COALESCE($6, tags), wp_status = COALESCE($7, wp_status), publish_at = CASE WHEN $8 THEN $9::timestamptz ELSE publish_at END,
              revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, p.title ?? null, p.content ?? null, p.excerpt ?? null, p.category ?? null, p.tags ?? null, p.wpStatus ?? null, p.publishAt !== undefined, p.publishAt ?? null],
    );
    if (!row) throw notFound();
    await audit(req.auth!.actor, 'post.updated', { type: 'post', id, label: row.title });
    return row;
  });

  app.post('/posts/:id/send', { preHandler: requireAuth('wordpress.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await one<any>('SELECT title FROM content_posts WHERE id = $1', [id]);
    if (!p) throw notFound();
    try {
      const res = await sendPost(id);
      await audit(req.auth!.actor, 'post.sent', { type: 'post', id, label: p.title }, { status: res.status });
      return { ok: true, result: res };
    } catch (e) {
      await audit(req.auth!.actor, 'post.sent', { type: 'post', id, label: p.title }, { fehler: (e as Error).message }, 'failed');
      throw badRequest(`Übertragung fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  app.delete('/posts/:id', { preHandler: requireAuth('wordpress.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const p = await one<any>('DELETE FROM content_posts WHERE id = $1 RETURNING title', [id]);
    if (!p) throw notFound();
    await audit(req.auth!.actor, 'post.deleted', { type: 'post', id, label: p.title }, { hinweis: 'Nur in LifeLink gelöscht, nicht in WordPress' });
    return { ok: true };
  });

  /* --------------------------------- Plugin-Download -------------------------------- */

  app.get('/wordpress/plugin', { preHandler: requireAnyAuth('wordpress.read', 'connection.read') }, async () => {
    const info = pluginInfo();
    return { available: !!info, ...info, fileName: info ? `lifelink-wordpress-${info.version}.zip` : null };
  });

  app.get('/wordpress/plugin/download', { preHandler: requireAnyAuth('wordpress.read', 'connection.read') }, async (req, reply) => {
    const info = pluginInfo();
    if (!info) throw notFound('Das Plugin ist in dieser Installation nicht enthalten.');
    const zip = new AdmZip();
    zip.addLocalFolder(config.pluginDir, 'lifelink');
    const buf = zip.toBuffer();
    await audit(req.auth!.actor, 'wordpress.plugin_downloaded', { type: 'plugin', label: info.version });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="lifelink-wordpress-${info.version}.zip"`);
    return reply.send(buf);
  });
}
