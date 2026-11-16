import fs from 'node:fs';
import sharp from 'sharp';
import { httpRequest, classifyStatus, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { publicFileFor } from '../routes/media.js';
import type { Connection, TestStep } from './common.js';
import { scrub } from './common.js';
import { BLUESKY_MAX, markerFor, socialText, URL_RE } from './channels.js';
import { connectionTestImage } from './meta.js';

/**
 * Bluesky (#215) über das AT Protocol mit einem App-Passwort. Geprüft am 16.11.2026 anhand der Lexika
 * (github.com/bluesky-social/atproto, packages/api/lexicons) und docs.bsky.app:
 *  - Anmeldung: POST /xrpc/com.atproto.server.createSession (identifier = Handle oder E-Mail, password =
 *    App-Passwort) → accessJwt, did, handle. Gedrosselt (rund 30 Anmeldungen je 5 Minuten) – BlaulichtCMS meldet
 *    sich nur zum Testen, Veröffentlichen, Suchen und Löschen an.
 *  - Bilder: POST /xrpc/com.atproto.repo.uploadBlob (Rohdaten), höchstens 4 je Beitrag, je bis 2 MB, `alt` ist
 *    Pflichtfeld im Lexikon (app.bsky.embed.images). Link-Vorschaukarte: app.bsky.embed.external (uri, title,
 *    description, optional thumb bis 1 MB). Bilder und Karte schließen sich aus.
 *  - Beitrag: POST /xrpc/com.atproto.repo.createRecord (collection app.bsky.feed.post; text höchstens 300 Grapheme
 *    und 3000 Bytes; facets mit Byte-Positionen in UTF-8 für Links und Hashtags; langs).
 *  - Löschen: com.atproto.repo.deleteRecord; Wiedererkennung: com.atproto.repo.listRecords.
 *  - Zahlen: app.bsky.feed.getPosts (öffentliche AppView, bis 25 Beiträge je Abruf; likeCount, repostCount,
 *    replyCount, quoteCount) – ohne Anmeldung.
 */
export const BSKY_DEFAULT_SERVICE = 'https://bsky.social';
const APPVIEW = () => (process.env.BLAULICHTCMS_BSKY_APPVIEW_URL ?? 'https://public.api.bsky.app').replace(/\/$/, '');
const privateHosts = () => ['BLAULICHTCMS_BSKY_APPVIEW_URL', 'BLAULICHTCMS_BSKY_TEST_SERVICE'].map((k) => process.env[k]).filter(Boolean).map((u) => new URL(u!).hostname);

/** Server (PDS) vereinheitlichen: nur https (http nur für den Teststellvertreter), ohne Pfad. */
export function normalizeService(raw: string | undefined | null): string | null {
  const v = String(raw ?? '').trim().replace(/\/+$/, '') || BSKY_DEFAULT_SERVICE;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
  const test = process.env.BLAULICHTCMS_BSKY_TEST_SERVICE ? new URL(process.env.BLAULICHTCMS_BSKY_TEST_SERVICE).host : null;
  if (u.protocol !== 'https:' && u.host !== test) return null;
  return `${u.protocol}//${u.host}`;
}

const service = (c: Pick<Connection, 'config'>) => {
  const s = normalizeService(c.config?.service);
  if (!s) throw new StepError('config', 'Die Server-Adresse (PDS) ist ungültig – leer lassen für bsky.social.');
  return s;
};

interface Xrpc {
  base: string;
  method: 'GET' | 'POST';
  nsid: string;
  jwt?: string;
  query?: Record<string, string | string[]>;
  json?: unknown;
  raw?: { type: string; data: Buffer };
  secrets?: Record<string, string>;
}

async function xrpc({ base, method, nsid, jwt, query, json, raw, secrets = {} }: Xrpc): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x);
  const url = `${base}/xrpc/${nsid}${qs.size ? `?${qs}` : ''}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  let body: string | Buffer | undefined;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (raw) {
    headers['content-type'] = raw.type;
    body = raw.data;
  }
  let res: HttpResponse;
  try {
    res = await httpRequest({ method, url, headers, body, timeoutMs: raw ? 120_000 : 30_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: privateHosts() });
  } catch (e: any) {
    if (e instanceof StepError) throw e;
    throw new StepError('transient', scrub(`Bluesky nicht erreichbar: ${e?.message ?? e}`, { ...secrets, ...(jwt ? { j: jwt } : {}) }));
  }
  const err = classifyStatus(res, 'Bluesky');
  if (err) {
    let detail = '';
    try {
      const j: any = res.json();
      detail = j?.message || j?.error || '';
      // Ungültiges App-Passwort meldet der Server als 401 „AuthenticationRequired“ bzw. „Invalid identifier or password“
      if (res.status === 400 && /ExpiredToken|InvalidToken/.test(String(j?.error))) err.errorClass = 'auth';
    } catch {
      /* kein JSON */
    }
    err.message = scrub(err.message.replace(/\.$/, '') + (detail ? `: ${detail}` : ''), { ...secrets, ...(jwt ? { j: jwt } : {}) });
    (err as any).technical = undefined;
    throw err;
  }
  try {
    return res.body.length ? res.json() : {};
  } catch {
    return {};
  }
}

interface Session {
  base: string;
  jwt: string;
  did: string;
  handle: string;
}

async function login(c: Pick<Connection, 'config'>, sec: Record<string, string>): Promise<Session> {
  const identifier = String(c.config?.identifier ?? '').trim().replace(/^@/, '');
  if (!identifier || !sec.appPassword) throw new StepError('config', 'Bitte Handle und App-Passwort hinterlegen.');
  const base = service(c);
  const s = await xrpc({ base, method: 'POST', nsid: 'com.atproto.server.createSession', json: { identifier, password: sec.appPassword }, secrets: sec });
  if (!s.accessJwt || !s.did) throw new StepError('auth', 'Bluesky hat keine Sitzung geliefert.');
  if (s.active === false) throw new StepError('permission', `Das Konto ist nicht aktiv (${s.status ?? 'unbekannt'}).`);
  return { base, jwt: String(s.accessJwt), did: String(s.did), handle: String(s.handle ?? identifier) };
}

/* ------------------------------------------------------------------ Test */

/**
 * Test ohne öffentlichen Beitrag: mit dem App-Passwort anmelden und ein neutrales Testbild als Blob hochladen
 * (nicht verwendete Blobs löscht der Server selbst) – das prüft das Schreibrecht. Ein Testbeitrag wäre öffentlich.
 */
export async function testBluesky(c: Connection, sec: Record<string, string>) {
  const steps: TestStep[] = [];
  const account: any = {};
  const caps: any = { text: false, image: false, link_card: false, alt_text: false, video: false };
  if (!normalizeService(c.config?.service)) return { steps: [{ name: 'Server', ok: false, message: 'Die Server-Adresse (PDS) ist ungültig – leer lassen für bsky.social.', kind: 'login' as const }], account, capabilities: caps };
  if (!String(c.config?.identifier ?? '').trim() || !sec.appPassword) return { steps: [{ name: 'Zugangsdaten', ok: false, message: 'Bitte Handle und App-Passwort hinterlegen.', kind: 'login' as const }], account, capabilities: caps };
  let s: Session;
  try {
    s = await login(c, sec);
    account.id = s.did;
    account.username = s.handle;
    account.link = `https://bsky.app/profile/${s.handle}`;
    steps.push({ name: 'Anmeldung mit App-Passwort', ok: true, message: `@${s.handle} erreichbar. (Anmeldung allein ist kein Veröffentlichungstest.)`, kind: 'login' });
  } catch (e: any) {
    steps.push({ name: 'Anmeldung mit App-Passwort', ok: false, message: e.errorClass === 'auth' ? `${e.message} – Handle und App-Passwort prüfen (nicht das Kontopasswort verwenden).` : e.message, kind: 'login' });
    return { steps, account, capabilities: caps };
  }
  try {
    const img = await connectionTestImage();
    const r = await xrpc({ base: s.base, method: 'POST', nsid: 'com.atproto.repo.uploadBlob', jwt: s.jwt, raw: { type: 'image/jpeg', data: img }, secrets: sec });
    if (!r?.blob) throw new StepError('invalid_payload', 'Der Server hat das Testbild nicht bestätigt.');
    Object.assign(caps, { text: true, image: true, link_card: true, alt_text: true });
    steps.push({ name: 'Veröffentlichungstest', ok: true, message: 'Neutrales Testbild hochgeladen (nicht veröffentlicht) – Beiträge mit Text (300 Zeichen), bis zu 4 Bildern mit Alternativtext und Link-Vorschaukarte sind möglich. Ein Testbeitrag wäre öffentlich und wird deshalb nicht angelegt.', kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: `Testbild konnte nicht hochgeladen werden: ${e.message}`, kind: 'publish' });
  }
  return { steps, account, capabilities: caps };
}

