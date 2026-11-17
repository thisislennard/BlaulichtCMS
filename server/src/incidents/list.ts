import crypto from 'node:crypto';
import { many, one, pool, type Queryable } from '../db/pool.js';
import { audit, type Actor } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { lookupKeyword } from '../keywords/store.js';

/**
 * Einsatzliste auf der Website (#213). Ein Eintrag ist eine knappe, öffentliche Einsatzinformation: Alarmzeit,
 * Stichwort mit Bedeutung aus dem Stichwortverzeichnis, Kategorie, Einsatzmeldung, Ort nur auf Ortsteil-Ebene,
 * optional Kurzbericht, Fahrzeuge, weitere Kräfte und Bilder. Ablauf wie bei Bannern: Entwurf → Freigabe genau dieser
 * Fassung (Prüfsumme) → Veröffentlichen an eine gekoppelte Website (Auftrag an die Bridge) → Zurückziehen.
 *
 * Datenschutz: keine Adressen, keine Namen. Der Ort wird gegen die Allowlist der Ortsangaben geprüft (Einstellungen der
 * Einsatzliste); ohne Allowlist weist die Prüfung Straßen und Hausnummern zurück. Eingehende Alarme liefern ohnehin nur
 * die Felder der Allowlist der Verbindung (Ortsteil bzw. Gemeinde).
 */

export const LIMITS = { title: 200, keyword: 60, keywordLabel: 200, category: 60, location: 80, report: 5000, vehicles: 500, units: 500, media: 10 } as const;

export interface EntryFields {
  site_id: string | null;
  alarm_at: string | Date;
  number: number | null;
  keyword: string;
  keyword_label: string;
  category: string;
  title: string;
  location: string;
  report: string;
  vehicles: string;
  units: string;
  link_url: string | null;
  featured: boolean;
  false_alarm: boolean;
  media_ids: string[];
}

export function entryHash(e: EntryFields): string {
  const base = [
    e.site_id ?? null,
    new Date(e.alarm_at).toISOString(),
    e.number ?? null,
    e.keyword,
    e.keyword_label,
    e.category,
    e.title,
    e.location,
    e.report,
    e.vehicles,
    e.units,
    e.link_url ?? null,
    !!e.featured,
    !!e.false_alarm,
    [...(e.media_ids ?? [])],
  ];
  return crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex');
}

export type EntryState = 'draft' | 'in_review' | 'approved' | 'publishing' | 'live' | 'failed' | 'withdrawing' | 'withdrawn';

/** Zustand aus Eintrag und letztem (nicht abgebrochenem) Auftrag. */
export function entryState(e: { content_hash: string; approved_hash: string | null; submitted_at: unknown; withdrawn_at: unknown; revision: number }, job: { action: string; status: string; revision: number } | null): EntryState {
  if (job?.action === 'delete') return job.status === 'done' ? 'withdrawn' : job.status === 'failed' ? 'failed' : 'withdrawing';
  if (e.withdrawn_at) return 'withdrawn';
  const approved = !!e.approved_hash && e.approved_hash === e.content_hash;
  if (job?.action === 'upsert' && job.revision === e.revision && approved) {
    if (job.status === 'done') return 'live';
    if (job.status === 'failed') return 'failed';
    return 'publishing';
  }
  if (approved) return 'approved';
  return e.submitted_at ? 'in_review' : 'draft';
}

/** Steht der Eintrag (in irgendeiner Fassung) auf der Website oder ist er dorthin unterwegs? */
export async function isOnWebsite(entryId: string, db: Queryable = pool): Promise<boolean> {
  const last = await one<{ action: string; status: string }>(
    `SELECT action, status FROM incident_jobs WHERE entry_id = $1 AND status IN ('queued','sent','done') ORDER BY created_at DESC LIMIT 1`,
    [entryId],
    db,
  );
  return !!last && last.action === 'upsert';
}

/* ------------------------------------------------------------------ Einstellungen */

export interface IncidentConfig {
  locations: string[];
  default_site_id: string | null;
}

export async function loadConfig(db: Queryable = pool): Promise<IncidentConfig> {
  const c = await one<any>(`SELECT locations, default_site_id FROM incident_list_config WHERE id`, [], db);
  return { locations: c?.locations ?? [], default_site_id: c?.default_site_id ?? null };
}

/* ------------------------------------------------------------------ Ort nur grob */

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);

