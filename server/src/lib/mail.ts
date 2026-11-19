import crypto from 'node:crypto';
import { httpRequest, type HttpResponse } from './http.js';
import { deriveKey } from './crypto.js';
import { readSecret } from './secrets.js';
import { getSettings, type Settings } from './settings.js';
import { StepError } from './errors.js';

/**
 * E-Mail-Versand über Microsoft 365 (#191) – wie LiFeOS „Versand als Anwendung“ (#926): Die App meldet sich mit
 * Client-Credentials (Tenant-ID, Client-ID, Client-Geheimnis) bei Microsoft Entra an und sendet über Microsoft Graph
 * `POST /users/{Absender}/sendMail`. Kein angemeldeter Benutzer, kein ablaufendes Benutzer-Token. Ohne Zusatzbibliothek:
 * zwei HTTPS-Aufrufe über lib/http.ts (SSRF-Schutz, Zeitlimit, Größenlimit).
 *
 * Die Transport-Hülle verhält sich wie ein Nodemailer-Transport (sendMail/close), damit Warnversand, Sicherheitsmeldungen,
 * Automationen und Benachrichtigungen unverändert über warnings/mail.ts smtpTransport() senden. Fehler tragen dieselben
 * Merkmale wie SMTP-Fehler, damit classifySmtpError() „sicher nicht gesendet“ und „Ergebnis unbekannt“ unterscheidet:
 * eine eindeutige HTTP-Antwort ⇒ responseCode; nicht erreichbar ⇒ code; Abbruch nach dem Senden ⇒ ohne code (unbekannt).
 */

export interface M365Settings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sender: string;
  saveSent: boolean;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

/** Nur in Tests: Microsoft-Adressen auf einen lokalen Stellvertreter umlenken. */
function testBase(): string | null {
  return process.env.VITEST ? (process.env.BLAULICHTCMS_M365_TEST_URL ?? null) : null;
}
const graphBase = () => (testBase() ? `${testBase()}/graph` : GRAPH);
const loginBase = () => (testBase() ? `${testBase()}/login` : LOGIN);
const privateHosts = () => (testBase() ? [new URL(testBase()!).hostname] : []);
/** Für weitere Graph-Aufrufe mit derselben App-Registrierung (Presse-Postfach #205). */
export const m365GraphBase = graphBase;
export const m365PrivateHosts = privateHosts;

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Formale Prüfung der Microsoft-365-Angaben; gibt eine Fehlermeldung zurück oder null. */
export function m365ConfigProblem(c: { tenantId: string; clientId: string; sender: string; clientSecret?: string }, requireSecret = true): string | null {
  const tenant = c.tenantId.trim();
  if (!tenant) return 'Bitte die Verzeichnis-ID (Tenant-ID) eintragen.';
  if (!GUID_RE.test(tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenant)) return 'Die Tenant-ID ist eine GUID (oder die Domain des Verzeichnisses, z. B. example.onmicrosoft.com).';
  if (!GUID_RE.test(c.clientId.trim())) return 'Die Anwendungs-ID (Client-ID) ist eine GUID aus der App-Registrierung.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.sender.trim())) return 'Bitte das Absenderpostfach als E-Mail-Adresse eintragen.';
  if (requireSecret && !String(c.clientSecret ?? '')) return 'Bitte das Client-Geheimnis eintragen.';
  return null;
}

export async function storedM365Settings(s?: Settings): Promise<M365Settings> {
  s ??= await getSettings(true);
  return {
    tenantId: String(s['m365.tenant_id'] ?? ''),
    clientId: String(s['m365.client_id'] ?? ''),
    sender: String(s['m365.sender'] ?? ''),
    saveSent: s['m365.save_sent'] !== false,
    clientSecret: (await readSecret(s['m365.secret_id'] || null)) ?? '',
  };
}

