import { many, one, pool } from '../db/pool.js';
import { httpRequest, type HttpResponse } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { connectionSecrets, type Connection, type TestStep } from './common.js';
import { draftTitle, handleIncident, incidentDecision, incidentInfo, normalizeTime, showTime, type Fe2Field } from './fe2.js';
import { Receipt, redactIncidentPayload, type ReceiptTrigger } from './receipts.js';
import { getSettings } from '../lib/settings.js';

/**
 * Feuersoftware Connect als zweite Einsatzquelle neben FE2. Connect meldet Einsätze nicht von sich aus – BlaulichtCMS
 * fragt die „Öffentliche Connect Schnittstelle“ regelmäßig ab (`GET /operation?onlyLatest=true`: je Einsatznummer der
 * aktuellste Stand, höchstens 101 Einsätze) und legt für jeden neuen, zu den Filtern passenden Einsatz der letzten
 * 24 Stunden genau einen internen Beitragsentwurf an – über denselben Weg wie FE2 (handleIncident). Ältere Einsätze
 * werden nie übernommen (sonst entstünden beim Aktivieren Entwürfe für längst vergangene Einsätze).
 *
 * Übernommen werden nur Stichwort, Einsatzart, Ort/Ortsteil (ohne Straße und Hausnummer), Alarmzeit und Ende.
 * Sachverhalt, Einsatznummer, Koordinaten, meldende Person und Telefonnummern werden nie gespeichert oder protokolliert.
 * Lagemeldungen (`/operation/{id}/message`) ruft BlaulichtCMS bewusst nicht ab: Freitext kann Gesundheitsdaten
 * enthalten (Art. 9 DSGVO) und wird für einen redaktionellen Entwurf nicht gebraucht.
 *
 * Feuersoftware begrenzt die Zahl der Anfragen (Richtwert 50 je Stunde) und behält sich vor, Schlüssel bei Überlast zu sperren.
 * Daher Abstand 60/120/180/300 s (Standard 120 s), nie mehr als ein Abruf je Verbindung gleichzeitig, Retry-After
 * wird eingehalten.
 */
export const FEUERSOFTWARE_BASE = 'https://connectapi.feuersoftware.com/interfaces/public';
export const FEUERSOFTWARE_INTERVALS = [60, 120, 180, 300] as const;
export const FEUERSOFTWARE_DEFAULT_INTERVAL = 120;
/** Ab so vielen Fehlschlägen in Folge wird die Verwaltung benachrichtigt (bei Erfolg wieder aufgehoben). */
export const ALERT_AFTER_FAILURES = 3;
const TIMEOUT_MS = 15_000;
const ID_MAX = 64;
/** Nur Einsätze, die höchstens so alt sind, werden übernommen. */
export const MAX_AGE_HOURS = 24;

/** Einsatz aus den letzten 24 Stunden? Ohne lesbare Zeit gilt er als aktuell (Connect liefert sonst immer Start). */
export function isRecent(op: any, now = Date.now()): boolean {
  const t = Date.parse(String(op?.Start ?? op?.CreatedAt ?? ''));
  return Number.isNaN(t) || now - t <= MAX_AGE_HOURS * 3600_000;
}

/** Basisadresse; nur in automatischen Tests auf einen lokalen Ersatzdienst umstellbar. */
function baseUrl(): string {
  const override = process.env.VITEST ? process.env.BLAULICHTCMS_FEUERSOFTWARE_URL : undefined;
  return (override || FEUERSOFTWARE_BASE).replace(/\/$/, '');
}