/* ------------------------------------------------------------------ Text und Facetten */

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).length;

/**
 * Facetten für Links und Hashtags mit Byte-Positionen (UTF-8), wie app.bsky.richtext.facet sie verlangt. Ohne Facette
 * wäre eine Adresse im Text nicht anklickbar.
 */
export function blueskyFacets(text: string): any[] {
  const out: any[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const uri = m[0].replace(/[.,;:!?)\]]+$/, '');
    const start = byteLen(text.slice(0, m.index!));
    out.push({ index: { byteStart: start, byteEnd: start + byteLen(uri) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,64})/gu)) {
    const at = m.index! + m[1].length;
    const start = byteLen(text.slice(0, at));
    out.push({ index: { byteStart: start, byteEnd: start + byteLen(`#${m[2]}`) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }] });
  }
  return out.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/* ------------------------------------------------------------------ Veröffentlichen */

async function blobFor(s: Session, sec: Record<string, string>, m: any, maxBytes: number): Promise<{ blob: any; width?: number; height?: number } | null> {
  const f = publicFileFor(m);
  if (!f || !fs.existsSync(f.path)) return null;
  let data = await fs.promises.readFile(f.path);
  let type = f.type;
  // Bluesky nimmt Bilder bis 2 MB (Vorschaubild der Karte bis 1 MB) – größere schrittweise verkleinern
  for (const [edge, q] of [[2048, 85], [1600, 80], [1200, 75], [900, 70]] as const) {
    if (data.length <= maxBytes) break;
    data = await sharp(await fs.promises.readFile(f.path)).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: q }).toBuffer();
    type = 'image/jpeg';
  }
  if (data.length > maxBytes) return null;
  const meta = await sharp(data).metadata().catch(() => ({}) as any);
  const r = await xrpc({ base: s.base, method: 'POST', nsid: 'com.atproto.repo.uploadBlob', jwt: s.jwt, raw: { type, data }, secrets: sec });
  return { blob: r.blob, width: meta.width, height: meta.height };
}