/** Prüfwert genau dieser Angaben (HMAC mit eigenem abgeleiteten Schlüssel) – für „Aktivieren nur nach Test“. */
export function m365Fingerprint(c: M365Settings): string {
  const canonical = JSON.stringify([c.tenantId.trim().toLowerCase(), c.clientId.trim().toLowerCase(), c.sender.trim().toLowerCase(), c.clientSecret]);
  return crypto.createHmac('sha256', deriveKey('m365-verification')).update(canonical).digest('hex');
}

/** E-Mail-Versand eingerichtet (gewählter Weg vollständig)? */
export function mailReady(s: Settings): boolean {
  if (s['mail.transport'] === 'm365') return !!(s['m365.tenant_id'] && s['m365.client_id'] && s['m365.sender'] && s['m365.secret_id']);
  return !!(s['smtp.host'] && s['smtp.from']);
}

/** Klartextbezeichnung des aktiven Wegs (Anzeige, Audit). */
export function mailRouteLabel(s: Settings): string {
  if (s['mail.transport'] === 'm365') return `Microsoft 365 (Postfach ${s['m365.sender'] || '–'})`;
  return s['smtp.host'] ? `SMTP ${s['smtp.host']}` : 'nicht eingerichtet';
}

/* ------------------------------------------------------------------ Anmeldung (Client-Credentials) */

const tokenCache = new Map<string, { token: string; until: number }>();

/** Fehler mit SMTP-ähnlichen Merkmalen (für classifySmtpError und verständliche Meldungen). */
function mailError(message: string, extra: { responseCode?: number; code?: string } = {}): Error {
  return Object.assign(new Error(message), extra);
}

/** Netzwerkfehler aus lib/http.ts übersetzen: nicht erreichbar ⇒ code (sicher nicht gesendet), sonst unbekannt. */
function networkError(e: unknown, what: string): Error {
  if (e instanceof StepError) {
    if (e.sideEffectUnknown) return mailError(`${what}: ${e.message} Ergebnis unbekannt.`); // kein code ⇒ „unknown“
    return mailError(`${what}: ${e.message}`, { code: e.errorClass === 'config' ? 'ETLS' : 'ECONNREFUSED' });
  }
  return mailError(`${what}: ${(e as Error).message}`, { code: 'ECONNREFUSED' });
}

