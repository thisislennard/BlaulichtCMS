import crypto from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit.js';
import { deriveKey } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { classifySmtpError } from '../warnings/mail.js';
import { htmlToText } from './mime.js';
import { pressMessageId, pressSender, sendPressMail } from './send.js';

/**
 * Presseverteiler und Pressemitteilungen (#207).
 *
 * Jede Pressemitteilung geht an jeden Kontakt einzeln (eine Mail je Empfänger, nur dessen Adresse im „An“) – nie als
 * offene Empfängerliste. Jede Mail trägt einen persönlichen Abmeldelink (Fußzeile und List-Unsubscribe/One-Click nach
 * RFC 8058). Abgemeldete Kontakte erhalten nichts mehr, auch nicht nach einem erneuten Import.
 *
 * Versand im Worker (Auftrag press.release), Empfänger nacheinander mit Protokoll je Empfänger. Ein unterbrochener
 * Versand an einen Empfänger gilt als „unbekannt“ und wird nie automatisch wiederholt; noch nicht versuchte Empfänger
 * lassen sich mit „Rest senden“ nachholen.
 */

/* ------------------------------------------------------------------ Abmeldelink */

const sig = (id: string) => crypto.createHmac('sha256', deriveKey('press-unsubscribe')).update(id).digest('base64url').slice(0, 22);

export function unsubscribeToken(contactId: string): string {
  return `${Buffer.from(contactId.replace(/-/g, ''), 'hex').toString('base64url')}.${sig(contactId)}`;
}

