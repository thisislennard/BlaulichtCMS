import sharp from 'sharp';
import { many, one, pool } from '../db/pool.js';
import { httpRequest, classifyStatus, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { sha256Hex, randomToken } from '../lib/crypto.js';
import { publicBase } from '../lib/urls.js';
import { publicFileFor } from '../routes/media.js';
import type { Connection, TestStep } from './common.js';
import { isReadOnly, scrub } from './common.js';
import { markerFor, socialText } from './channels.js';
import { effectiveAlt } from '../lib/accessibility.js';

/**
 * Facebook-Seiten (Graph API) und Instagram-Konten (Instagram Login, professionelle Konten).
 * Beide werden getrennt angebunden und haben getrennte Status. Tokens bleiben auf dem Server.
 */
/**
 * Graph-API-Version (Meta unterstützt jede Version rund zwei Jahre). v27.0 seit 04.11.2026, geprüft am 15.11.2026
 * anhand des Graph-API-Changelogs (v27.0 und v26.0) und des Instagram-Platform-Changelogs:
 *  - v27.0 bringt für die genutzten Aufrufe nur Ergänzungen (optional `is_ai_generated` beim Bearbeiten von Beiträgen);
 *    Seitenbeiträge, Fotos, Videos, Löschen, `permalink_url`, `/me/accounts`, `/me/permissions`, OAuth-Dialog und
 *    Token-Tausch sowie die Rechte `pages_*` und `instagram_business_*` sind unverändert.
 *  - Seit v26.0 bzw. für alle Versionen entfernt: `date_format`, `GET /?ids=`, `pretty`/`debug`, `If-None-Match`, einige
 *    Seitenfelder (`settings`, `parking` …) – nutzt BlaulichtCMS nicht (Seitenfelder nur `id,name,link`).
 *  - Instagram: `media_url` fehlt teils in Antworten – BlaulichtCMS liest nur `id`, `permalink`, `caption`, `timestamp`.
 * Bei einem Wechsel den Live-Test (#46) wiederholen.
 */
export const META_API_VERSION = 'v27.0';
export const FB_GRAPH = () => (process.env.BLAULICHTCMS_META_GRAPH_URL ?? `https://graph.facebook.com/${META_API_VERSION}`).replace(/\/$/, '');
export const FB_DIALOG = () => (process.env.BLAULICHTCMS_META_DIALOG_URL ?? `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`).replace(/\/$/, '');
export const IG_GRAPH = () => (process.env.BLAULICHTCMS_IG_GRAPH_URL ?? `https://graph.instagram.com/${META_API_VERSION}`).replace(/\/$/, '');
export const IG_API = () => (process.env.BLAULICHTCMS_IG_API_URL ?? 'https://api.instagram.com').replace(/\/$/, '');
export const IG_DIALOG = () => (process.env.BLAULICHTCMS_IG_DIALOG_URL ?? 'https://www.instagram.com/oauth/authorize').replace(/\/$/, '');

export const FB_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
/**
 * Zusätzlich angefragt für die Reichweite (#218), aber nicht Voraussetzung: ohne sie veröffentlicht BlaulichtCMS
 * trotzdem und zeigt nur die Zahlen, die ohne dieses Recht lesbar sind.
 */
export const FB_INSIGHT_SCOPES = ['read_insights'];
/**
 * Seiten, die zu einem Business-Portfolio gehören, liefert `/me/accounts` nur mit `business_management` – sonst ist die
 * Liste trotz aller Seitenrechte leer (im Betrieb festgestellt, 20.11.2026). Angefragt, aber nicht Voraussetzung:
 * Seiten ohne Portfolio kommen auch ohne.
 */
export const FB_BUSINESS_SCOPES = ['business_management'];
export const IG_INSIGHT_SCOPES = ['instagram_business_manage_insights'];

/** Ausdrücklich per Umgebungsvariable gesetzte Endpunkte (z. B. Testdienst) dürfen privat sein. */
export function privateHosts(): string[] {
  return ['BLAULICHTCMS_META_GRAPH_URL', 'BLAULICHTCMS_IG_GRAPH_URL', 'BLAULICHTCMS_IG_API_URL']
    .map((k) => process.env[k])
    .filter(Boolean)
    .map((u) => new URL(u!).hostname);
}

async function call(method: string, url: string, params: Record<string, string | undefined> = {}, secrets: Record<string, string> = {}, what = 'Meta'): Promise<any> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
  let res: HttpResponse;
  try {
    res =
      method === 'GET' || method === 'DELETE'
        ? await httpRequest({ method, url: `${url}${qs.size ? `?${qs}` : ''}`, timeoutMs: 30_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: privateHosts() })
        : await httpRequest({ method, url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs.toString(), timeoutMs: 60_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: privateHosts() });
  } catch (e: any) {
    if (e instanceof StepError) throw e;
    throw new StepError('transient', scrub(`${what} nicht erreichbar: ${e?.message ?? e}`, secrets));
  }
  const err = classifyStatus(res, what);
  if (err) {
    let detail = '';
    try {
      const j: any = res.json();
      detail = j?.error?.message ? `: ${j.error.message}` : '';
    } catch {
      /* kein JSON */
    }
    err.message = scrub(err.message.replace(/\.$/, '') + detail, secrets);
    (err as any).technical = undefined;
    throw err;
  }
  return res.json();
}

/* ------------------------------------------------------------------ OAuth */

export function facebookAuthorizeUrl(appId: string, redirectUri: string, state: string) {
  return `${FB_DIALOG()}?${new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, scope: [...FB_SCOPES, ...FB_INSIGHT_SCOPES, ...FB_BUSINESS_SCOPES].join(','), response_type: 'code' })}`;
}
export function instagramAuthorizeUrl(appId: string, redirectUri: string, state: string) {
  return `${IG_DIALOG()}?${new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, scope: [...IG_SCOPES, ...IG_INSIGHT_SCOPES].join(','), response_type: 'code' })}`;
}

/** Code → langlebiger Benutzer-Token → Seiten mit Seiten-Tokens. */
export async function facebookExchange(appId: string, appSecret: string, redirectUri: string, code: string) {
  const s = { appSecret, code };
  const short = await call('GET', `${FB_GRAPH()}/oauth/access_token`, { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }, s, 'Facebook');
  const long = await call('GET', `${FB_GRAPH()}/oauth/access_token`, { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }, { ...s, t: short.access_token }, 'Facebook');
  const pages = await call('GET', `${FB_GRAPH()}/me/accounts`, { fields: 'id,name,access_token,tasks', access_token: long.access_token }, { t: long.access_token }, 'Facebook');
  return { userToken: long.access_token as string, pages: (pages.data ?? []) as { id: string; name: string; access_token: string; tasks?: string[] }[] };
}

export async function instagramExchange(appId: string, appSecret: string, redirectUri: string, code: string) {
  const s = { appSecret, code };
  const short = await call('POST', `${IG_API()}/oauth/access_token`, { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }, s, 'Instagram');
  const long = await call('GET', `${IG_GRAPH().replace(/\/v[\d.]+$/, '')}/access_token`, { grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: short.access_token }, { ...s, t: short.access_token }, 'Instagram');
  return { token: long.access_token as string, userId: String(short.user_id ?? ''), expiresIn: Number(long.expires_in ?? 0) };
}