export class ConnectError extends Error {
  retryAfter: number | null;
  /** HTTP-Status der Antwort (für das Empfangsprotokoll), ohne Antwort null */
  status: number | null;
  constructor(message: string, retryAfter: number | null = null, status: number | null = null) {
    super(message);
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

// Feldnamen laut Schnittstellenbeschreibung (PascalCase). Connect könnte sie auch klein geschrieben liefern
// (camelCase) – dann fiele jeder Einsatz stillschweigend durch; daher normalisiert.
const FIELDS = new Map(
  ['Id', 'Start', 'End', 'CreatedAt', 'LastUpdateAt', 'Priority', 'Keyword', 'Category', 'Facts', 'Ric', 'Address', 'Reporter', 'Number', 'Source', 'Properties', 'AdditionalInformation', 'SiteId', 'Street', 'HouseNumber', 'City', 'District', 'StreetWithHouseNumber', 'CityWithDistrict', 'Lat', 'Lng', 'ZipCode', 'MessageText', 'TimeStamp', 'SenderName', 'Name', 'PhoneNumber'].map((n) => [n.toLowerCase(), n]),
);

export function normalizeKeys(v: unknown): any {
  if (Array.isArray(v)) return v.map(normalizeKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [FIELDS.get(k.toLowerCase()) ?? k, normalizeKeys(x)]));
  return v;
}

/** Retry-After in Sekunden (Zahl oder HTTP-Datum), begrenzt auf 1 s … 1 h; Standard 60 s. */
export function retryAfterSeconds(h: string | undefined): number {
  const s = String(h ?? '').trim();
  let n = /^\d+$/.test(s) ? Number(s) : s ? Math.ceil((Date.parse(s) - Date.now()) / 1000) : NaN;
  if (!Number.isFinite(n) || n <= 0) n = 60;
  return Math.min(3600, Math.max(1, n));
}

function privateHosts(): string[] {
  const u = process.env.VITEST ? process.env.BLAULICHTCMS_FEUERSOFTWARE_URL : undefined;
  return u ? [new URL(u).hostname] : [];
}

/** Ein Aufruf mit verständlichen Störungsmeldungen (Ursache und Abhilfe). Der Schlüssel erscheint nie in Meldungen. */
export async function connectRequest(apiKey: string, path: string): Promise<unknown> {
  if (!apiKey) throw new ConnectError('Kein API-Key hinterlegt – im Connect Portal unter Standort → Schnittstellen → „Öffentliche Connect Schnittstelle“ erzeugen und hier eintragen.');
  let res: HttpResponse;
  try {
    res = await httpRequest({ method: 'GET', url: `${baseUrl()}${path}`, headers: { authorization: `bearer ${apiKey}`, accept: 'application/json' }, timeoutMs: TIMEOUT_MS, maxResponseBytes: 2 * 1024 * 1024, maxRedirects: 0, allowPrivateHosts: privateHosts() });
  } catch (e) {
    if (e instanceof StepError && /Zeitüberschreitung/.test(e.message)) throw new ConnectError(`Feuersoftware Connect antwortet nicht (Zeitüberschreitung nach ${TIMEOUT_MS / 1000} s) – meist vorübergehend, der nächste Versuch läuft automatisch.`);
    if (e instanceof StepError && e.errorClass === 'config') throw new ConnectError(`Feuersoftware Connect ist nicht erreichbar: ${e.message}`);
    throw new ConnectError('Feuersoftware Connect ist nicht erreichbar – erreicht der Server connectapi.feuersoftware.com über HTTPS (Internet, DNS, Firewall)?');
  }
  const st = res.status;
  if (st === 200) {
    try {
      return normalizeKeys(JSON.parse(res.text()));
    } catch {
      throw new ConnectError('Unerwartete Antwort von Feuersoftware (kein JSON) – hat sich die Schnittstelle geändert?', null, st);
    }
  }
  if (st === 401) throw new ConnectError('Der API-Key wird abgelehnt (401) – im Connect Portal prüfen, ob die „Öffentliche Connect Schnittstelle“ aktiv ist, und den Schlüssel neu eintragen.', null, st);
  if (st === 403) throw new ConnectError('Zugriff verweigert (403) – der Schlüssel darf diese Daten nicht lesen (anderer Standort? Schnittstelle im Connect Portal deaktiviert oder wegen Überlast gesperrt?).', null, st);
  if (st === 404) throw new ConnectError('Adresse bei Feuersoftware nicht gefunden (404) – hat sich die Schnittstelle geändert?', null, st);
  if (st === 429) {
    const wait = retryAfterSeconds(res.headers['retry-after']);
    throw new ConnectError(`Zu viele Abfragen (429) – Feuersoftware begrenzt die Zahl der Abfragen. Nächster Versuch in ${wait} s; bei Wiederholung den Abrufabstand erhöhen.`, wait, st);
  }
  if (st >= 500) throw new ConnectError(`Feuersoftware meldet einen Serverfehler (${st}) – meist vorübergehend, der nächste Versuch läuft automatisch.`, null, st);
  throw new ConnectError(`Feuersoftware antwortet mit HTTP ${st}.`, null, st);
}

export async function fetchOperations(apiKey: string): Promise<any[]> {
  const data = await connectRequest(apiKey, '/operation?onlyLatest=true');
  if (!Array.isArray(data)) throw new ConnectError('Unerwartete Antwort von Feuersoftware (keine Einsatzliste).', null, 200);
  return data.filter((op) => op && typeof op === 'object');
}

/* ------------------------------------------------------------ Filter (RIC, Stichwort) */

export function splitList(v: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]+/);
  return parts.map((x) => String(x).trim()).filter(Boolean);
}

