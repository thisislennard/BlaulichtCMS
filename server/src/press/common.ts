import type pg from 'pg';
import { one, pool, type Queryable } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { emitPressRequest } from '../automations/events.js';

/**
 * Presseanfragen (#204): gemeinsame Bausteine für Routen, Postfach-Abruf (#205), Antworten (#206) und Worker.
 *
 * Status: neu → in Bearbeitung → beantwortet → erledigt (jeder Wechsel ist erlaubt, steht im Verlauf). Kontaktdaten der
 * anfragenden Person stehen nur in der Anfrage selbst – nie in Benachrichtigungen, Workflows oder dem Audit.
 */
export const PRESS_STATUS = ['new', 'in_progress', 'answered', 'done'] as const;
export type PressStatus = (typeof PRESS_STATUS)[number];
export const PRESS_STATUS_LABEL: Record<PressStatus, string> = { new: 'neu', in_progress: 'in Bearbeitung', answered: 'beantwortet', done: 'erledigt' };

export const PRESS_CHANNELS = ['phone', 'mail', 'mailbox', 'in_person', 'other'] as const;
export type PressChannel = (typeof PRESS_CHANNELS)[number];
export const PRESS_CHANNEL_LABEL: Record<PressChannel, string> = { phone: 'Telefon', mail: 'E-Mail', mailbox: 'Presse-Postfach', in_person: 'Persönlich', other: 'Sonstiges' };

/** Vorgangsnummer P-JJJJ-NNNN (Jahr in der eingestellten Zeitzone). */
export async function nextPressCaseNo(db: Queryable, timeZone: string): Promise<string> {
  const year = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(new Date());
  const seq = (await one<{ n: string }>(`SELECT nextval('press_request_seq') AS n`, [], db))!.n;
  return `P-${year}-${String(seq).padStart(4, '0')}`;
}

/** Eintrag im Verlauf einer Anfrage. */
export async function pressEvent(db: Queryable, requestId: string, actor: Pick<Actor, 'id' | 'name' | 'type'> | null, kind: string, text = '', details: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO press_request_events (request_id, actor_id, actor_name, kind, text, details) VALUES ($1,$2,$3,$4,$5,$6)`, [
    requestId,
    actor?.type === 'user' ? actor.id : null,
    actor?.name ?? 'System',
    kind,
    text.slice(0, 20_000),
    JSON.stringify(details),
  ]);
  await db.query(`UPDATE press_requests SET updated_at = now() WHERE id = $1`, [requestId]);
}

/** Workflow-Eingang „Neue Presseanfrage“ – nur Felder ohne Kontaktdaten. */
export async function emitNewPressRequest(id: string, db?: pg.PoolClient) {
  const r = await one<any>(`SELECT r.id, r.case_no, r.topic, r.outlet, r.channel, r.due_at, u.name AS assignee FROM press_requests r LEFT JOIN users u ON u.id = r.assignee_id WHERE r.id = $1`, [id], db ?? pool);
  if (!r) return;
  await emitPressRequest(
    {
      id: r.id,
      channel: r.channel,
      payload: {
        nummer: r.case_no,
        thema: r.topic,
        medium: r.outlet,
        eingangsweg: PRESS_CHANNEL_LABEL[r.channel as PressChannel] ?? r.channel,
        frist: r.due_at ? new Date(r.due_at).toISOString() : '',
        zustaendig: r.assignee ?? '',
        anfrage_link: `/presse/${r.id}`,
      },
    },
    db,
  );
}

/** Einfache E-Mail-Prüfung (Form, keine Zustellbarkeit). */
export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