const webUrl = (handle: string, uri: string) => `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}`;

export async function publishBluesky(c: Connection, sec: Record<string, string>, { sp, rev, media }: { sp: any; rev: any; media: any[] }) {
  const s = await login(c, sec);
  const text = socialText(rev, 'bluesky', sp.link);
  const images = media.filter((m) => m.kind === 'image').slice(0, 4);
  let embed: any;
  if (images.length) {
    const list: any[] = [];
    for (const m of images) {
      const b = await blobFor(s, sec, m, 2_000_000);
      if (!b) continue;
      list.push({ image: b.blob, alt: String(m.alt ?? '').trim().slice(0, 2000), ...(b.width && b.height ? { aspectRatio: { width: b.width, height: b.height } } : {}) });
    }
    if (list.length) embed = { $type: 'app.bsky.embed.images', images: list };
  } else if (sp.link) {
    // Link-Vorschaukarte aus den eigenen Angaben des Beitrags – ohne die Website abzurufen
    const cover = media.find((m) => m.id === rev.cover_id && m.kind === 'image');
    const thumb = cover ? await blobFor(s, sec, cover, 1_000_000).catch(() => null) : null;
    embed = { $type: 'app.bsky.embed.external', external: { uri: sp.link, title: String(rev.title ?? '').slice(0, 300), description: String(rev.excerpt || rev.body || '').replace(/\s+/g, ' ').trim().slice(0, 300), ...(thumb ? { thumb: thumb.blob } : {}) } };
  }
  const facets = blueskyFacets(text);
  const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: [String(c.config?.language || 'de').slice(0, 2)], ...(facets.length ? { facets } : {}), ...(embed ? { embed } : {}) };
  const r = await xrpc({ base: s.base, method: 'POST', nsid: 'com.atproto.repo.createRecord', jwt: s.jwt, json: { repo: s.did, collection: 'app.bsky.feed.post', record }, secrets: sec });
  if (!r?.uri) throw new StepError('timeout_unknown', 'Bluesky hat keine Beitragsadresse geliefert – bitte im Konto prüfen.', { sideEffectUnknown: true });
  return { id: String(r.uri), url: webUrl(s.handle, String(r.uri)) };
}

