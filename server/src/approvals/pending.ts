import { many, pool, type Queryable } from '../db/pool.js';
import { getSettings } from '../lib/settings.js';
import { POST_STATE_SQL, postAuthoredSql, reviewLink } from '../routes/posts.js';
import { bannerLink } from '../routes/banners.js';
import { warningAuthoredSql, warningState } from '../routes/warnings.js';
import { entryState, incidentLink } from '../incidents/list.js';

/**
 * Freigaben über alle Arten (#251): Beiträge, Banner, Einträge der Einsatzliste, Warnentwürfe, Antworten an die Presse
 * und Freigabeschritte aus Workflows. Diese Datei sammelt nur, was offen ist – entschieden wird weiter über die
 * bestehenden Endpunkte der jeweiligen Art mit all ihren Regeln (Prüfsumme, Vier-Augen, Datenschutz-Prüfung).
 *
 * Eine Abfrage je Art liefert die offenen Vorgänge; dieselbe Abfrage speist die Freigaben-Liste, den Zähler in der
 * Kopfzeile, die Kennzahl und Begrüßung im Dashboard (GET /approvals/pending, GET /dashboard) und die gebündelten
 * Benachrichtigungen (approvals/notices.ts). Ohne das passende Recht erscheint eine Art gar nicht.
 */
export type ApprovalKind = 'post' | 'banner' | 'incident' | 'warning' | 'press' | 'automation';

export interface ApprovalKindDef {
  kind: ApprovalKind;
  /** Recht zum Entscheiden */
  permission: string;
  /** Bezeichnung in der Spalte „Art“ */
  label: string;
  /** Bezeichnung im Filter */
  many: string;
  /** Wert im Adressparameter `?art=` der Freigaben-Liste */
  param: string;
}

export const APPROVAL_KINDS: readonly ApprovalKindDef[] = [
  { kind: 'post', permission: 'approval.post', label: 'Beitrag', many: 'Beiträge', param: 'beitrag' },
  { kind: 'banner', permission: 'approval.banner', label: 'Banner', many: 'Banner', param: 'banner' },
  { kind: 'incident', permission: 'approval.incident', label: 'Einsatzliste', many: 'Einsatzliste', param: 'einsatzliste' },
  { kind: 'warning', permission: 'warning.approve', label: 'Warnentwurf', many: 'Warnung', param: 'warnung' },
  { kind: 'press', permission: 'press.approve', label: 'Presseantwort', many: 'Presse', param: 'presse' },
  { kind: 'automation', permission: 'approval.automation', label: 'Workflow', many: 'Workflows', param: 'workflow' },
];
export const approvalKind = (kind: string) => APPROVAL_KINDS.find((k) => k.kind === kind);

/** Rechte, mit denen die Freigaben-Liste etwas zeigt (Entscheiden oder Veröffentlichen freigegebener Vorgänge). */
export const READY_PERMISSIONS: Record<'post' | 'banner' | 'incident' | 'warning', string[]> = {
  post: ['publish.website', 'publish.social'],
  banner: ['banner.publish'],
  incident: ['incident.publish'],
  warning: ['warning.send'],
};
export const APPROVAL_LIST_PERMISSIONS = [...APPROVAL_KINDS.map((k) => k.permission), ...new Set(Object.values(READY_PERMISSIONS).flat())];

export interface PendingItem {
  kind: ApprovalKind;
  id: string;
  title: string;
  /** Fassung (Workflow-Freigaben und Presseantworten haben keine) */
  revision: number | null;
  submitted_at: string;
  submitted_by_name: string | null;
  /** bestehende Prüfansicht der Art */
  link: string;
  /** Vier-Augen-Prinzip: warum diese Person nicht entscheiden darf (sonst null) – erscheint ausgegraut statt zu fehlen */
  blocked: string | null;
  /** Angaben je Art für die Anzeige (Website, Stichwort, Vorgangsnummer …) */
  meta: Record<string, unknown>;
}

export interface ReadyItem {
  kind: 'post' | 'banner' | 'incident' | 'warning';
  id: string;
  title: string;
  revision: number;
  approved_at: string | null;
  approved_by_name: string | null;
  link: string;
  meta: Record<string, unknown>;
}

interface Viewer {
  userId: string | null;
  fourEyes: boolean;
}