/* ------------------------------------------------------------------ Instagram über Unified Login */

/**
 * Instagram-Anmeldung über Facebook („API setup with Unified login“, Facebook Login for Business mit Konfiguration).
 * Neue Meta-Apps (etwa ab Ende Oktober 2026) bekommen das bisherige Instagram-Login nicht mehr angeboten – im Betrieb
 * festgestellt am 23.11.2026. Dann gibt es keine eigene Instagram-App-ID: Die Anmeldung läuft mit der Facebook-App-ID
 * und einer Konfigurations-ID (`config_id`); die Rechte stehen in der Konfiguration, nicht im Aufruf. Das Ergebnis ist
 * meist ein Systemnutzer-Token ohne Ablauf; alle Aufrufe gehen an graph.facebook.com statt graph.instagram.com.
 * Rechte: instagram_basic, instagram_content_publish, instagram_manage_insights, business_management (ohne
 * business_management liefert Meta kein zugewiesenes Instagram-Konto).
 */
export const igUnified = (c: Pick<Connection, 'config'>) => c.config?.login === 'unified';
/** Basisadresse der Instagram-Aufrufe je Anmeldeweg. */
export const igBase = (c: Pick<Connection, 'config'>) => (igUnified(c) ? FB_GRAPH() : IG_GRAPH());

export function unifiedAuthorizeUrl(appId: string, configId: string, redirectUri: string, state: string) {
  return `${FB_DIALOG()}?${new URLSearchParams({ client_id: appId, config_id: configId, redirect_uri: redirectUri, state, response_type: 'code', override_default_response_type: 'true' })}`;
}

export interface IgAccount {
  id: string;
  username: string;
}

/**
 * Code → Token → zugewiesene Instagram-Konten. Benutzer-Tokens (selten bei dieser Anmeldung) werden in langlebige
 * getauscht; Systemnutzer-Tokens laufen nicht ab. Konten werden auf drei Wegen gesucht, weil Meta sie je nach
 * Einrichtung unterschiedlich liefert: zugewiesene Instagram-Konten, Ziel-IDs der erteilten Rechte, mit einer Seite
 * verknüpfte Konten.
 */
export async function unifiedExchange(appId: string, appSecret: string, redirectUri: string, code: string): Promise<{ token: string; tokenType: string; expiresAt: string | null; accounts: IgAccount[] }> {
  const s: Record<string, string> = { appSecret, code };
  const first = await call('GET', `${FB_GRAPH()}/oauth/access_token`, { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }, s, 'Instagram');
  let token = String(first.access_token ?? '');
  if (!token) throw new StepError('auth', 'Meta hat keinen Token geliefert.');
  s.t = token;
  const appToken = `${appId}|${appSecret}`;
  const dbg = ((await call('GET', `${FB_GRAPH()}/debug_token`, { input_token: token, access_token: appToken }, { ...s, a: appToken }, 'Instagram').catch(() => ({}))) as any).data ?? {};
  const tokenType = String(dbg.type ?? 'UNKNOWN').toUpperCase();
  let expiresAt: string | null = Number(dbg.expires_at) > 0 ? new Date(Number(dbg.expires_at) * 1000).toISOString() : null;
  if (tokenType === 'USER' && expiresAt) {
    const long = await call('GET', `${FB_GRAPH()}/oauth/access_token`, { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token }, s, 'Instagram');
    token = String(long.access_token ?? token);
    s.t2 = token;
    expiresAt = Number(long.expires_in) > 0 ? new Date(Date.now() + Number(long.expires_in) * 1000).toISOString() : null;
  }
  const found = new Map<string, IgAccount>();
  const add = (a: any) => {
    if (a?.id && /^\d+$/.test(String(a.id))) found.set(String(a.id), { id: String(a.id), username: String(a.username ?? a.name ?? a.id) });
  };
  try {
    for (const a of (await call('GET', `${FB_GRAPH()}/me/assigned_instagram_accounts`, { fields: 'id,username', access_token: token }, s, 'Instagram')).data ?? []) add(a);
  } catch {
    /* nicht für jede Token-Art verfügbar */
  }
  if (!found.size) {
    const ids = new Set<string>();
    for (const g of dbg.granular_scopes ?? []) if (String(g.scope ?? '').startsWith('instagram_')) for (const t of g.target_ids ?? []) ids.add(String(t));
    for (const id of [...ids].slice(0, 20)) {
      try {
        add(await call('GET', `${FB_GRAPH()}/${encodeURIComponent(id)}`, { fields: 'id,username', access_token: token }, s, 'Instagram'));
      } catch {
        /* keine Instagram-ID */
      }
    }
  }
  if (!found.size) {
    try {
      for (const p of (await call('GET', `${FB_GRAPH()}/me/accounts`, { fields: 'instagram_business_account{id,username}', access_token: token }, s, 'Instagram')).data ?? []) add(p.instagram_business_account);
    } catch {
      /* kein Benutzer-Token */
    }
  }
  return { token, tokenType, expiresAt, accounts: [...found.values()] };
}

/* ------------------------------------------------------------------ Test */

/**
 * Test je Netzwerk. Eine erfolgreiche Anmeldung ist ausdrücklich KEIN Veröffentlichungstest:
 *  - Facebook: unveröffentlichten Beitrag auf der Seite anlegen und sofort wieder löschen.
 *  - Instagram: Mediencontainer mit einem Testbild anlegen und Verarbeitungsstatus prüfen – ohne zu veröffentlichen.
 */
