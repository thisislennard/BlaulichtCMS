import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { many, one, pool, tx } from '../db/pool.js';
import { deriveKey } from '../lib/crypto.js';
import { httpRequest } from '../lib/http.js';
import { log } from '../lib/log.js';
import { m365GraphBase, m365PrivateHosts, m365Token, storedM365Settings } from '../lib/mail.js';
import { notify } from '../lib/notify.js';
import { readSecret } from '../lib/secrets.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { emitNewPressRequest, nextPressCaseNo, pressEvent } from './common.js';
import { ImapClient, ImapError, imapSearchDate } from './imap.js';
import { htmlToText, parseMail, sanitizeHtml, type ParsedMail } from './mime.js';

/**
 * Abruf des Presse-Postfachs (#205): IMAP oder Microsoft 365 (Graph, gleiche App-Registrierung wie der Mailversand,
 * Anwendungsberechtigung Mail.Read – per Application Access Policy auf das Presse-Postfach beschränkbar).
 *
 * Der Abruf ist rein lesend: IMAP öffnet den Ordner mit EXAMINE und liest mit BODY.PEEK[] (nichts wird als gelesen
 * markiert oder verschoben), Graph liest nur. Wo der Abruf steht, merkt sich BlaulichtCMS selbst (IMAP: UIDVALIDITY
 * und letzte UID; Graph: Eingangszeit), doppelte Mails erkennt die Message-ID. Beim ersten Abruf werden nur Mails der
 * letzten 24 Stunden übernommen.
 *
 * Je Mail: automatische Antworten, Massenmails und vom Server als Spam markierte Mails werden ignoriert (Protokoll);
 * Antworten im selben Verlauf (In-Reply-To/References, sonst Vorgangsnummer im Betreff) hängen sich an die bestehende
 * Anfrage, alles andere wird eine neue Anfrage. Anhänge werden mit Größenlimit und Typprüfung am Inhalt übernommen.
 */

export interface MailboxConfig {
  enabled: boolean;
  mode: 'imap' | 'm365';
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  user: string;
  folder: string;
  secretId: string;
  /** Microsoft 365: Adresse des Presse-Postfachs */
  mailbox: string;
  intervalMinutes: number;
  maxAttachmentMb: number;
  verified: { fp: string; at: string } | null;
}

export const DEFAULT_MAILBOX: MailboxConfig = { enabled: false, mode: 'imap', host: '', port: 993, security: 'tls', user: '', folder: 'INBOX', secretId: '', mailbox: '', intervalMinutes: 5, maxAttachmentMb: 10, verified: null };

interface MailboxState {
  key?: string;
  uidValidity?: number;
  lastUid?: number;
  since?: string;
  lastRunAt?: string;
  lastOk?: boolean;
  lastError?: string | null;
  lastImported?: number;
}

export async function mailboxConfig(): Promise<MailboxConfig> {
  const s = await getSettings(true);
  return { ...DEFAULT_MAILBOX, ...((s['press.mailbox'] as Partial<MailboxConfig> | null) ?? {}) };
}

export async function mailboxState(): Promise<MailboxState> {
  return ((await getSettings(true))['press.mailbox_state'] as MailboxState | null) ?? {};
}

/** Kennung der Quelle: wechselt Server/Konto/Ordner, beginnt der Abruf neu. */
const sourceKey = (c: MailboxConfig) => (c.mode === 'm365' ? `m365:${c.mailbox.trim().toLowerCase()}` : `imap:${c.host.trim().toLowerCase()}:${c.port}:${c.user.trim().toLowerCase()}:${c.folder}`);

/** Prüfwert genau dieser Angaben (samt Passwort) – Aktivieren nur nach erfolgreichem Test. */
export function mailboxFingerprint(c: MailboxConfig, password: string): string {
  const canonical = JSON.stringify([sourceKey(c), c.security, c.mode === 'imap' ? password : '']);
  return crypto.createHmac('sha256', deriveKey('press-mailbox-verification')).update(canonical).digest('hex');
}