const LIMIT = 200;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/**
 * Offene Vorgänge einer Art, neueste zuerst. Mit `viewer` wird je Vorgang geprüft, ob diese Person wegen des
 * Vier-Augen-Prinzips nicht entscheiden darf (dieselben Regeln wie die Endpunkte der Entscheidung).
 */
export async function pendingOf(kind: ApprovalKind, viewer: Viewer | null = null, db: Queryable = pool): Promise<PendingItem[]> {
  const uid = viewer?.userId ?? null;
  const four = !!viewer?.fourEyes && !!uid;
  switch (kind) {
    case 'post': {
      // wie postState(): eingereicht, nicht archiviert, keine (nicht widerrufene) Entscheidung seit dem Einreichen
      const rows = await many<any>(
        `SELECT p.id, p.kind, r.title, r.number, r.submitted_at, su.name AS by_name, s.name AS site_name,
                ($1::boolean AND (r.submitted_by = $2::uuid OR ${postAuthoredSql('p.id', 'r.number', '$2::uuid')})) AS own
           FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
           LEFT JOIN users su ON su.id = r.submitted_by LEFT JOIN wp_sites s ON s.id = r.site_id
          WHERE p.archived_at IS NULL AND r.submitted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id = r.id AND a.revoked_at IS NULL AND a.decided_at >= r.submitted_at)
          ORDER BY r.submitted_at DESC LIMIT ${LIMIT}`,
        [four, uid],
        db,
      );
      return rows.map((r) => ({
        kind,
        id: r.id,
        title: r.title,
        revision: r.number,
        submitted_at: iso(r.submitted_at)!,
        submitted_by_name: r.by_name ?? null,
        link: reviewLink(r.id, r.number),
        blocked: r.own ? 'Selbst geschrieben oder eingereicht – Vier-Augen-Prinzip' : null,
        meta: { post_kind: r.kind, site_name: r.site_name ?? null },
      }));
    }
    case 'banner': {
      // Abgelaufene Banner lassen sich nicht mehr schalten – sie warten auf nichts mehr
      const rows = await many<any>(
        `SELECT b.id, b.title, b.revision, b.submitted_at, b.tone, b.starts_at, b.ends_at, su.name AS by_name, s.name AS site_name,
                ($1::boolean AND COALESCE($2::uuid = ANY(ARRAY[b.created_by, b.updated_by, b.submitted_by]), false)) AS own
           FROM banners b JOIN wp_sites s ON s.id = b.site_id LEFT JOIN users su ON su.id = b.submitted_by
          WHERE b.submitted_at IS NOT NULL AND b.ended_at IS NULL AND b.ends_at > now() AND b.approved_hash IS DISTINCT FROM b.content_hash
          ORDER BY b.submitted_at DESC LIMIT ${LIMIT}`,
        [four, uid],
        db,
      );
      return rows.map((r) => ({
        kind,
        id: r.id,
        title: r.title,
        revision: r.revision,
        submitted_at: iso(r.submitted_at)!,
        submitted_by_name: r.by_name ?? null,
        link: bannerLink(r.id),
        blocked: r.own ? 'Selbst angelegt, geändert oder eingereicht – Vier-Augen-Prinzip' : null,
        meta: { tone: r.tone, starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), site_name: r.site_name },
      }));
    }
    case 'incident': {
      const rows = await many<any>(
        `SELECT e.id, e.title, e.revision, e.submitted_at, e.keyword, e.location, e.alarm_at, e.content_hash, e.approved_hash, e.withdrawn_at, su.name AS by_name,
                j.status AS job_status, j.action AS job_action, j.revision AS job_revision,
                ($1::boolean AND COALESCE($2::uuid = ANY(ARRAY[e.created_by, e.updated_by, e.submitted_by]), false)) AS own
           FROM incident_entries e LEFT JOIN users su ON su.id = e.submitted_by
           LEFT JOIN LATERAL (SELECT status, action, revision FROM incident_jobs WHERE entry_id = e.id AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1) j ON true
          WHERE e.submitted_at IS NOT NULL AND e.approved_hash IS DISTINCT FROM e.content_hash
          ORDER BY e.submitted_at DESC LIMIT ${LIMIT}`,
        [four, uid],
        db,
      );
      return rows
        .filter((r) => entryState(r, r.job_status ? { status: r.job_status, action: r.job_action, revision: r.job_revision } : null) === 'in_review')
        .map((r) => ({
          kind,
          id: r.id,
          title: r.title,
          revision: r.revision,
          submitted_at: iso(r.submitted_at)!,
          submitted_by_name: r.by_name ?? null,
          link: incidentLink(r.id),
          blocked: r.own ? 'Selbst angelegt, geändert oder eingereicht – Vier-Augen-Prinzip' : null,
          meta: { keyword: r.keyword, location: r.location, alarm_at: iso(r.alarm_at) },
        }));
    }
    case 'warning': {
      const rows = await many<any>(
        `SELECT w.id, w.case_no, w.kind, r.number, r.submitted_at, r.data->>'headline' AS headline, (r.level_decision->>'level')::int AS level, su.name AS by_name,
                ($1::boolean AND (r.submitted_by = $2::uuid OR ${warningAuthoredSql('w.id', 'r.number', '$2::uuid')})) AS own
           FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision
           LEFT JOIN users su ON su.id = r.submitted_by
          WHERE w.archived_at IS NULL AND r.submitted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM warning_approvals a WHERE a.revision_id = r.id AND a.decision = 'approved' AND a.content_hash = r.content_hash)
          ORDER BY r.submitted_at DESC LIMIT ${LIMIT}`,
        [four, uid],
        db,
      );
      return rows.map((r) => ({
        kind,
        id: r.id,
        title: r.headline ? `${r.case_no} · ${r.headline}` : r.case_no,
        revision: r.number,
        submitted_at: iso(r.submitted_at)!,
        submitted_by_name: r.by_name ?? null,
        // Schritt „Prüfen & PDF“ des Vorgangs
        link: `/warnungen/${r.id}?schritt=pruefen`,
        blocked: r.own ? 'Selbst geschrieben oder eingereicht – Vier-Augen-Prinzip' : null,
        meta: { case_no: r.case_no, warning_kind: r.kind, level: r.level ?? null, headline: r.headline ?? '' },
      }));
    }
    case 'press': {
      // Die eigene Antwort gibt immer eine zweite Person frei – unabhängig von der Einstellung zum Vier-Augen-Prinzip
      const rows = await many<any>(
        `SELECT m.id, m.subject, m.created_at, m.request_id, r.case_no, r.topic, su.name AS by_name, ($1::uuid IS NOT NULL AND m.submitted_by = $1::uuid) AS own
           FROM press_messages m JOIN press_requests r ON r.id = m.request_id LEFT JOIN users su ON su.id = m.submitted_by
          WHERE m.direction = 'out' AND m.status = 'pending'
          ORDER BY m.created_at DESC LIMIT ${LIMIT}`,
        [uid],
        db,
      );
      return rows.map((r) => ({
        kind,
        id: r.id,
        title: r.subject || r.case_no,
        revision: null,
        submitted_at: iso(r.created_at)!,
        submitted_by_name: r.by_name ?? null,
        link: `/presse/${r.request_id}?antwort=${r.id}`,
        blocked: r.own ? 'Eigene Antwort – eine zweite Person gibt frei' : null,
        meta: { case_no: r.case_no, request_id: r.request_id, topic: r.topic },
      }));
    }
    case 'automation': {
      const rows = await many<any>(
        `SELECT ap.id, ap.kind, ap.title, ap.summary, ap.created_at, ap.expires_at, ap.run_id, a.id AS automation_id, a.name AS automation_name,
                ($1::boolean AND COALESCE($2::uuid = ANY(ARRAY[a.updated_by, v.activated_by]), false)) AS own
           FROM automation_approvals ap JOIN automations a ON a.id = ap.automation_id JOIN automation_runs r ON r.id = ap.run_id
           LEFT JOIN automation_versions v ON v.automation_id = a.id AND v.version = r.version
          WHERE ap.status = 'pending' AND ap.expires_at > now()
          ORDER BY ap.created_at DESC LIMIT ${LIMIT}`,
        [four, uid],
        db,
      );
      return rows.map((r) => ({
        kind,
        id: r.id,
        title: r.title,
        revision: null,
        submitted_at: iso(r.created_at)!,
        submitted_by_name: null,
        link: `/freigaben?workflow=${r.id}`,
        blocked: r.own ? 'Workflow selbst geändert oder aktiviert – Vier-Augen-Prinzip' : null,
        meta: { automation_id: r.automation_id, automation_name: r.automation_name, expires_at: iso(r.expires_at), summary: r.summary, approval_kind: r.kind, run_id: r.run_id },
      }));
    }
  }
}

