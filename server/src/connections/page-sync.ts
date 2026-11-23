import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { httpRequest } from '../lib/http.js';
import { log } from '../lib/log.js';
import { stripControlChars } from '../lib/text.js';
import { markerFor } from './channels.js';
import { connectionSecrets, scrub, type Connection } from './common.js';
import { cleanMetrics } from './insights.js';
import { dayKey, facebookMetrics, facebookPagePosts, facebookPageStats, instagramAccountStats, instagramMediaList, instagramMetrics, privateHosts, type PagePost, type PageStats } from './meta.js';

/**
 * Seitenabgleich: BlaulichtCMS liest alle Beiträge der verbundenen Facebook-Seite bzw. des Instagram-Kontos – auch die
 * direkt auf der Plattform erstellten – samt Vorschaubild und Zahlen, dazu einmal am Tag die Kennzahlen der Seite
 * (Follower, Aufrufe, Reichweite, Interaktionen). Daraus entstehen die Seitenstatistik, die Reichweite „alle
 * Seitenbeiträge“ und der freigegebene Social-Feed (RSS, Website-Widget).
 *
 * Gespeichert werden nur Inhalte der eigenen Seite und zusammengefasste Zahlen – nie, wer reagiert oder kommentiert hat.
 * Vorschaubilder liegen lokal (WebP), damit RSS-Leser und Website-Besucher keine Verbindung zu Meta aufbauen.
 */
export const PAGE_SYNC_KINDS = ['facebook', 'instagram'] as const;
/** Beim ersten Abgleich so weit zurück, danach nur das letzte Stück (Änderungen und Löschungen erkennen). */
const FIRST_DAYS = 90;
const REFRESH_DAYS = 14;
/** Zahlen je Beitrag: bis 30 Tage nach dem Erscheinen, in den ersten 2 Tagen alle 6 Stunden, danach täglich. */
const METRICS_DAYS = 30;
const METRICS_PER_RUN = 40;
/** Kennzahlen der Seite: beim ersten Mal rückwirkend (Facebook liefert bis zu 90 Tage, Instagram je Tag eine Abfrage). */
const FB_STATS_BACKFILL_DAYS = 28;
const IG_STATS_BACKFILL_DAYS = 7;
/** Auf der Seite entfernte Beiträge samt Bild nach so vielen Tagen löschen. */
const REMOVED_KEEP_DAYS = 30;

export const socialImageDir = () => path.join(config.dataDir, 'social');

/** Ist der Abgleich für diese Verbindung eingeschaltet? (Standard: an.) */
export function pageSyncEnabled(c: Pick<Connection, 'kind' | 'config'>): boolean {
  return (PAGE_SYNC_KINDS as readonly string[]).includes(c.kind) && c.config?.pageSync !== false;
}

/** Text eines Beitrags aufbereiten: Steuerzeichen weg, Länge begrenzt. */
export function cleanMessage(s: string): string {
  return stripControlChars(String(s ?? '')).replace(/\r\n?/g, '\n').trim().slice(0, 5000);
}