export async function m365Token(c: M365Settings, opts: { fresh?: boolean } = {}): Promise<string> {
  const key = m365Fingerprint(c);
  const hit = tokenCache.get(key);
  if (!opts.fresh && hit && hit.until > Date.now()) return hit.token;
  let res: HttpResponse;
  try {
    res = await httpRequest({
      method: 'POST',
      url: `${loginBase()}/${encodeURIComponent(c.tenantId.trim())}/oauth2/v2.0/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: c.clientId.trim(), client_secret: c.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
      timeoutMs: 15_000,
      maxResponseBytes: 256 * 1024,
      maxRedirects: 0,
      allowPrivateHosts: privateHosts(),
    });
  } catch (e) {
    throw networkError(e, 'Anmeldung bei Microsoft nicht möglich');
  }
  let data: any = null;
  try {
    data = res.json();
  } catch {
    data = null;
  }
  if (res.status !== 200 || !data?.access_token) {
    // AADSTS-Codes ohne Geheimnis weitergeben (Microsoft wiederholt das Geheimnis nie in der Antwort)
    const detail = String(data?.error_description ?? data?.error ?? res.text()).split('\n')[0].replace(c.clientSecret, '***').slice(0, 240);
    let hint = 'Anmeldung der App bei Microsoft abgelehnt.';
    if (/AADSTS7000215|invalid_client/i.test(detail)) hint = 'Client-Geheimnis ungültig – den Wert (nicht die Geheimnis-ID) eintragen und prüfen, ob das Geheimnis abgelaufen ist.';
    else if (/AADSTS700016/i.test(detail)) hint = 'Anwendung (Client-ID) in diesem Verzeichnis nicht gefunden.';
    else if (/AADSTS90002|AADSTS900023/i.test(detail)) hint = 'Verzeichnis (Tenant-ID) nicht gefunden.';
    throw mailError(`${hint} (${detail})`, { responseCode: res.status || 400 });
  }
  const ttl = Math.max(60, Number(data.expires_in) || 3600) - 120;
  tokenCache.set(key, { token: String(data.access_token), until: Date.now() + ttl * 1000 });
  if (tokenCache.size > 20) tokenCache.delete(tokenCache.keys().next().value!);
  return String(data.access_token);
}

/* ------------------------------------------------------------------ Versand */

interface MailOptions {
  from?: string;
  to?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  headers?: Record<string, string>;
  messageId?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((a) => a.trim()).filter(Boolean);
const recipients = (v: string | string[] | undefined) => list(v).map((address) => ({ emailAddress: { address } }));

/** Graph lehnt Anfragen über 4 MB ab; größere Anhänge bräuchten eine Upload-Sitzung (hier nicht nötig). */
const MAX_REQUEST_BYTES = 3_800_000;
const RETRY_STATUS = new Set([429, 503, 504]);

function graphHint(status: number, sender: string, code: string): string {
  if (status === 401) return 'Microsoft Graph hat die Anmeldung abgelehnt – Client-ID/Geheimnis prüfen.';
  if (status === 403) return 'Keine Berechtigung: In Microsoft Entra die Anwendungsberechtigung „Mail.Send“ (Microsoft Graph) mit Administratorzustimmung erteilen und – falls eingeschränkt – das Postfach für die App freigeben.';
  if (status === 404 || code === 'ErrorInvalidUser' || code === 'MailboxNotEnabledForRESTAPI') return `Absenderpostfach „${sender}“ nicht gefunden oder ohne Exchange-Online-Postfach.`;
  if (status === 413) return 'Die Nachricht ist für Microsoft Graph zu groß.';
  return 'Microsoft Graph meldet einen Fehler.';
}

export async function m365Send(c: M365Settings, m: MailOptions): Promise<{ messageId: string | undefined; response: string }> {
  const to = recipients(m.to);
  const bcc = recipients(m.bcc);
  if (!to.length && !bcc.length) throw mailError('Keine Empfänger angegeben.', { code: 'EENVELOPE' });
  const headers = Object.entries(m.headers ?? {})
    .filter(([k]) => /^x-/i.test(k))
    .slice(0, 5)
    .map(([name, value]) => ({ name, value: String(value).slice(0, 900) }));
  const message: Record<string, unknown> = {
    subject: m.subject ?? '',
    body: { contentType: 'Text', content: m.text ?? '' },
    ...(to.length ? { toRecipients: to } : {}),
    ...(bcc.length ? { bccRecipients: bcc } : {}),
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
    ...(m.attachments?.length
      ? { attachments: m.attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType ?? 'application/octet-stream', contentBytes: a.content.toString('base64') })) }
      : {}),
  };
  const body = JSON.stringify({ message, saveToSentItems: c.saveSent });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw mailError('Die Nachricht samt Anhang ist für den Versand über Microsoft 365 zu groß (höchstens etwa 3 MB).', { code: 'EMESSAGE' });
  const url = `${graphBase()}/users/${encodeURIComponent(c.sender.trim())}/sendMail`;
  for (let attempt = 1; ; attempt++) {
    const token = await m365Token(c, { fresh: attempt > 1 });
    let res: HttpResponse;
    try {
      res = await httpRequest({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body,
        timeoutMs: Number(process.env.BLAULICHTCMS_SMTP_TIMEOUT_MS ?? 60_000),
        maxResponseBytes: 256 * 1024,
        maxRedirects: 0,
        allowPrivateHosts: privateHosts(),
      });
    } catch (e) {
      throw networkError(e, 'Microsoft Graph');
    }
    if (res.status === 202 || res.status === 200) return { messageId: undefined, response: `Microsoft Graph: ${res.status} angenommen` };
    // Drosselung bzw. vorübergehend nicht verfügbar: Microsoft hat die Nachricht nicht angenommen – kurz warten, erneut
    // Gerade erteilte Berechtigung bzw. neues Postfach: ein zwischengespeichertes Token (bis knapp 1 Stunde) kennt sie noch
    // nicht – einmal mit frischem Token wiederholen, statt weiter „Keine Berechtigung“ zu melden
    if ((res.status === 401 || res.status === 403) && attempt === 1) continue;
    if (RETRY_STATUS.has(res.status) && attempt < 3) {
      const wait = Math.min(10, Math.max(1, Number(res.headers['retry-after']) || 2 ** attempt));
      await new Promise((r) => setTimeout(r, process.env.VITEST ? 10 : wait * 1000));
      continue;
    }
    let code = '';
    let detail = res.text().slice(0, 200);
    try {
      const err = (res.json() as any)?.error;
      code = String(err?.code ?? '');
      detail = String(err?.message ?? detail).slice(0, 200);
    } catch {
      /* Text bleibt */
    }
    throw mailError(`${graphHint(res.status, c.sender, code)} (Graph ${res.status}${code ? ` ${code}` : ''}: ${detail})`, { responseCode: res.status });
  }
}

/**
 * Fertige MIME-Nachricht über Microsoft Graph senden (Presse-Antworten #206): Graph übernimmt dabei alle Kopfzeilen der
 * Nachricht – auch In-Reply-To/References für den Mail-Verlauf, die das JSON-Format nicht erlaubt. Gespeichert wird in
 * „Gesendete Elemente“ des Absenderpostfachs.
 */
export async function m365SendMime(c: M365Settings, raw: Buffer): Promise<{ response: string }> {
  const body = raw.toString('base64');
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw mailError('Die Nachricht samt Anhang ist für den Versand über Microsoft 365 zu groß (höchstens etwa 3 MB).', { code: 'EMESSAGE' });
  const url = `${graphBase()}/users/${encodeURIComponent(c.sender.trim())}/sendMail`;
  for (let attempt = 1; ; attempt++) {
    const token = await m365Token(c, { fresh: attempt > 1 });
    let res: HttpResponse;
    try {
      res = await httpRequest({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', accept: 'application/json' }, body, timeoutMs: Number(process.env.BLAULICHTCMS_SMTP_TIMEOUT_MS ?? 60_000), maxResponseBytes: 256 * 1024, maxRedirects: 0, allowPrivateHosts: privateHosts() });
    } catch (e) {
      throw networkError(e, 'Microsoft Graph');
    }
    if (res.status === 202 || res.status === 200) return { response: `Microsoft Graph: ${res.status} angenommen` };
    // Gerade erteilte Berechtigung bzw. neues Postfach: ein zwischengespeichertes Token (bis knapp 1 Stunde) kennt sie noch
    // nicht – einmal mit frischem Token wiederholen, statt weiter „Keine Berechtigung“ zu melden
    if ((res.status === 401 || res.status === 403) && attempt === 1) continue;
    if (RETRY_STATUS.has(res.status) && attempt < 3) {
      await new Promise((r) => setTimeout(r, process.env.VITEST ? 10 : Math.min(10, Math.max(1, Number(res.headers['retry-after']) || 2 ** attempt)) * 1000));
      continue;
    }
    let code = '';
    let detail = res.text().slice(0, 200);
    try {
      const err = (res.json() as any)?.error;
      code = String(err?.code ?? '');
      detail = String(err?.message ?? detail).slice(0, 200);
    } catch {
      /* Text bleibt */
    }
    throw mailError(`${graphHint(res.status, c.sender, code)} (Graph ${res.status}${code ? ` ${code}` : ''}: ${detail})`, { responseCode: res.status });
  }
}

/** Transport-Hülle im Stil von Nodemailer (sendMail/close). */
export function m365Transport(c: M365Settings) {
  return {
    sendMail: (m: MailOptions) => m365Send(c, m),
    close: () => {},
  };
}

/** Nur für Tests. */
export function resetM365TokenCache() {
  tokenCache.clear();
}
