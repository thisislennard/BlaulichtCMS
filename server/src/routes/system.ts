import { de1 } from '../lib/num.js';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { proxyService } from '../lib/proxy-check.js';
import { many, one, pool } from '../db/pool.js';
import { assertRecentAuth, requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit, settingsDiff } from '../lib/audit.js';
import { runRetention } from '../lib/retention.js';
import { securityAlert } from '../lib/security-alerts.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { permissionDef, PERMISSIONS, settingPermission } from '../auth/permissions.js';

/** Rechte, mit denen sich überhaupt eine Einstellung ändern lässt; welches je Schlüssel nötig ist: settingPermission. */
const SETTINGS_CHANGE_PERMISSIONS = [...PERMISSIONS.filter((p) => p.module === 'settings' && p.level !== 'read').map((p) => p.id), 'backup.manage'];
import { DEFAULT_SETTINGS, getSettings, SETTING_RANGES, SETTING_TEXT_MAX, setSettings, type SettingKey } from '../lib/settings.js';
import { queueStats } from '../jobs/queue.js';
import { backupPath, BackupRunningError, runBackup } from '../ops/backup.js';
import { normalizePublicUrl } from '../lib/urls.js';
import { CATALOGS, STATE_IDS, stateName } from '../keywords/catalog.js';
import { syncCatalog } from '../keywords/store.js';

const startedAt = Date.now();

/** Einstellungen, die nicht über die allgemeine Einstellungsseite geändert werden dürfen. */
const INTERNAL_KEYS = new Set<SettingKey>([
  'setup.completed', 'dashboard.layouts', 'smtp.password_secret_id', 'smtp.verified', 'system.maintenance',
  // Gestaltung der Upload-Seite: eigene Seite mit eigener Prüfung (routes/media-design.ts)
  'media.upload_design',
  // In-App-Updates: eigene Seite und eigene Prüfung (routes/updates.ts) – Token nie in der allgemeinen Liste
  'updates.enabled', 'updates.repo', 'updates.api_url', 'updates.token_secret_id', 'updates.check_hours',
  'updates.latest', 'updates.last_check_at', 'updates.last_check_error', 'updates.notified_version',
  // E-Mail-Weg, Microsoft 365 und Push: eigene Seite mit Verbindungstest (routes/notify-channels.ts)
  'mail.transport', 'm365.tenant_id', 'm365.client_id', 'm365.sender', 'm365.secret_id', 'm365.save_sent', 'm365.verified',
  'notify.push_enabled', 'notify.mail_enabled', 'push.vapid_public_key', 'push.vapid_secret_id',
]);
/**
 * Versandeinstellungen werden nur über PUT /warning-settings geändert, das sie gemeinsam prüft (SMTP-Verschlüsselung,
 * Anmeldung nur mit TLS, Testpostfach, Server für den Echtbetrieb) – hier abgewiesen (#100). Lesen bleibt möglich.
 */
const DEDICATED_KEYS = new Set<string>(['smtp.host', 'smtp.port', 'smtp.security', 'smtp.user', 'smtp.from', 'warnings.test_mode', 'warnings.test_recipient']);

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
    const st = await fs.promises.statfs(config.dataDir);
    disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    disk = null;
  }
  const settings = await getSettings();
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
      state: disk && disk.free < settings['media.min_free_gb'] * 1024 ** 3 ? 'error' : 'ok',
      detail: disk ? `${de1(disk.free / 1024 ** 3)} GB frei von ${de1(disk.total / 1024 ** 3)} GB` : 'unbekannt',
      ms: null,
    },
    // Proxy-Kette (#192): X-Forwarded-For von einer Adresse außerhalb von TRUSTED_PROXIES
    proxyService(),
  ];
  // Wartungsmodus für die eigene Karte im Systemstatus (Recht system.maintenance, unabhängig von update.install)
  const m = settings['system.maintenance'] as { since: string; byName: string; reason: string } | null | undefined;
  const maintenance = m ? { since: m.since, byName: m.byName, reason: m.reason } : null;
  return { services, workers, queue, sites, lastBackup, disk, dbSize, maintenance, version: config.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version };
}

