import sharp from 'sharp';
import { many, one, pool } from '../db/pool.js';
import { httpRequest, classifyStatus, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { sha256Hex, randomToken } from '../lib/crypto.js';
import { publicBase } from '../lib/urls.js';
import { publicFileFor } from '../routes/media.js';
import type { Connection, TestStep } from './common.js';
import { scrub } from './common.js';
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

/** Ausdrücklich per Umgebungsvariable gesetzte Endpunkte (z. B. Testdienst) dürfen privat sein. */
function privateHosts(): string[] {
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
  return `${FB_DIALOG()}?${new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, scope: FB_SCOPES.join(','), response_type: 'code' })}`;
}
export function instagramAuthorizeUrl(appId: string, redirectUri: string, state: string) {
  return `${IG_DIALOG()}?${new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, scope: IG_SCOPES.join(','), response_type: 'code' })}`;
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

/* ------------------------------------------------------------------ Test */

/**
 * Test je Kanal. Eine erfolgreiche Anmeldung ist ausdrücklich KEIN Veröffentlichungstest:
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
    const missing = FB_SCOPES.filter((s) => !granted.includes(s));
    steps.push({ name: 'Berechtigungen', ok: !sec.userToken || missing.length === 0, message: !sec.userToken ? 'Seiten-Token manuell hinterlegt – Berechtigungen nicht abfragbar.' : missing.length ? `Es fehlen: ${missing.join(', ')}` : `Erteilt: ${FB_SCOPES.join(', ')}`, kind: 'read' });
  } catch (e: any) {
    steps.push({ name: 'Berechtigungen', ok: false, message: e.message, kind: 'read' });
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
  try {
    const me = await call('GET', `${IG_GRAPH()}/me`, { fields: 'user_id,username,account_type', access_token: sec.token }, sec, 'Instagram');
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
    const lim = await call('GET', `${IG_GRAPH()}/${userId}/content_publishing_limit`, { fields: 'quota_usage,config', access_token: sec.token }, sec, 'Instagram');
    const d = lim.data?.[0] ?? {};
    account.quota = { used: d.quota_usage ?? null, total: d.config?.quota_total ?? null };
    steps.push({ name: 'Veröffentlichungskontingent', ok: true, message: `Heute genutzt: ${d.quota_usage ?? '?'} von ${d.config?.quota_total ?? '?'}`, kind: 'read' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungskontingent', ok: false, message: e.message, kind: 'read' });
  }
  if (!testImageUrl) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: 'Für den Test ist eine öffentlich erreichbare HTTPS-Adresse von BlaulichtCMS nötig (Basisadresse in den Einstellungen).', kind: 'publish' });
    return { steps, account, capabilities: caps };
  }
  try {
    const cont = await call('POST', `${IG_GRAPH()}/${userId}/media`, { image_url: testImageUrl, caption: 'BlaulichtCMS-Verbindungstest (wird nicht veröffentlicht)', access_token: sec.token }, sec, 'Instagram');
    const status = await waitContainer(cont.id, sec, 6, 2000);
    const ok = status === 'FINISHED';
    if (ok) Object.assign(caps, { image: true, carousel: true, reels: true, stories: true });
    steps.push({ name: 'Veröffentlichungstest', ok, message: ok ? 'Mediencontainer mit Testbild verarbeitet (nicht veröffentlicht) – Bilder, Karussell, Reels und Storys möglich. Reine Textbeiträge unterstützt Instagram nicht.' : `Container-Status: ${status}. Meta konnte das Testbild nicht abrufen oder verarbeiten.`, kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: `Mediencontainer konnte nicht angelegt werden: ${e.message}`, kind: 'publish' });
  }
  return { steps, account: { ...account }, capabilities: caps, userId };
}

async function waitContainer(id: string, sec: Record<string, string>, tries = 60, delayMs = 5000): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const s = await call('GET', `${IG_GRAPH()}/${id}`, { fields: 'status_code', access_token: sec.token }, sec, 'Instagram');
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
  const r = await call('GET', `${IG_GRAPH()}/${c.config.userId}/media`, { fields: 'id,caption,permalink,timestamp', limit: '25', access_token: sec.token }, sec, 'Instagram');
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
    st = await waitContainer(container, sec).catch((e) => {
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
      container = (await call('POST', `${IG_GRAPH()}/${user}/media`, { ...p, caption, access_token: sec.token }, sec, 'Instagram')).id;
    } else {
      const children: string[] = [];
      for (const m of items) {
        const p = m.kind === 'video' ? { media_type: 'VIDEO', video_url: await mediaUrl(m.id) } : { image_url: await mediaUrl(m.id), alt_text: altParam(m) };
        const child = (await call('POST', `${IG_GRAPH()}/${user}/media`, { ...p, is_carousel_item: 'true', access_token: sec.token }, sec, 'Instagram')).id;
        const st = await waitContainer(child, sec);
        if (st !== 'FINISHED') throw new StepError('invalid_payload', `Instagram konnte eine Datei nicht verarbeiten (Status ${st}).`);
        children.push(child);
      }
      container = (await call('POST', `${IG_GRAPH()}/${user}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: sec.token }, sec, 'Instagram')).id;
    }
    await onContainer(container!);
  }
  st ??= await waitContainer(container!, sec);
  if (st !== 'FINISHED') {
    if (st === 'ERROR' || st === 'EXPIRED') await onContainer(null);
    throw new StepError('invalid_payload', `Instagram-Container nicht bereit (Status ${st}).`);
  }
  const pub = await call('POST', `${IG_GRAPH()}/${user}/media_publish`, { creation_id: container!, access_token: sec.token }, sec, 'Instagram');
  const info = await call('GET', `${IG_GRAPH()}/${pub.id}`, { fields: 'permalink', access_token: sec.token }, sec, 'Instagram').catch(() => ({}));
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
    const st = await waitContainer(container, sec).catch(() => 'EXPIRED');
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
    container = String((await call('POST', `${IG_GRAPH()}/${user}/media`, { media_type: 'STORIES', ...p, access_token: sec.token }, sec, 'Instagram')).id);
    await onContainer(container);
  }
  const st = await waitContainer(container, sec);
  if (st !== 'FINISHED') {
    if (st === 'ERROR' || st === 'EXPIRED') await onContainer(null);
    throw new StepError('invalid_payload', `Instagram-Story nicht bereit (Status ${st}).`);
  }
  const pub = await call('POST', `${IG_GRAPH()}/${user}/media_publish`, { creation_id: container, access_token: sec.token }, sec, 'Instagram');
  const info = await call('GET', `${IG_GRAPH()}/${pub.id}`, { fields: 'permalink', access_token: sec.token }, sec, 'Instagram').catch(() => ({}));
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
    const st = await call('GET', `${IG_GRAPH()}/${sp.container_id}`, { fields: 'status_code', access_token: sec.token }, sec, 'Instagram').catch(() => ({ status_code: 'EXPIRED' }));
    if (st.status_code !== 'PUBLISHED') return null;
    const r = await call('GET', `${IG_GRAPH()}/${c.config.userId}/stories`, { fields: 'id,permalink,timestamp', access_token: sec.token }, sec, 'Instagram');
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

/** Prüft je Kanal, ob die Medien der Fassung unterstützt werden (vor der Freigabe sichtbar). */
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
