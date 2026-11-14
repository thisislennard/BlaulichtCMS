import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { DEFAULT_SETTINGS, getSettings, setSettings, type SettingKey } from '../lib/settings.js';
import { queueStats } from '../jobs/queue.js';
import { backupPath, runBackup } from '../ops/backup.js';
import { normalizePublicUrl } from '../lib/urls.js';

const startedAt = Date.now();

/** Einstellungen, die nicht über die allgemeine Einstellungsseite geändert werden dürfen. */
const INTERNAL_KEYS = new Set<SettingKey>(['setup.completed', 'dashboard.layouts', 'smtp.password_secret_id']);

export async function systemStatus() {
  const t0 = Date.now();
  let dbOk = true;
  let dbVersion = '';
  let dbSize = 0;
  try {
    const r = await one<any>(`SELECT current_setting('server_version') AS v, pg_database_size(current_database())::bigint AS size`);
    dbVersion = r.v;
    dbSize = Number(r.size);
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - t0;
  const workers = await many<any>(`SELECT worker_id, started_at, last_seen_at, version, jobs_running, info FROM worker_heartbeats WHERE last_seen_at > now() - interval '1 day' ORDER BY last_seen_at DESC`);
  const liveWorkers = workers.filter((w) => Date.now() - new Date(w.last_seen_at).getTime() < 45_000);
  const queue = await queueStats();
  const sites = await many<any>(`SELECT id, name, site_url, status, last_seen_at, plugin_version FROM wp_sites WHERE status <> 'revoked' ORDER BY name`);
  const quarantine = await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE status = 'quarantine' AND deleted_at IS NULL`);
  const lastBackup = await one<any>(`SELECT file_name, status, started_at, finished_at, size_bytes, error FROM backups ORDER BY started_at DESC LIMIT 1`);
  let disk: { free: number; total: number } | null = null;
  try {
    const st = fs.statfsSync(config.dataDir);
    disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    disk = null;
  }
  const services = [
    { id: 'api', name: 'API', state: 'ok', detail: `läuft seit ${Math.round((Date.now() - startedAt) / 60000)} Min.`, ms: null },
    { id: 'db', name: 'Datenbank', state: dbOk ? 'ok' : 'error', detail: dbOk ? `PostgreSQL ${dbVersion}` : 'nicht erreichbar', ms: dbMs },
    {
      id: 'worker',
      name: 'Worker',
      state: liveWorkers.length ? 'ok' : 'error',
      detail: liveWorkers.length ? `${liveWorkers.length} aktiv · ${liveWorkers.reduce((a, w) => a + w.jobs_running, 0)} Aufträge laufen` : 'kein Worker aktiv – Aufträge werden nicht bearbeitet',
      ms: null,
    },
    {
      id: 'queue',
      name: 'Warteschlange',
      state: queue.oldest_ready_sec > 300 ? 'error' : queue.oldest_ready_sec > 60 ? 'warning' : 'ok',
      detail: `${queue.ready} bereit · ${queue.scheduled} geplant · ältester ${queue.oldest_ready_sec} s`,
      ms: null,
    },
    {
      id: 'media',
      name: 'Medienprüfung',
      state: quarantine!.n > 50 ? 'warning' : 'ok',
      detail: `${quarantine!.n} Datei(en) in Quarantäne`,
      ms: null,
    },
    {
      id: 'disk',
      name: 'Speicher',
      state: disk && disk.free < (await getSettings())['media.min_free_gb'] * 1024 ** 3 ? 'error' : 'ok',
      detail: disk ? `${(disk.free / 1024 ** 3).toFixed(1)} GB frei von ${(disk.total / 1024 ** 3).toFixed(1)} GB` : 'unbekannt',
      ms: null,
    },
  ];
  return { services, workers, queue, sites, lastBackup, disk, dbSize, version: config.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version };
}

export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/status', { preHandler: requireAnyAuth('system.read', 'post.read') }, async () => systemStatus());

  app.get('/system/logs', { preHandler: requireAuth('system.read') }, async (req) => {
    const q = z
      .object({ level: z.enum(['all', 'info', 'warn', 'error']).default('all'), source: z.string().max(40).optional(), q: z.string().max(100).optional(), before: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(500).default(100) })
      .parse(req.query);
    const p: unknown[] = [];
    const w: string[] = [];
    if (q.level !== 'all') {
      p.push(q.level === 'info' ? ['info', 'warn', 'error'] : q.level === 'warn' ? ['warn', 'error'] : ['error']);
      w.push(`level = ANY($${p.length})`);
    }
    if (q.source) {
      p.push(q.source);
      w.push(`source = $${p.length}`);
    }
    if (q.q) {
      p.push(`%${q.q}%`);
      w.push(`(message ILIKE $${p.length} OR correlation_id ILIKE $${p.length})`);
    }
    if (q.before) {
      p.push(q.before);
      w.push(`id < $${p.length}`);
    }
    p.push(q.limit);
    const rows = await many<any>(`SELECT * FROM app_logs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT $${p.length}`, p);
    const sources = await many<any>(`SELECT DISTINCT source FROM app_logs WHERE at > now() - interval '30 days' ORDER BY source`);
    return { logs: rows, sources: sources.map((s) => s.source), nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null };
  });

  app.get('/audit', { preHandler: requireAuth('audit.read') }, async (req) => {
    const q = z
      .object({ q: z.string().max(100).optional(), actor: z.string().max(100).optional(), objectType: z.string().max(40).optional(), result: z.enum(['all', 'ok', 'failed', 'denied']).default('all'), before: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(500).default(100) })
      .parse(req.query);
    const p: unknown[] = [];
    const w: string[] = [];
    if (q.q) {
      p.push(`%${q.q}%`);
      w.push(`(action ILIKE $${p.length} OR object_label ILIKE $${p.length} OR actor_name ILIKE $${p.length})`);
    }
    if (q.actor) {
      p.push(q.actor);
      w.push(`actor_name = $${p.length}`);
    }
    if (q.objectType) {
      p.push(q.objectType);
      w.push(`object_type = $${p.length}`);
    }
    if (q.result !== 'all') {
      p.push(q.result);
      w.push(`result = $${p.length}`);
    }
    if (q.before) {
      p.push(q.before);
      w.push(`id < $${p.length}`);
    }
    p.push(q.limit);
    const rows = await many<any>(`SELECT * FROM audit_events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT $${p.length}`, p);
    return { events: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null };
  });

  app.get('/settings', { preHandler: requireAnyAuth('system.read', 'system.manage') }, async () => {
    const s = await getSettings(true);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) if (!INTERNAL_KEYS.has(k)) out[k] = s[k];
    return { settings: out, env: { publicUrl: config.publicUrl || null, cookieSecure: config.cookieSecure, trustProxy: config.trustProxy, dataDir: config.dataDir } };
  });

  app.patch('/settings', { preHandler: requireAuth('system.manage') }, async (req) => {
    const body = z.record(z.string(), z.any()).parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!(k in DEFAULT_SETTINGS) || INTERNAL_KEYS.has(k as SettingKey)) throw badRequest(`Unbekannte Einstellung „${k}“.`);
      const def = (DEFAULT_SETTINGS as any)[k];
      if (typeof def === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100_000) throw badRequest(`Ungültiger Wert für „${k}“.`);
        patch[k] = n;
      } else if (typeof def === 'boolean') patch[k] = !!v;
      else if (Array.isArray(def)) patch[k] = Array.isArray(v) ? v.map(String).slice(0, 50) : [];
      else patch[k] = String(v ?? '').slice(0, 200);
    }
    if (patch['general.timezone']) {
      try {
        new Intl.DateTimeFormat('de-DE', { timeZone: String(patch['general.timezone']) });
      } catch {
        throw badRequest('Unbekannte Zeitzone.');
      }
    }
    if (patch['security.password_min_length'] != null && Number(patch['security.password_min_length']) < 10) throw badRequest('Mindestens 10 Zeichen für Passwörter.');
    if (patch['security.session_idle_minutes'] != null && Number(patch['security.session_idle_minutes']) < 5) throw badRequest('Leerlaufzeit mindestens 5 Minuten.');
    if (patch['jobs.concurrency'] != null && (Number(patch['jobs.concurrency']) < 1 || Number(patch['jobs.concurrency']) > 32)) throw badRequest('Parallele Aufträge: 1 bis 32.');
    if (patch['general.public_url'] != null && patch['general.public_url'] !== '') {
      patch['general.public_url'] = normalizePublicUrl(String(patch['general.public_url']));
    }
    await setSettings(patch as any, req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, 'settings.changed', { type: 'settings' }, { felder: Object.keys(patch) });
    return { ok: true };
  });

  /* Sicherungen */
  app.get('/backups', { preHandler: requireAuth('system.manage') }, async () =>
    many<any>(`SELECT b.*, u.name AS created_by_name FROM backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY started_at DESC LIMIT 50`),
  );

  app.post('/backups', { preHandler: requireAuth('system.manage') }, async (req) => {
    const running = await one(`SELECT 1 FROM backups WHERE status = 'running' AND started_at > now() - interval '1 hour'`);
    if (running) throw badRequest('Es läuft bereits eine Sicherung.');
    try {
      const res = await runBackup('manual', req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'backup.created', { type: 'backup', id: res.id, label: res.fileName });
      return res;
    } catch (e) {
      await audit(req.auth!.actor, 'backup.created', { type: 'backup' }, { fehler: (e as Error).message }, 'failed');
      throw badRequest(`Sicherung fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  app.get('/backups/:id/download', { preHandler: requireAuth('system.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = await one<any>(`SELECT * FROM backups WHERE id = $1 AND status = 'ok'`, [id]);
    if (!b) throw badRequest('Sicherung nicht gefunden.');
    await audit(req.auth!.actor, 'backup.downloaded', { type: 'backup', id, label: b.file_name });
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${b.file_name}"`);
    return reply.send(fs.createReadStream(backupPath(b.file_name)));
  });

  /* Benachrichtigungen */
  app.get('/notifications', { preHandler: requireAuth() }, async (req) => {
    const u = req.auth!;
    const rows = await many<any>(
      `SELECT n.*, (r.read_at IS NOT NULL) AS read FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
        WHERE (n.user_id = $1 OR (n.user_id IS NULL AND (n.permission IS NULL OR n.permission = ANY($2))))
          AND n.created_at > now() - interval '60 days'
        ORDER BY n.id DESC LIMIT 100`,
      [u.user?.id ?? null, [...u.permissions]],
    );
    return { notifications: rows, unread: rows.filter((r) => !r.read).length };
  });

  app.post('/notifications/read', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ ids: z.array(z.number()).max(500).optional(), all: z.boolean().optional() }).parse(req.body);
    const u = req.auth!;
    if (!u.user) return { ok: true };
    if (body.all) {
      await pool.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT n.id, $1 FROM notifications n WHERE (n.user_id = $1 OR (n.user_id IS NULL AND (n.permission IS NULL OR n.permission = ANY($2)))) ON CONFLICT DO NOTHING`,
        [u.user.id, [...u.permissions]],
      );
    } else if (body.ids?.length) {
      await pool.query(`INSERT INTO notification_reads (notification_id, user_id) SELECT unnest($2::bigint[]), $1 ON CONFLICT DO NOTHING`, [u.user.id, body.ids]);
    }
    return { ok: true };
  });

  /* Globale Suche (Strg K) */
  app.get('/search', { preHandler: requireAuth() }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const perms = req.auth!.permissions;
    const like = `%${q}%`;
    const out: { type: string; id: string; title: string; subtitle: string; href: string }[] = [];
    if (perms.has('post.read')) {
      for (const p of await many<any>(`SELECT id, title FROM posts WHERE title ILIKE $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 8`, [like])) {
        out.push({ type: 'post', id: p.id, title: p.title, subtitle: 'Beitrag', href: `/beitraege/${p.id}` });
      }
    }
    if (perms.has('media.read')) {
      for (const c of await many<any>(`SELECT id, title FROM collections WHERE title ILIKE $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 6`, [like])) {
        out.push({ type: 'collection', id: c.id, title: c.title, subtitle: 'Sammlung', href: `/medien/${c.id}` });
      }
    }
    if (perms.has('user.read')) {
      for (const u of await many<any>(`SELECT id, name, email FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 5`, [like])) {
        out.push({ type: 'user', id: u.id, title: u.name, subtitle: u.email, href: `/benutzer` });
      }
    }
    return { results: out };
  });
}