const STREET_RE = /(stra(ß|ss)e\b|str\.|weg\b|gasse\b|allee\b|chaussee\b|damm\b|pfad\b|steig\b|ufer\b|platz\b|graben\b|zeile\b)/i;
const STREET_PREFIX_RE = /^(am|an der|an den|an dem|im|in der|in den|auf der|auf dem|auf den|hinter der|hinter dem|hinter den|zum|zur|unter der|unter den|vor dem|vor der|bei der|beim)\s/i;

/** Sieht eine Ortsangabe nach Adresse aus (Hausnummer, Postleitzahl, Straßenname)? */
export function looksLikeAddress(v: string): boolean {
  return /\d/.test(v) || STREET_RE.test(v) || STREET_PREFIX_RE.test(v);
}

/**
 * Ortsangabe auf Ortsteil-Ebene bringen. Mit Allowlist: genauer Treffer (ohne Groß-/Kleinschreibung) oder ein Eintrag
 * der Allowlist, der als ganzes Wort in der Angabe vorkommt (z. B. „Gartenstraße, Musterstadt“ → „Musterstadt“) –
 * sonst entfällt der Ort. Ohne Allowlist entfällt eine Angabe, die nach Adresse aussieht.
 */
export function coarseLocation(raw: unknown, allow: string[]): { value: string; removed: boolean } {
  const v = clean(raw, 200);
  if (!v) return { value: '', removed: false };
  if (allow.length) {
    const exact = allow.find((a) => a.toLowerCase() === v.toLowerCase());
    if (exact) return { value: exact, removed: false };
    const lower = ` ${v.toLowerCase().replace(/[,;/()]/g, ' ')} `;
    const hits = allow.filter((a) => lower.includes(` ${a.toLowerCase()} `)).sort((a, b) => b.length - a.length);
    return hits.length ? { value: hits[0], removed: false } : { value: '', removed: true };
  }
  if (looksLikeAddress(v)) {
    // Erster Teil vor dem Komma ist oft die Straße, der Rest der Ort („Gartenstraße, Musterstadt“)
    const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
    const rest = parts.slice(1).filter((p) => !looksLikeAddress(p));
    if (parts.length > 1 && rest.length) return { value: rest[rest.length - 1].slice(0, LIMITS.location), removed: false };
    return { value: '', removed: true };
  }
  return { value: v.slice(0, LIMITS.location), removed: false };
}

/** Strenge Prüfung für Eingaben von Hand: lieber eine klare Fehlermeldung als stilles Entfernen. */
export function assertLocation(raw: string, allow: string[]): string {
  const v = clean(raw, 200);
  if (!v) return '';
  if (allow.length) {
    const exact = allow.find((a) => a.toLowerCase() === v.toLowerCase());
    if (!exact) throw badRequest(`Ort: bitte einen Eintrag aus der Liste der erlaubten Ortsangaben wählen (${allow.slice(0, 8).join(', ')}${allow.length > 8 ? ', …' : ''}).`);
    return exact;
  }
  if (looksLikeAddress(v)) throw badRequest('Ort: bitte nur den Ortsteil bzw. die Gemeinde angeben – keine Straße, keine Hausnummer, keine Postleitzahl.');
  return v.slice(0, LIMITS.location);
}

/* ------------------------------------------------------------------ Anlegen */

export interface NewEntry {
  siteId?: string | null;
  alarmAt: Date;
  number?: number | null;
  keyword?: string;
  keywordLabel?: string;
  category?: string;
  title?: string;
  location?: string;
  report?: string;
  vehicles?: string;
  units?: string;
  linkUrl?: string | null;
  featured?: boolean;
  falseAlarm?: boolean;
  mediaIds?: string[];
  source: 'manual' | 'alarm' | 'workflow' | 'import';
  sourceRef?: string | null;
  fe2EventId?: string | null;
  submit?: boolean;
}

/** Bedeutung und Kategorie aus dem Stichwortverzeichnis ergänzen, wo sie fehlen. */
export async function withKeywordMeaning(keyword: string, label: string, category: string, db: Queryable = pool) {
  if (!keyword || (label && category)) return { label, category };
  try {
    const k = await lookupKeyword(keyword, db);
    // Lange Aufzählungen aus dem Meldebild (z. B. „Wasser im Keller, Wasserrohrbruch, …“) sind keine knappe Bedeutung
    const short = k?.label && k.label.length <= 60 ? k.label : '';
    return { label: label || short, category: category || k?.category || '' };
  } catch {
    return { label, category };
  }
}

