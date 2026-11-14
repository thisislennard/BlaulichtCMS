import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit, type Actor } from '../lib/audit.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { publicBase } from '../lib/urls.js';
import { publicFileFor } from './media.js';
import { textFor } from './posts.js';
import { sendFileResponse } from './files.js';

export const BRIDGE_API_VERSION = 1;
/** Abholintervall, das die Bridge verwenden soll (Sekunden). */
const POLL_SECONDS = 60;
/** Ein abgeholter Auftrag ohne Rückmeldung wird nach dieser Zeit erneut ausgeliefert. */
const REDELIVER_AFTER_SEC = 120;
const PAIRING_MINUTES = 30;

/** Kopplungscode: 8 Zeichen ohne verwechselbare Zeichen, angezeigt als XXXX-XXXX. */
function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

function sitePayload(s: any) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    site_url: s.site_url,
    wp_version: s.wp_version,
    plugin_version: s.plugin_version,
    paired_at: s.paired_at,
    last_seen_at: s.last_seen_at,
    pairing_expires_at: s.status === 'pending' ? s.pairing_expires_at : null,
    revoked_at: s.revoked_at,
    created_at: s.created_at,
    open_jobs: s.open_jobs ?? 0,
    published_count: s.published_count ?? 0,
  };
}

interface BridgeSite {
  id: string;
  name: string;
}

async function bridgeAuth(req: FastifyRequest): Promise<BridgeSite> {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (llb_([A-Za-z0-9]{12})_[A-Za-z0-9_-]{20,})$/.exec(h.trim());
  if (!m) throw new AppError(401, 'bridge_unauthorized', 'Bridge-Schlüssel fehlt oder ist ungültig.');
  const site = await one<any>(`SELECT id, name, status, key_hash FROM wp_sites WHERE key_prefix = $1`, [m[2]]);
  if (!site || !site.key_hash || !safeEqual(site.key_hash, sha256Hex(m[1]))) throw new AppError(401, 'bridge_unauthorized', 'Bridge-Schlüssel ist ungültig.');
  if (site.status !== 'active') throw new AppError(403, 'bridge_revoked', 'Die Kopplung dieser Website wurde widerrufen.');
  const pv = String(req.headers['x-lifelink-bridge-version'] ?? '').slice(0, 20) || null;
  await pool.query(`UPDATE wp_sites SET last_seen_at = now(), plugin_version = COALESCE($2, plugin_version) WHERE id = $1`, [site.id, pv]);
  return { id: site.id, name: site.name };
}

const bridgeActor = (site: BridgeSite, req: FastifyRequest): Actor => ({ id: null, name: `Website „${site.name}“ (Bridge)`, type: 'system', ip: req.ip });

/** Text → einfache Absätze. Die Bridge escaped zusätzlich und erzeugt daraus HTML. */
function jobPayload(p: any, media: any[], base: string) {
  const text = textFor(p, 'wordpress');
  return {
    id: p.id,
    type: 'post.upsert',
    lifelink_post_id: p.post_id,
    kind: p.kind,
    revision: p.number,
    content_hash: p.content_hash,
    post: {
      title: text.title,
      body: text.body,
      excerpt: text.excerpt,
      status: 'publish',
      cover_media_id: p.cover_id,
    },
    media: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      mime: publicFileFor(m)?.type ?? m.mime,
      filename: `${m.id}.${publicFileFor(m)?.ext ?? 'bin'}`,
      // Pfad relativ zur LifeLink-Adresse, die die Bridge selbst verwendet (robust hinter Proxys und in Testnetzen)
      path: `/api/v1/bridge/media/${m.id}`,
      url: `${base}/api/v1/bridge/media/${m.id}`,
      width: m.width,
      height: m.height,
    })),
  };
}