export async function testFacebook(c: Connection, sec: Record<string, string>) {
  const steps: TestStep[] = [];
  const account: any = {};
  const caps: any = { text: false, photos: false, video: false, stories: false };
  const pageId = c.config.pageId;
  if (!sec.pageToken || !pageId) return { steps: [{ name: 'Seite verbunden', ok: false, message: 'Noch keine Seite gewählt (Verbinden mit Facebook).', kind: 'login' as const }], account, capabilities: caps };
  try {
    const page = await call('GET', `${FB_GRAPH()}/${pageId}`, { fields: 'id,name,link', access_token: sec.pageToken }, sec, 'Facebook');
    account.id = page.id;
    account.name = page.name;
    account.link = page.link ?? null;
    steps.push({ name: 'Anmeldung und Seite', ok: true, message: `Seite „${page.name}“ erreichbar. (Anmeldung allein ist kein Veröffentlichungstest.)`, kind: 'login' });
  } catch (e: any) {
    steps.push({ name: 'Anmeldung und Seite', ok: false, message: e.message, kind: 'login' });
    return { steps, account, capabilities: caps };
  }
  try {
    const perms = sec.userToken ? await call('GET', `${FB_GRAPH()}/me/permissions`, { access_token: sec.userToken }, sec, 'Facebook') : { data: [] };
    const granted = (perms.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
    account.permissions = granted;
    // Nur lesen: pages_manage_posts wird nicht gebraucht
    const missing = FB_SCOPES.filter((s) => !granted.includes(s) && !(isReadOnly(c) && s === 'pages_manage_posts'));
    const insights = FB_INSIGHT_SCOPES.every((s) => granted.includes(s));
    caps.insights = !!sec.userToken && insights;
    steps.push({ name: 'Berechtigungen', ok: !sec.userToken || missing.length === 0, message: !sec.userToken ? 'Seiten-Token manuell hinterlegt – Berechtigungen nicht abfragbar.' : missing.length ? `Es fehlen: ${missing.join(', ')}` : `Erteilt: ${FB_SCOPES.join(', ')}${insights ? ', read_insights (Reichweite)' : ' – ohne read_insights zeigt die Reichweite nur Reaktionen, Kommentare und geteilte Beiträge'}`, kind: 'read' });
  } catch (e: any) {
    steps.push({ name: 'Berechtigungen', ok: false, message: e.message, kind: 'read' });
  }
  if (isReadOnly(c)) {
    steps.push({ name: 'Nur lesen', ok: true, message: 'Veröffentlichen ist gesperrt – kein Testbeitrag. Die Verbindung liefert nur Statistik und Seitenabgleich.', kind: 'publish' });
    return { steps, account, capabilities: { ...caps, read_only: true } };
  }
  try {
    const probe = await call('POST', `${FB_GRAPH()}/${pageId}/feed`, { message: `BlaulichtCMS-Verbindungstest ${new Date().toISOString()} (unveröffentlicht, wird sofort gelöscht)`, published: 'false', access_token: sec.pageToken }, sec, 'Facebook');
    await call('DELETE', `${FB_GRAPH()}/${probe.id}`, { access_token: sec.pageToken }, sec, 'Facebook').catch(() => null);
    caps.text = true;
    caps.photos = true;
    caps.video = true;
    // Storys brauchen dieselben Rechte (pages_manage_posts) – Foto- und Video-Storys über photo_stories/video_stories
    caps.stories = true;
    steps.push({ name: 'Veröffentlichungstest', ok: true, message: 'Unveröffentlichter Testbeitrag angelegt und wieder gelöscht – Beiträge mit Text, Fotos und Video sowie Storys sind möglich.', kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: `Testbeitrag konnte nicht angelegt werden: ${e.message}`, kind: 'publish' });
  }
  return { steps, account, capabilities: caps };
}

export async function testInstagram(c: Connection, sec: Record<string, string>, testImageUrl: string | null) {
  const steps: TestStep[] = [];
  const account: any = {};
  const caps: any = { image: false, carousel: false, reels: false, stories: false, text_only: false };
  if (!sec.token) return { steps: [{ name: 'Konto verbunden', ok: false, message: 'Noch nicht mit Instagram verbunden.', kind: 'login' as const }], account, capabilities: caps };
  let userId = c.config.userId as string;
  if (igUnified(c)) {
    // Über Facebook angemeldet: /me wäre die Person bzw. der Systemnutzer – das gewählte Konto direkt abfragen. Über
    // diesen Weg erreichbare Instagram-Konten sind immer professionelle Konten.
    if (!userId) return { steps: [{ name: 'Konto verbunden', ok: false, message: 'Noch kein Instagram-Konto gewählt (Mit Instagram verbinden, dann Konto wählen).', kind: 'login' as const }], account, capabilities: caps };
    try {
      const ig = await call('GET', `${igBase(c)}/${encodeURIComponent(userId)}`, { fields: 'id,username', access_token: sec.token }, sec, 'Instagram');
      account.id = String(ig.id ?? userId);
      account.username = ig.username;
      account.type = 'BUSINESS';
      steps.push({ name: 'Anmeldung und Konto', ok: true, message: `@${ig.username} über Facebook (Unified Login). (Anmeldung allein ist kein Veröffentlichungstest.)`, kind: 'login' });
    } catch (e: any) {
      steps.push({ name: 'Anmeldung und Konto', ok: false, message: `${e.message} – ist das Konto in der Meta-Konfiguration freigegeben und business_management erteilt?`, kind: 'login' });
      return { steps, account, capabilities: caps };
    }
  } else try {
    const me = await call('GET', `${igBase(c)}/me`, { fields: 'user_id,username,account_type', access_token: sec.token }, sec, 'Instagram');
    userId = String(me.user_id ?? me.id ?? userId);
    account.id = userId;
    account.username = me.username;
    account.type = me.account_type;
    const pro = ['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type ?? '').toUpperCase());
    steps.push({ name: 'Anmeldung und Konto', ok: pro, message: pro ? `@${me.username} (${me.account_type}). (Anmeldung allein ist kein Veröffentlichungstest.)` : `@${me.username} ist kein professionelles Konto – Veröffentlichen ist nicht möglich.`, kind: 'login' });
    if (!pro) return { steps, account, capabilities: caps };
  } catch (e: any) {
    steps.push({ name: 'Anmeldung und Konto', ok: false, message: e.message, kind: 'login' });
    return { steps, account, capabilities: caps };
  }
  try {
    const lim = await call('GET', `${igBase(c)}/${userId}/content_publishing_limit`, { fields: 'quota_usage,config', access_token: sec.token }, sec, 'Instagram');
    const d = lim.data?.[0] ?? {};
    account.quota = { used: d.quota_usage ?? null, total: d.config?.quota_total ?? null };
    steps.push({ name: 'Veröffentlichungskontingent', ok: true, message: `Heute genutzt: ${d.quota_usage ?? '?'} von ${d.config?.quota_total ?? '?'}`, kind: 'read' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungskontingent', ok: false, message: e.message, kind: 'read' });
  }
  if (isReadOnly(c)) {
    steps.push({ name: 'Nur lesen', ok: true, message: 'Veröffentlichen ist gesperrt – kein Mediencontainer. Die Verbindung liefert nur Statistik und Seitenabgleich.', kind: 'publish' });
    return { steps, account, capabilities: { ...caps, read_only: true }, userId };
  }
  if (!testImageUrl) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: 'Für den Test ist eine öffentlich erreichbare HTTPS-Adresse von BlaulichtCMS nötig (Basisadresse in den Einstellungen).', kind: 'publish' });
    return { steps, account, capabilities: caps };
  }
  try {
    const cont = await call('POST', `${igBase(c)}/${userId}/media`, { image_url: testImageUrl, caption: 'BlaulichtCMS-Verbindungstest (wird nicht veröffentlicht)', access_token: sec.token }, sec, 'Instagram');
    const status = await waitContainer(cont.id, sec, igBase(c), 6, 2000);
    const ok = status === 'FINISHED';
    if (ok) Object.assign(caps, { image: true, carousel: true, reels: true, stories: true });
    steps.push({ name: 'Veröffentlichungstest', ok, message: ok ? 'Mediencontainer mit Testbild verarbeitet (nicht veröffentlicht) – Bilder, Karussell, Reels und Storys möglich. Reine Textbeiträge unterstützt Instagram nicht.' : `Container-Status: ${status}. Meta konnte das Testbild nicht abrufen oder verarbeiten.`, kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: `Mediencontainer konnte nicht angelegt werden: ${e.message}`, kind: 'publish' });
  }
  return { steps, account: { ...account }, capabilities: caps, userId };
}

async function waitContainer(id: string, sec: Record<string, string>, base: string, tries = 60, delayMs = 5000): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const s = await call('GET', `${base}/${id}`, { fields: 'status_code', access_token: sec.token }, sec, 'Instagram');
    if (['FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(s.status_code)) return s.status_code;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return 'IN_PROGRESS';
}

let testImage: Promise<Buffer> | null = null;
/**
 * Fest eingebautes, neutrales Testbild (1080 × 1080, grau mit hellerem Feld) für den Instagram-Verbindungstest (#95).
 * Wird einmal erzeugt und zwischengespeichert; enthält keine Inhalte aus Uploads.
 */
export function connectionTestImage(): Promise<Buffer> {
  testImage ??= (async () => {
    const inner = await sharp({ create: { width: 540, height: 540, channels: 3, background: { r: 200, g: 204, b: 208 } } }).png().toBuffer();
    return sharp({ create: { width: 1080, height: 1080, channels: 3, background: { r: 120, g: 126, b: 132 } } })
      .composite([{ input: inner, top: 270, left: 270 }])
      .jpeg({ quality: 80 })
      .toBuffer();
  })().catch((e) => {
    testImage = null;
    throw e;
  });
  return testImage;
}

/* ------------------------------------------------------------------ Medien-URLs */

/** Zeitlich begrenzte öffentliche HTTPS-Adresse für eine freigegebene Datei (Abruf durch Meta). */
export async function mediaUrl(mediaId: string, hours = 24, variant: 'story' | null = null): Promise<string> {
  const token = randomToken(32);
  await pool.query(`INSERT INTO media_tokens (token_hash, media_id, expires_at, variant) VALUES ($1,$2, now() + make_interval(hours => $3), $4)`, [sha256Hex(token), mediaId, hours, variant]);
  return `${await publicBase()}/api/v1/m/${token}`;
}

/* ------------------------------------------------------------------ Veröffentlichen */

export { markerFor, socialText } from './channels.js';

/** Gibt es den Beitrag schon? (Unbekanntes Ergebnis zuerst prüfen statt erneut zu veröffentlichen.) */
export async function findExisting(c: Connection, sec: Record<string, string>, marker: string, since: Date): Promise<{ id: string; url: string | null } | null> {
  if (c.kind === 'facebook') {
    const r = await call('GET', `${FB_GRAPH()}/${c.config.pageId}/feed`, { fields: 'id,message,created_time,permalink_url', limit: '25', access_token: sec.pageToken }, sec, 'Facebook');
    for (const p of r.data ?? []) if (p.message && markerFor(p.message) === marker && new Date(p.created_time ?? 0).getTime() >= since.getTime() - 120_000) return { id: p.id, url: p.permalink_url ?? null };
    return null;
  }
  const r = await call('GET', `${igBase(c)}/${c.config.userId}/media`, { fields: 'id,caption,permalink,timestamp', limit: '25', access_token: sec.token }, sec, 'Instagram');
  for (const p of r.data ?? []) if (p.caption && markerFor(p.caption) === marker && new Date(p.timestamp ?? 0).getTime() >= since.getTime() - 120_000) return { id: p.id, url: p.permalink ?? null };
  return null;
}

export interface PublishInput {
  sp: any;
  rev: any;
  media: any[];
}

/** Facebook: Text, Fotos (bis 10) oder ein Video. Rückgabe: Remote-ID und Link. */
export async function publishFacebook(c: Connection, sec: Record<string, string>, { rev, media }: PublishInput) {
  const page = c.config.pageId;
  const message = socialText(rev, 'facebook');
  const videos = media.filter((m) => m.kind === 'video');
  const images = media.filter((m) => m.kind === 'image').slice(0, 10);
  let id: string;
  if (videos.length) {
    const r = await call('POST', `${FB_GRAPH()}/${page}/videos`, { file_url: await mediaUrl(videos[0].id), description: message, access_token: sec.pageToken }, sec, 'Facebook');
    id = r.id;
  } else if (images.length === 1) {
    const r = await call('POST', `${FB_GRAPH()}/${page}/photos`, { url: await mediaUrl(images[0].id), caption: message, alt_text_custom: altParam(images[0]), access_token: sec.pageToken }, sec, 'Facebook');
    id = r.post_id ?? r.id;
  } else if (images.length > 1) {
    const ids: string[] = [];
    for (const m of images) ids.push((await call('POST', `${FB_GRAPH()}/${page}/photos`, { url: await mediaUrl(m.id), published: 'false', alt_text_custom: altParam(m), access_token: sec.pageToken }, sec, 'Facebook')).id);
    const params: Record<string, string> = { message, access_token: sec.pageToken };
    ids.forEach((x, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: x })));
    id = (await call('POST', `${FB_GRAPH()}/${page}/feed`, params, sec, 'Facebook')).id;
  } else {
    id = (await call('POST', `${FB_GRAPH()}/${page}/feed`, { message, access_token: sec.pageToken }, sec, 'Facebook')).id;
  }
  const info = await call('GET', `${FB_GRAPH()}/${id}`, { fields: 'permalink_url', access_token: sec.pageToken }, sec, 'Facebook').catch(() => ({}));
  return { id, url: (info as any).permalink_url ?? null };
}