const norm = (v: unknown) => String(v ?? '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Passt die eingestellte RIC zum RIC-Feld? Gleich (ohne Groß-/Kleinschreibung und doppelte Leerzeichen; bei Zahlen-RICs
 * auch ohne Leerzeichen) oder als ganzes Wort darin – „2-Drohne“ passt auf „KEL 2-Drohne TE“, „123“ aber nicht auf
 * „1234567“. Mehrere RICs im Feld sind durch Komma, Semikolon oder Zeilenumbruch getrennt; Leerzeichen gehören zum Namen.
 */
export function ricHit(wanted: string, ricField: string): boolean {
  const want = norm(wanted);
  if (!want) return false;
  const parts = splitList(ricField).map(norm);
  if (parts.includes(want) || parts.map((p) => p.replace(/ /g, '')).includes(want.replace(/ /g, ''))) return true;
  return new RegExp(`(?<![\\w-])${escapeRe(want)}(?![\\w-])`, 'u').test(norm(ricField));
}

export interface FsFilter {
  rics?: string[];
  keywords?: string[];
}

/** Gehört der Einsatz zur eigenen Einheit – und warum (für Test und Vorschau)? Ohne Filter gelten alle Einsätze. */
export function matchReason(op: any, f: FsFilter): { ok: boolean; reason: string } {
  const rics = f.rics ?? [];
  const keywords = f.keywords ?? [];
  if (!rics.length && !keywords.length) return { ok: true, reason: 'kein Filter – alle Einsätze des Standorts' };
  const hits = rics.filter((r) => ricHit(r, String(op.Ric ?? '')));
  if (hits.length) return { ok: true, reason: `RIC „${hits.join(', ')}“ passt` };
  const kw = String(op.Keyword ?? '').toLowerCase();
  const hit = keywords.find((w) => kw.includes(w.toLowerCase()));
  if (hit) return { ok: true, reason: `Stichwort enthält „${hit}“` };
  const parts = [
    rics.length ? `RIC nicht in der Liste: „${splitList(String(op.Ric ?? '')).join(', ') || '(keine)'}“ – eingestellt „${rics.join(', ')}“` : null,
    keywords.length ? `Stichwort nicht in der Liste: „${String(op.Keyword ?? '').trim() || '(keins)'}“ enthält keins von „${keywords.join(', ')}“` : null,
  ];
  return { ok: false, reason: `${parts.filter(Boolean).join('; ')}.` };
}

/** Angaben eines Connect-Einsatzes für das Empfangsprotokoll: Allowlist-Felder und RIC, nie Adresse oder Einsatznummer. */
function opInfo(op: any, tz: string) {
  const { eventId, fields } = operationFields(op, tz);
  return incidentInfo(eventId ?? (text(op.Id, 64) || null), fields, { ric: text(op.Ric, 200) || null });
}

/** Geschwärzte Rohdaten eines Einsatzes (ohne Straße, Hausnummer, Koordinaten, Sachverhalt, meldende Person, Einsatznummer). */
const opRaw = (op: any) => redactIncidentPayload(op);