/**
 * Eintrag aus bereits geprüften Werten anlegen (Alarm, Workflow, Import). Der Ort wird grob gemacht (nie eine Adresse).
 * Gibt null zurück, wenn es zu dieser Herkunft schon einen Eintrag gibt (Entprellen über source_ref).
 */
export async function createEntry(db: Queryable, n: NewEntry, actor: Actor, userId: string | null, cfg?: IncidentConfig): Promise<{ entry: any; locationRemoved: boolean } | null> {
  const conf = cfg ?? (await loadConfig(db));
  const keyword = clean(n.keyword, LIMITS.keyword);
  const meaning = await withKeywordMeaning(keyword, clean(n.keywordLabel, LIMITS.keywordLabel), clean(n.category, LIMITS.category), db);
  const loc = coarseLocation(n.location, conf.locations);
  const title = clean(n.title, LIMITS.title) || meaning.label || keyword || 'Einsatz';
  const linkUrl = n.linkUrl && /^https?:\/\/\S+$/i.test(n.linkUrl) ? n.linkUrl.slice(0, 500) : null;
  const fields: EntryFields = {
    site_id: n.siteId ?? conf.default_site_id ?? null,
    alarm_at: n.alarmAt,
    number: n.number ?? null,
    keyword,
    keyword_label: meaning.label.slice(0, LIMITS.keywordLabel),
    category: meaning.category.slice(0, LIMITS.category),
    title,
    location: loc.value,
    report: clean(n.report, LIMITS.report).replace(/\r\n/g, '\n'),
    vehicles: clean(n.vehicles, LIMITS.vehicles),
    units: clean(n.units, LIMITS.units),
    link_url: linkUrl,
    featured: !!n.featured,
    false_alarm: !!n.falseAlarm,
    media_ids: (n.mediaIds ?? []).slice(0, LIMITS.media),
  };
  const row = await one<any>(
    `INSERT INTO incident_entries (site_id, content_hash, alarm_at, number, keyword, keyword_label, category, title, location, report, vehicles, units, link_url, featured, false_alarm, media_ids,
                                   source, source_ref, fe2_event_id, created_by, updated_by, submitted_at, submitted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20, CASE WHEN $21 THEN now() END, CASE WHEN $21 THEN $20::uuid END)
     ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING *`,
    [
      fields.site_id,
      entryHash(fields),
      fields.alarm_at,
      fields.number,
      fields.keyword,
      fields.keyword_label,
      fields.category,
      fields.title,
      fields.location,
      fields.report,
      fields.vehicles,
      fields.units,
      fields.link_url,
      fields.featured,
      fields.false_alarm,
      fields.media_ids,
      n.source,
      n.sourceRef ?? null,
      n.fe2EventId ?? null,
      userId,
      !!n.submit,
    ],
    db,
  );
  if (!row) return null;
  if (n.source !== 'import') {
    await audit(actor, 'incident.created', { type: 'incident', id: row.id, label: row.title }, { herkunft: n.source, eingereicht: !!n.submit, ort_entfernt: loc.removed || undefined }, 'ok', db);
  }
  return { entry: row, locationRemoved: loc.removed };
}

/* ------------------------------------------------------------------ Aufträge an die Bridge */

export function entrySnapshot(e: any) {
  return {
    id: e.id,
    revision: e.revision,
    alarm_at: new Date(e.alarm_at).toISOString(),
    number: e.number ?? null,
    keyword: e.keyword,
    keyword_label: e.keyword_label,
    category: e.category,
    title: e.title,
    location: e.location,
    report: e.report,
    vehicles: e.vehicles,
    units: e.units,
    link_url: e.link_url ?? null,
    featured: !!e.featured,
    false_alarm: !!e.false_alarm,
    media_ids: e.media_ids ?? [],
  };
}

