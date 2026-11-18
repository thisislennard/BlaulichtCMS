import { one, tx, type Queryable } from '../db/pool.js';
import { log } from '../lib/log.js';
import { scheduleDelivery } from '../lib/notify.js';
import { plural } from '../lib/text.js';
import { APPROVAL_KINDS, approvalKind, pendingOf, type ApprovalKind, type PendingItem } from './pending.js';

/*
 * Benachrichtigungen „Freigabe angefordert“ (#253): eine Meldung je Art statt einer je Vorgang, die den offenen Stand
 * abbildet.
 *
 *  - Einreichen (`added`): Gibt es zur Art eine offene Meldung, wird sie aktualisiert (Anzahl, Titel, Link) und ist für
 *    alle wieder ungelesen – sonst entsteht eine neue. Push/E-Mail gehen nur hinaus, wenn die Meldung neu ist oder
 *    länger als BURST_MS ruhig war; eine Importwelle oder Unwetternacht ergibt so eine Mitteilung statt dreißig.
 *  - Entscheiden, Zurückziehen, Ändern, Löschen: Die Meldung zählt nur noch die offenen Vorgänge; ist keiner mehr offen,
 *    gilt sie als erledigt (resolved_at, „Erledigt – freigegeben von …“) und zählt bei niemandem mehr als ungelesen.
 *  - Der Worker gleicht regelmäßig ab (sweepApprovalNotices) – auch für Wege ohne eigenen Aufruf (Frist abgelaufen,
 *    Banner abgelaufen) und für ältere Einzelmeldungen von vor dieser Änderung.
 *
 * Titel und Text folgen den bisherigen Einzelmeldungen; nach außen (Push, E-Mail) gehen sie unverändert nur mit
 * notify.push_details bzw. notify.mail_details, sonst nur „Freigabe angefordert“ und der Link (lib/notify-channels.ts).
 */
const BURST_MS = 10 * 60_000;
const LOCK_BASE = 74_253_000;

const groupKey = (kind: ApprovalKind) => `approval:${kind}`;

interface NoticeText {
  title: string;
  body: string;
  link: string;
}

/** Text der Meldung für genau einen offenen Vorgang (wie die bisherigen Einzelmeldungen). */
function singleText(i: PendingItem, body?: string): NoticeText {
  const by = i.submitted_by_name ? ` · eingereicht von ${i.submitted_by_name}` : '';
  switch (i.kind) {
    case 'post':
      return { title: `Freigabe erbeten: ${i.title}`, body: body ?? `Fassung ${i.revision}${by}`, link: i.link };
    case 'banner':
      return { title: `Banner zur Freigabe: ${i.title}`, body: body ?? `Fassung ${i.revision}${by}`, link: i.link };
    case 'incident':
      return { title: `Einsatzliste: Freigabe erbeten – ${i.title}`, body: body ?? `Fassung ${i.revision}${by}`, link: i.link };
    case 'warning':
      return { title: `Warnentwurf zur Freigabe: ${i.meta.case_no}`, body: String(i.meta.headline ?? ''), link: i.link };
    case 'press':
      return { title: `Antwort zur Freigabe: ${i.meta.case_no}`, body: i.title, link: i.link };
    case 'automation':
      return { title: `Freigabe erbeten: ${i.title}`, body: `Aus dem Workflow „${i.meta.automation_name}“.`, link: i.link };
  }
}

/** Gebündelte Meldung für mehrere offene Vorgänge einer Art; der Link führt auf die passend gefilterte Liste. */
function bundleText(kind: ApprovalKind, items: PendingItem[]): NoticeText {
  const n = items.length;
  const latest = `Zuletzt: ${items[0].kind === 'warning' ? String(items[0].meta.case_no) : items[0].title}`;
  const list = `/freigaben?art=${approvalKind(kind)!.param}`;
  switch (kind) {
    case 'post':
      return { title: `Beiträge: ${plural(n, 'Fassung wartet', 'Fassungen warten')} auf Freigabe`, body: latest, link: list };
    case 'banner':
      return { title: `${plural(n, 'Banner wartet', 'Banner warten')} auf Freigabe`, body: latest, link: list };
    case 'incident':
      // Einsatzliste: dort lassen sich mehrere Einträge auf einmal freigeben
      return { title: `Einsatzliste: ${plural(n, 'Eintrag wartet', 'Einträge warten')} auf Freigabe`, body: latest, link: '/einsatzliste?stand=in_review&jahr=alle' };
    case 'warning':
      return { title: `${plural(n, 'Warnentwurf wartet', 'Warnentwürfe warten')} auf Freigabe`, body: latest, link: list };
    case 'press':
      return { title: `${plural(n, 'Antwort an die Presse wartet', 'Antworten an die Presse warten')} auf Freigabe`, body: latest, link: list };
    case 'automation':
      return { title: `Workflows: ${plural(n, 'Freigabe wartet', 'Freigaben warten')}`, body: latest, link: list };
  }
}

