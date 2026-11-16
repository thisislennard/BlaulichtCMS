import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { AppError, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { activeRoles, roleExists } from '../auth/permissions.js';
import { POST_STATE_SQL } from './posts.js';
import { availableWidgets, layoutIssues, normalizeLayout, resolveLayout } from '../lib/dashboard-layout.js';
import { insightsOverview } from './insights.js';

export async function dashboardRoutes(app: FastifyInstance) {
  /** Erstes Dashboard: offene Freigaben, bestätigter Veröffentlichungsstand, Medieneingang, Kanäle. */
  app.get('/dashboard', { preHandler: requireAuth() }, async (req) => {
    const perms = req.auth!.permissions;
    const out: Record<string, unknown> = {};
    if (perms.has('post.view')) {
      const submitted = await many<any>(
        `SELECT p.id, r.title, r.number, r.submitted_at, u.name AS submitted_by_name
           FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
           LEFT JOIN users u ON u.id = r.submitted_by
          WHERE p.archived_at IS NULL AND r.submitted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id = r.id AND a.revoked_at IS NULL AND a.decided_at >= r.submitted_at)
          ORDER BY r.submitted_at LIMIT 20`,
      );
      out.pendingApprovals = submitted;
      const readyToPublish = await many<any>(
        `SELECT x.id, x.rev_title AS title, x.current_revision AS number, x.site_id FROM (${POST_STATE_SQL} WHERE p.archived_at IS NULL) x
          WHERE x.state = 'approved' ORDER BY x.updated_at DESC LIMIT 20`,
      );
      out.readyToPublish = readyToPublish;
      out.publications = await many<any>(
        `SELECT pb.id, pb.post_id, pb.status, pb.action, pb.run_at, pb.remote_url, pb.error, pb.created_at, pb.fetched_at, pb.result_at, r.title, r.number AS revision_number, s.name AS site_name
           FROM publications pb JOIN post_revisions r ON r.id = pb.revision_id JOIN wp_sites s ON s.id = pb.site_id
          ORDER BY pb.created_at DESC LIMIT 15`,
      );
    }
    if (perms.has('channel.view')) {
      out.sites = await many<any>(`SELECT id, name, status, site_url, last_seen_at, plugin_version FROM wp_sites WHERE status <> 'revoked' ORDER BY name`);
    }
    if (perms.has('media.view')) {
      out.media = await one<any>(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
                count(*) FILTER (WHERE status = 'quarantine')::int AS quarantine,
                count(*) FILTER (WHERE status = 'ready' AND selection = 'pending')::int AS unreviewed,
                count(*) FILTER (WHERE status = 'rejected' AND created_at > now() - interval '7 days')::int AS rejected_7d
           FROM media WHERE deleted_at IS NULL`,
      );
      out.recentCollections = await many<any>(
        `SELECT c.id, c.title, max(m.created_at) AS last_upload, count(m.id)::int AS uploads
           FROM collections c JOIN media m ON m.collection_id = c.id AND m.deleted_at IS NULL
          WHERE m.created_at > now() - interval '7 days' GROUP BY c.id ORDER BY last_upload DESC LIMIT 6`,
      );
    }
    if (perms.has('banner.view')) {
      out.banners = await many<any>(
        `SELECT b.id, b.title, b.tone, b.priority, b.ends_at, s.name AS site_name FROM banners b JOIN wp_sites s ON s.id = b.site_id
          WHERE b.ended_at IS NULL AND b.ends_at > now() AND b.starts_at <= now()
            AND EXISTS (SELECT 1 FROM banner_jobs j WHERE j.banner_id = b.id AND j.action = 'upsert' AND j.revision = b.revision AND j.status = 'done')
          ORDER BY b.priority DESC, b.starts_at DESC LIMIT 10`,
      );
    }
    if (perms.has('source.view')) {
      out.rss = await many<any>(
        `SELECT i.id, i.title, i.link, i.published_at, i.starred_at, f.title AS feed_title FROM rss_items i JOIN rss_feeds f ON f.id = i.feed_id
          WHERE i.hidden_at IS NULL ORDER BY COALESCE(i.published_at, i.fetched_at) DESC LIMIT 8`,
      );
    }
    if (perms.has('press.view')) {
      // Presseanfragen (#204): offene Anfragen nach Frist, ohne Kontaktdaten
      out.press = {
        counts: await one<any>(
          `SELECT count(*) FILTER (WHERE status IN ('new','in_progress'))::int AS open,
                  count(*) FILTER (WHERE status IN ('new','in_progress') AND due_at < now())::int AS overdue,
                  count(*) FILTER (WHERE assignee_id = $1 AND status IN ('new','in_progress'))::int AS mine
             FROM press_requests`,
          [req.auth!.user?.id ?? null],
        ),
        open: await many<any>(
          `SELECT r.id, r.case_no, r.topic, r.outlet, r.status, r.due_at, u.name AS assignee_name, (r.due_at < now()) AS overdue
             FROM press_requests r LEFT JOIN users u ON u.id = r.assignee_id
            WHERE r.status IN ('new','in_progress') ORDER BY r.due_at ASC NULLS LAST, r.created_at DESC LIMIT 8`,
        ),
      };
    }
    if (perms.has('insights.view')) {
      // Reichweite der letzten 7 Tage (#218): Summen und die drei Beiträge mit den meisten Interaktionen
      const o = await insightsOverview(7, null, 3);
      out.insights = { days: o.days, publications: o.publications, measured: o.measured, totals: o.totals, interactions: o.interactions, top: o.top.map((t) => ({ post_id: t.post_id, title: t.title, interactions: t.interactions, views: t.views, kinds: [...new Set(t.channels.map((c) => c.kind))] })) };
    }
    if (perms.has('connection.configure')) {
      // Aktive Verbindungen, deren letzter Abruf oder Versand fehlgeschlagen ist (Kennzahl „Verbindungsfehler“)
      out.connectionErrors = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM connections WHERE status = 'active' AND deleted_at IS NULL AND last_error IS NOT NULL`))!.n;
    }
    out.confirmedAt = new Date().toISOString();
    return out;
  });

  /* ------------------------------ Dashboard-Layout ------------------------------ */

  /**
   * Layout der Person: persönlich → Rollenvorlage → Vorlage für alle → Standard. Immer normalisiert (auch Layouts im
   * Format vor 0.2.4) und auf die eigenen Rechte gefiltert; `widgets` nennt alles, was die Person einblenden darf.
   */
  app.get('/dashboard/layout', { preHandler: requireAuth() }, async (req) => {
    const a = req.auth!;
    const s = await getSettings();
    const shared = (s['dashboard.layouts'] ?? {}) as Record<string, unknown>;
    const { layout, source } = resolveLayout({ personal: (a.user?.preferences as any)?.dashboard, shared, roles: a.roles, perms: a.permissions });
    return {
      layout,
      source,
      widgets: availableWidgets(a.permissions),
      // Nur mit „Dashboard-Vorlagen speichern“: für wen es gemeinsame Vorlagen gibt ('*' = alle) und welche Rollen
      // (mitgelieferte und eigene) zur Auswahl stehen
      templates: a.permissions.has('dashboard.templates') ? Object.keys(shared).filter((k) => shared[k]) : undefined,
      templateRoles: a.permissions.has('dashboard.templates') ? activeRoles().map((r) => ({ id: r.id, label: r.label })) : undefined,
    };
  });

  app.put('/dashboard/layout', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ scope: z.enum(['personal', 'role', 'all']).default('personal'), role: z.string().max(40).optional(), layout: z.unknown().nullable() }).parse(req.body);
    const a = req.auth!;
    if (body.layout != null) {
      const issues = layoutIssues(body.layout);
      if (issues.length) throw badRequest(`Das Dashboard-Layout ist ungültig: ${issues[0].message}`, { issues });
    }
    if (body.scope === 'personal') {
      if (!a.user) throw badRequest('Nur für Benutzerkonten.');
      // Gespeichert wird nur, was die Person sehen darf – Unbekanntes und Unerlaubtes fällt still weg.
      const layout = body.layout != null ? normalizeLayout(body.layout, a.permissions) : null;
      if (layout) await pool.query(`UPDATE users SET preferences = preferences || jsonb_build_object('dashboard', $2::jsonb) WHERE id = $1`, [a.user.id, JSON.stringify(layout)]);
      else await pool.query(`UPDATE users SET preferences = preferences - 'dashboard' WHERE id = $1`, [a.user.id]);
      return { ok: true, layout };
    }
    if (!a.permissions.has('dashboard.templates')) throw new AppError(403, 'forbidden', 'Zum Speichern gemeinsamer Dashboards fehlt das Recht „Dashboard-Vorlagen speichern“.');
    const key = body.scope === 'all' ? '*' : body.role;
    if (!key || (key !== '*' && !roleExists(key))) throw badRequest('Unbekannte Rolle.');
    const s = await getSettings(true);
    const layouts = { ...(s['dashboard.layouts'] as Record<string, unknown>) };
    // Vorlagen enthalten alle bekannten Widgets; gefiltert wird beim Ausliefern nach den Rechten der jeweiligen Person.
    if (body.layout != null) layouts[key] = normalizeLayout(body.layout, null);
    else delete layouts[key];
    await setSettings({ 'dashboard.layouts': layouts } as any, a.user?.id ?? null);
    await audit(a.actor, 'dashboard.shared_saved', { type: 'settings', label: key === '*' ? 'alle' : key });
    return { ok: true };
  });

  /** QR-Code lokal erzeugen (SVG). Der Code enthält nur die URL – Rechte, Ablauf und Widerruf gelten weiter. */
  app.post('/qr', { preHandler: requireAuth(), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    if (!/^https?:\/\//i.test(text)) throw badRequest('Nur Web-Adressen können als QR-Code angezeigt werden.');
    const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } });
    return reply.type('image/svg+xml').header('cache-control', 'private, max-age=600').send(svg);
  });
}
