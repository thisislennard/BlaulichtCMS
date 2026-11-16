import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { permissionsFor } from '../auth/permissions.js';
import { ensureRolesFresh } from '../auth/roles.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { publicBase } from '../lib/urls.js';
import { getSettings } from '../lib/settings.js';
import { buildIcs } from '../calendar/ical.js';
import { calendarTimeZone, occurrences } from '../calendar/store.js';
import { feedTokenHash, fetchCalendar, newFeedToken, normalizeIcalUrl, refreshSource, replaceSourceUrl, storeSourceUrl, syncEvents } from '../calendar/sources.js';

/**
 * iCal (#202): externe Kalender einlesen (Quellen, Verbindungstest, Empfangsprotokoll) und den Kalender als
 * persönliches iCal-Abo anbieten (geheimer Link, nur Titel/Zeit/Kategorie, optional Beschreibung).
 */

const sourceInput = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.uuid().nullable().default(null),
  intervalMin: z.number().int().min(15).max(1440).default(60),
});

function sourceView(s: any) {
  return {
    id: s.id,
    name: s.name,
    host: s.url_host,
    categoryId: s.category_id,
    categoryName: s.category_name ?? null,
    intervalMin: s.interval_min,
    active: s.active,
    lastFetchAt: s.last_fetch_at,
    lastSuccessAt: s.last_success_at,
    lastError: s.last_error,
    eventCount: s.event_count ?? s.last_count ?? 0,
    createdAt: s.created_at,
  };
}

async function assertCategory(id: string | null) {
  if (id && !(await one('SELECT 1 FROM calendar_categories WHERE id = $1', [id]))) throw badRequest('Die Kategorie gibt es nicht (mehr).');
}

/** Abo-Fenster: 60 Tage zurück, 365 Tage voraus. */
const FEED_PAST_DAYS = 60;
const FEED_FUTURE_DAYS = 365;