export interface RefreshOptions {
  /** gerade eingereichte Vorgänge – macht die Meldung für alle wieder ungelesen und legt sie bei Bedarf an */
  added?: string[];
  /** Text statt des Standardtexts, solange genau dieser eine Vorgang offen ist (z. B. „Aus dem Workflow …“) */
  body?: string;
  /** Vermerk, wenn dadurch nichts mehr offen ist (z. B. „freigegeben von Sam“) */
  note?: string;
}

/**
 * Meldung einer Art an den offenen Stand anpassen. Fehler blockieren nie die auslösende Aktion (nur Protokoll).
 */
export async function refreshApprovalNotice(kind: ApprovalKind, opts: RefreshOptions = {}): Promise<void> {
  try {
    await refresh(kind, opts);
  } catch (e) {
    log('warn', 'notify', `Freigabe-Benachrichtigung (${kind}) nicht aktualisiert: ${(e as Error).message}`);
  }
}

async function refresh(kind: ApprovalKind, opts: RefreshOptions) {
  const def = approvalKind(kind)!;
  const deliver = await tx(async (db) => {
    // Gleichzeitige Einreichungen derselben Art legen nicht zwei Meldungen an
    await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_BASE + APPROVAL_KINDS.indexOf(def)]);
    const items = await pendingOf(kind, null, db);
    await resolveLegacy(kind, items, opts.note, db);
    const open = await one<{ id: number; updated_at: Date | null; created_at: Date }>(
      `SELECT id, updated_at, created_at FROM notifications WHERE group_key = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`,
      [groupKey(kind)],
      db,
    );
    if (!items.length) {
      if (open) await db.query(`UPDATE notifications SET resolved_at = now(), resolved_note = $2 WHERE id = $1`, [open.id, (opts.note ?? 'nicht mehr offen').slice(0, 200)]);
      return null;
    }
    const added = (opts.added ?? []).filter((id) => items.some((i) => i.id === id));
    const text = items.length === 1 ? singleText(items[0], added.includes(items[0].id) ? opts.body : undefined) : bundleText(kind, items);
    const objectId = items.length === 1 ? items[0].id : null;
    if (!open) {
      if (!added.length) return null; // Abgleich ohne neue Einreichung kündigt nichts an
      const row = await one<{ id: number }>(
        `INSERT INTO notifications (kind, title, body, link, permission, category, group_key, count, updated_at, object_type, object_id)
         VALUES ($1,$2,$3,$4,$5,'approval',$6,$7,now(),$8,$9) RETURNING id`,
        [kind === 'warning' ? 'warning' : 'info', text.title.slice(0, 200), text.body.slice(0, 1000), text.link, def.permission, groupKey(kind), items.length, kind, objectId],
        db,
      );
      return row!.id;
    }
    await db.query(
      `UPDATE notifications SET title = $2, body = $3, link = $4, count = $5, object_id = $6, updated_at = CASE WHEN $7 THEN now() ELSE updated_at END WHERE id = $1`,
      [open.id, text.title.slice(0, 200), text.body.slice(0, 1000), text.link, items.length, objectId, added.length > 0],
    );
    if (!added.length) return null;
    // Neue Einreichung: für alle wieder ungelesen; Push/E-Mail nur nach einer ruhigen Phase (keine Flut bei Importen)
    await db.query(`DELETE FROM notification_reads WHERE notification_id = $1`, [open.id]);
    const last = new Date(open.updated_at ?? open.created_at).getTime();
    return Date.now() - last > BURST_MS ? open.id : null;
  });
  if (deliver) await scheduleDelivery(deliver);
}

/**
 * Einzelmeldungen von vor der Bündelung (Migration 225): mit Objektbezug erledigt, sobald der Vorgang nicht mehr offen
 * ist; ohne Objektbezug (Sammelmeldungen, Workflows), sobald kein offener Vorgang der Art älter als die Meldung ist.
 */
async function resolveLegacy(kind: ApprovalKind, items: PendingItem[], note: string | undefined, db: Queryable) {
  const ids = items.map((i) => i.id);
  const oldest = items.length ? items.reduce((m, i) => (i.submitted_at < m ? i.submitted_at : m), items[0].submitted_at) : null;
  await db.query(
    `UPDATE notifications SET resolved_at = now(), resolved_note = $4
      WHERE object_type = $1 AND group_key IS NULL AND resolved_at IS NULL
        AND ((object_id IS NOT NULL AND NOT (object_id = ANY($2::text[]))) OR (object_id IS NULL AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)))`,
    [kind, ids, oldest, (note ?? 'nicht mehr offen').slice(0, 200)],
  );
}

/** Worker: alle Arten abgleichen (Frist abgelaufen, Banner abgelaufen, Wege ohne eigenen Aufruf). */
export async function sweepApprovalNotices(): Promise<void> {
  for (const k of APPROVAL_KINDS) await refreshApprovalNotice(k.kind);
}

/** Vermerk für die Entscheidung einer Person, z. B. „freigegeben von Sam Freigabe“. */
export const decidedBy = (decision: 'approved' | 'rejected', name: string | null | undefined) => `${decision === 'approved' ? 'freigegeben' : 'zurückgewiesen'}${name ? ` von ${name}` : ''}`;