export function mailboxConfigProblem(c: MailboxConfig): string | null {
  if (c.mode === 'm365') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.mailbox.trim())) return 'Bitte die Adresse des Presse-Postfachs eintragen.';
    return null;
  }
  if (!/^[a-z0-9.-]+$/i.test(c.host.trim())) return 'Bitte den IMAP-Server eintragen (z. B. imap.example.org).';
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return 'Ungültiger Port.';
  if (!['tls', 'starttls'].includes(c.security)) return 'Bitte TLS oder STARTTLS wählen – ohne Verschlüsselung ist keine Anmeldung möglich.';
  if (!c.user.trim()) return 'Bitte den Benutzernamen eintragen.';
  if (!c.folder.trim() || /[\r\n"\\]/.test(c.folder)) return 'Ungültiger Ordnername.';
  return null;
}

/* ------------------------------------------------------------------ Quellen */

interface RawMail {
  externalId: string;
  raw: Buffer | null;
  size: number;
  receivedAt: Date | null;
}

const FIRST_RUN_MS = 24 * 3600_000;
const MAX_PER_RUN = 50;
const maxMailBytes = (c: MailboxConfig) => Math.max(5, c.maxAttachmentMb * 3) * 1024 * 1024;

function imapClient(c: MailboxConfig, password: string) {
  return new ImapClient({ host: c.host.trim(), port: c.port, security: c.security, user: c.user.trim(), password, timeoutMs: 30_000, maxLiteralBytes: maxMailBytes(c) + 1024 * 1024, plainForTests: !!process.env.VITEST && process.env.BLAULICHTCMS_IMAP_TEST_PLAIN === '1' });
}

async function fetchImap(c: MailboxConfig, password: string, state: MailboxState, fresh: boolean): Promise<{ mails: RawMail[]; next: MailboxState }> {
  const client = imapClient(c, password);
  try {
    await client.connect();
    const box = await client.examine(c.folder);
    let uids: number[];
    const restart = fresh || state.uidValidity !== box.uidValidity || !state.lastUid;
    if (restart) uids = await client.search(`SINCE ${imapSearchDate(new Date(Date.now() - FIRST_RUN_MS))}`);
    else uids = (await client.search(`UID ${state.lastUid! + 1}:*`)).filter((u) => u > state.lastUid!);
    const meta = uids.length ? await client.sizes(uids) : new Map();
    if (restart) uids = uids.filter((u) => (meta.get(u)?.internalDate?.getTime() ?? Date.now()) >= Date.now() - FIRST_RUN_MS);
    const truncated = uids.length > MAX_PER_RUN;
    uids = uids.slice(0, MAX_PER_RUN);
    const mails: RawMail[] = [];
    for (const uid of uids) {
      const m = meta.get(uid);
      const size = m?.size ?? 0;
      mails.push({ externalId: `${box.uidValidity}:${uid}`, size, receivedAt: m?.internalDate ?? null, raw: size > maxMailBytes(c) ? null : await client.fetchRaw(uid) });
    }
    let lastUid = restart ? 0 : state.lastUid!;
    if (uids.length) lastUid = Math.max(lastUid, ...uids);
    // erster Abruf: ältere Mails (auch mit höherer UID, z. B. hineinverschoben) gelten als gesehen
    if (restart && !truncated && box.exists) lastUid = Math.max(lastUid, (await client.search('ALL')).slice(-1)[0] ?? 0);
    return { mails, next: { ...state, uidValidity: box.uidValidity, lastUid } };
  } finally {
    await client.logout();
  }
}

async function graphGet(path: string, accept: string, maxBytes: number) {
  const m = await storedM365Settings();
  const token = await m365Token(m);
  const res = await httpRequest({ method: 'GET', url: `${m365GraphBase()}${path}`, headers: { authorization: `Bearer ${token}`, accept }, timeoutMs: 60_000, maxResponseBytes: maxBytes, maxRedirects: 0, allowPrivateHosts: m365PrivateHosts() });
  if (res.status !== 200) {
    let detail = res.text().slice(0, 200);
    try {
      const err = (res.json() as any)?.error;
      detail = `${err?.code ?? ''} ${err?.message ?? ''}`.trim().slice(0, 200) || detail;
    } catch {
      /* Text bleibt */
    }
    const hint = res.status === 403 ? 'Keine Berechtigung: In Microsoft Entra die Anwendungsberechtigung „Mail.Read“ (Microsoft Graph) mit Administratorzustimmung erteilen und das Presse-Postfach für die App freigeben.' : res.status === 404 ? 'Presse-Postfach nicht gefunden.' : 'Microsoft Graph meldet einen Fehler.';
    throw new Error(`${hint} (Graph ${res.status}: ${detail})`);
  }
  return res;
}

async function fetchGraph(c: MailboxConfig, state: MailboxState, fresh: boolean): Promise<{ mails: RawMail[]; next: MailboxState }> {
  const since = fresh || !state.since ? new Date(Date.now() - FIRST_RUN_MS).toISOString() : state.since;
  const box = encodeURIComponent(c.mailbox.trim());
  const q = new URLSearchParams({ $select: 'id,internetMessageId,receivedDateTime', $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime asc', $top: String(MAX_PER_RUN) });
  const list = (await graphGet(`/users/${box}/mailFolders/inbox/messages?${q.toString().replace(/\+/g, '%20')}`, 'application/json', 2 * 1024 * 1024)).json() as any;
  const items = (Array.isArray(list?.value) ? list.value : []) as { id: string; internetMessageId?: string; receivedDateTime?: string }[];
  const known = new Set((await many<{ external_id: string }>(`SELECT external_id FROM press_messages WHERE source = 'm365' AND external_id = ANY($1::text[])`, [items.map((i) => i.id)])).map((r) => r.external_id));
  const knownLog = new Set((await many<{ detail: string }>(`SELECT detail FROM press_mailbox_log WHERE detail = ANY($1::text[])`, [items.map((i) => `graph:${i.id}`)])).map((r) => r.detail));
  const mails: RawMail[] = [];
  let next = since;
  for (const it of items) {
    if (it.receivedDateTime && it.receivedDateTime > next) next = it.receivedDateTime;
    if (known.has(it.id) || knownLog.has(`graph:${it.id}`)) continue;
    const res = await graphGet(`/users/${box}/messages/${encodeURIComponent(it.id)}/$value`, 'message/rfc822, text/plain, */*', maxMailBytes(c) + 1024 * 1024).catch((e) => {
      if (/größer|too large|exceed/i.test(String(e?.message))) return null;
      throw e;
    });
    mails.push({ externalId: it.id, raw: res ? res.body : null, size: res?.body.length ?? maxMailBytes(c) + 1, receivedAt: it.receivedDateTime ? new Date(it.receivedDateTime) : null });
  }
  return { mails, next: { ...state, since: next } };
}

/** Verbindungstest: anmelden, Ordner öffnen, Anzahl der Nachrichten melden. Ändert nichts. */
export async function testMailbox(c: MailboxConfig, password: string): Promise<string> {
  const problem = mailboxConfigProblem(c);
  if (problem) throw new Error(problem);
  if (c.mode === 'm365') {
    const box = encodeURIComponent(c.mailbox.trim());
    const r = (await graphGet(`/users/${box}/mailFolders/inbox?$select=totalItemCount,unreadItemCount`, 'application/json', 256 * 1024)).json() as any;
    return `Verbindung in Ordnung: Posteingang mit ${Number(r?.totalItemCount ?? 0)} Nachrichten.`;
  }
  const client = imapClient(c, password);
  try {
    await client.connect();
    const box = await client.examine(c.folder);
    return `Verbindung in Ordnung: Ordner „${c.folder}“ mit ${box.exists} Nachrichten.`;
  } finally {
    await client.logout();
  }
}

/* ------------------------------------------------------------------ Einordnen */

const AUTO_SUBJECT = /^(automatische antwort|automatic reply|auto(matic)?[- ]?reply|abwesenheit|out of (the )?office|ich bin (derzeit )?nicht im büro|unzustellbar|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|zustellungsbericht|lesebestätigung|read:|gelesen:)/i;

/** Grund, eine Mail zu ignorieren – oder null. */
export function ignoreReason(m: ParsedMail, ownAddresses: string[]): { outcome: 'auto' | 'spam' | 'bulk' | 'own'; detail: string } | null {
  const h = (n: string) => (m.headers.get(n) ?? []).join(' ').trim();
  const auto = h('auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return { outcome: 'auto', detail: `Auto-Submitted: ${auto.slice(0, 40)}` };
  if (h('x-autoreply') || h('x-autorespond') || h('x-autoresponse')) return { outcome: 'auto', detail: 'Kennzeichnung als automatische Antwort' };
  if (/^(auto_reply|auto-reply)$/i.test(h('precedence'))) return { outcome: 'auto', detail: `Precedence: ${h('precedence')}` };
  if (m.contentType === 'multipart/report') return { outcome: 'auto', detail: 'Zustellbericht' };
  const from = m.from?.address ?? '';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)) return { outcome: 'auto', detail: `Absender ${from.split('@')[0]}` };
  if (AUTO_SUBJECT.test(m.subject.replace(/^((re|aw|wg|fwd?):\s*)+/i, ''))) return { outcome: 'auto', detail: 'Betreff einer automatischen Antwort' };
  if (/^yes\b/i.test(h('x-spam-flag')) || /^yes\b/i.test(h('x-spam-status')) || /^yes\b/i.test(h('x-spam'))) return { outcome: 'spam', detail: 'vom Mailserver als Spam markiert' };
  const scl = Number(/(?:^|;)\s*SCL:(-?\d+)/i.exec(h('x-ms-exchange-organization-scl') ? `SCL:${h('x-ms-exchange-organization-scl')}` : h('x-forefront-antispam-report'))?.[1] ?? -1);
  if (scl >= 5) return { outcome: 'spam', detail: `Microsoft-Spambewertung ${scl}` };
  if (/^(bulk|junk|list)$/i.test(h('precedence')) || h('list-id') || h('list-unsubscribe')) return { outcome: 'bulk', detail: 'Massenmail/Newsletter' };
  if (from && ownAddresses.includes(from)) return { outcome: 'own', detail: 'eigene Mail' };
  return null;
}

const ALLOWED_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  cfb: 'application/x-cfb',
  rtf: 'application/rtf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};
const TEXT_EXT = /\.(txt|csv|ics|vcf|eml)$/i;

/** Typprüfung am Inhalt (wie bei Uploads): erlaubter erkannter Typ oder reiner Text. */
export async function checkAttachment(filename: string, content: Buffer): Promise<{ ok: true; contentType: string } | { ok: false; reason: string }> {
  const ft = await fileTypeFromBuffer(content).catch(() => undefined);
  if (ft) {
    const ext = ft.ext === 'jpg' || ft.ext === 'jpeg' ? 'jpg' : ft.ext;
    if (ALLOWED_TYPES[ext]) return { ok: true, contentType: ext === 'cfb' ? 'application/octet-stream' : ALLOWED_TYPES[ext] };
    return { ok: false, reason: `Dateityp ${ft.ext} ist nicht erlaubt` };
  }
  if (TEXT_EXT.test(filename) && !content.subarray(0, 8192).includes(0)) return { ok: true, contentType: 'text/plain; charset=utf-8' };
  return { ok: false, reason: 'Dateityp nicht erkannt oder nicht erlaubt' };
}

const CASE_IN_SUBJECT = /\[(P-\d{4}-\d{4,})\]/;
const stripPrefixes = (s: string) => s.replace(/^\s*((re|aw|wg|fw|fwd|antw|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

async function logEntry(outcome: string, m: { subject?: string; from?: string; requestId?: string | null; detail?: string }) {
  await pool.query(`INSERT INTO press_mailbox_log (outcome, subject, from_address, request_id, detail) VALUES ($1,$2,$3,$4,$5)`, [outcome, (m.subject ?? '').slice(0, 200), (m.from ?? '').slice(0, 254), m.requestId ?? null, (m.detail ?? '').slice(0, 500)]);
}

export type IngestOutcome = 'created' | 'assigned' | 'duplicate' | 'auto' | 'spam' | 'bulk' | 'own' | 'too_large' | 'invalid';

/** Eine Mail einordnen: neue Anfrage, Antwort im Verlauf oder ignorieren. */
export async function ingestPressMail(raw: Buffer, meta: { source: 'imap' | 'm365'; externalId: string; receivedAt: Date | null; maxAttachmentMb: number; ownAddresses: string[] }): Promise<{ outcome: IngestOutcome; requestId?: string }> {
  let m: ParsedMail;
  try {
    m = parseMail(raw);
  } catch (e) {
    await logEntry('invalid', { detail: `Mail nicht lesbar: ${(e as Error).message}` });
    return { outcome: 'invalid' };
  }
  const from = m.from;
  const fromAddr = from?.address ?? '';
  // Antworten gehen an Reply-To, falls angegeben
  const contactAddr = m.replyTo[0]?.address ?? fromAddr;
  const messageId = m.messageId ?? `<${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)}@press.invalid>`;
  if (await one(`SELECT 1 FROM press_messages WHERE message_id = $1`, [messageId])) {
    await logEntry('duplicate', { subject: m.subject, from: fromAddr, detail: 'bereits übernommen (gleiche Message-ID)' });
    return { outcome: 'duplicate' };
  }
  const ignore = ignoreReason(m, meta.ownAddresses);
  if (ignore) {
    await logEntry(ignore.outcome, { subject: m.subject, from: fromAddr, detail: meta.source === 'm365' ? `graph:${meta.externalId}` : ignore.detail });
    return { outcome: ignore.outcome };
  }
  // Anhänge prüfen (Größe, Typ); Bilder, die nur im HTML eingebettet sind (cid), entfallen
  const limit = Math.max(1, meta.maxAttachmentMb) * 1024 * 1024;
  const kept: { filename: string; contentType: string; content: Buffer }[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  for (const a of m.attachments) {
    if (a.inline && a.contentId && a.contentType.startsWith('image/') && m.html?.includes(`cid:${a.contentId}`)) continue;
    if (a.content.length > limit) {
      skipped.push({ filename: a.filename, reason: `größer als ${meta.maxAttachmentMb} MB` });
      continue;
    }
    if (kept.length >= 20) {
      skipped.push({ filename: a.filename, reason: 'mehr als 20 Anhänge' });
      continue;
    }
    const chk = await checkAttachment(a.filename, a.content);
    if (chk.ok) kept.push({ filename: a.filename, contentType: chk.contentType, content: a.content });
    else skipped.push({ filename: a.filename, reason: chk.reason });
  }
  const safe = m.html ? sanitizeHtml(m.html) : null;
  const text = (m.text || (m.html ? htmlToText(m.html) : '')).slice(0, 200_000);
  const s = await getSettings();
  const result = await tx(async (db) => {
    // Verlauf: In-Reply-To/References, sonst Vorgangsnummer im Betreff
    const ids = [m.inReplyTo, ...m.references].filter(Boolean) as string[];
    let requestId: string | null = ids.length ? ((await one<{ request_id: string }>(`SELECT request_id FROM press_messages WHERE message_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 1`, [ids], db))?.request_id ?? null) : null;
    const caseNo = CASE_IN_SUBJECT.exec(m.subject)?.[1];
    if (!requestId && caseNo) requestId = (await one<{ id: string }>(`SELECT id FROM press_requests WHERE case_no = $1`, [caseNo], db))?.id ?? null;
    let created = false;
    let caseNoOut: string;
    if (requestId) {
      const r = await one<any>(`SELECT case_no, status FROM press_requests WHERE id = $1 FOR UPDATE`, [requestId], db);
      caseNoOut = r.case_no;
      if (r.status === 'answered' || r.status === 'done') {
        await db.query(`UPDATE press_requests SET status = 'in_progress', done_at = NULL WHERE id = $1`, [requestId]);
        await pressEvent(db, requestId, null, 'status', `Status: ${r.status === 'done' ? 'erledigt' : 'beantwortet'} → in Bearbeitung (neue Mail)`, { status: 'in_progress' });
      }
    } else {
      caseNoOut = await nextPressCaseNo(db, s['general.timezone'] || 'Europe/Berlin');
      const row = await one<{ id: string }>(
        `INSERT INTO press_requests (case_no, status, channel, contact_name, contact_email, topic, body) VALUES ($1,'new','mailbox',$2,$3,$4,$5) RETURNING id`,
        [caseNoOut, (from?.name ?? '').slice(0, 200), contactAddr.slice(0, 254), (stripPrefixes(m.subject) || '(ohne Betreff)').slice(0, 300), text.slice(0, 20_000)],
        db,
      );
      requestId = row!.id;
      created = true;
      await pressEvent(db, requestId, null, 'created', 'Eingang über das Presse-Postfach');
    }
    const msg = await one<{ id: string }>(
      `INSERT INTO press_messages (request_id, direction, status, message_id, in_reply_to, refs, from_address, from_name, to_addresses, cc_addresses, subject, text_body, html_body, blocked_images, skipped_attachments, source, external_id, received_at)
       VALUES ($1,'in','received',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [requestId, messageId, m.inReplyTo, m.references, fromAddr, from?.name ?? '', m.to.map((a) => a.address).slice(0, 50), m.cc.map((a) => a.address).slice(0, 50), m.subject.slice(0, 500), text, safe?.html.slice(0, 500_000) ?? null, safe?.blockedImages ?? 0, JSON.stringify(skipped), meta.source, meta.externalId, m.date ?? meta.receivedAt ?? new Date()],
      db,
    );
    for (const a of kept) {
      await db.query(`INSERT INTO press_attachments (message_id, filename, content_type, size, sha256, data) VALUES ($1,$2,$3,$4,$5,$6)`, [msg!.id, a.filename, a.contentType, a.content.length, crypto.createHash('sha256').update(a.content).digest('hex'), a.content]);
    }
    if (!created) await pressEvent(db, requestId, null, 'mail_in', `Mail eingegangen: ${m.subject.slice(0, 200)}${kept.length ? ` (${kept.length} Anhang/Anhänge)` : ''}`);
    if (created) await emitNewPressRequest(requestId, db);
    return { requestId, created, caseNo: caseNoOut };
  });
  await logEntry(result.created ? 'created' : 'assigned', { subject: m.subject, from: fromAddr, requestId: result.requestId, detail: `${result.caseNo}${kept.length ? ` · ${kept.length} Anhang/Anhänge` : ''}${skipped.length ? ` · ${skipped.length} nicht übernommen` : ''}` });
  const topic = stripPrefixes(m.subject).slice(0, 200);
  if (result.created) await notify({ kind: 'info', title: `Neue Presseanfrage ${result.caseNo} (Presse-Postfach)`, body: topic, link: `/presse/${result.requestId}`, permission: 'press.manage', category: 'press' });
  else {
    const a = await one<{ assignee_id: string | null }>(`SELECT assignee_id FROM press_requests WHERE id = $1`, [result.requestId]);
    await notify({ kind: 'info', title: `Neue Mail zur Presseanfrage ${result.caseNo}`, body: topic, link: `/presse/${result.requestId}`, ...(a?.assignee_id ? { userId: a.assignee_id } : { permission: 'press.manage' }), category: 'press' });
  }
  return { outcome: result.created ? 'created' : 'assigned', requestId: result.requestId };
}

/* ------------------------------------------------------------------ Abruf */

const LOCK = 74_210_205;

/** Abruf, wenn eingeschaltet und fällig (Worker) bzw. sofort (`force`, „Jetzt abrufen“). */
export async function pollPressMailbox(opts: { force?: boolean } = {}): Promise<{ ran: boolean; imported?: number; error?: string }> {
  const c = await mailboxConfig();
  if (!c.enabled && !opts.force) return { ran: false };
  const state = await mailboxState();
  const key = sourceKey(c);
  if (!opts.force && state.lastRunAt && Date.now() - new Date(state.lastRunAt).getTime() < Math.max(1, c.intervalMinutes) * 60_000 - 5_000) return { ran: false };
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    if (!got.rows[0].ok) return { ran: false, error: 'Ein Abruf läuft bereits.' };
    try {
      const fresh = state.key !== key;
      let imported = 0;
      const s = await getSettings(true);
      const own = [s['smtp.from'], s['m365.sender'], c.mailbox, c.user].map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => x.includes('@'));
      try {
        const password = c.mode === 'imap' ? ((await readSecret(c.secretId || null)) ?? '') : '';
        const { mails, next } = c.mode === 'm365' ? await fetchGraph(c, fresh ? {} : state, fresh) : await fetchImap(c, password, fresh ? {} : state, fresh);
        for (const mail of mails) {
          if (!mail.raw) {
            await logEntry('too_large', { detail: `Mail mit ${Math.round(mail.size / 1024 / 1024)} MB nicht übernommen (Grenze ${Math.round(maxMailBytes(c) / 1024 / 1024)} MB)${c.mode === 'm365' ? ` · graph:${mail.externalId}` : ''}` });
            continue;
          }
          const r = await ingestPressMail(mail.raw, { source: c.mode, externalId: mail.externalId, receivedAt: mail.receivedAt, maxAttachmentMb: c.maxAttachmentMb, ownAddresses: own });
          if (r.outcome === 'created' || r.outcome === 'assigned') imported++;
        }
        const wasFailing = state.lastOk === false;
        await setSettings({ 'press.mailbox_state': { ...next, key, lastRunAt: new Date().toISOString(), lastOk: true, lastError: null, lastImported: imported } } as any);
        if (wasFailing) await logEntry('ok', { detail: 'Abruf wieder erfolgreich' });
        return { ran: true, imported };
      } catch (e) {
        const msg = e instanceof ImapError || e instanceof Error ? e.message : String(e);
        await logEntry('error', { detail: msg });
        log('warn', 'press', `Presse-Postfach: ${msg}`);
        // eine Meldung je Störung (nicht bei jedem Abruf)
        if (state.lastOk !== false) await notify({ kind: 'error', title: 'Presse-Postfach: Abruf fehlgeschlagen', body: msg.slice(0, 300), link: '/presse/einstellungen', permission: 'press.mailbox', category: 'press' });
        await setSettings({ 'press.mailbox_state': { ...state, key: state.key, lastRunAt: new Date().toISOString(), lastOk: false, lastError: msg.slice(0, 500) } } as any);
        return { ran: true, error: msg };
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    client.release();
  }
}
