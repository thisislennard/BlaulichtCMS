import type { Settings } from './settings.js';

/**
 * Absenderangaben der Mail-Einstellungen an einer Stelle lesen (#230).
 *
 * `smtp.from` ist Freitext und darf neben der reinen Adresse auch „Name <adresse@example.org>“ enthalten (so geht er
 * unverändert an den Mailserver, z. B. bei Warnentwürfen); `m365.sender` ist eine Adresse. Presseversand, Message-ID,
 * die Erkennung eigener Mails im Presse-Postfach und der VAPID-Kontakt brauchen die nackte Adresse – sie lesen sie
 * ausschließlich über parseMailbox() bzw. configuredSender().
 */
export interface Mailbox {
  /** Adresse ohne Anzeigenamen, wie eingetragen (Groß-/Kleinschreibung bleibt) */
  address: string;
  /** Anzeigename aus „Name <adresse>“, sonst leer */
  name: string;
}

const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+$/;

/** „adresse@example.org“, „Name <adresse@example.org>“ oder „"Nach, Vor" <adresse@example.org>“ → Adresse und Name; sonst null. */
export function parseMailbox(value: unknown): Mailbox | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^(.*?)\s*<\s*([^<>\s]+)\s*>$/.exec(s);
  const address = (m ? m[2] : s).trim();
  if (!ADDRESS.test(address)) return null;
  let name = m ? m[1].trim() : '';
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return { address, name: name.replace(/[\u0000-\u001f\u007f]/g, '').trim() };
}

/** Domain einer Adresse (kleingeschrieben) oder null. */
export function mailDomain(value: unknown): string | null {
  const a = parseMailbox(value)?.address;
  return a ? a.slice(a.lastIndexOf('@') + 1).toLowerCase() : null;
}

/** Absender des eingestellten Mailwegs (SMTP: `smtp.from`, Microsoft 365: `m365.sender`) – oder null, wenn keine Adresse erkennbar ist. */
export function configuredSender(s: Pick<Settings, 'mail.transport' | 'm365.sender' | 'smtp.from'>): Mailbox | null {
  return parseMailbox(s['mail.transport'] === 'm365' ? s['m365.sender'] : s['smtp.from']);
}

/** Alle eigenen Absenderadressen (SMTP und Microsoft 365), kleingeschrieben – z. B. um eigene Mails zu erkennen. */
export function ownSenderAddresses(s: Pick<Settings, 'm365.sender' | 'smtp.from'>): string[] {
  return [s['smtp.from'], s['m365.sender']].map((v) => parseMailbox(v)?.address.toLowerCase()).filter((a): a is string => !!a);
}
