import crypto from 'node:crypto';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { AppError, StepError } from '../lib/errors.js';
import { httpRequest } from '../lib/http.js';
import { log } from '../lib/log.js';
import { readSecret, revokeSecret, storeSecret } from '../lib/secrets.js';
import { getSettings } from '../lib/settings.js';
import { formatRrule } from './recurrence.js';
import { IcalError, parseIcal, type IcalEvent, type ParsedCalendar } from './ical.js';
import { calendarTimeZone, computeUntil } from './store.js';

/**
 * iCal-Quellen (#202): externe Kalender (Outlook, Google, Wehr-Kalender) regelmäßig einlesen. Abruf nur über den
 * geschützten HTTP-Client (SSRF-Schutz, interne Ziele nur nach Freigabe unter Einstellungen → Sicherheit, Größen- und
 * Zeitlimit, Weiterleitungen geprüft). Die Adresse kann einen Zugangstoken enthalten und liegt deshalb nur verschlüsselt
 * in `secrets`. Eingelesene Termine sind schreibgeschützt; Änderungen und gelöschte Termine der Quelle werden bei jedem
 * Abruf übernommen.
 */

export const MAX_ICS_BYTES = 3 * 1024 * 1024;
export const ICS_TIMEOUT_MS = 15_000;

export interface SyncResult {
  events: number;
  added: number;
  changed: number;
  removed: number;
  notModified: boolean;
  warnings: string[];
  name: string | null;
}