/** Nur Ort bzw. Ort mit Ortsteil – nie Straße und Hausnummer. */
export function locationArea(op: any): string {
  const a = op?.Address && typeof op.Address === 'object' ? op.Address : {};
  return String(a.CityWithDistrict || a.City || '').trim().slice(0, 200);
}

const text = (v: unknown, max: number) => {
  if (v == null || typeof v === 'object') return '';
  return String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
};

/** Einsatz → Felder der Allowlist (wie bei FE2). Alles andere wird verworfen. */
export function operationFields(op: any, timeZone = 'Europe/Berlin'): { eventId: string | null; fields: Partial<Record<Fe2Field, string>>; closed: boolean } {
  const id = text(op.Id, 200);
  const fields: Partial<Record<Fe2Field, string>> = {};
  const keyword = text(op.Keyword, 200);
  const category = text(op.Category, 100);
  const area = locationArea(op);
  const start = text(op.Start, 60);
  if (keyword) fields.keyword = keyword;
  if (category) fields.category = category;
  if (area) fields.municipality = area;
  if (start) fields.started_at = normalizeTime(start, timeZone);
  const closed = !!text(op.End, 60);
  if (closed) fields.status = 'beendet';
  return { eventId: id && id.length <= ID_MAX ? id : null, fields, closed };
}

/* ------------------------------------------------------------ Test, Abruf */

function filterOf(c: Connection): FsFilter {
  return { rics: c.config.rics ?? [], keywords: c.config.keywords ?? [] };
}

function previewOf(ops: any[], f: FsFilter) {
  return ops.slice(0, 10).map((op) => {
    const { fields } = operationFields(op);
    const m = matchReason(op, f);
    // Vorschau ohne Adresse: nur Ort/Ortsteil, Stichwort, Einsatzart, Alarmzeit und RIC
    return { title: draftTitle(fields), keyword: fields.keyword ?? null, category: fields.category ?? null, area: fields.municipality ?? null, start: fields.started_at ?? null, ric: text(op.Ric, 120) || null, matched: m.ok, reason: m.reason };
  });
}