/**
 * Instagram: Container anlegen (oder wiederverwenden), Verarbeitung abwarten, veröffentlichen.
 * Ein gespeicherter Container wird nur weiterverwendet, solange er gültig ist (#149): ERROR/EXPIRED (Meta verwirft
 * Container nach 24 h) → neuer Container; PUBLISHED → der Beitrag ist schon erschienen und wird gesucht statt doppelt
 * veröffentlicht. Scheitert ein neuer Container, wird er verworfen, damit „Wiederholen“ neu anlegt.
 */
export async function publishInstagram(c: Connection, sec: Record<string, string>, { sp, rev, media }: PublishInput, onContainer: (id: string | null) => Promise<void>) {
  const user = c.config.userId;
  const caption = socialText(rev, 'instagram');
  const items = media.filter((m) => publicFileFor(m)).slice(0, 10);
  if (!items.length) throw new StepError('invalid_payload', 'Instagram braucht mindestens ein Bild oder Video.');
  let container = sp.container_id as string | null;
  let st: string | null = null;
  if (container) {
    // Verworfene Container beantwortet Meta teils mit einem 4xx-Fehler statt mit EXPIRED – dann ebenfalls neu anlegen
    st = await waitContainer(container, sec, igBase(c)).catch((e) => {
      if (e instanceof StepError && e.errorClass === 'invalid_payload') return 'EXPIRED';
      throw e;
    });
    if (st === 'PUBLISHED') {
      const found = await findExisting(c, sec, sp.marker, new Date(sp.created_at));
      if (found) return found;
      throw new StepError('timeout_unknown', 'Instagram meldet den Container als veröffentlicht, der Beitrag wurde aber noch nicht gefunden – bitte später erneut prüfen.', { sideEffectUnknown: true });
    }
    if (st === 'ERROR' || st === 'EXPIRED') {
      container = null;
      st = null;
      await onContainer(null);
    }
  }
  if (!container) {
    if (items.length === 1) {
      const m = items[0];
      const p = m.kind === 'video' ? { media_type: 'REELS', video_url: await mediaUrl(m.id) } : { image_url: await mediaUrl(m.id), alt_text: altParam(m) };
      container = (await call('POST', `${igBase(c)}/${user}/media`, { ...p, caption, access_token: sec.token }, sec, 'Instagram')).id;
    } else {
      const children: string[] = [];
      for (const m of items) {
        const p = m.kind === 'video' ? { media_type: 'VIDEO', video_url: await mediaUrl(m.id) } : { image_url: await mediaUrl(m.id), alt_text: altParam(m) };
        const child = (await call('POST', `${igBase(c)}/${user}/media`, { ...p, is_carousel_item: 'true', access_token: sec.token }, sec, 'Instagram')).id;
        const st = await waitContainer(child, sec, igBase(c));
        if (st !== 'FINISHED') throw new StepError('invalid_payload', `Instagram konnte eine Datei nicht verarbeiten (Status ${st}).`);
        children.push(child);
      }
      container = (await call('POST', `${igBase(c)}/${user}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: sec.token }, sec, 'Instagram')).id;
    }
    await onContainer(container!);
  }
  st ??= await waitContainer(container!, sec, igBase(c));
  if (st !== 'FINISHED') {
    if (st === 'ERROR' || st === 'EXPIRED') await onContainer(null);
    throw new StepError('invalid_payload', `Instagram-Container nicht bereit (Status ${st}).`);
  }
  const pub = await call('POST', `${igBase(c)}/${user}/media_publish`, { creation_id: container!, access_token: sec.token }, sec, 'Instagram');
  const info = await call('GET', `${igBase(c)}/${pub.id}`, { fields: 'permalink', access_token: sec.token }, sec, 'Instagram').catch(() => ({}));
  return { id: pub.id as string, url: (info as any).permalink ?? null };
}

/**
 * Facebook-Beitrag löschen (#114). Instagram bietet für veröffentlichte Beiträge kein Löschen über die Schnittstelle –
 * dort muss der Beitrag in der App bzw. im Web gelöscht werden.
 */
export async function deleteFacebookPost(sec: Record<string, string>, remoteId: string) {
  await call('DELETE', `${FB_GRAPH()}/${encodeURIComponent(remoteId)}`, { access_token: sec.pageToken }, sec, 'Facebook');
}

/* ------------------------------------------------------------------ Storys (#188) */

/**
 * Storys über die offiziellen Schnittstellen (geprüft am 16.11.2026 auf developers.facebook.com):
 *  - Instagram: Container mit `media_type=STORIES` und `image_url` bzw. `video_url` (ohne Bildunterschrift – Storys
 *    haben keine), dann `media_publish`. Bilder JPEG bis 8 MB, empfohlen 9:16; Videos MP4/MOV, 3–60 s, bis 100 MB.
 *  - Facebook-Seite: Foto unveröffentlicht hochladen (`/{page}/photos`, published=false) und mit
 *    `/{page}/photo_stories` (photo_id) veröffentlichen; Video über `/{page}/video_stories` (upload_phase start →
 *    gehostete Datei an die upload_url mit Kopfzeile file_url → finish). Fotos bis 10 MB; Videos 9:16, 3–60 s.
 * Bilder gehen in einer eigenen Story-Fassung hinaus: 1080 × 1920 ohne Beschnitt, der Rand ist das unscharf vergrößerte
 * Bild selbst (öffentliche Fassung, also bereits geschwärzt und ohne Metadaten).
 */
export async function storyImage(src: Buffer): Promise<Buffer> {
  const W = 1080;
  const H = 1920;
  const bg = await sharp(src).resize(W, H, { fit: 'cover' }).blur(40).modulate({ brightness: 0.7 }).toBuffer();
  const fg = await sharp(src).resize(W, H, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
  return sharp(bg)
    .composite([{ input: fg.data, top: Math.round((H - fg.info.height) / 2), left: Math.round((W - fg.info.width) / 2) }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

const storyMedia = (media: any[]) => media.find((m) => publicFileFor(m)) ?? null;

export async function publishInstagramStory(c: Connection, sec: Record<string, string>, { sp, media }: PublishInput, onContainer: (id: string | null) => Promise<void>) {
  const user = c.config.userId;
  const m = storyMedia(media);
  if (!m) throw new StepError('invalid_payload', 'Eine Instagram-Story braucht ein Bild oder Video.');
  let container = sp.container_id as string | null;
  if (container) {
    const st = await waitContainer(container, sec, igBase(c)).catch(() => 'EXPIRED');
    if (st === 'PUBLISHED') {
      const found = await findExistingStory(c, sec, sp);
      if (found) return found;
      throw new StepError('timeout_unknown', 'Instagram meldet die Story als veröffentlicht, sie wurde aber noch nicht gefunden – bitte in Instagram prüfen.', { sideEffectUnknown: true });
    }
    if (st !== 'FINISHED') {
      container = null;
      await onContainer(null);
    }
  }
  if (!container) {
    const p = m.kind === 'video' ? { video_url: await mediaUrl(m.id) } : { image_url: await mediaUrl(m.id, 24, 'story') };
    container = String((await call('POST', `${igBase(c)}/${user}/media`, { media_type: 'STORIES', ...p, access_token: sec.token }, sec, 'Instagram')).id);
    await onContainer(container);
  }
  const st = await waitContainer(container, sec, igBase(c));
  if (st !== 'FINISHED') {
    if (st === 'ERROR' || st === 'EXPIRED') await onContainer(null);
    throw new StepError('invalid_payload', `Instagram-Story nicht bereit (Status ${st}).`);
  }
  const pub = await call('POST', `${igBase(c)}/${user}/media_publish`, { creation_id: container, access_token: sec.token }, sec, 'Instagram');
  const info = await call('GET', `${igBase(c)}/${pub.id}`, { fields: 'permalink', access_token: sec.token }, sec, 'Instagram').catch(() => ({}));
  return { id: String(pub.id), url: (info as any).permalink ?? null };
}

export async function publishFacebookStory(c: Connection, sec: Record<string, string>, { sp, media }: PublishInput, onContainer: (id: string | null) => Promise<void>) {
  const page = c.config.pageId;
  const m = storyMedia(media);
  if (!m) throw new StepError('invalid_payload', 'Eine Facebook-Story braucht ein Bild oder Video.');
  if (m.kind !== 'video') {
    // Ein unveröffentlichtes Foto aus einem früheren, gescheiterten Versuch wird weiterverwendet
    let photoId = sp.container_id as string | null;
    if (!photoId) {
      photoId = String((await call('POST', `${FB_GRAPH()}/${page}/photos`, { url: await mediaUrl(m.id, 24, 'story'), published: 'false', access_token: sec.pageToken }, sec, 'Facebook')).id);
      await onContainer(photoId);
    }
    const r = await call('POST', `${FB_GRAPH()}/${page}/photo_stories`, { photo_id: photoId, access_token: sec.pageToken }, sec, 'Facebook');
    if (!r.post_id) throw new StepError('timeout_unknown', 'Facebook hat keine Story-ID geliefert – bitte auf der Seite prüfen.', { sideEffectUnknown: true });
    return { id: String(r.post_id), url: null };
  }
  const start = await call('POST', `${FB_GRAPH()}/${page}/video_stories`, { upload_phase: 'start', access_token: sec.pageToken }, sec, 'Facebook');
  const videoId = String(start.video_id ?? '');
  if (!videoId || !start.upload_url) throw new StepError('invalid_payload', 'Facebook hat keinen Upload für die Video-Story bereitgestellt.');
  await onContainer(videoId);
  let up: HttpResponse;
  try {
    up = await httpRequest({ method: 'POST', url: String(start.upload_url), headers: { authorization: `OAuth ${sec.pageToken}`, file_url: await mediaUrl(m.id) }, timeoutMs: 120_000, maxResponseBytes: 1024 * 1024, allowPrivateHosts: privateHosts() });
  } catch (e: any) {
    if (e instanceof StepError) throw e;
    throw new StepError('transient', scrub(`Facebook-Upload nicht erreichbar: ${e?.message ?? e}`, sec));
  }
  const upErr = classifyStatus(up, 'Facebook-Upload');
  if (upErr) throw new StepError(upErr.errorClass, scrub(upErr.message, sec));
  // Abholen der Datei durch Facebook abwarten
  for (let i = 0; i < 24; i++) {
    const s = await call('GET', `${FB_GRAPH()}/${videoId}`, { fields: 'status', access_token: sec.pageToken }, sec, 'Facebook');
    const vs = s.status?.video_status;
    if (vs === 'error' || vs === 'expired') throw new StepError('invalid_payload', `Facebook konnte das Video nicht verarbeiten (Status ${vs}).`);
    if (s.status?.uploading_phase?.status === 'complete' || vs === 'ready') break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const fin = await call('POST', `${FB_GRAPH()}/${page}/video_stories`, { video_id: videoId, upload_phase: 'finish', access_token: sec.pageToken }, sec, 'Facebook');
  if (!fin.post_id) throw new StepError('timeout_unknown', 'Facebook hat keine Story-ID geliefert – bitte auf der Seite prüfen.', { sideEffectUnknown: true });
  return { id: String(fin.post_id), url: null };
}

/**
 * Gibt es die Story schon? Storys haben keinen Text, an dem sie sich wiedererkennen ließen – maßgeblich ist der
 * gespeicherte Container (Instagram) bzw. das hochgeladene Foto/Video (Facebook). Ohne ihn wurde nichts veröffentlicht.
 */
export async function findExistingStory(c: Connection, sec: Record<string, string>, sp: any): Promise<{ id: string; url: string | null } | null> {
  if (!sp.container_id) return null;
  const since = new Date(sp.created_at).getTime() - 120_000;
  if (c.kind === 'instagram') {
    const st = await call('GET', `${igBase(c)}/${sp.container_id}`, { fields: 'status_code', access_token: sec.token }, sec, 'Instagram').catch(() => ({ status_code: 'EXPIRED' }));
    if (st.status_code !== 'PUBLISHED') return null;
    const r = await call('GET', `${igBase(c)}/${c.config.userId}/stories`, { fields: 'id,permalink,timestamp', access_token: sec.token }, sec, 'Instagram');
    const hits = (r.data ?? []).filter((s: any) => new Date(s.timestamp ?? 0).getTime() >= since).sort((a: any, b: any) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return hits[0] ? { id: String(hits[0].id), url: hits[0].permalink ?? null } : null;
  }
  const r = await call('GET', `${FB_GRAPH()}/${c.config.pageId}/stories`, { since: String(Math.floor(since / 1000)), access_token: sec.pageToken }, sec, 'Facebook');
  const hit = (r.data ?? []).find((s: any) => String(s.media_id) === String(sp.container_id));
  return hit ? { id: String(hit.post_id), url: hit.url ?? null } : null;
}

/** Formatprüfung für Storys (vor der Freigabe sichtbar). */
export function checkStoryFormats(kind: 'facebook' | 'instagram', media: any[]): string[] {
  const name = kind === 'facebook' ? 'Facebook-Story' : 'Instagram-Story';
  const usable = media.filter((m) => m.kind === 'image' || m.kind === 'video');
  if (!usable.length) return [`${name}: braucht ein Bild oder Video.`];
  const issues: string[] = [];
  if (usable.length > 1) issues.push(`${name}: je Story eine Datei – verwendet wird nur die erste („${usable[0].original_name}“).`);
  const m = usable[0];
  if (m.kind === 'image' && m.width && m.height && Math.abs(m.width / m.height - 9 / 16) > 0.02) issues.push(`${name}: Das Bild wird auf 9:16 (1080 × 1920) gebracht – ohne Beschnitt, der Rand wird unscharf aus dem Bild gefüllt.`);
  if (m.kind === 'video') {
    if (m.mime === 'video/webm') issues.push(`${name}: WebM-Videos werden nicht unterstützt (MP4).`);
    if (m.width && m.height && Math.abs(m.width / m.height - 9 / 16) > 0.02) issues.push(`${name}: Das Video ist nicht im Hochformat 9:16 – es wird mit Rand oder beschnitten angezeigt.`);
    issues.push(`${name}: Videos müssen 3 bis 60 Sekunden lang sein.`);
  }
  return issues;
}

/** Prüft je Netzwerk, ob die Medien der Fassung unterstützt werden (vor der Freigabe sichtbar). */
export function checkFormats(kind: 'facebook' | 'instagram', media: any[], text: string): string[] {
  const issues: string[] = [];
  if (kind === 'instagram') {
    if (!media.length) issues.push('Instagram braucht mindestens ein Bild oder Video.');
    if (media.length > 10) issues.push('Instagram erlaubt höchstens 10 Dateien je Beitrag (Karussell).');
    for (const m of media) {
      if (m.kind === 'image' && m.width && m.height) {
        const r = m.width / m.height;
        if (r < 0.8 || r > 1.91) issues.push(`Seitenverhältnis von „${m.original_name}“ (${r.toFixed(2).replace('.', ',')}) liegt außerhalb 4:5 bis 1,91:1 – Instagram schneidet ab oder lehnt ab.`);
      }
      if (m.kind === 'video' && m.mime === 'video/webm') issues.push(`„${m.original_name}“: WebM wird von Instagram nicht unterstützt.`);
    }
    if (text.length > 2200) issues.push('Bildunterschrift über 2.200 Zeichen wird gekürzt.');
  } else {
    if (media.filter((m) => m.kind === 'video').length > 1) issues.push('Facebook: nur ein Video je Beitrag – weitere Dateien werden nicht übertragen.');
    if (media.some((m) => m.kind === 'video') && media.some((m) => m.kind === 'image')) issues.push('Facebook: Fotos und Video gemischt – übertragen wird nur das Video.');
    if (media.filter((m) => m.kind === 'image').length > 10) issues.push('Facebook: höchstens 10 Fotos je Beitrag.');
  }
  return issues;
}

export async function cleanupMediaTokens() {
  await pool.query(`DELETE FROM media_tokens WHERE expires_at < now()`);
}

/** Medien einer Fassung in Reihenfolge, je Datei mit dem wirksamen Alternativtext (`alt`, #217). */
export async function mediaForRevision(rev: any) {
  if (!rev.media_ids?.length) return [];
  const rows = await many<any>(`SELECT * FROM media WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL`, [rev.media_ids]);
  return rev.media_ids.map((id: string) => rows.find((r) => r.id === id)).filter(Boolean).map((m: any) => ({ ...m, alt: m.kind === 'image' ? effectiveAlt(rev, m) : '' }));
}

/** Alternativtext für Meta, Threads und X (je höchstens 1.000 Zeichen); leer = nicht senden. */
export const altParam = (m: any) => (m?.kind === 'image' && String(m.alt ?? '').trim() ? String(m.alt).trim().slice(0, 1000) : undefined);

export async function connectionForPublish(id: string) {
  return one<any>(`SELECT * FROM connections WHERE id = $1`, [id]);
}

/* ------------------------------------------------------------------ Reichweite (#218) */

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const insightValue = (data: any[], name: string) => n(data.find((x: any) => x.name === name)?.values?.[0]?.value ?? data.find((x: any) => x.name === name)?.total_value?.value);

/**
 * Facebook-Beitrag: Reaktionen, Kommentare und geteilte Beiträge (Recht pages_read_engagement) sowie – mit
 * read_insights – Aufrufe (post_media_view), erreichte Personen (post_total_media_view_unique) und Klicks
 * (post_clicks). Geprüft am 16.11.2026 (Graph API, Page Post Insights; post_impressions* entfallen nach v25).
 */
export async function facebookMetrics(sec: Record<string, string>, postId: string) {
  const p = await call('GET', `${FB_GRAPH()}/${encodeURIComponent(postId)}`, { fields: 'shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)', access_token: sec.pageToken }, sec, 'Facebook');
  const out: Record<string, number | null> = { likes: n(p.reactions?.summary?.total_count), replies: n(p.comments?.summary?.total_count), shares: n(p.shares?.count) ?? 0 };
  const metrics: Record<string, string> = { views: 'post_media_view', reach: 'post_total_media_view_unique', clicks: 'post_clicks' };
  const url = `${FB_GRAPH()}/${encodeURIComponent(postId)}/insights`;
  try {
    const i = await call('GET', url, { metric: Object.values(metrics).join(','), access_token: sec.pageToken }, sec, 'Facebook');
    for (const [k, m] of Object.entries(metrics)) out[k] = insightValue(i.data ?? [], m);
  } catch (e: any) {
    if (channelError(e)) return out;
    /* Meta lehnt die ganze Abfrage ab, wenn eine Kennzahl entfallen ist – dann einzeln versuchen. Ohne read_insights
       bzw. bei einer Seite unter 100 „Gefällt mir“ scheitern alle: dann bleiben nur die Interaktionen. */
    for (const [k, m] of Object.entries(metrics)) {
      try {
        const i = await call('GET', url, { metric: m, access_token: sec.pageToken }, sec, 'Facebook');
        out[k] = insightValue(i.data ?? [], m);
      } catch (e2: any) {
        if (channelError(e2) || e2?.errorClass === 'permission') break;
      }
    }
  }
  return out;
}

/**
 * Instagram-Beitrag: Gefällt mir und Kommentare (instagram_business_basic) sowie – mit
 * instagram_business_manage_insights – Aufrufe, Reichweite, geteilt und gespeichert (GET /{media}/insights).
 * Meta liefert die Werte mit bis zu 48 Stunden Verzögerung.
 */
export async function instagramMetrics(sec: Record<string, string>, mediaId: string, base = IG_GRAPH()) {
  const p = await call('GET', `${base}/${encodeURIComponent(mediaId)}`, { fields: 'like_count,comments_count', access_token: sec.token }, sec, 'Instagram');
  const out: Record<string, number | null> = { likes: n(p.like_count), replies: n(p.comments_count) };
  try {
    const i = await call('GET', `${base}/${encodeURIComponent(mediaId)}/insights`, { metric: 'views,reach,shares,saved', access_token: sec.token }, sec, 'Instagram');
    Object.assign(out, { views: insightValue(i.data ?? [], 'views'), reach: insightValue(i.data ?? [], 'reach'), shares: insightValue(i.data ?? [], 'shares'), saves: insightValue(i.data ?? [], 'saved') });
  } catch {
    /* ohne instagram_business_manage_insights: nur Gefällt mir und Kommentare */
  }
  return out;
}

/* ------------------------------------------------------------------ Seitenabgleich */

/** Ein Beitrag der Seite bzw. des Kontos, wie ihn der Abgleich liest. */
export interface PagePost {
  remoteId: string;
  postedAt: Date;
  message: string;
  permalink: string | null;
  mediaType: string | null;
  imageUrl: string | null;
}

/** Folgeseite einer Meta-Liste (`paging.next`) abrufen – nur vom selben Host wie die erste Abfrage. */
async function nextPage(next: string, base: string, sec: Record<string, string>, what: string) {
  const u = new URL(next);
  if (u.host !== new URL(base).host) return { data: [] };
  return call('GET', `${u.origin}${u.pathname}`, Object.fromEntries(u.searchParams), sec, what);
}

/**
 * Beiträge der Facebook-Seite (auch direkt auf Facebook erstellte), neueste zuerst. Recht: pages_read_engagement.
 * Nur Beiträge ab `since`, höchstens `max`.
 */
export async function facebookPagePosts(c: Connection, sec: Record<string, string>, since: Date, max = 100): Promise<PagePost[]> {
  if (!sec.pageToken || !c.config.pageId) throw new StepError('config', 'Noch keine Seite gewählt.');
  const out: PagePost[] = [];
  let r = await call('GET', `${FB_GRAPH()}/${encodeURIComponent(c.config.pageId)}/posts`, { fields: 'id,message,created_time,permalink_url,full_picture,status_type', since: String(Math.floor(since.getTime() / 1000)), limit: '50', access_token: sec.pageToken }, sec, 'Facebook');
  for (let page = 0; page < 10; page++) {
    for (const p of r.data ?? []) {
      const at = new Date(p.created_time ?? 0);
      if (!p.id || Number.isNaN(at.getTime()) || at < since) continue;
      out.push({ remoteId: String(p.id), postedAt: at, message: String(p.message ?? ''), permalink: p.permalink_url ?? null, mediaType: p.status_type ?? null, imageUrl: p.full_picture ?? null });
    }
    if (out.length >= max || !r.paging?.next || !(r.data ?? []).length) break;
    r = await nextPage(r.paging.next, FB_GRAPH(), sec, 'Facebook');
  }
  return out.slice(0, max);
}

/** Beiträge des Instagram-Kontos (Fotos, Videos, Karussells, Reels), neueste zuerst. Recht: instagram_business_basic. */
export async function instagramMediaList(c: Connection, sec: Record<string, string>, since: Date, max = 100): Promise<PagePost[]> {
  if (!sec.token || !c.config.userId) throw new StepError('config', 'Noch kein Konto verbunden.');
  const out: PagePost[] = [];
  let r = await call('GET', `${igBase(c)}/${encodeURIComponent(c.config.userId)}/media`, { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp', limit: '50', access_token: sec.token }, sec, 'Instagram');
  for (let page = 0; page < 10; page++) {
    let older = false;
    for (const p of r.data ?? []) {
      const at = new Date(p.timestamp ?? 0);
      if (!p.id || Number.isNaN(at.getTime())) continue;
      if (at < since) {
        older = true;
        continue;
      }
      // Video/Reel: Vorschaubild statt Videodatei
      const img = p.media_type === 'VIDEO' ? (p.thumbnail_url ?? null) : (p.media_url ?? p.thumbnail_url ?? null);
      out.push({ remoteId: String(p.id), postedAt: at, message: String(p.caption ?? ''), permalink: p.permalink ?? null, mediaType: p.media_type ?? null, imageUrl: img });
    }
    if (older || out.length >= max || !r.paging?.next || !(r.data ?? []).length) break;
    r = await nextPage(r.paging.next, igBase(c), sec, 'Instagram');
  }
  return out.slice(0, max);
}

/** UTC-Tag als 'YYYY-MM-DD'. */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export interface PageStats {
  /** Aktueller Stand (Follower …) – gehört zum Abruftag */
  current: Record<string, number>;
  /** Werte je Tag ('YYYY-MM-DD' → Kennzahl → Wert) */
  days: Record<string, Record<string, number>>;
  /** Kennzahlen, die Meta nicht geliefert hat (Recht fehlt, Seite zu klein oder Kennzahl entfallen) */
  missing: string[];
}

/** Kanalweite Störungen weiterreichen, alles andere gilt als „Kennzahl nicht verfügbar“. */
const channelError = (e: any) => ['auth', 'transient', 'rate_limit'].includes(e?.errorClass);

/**
 * Kennzahlen der Facebook-Seite je Tag (Recht read_insights). Jede Kennzahl einzeln abgefragt: Meta lehnt eine
 * Abfrage mit einer einzigen unbekannten oder entfernten Kennzahl ganz ab, und die Seiten-Kennzahlen werden laufend
 * umgestellt (geprüft 23.11.2026: `page_impressions*` entfallen zugunsten von `page_media_view` und
 * `page_total_media_view_unique`). Was nicht geht, fehlt einfach. Follower und „Gefällt mir“ sind der aktuelle Stand.
 */
export const FB_PAGE_METRICS: Record<string, string> = {
  views: 'page_media_view',
  reach: 'page_total_media_view_unique',
  interactions: 'page_post_engagements',
  new_followers: 'page_daily_follows_unique',
  page_views: 'page_views_total',
};
export async function facebookPageStats(c: Connection, sec: Record<string, string>, since: Date, until: Date): Promise<PageStats> {
  if (!sec.pageToken || !c.config.pageId) throw new StepError('config', 'Noch keine Seite gewählt.');
  const pageId = encodeURIComponent(c.config.pageId);
  const page = await call('GET', `${FB_GRAPH()}/${pageId}`, { fields: 'followers_count,fan_count', access_token: sec.pageToken }, sec, 'Facebook');
  const current: Record<string, number> = {};
  if (n(page.followers_count) != null) current.followers = page.followers_count;
  if (n(page.fan_count) != null) current.fans = page.fan_count;
  const days: Record<string, Record<string, number>> = {};
  const missing: string[] = [];
  for (const [key, metric] of Object.entries(FB_PAGE_METRICS)) {
    try {
      const r = await call('GET', `${FB_GRAPH()}/${pageId}/insights`, { metric, period: 'day', since: String(Math.floor(since.getTime() / 1000)), until: String(Math.floor(until.getTime() / 1000)), access_token: sec.pageToken }, sec, 'Facebook');
      const values = r.data?.[0]?.values ?? [];
      if (!values.length) missing.push(key);
      for (const v of values) {
        const at = new Date(v.end_time ?? 0);
        if (Number.isNaN(at.getTime()) || n(v.value) == null) continue;
        // end_time ist das Ende des Tages (Mitternacht US-Pazifikzeit) – der Wert gehört zum Tag davor
        (days[dayKey(new Date(at.getTime() - 12 * 3600_000))] ??= {})[key] = v.value;
      }
    } catch (e: any) {
      if (channelError(e)) throw e;
      missing.push(key);
    }
  }
  return { current, days, missing };
}

/**
 * Kennzahlen des Instagram-Kontos je Tag (Recht instagram_business_manage_insights; Werte bis zu 48 Stunden
 * verzögert). `metric_type=total_value` liefert eine Summe je Abfrage, daher je Tag und Kennzahl eine Abfrage.
 */
export const IG_ACCOUNT_METRICS: Record<string, string> = { views: 'views', reach: 'reach', interactions: 'total_interactions', engaged: 'accounts_engaged' };
export async function instagramAccountStats(c: Connection, sec: Record<string, string>, dayList: Date[]): Promise<PageStats> {
  if (!sec.token || !c.config.userId) throw new StepError('config', 'Noch kein Konto verbunden.');
  const userId = encodeURIComponent(c.config.userId);
  const acc = await call('GET', `${igBase(c)}/${userId}`, { fields: 'followers_count,media_count', access_token: sec.token }, sec, 'Instagram');
  const current: Record<string, number> = {};
  if (n(acc.followers_count) != null) current.followers = acc.followers_count;
  if (n(acc.media_count) != null) current.posts = acc.media_count;
  const days: Record<string, Record<string, number>> = {};
  const failed = new Set<string>();
  for (const day of dayList) {
    const since = Math.floor(day.getTime() / 1000);
    for (const [key, metric] of Object.entries(IG_ACCOUNT_METRICS)) {
      if (failed.has(key)) continue;
      try {
        const r = await call('GET', `${igBase(c)}/${userId}/insights`, { metric, period: 'day', metric_type: 'total_value', since: String(since), until: String(since + 86_400), access_token: sec.token }, sec, 'Instagram');
        const v = n(r.data?.[0]?.total_value?.value ?? r.data?.[0]?.values?.[0]?.value);
        if (v != null) (days[dayKey(day)] ??= {})[key] = v;
      } catch (e: any) {
        if (channelError(e)) throw e;
        failed.add(key);
      }
    }
  }
  return { current, days, missing: [...failed] };
}