/** Freigegeben und bereit zur Veröffentlichung bzw. zum Versand – nur für Personen mit dem passenden Recht. */
export async function readyOf(kind: ReadyItem['kind'], perms: ReadonlySet<string>, db: Queryable = pool): Promise<ReadyItem[]> {
  switch (kind) {
    case 'post': {
      const web = perms.has('publish.website');
      const social = perms.has('publish.social');
      // Nur, was ein Veröffentlichungsziel hat, das die Person bedienen darf (rein interne Beiträge warten auf nichts)
      const rows = await many<any>(
        `SELECT x.id, x.rev_title, x.current_revision, x.site_id, x.site_name, x.a_decided_at,
                (SELECT cardinality(social_targets) FROM post_revisions WHERE id = x.revision_id) AS n_social,
                (SELECT u.name FROM approvals a JOIN users u ON u.id = a.decided_by WHERE a.revision_id = x.revision_id AND a.revoked_at IS NULL ORDER BY a.decided_at DESC LIMIT 1) AS by_name
           FROM (${POST_STATE_SQL} WHERE p.archived_at IS NULL) x
          WHERE x.state = 'approved' ORDER BY x.a_decided_at DESC LIMIT ${LIMIT}`,
        [],
        db,
      );
      return rows
        .filter((r) => (web && r.site_id) || (social && (r.n_social ?? 0) > 0))
        .map((r) => ({ kind, id: r.id, title: r.rev_title, revision: r.current_revision, approved_at: iso(r.a_decided_at), approved_by_name: r.by_name ?? null, link: `/beitraege/${r.id}`, meta: { site_name: r.site_name ?? null, social: r.n_social ?? 0 } }));
    }
    case 'banner': {
      const rows = await many<any>(
        `SELECT b.id, b.title, b.revision, b.approved_at, b.tone, b.starts_at, b.ends_at, u.name AS by_name, s.name AS site_name
           FROM banners b JOIN wp_sites s ON s.id = b.site_id LEFT JOIN users u ON u.id = b.approved_by
          WHERE b.ended_at IS NULL AND b.ends_at > now() AND b.approved_hash = b.content_hash
            AND NOT EXISTS (SELECT 1 FROM banner_jobs j WHERE j.banner_id = b.id AND j.revision = b.revision AND j.action = 'upsert' AND j.status IN ('queued','sent','done'))
          ORDER BY b.approved_at DESC LIMIT ${LIMIT}`,
        [],
        db,
      );
      return rows.map((r) => ({ kind, id: r.id, title: r.title, revision: r.revision, approved_at: iso(r.approved_at), approved_by_name: r.by_name ?? null, link: bannerLink(r.id), meta: { tone: r.tone, starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), site_name: r.site_name } }));
    }
    case 'incident': {
      const rows = await many<any>(
        `SELECT e.id, e.title, e.revision, e.approved_at, e.keyword, e.location, e.alarm_at, e.content_hash, e.approved_hash, e.submitted_at, e.withdrawn_at, u.name AS by_name,
                j.status AS job_status, j.action AS job_action, j.revision AS job_revision
           FROM incident_entries e LEFT JOIN users u ON u.id = e.approved_by
           LEFT JOIN LATERAL (SELECT status, action, revision FROM incident_jobs WHERE entry_id = e.id AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1) j ON true
          WHERE e.approved_hash = e.content_hash AND e.site_id IS NOT NULL
          ORDER BY e.approved_at DESC LIMIT ${LIMIT}`,
        [],
        db,
      );
      return rows
        .filter((r) => entryState(r, r.job_status ? { status: r.job_status, action: r.job_action, revision: r.job_revision } : null) === 'approved')
        .map((r) => ({ kind, id: r.id, title: r.title, revision: r.revision, approved_at: iso(r.approved_at), approved_by_name: r.by_name ?? null, link: incidentLink(r.id), meta: { keyword: r.keyword, location: r.location, alarm_at: iso(r.alarm_at) } }));
    }
    case 'warning': {
      const rows = await many<any>(
        `SELECT w.id, w.case_no, w.kind, r.id AS rev_id, r.number, r.content_hash, r.submitted_at, r.data->>'headline' AS headline,
                a.decision AS a_decision, a.content_hash AS a_hash, a.decided_at AS a_decided_at, au.name AS by_name,
                s.revision_id AS s_revision_id, s.status AS s_status, s.resolution AS s_resolution, s.acknowledged_at AS s_acknowledged_at
           FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision
           LEFT JOIN LATERAL (SELECT decision, content_hash, decided_at, decided_by FROM warning_approvals WHERE revision_id = r.id ORDER BY decided_at DESC LIMIT 1) a ON true
           LEFT JOIN users au ON au.id = a.decided_by
           LEFT JOIN LATERAL (SELECT revision_id, status, resolution, acknowledged_at FROM warning_sends WHERE warning_id = w.id ORDER BY created_at DESC LIMIT 1) s ON true
          WHERE w.archived_at IS NULL AND a.decision = 'approved' AND a.content_hash = r.content_hash
          ORDER BY a.decided_at DESC LIMIT ${LIMIT}`,
        [],
        db,
      );
      return rows
        .filter(
          (r) =>
            warningState(
              { id: r.rev_id, content_hash: r.content_hash, submitted_at: r.submitted_at },
              { decision: r.a_decision, content_hash: r.a_hash, decided_at: r.a_decided_at },
              r.s_status ? { revision_id: r.s_revision_id, status: r.s_status, resolution: r.s_resolution, acknowledged_at: r.s_acknowledged_at } : null,
            ).state === 'approved',
        )
        .map((r) => ({ kind, id: r.id, title: r.headline ? `${r.case_no} · ${r.headline}` : r.case_no, revision: r.number, approved_at: iso(r.a_decided_at), approved_by_name: r.by_name ?? null, link: `/warnungen/${r.id}?schritt=versand`, meta: { case_no: r.case_no, warning_kind: r.kind } }));
    }
  }
}

