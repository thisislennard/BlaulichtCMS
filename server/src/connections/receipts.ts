import crypto from 'node:crypto';
import { many, one, pool, tx } from '../db/pool.js';
import { log } from '../lib/log.js';

/**
 * Empfangsprotokoll der eingehenden Verbindungen (Warnfeeds, FE2, Feuersoftware Connect).
 *
 * Je Abruf bzw. eingehender Meldung ein Eintrag mit Auslöser, Ergebnis (inkl. der bekannten deutschen Fehlermeldung),
 * HTTP-Status, Dauer und Zählern. Je gelieferter Meldung – auch den herausgefilterten – die Entscheidung mit lesbarer
 * Begründung, die wichtigsten Angaben und die Rohdaten. Die Entscheidungen entstehen dort, wo der Abruf sie ohnehin
 * trifft (warnfeed.ts, feuersoftware.ts, fe2.ts); hier wird nur gesammelt und gespeichert.
 *
 * Rohdaten: Warnfeeds liefern öffentliche Daten und werden vollständig gespeichert. FE2- und Feuersoftware-Meldungen
 * werden vor dem Speichern geschwärzt (redactIncidentPayload): Straße, Hausnummer, Koordinaten, Namen,
 * Telefonnummern, meldende Person und Freitext bleiben nie stehen. Kopfzeilen und Schlüssel werden nie gespeichert.
 * Gleiche Rohdaten liegen nur einmal vor (Prüfsumme) – ein Warnfeed liefert alle paar Minuten dieselben Meldungen.
 *
 * Grenzen: Löschfrist `privacy.receipt_days` (lib/retention.ts), höchstens RECEIPT_CAP Einträge je Verbindung,
 * höchstens RECEIPT_MAX_ITEMS Meldungen je Eintrag, Rohdaten je Meldung höchstens RAW_MAX_BYTES (gekürzt mit Hinweis).
 * Das Protokoll darf den eigentlichen Abruf nie stören: Fehler beim Speichern landen nur im Systemprotokoll.
 */

export type ReceiptTrigger = 'scheduled' | 'manual' | 'inbound' | 'test';
export type ReceiptDecision = 'accepted' | 'updated' | 'known' | 'filtered' | 'dismissed' | 'suppressed' | 'error' | 'test';

export const TRIGGER_LABEL: Record<ReceiptTrigger, string> = { scheduled: 'Planmäßiger Abruf', manual: '„Jetzt abrufen“', inbound: 'Eingehende Meldung', test: 'Test' };
export const DECISION_LABEL: Record<ReceiptDecision, string> = {
  accepted: 'übernommen',
  updated: 'Aktualisierung',
  known: 'schon bekannt',
  filtered: 'herausgefiltert',
  dismissed: 'ausgeblendet',
  suppressed: 'gesperrt',
  error: 'Fehler',
  test: 'Test',
};

/** Filtergruppen der Oberfläche („nur übernommene / nur herausgefilterte / Fehler“). */
export const DECISION_GROUPS = {
  accepted: ['accepted', 'updated'],
  filtered: ['filtered', 'dismissed', 'suppressed'],
  error: ['error'],
} as const satisfies Record<string, readonly ReceiptDecision[]>;
export type ReceiptFilter = keyof typeof DECISION_GROUPS;

/** Höchstens so viele Einträge je Verbindung – ein Abruf alle 2 Minuten füllt die Datenbank so nicht. */
export const RECEIPT_CAP = 500;
/** Höchstens so viele Meldungen je Eintrag (NINA liefert höchstens 50, Connect höchstens 101). */
export const RECEIPT_MAX_ITEMS = 200;
/** Rohdaten je Meldung (formatiertes JSON); längere werden gekürzt gespeichert. */
export const RAW_MAX_BYTES = 128 * 1024;

export interface ReceiptItem {
  decision: ReceiptDecision;
  reason: string;
  info: Record<string, unknown>;
  /** Rohdaten der Meldung – bei FE2/Feuersoftware nur geschwärzt übergeben. undefined = keine. */
  raw?: unknown;
}

