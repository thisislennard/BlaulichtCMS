import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import { httpRequest, classifyStatus, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { publicFileFor } from '../routes/media.js';
import type { Connection, TestStep } from './common.js';
import { allowedPrivateHosts, scrub } from './common.js';
import { contentWarning, limitsFor, markerFor, MASTODON_MAX, socialText } from './channels.js';
import { connectionTestImage } from './meta.js';

/**
 * Mastodon (#215) über die offizielle Mastodon-API der frei wählbaren Instanz. Geprüft am 16.11.2026 auf
 * docs.joinmastodon.org:
 *  - App registrieren: POST /api/v1/apps (client_name, redirect_uris, scopes, website) → client_id, client_secret.
 *  - Anmeldung: GET /oauth/authorize (response_type=code, client_id, redirect_uri, scope, state), Code →
 *    POST /oauth/token (grant_type=authorization_code, code, client_id, client_secret, redirect_uri).
 *    Alternativ ein Zugangstoken aus „Einstellungen → Entwicklung“ der Instanz.
 *  - Konto: GET /api/v1/accounts/verify_credentials; Grenzen: GET /api/v2/instance (öffentlich;
 *    configuration.statuses.max_characters, max_media_attachments, characters_reserved_per_url,
 *    configuration.media_attachments.description_limit).
 *  - Medien: POST /api/v2/media (file, description = Alternativtext) → 200 (fertig) oder 202 (in Arbeit,
 *    GET /api/v1/media/:id liefert 206 bis fertig, dann 200).
 *  - Beitrag: POST /api/v1/statuses (status, media_ids[], visibility, spoiler_text, language) mit Kopfzeile
 *    Idempotency-Key (eine Stunde gültig – ein erneuter Versuch legt keinen zweiten Beitrag an); scheduled_at
 *    (mindestens 5 Minuten in der Zukunft) legt nur einen geplanten Beitrag an – das nutzt der Test.
 *  - Löschen: DELETE /api/v1/statuses/:id; geplante Beiträge DELETE /api/v1/scheduled_statuses/:id.
 */
export const MASTODON_SCOPES = ['read:accounts', 'read:statuses', 'write:statuses', 'write:media'];
export const MASTODON_VISIBILITY = ['public', 'unlisted', 'private'] as const;

/** Instanz-Adresse vereinheitlichen: nur https (http nur für ausdrücklich freigegebene Testhosts), ohne Pfad. */
export function normalizeInstance(raw: string): string | null {
  const v = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && testHosts().includes(u.hostname))) return null;
  return `${u.protocol}//${u.host}`;
}

/** Nur für Tests: Hosts, die privat und über http erreichbar sein dürfen (Stellvertreter der Instanz). */
const testHosts = () => (process.env.BLAULICHTCMS_MASTODON_TEST_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function base(c: Pick<Connection, 'config'>): string {
  const b = normalizeInstance(c.config?.instance ?? '');
  if (!b) throw new StepError('config', 'Bitte die Adresse der Mastodon-Instanz angeben (z. B. https://social.bund.de).');
  return b;
}

interface CallOpts {
  token?: string;
  form?: Record<string, string | string[] | undefined>;
  multipart?: { fields: Record<string, string>; file: { name: string; type: string; data: Buffer } };
  headers?: Record<string, string>;
  secrets?: Record<string, string>;
  okStatuses?: number[];
}

async function call(c: Pick<Connection, 'config' | 'private_target' | 'private_approved_at'>, method: string, path: string, o: CallOpts = {}): Promise<{ json: any; res: HttpResponse }> {
  const url = `${base(c)}${path}`;
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: string | Buffer | undefined;
  if (o.form) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.form)) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else qs.append(k, v);
    }
    body = qs.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (o.multipart) {
    const boundary = `----blaulichtcms${crypto.randomBytes(12).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(o.multipart.fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
    const f = o.multipart.file;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`, 'utf8'), f.data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    body = Buffer.concat(parts);
    headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
  }
  const secrets = { ...(o.secrets ?? {}), ...(o.token ? { t: o.token } : {}) };
  let res: HttpResponse;
  try {
    res = await httpRequest({ method, url, headers, body, timeoutMs: o.multipart ? 120_000 : 30_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: [...allowedPrivateHosts(c as Connection), ...testHosts()] });
  } catch (e: any) {
    if (e instanceof StepError) throw e;
    throw new StepError('transient', scrub(`Mastodon-Instanz nicht erreichbar: ${e?.message ?? e}`, secrets));
  }
  if (!o.okStatuses?.includes(res.status)) {
    const err = classifyStatus(res, 'Mastodon');
    if (err) {
      let detail = '';
      try {
        const j: any = res.json();
        detail = j?.error_description || j?.error || '';
      } catch {
        /* kein JSON */
      }
      err.message = scrub(err.message.replace(/\.$/, '') + (detail ? `: ${detail}` : ''), secrets);
      (err as any).technical = undefined;
      throw err;
    }
  }
  let json: any = {};
  try {
    json = res.body.length ? res.json() : {};
  } catch {
    json = {};
  }
  return { json, res };
}

