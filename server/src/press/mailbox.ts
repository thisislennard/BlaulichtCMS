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
import { cleanLine, cleanText, htmlToText, parseMail, sanitizeHtml, type ParsedMail } from './mime.js';
import { ownSenderAddresses, parseMailbox } from '../lib/mail-address.js';

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
 *
 * Abruf je Mail (#237, #239): Mails werden einzeln geholt und sofort eingeordnet, der Fortschritt wird nach jeder Mail
 * gespeichert – es liegt höchstens eine Mail im Speicher, und ein Abbruch verliert nichts. Eine Mail, die sich nicht
 * übernehmen lässt, steht als „nicht übernommen“ im Empfangsprotokoll (sie bleibt unverändert im Postfach) und hält die
 * folgenden nie auf. Bricht die Verarbeitung derselben Mail mehrfach ab (Zeitüberschreitung, Absturz des Workers), wird
 * sie nach MAX_ATTEMPTS Versuchen übersprungen. Je Durchgang höchstens MAX_PER_RUN Mails bzw. MAX_BYTES_PER_RUN Bytes;
 * der Rest folgt im nächsten Durchgang ohne Wartezeit.
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
  /** IMAP: erster Abruf (Rückblick 24 Stunden) noch nicht vollständig */
  initial?: boolean;
  since?: string;
  /** Mail in Arbeit – vor der Verarbeitung gespeichert, damit auch ein Absturz als Versuch zählt */
  current?: { id: string; attempts: number } | null;
  /** Durchgang nicht vollständig (Höchstzahl/-menge erreicht): nächster Abruf ohne Wartezeit */
  more?: boolean;
  lastRunAt?: string;
  lastOk?: boolean;
  lastError?: string | null;
  lastImported?: number;
  lastSkipped?: number;
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

const FIRST_RUN_MS = 24 * 3600_000;
/** Höchstens so viele Mails bzw. Bytes je Durchgang – der Rest folgt im nächsten Durchgang (#239). */
const MAX_PER_RUN = 50;
const MAX_BYTES_PER_RUN = 200 * 1024 * 1024;
/** So oft darf die Verarbeitung derselben Mail abbrechen, danach wird sie übersprungen (#237, #239). */
export const MAX_ATTEMPTS = 3;
const maxMailBytes = (c: MailboxConfig) => Math.max(5, c.maxAttachmentMb * 3) * 1024 * 1024;

/** IMAP-Client mit derselben Freigabe interner Ziele wie alle anderen ausgehenden Verbindungen (#234). */
async function imapClient(c: MailboxConfig, password: string) {
  const allowPrivateHosts = ((await getSettings())['security.allowed_private_hosts'] ?? []) as string[];
  return new ImapClient({ host: c.host.trim(), port: c.port, security: c.security, user: c.user.trim(), password, timeoutMs: 30_000, maxLiteralBytes: maxMailBytes(c) + 1024 * 1024, allowPrivateHosts, plainForTests: !!process.env.VITEST && process.env.BLAULICHTCMS_IMAP_TEST_PLAIN === '1' });
}

/** Ein laufender Durchgang: Fortschritt wird nach jeder Mail gespeichert. */
interface Run {
  c: MailboxConfig;
  key: string;
  own: string[];
  state: MailboxState;
  imported: number;
  skipped: number;
  bytes: number;
}

async function saveProgress(run: Run, patch: Partial<MailboxState>) {
  run.state = { ...run.state, ...patch, key: run.key };
  await setSettings({ 'press.mailbox_state': run.state } as any);
}

/** Eine Mail im Postfach, die geholt und eingeordnet werden soll. */
interface Candidate {
  /** Kennung im Postfach (IMAP: Quelle:UIDVALIDITY:UID, Microsoft 365: Nachrichten-ID) */
  externalId: string;
  /** Größe laut Server (0 = unbekannt) */
  size: number;
  receivedAt: Date | null;
  /** Inhalt holen: Rohmail, 'too_large' oder null (nicht mehr im Postfach) */
  fetch: () => Promise<Buffer | 'too_large' | null>;
  /** Fortschritt, sobald diese Mail erledigt ist */
  done: Partial<MailboxState>;
}

const mb = (n: number) => Math.max(1, Math.round(n / 1024 / 1024));
const when = (d: Date | null) => (d ? ` vom ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

/** Eine Mail holen und einordnen – höchstens eine Mail liegt dabei im Speicher. */
async function processMail(run: Run, m: Candidate): Promise<void> {
  const ref = { source: run.c.mode, externalId: m.externalId };
  const prev = run.state.current;
  const attempts = prev?.id === m.externalId ? prev.attempts : 0;
  if (attempts >= MAX_ATTEMPTS) {
    await logEntry('invalid', { detail: `Mail${when(m.receivedAt)} übersprungen: ${attempts} Versuche sind abgebrochen (Zeitüberschreitung oder Abbruch beim Verarbeiten). Sie bleibt unverändert im Postfach.`, ref });
    run.skipped++;
    await saveProgress(run, { ...m.done, current: null });
    return;
  }
  if (m.size > maxMailBytes(run.c)) {
    await logEntry('too_large', { detail: `Mail${when(m.receivedAt)} mit ${mb(m.size)} MB nicht übernommen (Grenze ${mb(maxMailBytes(run.c))} MB) – sie bleibt im Postfach.`, ref });
    await saveProgress(run, { ...m.done, current: null });
    return;
  }
  // vor dem Holen merken: bricht der Worker mitten in dieser Mail ab (Speicher, Neustart), zählt das als Versuch
  await saveProgress(run, { current: { id: m.externalId, attempts: attempts + 1 } });
  // Verbindungsfehler beim Holen brechen den Durchgang ab; der Fortschritt bis zur letzten fertigen Mail bleibt
  const raw = await m.fetch();
  if (raw === 'too_large') await logEntry('too_large', { detail: `Mail${when(m.receivedAt)} größer als ${mb(maxMailBytes(run.c))} MB nicht übernommen – sie bleibt im Postfach.`, ref });
  else if (!raw) await logEntry('invalid', { detail: `Mail${when(m.receivedAt)} ist nicht mehr im Postfach.`, ref });
  else {
    run.bytes += raw.length;
    const r = await ingestPressMail(raw, { source: run.c.mode, externalId: m.externalId, receivedAt: m.receivedAt, maxAttachmentMb: run.c.maxAttachmentMb, ownAddresses: run.own });
    if (r.outcome === 'created' || r.outcome === 'assigned') run.imported++;
    if (r.outcome === 'invalid') run.skipped++;
  }
  await saveProgress(run, { ...m.done, current: null });
}

/** IMAP: neue UIDs seit dem letzten Stand (erster Abruf: 24 Stunden) einzeln holen. Gibt zurück, ob noch Mails warten. */
async function runImap(run: Run, password: string): Promise<boolean> {
  const { c } = run;
  const client = await imapClient(c, password);
  try {
    await client.connect();
    const box = await client.examine(c.folder);
    const st = run.state;
    const reset = st.uidValidity !== box.uidValidity;
    const initial = reset || !!st.initial || !st.lastUid;
    const from = reset ? 0 : (st.lastUid ?? 0);
    let uids = (initial ? await client.search(`SINCE ${imapSearchDate(new Date(Date.now() - FIRST_RUN_MS))}`) : await client.search(`UID ${from + 1}:*`)).filter((u) => u > from);
    const meta = uids.length ? await client.sizes(uids) : new Map<number, { size: number; internalDate: Date | null }>();
    if (initial) uids = uids.filter((u) => (meta.get(u)?.internalDate?.getTime() ?? Date.now()) >= Date.now() - FIRST_RUN_MS);
    let more = uids.length > MAX_PER_RUN;
    uids = uids.slice(0, MAX_PER_RUN);
    // Kennung je Quelle: ein anderer Server/Ordner kann dieselbe UIDVALIDITY haben – UIDs dürfen nicht kollidieren
    const src = crypto.createHash('sha256').update(run.key).digest('hex').slice(0, 12);
    await saveProgress(run, { uidValidity: box.uidValidity, lastUid: from, initial, ...(reset ? { current: null } : {}) });
    for (const uid of uids) {
      if (run.bytes >= MAX_BYTES_PER_RUN) {
        more = true;
        break;
      }
      const m = meta.get(uid);
      await processMail(run, { externalId: `${src}:${box.uidValidity}:${uid}`, size: m?.size ?? 0, receivedAt: m?.internalDate ?? null, fetch: () => client.fetchRaw(uid), done: { lastUid: uid } });
    }
    // erster Abruf vollständig: ältere Mails (auch mit höherer UID, z. B. hineinverschoben) gelten als gesehen
    if (initial && !more) {
      const highest = box.exists ? ((await client.search('ALL')).slice(-1)[0] ?? 0) : 0;
      await saveProgress(run, { lastUid: Math.max(run.state.lastUid ?? 0, highest), initial: false });
    }
    return more;
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

/** Microsoft 365: Nachrichten seit dem letzten Eingang (erster Abruf: 24 Stunden) einzeln holen. Gibt zurück, ob noch Mails warten. */
async function runGraph(run: Run): Promise<boolean> {
  const { c } = run;
  const since = run.state.since || new Date(Date.now() - FIRST_RUN_MS).toISOString();
  const box = encodeURIComponent(c.mailbox.trim());
  const q = new URLSearchParams({ $select: 'id,internetMessageId,receivedDateTime', $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime asc', $top: String(MAX_PER_RUN) });
  const list = (await graphGet(`/users/${box}/mailFolders/inbox/messages?${q.toString().replace(/\+/g, '%20')}`, 'application/json', 2 * 1024 * 1024)).json() as any;
  const items = (Array.isArray(list?.value) ? list.value : []) as { id: string; internetMessageId?: string; receivedDateTime?: string }[];
  const ids = items.map((i) => i.id);
  const known = new Set((await many<{ external_id: string }>(`SELECT external_id FROM press_messages WHERE source = 'm365' AND external_id = ANY($1::text[])`, [ids])).map((r) => r.external_id));
  // schon im Empfangsprotokoll (ignoriert, zu groß, nicht übernommen) – auch Einträge aus der Zeit vor #237 („graph:…“)
  for (const r of await many<{ external_id: string | null; detail: string }>(`SELECT external_id, detail FROM press_mailbox_log WHERE (source = 'm365' AND external_id = ANY($1::text[])) OR detail = ANY($2::text[])`, [ids, ids.map((i) => `graph:${i}`)])) {
    known.add(r.external_id ?? r.detail.slice('graph:'.length));
  }
  let more = items.length >= MAX_PER_RUN;
  let next = since;
  for (const it of items) {
    const at = it.receivedDateTime && it.receivedDateTime > next ? it.receivedDateTime : next;
    if (!known.has(it.id)) {
      if (run.bytes >= MAX_BYTES_PER_RUN) {
        more = true;
        break;
      }
      await processMail(run, {
        externalId: it.id,
        size: 0,
        receivedAt: it.receivedDateTime ? new Date(it.receivedDateTime) : null,
        fetch: async () => {
          const res = await graphGet(`/users/${box}/messages/${encodeURIComponent(it.id)}/$value`, 'message/rfc822, text/plain, */*', maxMailBytes(c) + 1024 * 1024).catch((e) => {
            if (/größer|too large|exceed/i.test(String(e?.message))) return null;
            throw e;
          });
          return res ? res.body : 'too_large';
        },
        done: { since: at },
      });
    }
    next = at;
  }
  if (next !== run.state.since) await saveProgress(run, { since: next });
  return more;
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
  const client = await imapClient(c, password);
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

type MailRef = { source: 'imap' | 'm365'; externalId: string };

async function logEntry(outcome: string, m: { subject?: string; from?: string; requestId?: string | null; detail?: string; ref?: MailRef }) {
  await pool.query(`INSERT INTO press_mailbox_log (outcome, subject, from_address, request_id, detail, source, external_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    outcome,
    cleanLine(m.subject ?? '').slice(0, 200),
    cleanLine(m.from ?? '').slice(0, 254),
    m.requestId ?? null,
    cleanText(m.detail ?? '').slice(0, 500),
    m.ref?.source ?? null,
    m.ref?.externalId.slice(0, 500) ?? null,
  ]);
}