export interface ApprovalOverview {
  /** Arten, über die die Person entscheiden darf, mit Anzahl (alle) und offen (ohne Vier-Augen-Sperre) */
  kinds: { kind: ApprovalKind; label: string; many: string; param: string; count: number; open: number }[];
  /** offene Vorgänge aller dieser Arten, neueste zuerst */
  items: PendingItem[];
  /** freigegeben und bereit zur Veröffentlichung bzw. zum Versand (nur mit dem passenden Recht) */
  ready: ReadyItem[];
  /** alle offenen Vorgänge */
  total: number;
  /** davon kann die Person entscheiden – „wartet auf dich“ (Zähler in der Kopfzeile mit `ready`) */
  open: number;
}

/** Alles, was auf die Person wartet – Grundlage für Freigaben-Liste, Kopfzeile und Dashboard. */
export async function approvalOverview(auth: { permissions: ReadonlySet<string>; user: { id: string } | null }, db: Queryable = pool): Promise<ApprovalOverview> {
  const perms = auth.permissions;
  const viewer: Viewer = { userId: auth.user?.id ?? null, fourEyes: !!(await getSettings())['editorial.four_eyes'] };
  const defs = APPROVAL_KINDS.filter((k) => perms.has(k.permission));
  const lists = await Promise.all(defs.map((k) => pendingOf(k.kind, viewer, db)));
  const items = lists.flat().sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const readyKinds = (Object.keys(READY_PERMISSIONS) as ReadyItem['kind'][]).filter((k) => READY_PERMISSIONS[k].some((p) => perms.has(p)));
  const ready = (await Promise.all(readyKinds.map((k) => readyOf(k, perms, db)))).flat().sort((a, b) => String(b.approved_at ?? '').localeCompare(String(a.approved_at ?? '')));
  return {
    kinds: defs.map((k, i) => ({ kind: k.kind, label: k.label, many: k.many, param: k.param, count: lists[i].length, open: lists[i].filter((x) => !x.blocked).length })),
    items,
    ready,
    total: items.length,
    open: items.filter((x) => !x.blocked).length,
  };
}