export async function bridgeRoutes(app: FastifyInstance) {
  /* ----------------------------- Verwaltung in LifeLink ----------------------------- */

  app.get('/sites', { preHandler: requireAuth('post.read') }, async () => {
    const rows = await many<any>(
      `SELECT s.*,
              (SELECT count(*)::int FROM publications p WHERE p.site_id = s.id AND p.status IN ('queued','sent','unknown')) AS open_jobs,
              (SELECT count(*)::int FROM publications p WHERE p.site_id = s.id AND p.status = 'published') AS published_count
         FROM wp_sites s ORDER BY s.status = 'revoked', s.name`,
    );
    return rows.map(sitePayload);
  });

  app.post('/sites', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const body = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
    const code = pairingCode();
    const s = await one<any>(
      `INSERT INTO wp_sites (name, pairing_code_hash, pairing_expires_at, created_by) VALUES ($1,$2, now() + make_interval(mins => $3), $4) RETURNING *`,
      [body.name, sha256Hex(normCode(code)), PAIRING_MINUTES, req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'site.created', { type: 'site', id: s.id, label: s.name });
    return { site: sitePayload(s), pairingCode: code, lifelinkUrl: await publicBase(req) };
  });

  app.post('/sites/:id/pairing-code', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const code = pairingCode();
    const s = await one<any>(
      `UPDATE wp_sites SET pairing_code_hash = $2, pairing_expires_at = now() + make_interval(mins => $3) WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, sha256Hex(normCode(code)), PAIRING_MINUTES],
    );
    if (!s) throw badRequest('Ein neuer Kopplungscode ist nur für noch nicht gekoppelte Websites möglich.');
    await audit(req.auth!.actor, 'site.pairing_code', { type: 'site', id, label: s.name });
    return { site: sitePayload(s), pairingCode: code, lifelinkUrl: await publicBase(req) };
  });

  app.post('/sites/:id/revoke', { preHandler: requireAuth('channel.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const s = await tx(async (db) => {
      const s = await one<any>(
        `UPDATE wp_sites SET status = 'revoked', revoked_at = now(), revoked_by = $2, key_hash = NULL, pairing_code_hash = NULL WHERE id = $1 AND status <> 'revoked' RETURNING *`,
        [id, req.auth!.user?.id ?? null],
        db,
      );
      if (!s) throw notFound('Website nicht gefunden oder bereits widerrufen.');
      await db.query(`UPDATE publications SET status = 'canceled', result_at = now(), error = 'Kopplung widerrufen' WHERE site_id = $1 AND status = 'queued'`, [id]);
      await audit(req.auth!.actor, 'site.revoked', { type: 'site', id, label: s.name }, {}, 'ok', db);
      return s;
    });
    return sitePayload(s);
  });

  /** LifeLink Bridge als installierbare ZIP-Datei (WordPress → Plugins → Installieren → Plugin hochladen). */
  app.get('/sites/plugin.zip', { preHandler: requireAuth('channel.manage') }, async (req, reply) => {
    const dir = config.pluginDir;
    if (!fs.existsSync(path.join(dir, 'lifelink-bridge.php'))) throw notFound('Das Plugin ist in diesem Image nicht enthalten.');
    const zip = new AdmZip();
    zip.addLocalFolder(dir, 'lifelink-bridge', (name) => !/(^|\/)(tests|node_modules|\.git)(\/|$)/.test(name));
    const header = fs.readFileSync(path.join(dir, 'lifelink-bridge.php'), 'utf8');
    const version = /Version:\s*([0-9.]+)/.exec(header)?.[1] ?? '0';
    await audit(req.auth!.actor, 'site.plugin_downloaded', { type: 'plugin', label: `LifeLink Bridge ${version}` });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="lifelink-bridge-${version}.zip"`);
    return reply.send(zip.toBuffer());
  });

  /* ------------------------------ Bridge-Schnittstelle ------------------------------ */

  const bridgeLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /** Kopplung per einmaligem Code. Antwort enthält den Schlüssel genau einmal. */
  app.post('/bridge/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({
        code: z.string().trim().min(8).max(20),
        site_url: z.url().max(300),
        site_name: z.string().max(200).default(''),
        wp_version: z.string().max(20).default(''),
        plugin_version: z.string().max(20).default(''),
      })
      .parse(req.body);
    const site = await one<any>(`SELECT * FROM wp_sites WHERE pairing_code_hash = $1 AND status = 'pending'`, [sha256Hex(normCode(body.code))]);
    if (!site) {
      await audit({ id: null, name: 'Bridge (unbekannt)', type: 'system', ip: req.ip }, 'site.pair', { type: 'site', label: body.site_url }, {}, 'denied');
      throw new AppError(401, 'pairing_invalid', 'Der Kopplungscode ist ungültig.');
    }
    if (new Date(site.pairing_expires_at).getTime() < Date.now()) throw new AppError(410, 'pairing_expired', 'Der Kopplungscode ist abgelaufen. Bitte in LifeLink einen neuen erzeugen.');
    const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12).padEnd(12, 'x');
    const key = `llb_${prefix}_${randomToken(32)}`;
    const updated = await one<any>(
      `UPDATE wp_sites SET status = 'active', key_prefix = $2, key_hash = $3, pairing_code_hash = NULL, pairing_expires_at = NULL,
              site_url = $4, wp_version = $5, plugin_version = $6, paired_at = now(), last_seen_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [site.id, prefix, sha256Hex(key), body.site_url.replace(/\/+$/, ''), body.wp_version || null, body.plugin_version || null],
    );
    if (!updated) throw new AppError(409, 'pairing_used', 'Der Kopplungscode wurde bereits verwendet.');
    await audit({ id: null, name: `Website „${site.name}“ (Bridge)`, type: 'system', ip: req.ip }, 'site.paired', { type: 'site', id: site.id, label: site.name }, { url: body.site_url });
    await notify({ kind: 'success', title: `Website „${site.name}“ gekoppelt`, body: body.site_url, link: '/kanaele', permission: 'channel.manage' });
    return { key, site_id: site.id, site_name: site.name, api_version: BRIDGE_API_VERSION, poll_interval: POLL_SECONDS, lifelink_url: await publicBase(req) };
  });

  app.get('/bridge/status', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    return { ok: true, site_id: site.id, site_name: site.name, api_version: BRIDGE_API_VERSION, poll_interval: POLL_SECONDS };
  });

  /** Offene Aufträge abholen. Mehrfaches Abholen ist erlaubt – die Bridge arbeitet idempotent. */
  app.get('/bridge/jobs', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    const rows = await many<any>(
      `UPDATE publications pb SET status = CASE WHEN pb.status = 'queued' THEN 'sent' ELSE pb.status END,
              fetched_at = now(), attempts = pb.attempts + 1
        WHERE pb.id IN (
          SELECT id FROM publications
           WHERE site_id = $1 AND run_at <= now() AND (status IN ('queued','unknown') OR (status = 'sent' AND (fetched_at IS NULL OR fetched_at < now() - make_interval(secs => $2))))
           ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING pb.id`,
      [site.id, REDELIVER_AFTER_SEC],
    );
    const bannerRows = await many<any>(
      `UPDATE banner_jobs SET status = 'sent', fetched_at = now(), attempts = attempts + 1
        WHERE id IN (SELECT id FROM banner_jobs WHERE site_id = $1 AND (status = 'queued' OR (status = 'sent' AND fetched_at < now() - make_interval(secs => $2)))
                     ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id, action, payload`,
      [site.id, REDELIVER_AFTER_SEC],
    );
    const jobs: any[] = bannerRows.map((b) => ({ id: b.id, type: b.action === 'upsert' ? 'banner.upsert' : 'banner.delete', banner: b.payload }));
    // Vollständige Liste aktiver Banner: Die Bridge gleicht damit ihren lokalen Stand ab (auch nach Datenverlust in WordPress)
    const active = await many<any>(
      `SELECT b.* FROM banners b WHERE b.site_id = $1 AND b.ended_at IS NULL AND b.ends_at > now()
          AND EXISTS (SELECT 1 FROM banner_jobs j WHERE j.banner_id = b.id AND j.action = 'upsert' AND j.status IN ('sent','done'))`,
      [site.id],
    );
    if (!rows.length) return { jobs, banner_ids: active.map((b) => b.id), poll_interval: POLL_SECONDS };
    const base = await publicBase(req);
    for (const r of rows) {
      const p = await one<any>(
        `SELECT pb.id, pb.post_id, pb.action, (SELECT kind FROM posts WHERE id = pb.post_id) AS kind, rv.number, rv.title, rv.body, rv.excerpt, rv.variants, rv.media_ids, rv.cover_id, rv.content_hash
           FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id WHERE pb.id = $1`,
        [r.id],
      );
      if (p.action === 'unpublish') {
        jobs.push({ id: p.id, type: 'post.unpublish', lifelink_post_id: p.post_id, revision: p.number });
        continue;
      }
      const media = p.media_ids.length ? await many<any>(`SELECT * FROM media WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL`, [p.media_ids]) : [];
      const ordered = p.media_ids.map((id: string) => media.find((m: any) => m.id === id)).filter((m: any) => m && publicFileFor(m));
      jobs.push(jobPayload(p, ordered, base));
    }
    await audit(bridgeActor(site, req), 'publication.fetched', { type: 'site', id: site.id, label: site.name }, { auftraege: rows.map((r) => r.id) });
    return { jobs, banner_ids: active.map((b) => b.id), poll_interval: POLL_SECONDS };
  });

  /** Ergebnis melden. Wiederholte Meldungen desselben Ergebnisses ändern nichts. */
  app.post('/bridge/jobs/:id/result', bridgeLimit, async (req) => {
    const site = await bridgeAuth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(['published', 'failed']),
        remote_id: z.union([z.string(), z.number()]).transform(String).optional(),
        url: z.url().max(500).optional(),
        remote_status: z.string().max(40).optional(),
        error: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const pub = await one<any>(`SELECT pb.*, rv.title FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id WHERE pb.id = $1 AND pb.site_id = $2`, [id, site.id]);
    if (!pub) {
      // Banner-Auftrag?
      const bj = await one<any>(`SELECT j.*, b.title FROM banner_jobs j JOIN banners b ON b.id = j.banner_id WHERE j.id = $1 AND j.site_id = $2`, [id, site.id]);
      if (!bj) throw notFound('Auftrag nicht gefunden.');
      if (bj.status === 'done') return { ok: true, status: 'published', duplicate: true };
      const ok = body.status === 'published';
      await pool.query(`UPDATE banner_jobs SET status = $2, error = $3, result_at = now() WHERE id = $1`, [id, ok ? 'done' : 'failed', ok ? null : (body.error ?? 'Unbekannter Fehler').slice(0, 1000)]);
      await audit(bridgeActor(site, req), ok ? 'banner.synced' : 'banner.sync_failed', { type: 'banner', id: bj.banner_id, label: bj.title }, { auftrag: id, aktion: bj.action }, ok ? 'ok' : 'failed');
      if (!ok) await notify({ kind: 'error', title: `Banner nicht übertragen: ${bj.title}`.slice(0, 200), body: body.error ?? '', link: '/banner', permission: 'post.publish' });
      return { ok: true, status: body.status };
    }
    if (pub.status === 'published') {
      return { ok: true, status: 'published', duplicate: true };
    }
    if (pub.status === 'canceled') throw new AppError(409, 'job_canceled', 'Der Auftrag wurde in LifeLink abgebrochen.');
    if (body.status === 'published' && pub.action === 'unpublish') {
      await pool.query(`UPDATE publications SET status = 'published', remote_id = $2, remote_status = $3, error = NULL, result_at = now() WHERE id = $1`, [id, body.remote_id ?? null, body.remote_status ?? 'draft']);
      await audit(bridgeActor(site, req), 'publication.unpublished', { type: 'post', id: pub.post_id, label: pub.title }, { auftrag: id });
      await notify({ kind: 'info', title: `Zurückgezogen: ${pub.title}`.slice(0, 200), body: site.name, link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
    } else if (body.status === 'published') {
      if (!body.remote_id || !body.url) throw badRequest('Für eine erfolgreiche Veröffentlichung sind WordPress-ID und URL nötig.');
      await pool.query(
        `UPDATE publications SET status = 'published', remote_id = $2, remote_url = $3, remote_status = $4, error = NULL, result_at = now() WHERE id = $1`,
        [id, body.remote_id, body.url, body.remote_status ?? 'publish'],
      );
      await audit(bridgeActor(site, req), 'publication.confirmed', { type: 'post', id: pub.post_id, label: pub.title }, { auftrag: id, url: body.url, wordpress_id: body.remote_id });
      await notify({ kind: 'success', title: `Veröffentlicht: ${pub.title}`.slice(0, 200), body: body.url, link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
    } else {
      await pool.query(`UPDATE publications SET status = 'failed', error = $2, result_at = now() WHERE id = $1`, [id, (body.error ?? 'Unbekannter Fehler').slice(0, 1000)]);
      await audit(bridgeActor(site, req), 'publication.failed', { type: 'post', id: pub.post_id, label: pub.title }, { auftrag: id }, 'failed');
      await notify({ kind: 'error', title: `Veröffentlichung fehlgeschlagen: ${pub.title}`.slice(0, 200), body: body.error ?? '', link: `/beitraege/${pub.post_id}`, permission: 'post.publish' });
    }
    return { ok: true, status: body.status };
  });

  /** Öffentliche Medienfassung für einen Auftrag dieser Website (ohne Standortdaten). */
  app.get('/bridge/media/:id', bridgeLimit, async (req, reply) => {
    const site = await bridgeAuth(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const allowed = await one(
      `SELECT 1 FROM publications pb JOIN post_revisions rv ON rv.id = pb.revision_id
        WHERE pb.site_id = $1 AND pb.status IN ('sent','unknown','queued','published') AND $2 = ANY(rv.media_ids) LIMIT 1`,
      [site.id, id],
    );
    if (!allowed) throw notFound('Datei gehört zu keinem Auftrag dieser Website.');
    const m = await one<any>(`SELECT * FROM media WHERE id = $1 AND status = 'ready' AND deleted_at IS NULL`, [id]);
    const pf = m ? publicFileFor(m) : null;
    if (!pf) throw notFound('Keine öffentliche Fassung vorhanden.');
    return sendFileResponse(reply, pf.path, pf.type, `${id}.${pf.ext}`);
  });
}