/**
 * Fehler, die nicht an der Mail liegen (Datenbank nicht erreichbar oder überlastet, Neustart, Abbruch, Sperrkonflikt):
 * dann bricht der Durchgang ab und die Mail kommt beim nächsten Abruf erneut an die Reihe.
 */
export function isTransientError(e: unknown): boolean {
  const code = String((e as any)?.code ?? '');
  if (/^(08|53|57P|58)/.test(code) || ['57014', '40001', '40P01'].includes(code)) return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|connection error|Cannot use a pool after calling end/i.test(String((e as any)?.message ?? ''));
}

export type IngestOutcome = 'created' | 'assigned' | 'duplicate' | 'auto' | 'spam' | 'bulk' | 'own' | 'too_large' | 'invalid';

type IngestMeta = { source: 'imap' | 'm365'; externalId: string; receivedAt: Date | null; maxAttachmentMb: number; ownAddresses: string[] };

/**
 * Eine Mail einordnen: neue Anfrage, Antwort im Verlauf oder ignorieren. Lässt sie sich nicht übernehmen, steht sie als
 * „nicht übernommen“ im Empfangsprotokoll (#237) – nur Fehler, die nicht an der Mail liegen (isTransientError), werden
 * weitergereicht.
 */
export async function ingestPressMail(raw: Buffer, meta: IngestMeta): Promise<{ outcome: IngestOutcome; requestId?: string }> {
  const ref: MailRef = { source: meta.source, externalId: meta.externalId };
  let m: ParsedMail;
  try {
    m = parseMail(raw);
  } catch (e) {
    await logEntry('invalid', { detail: `Mail nicht lesbar (${(e as Error).message}) – sie bleibt unverändert im Postfach.`, ref });
    return { outcome: 'invalid' };
  }
  try {
    return await ingestParsed(m, raw, meta, ref);
  } catch (e) {
    if (isTransientError(e)) throw e;
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    log('warn', 'press', `Presse-Postfach: Mail nicht übernommen: ${msg}`);
    await logEntry('invalid', { subject: m.subject, from: m.from?.address, detail: `Mail konnte nicht übernommen werden (${msg}) – sie bleibt unverändert im Postfach.`, ref });
    return { outcome: 'invalid' };
  }
}