/** webcal:// (Apple, Outlook) ist https://; andere Schemata sind nicht erlaubt. */
export function normalizeIcalUrl(raw: string): string {
  const s = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new AppError(400, 'invalid_url', 'Keine gültige Adresse.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AppError(400, 'invalid_url', 'Nur http(s)- und webcal-Adressen sind erlaubt.');
  if (u.username || u.password) throw new AppError(400, 'invalid_url', 'Zugangsdaten in der Adresse (benutzer:passwort@) sind nicht erlaubt. Geheime Kalender-Links mit Token im Pfad oder in den Parametern sind dagegen möglich.');
  return u.toString();
}

/** Kalenderdatei abrufen und lesen. Fehler als verständliche AppError (ohne aufgelöste IP-Adressen). */
export async function fetchCalendar(url: string, cache: { etag?: string | null; lastModified?: string | null } = {}): Promise<{ notModified: true; status: number } | { notModified: false; status: number; cal: ParsedCalendar; etag: string | null; lastModified: string | null; bytes: number }> {
  const s = await getSettings();
  const tz = await calendarTimeZone();
  const headers: Record<string, string> = { accept: 'text/calendar, application/ics;q=0.9, */*;q=0.5', 'user-agent': 'BlaulichtCMS-Kalender/1.0' };
  if (cache.etag) headers['if-none-match'] = cache.etag;
  if (cache.lastModified) headers['if-modified-since'] = cache.lastModified;
  let res;
  try {
    res = await httpRequest({ method: 'GET', url, headers, timeoutMs: ICS_TIMEOUT_MS, maxResponseBytes: MAX_ICS_BYTES, maxRedirects: 3, allowPrivateHosts: ((s as any)['security.allowed_private_hosts'] ?? []) as string[] });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (e instanceof StepError && e.errorClass === 'invalid_payload') throw new AppError(400, 'ics_too_large', `Die Kalenderdatei ist größer als ${MAX_ICS_BYTES / 1024 / 1024} MB.`);
    if (/intern|privat|gesperrt/i.test(msg)) throw new AppError(400, 'ics_blocked', 'Die Adresse zeigt auf ein internes Netz und ist gesperrt. Interne Adressen gibt die Administration unter Einstellungen → Sicherheit frei.');
    if (/Zeitüberschreitung|timeout/i.test(msg)) throw new AppError(504, 'ics_timeout', 'Der Kalender antwortet nicht rechtzeitig.');
    if (/aufgelöst|ENOTFOUND|EAI_AGAIN/i.test(msg)) throw new AppError(502, 'ics_dns', 'Die Adresse ist nicht auffindbar (Name unbekannt). Bitte die Schreibweise prüfen.');
    if (/Weiterleitung|Protokoll|TLS/i.test(msg)) throw new AppError(400, 'ics_config', msg);
    throw new AppError(502, 'ics_unreachable', 'Der Kalender ist nicht erreichbar.');
  }
  if (res.status === 304) return { notModified: true, status: 304 };
  if (res.status === 401 || res.status === 403) throw new AppError(502, 'ics_http', `Der Kalender verweigert den Zugriff (HTTP ${res.status}). Ist der Link noch gültig bzw. öffentlich freigegeben?`);
  if (res.status === 404) throw new AppError(502, 'ics_http', 'Den Kalender gibt es unter dieser Adresse nicht (HTTP 404).');
  if (res.status >= 400) throw new AppError(502, 'ics_http', `Der Kalender antwortet mit HTTP ${res.status}.`);
  let cal: ParsedCalendar;
  try {
    cal = parseIcal(res.text(), tz);
  } catch (e) {
    if (e instanceof IcalError) throw new AppError(400, 'ics_invalid', e.message);
    throw e;
  }
  return { notModified: false, status: res.status, cal, etag: res.headers['etag'] || null, lastModified: res.headers['last-modified'] || null, bytes: res.body.length };
}

interface Row {
  title: string;
  description: string;
  location: string;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  tz: string;
  rrule: string | null;
  exdates: Date[];
  until_at: Date | null;
  tags: string[];
}

const fingerprint = (r: Row) => JSON.stringify([r.title, r.description, r.location, +r.starts_at, +r.ends_at, r.all_day, r.tz, r.rrule, r.exdates.map(Number).sort(), r.tags]);

function toRow(e: IcalEvent, extraEx: number[] = []): Row {
  const rrule = e.rruleParsed ? formatRrule(e.rruleParsed) : null;
  return {
    title: e.summary,
    description: e.description,
    location: e.location,
    starts_at: new Date(e.start),
    ends_at: new Date(Math.max(e.end, e.start)),
    all_day: e.allDay,
    tz: e.tz,
    rrule,
    exdates: rrule ? [...new Set([...e.exdates, ...extraEx])].sort((a, b) => a - b).map((x) => new Date(x)) : [],
    until_at: rrule ? computeUntil({ starts_at: e.start, ends_at: e.end, all_day: e.allDay, tz: e.tz, rrule }) : null,
    tags: e.categories,
  };
}

/**
 * Termine einer Quelle mit dem Inhalt der Datei abgleichen (in einer Transaktion – `db` muss ein Client innerhalb von
 * `tx()` sein): neue anlegen, geänderte aktualisieren, nicht mehr enthaltene löschen. Abgesagte Einzeltermine
 * (STATUS:CANCELLED mit RECURRENCE-ID) werden zu Ausnahmen der Serie, abgesagte Einzeltermine ohne Serie entfallen.
 *
 * Jeder Termin wird in einem eigenen Sicherungspunkt gespeichert: Scheitert ein einzelner Termin, bleibt sein
 * bisheriger Stand erhalten, er erscheint als Hinweis im Empfangsprotokoll und der Abgleich der übrigen Termine läuft
 * weiter (#237). Ein einziger fehlerhafter Eintrag in der Fremddatei blockiert so nie die ganze Quelle.
 */
export async function syncEvents(sourceId: string, cal: ParsedCalendar, categoryId: string | null, db: Queryable): Promise<Omit<SyncResult, 'notModified' | 'name'>> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('calendar_source:' || $1))`, [sourceId]);
  const warnings: string[] = [];
  /** Einen Termin für sich speichern; bei einem Fehler zurückrollen, melden und weitermachen. */
  const guarded = async <T>(title: string, fn: () => Promise<T>): Promise<T | undefined> => {
    await db.query('SAVEPOINT calendar_event');
    try {
      const r = await fn();
      await db.query('RELEASE SAVEPOINT calendar_event');
      return r;
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT calendar_event');
      await db.query('RELEASE SAVEPOINT calendar_event');
      warnings.push(`„${title.slice(0, 80)}“ konnte nicht gespeichert werden und wurde übersprungen.`);
      log('warn', 'calendar', `iCal-Quelle ${sourceId}: Termin übersprungen – ${(e as Error).message}`);
      return undefined;
    }
  };
  const existing = await many<any>(`SELECT * FROM calendar_events WHERE source = 'ical' AND source_id = $1`, [sourceId], db);
  const key = (uid: string, rid: Date | number | null) => `${uid}|${rid == null ? '' : +rid}`;
  const byKey = new Map(existing.map((r) => [key(r.uid, r.recurrence_id), r]));
  const seen = new Set<string>();
  let added = 0;
  let changed = 0;
  const masters = new Map<string, IcalEvent>();
  const overrides: IcalEvent[] = [];
  for (const e of cal.events) {
    if (e.recurrenceId == null) {
      // doppelte UID: die mit der höchsten SEQUENCE gewinnt
      const prev = masters.get(e.uid);
      if (!prev || e.sequence >= prev.sequence) masters.set(e.uid, e);
    } else overrides.push(e);
  }
  const upsert = async (k: string, uid: string, row: Row, link: { seriesId: string | null; recurrenceId: Date | null }) => {
    seen.add(k);
    const cur = byKey.get(k);
    if (!cur) {
      const r = await one<{ id: string }>(
        `INSERT INTO calendar_events (title, description, location, starts_at, ends_at, all_day, tz, category_id, tags, source, source_id, uid, rrule, exdates, until_at, series_id, recurrence_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ical',$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [row.title, row.description, row.location, row.starts_at, row.ends_at, row.all_day, row.tz, categoryId, row.tags, sourceId, uid, row.rrule, row.exdates, row.until_at, link.seriesId, link.recurrenceId],
        db,
      );
      added++;
      return r!.id;
    }
    const before: Row = { title: cur.title, description: cur.description, location: cur.location, starts_at: cur.starts_at, ends_at: cur.ends_at, all_day: cur.all_day, tz: cur.tz, rrule: cur.rrule, exdates: cur.exdates ?? [], until_at: cur.until_at, tags: cur.tags ?? [] };
    if (fingerprint(before) !== fingerprint(row) || cur.category_id !== categoryId || cur.series_id !== link.seriesId) {
      await db.query(
        `UPDATE calendar_events SET title=$2, description=$3, location=$4, starts_at=$5, ends_at=$6, all_day=$7, tz=$8, category_id=$9, tags=$10, rrule=$11, exdates=$12, until_at=$13, series_id=$14, updated_at=now() WHERE id = $1`,
        [cur.id, row.title, row.description, row.location, row.starts_at, row.ends_at, row.all_day, row.tz, categoryId, row.tags, row.rrule, row.exdates, row.until_at, link.seriesId],
      );
      changed++;
    }
    return cur.id as string;
  };

  const masterIds = new Map<string, string>();
  const failed = new Set<string>();
  for (const [uid, m] of masters) {
    if (m.cancelled) continue;
    const cancelled = overrides.filter((o) => o.uid === uid && o.cancelled).map((o) => o.recurrenceId!);
    const id = await guarded(m.summary, () => upsert(key(uid, null), uid, toRow(m, cancelled), { seriesId: null, recurrenceId: null }));
    if (id) masterIds.set(uid, id);
    else failed.add(uid);
  }
  for (const o of overrides) {
    if (o.cancelled) continue;
    const master = masters.get(o.uid);
    const masterId = masterIds.get(o.uid);
    if (master?.rruleParsed && failed.has(o.uid)) {
      // Serie nicht gespeichert: ihre geänderten Termine bleiben auf dem bisherigen Stand
      seen.add(key(o.uid, o.recurrenceId));
      continue;
    }
    if (master?.rruleParsed && masterId) {
      await guarded(o.summary, () => upsert(key(o.uid, o.recurrenceId), o.uid, toRow(o), { seriesId: masterId, recurrenceId: new Date(o.recurrenceId!) }));
    } else {
      // Geänderter Termin ohne (wiederkehrenden) Haupttermin: als eigener Termin
      const uid = `${o.uid}#${o.recurrenceId}`;
      await guarded(o.summary, () => upsert(key(uid, null), uid, toRow(o), { seriesId: null, recurrenceId: null }));
    }
  }
  // Nicht mehr enthaltene Termine löschen (geänderte Einzeltermine zuerst, Serien löschen ihre per CASCADE)
  const gone = existing.filter((r) => !seen.has(key(r.uid, r.recurrence_id)));
  if (gone.length) await db.query(`DELETE FROM calendar_events WHERE id = ANY($1)`, [gone.map((r) => r.id)]);
  return { events: masters.size + overrides.length, added, changed, removed: gone.length, warnings };
}

