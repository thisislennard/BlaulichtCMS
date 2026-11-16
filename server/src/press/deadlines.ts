import { many, pool, type Queryable } from '../db/pool.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';

/**
 * Fristen der Presseanfragen (#204).
 *
 * `openPressDeadlines` ist die Abfrage für andere Module (z. B. Kalender #201): offene Anfragen (neu oder in
 * Bearbeitung) mit Frist, wahlweise in einem Zeitraum. Sie liefert nur Vorgangsnummer, Thema, Medium, Frist und
 * Zuständigkeit – keine Kontaktdaten. Anzeigen darf das nur, wer „Presseanfragen ansehen“ (press.view) hat.
 *
 * `checkPressDeadlines` läuft im Worker (Leader, jede Minute): Erinnerung `press.reminder_hours` vor Ablauf und eine
 * Meldung bei Überschreitung – je Anfrage und Frist höchstens einmal (Ändern der Frist setzt die Merker zurück).
 */
export interface PressDeadline {
  id: string;
  case_no: string;
  topic: string;
  outlet: string;
  status: 'new' | 'in_progress';
  due_at: string;
  overdue: boolean;
  assignee_id: string | null;
  assignee_name: string | null;
  /** Adresse in der Oberfläche */
  link: string;
}

export async function openPressDeadlines(opts: { from?: Date; to?: Date; assigneeId?: string; limit?: number } = {}, db: Queryable = pool): Promise<PressDeadline[]> {
  const rows = await many<any>(
    `SELECT r.id, r.case_no, r.topic, r.outlet, r.status, r.due_at, r.assignee_id, u.name AS assignee_name, r.due_at < now() AS overdue
       FROM press_requests r LEFT JOIN users u ON u.id = r.assignee_id
      WHERE r.status IN ('new','in_progress') AND r.due_at IS NOT NULL
        AND ($1::timestamptz IS NULL OR r.due_at >= $1) AND ($2::timestamptz IS NULL OR r.due_at < $2)
        AND ($3::uuid IS NULL OR r.assignee_id = $3)
      ORDER BY r.due_at LIMIT $4`,
    [opts.from ?? null, opts.to ?? null, opts.assigneeId ?? null, Math.min(Math.max(opts.limit ?? 500, 1), 2000)],
    db,
  );
  return rows.map((r) => ({ ...r, due_at: new Date(r.due_at).toISOString(), link: `/presse/${r.id}` }));
}

const fmt = (d: Date, tz: string) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(d);

export async function checkPressDeadlines(): Promise<{ reminded: number; overdue: number }> {
  const s = await getSettings();
  const tz = s['general.timezone'] || 'Europe/Berlin';
  const hours = Math.max(0, Number(s['press.reminder_hours']) || 0);
  let reminded = 0;
  let overdue = 0;
  if (hours > 0) {
    const due = await many<any>(
      `UPDATE press_requests SET due_reminded_at = now()
        WHERE status IN ('new','in_progress') AND due_at IS NOT NULL AND due_reminded_at IS NULL
          AND due_at > now() AND due_at <= now() + make_interval(hours => $1)
        RETURNING id, case_no, topic, due_at, assignee_id`,
      [hours],
    );
    for (const r of due) {
      await notify({ kind: 'warning', title: `Presseanfrage ${r.case_no}: Frist ${fmt(new Date(r.due_at), tz)}`, body: String(r.topic).slice(0, 200), link: `/presse/${r.id}`, ...(r.assignee_id ? { userId: r.assignee_id } : { permission: 'press.manage' }), category: 'press' });
      reminded++;
    }
  }
  const late = await many<any>(
    `UPDATE press_requests SET overdue_reminded_at = now()
      WHERE status IN ('new','in_progress') AND due_at IS NOT NULL AND overdue_reminded_at IS NULL AND due_at <= now()
      RETURNING id, case_no, topic, assignee_id`,
  );
  for (const r of late) {
    await notify({ kind: 'error', title: `Presseanfrage ${r.case_no}: Frist überschritten`, body: String(r.topic).slice(0, 200), link: `/presse/${r.id}`, ...(r.assignee_id ? { userId: r.assignee_id } : { permission: 'press.manage' }), category: 'press' });
    overdue++;
  }
  return { reminded, overdue };
}
