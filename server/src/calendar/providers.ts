import { many, one, tx } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { openPressDeadlines } from '../press/deadlines.js';
import { POST_STATE_SQL, postState, revisionHash } from '../routes/posts.js';
import { registerCalendarProvider, type CalendarEntry } from './store.js';

/**
 * Einträge anderer Module im Kalender (#201): geplante Beiträge samt sozialer Kanäle und Fristen von Presseanfragen.
 */

export const POST_STATE_LABEL: Record<string, string> = {
  draft: 'Entwurf',
  in_review: 'zur Freigabe',
  approved: 'freigegeben',
  rejected: 'zurückgewiesen',
  scheduled: 'freigegeben, Veröffentlichung beauftragt',
  publishing: 'wird veröffentlicht',
  published: 'veröffentlicht',
  failed: 'Veröffentlichung fehlgeschlagen',
  unknown: 'Ergebnis unbekannt',
  deactivated: 'zurückgezogen',
};

const SOCIAL_LABEL: Record<string, string> = { queued: 'geplant', publishing: 'wird veröffentlicht', published: 'veröffentlicht', failed: 'fehlgeschlagen', unknown: 'Ergebnis unbekannt', canceled: 'abgebrochen' };

/** Zustände, in denen ein Beitrag nicht mehr per Kalender verschoben werden kann. */
const FIXED_STATES = new Set(['scheduled', 'publishing', 'published', 'unknown', 'deactivated']);

/** Geplante Beiträge (Termin der aktuellen Fassung) im Zeitraum. */
export async function postEntries(from: Date, to: Date, canMove: boolean): Promise<CalendarEntry[]> {
  const rows = await many<any>(
    `SELECT x.*, r.publish_at, r.social_targets, r.number
       FROM (${POST_STATE_SQL}) x JOIN post_revisions r ON r.id = x.revision_id
      WHERE x.archived_at IS NULL AND r.publish_at >= $1 AND r.publish_at < $2
      ORDER BY r.publish_at LIMIT 1000`,
    [from, to],
  );
  if (!rows.length) return [];
  const targets = [...new Set(rows.flatMap((r) => r.social_targets ?? []))];
  const conns = targets.length ? await many<{ id: string; name: string; kind: string }>(`SELECT id, name, kind FROM connections WHERE id = ANY($1)`, [targets]) : [];
  const connName = new Map(conns.map((c) => [c.id, c]));
  const social = await many<{ revision_id: string; connection_id: string; status: string }>(
    `SELECT DISTINCT ON (revision_id, connection_id) revision_id, connection_id, status FROM social_publications WHERE revision_id = ANY($1) ORDER BY revision_id, connection_id, created_at DESC`,
    [rows.map((r) => r.revision_id)],
  );
  return rows.map((r) => {
    const at = new Date(r.publish_at).toISOString();
    const channels = [
      ...(r.site_name ? [{ name: r.site_name, kind: 'website', status: null as string | null }] : []),
      ...((r.social_targets ?? []) as string[]).map((id) => {
        const c = connName.get(id);
        const s = social.find((x) => x.revision_id === r.revision_id && x.connection_id === id);
        return { name: c?.name ?? 'Kanal', kind: c?.kind ?? 'social', status: s ? SOCIAL_LABEL[s.status] ?? s.status : null };
      }),
    ];
    const socialBusy = social.some((s) => s.revision_id === r.revision_id && ['queued', 'publishing', 'unknown'].includes(s.status));
    const movable = canMove && !FIXED_STATES.has(r.state) && !socialBusy;
    return {
      key: `post:${r.id}`,
      kind: 'post',
      id: r.id,
      seriesId: null,
      instance: null,
      title: r.rev_title,
      start: at,
      end: at,
      allDay: false,
      location: '',
      description: channels.length ? `Kanäle: ${channels.map((c) => `${c.name}${c.status ? ` (${c.status})` : ''}`).join(', ')}` : 'Noch kein Kanal gewählt.',
      category: null,
      tags: [],
      source: 'post',
      sourceId: null,
      sourceName: 'Beitrag',
      recurring: false,
      readOnly: !movable,
      color: 'post',
      status: r.state,
      statusLabel: POST_STATE_LABEL[r.state] ?? r.state,
      link: `/beitraege/${r.id}`,
      movable,
      meta: { revision: r.number, channels, approved: ['approved', 'scheduled', 'publishing', 'published'].includes(r.state), submitted: r.state === 'in_review' },
    } satisfies CalendarEntry;
  });
}

/**
 * Termin eines Beitrags verschieben. Der Termin gehört zur Fassung (Prüfsumme): Es entsteht eine neue Fassung mit
 * neuem Termin; eine Freigabe der bisherigen Fassung gilt dann nicht mehr (bestehende Regeln, Vier-Augen-Prinzip
 * unverändert – ein verschobener Termin zählt nicht als Schreiben am Inhalt).
 */
