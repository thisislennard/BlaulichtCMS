import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import { httpRequest, classifyStatus, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { publicFileFor } from '../routes/media.js';
import type { Connection, TestStep } from './common.js';
import { scrub } from './common.js';
import { markerFor, socialText, X_MAX } from './channels.js';

/**
 * X (#189) in zwei Betriebsarten:
 *  - „Teilen von Hand“ (Standard): keine Schnittstelle, BlaulichtCMS bereitet Text und Link vor.
 *  - „Über die X-API posten“: eigene Zugangsdaten der X-App (OAuth 1.0a im Benutzerkontext: API Key und Secret sowie
 *    Access Token und Secret des eigenen Kontos). Das Posten über die X-API ist kostenpflichtig (nutzungsabhängige
 *    Abrechnung über Guthaben in der Developer Console, Stand der X-Doku vom 16.11.2026).
 * Endpunkte (X API v2, geprüft am 16.11.2026 auf docs.x.com): GET /2/users/me, POST /2/tweets, DELETE /2/tweets/:id,
 * GET /2/users/:id/tweets und POST /2/media/upload (JSON mit base64, media_category tweet_image, Bilder bis 5 MB).
 * OAuth 1.0a wird mit node:crypto signiert (RFC 5849, HMAC-SHA1) – ohne zusätzliche Abhängigkeit.
 */
export const X_API = () => (process.env.BLAULICHTCMS_X_API_URL ?? 'https://api.x.com').replace(/\/$/, '');
const privateHosts = () => (process.env.BLAULICHTCMS_X_API_URL ? [new URL(process.env.BLAULICHTCMS_X_API_URL).hostname] : []);
export const X_SECRET_KEYS = ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret'] as const;

/* ------------------------------------------------------------------ OAuth 1.0a */

/** Prozentkodierung nach RFC 3986 (wie von OAuth 1.0a verlangt). */
export const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/**
 * Signatur nach RFC 5849 §3.4 (HMAC-SHA1). `params` sind Abfrage- und Formularparameter; JSON-Rümpfe werden nicht
 * signiert. Liefert Signatur und alle oauth_*-Parameter.
 */
export function oauth1Sign(method: string, url: string, creds: OAuth1Credentials, params: Record<string, string> = {}, opts: { nonce?: string; timestamp?: number } = {}) {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  const all: [string, string][] = [...u.searchParams.entries(), ...Object.entries(params), ...Object.entries(oauth)].map(([k, v]) => [pct(k), pct(v)]);
  all.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join('&');
  // URL normalisiert Schema und Host bereits auf Kleinbuchstaben und lässt Standard-Ports weg; der Pfad bleibt wie er ist
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [method.toUpperCase(), pct(baseUrl), pct(paramString)].join('&');
  const key = `${pct(creds.consumerSecret)}&${pct(creds.tokenSecret)}`;
  const signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return { signature, oauth, base };
}

export function oauth1Header(method: string, url: string, creds: OAuth1Credentials, params: Record<string, string> = {}, opts: { nonce?: string; timestamp?: number } = {}): string {
  const { signature, oauth } = oauth1Sign(method, url, creds, params, opts);
  const h = { ...oauth, oauth_signature: signature };
  return 'OAuth ' + Object.keys(h).sort().map((k) => `${pct(k)}="${pct((h as any)[k])}"`).join(', ');
}

function creds(sec: Record<string, string>): OAuth1Credentials {
  if (!X_SECRET_KEYS.every((k) => sec[k])) throw new StepError('config', 'Für das Posten über die X-API fehlen Zugangsdaten (API Key und Secret, Access Token und Secret).');
  return { consumerKey: sec.apiKey, consumerSecret: sec.apiSecret, token: sec.accessToken, tokenSecret: sec.accessTokenSecret };
}

async function call(method: string, path: string, sec: Record<string, string>, body?: unknown): Promise<{ json: any; res: HttpResponse }> {
  const url = `${X_API()}${path}`;
  let res: HttpResponse;
  try {
    res = await httpRequest({
      method,
      url,
      headers: { authorization: oauth1Header(method, url, creds(sec)), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: 60_000,
      maxResponseBytes: 2 * 1024 * 1024,
      allowPrivateHosts: privateHosts(),
    });
  } catch (e: any) {
    if (e instanceof StepError) throw e;
    throw new StepError('transient', scrub(`X nicht erreichbar: ${e?.message ?? e}`, sec));
  }
  if (res.status === 402) throw new StepError('config', 'X lehnt ab: Für die X-API ist kein Guthaben vorhanden (Zahlung erforderlich). Guthaben in der Developer Console von X aufladen.');
  const err = classifyStatus(res, 'X');
  if (err) {
    let detail = '';
    try {
      const j: any = res.json();
      detail = j?.detail || j?.title || j?.errors?.[0]?.message || '';
    } catch {
      /* kein JSON */
    }
    err.message = scrub(err.message.replace(/\.$/, '') + (detail ? `: ${detail}` : ''), sec);
    (err as any).technical = undefined;
    throw err;
  }
  let json: any = {};
  try {
    json = res.status === 204 ? {} : res.json();
  } catch {
    json = {};
  }
  return { json, res };
}

/* ------------------------------------------------------------------ Test */

export async function testX(c: Connection, sec: Record<string, string>) {
  if (c.config?.mode !== 'api') {
    return {
      steps: [{ name: 'Teilen von Hand', ok: true, message: `Keine Schnittstelle nötig: BlaulichtCMS bereitet den Text (höchstens ${X_MAX} Zeichen nach den Zählregeln von X) samt Link vor und öffnet x.com zum Posten. Geteilte Beiträge werden in BlaulichtCMS von Hand als geteilt markiert.`, kind: 'publish' as const }],
      account: { mode: 'Teilen von Hand' },
      capabilities: { manual: true, text: true, photos: false, video: false },
    };
  }
  const steps: TestStep[] = [];
  const account: any = { mode: 'X-API' };
  const caps: any = { text: false, photos: false, video: false };
  const missing = X_SECRET_KEYS.filter((k) => !sec[k]);
  if (missing.length) return { steps: [{ name: 'Zugangsdaten', ok: false, message: 'Bitte API Key, API Key Secret, Access Token und Access Token Secret hinterlegen.', kind: 'login' as const }], account, capabilities: caps };
  let level = '';
  try {
    const { json, res } = await call('GET', '/2/users/me', sec);
    account.id = json.data?.id;
    account.username = json.data?.username;
    account.name = json.data?.name;
    level = String(res.headers['x-access-level'] ?? '');
    steps.push({ name: 'Anmeldung und Konto', ok: !!account.id, message: account.id ? `@${account.username} erreichbar. (Anmeldung allein ist kein Veröffentlichungstest.)` : 'X hat kein Konto geliefert.', kind: 'login' });
  } catch (e: any) {
    steps.push({ name: 'Anmeldung und Konto', ok: false, message: e.message, kind: 'login' });
    return { steps, account, capabilities: caps };
  }
  // X meldet bei OAuth 1.0a die Zugriffsstufe des Tokens (read, read-write, read-write-directmessages). Ein Testbeitrag
  // wäre öffentlich sichtbar und kostet Guthaben – deshalb wird nur das Schreibrecht des Tokens geprüft.
  if (!level) {
    caps.text = caps.photos = true;
    steps.push({ name: 'Schreibrecht', ok: true, message: 'X meldet die Zugriffsstufe des Tokens nicht – das Schreibrecht ist ungeprüft. Ein Testbeitrag wäre öffentlich sichtbar und wird deshalb nicht angelegt.', kind: 'publish' });
  } else if (/write/.test(level)) {
    caps.text = caps.photos = true;
    steps.push({ name: 'Schreibrecht', ok: true, message: `Zugriffsstufe des Tokens: ${level} – Beiträge mit Text und Bildern sind möglich. Ein Testbeitrag wäre öffentlich sichtbar und wird deshalb nicht angelegt. Für jeden Beitrag braucht es Guthaben bei X.`, kind: 'publish' });
  } else {
    steps.push({ name: 'Schreibrecht', ok: false, message: `Der Access Token darf nur lesen (${level}). In der Developer Console unter „User authentication settings“ die App-Berechtigung „Read and write“ setzen und Access Token und Secret danach neu erzeugen.`, kind: 'publish' });
  }
  return { steps, account, capabilities: caps };
}

/* ------------------------------------------------------------------ Veröffentlichen */

const unescapeX = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function uploadImage(sec: Record<string, string>, m: any): Promise<string | null> {
  const f = publicFileFor(m);
  if (!f || !fs.existsSync(f.path)) return null;
  let buf = await fs.promises.readFile(f.path);
  // X nimmt Bilder bis 5 MB – größere verkleinern (öffentliche Fassung ist ohnehin JPEG ohne Metadaten)
  if (buf.length > 5 * 1024 * 1024) buf = await sharp(buf).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const { json } = await call('POST', '/2/media/upload', sec, { media: buf.toString('base64'), media_category: 'tweet_image' });
  const id = json.data?.id ?? null;
  // Alternativtext (#217): POST /2/media/metadata, höchstens 1.000 Zeichen. Scheitert das, geht das Bild ohne ihn hinaus.
  const alt = String(m.alt ?? '').trim().slice(0, 1000);
  if (id && alt) await call('POST', '/2/media/metadata', sec, { id: String(id), metadata: { alt_text: { text: alt } } }).catch(() => null);
  return id;
}

export async function publishX(c: Connection, sec: Record<string, string>, { sp, rev, media }: { sp: any; rev: any; media: any[] }) {
  const text = socialText(rev, 'x', sp.link);
  const ids: string[] = [];
  for (const m of media.filter((x) => x.kind === 'image').slice(0, 4)) {
    const id = await uploadImage(sec, m);
    if (id) ids.push(id);
  }
  const { json } = await call('POST', '/2/tweets', sec, { text, ...(ids.length ? { media: { media_ids: ids } } : {}) });
  const id = String(json.data?.id ?? '');
  if (!id) throw new StepError('timeout_unknown', 'X hat keine Beitrags-ID geliefert – bitte auf X prüfen.', { sideEffectUnknown: true });
  return { id, url: `https://x.com/${c.account?.username || 'i/web'}/status/${id}` };
}

export async function findExistingX(c: Connection, sec: Record<string, string>, marker: string, since: Date) {
  const uid = c.account?.id;
  if (!uid) return null;
  const { json } = await call('GET', `/2/users/${encodeURIComponent(uid)}/tweets?max_results=10&tweet.fields=created_at,text`, sec);
  for (const t of json.data ?? []) {
    if (t.text && markerFor(unescapeX(t.text), 'x') === marker && new Date(t.created_at ?? 0).getTime() >= since.getTime() - 120_000) return { id: String(t.id), url: `https://x.com/${c.account?.username || 'i/web'}/status/${t.id}` };
  }
  return null;
}

export async function deleteXPost(sec: Record<string, string>, id: string) {
  await call('DELETE', `/2/tweets/${encodeURIComponent(id)}`, sec);
}

/** Formatprüfung für X. */
export function checkXFormats(c: Pick<Connection, 'config'>, media: any[], tooLong: boolean): string[] {
  const issues: string[] = [];
  const api = c.config?.mode === 'api';
  if (api && media.some((m) => m.kind === 'video')) issues.push('X: Videos überträgt BlaulichtCMS nicht – es gehen nur Text und bis zu 4 Bilder.');
  if (api && media.filter((m) => m.kind === 'image').length > 4) issues.push('X: höchstens 4 Bilder je Beitrag – weitere werden nicht übertragen.');
  if (!api && media.length) issues.push('X (Teilen von Hand): Bilder bitte beim Teilen selbst anhängen – sie stehen dort zum Herunterladen bereit.');
  if (tooLong) issues.push(`X: Text auf ${X_MAX} Zeichen gekürzt – ein eigener, kürzerer Text für X ist besser.`);
  return issues;
}
