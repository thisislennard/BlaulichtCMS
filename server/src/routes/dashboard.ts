import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { AppError, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { activeRole, activeRoles, roleExists } from '../auth/permissions.js';
import { POST_STATE_SQL } from './posts.js';
import { availableWidgets, defaultProfile, layoutIssues, normalizeLayout, resolveLayout, type DashboardModule } from '../lib/dashboard-layout.js';
import { insightsOverview } from './insights.js';
import { APPROVAL_LIST_PERMISSIONS, approvalOverview } from '../approvals/pending.js';
import { warningState } from './warnings.js';
import { entryState } from '../incidents/list.js';
import { calendarProviders, calendarTimeZone, occurrences, toEntry, type CalendarEntry } from '../calendar/store.js';
import { localDate, midnight } from '../calendar/recurrence.js';

const DAY_MS = 86_400_000;

/**
 * Module ohne Einrichtung bzw. ohne jeden Eintrag (#254): ihre Kacheln fehlen in der mitgelieferten Standardansicht,
 * bis das Modul genutzt wird – dann erscheinen sie von selbst. Eine Abfrage mit EXISTS je Modul.
 */
export async function unusedModules(): Promise<Set<DashboardModule>> {
  const r = (await one<Record<DashboardModule, boolean>>(
    `SELECT EXISTS (SELECT 1 FROM wp_sites WHERE status <> 'revoked') AS website,
            EXISTS (SELECT 1 FROM rss_feeds) AS rss,
            EXISTS (SELECT 1 FROM calendar_events) OR EXISTS (SELECT 1 FROM calendar_sources) AS calendar,
            EXISTS (SELECT 1 FROM press_requests) OR EXISTS (SELECT 1 FROM settings WHERE key = 'press.mailbox' AND value IS NOT NULL AND value <> 'null'::jsonb) AS press,
            EXISTS (SELECT 1 FROM warnings) OR EXISTS (SELECT 1 FROM connections WHERE kind = 'warnfeed' AND deleted_at IS NULL) AS warnings,
            EXISTS (SELECT 1 FROM incident_entries) OR EXISTS (SELECT 1 FROM connections WHERE kind IN ('fe2','feuersoftware') AND deleted_at IS NULL) AS incidents,
            EXISTS (SELECT 1 FROM automations WHERE deleted_at IS NULL) AS automations,
            EXISTS (SELECT 1 FROM connections WHERE deleted_at IS NULL) AS connections,
            EXISTS (SELECT 1 FROM connections WHERE kind NOT IN ('fe2','feuersoftware','warnfeed') AND deleted_at IS NULL) AS social`,
  ))!;
  return new Set((Object.keys(r) as DashboardModule[]).filter((k) => !r[k]));
}

/** Kalender der nächsten 7 Tage (#254): eigene und eingelesene Termine plus Einträge der Anbieter mit Recht (Presse-Fristen, geplante Beiträge). */
async function upcomingCalendar(perms: ReadonlySet<string>, userId: string | null, log: { warn: (o: unknown, m: string) => void }) {
  const tz = await calendarTimeZone();
  const now = Date.now();
  const today = localDate(now, tz);
  const from = new Date(midnight(today, tz));
  const to = new Date(+from + 8 * DAY_MS);
  const entries: CalendarEntry[] = perms.has('calendar.view') ? (await occurrences(from, to)).map(toEntry) : [];
  for (const p of calendarProviders()) {
    if (!perms.has(p.permission)) continue;
    try {
      entries.push(...(await p.list(from, to, { permissions: new Set(perms), userId })));
    } catch (e) {
      log.warn({ err: e }, `Kalender-Anbieter ${p.id} fehlgeschlagen`);
    }
  }
  // Ganztägige Termine enden um Mitternacht des Folgetags; „heute“ = beginnt heute oder läuft heute noch
  const endDay = (e: CalendarEntry) => localDate(Date.parse(e.end) - (e.allDay && Date.parse(e.end) > Date.parse(e.start) ? 1 : 0), tz);
  const isToday = (e: CalendarEntry) => localDate(Date.parse(e.start), tz) <= today && endDay(e) >= today;
  const sevenDays = now + 7 * DAY_MS;
  // Überfällige Presse-Fristen bleiben sichtbar (sie liegen vor „jetzt“), sonst nur, was noch nicht vorbei ist
  const upcoming = entries
    .filter((e) => (e.overdue || Date.parse(e.end) >= now || (e.allDay && endDay(e) >= today)) && Date.parse(e.start) < sevenDays)
    .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'de'));
  return {
    timeZone: tz,
    today: entries.filter(isToday).length,
    total: upcoming.length,
    upcoming: upcoming.slice(0, 8).map((e) => ({ key: e.key, kind: e.kind, id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, link: e.link ?? (e.kind === 'event' ? `/kalender?termin=${e.id}` : null), overdue: !!e.overdue, color: e.category?.color ?? e.color ?? null, today: isToday(e) })),
  };
}