export async function findExistingBluesky(c: Connection, sec: Record<string, string>, marker: string, since: Date) {
  const s = await login(c, sec);
  const r = await xrpc({ base: s.base, method: 'GET', nsid: 'com.atproto.repo.listRecords', jwt: s.jwt, query: { repo: s.did, collection: 'app.bsky.feed.post', limit: '25' }, secrets: sec });
  for (const rec of r.records ?? []) {
    const v = rec.value ?? {};
    if (new Date(v.createdAt ?? 0).getTime() < since.getTime() - 120_000) continue;
    if (typeof v.text === 'string' && markerFor(v.text, 'bluesky') === marker) return { id: String(rec.uri), url: webUrl(s.handle, String(rec.uri)) };
  }
  return null;
}

export async function deleteBlueskyPost(c: Connection, sec: Record<string, string>, uri: string) {
  const s = await login(c, sec);
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  if (!m) throw new StepError('invalid_payload', 'Unbekannte Beitragsadresse.');
  await xrpc({ base: s.base, method: 'POST', nsid: 'com.atproto.repo.deleteRecord', jwt: s.jwt, json: { repo: s.did, collection: 'app.bsky.feed.post', rkey: m[2] }, secrets: sec });
}

/** Öffentliche Zähler über die AppView (ohne Anmeldung), bis 25 Beiträge je Abruf. */
export async function blueskyMetrics(uris: string[]): Promise<Map<string, { likes: number | null; reposts: number | null; replies: number | null; quotes: number | null }>> {
  const out = new Map<string, any>();
  for (let i = 0; i < uris.length; i += 25) {
    const r = await xrpc({ base: APPVIEW(), method: 'GET', nsid: 'app.bsky.feed.getPosts', query: { uris: uris.slice(i, i + 25) } });
    for (const p of r.posts ?? []) out.set(String(p.uri), { likes: num(p.likeCount), reposts: num(p.repostCount), replies: num(p.replyCount), quotes: num(p.quoteCount) });
  }
  return out;
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function checkBlueskyFormats(media: any[], tooLong: boolean): string[] {
  const issues: string[] = [];
  if (media.some((m) => m.kind === 'video')) issues.push('Bluesky: Videos überträgt BlaulichtCMS nicht – es gehen nur Text und bis zu 4 Bilder.');
  if (media.filter((m) => m.kind === 'image').length > 4) issues.push('Bluesky: höchstens 4 Bilder je Beitrag – weitere werden nicht übertragen.');
  if (tooLong) issues.push(`Bluesky: Text auf ${BLUESKY_MAX} Zeichen gekürzt – ein eigener, kürzerer Text ist besser.`);
  return issues;
}