/** Vorschaubild laden und als WebP (höchstens 1080 px) ablegen. Rückgabe: Dateiname samt Maße oder null. */
async function storeImage(id: string, url: string): Promise<{ file: string; width: number; height: number } | null> {
  // Bilder von Meta kommen über HTTPS; nur ein per Umgebungsvariable gesetzter Testdienst darf http und privat sein
  const test = privateHosts();
  const host = new URL(url).hostname;
  if (!/^https:\/\//i.test(url) && !test.includes(host)) return null;
  const res = await httpRequest({ method: 'GET', url, timeoutMs: 30_000, maxResponseBytes: 25 * 1024 * 1024, maxRedirects: 3, allowPrivateHosts: test });
  if (res.status >= 400) throw new Error(`Bild nicht ladbar (HTTP ${res.status}).`);
  const out = await sharp(res.body, { limitInputPixels: 100_000_000 }).rotate().resize({ width: 1080, height: 1080, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  fs.mkdirSync(socialImageDir(), { recursive: true });
  const file = `${id}.webp`;
  const tmp = path.join(socialImageDir(), `${file}.tmp`);
  fs.writeFileSync(tmp, out.data);
  fs.renameSync(tmp, path.join(socialImageDir(), file));
  return { file, width: out.info.width, height: out.info.height };
}

function removeImage(file: string | null) {
  if (!file || !/^[0-9a-f-]{36}\.webp$/.test(file)) return;
  fs.rmSync(path.join(socialImageDir(), file), { force: true });
}

/** Beiträge speichern bzw. aktualisieren; Rückgabe: Anzahl neuer Beiträge. */
export async function storePagePosts(c: Connection, posts: PagePost[], since: Date, complete: boolean): Promise<number> {
  let added = 0;
  const seen: string[] = [];
  for (const p of posts) {
    seen.push(p.remoteId);
    const message = cleanMessage(p.message);
    // Aus BlaulichtCMS veröffentlicht? (gleiche ID oder gleicher Text wie die Veröffentlichung)
    const pub = await one<{ id: string }>(
      `SELECT id FROM social_publications WHERE connection_id = $1 AND status = 'published' AND (remote_id = $2 OR (marker = $3 AND $4)) ORDER BY published_at DESC NULLS LAST LIMIT 1`,
      [c.id, p.remoteId, markerFor(message, c.kind), message.length > 0],
    );
    const row = await one<any>(
      `INSERT INTO social_page_posts (connection_id, kind, remote_id, publication_id, posted_at, message, permalink, media_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (connection_id, remote_id) DO UPDATE SET publication_id = COALESCE(EXCLUDED.publication_id, social_page_posts.publication_id),
         message = EXCLUDED.message, permalink = EXCLUDED.permalink, media_type = EXCLUDED.media_type, last_seen_at = now(), removed_at = NULL
       RETURNING id, image_file, image_source, (xmax = 0) AS inserted`,
      [c.id, c.kind, p.remoteId, pub?.id ?? null, p.postedAt, message, p.permalink?.startsWith('https://') ? p.permalink.slice(0, 1000) : null, p.mediaType?.slice(0, 40) ?? null],
    );
    if (row.inserted) added++;
    // Bildadressen von Meta sind signiert und ändern sich bei jedem Abruf – neu laden nur, wenn noch keins da ist (oder die
    // Datei fehlt, z. B. nach dem Zurückspielen einer Sicherung, die nur die Datenbank enthält)
    if (p.imageUrl && (!row.image_file || !fs.existsSync(path.join(socialImageDir(), row.image_file)))) {
      try {
        const img = await storeImage(row.id, p.imageUrl);
        if (img) await pool.query(`UPDATE social_page_posts SET image_file = $2, image_width = $3, image_height = $4, image_source = $5 WHERE id = $1`, [row.id, img.file, img.width, img.height, new URL(p.imageUrl).host]);
      } catch (e: any) {
        log('warn', 'page-sync', `${c.name}: Vorschaubild nicht übernommen – ${String(e?.message ?? e).slice(0, 200)}`);
      }
    } else if (!p.imageUrl && row.image_file) {
      removeImage(row.image_file);
      await pool.query(`UPDATE social_page_posts SET image_file = NULL, image_width = NULL, image_height = NULL, image_source = NULL WHERE id = $1`, [row.id]);
    }
  }
  // Vollständige Liste des Zeitraums: was darin fehlt, gibt es auf der Seite nicht mehr
  if (complete) {
    await pool.query(`UPDATE social_page_posts SET removed_at = now() WHERE connection_id = $1 AND posted_at >= $2 AND removed_at IS NULL AND NOT (remote_id = ANY($3))`, [c.id, since, seen]);
  }
  return added;
}

/** Zahlen der Seitenbeiträge, die nicht aus BlaulichtCMS stammen (die haben eigene Abrufe nach 1 h, 24 h, 7 Tagen). */
async function refreshPostMetrics(c: Connection, sec: Record<string, string>): Promise<void> {
  const due = await many<any>(
    `SELECT id, remote_id FROM social_page_posts
      WHERE connection_id = $1 AND publication_id IS NULL AND removed_at IS NULL AND posted_at >= now() - make_interval(days => $2)
        AND (metrics_at IS NULL OR (posted_at >= now() - interval '2 days' AND metrics_at < now() - interval '6 hours') OR metrics_at < now() - interval '1 day')
      ORDER BY metrics_at NULLS FIRST, posted_at DESC LIMIT $3`,
    [c.id, METRICS_DAYS, METRICS_PER_RUN],
  );
  for (const r of due) {
    try {
      const m = c.kind === 'facebook' ? await facebookMetrics(sec, r.remote_id) : await instagramMetrics(sec, r.remote_id);
      await pool.query(`UPDATE social_page_posts SET metrics = $2, metrics_at = now(), metrics_error = NULL WHERE id = $1`, [r.id, JSON.stringify(cleanMetrics(m))]);
    } catch (e: any) {
      if (['auth', 'transient', 'rate_limit'].includes(e?.errorClass)) throw e;
      await pool.query(`UPDATE social_page_posts SET metrics_at = now(), metrics_error = $2 WHERE id = $1`, [r.id, scrub(String(e?.message ?? e), sec).slice(0, 300)]);
    }
  }
}

/** Kennzahlen je Tag zusammenführen (vorhandene Werte eines Tages bleiben, neue ergänzen bzw. ersetzen sie). */
export async function storePageStats(connectionId: string, stats: PageStats, today: string): Promise<void> {
  const days = { ...stats.days };
  if (Object.keys(stats.current).length) days[today] = { ...(days[today] ?? {}), ...stats.current };
  for (const [day, m] of Object.entries(days)) {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) clean[k] = Math.round(v);
    if (!Object.keys(clean).length) continue;
    await pool.query(
      `INSERT INTO social_page_stats (connection_id, day, metrics) VALUES ($1,$2,$3)
       ON CONFLICT (connection_id, day) DO UPDATE SET metrics = social_page_stats.metrics || EXCLUDED.metrics, fetched_at = now()`,
      [connectionId, day, JSON.stringify(clean)],
    );
  }
}

/** Kennzahlen der Seite abrufen, höchstens einmal je Tag. */
async function refreshPageStats(c: Connection, sec: Record<string, string>, lastDay: string | null, now: Date): Promise<string[]> {
  const today = dayKey(now);
  if (lastDay === today) return [];
  const DAY = 86_400_000;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (c.kind === 'facebook') {
    // Die letzten Tage immer erneut (Meta trägt Werte nach), beim ersten Mal rückwirkend
    const back = lastDay ? 3 : FB_STATS_BACKFILL_DAYS;
    const stats = await facebookPageStats(c, sec, new Date(midnight - back * DAY), new Date(midnight));
    await storePageStats(c.id, stats, today);
    return stats.missing;
  }
  const back = lastDay ? 3 : IG_STATS_BACKFILL_DAYS;
  const list = Array.from({ length: back }, (_, i) => new Date(midnight - (i + 1) * DAY));
  const stats = await instagramAccountStats(c, sec, list);
  await storePageStats(c.id, stats, today);
  return stats.missing;
}

/** Eine Verbindung abgleichen. */
export async function syncConnection(c: Connection, now = new Date()): Promise<{ added: number; missing: string[] }> {
  const state = await one<any>(`SELECT posts_at, stats_day::text AS stats_day FROM social_page_sync WHERE connection_id = $1`, [c.id]);
  let sec: Record<string, string> = {};
  try {
    sec = await connectionSecrets(c);
    const first = !state?.posts_at;
    const since = new Date(now.getTime() - (first ? FIRST_DAYS : REFRESH_DAYS) * 86_400_000);
    const max = first ? 300 : 100;
    const posts = c.kind === 'facebook' ? await facebookPagePosts(c, sec, since, max) : await instagramMediaList(c, sec, since, max);
    const added = await storePagePosts(c, posts, since, posts.length < max);
    await refreshPostMetrics(c, sec);
    const missing = await refreshPageStats(c, sec, state?.stats_day ?? null, now);
    await pool.query(
      `INSERT INTO social_page_sync (connection_id, posts_at, stats_day, ok, message, at) VALUES ($1, $2, $3, true, $4, now())
       ON CONFLICT (connection_id) DO UPDATE SET posts_at = EXCLUDED.posts_at, stats_day = EXCLUDED.stats_day, ok = true, message = EXCLUDED.message, at = now()`,
      [c.id, now, dayKey(now), missing.length ? `Nicht geliefert: ${missing.join(', ')}` : null],
    );
    return { added, missing };
  } catch (e: any) {
    const msg = scrub(String(e?.message ?? e), sec).slice(0, 300);
    await pool.query(
      `INSERT INTO social_page_sync (connection_id, ok, message, at) VALUES ($1, false, $2, now())
       ON CONFLICT (connection_id) DO UPDATE SET ok = false, message = EXCLUDED.message, at = now()`,
      [c.id, msg],
    );
    throw Object.assign(new Error(msg), { errorClass: e?.errorClass });
  }
}

/** Alte, auf der Seite entfernte Beiträge samt Bild löschen; verwaiste Bilddateien aufräumen. */
export async function cleanupPagePosts(): Promise<void> {
  const gone = await many<{ image_file: string | null }>(
    `DELETE FROM social_page_posts WHERE removed_at < now() - make_interval(days => $1) RETURNING image_file`,
    [REMOVED_KEEP_DAYS],
  );
  for (const g of gone) removeImage(g.image_file);
  const dir = socialImageDir();
  if (!fs.existsSync(dir)) return;
  const known = new Set((await many<{ image_file: string }>(`SELECT image_file FROM social_page_posts WHERE image_file IS NOT NULL`)).map((r) => r.image_file));
  for (const f of fs.readdirSync(dir)) {
    if (known.has(f)) continue;
    // Halb geschriebene Dateien eines laufenden Abgleichs nicht anfassen
    const st = fs.statSync(path.join(dir, f));
    if (Date.now() - st.mtimeMs > 60 * 60_000) fs.rmSync(path.join(dir, f), { force: true });
  }
}

let running = false;

/** Alle eingeschalteten Verbindungen abgleichen (vom Worker stündlich angestoßen; läuft nie doppelt). */
export async function runPageSync(now = new Date()): Promise<{ synced: number; failed: number }> {
  if (running) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    const list = await many<Connection>(`SELECT * FROM connections WHERE kind = ANY($1) AND deleted_at IS NULL AND status = 'active'`, [PAGE_SYNC_KINDS]);
    for (const c of list) {
      if (!pageSyncEnabled(c)) continue;
      try {
        await syncConnection(c, now);
        synced++;
      } catch (e: any) {
        failed++;
        log('warn', 'page-sync', `${c.name}: Seitenabgleich fehlgeschlagen – ${e.message}`);
      }
    }
    await cleanupPagePosts().catch((e) => log('warn', 'page-sync', `Aufräumen: ${e.message}`));
  } finally {
    running = false;
  }
  return { synced, failed };
}