async function writeLog(sourceId: string, trigger: 'schedule' | 'manual' | 'test', entry: { ok: boolean; status?: number | null; notModified?: boolean; events?: number; added?: number; changed?: number; removed?: number; bytes?: number | null; durationMs: number; message?: string | null; warnings?: string[] }) {
  await pool.query(
    `INSERT INTO calendar_source_log (source_id, trigger, ok, http_status, not_modified, events, added, changed, removed, bytes, duration_ms, message, warnings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [sourceId, trigger, entry.ok, entry.status ?? null, !!entry.notModified, entry.events ?? 0, entry.added ?? 0, entry.changed ?? 0, entry.removed ?? 0, entry.bytes ?? null, entry.durationMs, entry.message?.slice(0, 500) ?? null, JSON.stringify((entry.warnings ?? []).slice(0, 20))],
  );
  // Protokoll je Quelle auf die letzten 200 Abrufe begrenzen
  await pool.query(`DELETE FROM calendar_source_log WHERE source_id = $1 AND id NOT IN (SELECT id FROM calendar_source_log WHERE source_id = $1 ORDER BY at DESC LIMIT 200)`, [sourceId]);
}

export async function sourceUrl(src: { url_secret_id: string }): Promise<string> {
  const url = await readSecret(src.url_secret_id);
  if (!url) throw new AppError(409, 'ics_no_url', 'Die Adresse der Quelle ist nicht mehr vorhanden. Bitte neu eintragen.');
  return url;
}

/** Eine Quelle abrufen und abgleichen; Ergebnis im Empfangsprotokoll. `force` ignoriert ETag/Last-Modified. */
export async function refreshSource(src: any, trigger: 'schedule' | 'manual' = 'schedule', force = false): Promise<SyncResult> {
  const started = Date.now();
  await pool.query('UPDATE calendar_sources SET last_fetch_at = now() WHERE id = $1', [src.id]);
  try {
    const r = await fetchCalendar(await sourceUrl(src), force ? {} : { etag: src.etag, lastModified: src.last_modified });
    if (r.notModified) {
      await pool.query('UPDATE calendar_sources SET last_success_at = now(), last_error = NULL WHERE id = $1', [src.id]);
      await writeLog(src.id, trigger, { ok: true, status: 304, notModified: true, events: src.last_count ?? 0, durationMs: Date.now() - started, message: 'Unverändert seit dem letzten Abruf.' });
      return { events: src.last_count ?? 0, added: 0, changed: 0, removed: 0, notModified: true, warnings: [], name: null };
    }
    const res = await tx((db) => syncEvents(src.id, r.cal, src.category_id, db));
    const warnings = [...r.cal.warnings, ...res.warnings];
    await pool.query('UPDATE calendar_sources SET last_success_at = now(), last_error = NULL, last_count = $2, etag = $3, last_modified = $4 WHERE id = $1', [src.id, res.events, r.etag, r.lastModified]);
    await writeLog(src.id, trigger, { ok: true, status: r.status, events: res.events, added: res.added, changed: res.changed, removed: res.removed, bytes: r.bytes, durationMs: Date.now() - started, warnings });
    return { ...res, notModified: false, warnings, name: r.cal.name };
  } catch (e) {
    const msg = (e as Error).message;
    await pool.query('UPDATE calendar_sources SET last_error = $2 WHERE id = $1', [src.id, msg.slice(0, 300)]);
    await writeLog(src.id, trigger, { ok: false, durationMs: Date.now() - started, message: msg });
    throw e;
  }
}

/** Fällige aktive Quellen abrufen (Worker, jede Minute geprüft). */
export async function refreshDueCalendarSources() {
  const due = await many<any>(`SELECT * FROM calendar_sources WHERE active AND (last_fetch_at IS NULL OR last_fetch_at < now() - make_interval(mins => interval_min)) ORDER BY last_fetch_at NULLS FIRST LIMIT 10`);
  for (const s of due) {
    await refreshSource(s).catch((e) => log('warn', 'calendar', `iCal-Quelle „${s.name}“: ${(e as Error).message}`));
  }
}

export async function storeSourceUrl(sourceId: string, url: string, userId: string | null, db: Queryable) {
  const meta = await storeSecret('calendar_source', sourceId, url, userId, db);
  return meta.id;
}

export async function replaceSourceUrl(src: { id: string; url_secret_id: string }, url: string, userId: string | null, db: Queryable) {
  const id = await storeSourceUrl(src.id, url, userId, db);
  await revokeSecret(src.url_secret_id, db);
  return id;
}

/* ------------------------------------------------------------------ Abo (Ausgabe) */

export const FEED_TOKEN_PREFIX = 'bcal_';
export const newFeedToken = () => FEED_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
export const feedTokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