export async function testFeuersoftware(c: Connection) {
  const sec = await connectionSecrets(c);
  const steps: TestStep[] = [{ name: 'API-Key', ok: !!sec.apiKey, message: sec.apiKey ? 'Hinterlegt (verschlüsselt).' : 'Fehlt – im Connect Portal unter Standort → Schnittstellen → „Öffentliche Connect Schnittstelle“ erzeugen und hier eintragen.', kind: 'login' }];
  let preview: any = null;
  const wait = (c as any).retry_after_until ? new Date((c as any).retry_after_until) : null;
  if (!sec.apiKey) return { steps, preview, capabilities: { read: false, drafts: false } };
  if (wait && wait > new Date()) {
    steps.push({ name: 'Einsätze abrufen', ok: false, message: `Feuersoftware hat um eine Pause gebeten – bitte nach ${wait.toLocaleTimeString('de-DE', { timeZone: (await getSettings())['general.timezone'] || 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit' })} erneut testen.`, kind: 'read' });
    return { steps, preview, capabilities: { read: false, drafts: false } };
  }
  const rec = new Receipt(c.id, 'test');
  try {
    let ops = await fetchOperations(sec.apiKey);
    rec.httpStatus = 200;
    const all = ops.length;
    const tz = (await getSettings())['general.timezone'] || 'Europe/Berlin';
    for (const op of ops) {
      const m = matchReason(op, filterOf(c));
      if (!isRecent(op)) rec.add({ decision: 'filtered', reason: `Älter als ${MAX_AGE_HOURS} Stunden – wird nie übernommen.`, info: opInfo(op, tz), raw: opRaw(op) });
      else rec.add({ decision: m.ok ? 'test' : 'filtered', reason: m.ok ? `Test – nichts angelegt. Würde übernommen: ${m.reason}.` : m.reason, info: opInfo(op, tz), raw: opRaw(op) });
    }
    await rec.finish({ ok: true, received: all, summary: 'Verbindungstest – nichts angelegt.' });
    ops = ops.filter((op) => isRecent(op));
    steps.push({ name: 'Einsätze abrufen', ok: true, message: all ? `Verbindung steht: ${all} Einsatz/Einsätze gelesen, davon ${ops.length} aus den letzten ${MAX_AGE_HOURS} Stunden (nur diese werden übernommen).` : 'Verbindung steht, der Schlüssel wird angenommen. Zurzeit liefert Connect keinen Einsatz.', kind: 'read' });
    const f = filterOf(c);
    const matching = ops.filter((op) => matchReason(op, f).ok);
    const rics = [...new Set(ops.flatMap((op) => splitList(String(op.Ric ?? ''))))].slice(0, 8);
    const noFilter = !f.rics?.length && !f.keywords?.length;
    steps.push({
      name: 'Filter (RIC, Stichwort)',
      ok: true,
      message: `${matching.length} von ${ops.length} passen${noFilter ? ' (kein Filter gesetzt – jeder Einsatz des Standorts wird übernommen)' : ''}.${rics.length && matching.length < ops.length ? ` RICs der Einsätze: ${rics.join(', ')}.` : ''}`,
      kind: 'read',
    });
    preview = { operations: previewOf(ops, f), total: ops.length, matched: matching.length, at: new Date().toISOString() };
    await pool.query(`UPDATE connections SET last_poll_at = now(), retry_after_until = NULL WHERE id = $1`, [c.id]);
  } catch (e: any) {
    const err = e instanceof ConnectError ? e : new ConnectError(String(e?.message ?? e));
    steps.push({ name: 'Einsätze abrufen', ok: false, message: err.message.slice(0, 300), kind: 'read' });
    await rec.finish({ ok: false, error: err.message.slice(0, 300), httpStatus: err.status, received: 0 });
    await pool.query(`UPDATE connections SET last_poll_at = now(), retry_after_until = CASE WHEN $2::int IS NULL THEN retry_after_until ELSE now() + make_interval(secs => $2::int) END WHERE id = $1`, [c.id, err.retryAfter]);
  }
  return { steps, preview, capabilities: { read: steps.every((s) => s.ok), drafts: steps.every((s) => s.ok) } };
}

export function intervalOf(c: { config: Record<string, any> }): number {
  const v = Number(c.config?.intervalSeconds);
  return (FEUERSOFTWARE_INTERVALS as readonly number[]).includes(v) ? v : FEUERSOFTWARE_DEFAULT_INTERVAL;
}

/**
 * Läuft gerade ein Abruf in diesem Prozess? (zusätzlich zur Sperre über last_poll_at in der Datenbank). Die Sperre hat
 * eine Frist (#240): Ein Abruf, der länger als POLL_LOCK_MS läuft, gilt als hängend – der nächste fällige Abruf läuft
 * dann trotzdem und es wird gewarnt, statt dass still keine Einsätze mehr ankommen. Die Anfrage selbst endet ohnehin
 * nach TIMEOUT_MS (Gesamtfrist in lib/http.ts); die Frist hier fängt alles andere ab.
 */
export const POLL_LOCK_MS = 120_000;
const inFlight = new Map<string, { since: number; token: symbol }>();

/** Sperre für einen Abruf nehmen; null = es läuft schon einer (innerhalb der Frist). */
export function acquirePollLock(id: string, now = Date.now()): symbol | null {
  const cur = inFlight.get(id);
  if (cur && now - cur.since < POLL_LOCK_MS) return null;
  if (cur) log('warn', 'feuersoftware', `Ein Abruf hängt seit ${Math.round((now - cur.since) / 1000)} s – Sperre aufgehoben, der nächste Abruf läuft.`);
  const token = Symbol(id);
  inFlight.set(id, { since: now, token });
  return token;
}

/** Sperre freigeben – nur die eigene (ein hängender alter Abruf gibt eine neuere Sperre nicht frei). */
export function releasePollLock(id: string, token: symbol) {
  if (inFlight.get(id)?.token === token) inFlight.delete(id);
}

