import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { StepError } from '../lib/errors.js';
import { checkTemplate } from '../lib/template.js';
import { isPrivateAddress } from '../lib/http.js';
import { config } from '../config.js';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Connector, ExecContext, NodeType, RuntimeConnection, TestStep } from '../engine/types.js';

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

async function assertHostAllowed(host: string, allowPrivate: boolean) {
  if (allowPrivate || config.allowPrivateTargets) return;
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new StepError('config', `Server „${host}“ liegt in einem internen Netz und ist nicht freigegeben.`, { hint: 'In der Verbindung „Interne Ziele erlauben“ aktivieren, wenn das gewollt ist.' });
  }
}

/* -------------------------------------- SMTP ---------------------------------------- */

export const smtpConnector: Connector = {
  id: 'smtp',
  name: 'E-Mail (SMTP)',
  kind: 'E-Mail · SMTP',
  group: 'E-Mail',
  description: 'E-Mails über einen eigenen Mailserver versenden – an fest hinterlegte Empfänger.',
  monogram: 'SM',
  color: '#B45309',
  needsConnection: true,
  setupMinutes: 2,
  fields: [
    { key: 'host', type: 'host', label: 'Server', required: true, placeholder: 'smtp.beispiel.de' },
    {
      key: 'security',
      type: 'select',
      label: 'Verschlüsselung',
      default: 'starttls',
      options: [
        { value: 'tls', label: 'TLS (Port 465)' },
        { value: 'starttls', label: 'STARTTLS (Port 587)' },
      ],
    },
    { key: 'port', type: 'port', label: 'Port', default: 587, help: 'Wird beim Wechsel der Verschlüsselung automatisch gesetzt.' },
    { key: 'username', type: 'text', label: 'Benutzername' },
    { key: 'from', type: 'text', label: 'Absender', required: true, placeholder: 'LifeLink <lifelink@beispiel.de>' },
    { key: 'allowPrivate', type: 'switch', label: 'Interne Ziele erlauben', default: false, advanced: true },
  ],
  secretFields: [{ key: 'password', type: 'secret', label: 'Passwort' }],
  securityNotes: ['Unverschlüsselte Verbindungen sind nicht möglich (TLS oder STARTTLS Pflicht).', 'Empfänger werden im Workflow fest hinterlegt und nie aus eingehenden Daten übernommen.'],
  testInfo: ['Server auflösen', 'Verbindung + TLS aufbauen', 'Anmeldung prüfen'],
  async test(conn) {
    const steps: TestStep[] = [];
    const t0 = Date.now();
    try {
      await assertHostAllowed(conn.config.host, !!conn.config.allowPrivate);
      steps.push({ label: 'Server erreichbar', ok: true, ms: Date.now() - t0 });
      const t1 = Date.now();
      await transport(conn).verify();
      steps.push({ label: 'TLS und Anmeldung', ok: true, ms: Date.now() - t1, message: 'Server akzeptiert die Zugangsdaten' });
    } catch (e) {
      steps.push({ label: steps.length ? 'TLS und Anmeldung' : 'Server erreichbar', ok: false, ms: Date.now() - t0, message: (e as Error).message });
    }
    return steps;
  },
  help: 'Für Benachrichtigungen per E-Mail. Absender und Zugangsdaten stehen in der Verbindung; Empfänger legt der Workflow fest.',
};

