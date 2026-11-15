import fs from 'node:fs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { one, pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { readSecret } from '../lib/secrets.js';
import { deriveKey } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';

/**
 * SMTP-Versand eines freigegebenen Warnentwurfs (PDF als Anhang).
 *  accepted  – der Mailserver hat die Nachricht angenommen (technische Annahme, KEINE fachliche Eingangsbestätigung)
 *  failed    – sicher nicht versendet (Verbindung/Anmeldung/Ablehnung vor bzw. bei der Annahme)
 *  unknown   – Abbruch nach dem Senden der Daten: möglicherweise angekommen → erst prüfen, nie automatisch erneut senden
 */
export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;

/**
 * Zentrale Prüfung der Versandeinstellungen (#100): nur bekannte Verschlüsselungsarten; ohne TLS keine Anmeldung, damit
 * Zugangsdaten nie im Klartext übertragen werden. Gibt eine Fehlermeldung zurück oder null.
 */
export function smtpConfigProblem(c: { security: unknown; user?: unknown; password?: unknown }): string | null {
  if (!SMTP_SECURITY.includes(c.security as any)) return 'Unbekannte Verschlüsselung für den Mailserver (erlaubt: STARTTLS, TLS, keine).';
  if (c.security === 'none' && (String(c.user ?? '').trim() || String(c.password ?? ''))) return 'Ohne Verschlüsselung ist keine Anmeldung möglich – Zugangsdaten würden im Klartext übertragen. Bitte STARTTLS oder TLS wählen oder Benutzer und Passwort leeren.';
  return null;
}

/** Versandeinstellungen samt Passwort (Klartext nur im Speicher, nie in Antworten oder Protokollen). */
export interface SmtpSettings {
  host: string;
  port: number;
  security: string;
  user: string;
  from: string;
  password: string;
}

/** Gespeicherte Versandeinstellungen (Passwort entschlüsselt). */
export async function storedSmtpSettings(): Promise<SmtpSettings> {
  const s = await getSettings(true);
  return {
    host: String(s['smtp.host'] ?? ''),
    port: Number(s['smtp.port']),
    security: String(s['smtp.security'] ?? ''),
    user: String(s['smtp.user'] ?? ''),
    from: String(s['smtp.from'] ?? ''),
    password: (await readSecret(s['smtp.password_secret_id'])) ?? '',
  };
}

/**
 * Prüfwert genau dieser Versandeinstellungen (Server, Port, Verschlüsselung, Benutzer, Absender, Passwort) für die
 * Regel „Echtbetrieb nur nach erfolgreicher Testmail“. HMAC mit einem eigenen, aus dem Master-Schlüssel abgeleiteten
 * Schlüssel – der gespeicherte Wert lässt keine Rückschlüsse auf das Passwort zu. Ohne Anmeldung zählt das Passwort nicht.
 */
export function smtpFingerprint(c: SmtpSettings): string {
  const auth = !!c.user.trim() && c.security !== 'none';
  const canonical = JSON.stringify([c.host.trim().toLowerCase(), Number(c.port), c.security, c.user.trim(), c.from.trim(), auth ? c.password : '']);
  return crypto.createHmac('sha256', deriveKey('smtp-verification')).update(canonical).digest('hex');
}

/** So lange gilt eine erfolgreiche Testmail als Nachweis für das Ausschalten des Testmodus bzw. Änderungen im Echtbetrieb. */
export const SMTP_VERIFY_MAX_AGE_MS = 60 * 60_000;

export async function smtpTransport(override?: SmtpSettings) {
  const c = override ?? (await storedSmtpSettings());
  if (!c.host || !c.from) throw new Error('SMTP ist nicht eingerichtet (Einstellungen → E-Mail-Versand).');
  // Auch hier prüfen – z. B. Altbestand aus der Zeit vor der Prüfung (#100)
  const problem = smtpConfigProblem({ security: c.security, user: c.user });
  if (problem) throw new Error(problem);
  const timeout = Number(process.env.BLAULICHTCMS_SMTP_TIMEOUT_MS ?? 60_000);
  return {
    from: c.from,
    transport: nodemailer.createTransport({
      host: c.host,
      port: Number(c.port),
      secure: c.security === 'tls',
      requireTLS: c.security === 'starttls',
      ignoreTLS: c.security === 'none',
      auth: c.user && c.security !== 'none' ? { user: c.user, pass: c.password ?? '' } : undefined,
      connectionTimeout: Math.min(timeout, 15_000),
      greetingTimeout: Math.min(timeout, 15_000),
      socketTimeout: timeout,
      tls: { minVersion: 'TLSv1.2' },
    }),
  };
}

