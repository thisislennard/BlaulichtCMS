import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { m365ConfigProblem, m365SendMime, storedM365Settings } from '../lib/mail.js';
import { getSettings } from '../lib/settings.js';
import { smtpTransport } from '../warnings/mail.js';

/**
 * Versand von Presse-Mails (Antworten #206, Pressemitteilungen #207) über den eingestellten Mailweg – SMTP oder
 * Microsoft 365. Damit der Mail-Verlauf bei der Redaktion stimmt, trägt jede Mail eine eigene Message-ID sowie
 * In-Reply-To/References. Bei Microsoft 365 wird die Nachricht dafür als fertige MIME-Nachricht übergeben.
 */
export interface PressMail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

/** Message-ID mit der Domain des Absenders (sonst „blaulichtcms.invalid“). */
export function pressMessageId(from: string, prefix = 'press'): string {
  const domain = /@([a-z0-9.-]+)$/i.exec(from.trim())?.[1] ?? 'blaulichtcms.invalid';
  return `<${prefix}-${crypto.randomUUID()}@${domain.toLowerCase()}>`;
}

/** Absenderadresse des eingestellten Mailwegs. */
export async function pressSender(): Promise<{ address: string; name: string }> {
  const s = await getSettings(true);
  const address = s['mail.transport'] === 'm365' ? String(s['m365.sender'] ?? '') : String(s['smtp.from'] ?? '');
  const name = String(s['general.sender_name'] || s['general.organization'] || s['general.instance_name'] || '').trim();
  return { address: address.trim(), name };
}

export async function sendPressMail(m: PressMail): Promise<{ response: string }> {
  const s = await getSettings(true);
  const sender = await pressSender();
  const message = {
    from: sender.name ? { name: sender.name, address: sender.address } : sender.address,
    to: m.to,
    ...(m.cc?.length ? { cc: m.cc } : {}),
    subject: m.subject,
    text: m.text,
    messageId: m.messageId,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.references?.length ? { references: m.references } : {}),
    ...(m.headers ? { headers: m.headers } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  };
  if (s['mail.transport'] === 'm365') {
    const c = await storedM365Settings(s);
    const problem = m365ConfigProblem(c);
    if (problem) throw Object.assign(new Error(`Microsoft 365 ist nicht vollständig eingerichtet: ${problem}`), { code: 'ECONFIG' });
    const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' }).sendMail(message);
    return m365SendMime(c, built.message as Buffer);
  }
  const { transport } = await smtpTransport().catch((e) => {
    throw Object.assign(e, { code: 'ECONFIG' }); // nicht eingerichtet: sicher nicht gesendet
  });
  try {
    const info = await transport.sendMail(message);
    return { response: String(info.response ?? 'angenommen').slice(0, 300) };
  } finally {
    transport.close();
  }
}