function transport(conn: RuntimeConnection) {
  const c = conn.config;
  return nodemailer.createTransport({
    host: c.host,
    port: Number(c.port) || (c.security === 'tls' ? 465 : 587),
    secure: c.security === 'tls',
    requireTLS: c.security !== 'tls',
    auth: c.username ? { user: c.username, pass: conn.secrets.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

function recipients(list: unknown): string[] {
  return (Array.isArray(list) ? list : String(list ?? '').split(/[,;\n]/)).map((s) => String(s).trim()).filter(Boolean);
}

function validateRecipients(c: Record<string, any>): string[] {
  const out: string[] = [];
  const to = recipients(c.to);
  if (!to.length) out.push('Mindestens einen Empfänger angeben.');
  for (const r of [...to, ...recipients(c.cc), ...recipients(c.bcc)]) {
    if (r.includes('{{')) out.push(`Empfänger „${r}“: Variablen sind bei Empfängern nicht erlaubt (Schutz vor Fehlleitung).`);
    else if (!EMAIL_RE.test(r)) out.push(`„${r}“ ist keine gültige E-Mail-Adresse.`);
  }
  if (recipients(c.to).length + recipients(c.cc).length + recipients(c.bcc).length > 50) out.push('Höchstens 50 Empfänger.');
  return out;
}

function mailContent(ctx: ExecContext) {
  const c = ctx.node.config;
  const subject = ctx.render(c.subject).replace(/[\r\n]+/g, ' ').slice(0, 250);
  const text = ctx.render(c.text);
  const html = c.format === 'html' ? ctx.render(c.html, 'html') : undefined;
  return { subject, text, html, to: recipients(c.to), cc: recipients(c.cc), bcc: recipients(c.bcc) };
}

const mailFields = [
  { key: 'to', type: 'list' as const, label: 'Empfänger', required: true, help: 'Feste Adressen – aus Sicherheitsgründen keine Variablen.' },
  { key: 'cc', type: 'list' as const, label: 'CC', advanced: true },
  { key: 'bcc', type: 'list' as const, label: 'BCC', advanced: true },
  { key: 'subject', type: 'variableText' as const, label: 'Betreff', required: true },
  { key: 'format', type: 'select' as const, label: 'Format', default: 'text', options: [{ value: 'text', label: 'Text' }, { value: 'html', label: 'Text + HTML' }] },
  { key: 'text', type: 'variableTextarea' as const, label: 'Nachricht', required: true },
  { key: 'html', type: 'variableTextarea' as const, label: 'HTML-Version', showIf: { key: 'format', equals: 'html' }, help: 'Eingesetzte Variablen werden automatisch HTML-maskiert.' },
];

export const sendMailNode: NodeType = {
  type: 'email.send',
  category: 'action',
  title: 'E-Mail senden',
  description: 'Sendet eine E-Mail über die SMTP-Verbindung an fest hinterlegte Empfänger.',
  icon: 'Mail',
  connector: 'smtp',
  sideEffect: true,
  idempotent: false,
  targetFields: ['to', 'cc', 'bcc'],
  fields: mailFields,
  outputs: [{ id: 'out', label: 'Gesendet' }],
  outputFields: [
    { path: 'message_id', type: 'text', description: 'Message-ID der E-Mail' },
    { path: 'accepted', type: 'list', description: 'Angenommene Empfänger' },
  ],
  sampleOutput: { message_id: '<abc@beispiel.de>', accepted: ['leitung@beispiel.de'] },
  validate(c) {
    return [...validateRecipients(c), ...(c.subject ? [checkTemplate(c.subject)] : ['Betreff angeben.']), ...(c.text ? [checkTemplate(c.text)] : ['Nachricht angeben.'])].filter(Boolean) as string[];
  },
  async execute(ctx) {
    if (!ctx.connection) throw new StepError('config', 'Keine SMTP-Verbindung gewählt.');
    await assertHostAllowed(ctx.connection.config.host, !!ctx.connection.config.allowPrivate);
    const m = mailContent(ctx);
    try {
      const info = await transport(ctx.connection).sendMail({
        from: ctx.connection.config.from,
        to: m.to,
        cc: m.cc.length ? m.cc : undefined,
        bcc: m.bcc.length ? m.bcc : undefined,
        subject: m.subject,
        text: m.text,
        html: m.html,
        headers: { 'X-LifeLink-Run': String(ctx.run.id) },
        messageId: undefined,
      });
      return { output: { message_id: info.messageId, accepted: info.accepted, rejected: info.rejected }, externalRef: info.messageId, statusText: `${(info.accepted as unknown[]).length} Empfänger` };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { responseCode?: number; command?: string };
      if (err.responseCode === 535 || err.code === 'EAUTH') throw new StepError('auth', 'Der Mailserver hat die Anmeldung abgelehnt.', { technical: err.message, hint: 'Passwort der SMTP-Verbindung prüfen.' });
      if (err.responseCode && err.responseCode >= 500) throw new StepError('invalid_payload', 'Der Mailserver hat die Nachricht abgelehnt.', { technical: err.message });
      if (err.responseCode && err.responseCode >= 400) throw new StepError('transient', 'Der Mailserver ist vorübergehend nicht bereit.', { technical: err.message });
      // Abbruch nach DATA: Zustellung unklar
      if (err.command === 'DATA' || err.code === 'ETIMEDOUT') throw new StepError('timeout_unknown', 'Unklar, ob die E-Mail zugestellt wurde.', { technical: err.message, sideEffectUnknown: true });
      throw new StepError('transient', 'Der Mailserver ist nicht erreichbar.', { technical: err.message });
    }
  },
  async simulate(ctx) {
    const m = mailContent(ctx);
    return { output: { simuliert: true, an: m.to, betreff: m.subject, text: m.text }, statusText: `Simuliert: an ${m.to.length} Empfänger` };
  },
};

/* -------------------------------------- IMAP ---------------------------------------- */

export const imapConnector: Connector = {
  id: 'imap',
  name: 'E-Mail-Postfach (IMAP)',
  kind: 'E-Mail · IMAP',
  group: 'E-Mail',
  description: 'Neue E-Mails in einem Postfach erkennen und als Auslöser verwenden.',
  monogram: 'IM',
  color: '#B45309',
  needsConnection: true,
  setupMinutes: 2,
  fields: [
    { key: 'host', type: 'host', label: 'Server', required: true, placeholder: 'imap.beispiel.de' },
    { key: 'port', type: 'port', label: 'Port', default: 993 },
    { key: 'username', type: 'text', label: 'Benutzername', required: true },
    { key: 'mailbox', type: 'text', label: 'Ordner', default: 'INBOX' },
    { key: 'allowPrivate', type: 'switch', label: 'Interne Ziele erlauben', default: false, advanced: true },
  ],
  secretFields: [{ key: 'password', type: 'secret', label: 'Passwort' }],
  securityNotes: ['Nur verschlüsselte Verbindungen (TLS, Port 993).', 'LifeLink liest nur – E-Mails werden nicht gelöscht oder verschoben.'],
  testInfo: ['Server erreichen', 'Anmelden', 'Ordner öffnen'],
  async test(conn) {
    const t0 = Date.now();
    const client = imapClient(conn);
    try {
      await assertHostAllowed(conn.config.host, !!conn.config.allowPrivate);
      await client.connect();
      const t1 = Date.now();
      const box = await client.mailboxOpen(conn.config.mailbox || 'INBOX', { readOnly: true });
      return [
        { label: 'Anmeldung', ok: true, ms: t1 - t0 },
        { label: `Ordner „${conn.config.mailbox || 'INBOX'}“`, ok: true, ms: Date.now() - t1, message: `${box.exists} Nachrichten` },
      ];
    } catch (e) {
      return [{ label: 'Verbindung', ok: false, ms: Date.now() - t0, message: (e as Error).message }];
    } finally {
      await client.logout().catch(() => {});
    }
  },
};

export function imapClient(conn: RuntimeConnection) {
  return new ImapFlow({
    host: conn.config.host,
    port: Number(conn.config.port) || 993,
    secure: true,
    auth: { user: conn.config.username, pass: conn.secrets.password ?? '' },
    logger: false,
    socketTimeout: 60_000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

/** Holt neue Nachrichten seit dem Cursor (UID + UIDVALIDITY). Wird vom Trigger-Dienst aufgerufen. */
export async function pollImap(conn: RuntimeConnection, cursor: { uid?: number; validity?: string }, opts: { fromFilter?: string; subjectFilter?: string }) {
  await assertHostAllowed(conn.config.host, !!conn.config.allowPrivate);
  const client = imapClient(conn);
  await client.connect();
  try {
    const box = await client.mailboxOpen(conn.config.mailbox || 'INBOX', { readOnly: true });
    const validity = String(box.uidValidity);
    const messages: Record<string, unknown>[] = [];
    let lastUid = cursor.validity === validity ? (cursor.uid ?? 0) : 0;
    if (lastUid === 0 && cursor.validity !== validity) {
      // Erststart: nur ab jetzt, keine Altlasten verarbeiten
      return { messages, cursor: { uid: Math.max(0, Number(box.uidNext ?? 1) - 1), validity } };
    }
    for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, source: { maxLength: 200_000 } as any }, { uid: true })) {
      if (msg.uid <= lastUid) continue;
      lastUid = Math.max(lastUid, msg.uid);
      const from = msg.envelope?.from?.[0];
      const fromAddr = from?.address ?? '';
      const subject = msg.envelope?.subject ?? '';
      if (opts.fromFilter && !fromAddr.toLowerCase().includes(opts.fromFilter.toLowerCase())) continue;
      if (opts.subjectFilter && !subject.toLowerCase().includes(opts.subjectFilter.toLowerCase())) continue;
      const raw = msg.source?.toString('utf8') ?? '';
      const bodyStart = raw.indexOf('\r\n\r\n');
      messages.push({
        uid: msg.uid,
        message_id: msg.envelope?.messageId,
        from: fromAddr,
        from_name: from?.name ?? '',
        subject,
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        text: bodyStart >= 0 ? raw.slice(bodyStart + 4, bodyStart + 4 + 20_000) : '',
      });
      if (messages.length >= 25) break;
    }
    return { messages, cursor: { uid: lastUid, validity } };
  } finally {
    await client.logout().catch(() => {});
  }
}

export const imapTrigger: NodeType = {
  type: 'imap.mail',
  category: 'trigger',
  title: 'Neue E-Mail',
  description: 'Startet für jede neue E-Mail im Postfach einen Lauf.',
  icon: 'Inbox',
  connector: 'imap',
  trigger: 'imap',
  fields: [
    { key: 'intervalMinutes', type: 'number', label: 'Prüfen alle (Minuten)', default: 5, min: 1, max: 1440 },
    { key: 'fromFilter', type: 'text', label: 'Nur von Absender (enthält)', advanced: true },
    { key: 'subjectFilter', type: 'text', label: 'Nur mit Betreff (enthält)', advanced: true },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'from', type: 'text', description: 'Absenderadresse' },
    { path: 'from_name', type: 'text', description: 'Absendername' },
    { path: 'subject', type: 'text', description: 'Betreff' },
    { path: 'date', type: 'date', description: 'Datum' },
    { path: 'text', type: 'text', description: 'Inhalt (Rohtext, gekürzt)' },
  ],
  sampleOutput: { from: 'leitstelle@beispiel.de', from_name: 'Leitstelle', subject: 'Information', date: '2026-10-29T17:00:00.000Z', text: '…' },
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
};