/**
 * Konservativ: Nur wenn sicher ist, dass nichts angenommen wurde, gilt „failed“ (erneuter Versand erlaubt).
 * Nodemailer meldet Socket-Timeouts auch nach DATA mit command „CONN“ – deshalb zählt jeder Abbruch einer
 * bestehenden Verbindung als „unknown“, außer Verbindungsaufbau, Begrüßung oder Anmeldung sind gescheitert.
 */
export function classifySmtpError(e: any): 'failed' | 'unknown' {
  if (typeof e?.responseCode === 'number') return 'failed'; // Server hat eindeutig geantwortet (4xx/5xx)
  const msg = String(e?.message ?? '');
  if (['ECONNREFUSED', 'EDNS', 'EAUTH', 'ETLS', 'EENVELOPE', 'EMESSAGE', 'ENOAUTH', 'EPROTOCOL'].includes(e?.code)) return 'failed';
  if (/Connection timeout|Greeting never received|connect ECONN|getaddrinfo/i.test(msg)) return 'failed';
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNECTION', 'ESTREAM'].includes(e?.code)) return 'unknown';
  return e?.code ? 'failed' : 'unknown';
}

export async function deliverWarningSend(sendId: string) {
  const send = await one<any>(
    `SELECT s.*, w.case_no, a.pdf_file, a.pdf_sha256 FROM warning_sends s JOIN warnings w ON w.id = s.warning_id JOIN warning_approvals a ON a.id = s.approval_id WHERE s.id = $1`,
    [sendId],
  );
  if (!send) return;
  if (send.status === 'sending') {
    // Vorheriger Versuch wurde unterbrochen (z. B. Neustart): Ergebnis unklar → zur Prüfung, kein automatischer Neuversand
    await pool.query(`UPDATE warning_sends SET status = 'unknown', needs_review = true, error = 'Versand wurde unterbrochen – Ergebnis unbekannt.' WHERE id = $1`, [sendId]);
    await notify({ kind: 'warning', title: `Versand ${send.case_no}: Ergebnis unbekannt – bitte prüfen`, link: `/warnungen/${send.warning_id}`, permission: 'warning.send' });
    return;
  }
  if (send.status !== 'queued') return;
  await pool.query(`UPDATE warning_sends SET status = 'sending', attempts = attempts + 1 WHERE id = $1`, [sendId]);
  const body = (await one<any>(`SELECT body FROM warning_sends_body WHERE send_id = $1`, [sendId]))?.body ?? '';
  try {
    const pdf = fs.readFileSync(send.pdf_file);
    const { transport, from } = await smtpTransport();
    const info = await transport.sendMail({
      from,
      to: send.recipients,
      subject: send.subject,
      text: body,
      messageId: `<${send.id}@blaulichtcms.invalid>`,
      headers: { 'X-BlaulichtCMS-Vorgang': send.case_no, 'X-BlaulichtCMS-PDF-SHA256': send.pdf_sha256 },
      attachments: [{ filename: `${send.case_no}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
    await pool.query(`UPDATE warning_sends SET status = 'accepted', message_id = $2, smtp_response = $3, sent_at = now(), error = NULL WHERE id = $1`, [sendId, info.messageId, String(info.response ?? '').slice(0, 300)]);
  } catch (e: any) {
    const outcome = classifySmtpError(e);
    await pool.query(`UPDATE warning_sends SET status = $2, needs_review = $3, error = $4, smtp_response = $5 WHERE id = $1`, [sendId, outcome, outcome === 'unknown', String(e?.message ?? e).slice(0, 500), e?.response ? String(e.response).slice(0, 300) : null]);
    log('warn', 'warnings', `Versand ${send.case_no}: ${outcome} – ${e?.message ?? e}`);
    await notify({ kind: outcome === 'unknown' ? 'warning' : 'error', title: `Versand ${send.case_no}: ${outcome === 'unknown' ? 'Ergebnis unbekannt – bitte prüfen' : 'fehlgeschlagen'}`, body: String(e?.message ?? '').slice(0, 200), link: `/warnungen/${send.warning_id}`, permission: 'warning.send' });
  }
}