/* ------------------------------------------------------------------ App und Anmeldung */

/** App auf der Instanz registrieren (einmal je Instanz und Weiterleitungsadresse). */
export async function registerMastodonApp(c: Connection, redirectUri: string, website: string) {
  const { json } = await call(c, 'POST', '/api/v1/apps', { form: { client_name: 'BlaulichtCMS', redirect_uris: redirectUri, scopes: MASTODON_SCOPES.join(' '), website: /^https:\/\//.test(website) ? website : undefined } });
  if (!json.client_id || !json.client_secret) throw new StepError('invalid_payload', 'Die Instanz hat keine App-Zugangsdaten geliefert.');
  return { clientId: String(json.client_id), clientSecret: String(json.client_secret) };
}

export function mastodonAuthorizeUrl(c: Connection, clientId: string, redirectUri: string, state: string) {
  return `${base(c)}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: MASTODON_SCOPES.join(' '), state })}`;
}

export async function mastodonExchange(c: Connection, clientId: string, clientSecret: string, redirectUri: string, code: string) {
  const { json } = await call(c, 'POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }, secrets: { clientSecret, code } });
  if (!json.access_token) throw new StepError('auth', 'Die Instanz hat kein Zugangstoken geliefert.');
  return String(json.access_token);
}

/* ------------------------------------------------------------------ Test */

/**
 * Test ohne öffentlichen Beitrag: Konto lesen, Grenzen der Instanz lesen, Rechte der App prüfen, einen geplanten
 * Beitrag (Sichtbarkeit „nur Erwähnte“, einen Tag in der Zukunft) anlegen und sofort wieder löschen und ein neutrales
 * Testbild mit Alternativtext hochladen (nicht angehängte Medien räumt die Instanz selbst ab; ab Mastodon 4.4 wird
 * es gleich gelöscht).
 */
export async function testMastodon(c: Connection, sec: Record<string, string>) {
  const steps: TestStep[] = [];
  const account: any = {};
  const caps: any = { text: false, image: false, video: false, alt_text: false, content_warning: false };
  if (!normalizeInstance(c.config?.instance ?? '')) return { steps: [{ name: 'Instanz', ok: false, message: 'Bitte die Adresse der Mastodon-Instanz angeben (https://…).', kind: 'login' as const }], account, capabilities: caps };
  if (!sec.token) return { steps: [{ name: 'Konto verbunden', ok: false, message: 'Noch nicht mit Mastodon verbunden (Anmelden oder Zugangstoken hinterlegen).', kind: 'login' as const }], account, capabilities: caps };
  try {
    const { json: me } = await call(c, 'GET', '/api/v1/accounts/verify_credentials', { token: sec.token, secrets: sec });
    account.id = String(me.id ?? '');
    account.username = me.acct ?? me.username;
    account.name = me.display_name || me.username;
    account.link = me.url ?? null;
    steps.push({ name: 'Anmeldung und Konto', ok: !!account.id, message: account.id ? `@${account.username} erreichbar. (Anmeldung allein ist kein Veröffentlichungstest.)` : 'Die Instanz hat kein Konto geliefert.', kind: 'login' });
    if (!account.id) return { steps, account, capabilities: caps };
  } catch (e: any) {
    steps.push({ name: 'Anmeldung und Konto', ok: false, message: e.message, kind: 'login' });
    return { steps, account, capabilities: caps };
  }
  try {
    const { json: inst } = await call(c, 'GET', '/api/v2/instance');
    const st = inst?.configuration?.statuses ?? {};
    const ma = inst?.configuration?.media_attachments ?? {};
    caps.max_characters = Number(st.max_characters) || MASTODON_MAX;
    caps.max_media = Number(st.max_media_attachments) || 4;
    caps.url_chars = Number(st.characters_reserved_per_url) || 23;
    caps.alt_limit = Number(ma.description_limit) || 1500;
    account.instance = inst?.domain ?? inst?.title ?? null;
    account.version = inst?.version ?? null;
    steps.push({ name: 'Grenzen der Instanz', ok: true, message: `Bis ${caps.max_characters} Zeichen, ${caps.max_media} Dateien je Beitrag, Alternativtext bis ${caps.alt_limit} Zeichen.`, kind: 'read' });
  } catch (e: any) {
    caps.max_characters = MASTODON_MAX;
    caps.max_media = 4;
    steps.push({ name: 'Grenzen der Instanz', ok: true, message: `Nicht lesbar (${e.message}) – BlaulichtCMS nimmt die Standardwerte (500 Zeichen, 4 Dateien).`, kind: 'read' });
  }
  try {
    const { json: app } = await call(c, 'GET', '/api/v1/apps/verify_credentials', { token: sec.token, secrets: sec });
    // `scopes` liefert die App erst ab Mastodon 4.3 – sonst zeigt der Testbeitrag unten, ob Schreiben erlaubt ist
    const scopes: string[] = Array.isArray(app?.scopes) ? app.scopes : [];
    if (scopes.length) {
      const has = (s: string) => scopes.includes(s) || scopes.includes(s.split(':')[0]);
      const missing = MASTODON_SCOPES.filter((s) => !has(s));
      steps.push({ name: 'Rechte der App', ok: missing.length === 0, message: missing.length ? `Es fehlen: ${missing.join(', ')}. In der Instanz unter „Einstellungen → Entwicklung“ die Rechte ergänzen bzw. neu anmelden.` : `Erteilt: ${MASTODON_SCOPES.join(', ')}`, kind: 'read' });
    }
  } catch {
    /* ältere Instanzen ohne diesen Endpunkt – der Schreibtest entscheidet */
  }
  try {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const { json: sch } = await call(c, 'POST', '/api/v1/statuses', { token: sec.token, secrets: sec, headers: { 'idempotency-key': `blaulichtcms-test-${crypto.randomUUID()}` }, form: { status: 'BlaulichtCMS-Verbindungstest (geplant, wird sofort gelöscht)', visibility: 'direct', scheduled_at: at } });
    if (!sch?.id || !sch?.scheduled_at) throw new StepError('invalid_payload', 'Die Instanz hat den geplanten Testbeitrag nicht als geplant bestätigt – bitte im Konto nachsehen.');
    await call(c, 'DELETE', `/api/v1/scheduled_statuses/${encodeURIComponent(sch.id)}`, { token: sec.token, secrets: sec }).catch(() => null);
    caps.text = caps.content_warning = true;
    steps.push({ name: 'Veröffentlichungstest', ok: true, message: 'Geplanten Testbeitrag angelegt und sofort wieder gelöscht (nie öffentlich) – Beiträge mit Text, Link und Inhaltswarnung sind möglich.', kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: `Testbeitrag konnte nicht angelegt werden: ${e.message}`, kind: 'publish' });
    return { steps, account, capabilities: caps };
  }
  try {
    const img = await connectionTestImage();
    const { json: med } = await call(c, 'POST', '/api/v2/media', { token: sec.token, secrets: sec, okStatuses: [202], multipart: { fields: { description: 'Graues Testbild mit hellerem Quadrat in der Mitte (BlaulichtCMS-Verbindungstest)' }, file: { name: 'blaulichtcms-test.jpg', type: 'image/jpeg', data: img } } });
    if (med?.id) await call(c, 'DELETE', `/api/v1/media/${encodeURIComponent(med.id)}`, { token: sec.token, secrets: sec }).catch(() => null);
    caps.image = caps.video = caps.alt_text = true;
    steps.push({ name: 'Medien hochladen', ok: true, message: 'Neutrales Testbild mit Alternativtext hochgeladen (nicht veröffentlicht) – Bilder und Videos mit Alternativtext sind möglich.', kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Medien hochladen', ok: false, message: `Testbild konnte nicht hochgeladen werden: ${e.message}`, kind: 'publish' });
  }
  return { steps, account, capabilities: caps };
}

/* ------------------------------------------------------------------ Veröffentlichen */

/** Bilder über 16 MB (übliche Grenze der Instanzen) verkleinern; die öffentliche Fassung ist bereits ohne Metadaten. */
async function mediaFile(m: any): Promise<{ name: string; type: string; data: Buffer } | null> {
  const f = publicFileFor(m);
  if (!f || !fs.existsSync(f.path)) return null;
  let data = await fs.promises.readFile(f.path);
  let type = f.type;
  if (m.kind === 'image' && data.length > 8 * 1024 * 1024) {
    data = await sharp(data).resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    type = 'image/jpeg';
  }
  return { name: `${m.id}.${f.ext}`, type, data };
}

async function waitMedia(c: Connection, sec: Record<string, string>, id: string, tries = 40, delayMs = 3000) {
  for (let i = 0; i < tries; i++) {
    const { res } = await call(c, 'GET', `/api/v1/media/${encodeURIComponent(id)}`, { token: sec.token, secrets: sec, okStatuses: [206] });
    if (res.status === 200) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new StepError('transient', 'Die Instanz verarbeitet die Datei noch – bitte später erneut versuchen.');
}

/** Welche Dateien gehen an Mastodon: ein Video (Mastodon mischt Video und Bilder nicht) oder bis zu N Bilder. */
export function mastodonMedia(media: any[], max = 4): any[] {
  const video = media.find((m) => m.kind === 'video');
  if (video) return [video];
  return media.filter((m) => m.kind === 'image').slice(0, max);
}

export async function publishMastodon(c: Connection, sec: Record<string, string>, { sp, rev, media }: { sp: any; rev: any; media: any[] }) {
  if (!sec.token) throw new StepError('config', 'Die Verbindung ist nicht (mehr) bei Mastodon angemeldet.');
  const text = socialText(rev, 'mastodon', sp.link, limitsFor(c));
  const altLimit = Number(c.capabilities?.alt_limit) || 1500;
  const ids: string[] = [];
  for (const m of mastodonMedia(media, Number(c.capabilities?.max_media) || 4)) {
    const file = await mediaFile(m);
    if (!file) continue;
    const alt = String(m.alt ?? '').trim().slice(0, altLimit);
    const { json, res } = await call(c, 'POST', '/api/v2/media', { token: sec.token, secrets: sec, okStatuses: [202], multipart: { fields: alt ? { description: alt } : {}, file } });
    if (!json?.id) throw new StepError('invalid_payload', 'Die Instanz hat die Datei nicht angenommen.');
    if (res.status === 202 || !json.url) await waitMedia(c, sec, String(json.id));
    ids.push(String(json.id));
  }
  const cw = contentWarning(rev);
  const visibility = (MASTODON_VISIBILITY as readonly string[]).includes(c.config?.visibility) ? c.config.visibility : 'public';
  // Idempotency-Key = Auftrag: ein erneuter Versuch binnen einer Stunde liefert denselben Beitrag statt eines zweiten
  const { json } = await call(c, 'POST', '/api/v1/statuses', {
    token: sec.token,
    secrets: sec,
    headers: { 'idempotency-key': `blaulichtcms-${sp.id}` },
    form: { status: text, 'media_ids[]': ids.length ? ids : undefined, visibility, spoiler_text: cw || undefined, language: String(c.config?.language || 'de').slice(0, 2) },
  });
  if (!json?.id) throw new StepError('timeout_unknown', 'Mastodon hat keine Beitrags-ID geliefert – bitte im Konto prüfen.', { sideEffectUnknown: true });
  return { id: String(json.id), url: json.url ?? json.uri ?? null };
}

/** Mastodon liefert den Text als HTML – für die Wiedererkennung in Text zurückverwandeln. */
export function mastodonHtmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

export async function findExistingMastodon(c: Connection, sec: Record<string, string>, marker: string, since: Date) {
  const uid = c.account?.id;
  if (!uid || !sec.token) return null;
  const { json } = await call(c, 'GET', `/api/v1/accounts/${encodeURIComponent(uid)}/statuses?limit=20&exclude_replies=true&exclude_reblogs=true`, { token: sec.token, secrets: sec });
  for (const s of Array.isArray(json) ? json : []) {
    if (new Date(s.created_at ?? 0).getTime() < since.getTime() - 120_000) continue;
    if (markerFor(mastodonHtmlToText(s.content), 'mastodon') === marker) return { id: String(s.id), url: s.url ?? s.uri ?? null };
  }
  return null;
}

export async function deleteMastodonPost(c: Connection, sec: Record<string, string>, id: string) {
  await call(c, 'DELETE', `/api/v1/statuses/${encodeURIComponent(id)}`, { token: sec.token, secrets: sec });
}

/** Öffentliche Zähler eines Beitrags (Boosts, Favoriten, Antworten) – nur Zahlen, keine Personen. */
export async function mastodonMetrics(c: Connection, sec: Record<string, string>, id: string) {
  const { json } = await call(c, 'GET', `/api/v1/statuses/${encodeURIComponent(id)}`, { token: sec.token, secrets: sec });
  return { reposts: num(json.reblogs_count), likes: num(json.favourites_count), replies: num(json.replies_count), quotes: num(json.quotes_count) };
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function checkMastodonFormats(c: Pick<Connection, 'capabilities'>, media: any[], tooLong: boolean): string[] {
  const issues: string[] = [];
  const max = Number(c.capabilities?.max_media) || 4;
  if (media.some((m) => m.kind === 'video') && media.length > 1) issues.push('Mastodon: Video und Bilder lassen sich nicht mischen – übertragen wird nur das erste Video.');
  else if (media.filter((m) => m.kind === 'image').length > max) issues.push(`Mastodon: höchstens ${max} Bilder je Beitrag – weitere werden nicht übertragen.`);
  if (tooLong) issues.push(`Mastodon: Text auf ${Number(c.capabilities?.max_characters) || MASTODON_MAX} Zeichen gekürzt (Inhaltswarnung zählt mit) – ein eigener, kürzerer Text ist besser.`);
  return issues;
}

