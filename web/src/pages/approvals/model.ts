import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format';

/**
 * Freigaben über alle Arten (#251) – Daten aus GET /approvals/pending (server/src/approvals/pending.ts). Dieselbe
 * Quelle speist die Freigaben-Liste, den Zähler in der Kopfzeile und (über GET /dashboard) Kennzahl, Begrüßung und
 * Redaktionsfluss.
 */
export type ApprovalKind = 'post' | 'banner' | 'incident' | 'warning' | 'press' | 'automation';

export interface PendingItem {
  kind: ApprovalKind;
  id: string;
  title: string;
  revision: number | null;
  submitted_at: string;
  submitted_by_name: string | null;
  link: string;
  blocked: string | null;
  meta: Record<string, any>;
}

export interface ReadyItem {
  kind: 'post' | 'banner' | 'incident' | 'warning';
  id: string;
  title: string;
  revision: number;
  approved_at: string | null;
  approved_by_name: string | null;
  link: string;
  meta: Record<string, any>;
}

export interface ApprovalOverview {
  kinds: { kind: ApprovalKind; label: string; many: string; param: string; count: number; open: number }[];
  items: PendingItem[];
  ready: ReadyItem[];
  total: number;
  open: number;
}

/** Rechte, mit denen die Seite Freigaben etwas zeigt (wie APPROVAL_LIST_PERMISSIONS im Server). */
export const APPROVAL_PAGE_PERMS = ['approval.post', 'approval.banner', 'approval.incident', 'approval.automation', 'warning.approve', 'press.approve', 'publish.website', 'publish.social', 'banner.publish', 'incident.publish', 'warning.send'];

export const KIND_LABEL: Record<ApprovalKind, string> = { post: 'Beitrag', banner: 'Banner', incident: 'Einsatzliste', warning: 'Warnentwurf', press: 'Presseantwort', automation: 'Workflow' };
export const KIND_ICON: Record<ApprovalKind, string> = { post: 'FileText', banner: 'Megaphone', incident: 'ListOrdered', warning: 'Siren', press: 'MessageSquareQuote', automation: 'Workflow' };

const POST_KIND: Record<string, string> = { news: 'Nachricht', incident: 'Einsatzbericht', event: 'Veranstaltung', situation: 'Lage-Info' };
const TONE: Record<string, string> = { info: 'Hinweis', warning: 'Warnung', danger: 'Gefahr' };
const WARNING_KIND: Record<string, string> = { initial: 'Erstmeldung', update: 'Aktualisierung', all_clear: 'Entwarnung' };

/** Uhrzeit heute, sonst Datum mit Uhrzeit */
const when = (v: string) => (fmtDate(v) === fmtDate(new Date()) ? fmtTime(v) : fmtDateTime(v));

/** Kurze Einordnung je Art, z. B. „Warnung, ab 23:13 · Testseite“ oder „F 2 · Ortsteil Ost“. */
export function approvalDetail(i: { kind: ApprovalKind; meta: Record<string, any> }): string {
  const m = i.meta;
  switch (i.kind) {
    case 'post':
      return [POST_KIND[m.post_kind] ?? '', m.site_name ? `Website ${m.site_name}` : ''].filter(Boolean).join(' · ');
    case 'banner':
      return [`${TONE[m.tone] ?? 'Hinweis'}${m.starts_at ? `, ab ${when(m.starts_at)}` : ''}`, m.site_name].filter(Boolean).join(' · ');
    case 'incident':
      return [m.keyword, m.location, m.alarm_at ? fmtDateTime(m.alarm_at) : ''].filter(Boolean).join(' · ');
    case 'warning':
      return [WARNING_KIND[m.warning_kind] ?? '', m.level ? `Warnstufe ${m.level}` : ''].filter(Boolean).join(' · ');
    case 'press':
      return [m.case_no, m.topic].filter(Boolean).join(' · ');
    case 'automation':
      return [`Workflow „${m.automation_name}“`, m.expires_at ? `Frist bis ${when(m.expires_at)}` : ''].filter(Boolean).join(' · ');
  }
}

/**
 * Fassung als Text: Einträge der Einsatzliste ausgeschrieben („Fassung 2“, weil „F2“ neben Stichwörtern wie „F 2“
 * gelesen würde, Design §6), sonst kurz über `Rev`.
 */
export const spellRevision = (kind: ApprovalKind) => kind === 'incident';

/** Erledigte Freigabe-Anfrage in den Benachrichtigungen (#253): „Erledigt – freigegeben von Sam, 23:10“ */
export function resolvedText(n: { resolved_at?: string | null; resolved_note?: string | null }) {
  if (!n.resolved_at) return '';
  return `Erledigt${n.resolved_note ? ` – ${n.resolved_note}` : ''}, ${fmtTime(n.resolved_at)}`;
}

/** Offene Freigaben der Person (Kopfzeile und Seite Freigaben teilen sich den Stand). */
export function useApprovals() {
  const { me, canAny } = useAuth();
  const fallback = useLive() === 'live' ? 120_000 : 30_000;
  return useQuery({ queryKey: ['approvals-pending'], queryFn: () => get<ApprovalOverview>('/approvals/pending'), enabled: !!me && canAny(...APPROVAL_PAGE_PERMS), refetchInterval: fallback });
}