const inGroup = (d: ReceiptDecision, g: ReceiptFilter) => (DECISION_GROUPS[g] as readonly string[]).includes(d);

/** Rohdaten als formatiertes JSON mit Prüfsumme; zu große werden gekürzt. */
export function packRaw(raw: unknown): { hash: string; body: string; truncated: boolean; bytes: number } {
  let body = JSON.stringify(raw, null, 2) ?? 'null';
  const bytes = Buffer.byteLength(body);
  const truncated = bytes > RAW_MAX_BYTES;
  if (truncated) {
    // Byte-genau kürzen, ohne ein Zeichen zu zerschneiden
    body = Buffer.from(body).subarray(0, RAW_MAX_BYTES).toString('utf8').replace(/�$/, '');
  }
  return { hash: crypto.createHash('sha256').update(body).digest('hex'), body, truncated, bytes };
}

/** Sammelt die Meldungen eines Abrufs bzw. einer eingehenden Meldung und speichert sie am Ende in einem Zug. */
export class Receipt {
  private items: ReceiptItem[] = [];
  private dropped = 0;
  private finished = false;
  private readonly started = Date.now();
  /** HTTP-Status der (letzten) Antwort der Quelle bzw. der eigenen Antwort beim FE2-Eingang */
  httpStatus: number | null = null;

  constructor(
    readonly connectionId: string,
    readonly trigger: ReceiptTrigger,
  ) {}

  add(item: ReceiptItem) {
    if (this.items.length >= RECEIPT_MAX_ITEMS) {
      this.dropped++;
      return;
    }
    this.items.push({ ...item, reason: String(item.reason ?? '').slice(0, 1000) });
  }

  get size() {
    return this.items.length + this.dropped;
  }