/** Token prüfen → Kontakt-ID oder null. */
export function contactFromToken(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const hex = Buffer.from(m[1], 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expected = Buffer.from(sig(id));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? id : null;
}

export async function publicBase(): Promise<string> {
  const s = await getSettings();
  return String(s['general.public_url'] || config.publicUrl || '').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ Empfänger und Versand */

/** Empfänger aus Listen: je Adresse einmal, ohne abgemeldete Kontakte. */
export async function recipientsFor(listIds: string[], db: Queryable = pool) {
  return many<{ id: string; email: string; name: string }>(
    `SELECT DISTINCT ON (lower(c.email)) c.id, c.email, c.name FROM press_contacts c JOIN press_list_members m ON m.contact_id = c.id
      WHERE m.list_id = ANY($1::uuid[]) AND c.unsubscribed_at IS NULL ORDER BY lower(c.email), c.created_at`,
    [listIds],
    db,
  );
}

/** Versand starten (Entwurf → Empfänger anlegen) bzw. verbliebene Empfänger nachholen. Gibt die Zahl offener Empfänger zurück. */
export async function startRelease(id: string, actor: Actor, userId: string | null): Promise<number> {
  const base = await publicBase();
  if (!/^https?:\/\//.test(base)) throw badRequest('Für den Abmeldelink braucht BlaulichtCMS seine öffentliche Adresse (Einstellungen → Allgemein → Öffentliche Adresse).');
  if (!(await pressSender()).address) throw badRequest('Der E-Mail-Versand ist nicht eingerichtet (Einstellungen → Benachrichtigungen und E-Mail).');
  return tx(async (db) => {
    const r = await one<any>(`SELECT * FROM press_releases WHERE id = $1 FOR UPDATE`, [id], db);
    if (!r) throw notFound('Pressemitteilung nicht gefunden.');
    if (r.status === 'draft') {
      if (!r.list_ids.length) throw badRequest('Bitte mindestens eine Verteilerliste wählen.');
      const rec = await recipientsFor(r.list_ids, db);
      if (!rec.length) throw badRequest('Die gewählten Listen enthalten keine (angemeldeten) Kontakte.');
      for (const c of rec) await db.query(`INSERT INTO press_release_recipients (release_id, contact_id, email, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id, c.id, c.email, c.name]);
      await db.query(`UPDATE press_releases SET status = 'sending', sent_by = $2, sent_at = now(), updated_at = now() WHERE id = $1`, [id, userId]);
      await audit(actor, 'press.release_sent', { type: 'press_release', id, label: r.subject.slice(0, 120) }, { empfaenger: rec.length, listen: r.list_ids.length }, 'ok', db);
    } else {
      await db.query(`UPDATE press_releases SET status = 'sending', updated_at = now() WHERE id = $1`, [id]);
      await audit(actor, 'press.release_resumed', { type: 'press_release', id, label: r.subject.slice(0, 120) }, {}, 'ok', db);
    }
    const open = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM press_release_recipients WHERE release_id = $1 AND status = 'queued'`, [id], db))!.n;
    if (!open) {
      await db.query(`UPDATE press_releases SET status = 'sent' WHERE id = $1`, [id]);
      return 0;
    }
    await enqueue('press.release', { id }, { maxAttempts: 1, dedupKey: `press.release:${id}` }, db);
    return open;
  });
}

/** Worker: Empfänger nacheinander anschreiben. */
export async function deliverRelease(id: string): Promise<void> {
  const r = await one<any>(`SELECT * FROM press_releases WHERE id = $1`, [id]);
  if (!r) return;
  // Unterbrochener Versand an einzelne Empfänger: Ergebnis unklar, nie automatisch erneut
  await pool.query(`UPDATE press_release_recipients SET status = 'unknown', error = 'Versand wurde unterbrochen – Ergebnis unbekannt.' WHERE release_id = $1 AND status = 'sending'`, [id]);
  const base = await publicBase();
  const sender = await pressSender();
  const pause = process.env.VITEST ? 0 : 300; // Mailserver nicht fluten
  for (;;) {
    const c = await one<any>(`UPDATE press_release_recipients SET status = 'sending' WHERE id = (SELECT id FROM press_release_recipients WHERE release_id = $1 AND status = 'queued' ORDER BY lower(email) LIMIT 1) RETURNING *`, [id]);
    if (!c) break;
    // Kontakt inzwischen abgemeldet: überspringen
    if (c.contact_id && (await one(`SELECT 1 FROM press_contacts WHERE id = $1 AND unsubscribed_at IS NOT NULL`, [c.contact_id]))) {
      await pool.query(`UPDATE press_release_recipients SET status = 'failed', error = 'abgemeldet' WHERE id = $1`, [c.id]);
      continue;
    }
    const link = c.contact_id ? `${base}/presse-abmelden/${unsubscribeToken(c.contact_id)}` : '';
    const api = c.contact_id ? `${base}/api/v1/public/press/unsubscribe/${unsubscribeToken(c.contact_id)}` : '';
    const messageId = pressMessageId(sender.address, 'pm');
    try {
      await sendPressMail({
        to: [c.email],
        subject: r.subject,
        text: `${r.body}\n\n—\nSie erhalten diese Pressemitteilung als Kontakt unseres Presseverteilers.${link ? `\nAbmelden: ${link}` : ''}`,
        messageId,
        headers: { ...(api ? { 'List-Unsubscribe': `<${api}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}), 'X-BlaulichtCMS-Pressemitteilung': id },
      });
      await pool.query(`UPDATE press_release_recipients SET status = 'sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1`, [c.id, messageId]);
    } catch (e: any) {
      const outcome = classifySmtpError(e);
      await pool.query(`UPDATE press_release_recipients SET status = $2, error = $3 WHERE id = $1`, [c.id, outcome, String(e?.message ?? e).slice(0, 500)]);
      log('warn', 'press', `Pressemitteilung an ${c.email.replace(/^(.).*@/, '$1…@')}: ${outcome} – ${e?.message ?? e}`);
    }
    if (pause) await new Promise((res) => setTimeout(res, pause));
  }
  const counts = (await one<any>(`SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status IN ('failed','unknown'))::int AS bad, count(*)::int AS total FROM press_release_recipients WHERE release_id = $1`, [id]))!;
  await pool.query(`UPDATE press_releases SET status = $2, updated_at = now() WHERE id = $1`, [id, counts.bad ? 'partial' : 'sent']);
  await audit(SYSTEM_ACTOR, 'press.release_done', { type: 'press_release', id, label: String(r.subject).slice(0, 120) }, { gesendet: counts.sent, fehler: counts.bad }, counts.bad ? 'failed' : 'ok');
  await notify({ kind: counts.bad ? 'warning' : 'success', title: `Pressemitteilung „${String(r.subject).slice(0, 80)}“: ${counts.sent} von ${counts.total} gesendet`, body: counts.bad ? `${counts.bad} Empfänger nicht erreicht – Versandprotokoll prüfen.` : '', link: `/presse/mitteilungen?id=${id}`, ...(r.sent_by ? { userId: r.sent_by } : { permission: 'press.release' }), category: 'press' });
}

/** Text eines Beitrags (aktuelle Fassung) als Vorlage für eine Pressemitteilung. */
export async function postAsRelease(postId: string): Promise<{ subject: string; body: string } | null> {
  const p = await one<any>(`SELECT r.title, r.body, r.excerpt FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision WHERE p.id = $1`, [postId]);
  if (!p) return null;
  const body = /<[a-z][\s\S]*>/i.test(p.body ?? '') ? htmlToText(p.body) : String(p.body ?? '');
  return { subject: p.title, body: body || p.excerpt || '' };
}

/* ------------------------------------------------------------------ CSV */

/** CSV lesen (Trennzeichen ; oder , automatisch, Anführungszeichen, Zeilenumbrüche in Feldern). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/** CSV-Feld; Formel-Einleitungszeichen werden entschärft (Schutz vor CSV-Injection in Tabellenprogrammen). */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ Workflow-Ausgang */

/**
 * Workflow-Ausgang „Pressemitteilung an Verteiler“: legt standardmäßig einen Entwurf an (Versand von Hand); nur mit
 * Direktversand (Freigabe des Workflows für Direktveröffentlichung, Recht „Workflows direkt veröffentlichen lassen“)
 * wird sofort gesendet.
 */
export async function pressReleaseFromWorkflow(o: { subject: string; body: string; listIds: string[]; direct: boolean; test: boolean; automationName: string; actor: Actor }): Promise<{ id: string | null; info: string; recipients: number }> {
  const lists = await many<{ id: string; name: string }>(`SELECT id, name FROM press_lists WHERE id = ANY($1::uuid[])`, [o.listIds]);
  if (!lists.length) throw new Error('Keine der gewählten Verteilerlisten gibt es (noch).');
  const n = (await recipientsFor(lists.map((l) => l.id))).length;
  const where = lists.map((l) => `„${l.name}“`).join(', ');
  if (o.test) return { id: null, recipients: n, info: `Testlauf: würde die Pressemitteilung „${o.subject}“ ${o.direct ? `sofort an ${n} Kontakte (${where}) senden` : `als Entwurf für ${where} anlegen`}.` };
  const r = await one<{ id: string }>(`INSERT INTO press_releases (subject, body, list_ids, source) VALUES ($1,$2,$3,'workflow') RETURNING id`, [o.subject, o.body, lists.map((l) => l.id)]);
  await audit(o.actor, 'press.release_created', { type: 'press_release', id: r!.id, label: o.subject.slice(0, 120) }, { workflow: o.automationName, direkt: o.direct });
  if (o.direct) {
    const open = await startRelease(r!.id, o.actor, null);
    return { id: r!.id, recipients: open, info: `Pressemitteilung „${o.subject}“ wird an ${open} Kontakte gesendet (Direktversand).` };
  }
  await notify({ kind: 'info', title: `Pressemitteilung vorbereitet: ${o.subject}`.slice(0, 200), body: `Aus dem Workflow „${o.automationName}“ – bitte prüfen und senden.`, link: `/presse/mitteilungen?id=${r!.id}`, permission: 'press.release', category: 'press' });
  return { id: r!.id, recipients: n, info: `Pressemitteilung „${o.subject}“ als Entwurf für ${where} angelegt – Versand von Hand.` };
}