export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/status', { preHandler: requireAuth('system.status') }, async () => systemStatus());

  app.get('/system/logs', { preHandler: requireAuth('system.logs') }, async (req) => {
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

  app.get('/audit', { preHandler: requireAuth('audit.view') }, async (req) => {
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

  /** Hash-Kette des Audits prüfen (#112): vorher offene Einträge versiegeln, dann die ganze Kette nachrechnen. */
  app.get('/system/audit-integrity', { preHandler: requireAuth('audit.view'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { sealAudit, verifyAudit } = await import('../lib/audit-chain.js');
    await sealAudit();
    const v = await verifyAudit((await getSettings())['retention.audit_days']);
    await audit(req.auth!.actor, 'audit.verified', { type: 'system', label: 'Audit-Kette' }, { eintraege: v.checked, probleme: v.problems.length }, v.ok ? 'ok' : 'failed');
    return { ...v, forward: config.auditForward.mode || null };
  });

  app.get('/settings', { preHandler: requireAuth('settings.view') }, async () => {
    const s = await getSettings(true);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) if (!INTERNAL_KEYS.has(k)) out[k] = s[k];
    return { settings: out, env: { publicUrl: config.publicUrl || null, cookieSecure: config.cookieSecure, trustedProxies: config.trustedProxies, dataDir: config.dataDir } };
  });

  app.patch('/settings', { preHandler: requireAnyAuth(...SETTINGS_CHANGE_PERMISSIONS) }, async (req) => {
    const body = z.record(z.string(), z.any()).parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!(k in DEFAULT_SETTINGS) || INTERNAL_KEYS.has(k as SettingKey)) throw badRequest(`Unbekannte Einstellung „${k}“.`);
      if (!req.auth!.permissions.has(settingPermission(k))) throw forbidden(`Für „${k}“ fehlt das Recht „${permissionDef(settingPermission(k))?.label}“.`);
      if (DEDICATED_KEYS.has(k)) throw badRequest(`„${k}“ wird unter Warnentwurf → Einstellungen (E-Mail-Versand) geändert.`);
      const def = (DEFAULT_SETTINGS as any)[k];
      if (typeof def === 'number') {
        const n = Number(v);
        const [lo, hi] = SETTING_RANGES[k] ?? [0, 100_000];
        if (!Number.isInteger(n) || n < lo || n > hi) throw badRequest(`Ungültiger Wert für „${k}“: erlaubt sind ganze Zahlen von ${lo} bis ${hi}.`);
        patch[k] = n;
      } else if (typeof def === 'boolean') patch[k] = !!v;
      else if (Array.isArray(def)) patch[k] = Array.isArray(v) ? v.map(String).slice(0, 50) : [];
      else patch[k] = String(v ?? '').slice(0, SETTING_TEXT_MAX[k] ?? 200);
      if (k === 'general.instance_name' && !String(patch[k]).trim()) throw badRequest('Der Instanzname darf nicht leer sein.');
    }
    // Sicherheitseinstellungen (2FA-Pflicht, Sperre, Passwortlänge, interne Ziele) nur mit frischer Bestätigung (#109)
    // (nur bei tatsächlicher Änderung – die Oberfläche speichert ganze Abschnitte)
    const current = await getSettings(true);
    if (Object.keys(patch).some((k) => k.startsWith('security.') && JSON.stringify(patch[k]) !== JSON.stringify((current as any)[k]))) assertRecentAuth(req);
    if (patch['general.timezone']) {
      try {
        new Intl.DateTimeFormat('de-DE', { timeZone: String(patch['general.timezone']) });
      } catch {
        throw badRequest('Unbekannte Zeitzone.');
      }
    }
    if (patch['general.state'] != null && patch['general.state'] !== '' && !STATE_IDS.includes(String(patch['general.state']))) throw badRequest('Unbekanntes Bundesland.');
    if (patch['security.password_min_length'] != null && Number(patch['security.password_min_length']) < 10) throw badRequest('Mindestens 10 Zeichen für Passwörter.');
    if (patch['security.session_idle_minutes'] != null && Number(patch['security.session_idle_minutes']) < 5) throw badRequest('Leerlaufzeit mindestens 5 Minuten.');
    if (patch['jobs.concurrency'] != null && (Number(patch['jobs.concurrency']) < 1 || Number(patch['jobs.concurrency']) > 32)) throw badRequest('Parallele Aufträge: 1 bis 32.');
    if (patch['privacy.policy_url'] != null && String(patch['privacy.policy_url']).trim() !== '') {
      const u = String(patch['privacy.policy_url']).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(u)) throw badRequest('Datenschutzerklärung: bitte eine vollständige Adresse mit https:// angeben.');
      patch['privacy.policy_url'] = u;
    }
    if (patch['media.allowed_types'] != null) {
      const { cleanTypeList } = await import('../media/types.js');
      const types = cleanTypeList(patch['media.allowed_types']);
      if (!types.length) throw badRequest('Bitte mindestens einen erlaubten Dateityp wählen.');
      patch['media.allowed_types'] = types;
    }
    if (patch['general.public_url'] != null && patch['general.public_url'] !== '') {
      patch['general.public_url'] = normalizePublicUrl(String(patch['general.public_url']));
    }
    await setSettings(patch as any, req.auth!.user?.id ?? null);
    // Bundesland gewechselt: dessen Stichwortverzeichnis übernehmen, Einträge anderer Verzeichnisse deaktivieren (#195)
    if (patch['general.state'] != null && patch['general.state'] !== current['general.state']) {
      const state = String(patch['general.state']);
      const r = await syncCatalog(state, { activate: true });
      await audit(req.auth!.actor, 'keywords.state_changed', { type: 'keyword', label: stateName(state) || 'nicht gewählt' }, { verzeichnis: CATALOGS[state]?.version ?? null, neu: r.added, geaendert: r.updated, deaktiviert: r.deactivated, eigene: r.ownKept });
    }
    // „Angemeldet bleiben“ abgeschaltet: gemerkte Sitzungen sofort beenden. Die eigene Sitzung bleibt, gilt aber ab
    // jetzt wie eine normale (Leerlauf und Höchstdauer).
    const revoked: Record<string, number> = {};
    if (patch['security.remember_enabled'] === false && current['security.remember_enabled']) {
      const own = req.auth!.sessionId ?? null;
      if (own) await pool.query(`UPDATE sessions SET remember = false, device_hash = NULL, expires_at = LEAST(expires_at, now() + make_interval(hours => $2)) WHERE id = $1`, [own, current['security.session_max_hours']]);
      const r = await pool.query(`UPDATE sessions SET revoked_at = now() WHERE remember AND stage = 'full' AND revoked_at IS NULL AND expires_at > now() AND ($1::uuid IS NULL OR id <> $1)`, [own]);
      revoked.gemerkte_sitzungen = r.rowCount ?? 0;
    }
    // „Zwei-Faktor merken“ abgeschaltet: alle vertrauenswürdigen Geräte widerrufen
    if (patch['security.mfa_remember_enabled'] === false && current['security.mfa_remember_enabled']) {
      const r = await pool.query(`UPDATE trusted_devices SET revoked_at = now() WHERE revoked_at IS NULL`);
      revoked.vertrauenswuerdige_geraete = r.rowCount ?? 0;
    }
    if (Object.keys(revoked).length) await audit(req.auth!.actor, 'settings.remember_revoked', { type: 'settings', label: 'Angemeldet bleiben / Zwei-Faktor merken' }, revoked);
    // Vorher/nachher je geändertem Schlüssel (#111) – z. B. abgeschaltete 2FA-Pflicht, erweiterte interne Ziele,
    // verkürzte Aufbewahrung. Geheimnisse stehen nicht in diesen Einstellungen (SMTP-Passwort separat).
    const changes = settingsDiff(current as any, patch);
    if (Object.keys(changes).length) await audit(req.auth!.actor, 'settings.changed', { type: 'settings', label: Object.keys(changes).join(', ').slice(0, 200) }, { felder: Object.keys(changes), aenderungen: changes });
    // Sicherheits- und Aufbewahrungseinstellungen geändert: Administration informieren (#101)
    const sensitive = Object.entries(changes).filter(([k]) => /^(security|retention)\./.test(k) || /^privacy\..*_days$/.test(k));
    if (sensitive.length) {
      await securityAlert('security_settings', {
        title: `Sicherheitseinstellungen geändert von ${req.auth!.actor.name}`,
        body: sensitive.map(([k, c]) => `${k}: ${JSON.stringify(c.vorher)} → ${JSON.stringify(c.nachher)}`).join('\n').slice(0, 900),
        link: '/protokolle',
      });
    }
    return { ok: true };
  });

  /* Löschfristen (#97): Probelauf „Was würde gelöscht?“ und sofortige Anwendung */
  app.get('/system/retention', { preHandler: requireAuth('settings.view') }, async () => runRetention({ dryRun: true }));
  app.post('/system/retention/run', { preHandler: requireAuth('system.retention'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) =>
    runRetention({ dryRun: false, actor: req.auth!.actor }),
  );

  /* Sicherungen */
  /** Update-Vorabprüfung und Wartungsmodus (Ablauf: Sichern → Wechseln → Prüfen → Wiederherstellen). */
  app.get('/system/update-preflight', { preHandler: requireAuth('update.install') }, async () => {
    const { updatePreflight } = await import('../ops/update.js');
    return updatePreflight();
  });
  app.post('/system/maintenance', { preHandler: requireAuth('system.maintenance') }, async (req) => {
    const b = z.object({ enabled: z.boolean(), reason: z.string().trim().max(200).default('') }).parse(req.body);
    const { setMaintenance } = await import('../ops/update.js');
    await setMaintenance(b.enabled, req.auth!.user?.name ?? 'Administration', b.reason || 'Update wird vorbereitet', req.auth!.user?.id ?? null);
    await audit(req.auth!.actor, b.enabled ? 'system.maintenance_on' : 'system.maintenance_off', { type: 'system', label: 'Wartungsmodus' }, { grund: b.reason || null });
    return { ok: true };
  });

  app.get('/backups', { preHandler: requireAuth('backup.manage') }, async () =>
    many<any>(`SELECT b.*, u.name AS created_by_name FROM backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY started_at DESC LIMIT 50`),
  );

  app.post('/backups', { preHandler: requireAuth('backup.manage') }, async (req) => {
    try {
      const res = await runBackup('manual', req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'backup.created', { type: 'backup', id: res.id, label: res.fileName });
      return res;
    } catch (e) {
      if (e instanceof BackupRunningError) throw badRequest(e.message);
      await audit(req.auth!.actor, 'backup.created', { type: 'backup' }, { fehler: (e as Error).message }, 'failed');
      throw badRequest(`Sicherung fehlgeschlagen: ${(e as Error).message}`);
    }
  });

  app.get('/backups/:id/download', { preHandler: requireAuth('backup.download') }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = await one<any>(`SELECT * FROM backups WHERE id = $1 AND status = 'ok'`, [id]);
    if (!b) throw badRequest('Sicherung nicht gefunden.');
    await audit(req.auth!.actor, 'backup.downloaded', { type: 'backup', id, label: b.file_name });
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${b.file_name}"`);
    return reply.send(fs.createReadStream(backupPath(b.file_name)));
  });

  /* Benachrichtigungen */
  const mutedCategories = async (userId: string | null): Promise<string[]> => {
    if (!userId) return [];
    const p = await one<any>(`SELECT preferences->'mutedNotifications' AS m FROM users WHERE id = $1`, [userId]);
    return Array.isArray(p?.m) ? p.m.map(String) : [];
  };
  app.get('/notifications', { preHandler: requireAuth() }, async (req) => {
    const u = req.auth!;
    // Stummgeschaltete Arten (Mein Konto → Benachrichtigungen, z. B. Medien) ausblenden
    const muted = await mutedCategories(u.user?.id ?? null);
    const rows = await many<any>(
      `SELECT n.*, (r.read_at IS NOT NULL) AS read FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
        WHERE (n.user_id = $1 OR (n.user_id IS NULL AND (n.permission IS NULL OR n.permission = ANY($2))))
          AND n.created_at > now() - interval '60 days' AND (n.category IS NULL OR NOT (n.category = ANY($3::text[])))
        ORDER BY COALESCE(n.updated_at, n.created_at) DESC, n.id DESC LIMIT 100`,
      [u.user?.id ?? null, [...u.permissions], muted],
    );
    return { notifications: rows, unread: rows.filter((r) => !r.read).length };
  });

  app.post('/notifications/read', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ ids: z.array(z.number().int().positive()).max(500).optional(), all: z.boolean().optional() }).parse(req.body);
    const u = req.auth!;
    if (!u.user) return { ok: true };
    if (body.all) {
      await pool.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT n.id, $1 FROM notifications n WHERE (n.user_id = $1 OR (n.user_id IS NULL AND (n.permission IS NULL OR n.permission = ANY($2)))) ON CONFLICT DO NOTHING`,
        [u.user.id, [...u.permissions]],
      );
    } else if (body.ids?.length) {
      // Nur existierende und für die Person sichtbare Benachrichtigungen (#173): inzwischen gelöschte IDs
      // (Aufräumen nach 60 Tagen, gelöschtes Konto) werden still übergangen statt am Fremdschlüssel zu scheitern.
      await pool.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT n.id, $1 FROM notifications n
          WHERE n.id = ANY($2::bigint[]) AND (n.user_id = $1 OR (n.user_id IS NULL AND (n.permission IS NULL OR n.permission = ANY($3))))
         ON CONFLICT DO NOTHING`,
        [u.user.id, body.ids, [...u.permissions]],
      );
    }
    return { ok: true };
  });

  /* Globale Suche (Strg K) */
  app.get('/search', { preHandler: requireAuth() }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const perms = req.auth!.permissions;
    const like = `%${q}%`;
    const out: { type: string; id: string; title: string; subtitle: string; href: string }[] = [];
    if (perms.has('post.view')) {
      for (const p of await many<any>(`SELECT id, title FROM posts WHERE title ILIKE $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 8`, [like])) {
        out.push({ type: 'post', id: p.id, title: p.title, subtitle: 'Beitrag', href: `/beitraege/${p.id}` });
      }
    }
    if (perms.has('media.view')) {
      for (const c of await many<any>(`SELECT id, title FROM collections WHERE title ILIKE $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 6`, [like])) {
        out.push({ type: 'collection', id: c.id, title: c.title, subtitle: 'Sammlung', href: `/medien/${c.id}` });
      }
    }
    if (perms.has('user.view')) {
      for (const u of await many<any>(`SELECT id, name, email FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 5`, [like])) {
        out.push({ type: 'user', id: u.id, title: u.name, subtitle: u.email, href: `/benutzer` });
      }
    }
    return { results: out };
  });
}