  /** Speichert den Eintrag. Wirft nie – ein Fehler beim Protokollieren darf den Abruf nicht scheitern lassen. */
  async finish(r: { ok: boolean; error?: string | null; received?: number; httpStatus?: number | null; summary?: string | null }): Promise<string | null> {
    // Nur einmal speichern (ein Fehler nach dem Speichern darf keinen zweiten Eintrag erzeugen)
    if (this.finished) return null;
    this.finished = true;
    try {
      const count = (g: ReceiptFilter) => this.items.filter((i) => inGroup(i.decision, g)).length;
      const summary = [r.summary, this.dropped ? `${this.dropped} weitere Meldung(en) nicht einzeln protokolliert (höchstens ${RECEIPT_MAX_ITEMS} je Eintrag).` : null].filter(Boolean).join(' ') || null;
      const raws = new Map<string, ReturnType<typeof packRaw>>();
      const rows = this.items.map((it, position) => {
        let rawHash: string | null = null;
        if (it.raw !== undefined) {
          const p = packRaw(it.raw);
          raws.set(p.hash, p);
          rawHash = p.hash;
        }
        return { position, decision: it.decision, reason: it.reason, info: it.info ?? {}, raw_hash: rawHash };
      });
      return await tx(async (db) => {
        const row = await one<{ id: string }>(
          `INSERT INTO connection_receipts (connection_id, trigger, ok, error, http_status, duration_ms, received, accepted, filtered, errors, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            this.connectionId,
            this.trigger,
            r.ok,
            r.error ? String(r.error).slice(0, 1000) : null,
            r.httpStatus ?? this.httpStatus,
            Date.now() - this.started,
            r.received ?? this.size,
            count('accepted'),
            count('filtered'),
            count('error'),
            summary ? summary.slice(0, 1000) : null,
          ],
          db,
        );
        if (raws.size) {
          await db.query(
            `INSERT INTO connection_receipt_raws (hash, body, truncated, bytes)
             SELECT x.hash, x.body, x.truncated, x.bytes FROM jsonb_to_recordset($1::jsonb) AS x(hash text, body text, truncated boolean, bytes integer)
             ON CONFLICT (hash) DO UPDATE SET last_used_at = now()`,
            [JSON.stringify([...raws.values()])],
          );
        }
        if (rows.length) {
          await db.query(
            `INSERT INTO connection_receipt_items (receipt_id, position, decision, reason, info, raw_hash)
             SELECT $1, x.position, x.decision, x.reason, x.info, x.raw_hash FROM jsonb_to_recordset($2::jsonb) AS x(position integer, decision text, reason text, info jsonb, raw_hash text)`,
            [row!.id, JSON.stringify(rows)],
          );
        }
        // Obergrenze je Verbindung: älteste Einträge (samt Meldungen) entfernen
        await db.query(
          `DELETE FROM connection_receipts WHERE id IN (SELECT id FROM connection_receipts WHERE connection_id = $1 ORDER BY created_at DESC, id DESC OFFSET $2)`,
          [this.connectionId, RECEIPT_CAP],
        );
        return row!.id;
      });
    } catch (e: any) {
      log('warn', 'receipts', `Empfangsprotokoll nicht gespeichert: ${e?.message ?? e}`);
      return null;
    }
  }
}

/**
 * Rohdaten ohne Bezug entfernen (nach Löschfrist und Obergrenze). Erst eine Stunde nach der letzten Verwendung, damit
 * ein gerade laufender Abruf, der dieselben Rohdaten erneut meldet, sie nicht verliert.
 */
export async function purgeOrphanRaws(): Promise<number> {
  const r = await pool.query(
    `DELETE FROM connection_receipt_raws b WHERE b.hash IN (
       SELECT b2.hash FROM connection_receipt_raws b2 WHERE b2.last_used_at < now() - interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM connection_receipt_items i WHERE i.raw_hash = b2.hash) LIMIT 20000)`,
  );
  return r.rowCount ?? 0;
}

/* ------------------------------------------------------------ Abfragen für die Oberfläche */

const FILTER_SQL: Record<ReceiptFilter, string> = {
  accepted: 'r.accepted > 0',
  filtered: 'r.filtered > 0',
  error: '(NOT r.ok OR r.errors > 0)',
};

export async function listReceipts(connectionId: string, opts: { filter?: ReceiptFilter | null; page: number; limit: number }) {
  const where = opts.filter ? ` AND ${FILTER_SQL[opts.filter]}` : '';
  const rows = await many<any>(
    `SELECT r.id, r.trigger, r.ok, r.error, r.http_status, r.duration_ms, r.received, r.accepted, r.filtered, r.errors, r.summary, r.created_at, count(*) OVER () AS total
       FROM connection_receipts r WHERE r.connection_id = $1${where}
      ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`,
    [connectionId, opts.limit, (opts.page - 1) * opts.limit],
  );
  const total = rows.length ? Number(rows[0].total) : opts.page > 1 ? Number((await one<any>(`SELECT count(*)::int AS n FROM connection_receipts r WHERE r.connection_id = $1${where}`, [connectionId]))?.n ?? 0) : 0;
  return {
    items: rows.map(({ total: _t, ...r }) => ({ ...r, trigger_label: TRIGGER_LABEL[r.trigger as ReceiptTrigger] ?? r.trigger })),
    total,
    page: opts.page,
    limit: opts.limit,
  };
}

export async function receiptItems(connectionId: string, receiptId: string, filter?: ReceiptFilter | null) {
  const rec = await one<any>(`SELECT id FROM connection_receipts WHERE id = $1 AND connection_id = $2`, [receiptId, connectionId]);
  if (!rec) return null;
  const rows = await many<any>(
    `SELECT i.id, i.position, i.decision, i.reason, i.info, i.raw_hash IS NOT NULL AS has_raw, b.truncated AS raw_truncated
       FROM connection_receipt_items i LEFT JOIN connection_receipt_raws b ON b.hash = i.raw_hash
      WHERE i.receipt_id = $1 AND ($2::text[] IS NULL OR i.decision = ANY($2::text[])) ORDER BY i.position`,
    [receiptId, filter ? [...DECISION_GROUPS[filter]] : null],
  );
  return rows.map((r) => ({ ...r, raw_truncated: !!r.raw_truncated, decision_label: DECISION_LABEL[r.decision as ReceiptDecision] ?? r.decision }));
}

export async function receiptRaw(connectionId: string, receiptId: string, itemId: string) {
  return one<{ body: string; truncated: boolean; bytes: number }>(
    `SELECT b.body, b.truncated, b.bytes FROM connection_receipt_items i
       JOIN connection_receipts r ON r.id = i.receipt_id
       JOIN connection_receipt_raws b ON b.hash = i.raw_hash
      WHERE i.id = $1 AND r.id = $2 AND r.connection_id = $3`,
    [itemId, receiptId, connectionId],
  );
}

/* ------------------------------------------------------------ Schwärzen (FE2, Feuersoftware) */

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

/**
 * Felder, deren Werte stehen bleiben dürfen (Allowlist wie bei FE2: Stichwort, Einsatzart, Ort/Ortsteil, Zeiten,
 * Status, RIC, Einheiten, Kennung). Alles andere wird durch einen Platzhalter mit Art und Länge ersetzt, damit die
 * Struktur der Meldung (für die Feldzuordnung) sichtbar bleibt, aber kein Inhalt.
 */
const SAFE_KEYS = new Set(
  [
    'id', 'einsatzid', 'operationid', 'eventid', 'stichwort', 'keyword', 'stichworttext', 'keywordtext', 'stichwortklartext', 'einsatzart', 'category',
    'kategorie', 'ort', 'city', 'gemeinde', 'municipality', 'stadt', 'ortsteil', 'district', 'citywithdistrict', 'alarmzeit', 'alarmierungszeit',
    'alarmtime', 'start', 'startzeit', 'begin', 'end', 'ende', 'endzeit', 'createdat', 'lastupdateat', 'updatedat', 'timestamp', 'status', 'state',
    'priority', 'prioritaet', 'priorität', 'ric', 'rics', 'source', 'quelle', 'siteid', 'type', 'typ',
  ].map(normKey),
);
/** Unterhalb dieser Felder ist alles personenbezogen (meldende Person, Betroffene, Kontakte). */
const PERSON_KEYS = new Set(
  ['anrufer', 'caller', 'melder', 'meldender', 'meldendeperson', 'mitteiler', 'reporter', 'informant', 'patient', 'patienten', 'person', 'personen', 'betroffene', 'betroffener', 'kontakt', 'contact', 'verletzte', 'sender', 'sendername', 'absender'].map(normKey),
);
/** Koordinaten werden ganz entfernt (auch gerundet verraten sie bei Einsätzen oft das Haus). */
const GEO_KEYS = new Set(['lat', 'lng', 'lon', 'long', 'latitude', 'longitude', 'koordinaten', 'koordinate', 'coordinates', 'coordinate', 'geo', 'gps', 'position', 'geometry', 'x', 'y', 'utm', 'rechtswert', 'hochwert', 'geokoordinaten'].map(normKey));
/** Einheiten/Alarmgruppen: deren Namen und Kennungen bleiben stehen. */
const UNIT_KEYS = new Set(['einheiten', 'units', 'fahrzeuge', 'vehicles', 'alarmgruppen', 'groups', 'ressourcen', 'resources'].map(normKey));
const UNIT_SAFE = new Set(['name', 'bezeichnung', 'kennung', 'address', 'funkrufname', 'callsign', 'id'].map(normKey));

const MAX_DEPTH = 8;
const MAX_ARRAY = 50;
const MAX_KEYS = 200;
const MAX_KEPT_TEXT = 200;

function mask(v: string | number | bigint): string {
  if (typeof v === 'string') return `‹ausgeblendet: Text, ${v.length} Zeichen›`;
  return '‹ausgeblendet: Zahl›';
}

/** Personenbezogenes in erlaubten Texten erkennen und ersetzen: E-Mail, Telefonnummer, Straße mit Hausnummer. */
export function scrubText(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '‹E-Mail›')
    .replace(/[\p{L}ß.-]*(?:straße|strasse|str\.|weg|gasse|allee|platz|ring|damm|ufer|chaussee|steig|pfad)\s*\d+\s*[a-z]?\b/giu, '‹Adresse›')
    .replace(/(?:\+|\b0)[\d\s/()-]{5,}\d/g, '‹Telefon›');
}

function keepValue(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return v.length > MAX_KEPT_TEXT ? mask(v) : scrubText(v);
  if (depth > MAX_DEPTH) return '‹ausgeblendet: zu tief verschachtelt›';
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => keepValue(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).slice(0, MAX_KEYS).map(([k, x]) => [k, GEO_KEYS.has(normKey(k)) ? '‹entfernt: Koordinate›' : PERSON_KEYS.has(normKey(k)) ? redactAll(x) : keepValue(x, depth + 1)]));
  return mask(String(v));
}

function redactAll(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string' || typeof v === 'number') return mask(v);
  if (depth > MAX_DEPTH) return '‹ausgeblendet: zu tief verschachtelt›';
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => redactAll(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).slice(0, MAX_KEYS).map(([k, x]) => [k, redactAll(x, depth + 1)]));
  return '‹ausgeblendet›';
}

/**
 * Geschwärzte Kopie einer Einsatzmeldung (FE2-Eingang, Feuersoftware Connect) für das Empfangsprotokoll.
 * `keepPaths`: Pfade der FE2-Feldzuordnung (Punkte für Verschachtelung) – deren Werte werden ohnehin übernommen.
 * Werte sonstiger Felder werden durch „‹ausgeblendet: Text, n Zeichen›“ ersetzt, Koordinaten entfernt, alles
 * unterhalb von meldender Person/Betroffenen/Kontakt ausgeblendet; auch erlaubte Texte werden auf E-Mail-Adressen,
 * Telefonnummern und Straßen mit Hausnummer geprüft.
 */
export function redactIncidentPayload(payload: unknown, opts: { keepPaths?: string[] } = {}): unknown {
  const keep = new Set((opts.keepPaths ?? []).filter(Boolean));
  const walk = (v: unknown, path: string[], person: boolean, unit: boolean, depth: number): unknown => {
    const key = normKey(path[path.length - 1] ?? '');
    if (!person && keep.has(path.join('.'))) return keepValue(v);
    if (depth > MAX_DEPTH) return '‹ausgeblendet: zu tief verschachtelt›';
    if (v === null || v === undefined || typeof v === 'boolean') return v ?? null;
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_ARRAY).map((x) => walk(x, path, person, unit, depth + 1));
      if (v.length > MAX_ARRAY) out.push(`‹${v.length - MAX_ARRAY} weitere Einträge›`);
      return out;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as object);
      const out: Record<string, unknown> = {};
      for (const [k, x] of entries.slice(0, MAX_KEYS)) {
        const nk = normKey(k);
        if (GEO_KEYS.has(nk)) out[k] = x == null ? null : '‹entfernt: Koordinate›';
        else out[k] = walk(x, [...path, k], person || PERSON_KEYS.has(nk), unit || UNIT_KEYS.has(nk), depth + 1);
      }
      if (entries.length > MAX_KEYS) out['…'] = `‹${entries.length - MAX_KEYS} weitere Felder›`;
      return out;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return '‹ausgeblendet›';
    if (person || PERSON_KEYS.has(key)) return mask(v);
    if (SAFE_KEYS.has(key) || UNIT_KEYS.has(key) || (unit && UNIT_SAFE.has(key))) return keepValue(v);
    return mask(v);
  };
  return walk(payload, [], false, false, 0);
}