export interface PollResult {
  skipped?: string;
  seen?: number;
  matched?: number;
  created?: number;
  warnings?: string[];
  error?: string;
}

/**
 * Einen Abruf beanspruchen: setzt last_poll_at nur, wenn die Verbindung aktiv, fällig (bzw. bei „Jetzt abrufen“ seit
 * mindestens 15 s ohne Abruf) und keine erbetene Pause offen ist. Die bedingte Aktualisierung ist die Sperre gegen
 * gleichzeitige Abrufe – auch über mehrere Prozesse hinweg.
 */
async function claim(id: string, force: boolean): Promise<Connection | null> {
  // Regulär: Abstand der Verbindung (2 s Spielraum für den Takt des Workers); „Jetzt abrufen“: mindestens 15 s
  return one<Connection>(
    `UPDATE connections SET last_poll_at = now()
      WHERE id = $1 AND kind = 'feuersoftware' AND status = 'active' AND deleted_at IS NULL
        AND (retry_after_until IS NULL OR retry_after_until <= now())
        AND (last_poll_at IS NULL OR last_poll_at <= now() - make_interval(secs => CASE WHEN $2 THEN 15
              ELSE GREATEST(58, COALESCE((config->>'intervalSeconds')::int, ${FEUERSOFTWARE_DEFAULT_INTERVAL}) - 2) END))
      RETURNING *`,
    [id, force],
  );
}

/** Abruf einer aktiven Verbindung: neue, passende Einsätze als Entwurf; Fehler zählen und ggf. melden. */
export async function pollFeuersoftware(id: string, opts: { force?: boolean } = {}): Promise<PollResult> {
  const lock = acquirePollLock(id);
  if (!lock) return { skipped: 'Ein Abruf läuft bereits.' };
  try {
    const c = await claim(id, !!opts.force);
    if (!c) {
      const cur = await one<any>(`SELECT status, retry_after_until FROM connections WHERE id = $1`, [id]);
      if (cur?.status !== 'active') return { skipped: 'Die Verbindung ist nicht aktiv.' };
      if (cur.retry_after_until && new Date(cur.retry_after_until) > new Date()) return { skipped: 'Feuersoftware hat um eine Pause gebeten.' };
      return { skipped: 'Gerade erst abgerufen – bitte kurz warten.' };
    }
    const rec = new Receipt(c.id, opts.force ? 'manual' : 'scheduled');
    try {
      const r = await runPoll(c, rec);
      await rec.finish(r.error ? { ok: false, error: r.error, received: 0 } : { ok: true, received: r.received, summary: r.warnings?.length ? r.warnings.join(' ') : null });
      return r;
    } catch (e: any) {
      await rec.finish({ ok: false, error: String(e?.message ?? e).slice(0, 300), received: rec.size });
      throw e;
    }
  } finally {
    releasePollLock(id, lock);
  }
}