export async function reschedulePost(postId: string, input: { revision: number; publishAt: string }, actor: Actor, userId: string | null) {
  const at = new Date(input.publishAt);
  if (Number.isNaN(at.getTime())) throw badRequest('Kein gültiger Zeitpunkt.');
  if (at.getTime() < Date.now() - 60_000) throw badRequest('Der neue Termin liegt in der Vergangenheit.');
  return tx(async (db) => {
    const post = await one<any>('SELECT * FROM posts WHERE id = $1 FOR UPDATE', [postId], db);
    if (!post) throw notFound('Beitrag nicht gefunden.');
    if (post.archived_at) throw badRequest('Der Beitrag ist archiviert.');
    const st = (await postState(postId, db))!;
    const cur = st.current;
    if (cur.number !== input.revision) throw conflict(`Der Beitrag wurde inzwischen geändert (aktuell Fassung ${cur.number}). Bitte neu laden.`, { current: cur.number });
    if (FIXED_STATES.has(st.state)) throw new AppError(409, 'publication_running', 'Die Veröffentlichung ist bereits beauftragt oder erfolgt. Den Termin bitte im Beitrag ändern (vorher den Auftrag abbrechen).');
    const busy = await one(`SELECT 1 FROM social_publications WHERE revision_id = $1 AND status IN ('queued','publishing','unknown') LIMIT 1`, [cur.id], db);
    if (busy) throw new AppError(409, 'publication_running', 'Eine Veröffentlichung in sozialen Kanälen ist bereits beauftragt. Den Termin bitte im Beitrag ändern.');
    if (cur.publish_at && new Date(cur.publish_at).getTime() === at.getTime()) return { changed: false, number: cur.number, approvalInvalidated: false, wasSubmitted: false };
    const next = { title: cur.title, body: cur.body, excerpt: cur.excerpt, media_ids: cur.media_ids, cover_id: cur.cover_id, site_id: cur.site_id, variants: cur.variants, publish_at: at, social_targets: cur.social_targets ?? [], social_formats: cur.social_formats ?? {} };
    const hash = revisionHash(next);
    const number = cur.number + 1;
    await db.query(
      `INSERT INTO post_revisions (post_id, number, title, body, excerpt, media_ids, cover_id, site_id, content_hash, change_note, created_by, variants, publish_at, social_targets, social_formats) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [postId, number, cur.title, cur.body, cur.excerpt, cur.media_ids, cur.cover_id, cur.site_id, hash, 'Termin im Kalender verschoben', userId, JSON.stringify(cur.variants ?? {}), at, cur.social_targets ?? [], JSON.stringify(cur.social_formats ?? {})],
    );
    await db.query('UPDATE posts SET current_revision = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [postId, number, userId]);
    const approvalInvalidated = !!st.validApproval;
    await audit(actor, 'post.revised', { type: 'post', id: postId, label: cur.title }, { fassung: number, freigabe_entfaellt: approvalInvalidated, termin: at.toISOString(), quelle: 'Kalender' }, 'ok', db);
    return { changed: true, number, approvalInvalidated, wasSubmitted: !!cur.submitted_at };
  });
}

registerCalendarProvider({
  id: 'post',
  label: 'Geplante Beiträge',
  permission: 'post.view',
  list: (from, to, ctx) => postEntries(from, to, ctx.permissions.has('post.edit')),
});

const PRESS_STATUS: Record<string, string> = { new: 'neu', in_progress: 'in Bearbeitung' };

registerCalendarProvider({
  id: 'press',
  label: 'Fristen von Presseanfragen',
  permission: 'press.view',
  list: async (from, to) =>
    (await openPressDeadlines({ from, to, limit: 1000 })).map((d) => ({
      key: `press:${d.id}`,
      kind: 'press',
      id: d.id,
      seriesId: null,
      instance: null,
      // Thema zuerst (#272): in der Monatsansicht bleibt sonst nur „Frist P-2026-000…“ stehen; die Vorgangsnummer
      // steht im Detail (meta.caseNo)
      title: `Frist: ${d.topic}`,
      start: d.due_at,
      end: d.due_at,
      allDay: false,
      location: '',
      description: [d.outlet ? `Medium: ${d.outlet}` : '', d.assignee_name ? `Zuständig: ${d.assignee_name}` : 'Noch niemand zuständig'].filter(Boolean).join('\n'),
      category: null,
      tags: [],
      source: 'press',
      sourceId: null,
      sourceName: 'Presseanfrage',
      recurring: false,
      readOnly: true,
      color: 'press',
      status: d.status,
      statusLabel: PRESS_STATUS[d.status] ?? d.status,
      link: d.link,
      overdue: d.overdue,
      meta: { caseNo: d.case_no },
    })),
});