async function ingestParsed(m: ParsedMail, raw: Buffer, meta: IngestMeta, ref: MailRef): Promise<{ outcome: IngestOutcome; requestId?: string }> {
  const from = m.from;
  const fromAddr = from?.address ?? '';
  // Antworten gehen an Reply-To, falls angegeben
  const contactAddr = m.replyTo[0]?.address ?? fromAddr;
  const messageId = m.messageId ?? `<${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)}@press.invalid>`;
  if (await one(`SELECT 1 FROM press_messages WHERE message_id = $1`, [messageId])) {
    await logEntry('duplicate', { subject: m.subject, from: fromAddr, detail: 'bereits übernommen (gleiche Message-ID)', ref });
    return { outcome: 'duplicate' };
  }
  const ignore = ignoreReason(m, meta.ownAddresses);
  if (ignore) {
    await logEntry(ignore.outcome, { subject: m.subject, from: fromAddr, detail: ignore.detail, ref });
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
  const text = cleanText(m.text || (m.html ? htmlToText(m.html) : '')).slice(0, 200_000);
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
  // Ab hier ist die Mail übernommen: Protokoll und Benachrichtigung dürfen das Ergebnis nicht mehr umstoßen
  try {
    await logEntry(result.created ? 'created' : 'assigned', { subject: m.subject, from: fromAddr, requestId: result.requestId, detail: `${result.caseNo}${kept.length ? ` · ${kept.length} Anhang/Anhänge` : ''}${skipped.length ? ` · ${skipped.length} nicht übernommen` : ''}`, ref });
    const topic = stripPrefixes(m.subject).slice(0, 200);
    if (result.created) await notify({ kind: 'info', title: `Neue Presseanfrage ${result.caseNo} (Presse-Postfach)`, body: topic, link: `/presse/${result.requestId}`, permission: 'press.manage', category: 'press' });
    else {
      const a = await one<{ assignee_id: string | null }>(`SELECT assignee_id FROM press_requests WHERE id = $1`, [result.requestId]);
      await notify({ kind: 'info', title: `Neue Mail zur Presseanfrage ${result.caseNo}`, body: topic, link: `/presse/${result.requestId}`, ...(a?.assignee_id ? { userId: a.assignee_id } : { permission: 'press.manage' }), category: 'press' });
    }
  } catch (e) {
    log('warn', 'press', `Presse-Postfach: Protokoll/Benachrichtigung zu ${result.caseNo}: ${(e as Error).message}`);
  }
  return { outcome: result.created ? 'created' : 'assigned', requestId: result.requestId };
}

/* ------------------------------------------------------------------ Abruf */

const LOCK = 74_210_205;

/** Abruf, wenn eingeschaltet und fällig (Worker) bzw. sofort (`force`, „Jetzt abrufen“). */
export async function pollPressMailbox(opts: { force?: boolean } = {}): Promise<{ ran: boolean; imported?: number; skipped?: number; more?: boolean; error?: string }> {
  const c = await mailboxConfig();
  if (!c.enabled && !opts.force) return { ran: false };
  const state = await mailboxState();
  const key = sourceKey(c);
  // Wartezeit entfällt, solange vom letzten Durchgang noch Mails übrig sind
  if (!opts.force && !state.more && state.lastRunAt && Date.now() - new Date(state.lastRunAt).getTime() < Math.max(1, c.intervalMinutes) * 60_000 - 5_000) return { ran: false };
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    if (!got.rows[0].ok) return { ran: false, error: 'Ein Abruf läuft bereits.' };
    try {
      const fresh = state.key !== key;
      const s = await getSettings(true);
      const own = [...new Set([...ownSenderAddresses(s), ...[c.mailbox, c.user].map((x) => parseMailbox(x)?.address.toLowerCase() ?? '')].filter(Boolean))];
      const run: Run = { c, key, own, state: fresh ? { key } : { ...state }, imported: 0, skipped: 0, bytes: 0 };
      const reportSkipped = async () => {
        if (!run.skipped) return;
        await notify({ kind: 'warning', title: `Presse-Postfach: ${run.skipped === 1 ? 'eine Mail' : `${run.skipped} Mails`} nicht übernommen`, body: 'Die Mails bleiben unverändert im Postfach. Grund und Zeitpunkt stehen im Empfangsprotokoll – bitte dort nachsehen und ggf. von Hand erfassen.', link: '/presse/einstellungen', permission: 'press.mailbox', category: 'press' }).catch(() => {});
      };
      try {
        const password = c.mode === 'imap' ? ((await readSecret(c.secretId || null)) ?? '') : '';
        const more = c.mode === 'm365' ? await runGraph(run) : await runImap(run, password);
        const wasFailing = state.lastOk === false;
        await saveProgress(run, { lastRunAt: new Date().toISOString(), lastOk: true, lastError: null, lastImported: run.imported, lastSkipped: run.skipped, more });
        if (wasFailing) await logEntry('ok', { detail: 'Abruf wieder erfolgreich' });
        await reportSkipped();
        return { ran: true, imported: run.imported, skipped: run.skipped, more };
      } catch (e) {
        const msg = e instanceof ImapError || e instanceof Error ? e.message : String(e);
        await logEntry('error', { detail: msg }).catch(() => {});
        log('warn', 'press', `Presse-Postfach: ${msg}`);
        // eine Meldung je Störung (nicht bei jedem Abruf)
        if (state.lastOk !== false) await notify({ kind: 'error', title: 'Presse-Postfach: Abruf fehlgeschlagen', body: msg.slice(0, 300), link: '/presse/einstellungen', permission: 'press.mailbox', category: 'press' }).catch(() => {});
        await reportSkipped();
        // Fortschritt bis zur letzten fertigen Mail bleibt erhalten (run.state)
        await saveProgress(run, { lastRunAt: new Date().toISOString(), lastOk: false, lastError: msg.slice(0, 500), more: false }).catch(() => {});
        return { ran: true, imported: run.imported, skipped: run.skipped, error: msg };
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    client.release();
  }
}
