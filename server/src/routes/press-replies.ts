import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit, SYSTEM_ACTOR } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { decidedBy, refreshApprovalNotice } from '../approvals/notices.js';
import { getSettings } from '../lib/settings.js';
import { enqueue } from '../jobs/queue.js';
import { classifySmtpError } from '../warnings/mail.js';
import { pressEvent } from '../press/common.js';
import { pressMessageId, pressSender, sendPressMail } from '../press/send.js';

/*
 * Antworten auf Presseanfragen (#206): Antwort-Editor in der Anfrage, Versand über den eingestellten Mailweg mit
 * richtigen Kopfzeilen für den Mail-Verlauf, Textbausteine mit Platzhaltern und optionale Freigabe durch eine zweite
 * Person (Einstellung press.reply_approval, Standard aus).
 *
 * Stand einer Antwort (press_messages.status, direction = 'out'):
 *   pending – wartet auf Freigabe · rejected – zurückgewiesen · queued – wartet auf den Versand · sending – wird gesendet
 *   sent – vom Mailserver angenommen · failed – sicher nicht gesendet (erneut senden möglich)
 *   unknown – Abbruch nach dem Senden, Ergebnis unklar (nie automatisch erneut)
 */

const emailList = z.array(z.email().max(254)).max(10);

/** Versand im Worker (Auftrag press.reply). Genau ein Versuch – ein Wiederholungsversand könnte doppelt zustellen. */
export async function deliverPressReply(id: string): Promise<void> {
  const m = await one<any>(`SELECT m.*, r.case_no, r.status AS request_status, r.assignee_id FROM press_messages m JOIN press_requests r ON r.id = m.request_id WHERE m.id = $1 AND m.direction = 'out'`, [id]);
  if (!m) return;
  if (m.status === 'sending') {
    await pool.query(`UPDATE press_messages SET status = 'unknown', error = 'Versand wurde unterbrochen – Ergebnis unbekannt.' WHERE id = $1`, [id]);
    await notify({ kind: 'warning', title: `Antwort zu ${m.case_no}: Ergebnis unbekannt – bitte prüfen`, link: `/presse/${m.request_id}`, ...(m.submitted_by ? { userId: m.submitted_by } : { permission: 'press.reply' }), category: 'press' });
    return;
  }
  if (m.status !== 'queued') return;
  await pool.query(`UPDATE press_messages SET status = 'sending' WHERE id = $1`, [id]);
  try {
    const res = await sendPressMail({ to: m.to_addresses, cc: m.cc_addresses, subject: m.subject, text: m.text_body, messageId: m.message_id, inReplyTo: m.in_reply_to, references: m.refs, headers: { 'X-BlaulichtCMS-Vorgang': m.case_no } });
    await tx(async (db) => {
      await db.query(`UPDATE press_messages SET status = 'sent', sent_at = now(), error = NULL, from_address = $2 WHERE id = $1`, [id, (await pressSender()).address]);
      await pressEvent(db, m.request_id, null, 'mail_out', `Antwort gesendet an ${m.to_addresses.join(', ')}: ${m.subject}`.slice(0, 500));
      // Status automatisch „beantwortet“ (nicht, wenn die Anfrage schon erledigt ist)
      if (m.request_status === 'new' || m.request_status === 'in_progress') {
        await db.query(`UPDATE press_requests SET status = 'answered', answered_at = now() WHERE id = $1`, [m.request_id]);
        await pressEvent(db, m.request_id, null, 'status', `Status: ${m.request_status === 'new' ? 'neu' : 'in Bearbeitung'} → beantwortet (Antwort gesendet)`, { status: 'answered' });
      }
      await audit(SYSTEM_ACTOR, 'press.reply_sent', { type: 'press_request', id: m.request_id, label: m.case_no }, { empfaenger: m.to_addresses.length + m.cc_addresses.length, antwort: res.response.slice(0, 120) }, 'ok', db);
    });
  } catch (e: any) {
    const outcome = classifySmtpError(e);
    await pool.query(`UPDATE press_messages SET status = $2, error = $3 WHERE id = $1`, [id, outcome, String(e?.message ?? e).slice(0, 500)]);
    log('warn', 'press', `Antwort ${m.case_no}: ${outcome} – ${e?.message ?? e}`);
    await audit(SYSTEM_ACTOR, 'press.reply_failed', { type: 'press_request', id: m.request_id, label: m.case_no }, { ergebnis: outcome }, 'failed');
    await notify({ kind: outcome === 'unknown' ? 'warning' : 'error', title: `Antwort zu ${m.case_no}: ${outcome === 'unknown' ? 'Ergebnis unbekannt – bitte prüfen' : 'Versand fehlgeschlagen'}`, body: String(e?.message ?? '').slice(0, 200), link: `/presse/${m.request_id}`, ...(m.submitted_by ? { userId: m.submitted_by } : { permission: 'press.reply' }), category: 'press' });
  }
}