export async function dashboardRoutes(app: FastifyInstance) {
  /** Erstes Dashboard: offene Freigaben, bestätigter Veröffentlichungsstand, Medieneingang, Kanäle. */
  app.get('/dashboard', { preHandler: requireAuth() }, async (req) => {
    const perms = req.auth!.permissions;
    const userId = req.auth!.user?.id ?? null;
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
    // Freigaben über alle Arten (#251): dieselbe Quelle wie die Freigaben-Liste und der Zähler in der Kopfzeile –
    // Kennzahl, Begrüßung und Redaktionsfluss zählen damit Banner, Einsatzliste, Warnentwürfe, Presse und Workflows mit
    if (APPROVAL_LIST_PERMISSIONS.some((p) => perms.has(p))) out.approvals = await approvalOverview(req.auth!);
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
      // Was auf der Website steht: die zuletzt übertragene Fassung. Eine neuere Fassung in Freigabe (z. B. Aktualisierung
      // aus einem Workflow, #274) ändert daran nichts, bis sie veröffentlicht ist.
      out.banners = await many<any>(
        `SELECT id, title, tone, priority, ends_at, site_name FROM (
           SELECT b.id, live.p->>'title' AS title, live.p->>'tone' AS tone, (live.p->>'priority')::int AS priority,
                  (live.p->>'starts_at')::timestamptz AS starts_at, (live.p->>'ends_at')::timestamptz AS ends_at, s.name AS site_name
             FROM banners b JOIN wp_sites s ON s.id = b.site_id
             JOIN LATERAL (SELECT j.payload AS p FROM banner_jobs j WHERE j.banner_id = b.id AND j.action = 'upsert' AND j.status = 'done'
                            ORDER BY j.created_at DESC LIMIT 1) live ON true
            WHERE b.ended_at IS NULL) x
          WHERE ends_at > now() AND starts_at <= now()
          ORDER BY priority DESC, starts_at DESC LIMIT 10`,
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
    if (perms.has('post.edit') && userId) {
      // Meine Entwürfe (#254): eigene, noch nicht eingereichte oder zurückgewiesene Beiträge
      out.myDrafts = await many<any>(
        `SELECT x.id, x.rev_title AS title, x.current_revision AS number, x.state, x.updated_at, count(*) OVER ()::int AS total
           FROM (${POST_STATE_SQL} WHERE p.archived_at IS NULL AND (p.created_by = $1 OR r.created_by = $1)) x
          WHERE x.state IN ('draft','rejected') ORDER BY x.state = 'rejected' DESC, x.updated_at DESC LIMIT 6`,
        [userId],
      );
    }
    if (perms.has('calendar.view')) {
      out.calendar = await upcomingCalendar(perms, userId, req.log);
    }
    if (perms.has('press.view')) {
      // Mir zugewiesene Presseanfragen (#254), überfällige zuerst, dann nach Frist; ohne Kontaktdaten
      out.myPress = await many<any>(
        `SELECT r.id, r.case_no, r.topic, r.outlet, r.status, r.due_at, (r.due_at < now()) AS overdue, count(*) OVER ()::int AS total
           FROM press_requests r WHERE r.assignee_id = $1 AND r.status IN ('new','in_progress')
          ORDER BY (r.due_at < now()) DESC, r.due_at ASC NULLS LAST, r.created_at DESC LIMIT 6`,
        [userId],
      );
      out.pressUnassigned = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM press_requests WHERE assignee_id IS NULL AND status IN ('new','in_progress')`))!.n;
    }
    if (perms.has('warning.view') || perms.has('official.view')) {
      const w: Record<string, unknown> = {};
      if (perms.has('warning.view')) {
        // Offene Warnvorgänge: alles, was noch nicht versandt ist (Zustand wie in der Liste, #184)
        const rows = await many<any>(
          `SELECT w.id, w.case_no, w.kind, w.current_revision, w.updated_at, r.data->>'headline' AS headline,
                  r.id AS rev_id, r.content_hash AS rev_hash, r.submitted_at AS rev_submitted_at,
                  a.decision AS a_decision, a.content_hash AS a_hash, a.decided_at AS a_decided_at,
                  s.revision_id AS s_revision_id, s.status AS s_status, s.resolution AS s_resolution, s.acknowledged_at AS s_acknowledged_at
             FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision
             LEFT JOIN LATERAL (SELECT decision, content_hash, decided_at FROM warning_approvals WHERE revision_id = r.id ORDER BY decided_at DESC LIMIT 1) a ON true
             LEFT JOIN LATERAL (SELECT revision_id, status, resolution, acknowledged_at FROM warning_sends WHERE warning_id = w.id ORDER BY created_at DESC LIMIT 1) s ON true
            WHERE w.archived_at IS NULL AND w.updated_at > now() - interval '30 days' ORDER BY w.updated_at DESC LIMIT 100`,
        );
        // Was die Person tun kann, steht vorn: Freigabe (warning.approve), Versand (warning.send), sonst Entwürfe
        const rank = (st: string) =>
          ['send_failed', 'send_unknown'].includes(st) ? 0 : st === 'in_review' && perms.has('warning.approve') ? 1 : st === 'approved' && perms.has('warning.send') ? 2 : ['draft', 'rejected'].includes(st) ? 3 : 4;
        const open = rows
          .map((r) => ({
            id: r.id,
            case_no: r.case_no,
            kind: r.kind,
            headline: r.headline,
            number: r.current_revision,
            updated_at: r.updated_at,
            state: warningState(
              { id: r.rev_id, content_hash: r.rev_hash, submitted_at: r.rev_submitted_at },
              r.a_decision ? { decision: r.a_decision, content_hash: r.a_hash, decided_at: r.a_decided_at } : null,
              r.s_status ? { revision_id: r.s_revision_id, status: r.s_status, resolution: r.s_resolution, acknowledged_at: r.s_acknowledged_at } : null,
            ).state,
          }))
          .filter((x) => !['sent', 'acknowledged'].includes(x.state))
          .sort((a, b) => rank(a.state) - rank(b.state));
        w.cases = open.slice(0, 5);
        w.casesTotal = open.length;
      }
      if (perms.has('official.view')) {
        // Gültige amtliche Warnungen (nicht ausgeblendet, nicht aufgehoben/ersetzt, nicht abgelaufen), neueste zuerst
        const official = await many<any>(
          `SELECT w.id, w.severity, w.event, w.headline, w.in_area, w.expires_at, w.received_at, count(*) OVER ()::int AS total
             FROM official_warnings w
            WHERE w.dismissed_at IS NULL AND NOT w.cancelled AND w.superseded_by IS NULL AND w.msg_type <> 'Cancel'
              AND (w.expires_at IS NULL OR w.expires_at > now())
            ORDER BY w.in_area DESC, w.received_at DESC LIMIT 4`,
        );
        w.official = official;
        w.officialTotal = official[0]?.total ?? 0;
      }
      out.warnings = w;
    }
    if (perms.has('incident.view')) {
      // Einsatzliste (#254): zur Freigabe, freigegeben (noch nicht übergeben) und Übertragungsfehler
      const rows = await many<any>(
        `SELECT e.id, e.title, e.keyword, e.alarm_at, e.revision, e.content_hash, e.approved_hash, e.submitted_at, e.withdrawn_at,
                j.status AS job_status, j.action AS job_action, j.revision AS job_revision, j.error AS job_error
           FROM incident_entries e
           LEFT JOIN LATERAL (SELECT status, action, revision, error FROM incident_jobs WHERE entry_id = e.id AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1) j ON true
          WHERE e.submitted_at IS NOT NULL OR j.status = 'failed'
          ORDER BY e.alarm_at DESC LIMIT 200`,
      );
      const items = rows
        .map((e) => ({ id: e.id, title: e.title, keyword: e.keyword, alarm_at: e.alarm_at, error: e.job_status === 'failed' ? e.job_error : null, state: entryState(e, e.job_status ? { status: e.job_status, action: e.job_action, revision: e.job_revision } : null) }))
        .filter((e) => ['in_review', 'approved', 'failed'].includes(e.state));
      const order: Record<string, number> = { failed: 0, in_review: 1, approved: 2 };
      items.sort((a, b) => order[a.state] - order[b.state]);
      out.incidents = { counts: { failed: items.filter((e) => e.state === 'failed').length, in_review: items.filter((e) => e.state === 'in_review').length, approved: items.filter((e) => e.state === 'approved').length }, items: items.slice(0, 6) };
    }
    if (perms.has('automation.read')) {
      // Workflows mit Fehlern (#254): fehlgeschlagene Läufe der letzten 7 Tage je Workflow (Testläufe zählen nicht)
      out.automations = {
        failed: await many<any>(
          `SELECT a.id, a.name, count(*)::int AS failures, max(r.finished_at) AS last_failed_at,
                  (array_agg(r.error ORDER BY r.created_at DESC))[1] AS last_error
             FROM automation_runs r JOIN automations a ON a.id = r.automation_id
            WHERE r.status = 'failed' AND r.mode = 'live' AND r.created_at > now() - interval '7 days' AND a.deleted_at IS NULL
            GROUP BY a.id, a.name ORDER BY max(r.created_at) DESC LIMIT 6`,
        ),
        enabled: (await getSettings())['automations.enabled'] !== false,
      };
    }
    // Bewusst nicht hier (#254/#255): Kennzahl „Dienste“ nutzt GET /system/status (dieselbe Abfrage wie die Statuszeile)
    // und die Kachel „BlaulichtCMS startklar“ GET /setup/checklist – beide nur, wenn sie auf dem Dashboard stehen. Die
    // Kopfzeile fragt GET /dashboard regelmäßig für den Freigabe-Zähler ab; das soll leicht bleiben.
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
    // Mitgelieferte Standardansicht (#254): erste passende Rolle; eigene Rollen nach ihren Rechten
    const profile = defaultProfile(a.roles, (id) => {
      const r = activeRole(id);
      return r ? new Set(r.permissions) : undefined;
    });
    const { layout, source } = resolveLayout({ personal: (a.user?.preferences as any)?.dashboard, shared, roles: a.roles, perms: a.permissions, profile, unused: await unusedModules() });
    return {
      layout,
      source,
      /** Profil der mitgelieferten Standardansicht (für „Standard wiederherstellen“ und die Begrüßung neuer Konten) */
      profile,
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
