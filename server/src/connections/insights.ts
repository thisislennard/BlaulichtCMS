import { many, pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { connectionSecrets, scrub, type Connection } from './common.js';
import { facebookMetrics, instagramMetrics } from './meta.js';
import { threadsMetrics } from './threads.js';
import { xMetrics } from './x.js';
import { mastodonMetrics } from './mastodon.js';
import { blueskyMetrics } from './bluesky.js';

/**
 * Reichweite der Social-Posts (#218): Der Worker ruft die Zahlen veröffentlichter Beiträge über die offiziellen
 * Statistik-Schnittstellen ab – nach 1 Stunde, nach 24 Stunden und nach 7 Tagen, danach nicht mehr.
 *
 * Gespeichert werden nur zusammengefasste Zahlen je Beitrag (Aufrufe, Reichweite, Gefällt mir, Antworten, Reposts,
 * Zitate, geteilt, gespeichert, Klicks) – nie, WER reagiert hat. Nicht abgefragt werden: Storys (verschwinden nach
 * 24 Stunden), von Hand geteilte Beiträge (keine Schnittstelle), entfernte Beiträge, Kanäle mit ausgeschaltetem
 * Abruf und X ohne ausdrückliches Einschalten (jeder Abruf kostet dort Guthaben).
 */
export const METRIC_KEYS = ['views', 'reach', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'saves', 'clicks'] as const;
export type Metrics = Partial<Record<(typeof METRIC_KEYS)[number], number | null>>;

/** Abrufzeitpunkte nach der Veröffentlichung (Stufe 1, 2, 3). */
export const STAGES_MS = [60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000];
/** Höchstens so viele Beiträge je Lauf und Kanal (Grenzen der Schnittstellen schonen). */
const PER_CONNECTION = 25;
const PER_RUN = 150;

/** Ist der Abruf für diesen Kanal eingeschaltet? X nur ausdrücklich (kostenpflichtig), alle anderen standardmäßig. */
export function insightsEnabled(c: Pick<Connection, 'kind' | 'config'>): boolean {
  if (c.kind === 'x') return c.config?.mode === 'api' && c.config?.insights === true;
  if (c.kind === 'whatsapp') return false;
  return c.config?.insights !== false;
}

/** Erreichte Stufe für einen Veröffentlichungszeitpunkt (0 = noch keine). */
export function stageFor(publishedAt: Date, now = Date.now()): number {
  const age = now - publishedAt.getTime();
  return STAGES_MS.filter((ms) => age >= ms).length;
}

/** Summe der Interaktionen (ohne Aufrufe/Reichweite/Klicks). */
export function interactions(m: Metrics | null | undefined): number {
  if (!m) return 0;
  return ['likes', 'replies', 'reposts', 'quotes', 'shares', 'saves'].reduce((a, k) => a + (Number((m as any)[k]) || 0), 0);
}

/** Nur bekannte Kennzahlen, nur Zahlen ≥ 0 – alles andere fällt weg. */
export function cleanMetrics(m: Record<string, unknown>): Metrics {
  const out: Metrics = {};
  for (const k of METRIC_KEYS) {
    const v = m[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v);
  }
  return out;
}

let running = false;

/** Fällige Abrufe ausführen (vom Worker alle 15 Minuten angestoßen; läuft nie doppelt). */
export async function runDueInsights(now = Date.now()): Promise<{ fetched: number; failed: number }> {
  if (running) return { fetched: 0, failed: 0 };
  running = true;
  let fetched = 0;
  let failed = 0;
  try {
    const due = await many<any>(
      `SELECT sp.id, sp.remote_id, sp.published_at, sp.insights_stage, sp.connection_id
         FROM social_publications sp JOIN connections c ON c.id = sp.connection_id
        WHERE sp.status = 'published' AND sp.insights_stage < 3 AND sp.format = 'feed' AND sp.shared_at IS NULL AND sp.remote_id IS NOT NULL
          AND sp.removal_status IS DISTINCT FROM 'removed' AND sp.published_at IS NOT NULL
          AND sp.published_at <= now() - make_interval(secs => $1::float8)
          AND c.deleted_at IS NULL AND c.status IN ('active','disabled')
          AND ((sp.insights_stage = 0) OR (sp.insights_stage = 1 AND sp.published_at <= now() - make_interval(secs => $2::float8)) OR (sp.insights_stage = 2 AND sp.published_at <= now() - make_interval(secs => $3::float8)))
        ORDER BY sp.published_at LIMIT ${PER_RUN}`,
      STAGES_MS.map((ms) => ms / 1000),
    );
    const byConn = new Map<string, any[]>();
    for (const r of due) byConn.set(r.connection_id, [...(byConn.get(r.connection_id) ?? []), r].slice(0, PER_CONNECTION));
    for (const [cid, rows] of byConn) {
      const c = (await pool.query(`SELECT * FROM connections WHERE id = $1`, [cid])).rows[0] as Connection;
      const stageOf = (r: any) => Math.max(r.insights_stage + 1, stageFor(new Date(r.published_at), now));
      if (!c || !insightsEnabled(c)) {
        // Abruf ausgeschaltet: Stufe trotzdem weiterzählen, damit nichts nachträglich auf einmal abgefragt wird
        for (const r of rows) await pool.query(`UPDATE social_publications SET insights_stage = $2 WHERE id = $1`, [r.id, stageOf(r)]);
        continue;
      }
      let sec: Record<string, string> = {};
      try {
        sec = await connectionSecrets(c);
        const results = await fetchFor(c, sec, rows.map((r) => String(r.remote_id)));
        for (const r of rows) {
          const res = results.get(String(r.remote_id));
          const stage = stageOf(r);
          if (res && 'error' in res) {
            failed++;
            await pool.query(`UPDATE social_publications SET insights_stage = $2, insights_error = $3, insights_at = now() WHERE id = $1`, [r.id, stage, scrub(String(res.error), sec).slice(0, 300)]);
            continue;
          }
          const m = cleanMetrics(res ?? {});
          await pool.query(`INSERT INTO social_insights (publication_id, stage, metrics) VALUES ($1,$2,$3)`, [r.id, stage, JSON.stringify(m)]);
          await pool.query(`UPDATE social_publications SET insights_stage = $2, insights = $3, insights_at = now(), insights_error = NULL WHERE id = $1`, [r.id, stage, JSON.stringify(m)]);
          fetched++;
        }
      } catch (e: any) {
        failed += rows.length;
        const msg = scrub(String(e?.message ?? e), sec).slice(0, 300);
        log('warn', 'insights', `${c.name}: Reichweite nicht abrufbar – ${msg}`);
        // Zeitweise Störung (Netz, 429, 5xx): Stufe bleibt, nächster Lauf versucht es erneut – höchstens bis zur nächsten Stufe
        const transient = ['transient', 'rate_limit', 'timeout_unknown'].includes(e?.errorClass);
        for (const r of rows) {
          const late = stageFor(new Date(r.published_at), now) > r.insights_stage + 1;
          await pool.query(`UPDATE social_publications SET insights_stage = CASE WHEN $3 THEN insights_stage ELSE $2 END, insights_error = $4, insights_at = now() WHERE id = $1`, [r.id, stageOf(r), transient && !late, msg]);
        }
      }
    }
  } finally {
    running = false;
  }
  return { fetched, failed };
}

type Result = Record<string, number | null> | { error: string };

/** Zahlen je Beitrag eines Kanals; Fehler je Beitrag werden einzeln gemeldet, Fehler des Kanals geworfen. */
async function fetchFor(c: Connection, sec: Record<string, string>, ids: string[]): Promise<Map<string, Result>> {
  const out = new Map<string, Result>();
  if (c.kind === 'bluesky') {
    const r = await blueskyMetrics(ids);
    for (const id of ids) out.set(id, r.get(id) ?? { error: 'Beitrag bei Bluesky nicht gefunden (gelöscht?).' });
    return out;
  }
  if (c.kind === 'x') {
    const r = await xMetrics(sec, ids);
    for (const id of ids) out.set(id, r.get(id) ?? { error: 'Beitrag bei X nicht gefunden (gelöscht?).' });
    return out;
  }
  for (const id of ids) {
    try {
      const m =
        c.kind === 'facebook' ? await facebookMetrics(sec, id)
        : c.kind === 'instagram' ? await instagramMetrics(sec, id)
        : c.kind === 'threads' ? await threadsMetrics(sec, id)
        : c.kind === 'mastodon' ? await mastodonMetrics(c, sec, id)
        : null;
      out.set(id, m ?? { error: 'Für dieses Netzwerk gibt es keine Statistik-Schnittstelle.' });
    } catch (e: any) {
      // Anmeldung abgelaufen, Kontingent oder Störung betreffen den ganzen Kanal
      if (['auth', 'transient', 'rate_limit'].includes(e?.errorClass)) throw e;
      out.set(id, { error: e?.errorClass === 'permission' ? `Recht für die Statistik fehlt (${e.message}). Verbindung erneut verbinden und testen.` : String(e?.message ?? e) });
    }
  }
  return out;
}