export async function enqueueIncidentJob(db: Queryable, e: any, siteId: string, action: 'upsert' | 'delete', userId: string | null) {
  // Ältere, noch nicht abgeholte Aufträge desselben Eintrags an dieselbe Website sind überholt
  await db.query(`UPDATE incident_jobs SET status = 'canceled', result_at = now() WHERE entry_id = $1 AND site_id = $2 AND status = 'queued'`, [e.id, siteId]);
  const payload = action === 'upsert' ? entrySnapshot(e) : { id: e.id, media_ids: e.media_ids ?? [] };
  return one<any>(`INSERT INTO incident_jobs (entry_id, site_id, action, revision, payload, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [e.id, siteId, action, e.revision, JSON.stringify(payload), userId], db);
}

/** Website, auf der ein Eintrag zuletzt stand bzw. hin unterwegs war (für Zurückziehen nach Website-Wechsel). */
export async function liveSite(entryId: string, db: Queryable = pool): Promise<string | null> {
  const j = await one<{ site_id: string; action: string }>(
    `SELECT site_id, action FROM incident_jobs WHERE entry_id = $1 AND status IN ('queued','sent','done') ORDER BY created_at DESC LIMIT 1`,
    [entryId],
    db,
  );
  return j?.action === 'upsert' ? j.site_id : null;
}

/* ------------------------------------------------------------------ Vorschläge aus Alarmen */

/** Felder einer Einsatzmeldung (fe2_events.fields, nur Allowlist) → Eintrag. */
export function fieldsFromEvent(ev: { fields: any; received_at: string | Date; keyword?: string | null; title?: string | null }) {
  const f = ev.fields ?? {};
  const started = f.started_at && !Number.isNaN(Date.parse(f.started_at)) ? new Date(f.started_at) : new Date(ev.received_at);
  return {
    alarmAt: started,
    keyword: String(f.keyword ?? ev.keyword ?? ''),
    keywordLabel: String(f.keyword_text ?? ''),
    category: '',
    title: String(f.keyword_text || ev.title || f.category || ''),
    location: String(f.district || f.municipality || ''),
    units: String(f.units ?? ''),
  };
}

export async function openSuggestions(days = 60, db: Queryable = pool) {
  return many<any>(
    `SELECT ev.id, ev.keyword, ev.title, ev.fields, ev.source, ev.status, ev.received_at
       FROM fe2_events ev
      WHERE ev.received_at > now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM incident_entries e WHERE e.fe2_event_id = ev.id)
      ORDER BY ev.received_at DESC LIMIT 100`,
    [days],
    db,
  );
}

/* ------------------------------------------------------------------ CSV-Import */

export interface ImportRow {
  line: number;
  alarmAt: Date;
  number: number | null;
  keyword: string;
  title: string;
  location: string;
  vehicles: string;
  units: string;
  report: string;
  featured: boolean;
  falseAlarm: boolean;
}

/** CSV mit Trennzeichen , ; oder Tab, Anführungszeichen nach RFC 4180. */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((r) => r.cells);
}

/**
 * Wie `parseCsv`, dazu je Datensatz die Zeile der Datei, in der er beginnt (ab 1). Zeilenumbrüche in Feldern mit
 * Anführungszeichen und leere Zeilen zählen mit – Fehlermeldungen nennen so die Zeile, die man im Editor sieht (#233).
 */
export function parseCsvRecords(text: string): { cells: string[]; line: number }[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delim = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else {
        cur += ch;
        // Umbruch im Feld: physische Zeile weiterzählen (\r\n zählt einmal)
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++;
      }
      continue;
    }
    if (ch === '"' && cur === '') quoted = true;
    else if (ch === delim) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push({ cells: row, line: start });
      row = [];
      start = ++line;
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push({ cells: row, line: start });
  return rows;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

/** Spaltennamen (auch die des CSV-Exports der WordPress-Erweiterung „Einsatzverwaltung“). */
const COLUMN_ALIASES: Record<string, string[]> = {
  number: ['lfd', 'lfdnr', 'laufendenummer', 'nr', 'nummer'],
  alarmAt: ['alarmzeit', 'datum', 'datumuhrzeit', 'zeit', 'alarmiert', 'beginn'],
  time: ['uhrzeit'],
  keyword: ['einsatzart', 'stichwort', 'einsatzstichwort'],
  title: ['berichtstitel', 'einsatzmeldung', 'titel', 'meldung', 'bezeichnung'],
  location: ['einsatzort', 'ort', 'ortsteil'],
  vehicles: ['fahrzeuge', 'einheitenundfahrzeuge', 'einheiten'],
  units: ['externeeinsatzmittel', 'weiterekrafte', 'weiterekraefte', 'weitere'],
  report: ['berichtstext', 'bericht', 'kurzbericht', 'text'],
  featured: ['besonderereinsatz', 'besonders', 'hervorgehoben'],
  falseAlarm: ['fehlalarm'],
};

/** Datum in deutscher Schreibweise oder ISO (Ortszeit der Instanz). */
export function parseLocalDate(date: string, time: string, timeZone: string): Date | null {
  const d = date.trim();
  let y: number, mo: number, da: number, h = 0, mi = 0;
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2}))?/.exec(d);
  if (m) {
    da = +m[1];
    mo = +m[2];
    y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    if (m[4]) [h, mi] = [+m[4], +m[5]];
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(d))) {
    y = +m[1];
    mo = +m[2];
    da = +m[3];
    if (m[4]) [h, mi] = [+m[4], +m[5]];
  } else return null;
  const t = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (t) [h, mi] = [+t[1], +t[2]];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || y < 1900 || y > 2100) return null;
  // Tag muss im Monat liegen: „31.04.“ oder „29.02.“ außerhalb von Schaltjahren nicht zum Folgemonat weiterrollen (#233)
  if (da > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  // Ortszeit → UTC: Versatz der Zeitzone zu diesem Zeitpunkt bestimmen
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (k: string) => +(parts.find((p) => p.type === k)?.value ?? 0);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shown - guess));
}

const yes = (v: string) => /^(ja|yes|x|1|true|wahr)$/i.test(v.trim());

export function parseIncidentCsv(text: string, timeZone: string): { rows: ImportRow[]; errors: string[]; columns: string[] } {
  const records = parseCsvRecords(text);
  const all = records.map((r) => r.cells);
  if (all.length < 2) return { rows: [], errors: ['Die Datei enthält keine Datenzeilen (erste Zeile = Spaltennamen).'], columns: [] };
  const header = all[0].map((h) => norm(h));
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) col[key] = idx;
  }
  const errors: string[] = [];
  if (col.alarmAt === undefined) return { rows: [], errors: ['Spalte „Alarmzeit“ bzw. „Datum“ fehlt.'], columns: Object.keys(col) };
  if (col.keyword === undefined && col.title === undefined) return { rows: [], errors: ['Spalte „Einsatzart“/„Stichwort“ oder „Einsatzmeldung“/„Berichtstitel“ fehlt.'], columns: Object.keys(col) };
  const rows: ImportRow[] = [];
  const val = (r: string[], k: string) => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim());
  for (let i = 1; i < all.length && rows.length < 5000; i++) {
    const r = all[i];
    // Zeile der Datei, in der der Datensatz beginnt (mehrzeilige Felder, leere Zeilen; #233)
    const line = records[i].line;
    const at = parseLocalDate(val(r, 'alarmAt'), val(r, 'time'), timeZone);
    if (!at) {
      errors.push(`Zeile ${line}: Datum „${val(r, 'alarmAt').slice(0, 30)}“ nicht lesbar oder ungültig – übersprungen.`);
      continue;
    }
    const nr = parseInt(val(r, 'number'), 10);
    const keyword = val(r, 'keyword');
    const title = val(r, 'title');
    if (!keyword && !title) {
      errors.push(`Zeile ${line}: weder Einsatzart noch Einsatzmeldung – übersprungen.`);
      continue;
    }
    rows.push({
      line,
      alarmAt: at,
      number: Number.isInteger(nr) && nr > 0 && nr < 100000 ? nr : null,
      keyword,
      title,
      location: val(r, 'location'),
      vehicles: val(r, 'vehicles'),
      units: val(r, 'units'),
      report: val(r, 'report'),
      featured: yes(val(r, 'featured')),
      falseAlarm: yes(val(r, 'falseAlarm')),
    });
  }
  if (all.length - 1 > 5000) errors.push('Höchstens 5000 Zeilen je Import – der Rest wurde nicht gelesen.');
  return { rows, errors, columns: Object.keys(col) };
}

/** Schlüssel gegen doppelten Import derselben Zeile (Alarmzeit + Stichwort + Meldung). */
export function importRef(r: { alarmAt: Date; keyword: string; title: string }) {
  return `import:${crypto.createHash('sha256').update(`${r.alarmAt.toISOString()}|${r.keyword}|${r.title}`).digest('hex').slice(0, 40)}`;
}
