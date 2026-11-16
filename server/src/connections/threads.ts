import { httpRequest, classifyStatus, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { publicFileFor } from '../routes/media.js';
import type { Connection, TestStep } from './common.js';
import { connectionSecrets, scrub, updateConnectionSecrets } from './common.js';
import { markerFor, socialText, THREADS_MAX } from './channels.js';
import { mediaUrl } from './meta.js';

/**
 * Threads (#189) über die offizielle Threads-API (Meta). Geprüft am 16.11.2026 auf developers.facebook.com/docs/threads:
 *  - Anmeldung: https://threads.com/oauth/authorize (client_id, redirect_uri, scope, response_type=code, state),
 *    Rechte threads_basic und threads_content_publish; Code → POST graph.threads.com/oauth/access_token (liefert
 *    user_id), → langlebig GET /access_token?grant_type=th_exchange_token (60 Tage), Verlängern GET
 *    /refresh_access_token?grant_type=th_refresh_token (Token mindestens 24 h alt und noch gültig).
 *  - Veröffentlichen: Container POST /{user-id}/threads (media_type TEXT/IMAGE/VIDEO bzw. CAROUSEL mit 2–20 Kindern,
 *    text, image_url, video_url, link_attachment nur bei TEXT), Status GET /{container}?fields=status,error_message,
 *    dann POST /{user-id}/threads_publish (creation_id). Texte höchstens 500 Zeichen.
 */
export const THREADS_API_VERSION = 'v1.0';
export const TH_GRAPH = () => (process.env.BLAULICHTCMS_THREADS_GRAPH_URL ?? `https://graph.threads.com/${THREADS_API_VERSION}`).replace(/\/$/, '');
const TH_ROOT = () => TH_GRAPH().replace(/\/v[\d.]+$/, '');
export const TH_DIALOG = () => (process.env.BLAULICHTCMS_THREADS_DIALOG_URL ?? 'https://threads.com/oauth/authorize').replace(/\/$/, '');
export const TH_SCOPES = ['threads_basic', 'threads_content_publish'];
const privateHosts = () => (process.env.BLAULICHTCMS_THREADS_GRAPH_URL ? [new URL(process.env.BLAULICHTCMS_THREADS_GRAPH_URL).hostname] : []);

async function call(method: string, url: string, params: Record<string, string | undefined> = {}, secrets: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
  let res: HttpResponse;
  try {
    res =
      method === 'GET' || method === 'DELETE'
        ? await httpRequest({ method, url: `${url}${qs.size ? `?${qs}` : ''}`, timeoutMs: 30_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: privateHosts() })
        : await httpRequest({ method, url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs.toString(), timeoutMs: 60_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: privateHosts() });
  } catch (e: any) {
    if (e instanceof StepError) throw e;
    throw new StepError('transient', scrub(`Threads nicht erreichbar: ${e?.message ?? e}`, secrets));
  }
  const err = classifyStatus(res, 'Threads');
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

export function threadsAuthorizeUrl(appId: string, redirectUri: string, state: string) {
  return `${TH_DIALOG()}?${new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope: TH_SCOPES.join(','), response_type: 'code', state })}`;
}

export async function threadsExchange(appId: string, appSecret: string, redirectUri: string, code: string) {
  const s = { appSecret, code };
  const short = await call('POST', `${TH_ROOT()}/oauth/access_token`, { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }, s);
  const long = await call('GET', `${TH_ROOT()}/access_token`, { grant_type: 'th_exchange_token', client_secret: appSecret, access_token: short.access_token }, { ...s, t: short.access_token });
  return { token: long.access_token as string, userId: String(short.user_id ?? ''), expiresIn: Number(long.expires_in ?? 0) };
}

/**
 * Langlebige Threads-Tokens gelten 60 Tage und lassen sich verlängern, solange sie gültig und mindestens 24 Stunden alt
 * sind. Der Worker verlängert täglich alle Tokens, die in weniger als 20 Tagen ablaufen.
 */
export async function refreshThreadsTokens(): Promise<number> {
  const rows = (await pool.query(`SELECT * FROM connections WHERE kind = 'threads' AND status IN ('tested','active','disabled') AND deleted_at IS NULL AND secret_id IS NOT NULL`)).rows as Connection[];
  let n = 0;
  for (const c of rows) {
    const exp = c.config?.tokenExpiresAt ? Date.parse(c.config.tokenExpiresAt) : NaN;
    if (Number.isFinite(exp) && exp - Date.now() > 20 * 86_400_000) continue;
    if (Number.isFinite(exp) && exp < Date.now()) continue;
    const sec = await connectionSecrets(c);
    if (!sec.token) continue;
    try {
      const r = await call('GET', `${TH_ROOT()}/refresh_access_token`, { grant_type: 'th_refresh_token', access_token: sec.token }, sec);
      if (!r.access_token) continue;
      await updateConnectionSecrets(c, { token: r.access_token }, null);
      await pool.query(`UPDATE connections SET config = config || $2 WHERE id = $1`, [c.id, JSON.stringify({ tokenExpiresAt: new Date(Date.now() + Number(r.expires_in ?? 60 * 86_400) * 1000).toISOString() })]);
      n++;
    } catch (e: any) {
      log('warn', 'threads', `${c.name}: Token nicht verlängert – ${scrub(e.message, sec)}`);
      if (Number.isFinite(exp) && exp - Date.now() < 5 * 86_400_000) await notify({ kind: 'warning', title: `${c.name}: Threads-Anmeldung läuft bald ab`, body: 'Bitte die Verbindung erneut mit Threads verbinden und testen.', link: `/verbindungen/${c.id}`, permission: 'connection.configure' });
    }
  }
  return n;
}

/* ------------------------------------------------------------------ Test */

async function waitContainer(id: string, sec: Record<string, string>, tries = 30, delayMs = 3000): Promise<{ status: string; error?: string }> {
  for (let i = 0; i < tries; i++) {
    const s = await call('GET', `${TH_GRAPH()}/${id}`, { fields: 'status,error_message', access_token: sec.token }, sec);
    if (['FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(s.status)) return { status: s.status, error: s.error_message };
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { status: 'IN_PROGRESS' };
}

/**
 * Test: Profil und Rechte lesen, Kontingent prüfen und einen Text-Container anlegen und verarbeiten lassen – ohne zu
 * veröffentlichen (unveröffentlichte Container verfallen nach 24 Stunden).
 */
export async function testThreads(c: Connection, sec: Record<string, string>) {
  const steps: TestStep[] = [];
  const account: any = {};
  const caps: any = { text: false, image: false, link: false, video: false };
  if (!sec.token) return { steps: [{ name: 'Profil verbunden', ok: false, message: 'Noch nicht mit Threads verbunden.', kind: 'login' as const }], account, capabilities: caps };
  let userId = String(c.config.userId ?? '');
  try {
    const me = await call('GET', `${TH_GRAPH()}/me`, { fields: 'id,username,name', access_token: sec.token }, sec);
    userId = String(me.id ?? userId);
    account.id = userId;
    account.username = me.username;
    if (me.name) account.name = me.name;
    steps.push({ name: 'Anmeldung und Profil', ok: true, message: `@${me.username} erreichbar. (Anmeldung allein ist kein Veröffentlichungstest.)`, kind: 'login' });
  } catch (e: any) {
    steps.push({ name: 'Anmeldung und Profil', ok: false, message: e.message, kind: 'login' });
    return { steps, account, capabilities: caps };
  }
  try {
    const lim = await call('GET', `${TH_GRAPH()}/${userId}/threads_publishing_limit`, { fields: 'quota_usage,config', access_token: sec.token }, sec);
    const d = lim.data?.[0] ?? {};
    account.quota = { used: d.quota_usage ?? null, total: d.config?.quota_total ?? null };
    steps.push({ name: 'Veröffentlichungskontingent', ok: true, message: `Heute genutzt: ${d.quota_usage ?? '?'} von ${d.config?.quota_total ?? '?'}`, kind: 'read' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungskontingent', ok: false, message: e.message, kind: 'read' });
  }
  try {
    const cont = await call('POST', `${TH_GRAPH()}/${userId}/threads`, { media_type: 'TEXT', text: 'BlaulichtCMS-Verbindungstest (wird nicht veröffentlicht)', access_token: sec.token }, sec);
    const st = await waitContainer(cont.id, sec, 6, 2000);
    const ok = st.status === 'FINISHED';
    if (ok) Object.assign(caps, { text: true, image: true, link: true, video: true });
    steps.push({ name: 'Veröffentlichungstest', ok, message: ok ? 'Text-Container verarbeitet (nicht veröffentlicht) – Beiträge mit Text, Bild, Video und Link sind möglich.' : `Container-Status: ${st.status}${st.error ? ` (${st.error})` : ''}.`, kind: 'publish' });
  } catch (e: any) {
    steps.push({ name: 'Veröffentlichungstest', ok: false, message: `Container konnte nicht angelegt werden: ${e.message}`, kind: 'publish' });
  }
  return { steps, account, capabilities: caps, userId };
}

/* ------------------------------------------------------------------ Veröffentlichen */

/**
 * Text, Bild(er), Video oder Text mit Link-Vorschau. Ohne Medien hängt BlaulichtCMS den Link zur Website als
 * Link-Anhang an (nur bei Textbeiträgen möglich); mit Medien steht er im Text.
 */
export async function publishThreads(c: Connection, sec: Record<string, string>, { sp, rev, media }: { sp: any; rev: any; media: any[] }, onContainer: (id: string | null) => Promise<void>) {
  const user = c.config.userId;
  const text = socialText(rev, 'threads', sp.link);
  const items = media.filter((m) => publicFileFor(m)).slice(0, 20);
  let container = sp.container_id as string | null;
  if (container) {
    const st = await waitContainer(container, sec).catch(() => ({ status: 'EXPIRED' }));
    if (st.status === 'PUBLISHED') {
      const found = await findExistingThreads(c, sec, sp.marker, new Date(sp.created_at));
      if (found) return found;
      throw new StepError('timeout_unknown', 'Threads meldet den Container als veröffentlicht, der Beitrag wurde aber noch nicht gefunden – bitte später erneut prüfen.', { sideEffectUnknown: true });
    }
    if (st.status !== 'FINISHED') {
      container = null;
      await onContainer(null);
    }
  }
  if (!container) {
    const mk = async (m: any, child: boolean) => {
      const p = m.kind === 'video' ? { media_type: 'VIDEO', video_url: await mediaUrl(m.id) } : { media_type: 'IMAGE', image_url: await mediaUrl(m.id) };
      return (await call('POST', `${TH_GRAPH()}/${user}/threads`, { ...p, ...(child ? { is_carousel_item: 'true' } : { text }), access_token: sec.token }, sec)).id as string;
    };
    if (!items.length) {
      container = (await call('POST', `${TH_GRAPH()}/${user}/threads`, { media_type: 'TEXT', text, link_attachment: sp.link || undefined, access_token: sec.token }, sec)).id;
    } else if (items.length === 1) {
      container = await mk(items[0], false);
    } else {
      const children: string[] = [];
      for (const m of items) {
        const id = await mk(m, true);
        const st = await waitContainer(id, sec);
        if (st.status !== 'FINISHED') throw new StepError('invalid_payload', `Threads konnte eine Datei nicht verarbeiten (Status ${st.status}${st.error ? `: ${st.error}` : ''}).`);
        children.push(id);
      }
      container = (await call('POST', `${TH_GRAPH()}/${user}/threads`, { media_type: 'CAROUSEL', children: children.join(','), text, access_token: sec.token }, sec)).id;
    }
    await onContainer(container!);
  }
  const st = await waitContainer(container!, sec);
  if (st.status !== 'FINISHED') {
    if (st.status === 'ERROR' || st.status === 'EXPIRED') await onContainer(null);
    throw new StepError('invalid_payload', `Threads-Container nicht bereit (Status ${st.status}${st.error ? `: ${st.error}` : ''}).`);
  }
  const pub = await call('POST', `${TH_GRAPH()}/${user}/threads_publish`, { creation_id: container!, access_token: sec.token }, sec);
  const info = await call('GET', `${TH_GRAPH()}/${pub.id}`, { fields: 'permalink', access_token: sec.token }, sec).catch(() => ({}));
  return { id: String(pub.id), url: (info as any).permalink ?? null };
}

export async function findExistingThreads(c: Connection, sec: Record<string, string>, marker: string, since: Date) {
  const r = await call('GET', `${TH_GRAPH()}/${c.config.userId}/threads`, { fields: 'id,text,timestamp,permalink', limit: '25', access_token: sec.token }, sec);
  for (const p of r.data ?? []) if (p.text && markerFor(p.text) === marker && new Date(p.timestamp ?? 0).getTime() >= since.getTime() - 120_000) return { id: String(p.id), url: p.permalink ?? null };
  return null;
}

export function checkThreadsFormats(media: any[], tooLong: boolean): string[] {
  const issues: string[] = [];
  if (media.length > 20) issues.push('Threads: höchstens 20 Dateien je Beitrag (Karussell) – weitere werden nicht übertragen.');
  if (media.some((m) => m.kind === 'video' && m.mime === 'video/webm')) issues.push('Threads: WebM-Videos werden nicht unterstützt (MP4 oder MOV).');
  if (tooLong) issues.push(`Threads: Text auf ${THREADS_MAX} Zeichen gekürzt – ein eigener, kürzerer Text für Threads ist besser.`);
  return issues;
}