async function runPoll(c: Connection, rec: Receipt): Promise<PollResult & { received?: number }> {
  const sec = await connectionSecrets(c);
  let ops: any[];
  try {
    ops = await fetchOperations(sec.apiKey ?? '');
    rec.httpStatus = 200;
  } catch (e: any) {
    const err = e instanceof ConnectError ? e : new ConnectError(String(e?.message ?? e));
    rec.httpStatus = err.status;
    await recordFailure(c, err);
    return { error: err.message };
  }
  const tz = (await getSettings())['general.timezone'] || 'Europe/Berlin';
  const f = filterOf(c);
  const warnings: string[] = [];
  let matched = 0;
  let created = 0;
  const received = ops.length;
  // Jeder gelieferte Einsatz steht mit Entscheidung im Empfangsprotokoll – auch ältere und nicht passende
  const note = (op: any, decision: Parameters<Receipt['add']>[0]['decision'], reason: string) => rec.add({ decision, reason, info: opInfo(op, tz), raw: opRaw(op) });
  for (const op of ops.filter((x) => !isRecent(x))) note(op, 'filtered', `Älter als ${MAX_AGE_HOURS} Stunden (Alarm ${showTime(normalizeTime(text(op.Start ?? op.CreatedAt, 40), tz), tz) || 'unbekannt'}) – wird nie übernommen.`);
  ops = ops.filter((op) => isRecent(op));
  for (const op of ops) {
    const m = matchReason(op, f);
    if (!m.ok) {
      note(op, 'filtered', m.reason);
      continue;
    }
    matched++;
    const { eventId, fields, closed } = operationFields(op, tz);
    if (!eventId) {
      warnings.push('Ein Einsatz ohne gültige Kennung wurde übersprungen.');
      note(op, 'error', 'Fehler beim Verarbeiten: Einsatz ohne gültige Kennung (Id fehlt oder ist zu lang) – übersprungen.');
      continue;
    }
    try {
      const r = await handleIncident(c, 'feuersoftware', { eventId, fields, closed });
      if (r.outcome === 'created') created++;
      const d = incidentDecision(r, c.config.createDrafts !== false);
      note(op, d.decision, `${d.reason} Filter: ${m.reason}.`);
    } catch (e: any) {
      log('warn', 'feuersoftware', `Einsatz nicht übernommen: ${e?.message ?? e}`);
      warnings.push('Ein Einsatz konnte nicht übernommen werden – Details im Systemprotokoll.');
      note(op, 'error', `Fehler beim Verarbeiten: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  await recordSuccess(c);
  return { seen: ops.length, matched, created, warnings: [...new Set(warnings)], received };
}

async function recordFailure(c: Connection, err: ConnectError) {
  const r = await one<{ consecutive_failures: number }>(
    `UPDATE connections SET consecutive_failures = consecutive_failures + 1, last_error = $2,
            retry_after_until = CASE WHEN $3::int IS NULL THEN retry_after_until ELSE now() + make_interval(secs => $3::int) END
      WHERE id = $1 RETURNING consecutive_failures`,
    [c.id, err.message.slice(0, 500), err.retryAfter],
  );
  log('warn', 'feuersoftware', `Abruf „${c.name}“ fehlgeschlagen: ${err.message}`);
  if (r?.consecutive_failures === ALERT_AFTER_FAILURES) {
    await notify({ kind: 'error', title: `Feuersoftware Connect „${c.name}“ gestört`, body: `Seit ${ALERT_AFTER_FAILURES} Abrufen keine Verbindung: ${err.message}`, link: `/verbindungen/${c.id}`, permission: 'connection.configure' });
  }
}

async function recordSuccess(c: Connection) {
  const before = await one<{ consecutive_failures: number }>(
    `UPDATE connections n SET consecutive_failures = 0, last_error = NULL, retry_after_until = NULL, last_event_at = now()
       FROM connections o WHERE n.id = o.id AND n.id = $1 RETURNING o.consecutive_failures`,
    [c.id],
  );
  if ((before?.consecutive_failures ?? 0) >= ALERT_AFTER_FAILURES) {
    // Störungsmeldung aufheben und Entwarnung geben
    await pool.query(`DELETE FROM notifications WHERE link = $1 AND title LIKE 'Feuersoftware Connect %gestört'`, [`/verbindungen/${c.id}`]);
    await notify({ kind: 'success', title: `Feuersoftware Connect „${c.name}“ wieder erreichbar`, link: `/verbindungen/${c.id}`, permission: 'connection.configure' });
    log('info', 'feuersoftware', `Abruf „${c.name}“ wieder erfolgreich`);
  }
}

/** Fällige Abrufe aller aktiven Feuersoftware-Verbindungen (Worker, nacheinander). */
export async function pollDueFeuersoftware() {
  const rows = await many<Connection>(
    `SELECT * FROM connections WHERE kind = 'feuersoftware' AND status = 'active' AND deleted_at IS NULL
       AND (retry_after_until IS NULL OR retry_after_until <= now())`,
  );
  for (const c of rows) {
    const last = (c as any).last_poll_at ? new Date((c as any).last_poll_at).getTime() : 0;
    if (Date.now() - last < intervalOf(c) * 1000) continue;
    await pollFeuersoftware(c.id).catch((e) => log('warn', 'feuersoftware', `Abruf „${c.name}“: ${e?.message ?? e}`));
  }
}