const queueSend = (id: string, db = pool as any) => enqueue('press.reply', { id }, { maxAttempts: 1, dedupKey: `press.reply:${id}` }, db);

export async function pressReplyRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------------ Textbausteine */

  app.get('/press/snippets', { preHandler: requireAnyAuth('press.reply', 'press.snippets') }, async () => many<any>(`SELECT id, title, body, updated_at FROM press_snippets ORDER BY lower(title)`));

  const snippet = z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(1).max(20_000) });
  app.post('/press/snippets', { preHandler: requireAuth('press.snippets') }, async (req) => {
    const v = snippet.parse(req.body);
    const r = await one<any>(`INSERT INTO press_snippets (title, body, created_by) VALUES ($1,$2,$3) RETURNING id`, [v.title, v.body, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'press.snippet_created', { type: 'press_snippet', id: r.id, label: v.title });
    return { id: r.id };
  });
  app.put('/press/snippets/:id', { preHandler: requireAuth('press.snippets') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = snippet.parse(req.body);
    const r = await pool.query(`UPDATE press_snippets SET title = $2, body = $3, updated_at = now() WHERE id = $1`, [id, v.title, v.body]);
    if (!r.rowCount) throw notFound('Textbaustein nicht gefunden.');
    await audit(req.auth!.actor, 'press.snippet_updated', { type: 'press_snippet', id, label: v.title });
    return { ok: true };
  });
  app.delete('/press/snippets/:id', { preHandler: requireAuth('press.snippets') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<any>(`DELETE FROM press_snippets WHERE id = $1 RETURNING title`, [id]);
    if (!r) throw notFound('Textbaustein nicht gefunden.');
    await audit(req.auth!.actor, 'press.snippet_deleted', { type: 'press_snippet', id, label: r.title });
    return { ok: true };
  });

  /* ------------------------------------------------------------------ Antworten */

  app.post('/press/requests/:id/replies', { preHandler: requireAuth('press.reply') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const v = z.object({ to: emailList.min(1, 'Bitte mindestens einen Empfänger angeben.'), cc: emailList.default([]), subject: z.string().trim().min(2).max(300), body: z.string().trim().min(1, 'Bitte einen Text eingeben.').max(50_000) }).parse(req.body);
    const r = await one<any>(`SELECT id, case_no FROM press_requests WHERE id = $1`, [id]);
    if (!r) throw notFound('Presseanfrage nicht gefunden.');
    const s = await getSettings(true);
    const sender = await pressSender();
    if (!sender.address) throw badRequest('Der E-Mail-Versand ist nicht eingerichtet (Einstellungen → E-Mail & Push).');
    const approval = !!s['press.reply_approval'];
    // Verlauf: auf die letzte eingegangene Mail der Empfängerin bzw. des Empfängers antworten, sonst auf die letzte überhaupt
    const last = await one<any>(
      `SELECT message_id, refs FROM press_messages WHERE request_id = $1 AND direction = 'in' AND message_id IS NOT NULL
        ORDER BY (lower(from_address) = ANY($2::text[])) DESC, COALESCE(received_at, created_at) DESC, created_at DESC LIMIT 1`,
      [id, v.to.map((a) => a.toLowerCase())],
    );
    const refs = last ? [...(last.refs ?? []), last.message_id].slice(-20) : [];
    const subject = v.subject.includes(`[${r.case_no}]`) ? v.subject : `${v.subject} [${r.case_no}]`;
    const actor = req.auth!.actor;
    const msg = await tx(async (db) => {
      const row = await one<any>(
        `INSERT INTO press_messages (request_id, direction, status, message_id, in_reply_to, refs, from_address, to_addresses, cc_addresses, subject, text_body, created_by, submitted_by)
         VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
        [id, approval ? 'pending' : 'queued', pressMessageId(sender.address), last?.message_id ?? null, refs, sender.address, v.to, v.cc, subject, v.body, req.auth!.user?.id ?? null],
        db,
      );
      await pressEvent(db, id, actor, 'reply', approval ? `Antwort zur Freigabe eingereicht: ${subject}` : `Antwort an ${v.to.join(', ')} wird gesendet`);
      await audit(actor, approval ? 'press.reply_submitted' : 'press.reply_queued', { type: 'press_request', id, label: r.case_no }, { empfaenger: v.to.length + v.cc.length }, 'ok', db);
      if (!approval) await queueSend(row!.id, db);
      return row!;
    });
    // Link auf die Antwort in der Anfrage; mehrere offene Antworten ergeben eine gebündelte Meldung (#253)
    if (approval) await refreshApprovalNotice('press', { added: [msg.id] });
    return { id: msg.id, status: approval ? 'pending' : 'queued' };
  });

  const loadReply = async (id: string) => {
    const m = await one<any>(`SELECT m.*, r.case_no FROM press_messages m JOIN press_requests r ON r.id = m.request_id WHERE m.id = $1 AND m.direction = 'out'`, [id]);
    if (!m) throw notFound('Antwort nicht gefunden.');
    return m;
  };

  app.post('/press/replies/:id/decision', { preHandler: requireAuth('press.approve') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(1000).default('') }).parse(req.body);
    const m = await loadReply(id);
    if (m.status !== 'pending') throw conflict('Diese Antwort wartet nicht (mehr) auf Freigabe.');
    if (m.submitted_by && m.submitted_by === req.auth!.user?.id) throw forbidden('Die eigene Antwort kann nur eine zweite Person freigeben.');
    if (b.decision === 'rejected' && !b.note) throw badRequest('Bitte kurz begründen, was geändert werden soll.');
    const actor = req.auth!.actor;
    await tx(async (db) => {
      const upd = await db.query(`UPDATE press_messages SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 AND status = 'pending'`, [id, b.decision === 'approved' ? 'queued' : 'rejected', req.auth!.user?.id ?? null, b.note]);
      if (!upd.rowCount) throw conflict('Diese Antwort wartet nicht (mehr) auf Freigabe.');
      await pressEvent(db, m.request_id, actor, 'reply', b.decision === 'approved' ? `Antwort freigegeben${b.note ? `: ${b.note}` : ''}` : `Antwort zurückgewiesen: ${b.note}`);
      await audit(actor, b.decision === 'approved' ? 'press.reply_approved' : 'press.reply_rejected', { type: 'press_request', id: m.request_id, label: m.case_no }, {}, 'ok', db);
      if (b.decision === 'approved') await queueSend(id, db);
    });
    if (m.submitted_by) await notify({ kind: b.decision === 'approved' ? 'success' : 'warning', title: `Antwort zu ${m.case_no} ${b.decision === 'approved' ? 'freigegeben – wird gesendet' : 'zurückgewiesen'}`, body: b.note.slice(0, 200), link: `/presse/${m.request_id}?antwort=${id}`, userId: m.submitted_by, category: 'press' });
    await refreshApprovalNotice('press', { note: decidedBy(b.decision, req.auth!.actor.name) });
    return { ok: true };
  });

  /** Sicher nicht gesendete Antwort erneut senden (nicht bei „Ergebnis unbekannt“ – dort erst prüfen). */
  app.post('/press/replies/:id/retry', { preHandler: requireAuth('press.reply') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const m = await loadReply(id);
    if (m.status !== 'failed') throw conflict(m.status === 'unknown' ? 'Ergebnis unbekannt: Bitte erst beim Mailserver bzw. der Redaktion prüfen, ob die Antwort angekommen ist, und dann als gesendet markieren oder neu schreiben.' : 'Nur fehlgeschlagene Antworten lassen sich erneut senden.');
    await tx(async (db) => {
      await db.query(`UPDATE press_messages SET status = 'queued', error = NULL WHERE id = $1`, [id]);
      await audit(req.auth!.actor, 'press.reply_retry', { type: 'press_request', id: m.request_id, label: m.case_no }, {}, 'ok', db);
      await queueSend(id, db);
    });
    return { ok: true };
  });

  /** Ergebnis unbekannt: nach Prüfung als gesendet bzw. als nicht gesendet festhalten. */
  app.post('/press/replies/:id/resolve', { preHandler: requireAuth('press.reply') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { sent } = z.object({ sent: z.boolean() }).parse(req.body);
    const m = await loadReply(id);
    if (m.status !== 'unknown') throw conflict('Nur Antworten mit unbekanntem Ergebnis lassen sich so klären.');
    await tx(async (db) => {
      await db.query(`UPDATE press_messages SET status = $2, sent_at = CASE WHEN $3 THEN now() END WHERE id = $1`, [id, sent ? 'sent' : 'failed', sent]);
      await pressEvent(db, m.request_id, req.auth!.actor, 'reply', sent ? 'Antwort nach Prüfung als gesendet markiert' : 'Antwort nach Prüfung als nicht gesendet markiert');
      await audit(req.auth!.actor, 'press.reply_resolved', { type: 'press_request', id: m.request_id, label: m.case_no }, { gesendet: sent }, 'ok', db);
    });
    return { ok: true };
  });

  /** Eingereichte oder zurückgewiesene Antwort zurückziehen (verwerfen). */
  app.delete('/press/replies/:id', { preHandler: requireAuth('press.reply') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const m = await loadReply(id);
    if (!['pending', 'rejected', 'failed'].includes(m.status)) throw conflict('Gesendete oder laufende Antworten lassen sich nicht zurückziehen.');
    await tx(async (db) => {
      await db.query(`DELETE FROM press_messages WHERE id = $1`, [id]);
      await pressEvent(db, m.request_id, req.auth!.actor, 'reply', `Antwort verworfen: ${m.subject}`.slice(0, 500));
      await audit(req.auth!.actor, 'press.reply_discarded', { type: 'press_request', id: m.request_id, label: m.case_no }, { stand: m.status }, 'ok', db);
    });
    if (m.status === 'pending') await refreshApprovalNotice('press', { note: 'Antwort verworfen' });
    return { ok: true };
  });
}