export async function calendarIcalRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- Quellen */

  app.get('/calendar/sources', { preHandler: requireAuth('calendar.sources') }, async () => {
    const rows = await many<any>(
      `SELECT s.*, c.name AS category_name, (SELECT count(*)::int FROM calendar_events e WHERE e.source_id = s.id) AS event_count
         FROM calendar_sources s LEFT JOIN calendar_categories c ON c.id = s.category_id ORDER BY lower(s.name)`,
    );
    return rows.map(sourceView);
  });

  /** Verbindungstest vor dem Anlegen: Adresse abrufen und lesen, ohne etwas zu speichern. */
  app.post('/calendar/sources/test', { preHandler: requireAuth('calendar.sources'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { url } = z.object({ url: z.string().trim().min(8).max(2000) }).parse(req.body);
    const r = await fetchCalendar(normalizeIcalUrl(url));
    if (r.notModified) throw new AppError(502, 'ics_http', 'Der Kalender antwortet ohne Inhalt.');
    const now = Date.now();
    const upcoming = r.cal.events.filter((e) => !e.cancelled && (e.end >= now || e.rruleParsed)).sort((a, b) => a.start - b.start).slice(0, 5);
    return {
      name: r.cal.name,
      events: r.cal.events.length,
      recurring: r.cal.events.filter((e) => e.rruleParsed).length,
      sample: upcoming.map((e) => ({ title: e.summary, start: new Date(e.start).toISOString(), allDay: e.allDay, recurring: !!e.rruleParsed })),
      warnings: r.cal.warnings.slice(0, 10),
      bytes: r.bytes,
    };
  });

  /** Anlegen nur nach erfolgreichem Abruf (Verbindungstest); die Termine werden sofort übernommen. */
  app.post('/calendar/sources', { preHandler: requireAuth('calendar.sources'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const v = sourceInput.extend({ url: z.string().trim().min(8).max(2000) }).parse(req.body);
    await assertCategory(v.categoryId);
    const url = normalizeIcalUrl(v.url);
    const r = await fetchCalendar(url);
    if (r.notModified) throw new AppError(502, 'ics_http', 'Der Kalender antwortet ohne Inhalt.');
    const host = new URL(url).hostname;
    const uid = req.auth!.user?.id ?? null;
    const created = await tx(async (db) => {
      const s = await one<any>(
        `INSERT INTO calendar_sources (name, url_secret_id, url_host, category_id, interval_min, created_by, etag, last_modified, last_fetch_at, last_success_at)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, now(), now()) RETURNING *`,
        [v.name, host, v.categoryId, v.intervalMin, uid, r.etag, r.lastModified],
        db,
      );
      const secretId = await storeSourceUrl(s.id, url, uid, db);
      await db.query('UPDATE calendar_sources SET url_secret_id = $2 WHERE id = $1', [s.id, secretId]);
      const res = await syncEvents(s.id, r.cal, v.categoryId, db);
      await db.query('UPDATE calendar_sources SET last_count = $2 WHERE id = $1', [s.id, res.events]);
      await db.query(
        `INSERT INTO calendar_source_log (source_id, trigger, ok, http_status, events, added, bytes, duration_ms, message, warnings) VALUES ($1,'test',true,$2,$3,$4,$5,0,'Verbindungstest und erster Abruf beim Anlegen',$6)`,
        [s.id, r.status, res.events, res.added, r.bytes, JSON.stringify(r.cal.warnings.slice(0, 20))],
      );
      await audit(req.auth!.actor, 'calendar.source_created', { type: 'calendar_source', id: s.id, label: v.name }, { host, termine: res.events }, 'ok', db);
      return { ...s, url_secret_id: secretId, last_count: res.events };
    });
    return sourceView(created);
  });

  app.put('/calendar/sources/:id', { preHandler: requireAuth('calendar.sources') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = sourceInput.extend({ url: z.string().trim().max(2000).optional(), active: z.boolean().optional() }).parse(req.body);
    await assertCategory(v.categoryId);
    const src = await one<any>('SELECT * FROM calendar_sources WHERE id = $1', [id]);
    if (!src) throw notFound();
    // Neue Adresse: erst testen, dann übernehmen (sonst bleibt die alte)
    const newUrl = v.url ? normalizeIcalUrl(v.url) : null;
    if (newUrl) {
      const r = await fetchCalendar(newUrl);
      if (r.notModified) throw new AppError(502, 'ics_http', 'Der Kalender antwortet ohne Inhalt.');
    }
    await tx(async (db) => {
      if (newUrl) {
        const secretId = await replaceSourceUrl(src, newUrl, req.auth!.user?.id ?? null, db);
        await db.query('UPDATE calendar_sources SET url_secret_id = $2, url_host = $3, etag = NULL, last_modified = NULL WHERE id = $1', [id, secretId, new URL(newUrl).hostname]);
      }
      await db.query('UPDATE calendar_sources SET name = $2, category_id = $3, interval_min = $4, active = COALESCE($5, active), updated_at = now() WHERE id = $1', [id, v.name, v.categoryId, v.intervalMin, v.active ?? null]);
      // Kategorie gilt für alle Termine der Quelle
      await db.query(`UPDATE calendar_events SET category_id = $2 WHERE source_id = $1 AND category_id IS DISTINCT FROM $2`, [id, v.categoryId]);
      await audit(req.auth!.actor, 'calendar.source_updated', { type: 'calendar_source', id, label: v.name }, { neue_adresse: !!newUrl, aktiv: v.active ?? src.active }, 'ok', db);
    });
    const updated = await one<any>('SELECT * FROM calendar_sources WHERE id = $1', [id]);
    // Nach neuer Adresse oder Wiederaktivierung sofort abrufen
    if (newUrl || (v.active === true && !src.active)) await refreshSource(updated, 'manual', true).catch(() => {});
    return sourceView((await one<any>('SELECT * FROM calendar_sources WHERE id = $1', [id]))!);
  });

  app.post('/calendar/sources/:id/refresh', { preHandler: requireAuth('calendar.sources'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const src = await one<any>('SELECT * FROM calendar_sources WHERE id = $1', [id]);
    if (!src) throw notFound();
    const r = await refreshSource(src, 'manual', true);
    return r;
  });

  app.delete('/calendar/sources/:id', { preHandler: requireAuth('calendar.sources') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await tx(async (db) => {
      const s = await one<any>('DELETE FROM calendar_sources WHERE id = $1 RETURNING *', [id], db);
      if (!s) throw notFound();
      await db.query(`DELETE FROM secrets WHERE owner_type = 'calendar_source' AND owner_id = $1`, [id]);
      await audit(req.auth!.actor, 'calendar.source_deleted', { type: 'calendar_source', id, label: s.name }, { host: s.url_host }, 'ok', db);
    });
    return { ok: true };
  });

  app.get('/calendar/sources/:id/log', { preHandler: requireAuth('calendar.sources') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await one('SELECT 1 FROM calendar_sources WHERE id = $1', [id]))) throw notFound();
    return many(`SELECT id, at, trigger, ok, http_status, not_modified, events, added, changed, removed, bytes, duration_ms, message, warnings FROM calendar_source_log WHERE source_id = $1 ORDER BY at DESC LIMIT 100`, [id]);
  });

  /* ---------------------------------------------------------------- Abo */

  app.get('/calendar/feed', { preHandler: requireAuth('calendar.subscribe') }, async (req) => {
    const f = await one<any>('SELECT * FROM calendar_feeds WHERE user_id = $1', [req.auth!.user?.id]);
    return f ? { active: true, categories: f.categories, includeDescription: f.include_description, createdAt: f.created_at, lastUsedAt: f.last_used_at } : { active: false, categories: [], includeDescription: false };
  });

  /** Link erzeugen oder erneuern: Der bisherige Link funktioniert danach nicht mehr. Der Link wird nur einmal angezeigt. */
  app.post('/calendar/feed', { preHandler: requireAuth('calendar.subscribe') }, async (req) => {
    const uid = req.auth!.user?.id;
    if (!uid || req.auth!.kind !== 'session') throw new AppError(403, 'forbidden', 'Ein Abo gibt es nur für Personen mit Benutzerkonto.');
    const b = z.object({ categories: z.array(z.uuid()).max(50).optional(), includeDescription: z.boolean().optional() }).parse(req.body ?? {});
    const token = newFeedToken();
    const existed = await one<any>('SELECT 1 FROM calendar_feeds WHERE user_id = $1', [uid]);
    await pool.query(
      `INSERT INTO calendar_feeds (user_id, token_hash, categories, include_description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), last_used_at = NULL,
         categories = COALESCE($5, calendar_feeds.categories), include_description = COALESCE($6, calendar_feeds.include_description)`,
      [uid, feedTokenHash(token), b.categories ?? [], b.includeDescription ?? false, b.categories ?? null, b.includeDescription ?? null],
    );
    await audit(req.auth!.actor, existed ? 'calendar.feed_renewed' : 'calendar.feed_created', { type: 'calendar_feed', id: uid, label: req.auth!.user?.name ?? null });
    return { url: `${await publicBase(req)}/api/v1/public/calendar/${token}.ics` };
  });

  app.put('/calendar/feed', { preHandler: requireAuth('calendar.subscribe') }, async (req) => {
    const b = z.object({ categories: z.array(z.uuid()).max(50), includeDescription: z.boolean() }).parse(req.body);
    const r = await pool.query('UPDATE calendar_feeds SET categories = $2, include_description = $3 WHERE user_id = $1', [req.auth!.user?.id, b.categories, b.includeDescription]);
    if (!r.rowCount) throw notFound('Es gibt noch keinen Abo-Link.');
    await audit(req.auth!.actor, 'calendar.feed_updated', { type: 'calendar_feed', id: req.auth!.user?.id, label: req.auth!.user?.name ?? null }, { kategorien: b.categories.length, beschreibung: b.includeDescription });
    return { ok: true };
  });

  app.delete('/calendar/feed', { preHandler: requireAuth('calendar.subscribe') }, async (req) => {
    const r = await pool.query('DELETE FROM calendar_feeds WHERE user_id = $1', [req.auth!.user?.id]);
    if (r.rowCount) await audit(req.auth!.actor, 'calendar.feed_revoked', { type: 'calendar_feed', id: req.auth!.user?.id, label: req.auth!.user?.name ?? null });
    return { ok: true };
  });

  /**
   * Öffentliche Abo-Adresse (ohne Anmeldung, geschützt durch den geheimen Link). Liefert nur Termine (eigene und
   * eingelesene), keine Beiträge oder Presse-Fristen; je Termin Titel, Zeit und Kategorie, optional Beschreibung und
   * Ort. Gilt nur, solange das Konto aktiv ist und „Kalender ansehen“ hat.
   */
  app.get('/public/calendar/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(200) }).parse(req.params);
    const raw = token.replace(/\.ics$/i, '');
    const feed = /^bcal_[A-Za-z0-9_-]{30,}$/.test(raw)
      ? await one<any>(`SELECT f.*, u.status, u.roles FROM calendar_feeds f JOIN users u ON u.id = f.user_id WHERE f.token_hash = $1`, [feedTokenHash(raw)])
      : null;
    await ensureRolesFresh();
    if (!feed || feed.status !== 'active' || !permissionsFor(feed.roles).has('calendar.view') || !permissionsFor(feed.roles).has('calendar.subscribe')) {
      reply.header('cache-control', 'no-store');
      return reply.status(404).send({ error: 'not_found', message: 'Diesen Kalender gibt es nicht (mehr).' });
    }
    const now = Date.now();
    const occ = await occurrences(new Date(now - FEED_PAST_DAYS * 86_400_000), new Date(now + FEED_FUTURE_DAYS * 86_400_000));
    const cats: string[] = feed.categories ?? [];
    const list = occ.filter((o) => !cats.length || (o.row.category_id && cats.includes(o.row.category_id)));
    const s = await getSettings();
    const tz = await calendarTimeZone();
    const host = (() => {
      try {
        return new URL(String(s['general.public_url'] || 'http://blaulichtcms.local')).hostname;
      } catch {
        return 'blaulichtcms.local';
      }
    })();
    const ics = buildIcs(
      String(s['general.instance_name'] || 'BlaulichtCMS'),
      list.slice(0, 5000).map((o) => ({
        uid: `${o.row.id}${o.instance != null && o.row.rrule ? `-${o.instance}` : ''}@${host}`,
        start: o.start,
        end: o.end,
        allDay: o.row.all_day,
        summary: o.row.title,
        description: feed.include_description ? o.row.description : undefined,
        location: feed.include_description ? o.row.location : undefined,
        categories: o.row.cat_name ? [o.row.cat_name] : undefined,
        lastModified: +o.row.updated_at,
      })),
      tz,
    );
    // Nutzung höchstens alle 10 Minuten vermerken
    await pool.query(`UPDATE calendar_feeds SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '10 minutes')`, [feed.id]);
    reply.header('content-type', 'text/calendar; charset=utf-8').header('cache-control', 'private, no-store').header('content-disposition', 'inline; filename="kalender.ics"').header('x-robots-tag', 'noindex');
    return ics;
  });
}
