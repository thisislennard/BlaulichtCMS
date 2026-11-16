/**
 * Aktive Stichwortliste (#195) = Tabelle `fire_keywords`: übernommenes Landesverzeichnis (source = Länderkürzel) plus
 * eigene Einträge (source = 'eigen'). Eigene Einträge haben Vorrang – beim Übernehmen eines Verzeichnisses bleibt ein
 * gleichnamiger eigener Eintrag unverändert. Stichwörter werden nie gelöscht, nur deaktiviert, damit Regeln,
 * Lagefragen und Warnvorgänge ihren Bezug behalten.
 */
import { many, pool, tx, type Queryable } from '../db/pool.js';
import { getSettings } from '../lib/settings.js';
import { CATALOGS, entryDetails, entryLabel, normalizeCode, OWN_LIST, resolveKeyword } from './catalog.js';

export interface KeywordRow {
  id: string;
  code: string;
  label: string;
  category: string;
  details: string;
  source: string;
  aliases: string[];
  active: boolean;
}

/* ------------------------------------------------------------ Nachschlagen (mit kurzem Zwischenspeicher) */

let cache: { at: number; list: KeywordRow[] } | null = null;
const TTL_MS = 30_000;

export function invalidateKeywords() {
  cache = null;
}

export async function activeKeywords(db: Queryable = pool): Promise<KeywordRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const list = await many<KeywordRow>(`SELECT id, code, label, category, details, source, aliases, active FROM fire_keywords WHERE active ORDER BY code`, [], db);
  cache = { at: Date.now(), list };
  return list;
}

/** Bedeutung eines Stichworts aus einer Einsatzmeldung (null = unbekannt, bleibt roh stehen). */
export async function lookupKeyword(raw: string | null | undefined, db: Queryable = pool) {
  if (!raw) return null;
  const hit = resolveKeyword(raw, await activeKeywords(db));
  if (!hit) return null;
  // Verzeichnisse ohne Meldebild (z. B. Bayern) führen das Kürzel als Bezeichnung – das ist keine Bedeutung
  const label = normalizeCode(hit.entry.label) === normalizeCode(hit.entry.code) ? '' : hit.entry.label;
  return { code: hit.entry.code, label, category: hit.entry.category, partial: hit.partial };
}

/**
 * Einsatzfelder ergänzen: Liefert die Quelle zum Stichwort keinen Klartext, kommt er aus der aktiven Liste
 * (Kurzbezeichnung, sonst Kategorie). Gelieferter Klartext bleibt unverändert.
 */
export async function withKeywordText<T extends { keyword?: string; keyword_text?: string }>(fields: T, db: Queryable = pool): Promise<T> {
  if (!fields.keyword || fields.keyword_text) return fields;
  try {
    const k = await lookupKeyword(fields.keyword, db);
    const text = k ? k.label || k.category : '';
    return text ? { ...fields, keyword_text: text.slice(0, 200) } : fields;
  } catch {
    return fields;
  }
}

/* ------------------------------------------------------------ Verzeichnis übernehmen */

export interface SyncResult {
  added: number;
  updated: number;
  deactivated: number;
  ownKept: number;
}

/**
 * Verzeichnis des Landes in die aktive Liste übernehmen. `activate`: beim Wechsel des Landes die Einträge des neuen
 * Verzeichnisses (wieder) aktivieren; beim bloßen Auffrischen bleibt ein von Hand deaktivierter Eintrag aus.
 * Einträge anderer Verzeichnisse und nicht mehr enthaltene Einträge werden deaktiviert, eigene nie angefasst.
 */
export async function syncCatalog(state: string, opts: { activate: boolean }): Promise<SyncResult> {
  const cat = CATALOGS[state];
  const res: SyncResult = { added: 0, updated: 0, deactivated: 0, ownKept: 0 };
  await tx(async (db) => {
    await db.query(`LOCK TABLE fire_keywords IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await many<KeywordRow>(`SELECT id, code, label, category, details, source, aliases, active FROM fire_keywords`, [], db);
    const byNorm = new Map(rows.map((r) => [normalizeCode(r.code), r]));
    const kept = new Set<string>();
    for (const e of cat?.eintraege ?? []) {
      const label = entryLabel(e) || e.code;
      const details = entryDetails(e);
      const aliases = e.aliase ?? [];
      const row = byNorm.get(normalizeCode(e.code));
      if (row) {
        kept.add(row.id);
        if (row.source === OWN_LIST) {
          res.ownKept++;
          continue;
        }
        const active = opts.activate || row.source !== state ? true : row.active;
        const changed = row.code !== e.code || row.label !== label || row.category !== e.kategorie || row.details !== details || row.source !== state || row.active !== active || JSON.stringify(row.aliases) !== JSON.stringify(aliases);
        if (changed) {
          await db.query(`UPDATE fire_keywords SET code = $2, label = $3, category = $4, details = $5, source = $6, active = $7, aliases = $8 WHERE id = $1`, [row.id, e.code, label, e.kategorie, details, state, active, aliases]);
          res.updated++;
        }
      } else {
        await db.query(`INSERT INTO fire_keywords (code, label, category, details, source, aliases) VALUES ($1,$2,$3,$4,$5,$6)`, [e.code, label, e.kategorie, details, state, aliases]);
        res.added++;
      }
    }
    for (const r of rows) {
      if (r.source === OWN_LIST || kept.has(r.id) || !r.active) continue;
      await db.query(`UPDATE fire_keywords SET active = false WHERE id = $1`, [r.id]);
      res.deactivated++;
    }
  });
  invalidateKeywords();
  return res;
}

/* ------------------------------------------------------------ Eigene Liste: Import und Export */

export interface ImportRow {
  code: string;
  bezeichnung: string;
  kategorie: string;
}

const HEADER = /^(code|kürzel|kuerzel|stichwort)$/i;

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * Eigene Liste lesen: JSON (Liste von { code, bezeichnung, kategorie }) oder CSV mit Semikolon (oder Komma) in der
 * Reihenfolge code;bezeichnung;kategorie, Kopfzeile optional. Weitere Spalten (z. B. aus dem Export) zählen nicht.
 */
export function parseKeywordList(text: string): { rows: ImportRow[]; errors: string[] } {
  const src = String(text ?? '').replace(/^﻿/, '').trim();
  const errors: string[] = [];
  let raw: { code: unknown; bezeichnung: unknown; kategorie: unknown; line: number }[] = [];
  if (src.startsWith('[') || src.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(src);
    } catch {
      return { rows: [], errors: ['Die Datei ist kein gültiges JSON.'] };
    }
    const list = Array.isArray(data) ? data : Array.isArray((data as any)?.eintraege) ? (data as any).eintraege : null;
    if (!list) return { rows: [], errors: ['JSON: erwartet wird eine Liste von Einträgen mit code, bezeichnung und kategorie.'] };
    raw = list.map((x: any, i: number) => ({ code: x?.code, bezeichnung: x?.bezeichnung ?? x?.label, kategorie: x?.kategorie ?? x?.category ?? '', line: i + 1 }));
  } else {
    const lines = src.split(/\r?\n/);
    const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      const [code = '', bezeichnung = '', kategorie = ''] = splitCsvLine(l, sep);
      if (i === 0 && HEADER.test(code)) return;
      raw.push({ code, bezeichnung, kategorie, line: i + 1 });
    });
  }
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const code = String(r.code ?? '').trim();
    const bezeichnung = String(r.bezeichnung ?? '').trim();
    const kategorie = String(r.kategorie ?? '').trim();
    if (!code || code.length > 40) {
      errors.push(`Zeile ${r.line}: Kürzel fehlt oder ist länger als 40 Zeichen.`);
      continue;
    }
    if (bezeichnung.length < 2 || bezeichnung.length > 300) {
      errors.push(`Zeile ${r.line} (${code}): Bezeichnung muss 2 bis 300 Zeichen haben.`);
      continue;
    }
    if (kategorie.length > 60) {
      errors.push(`Zeile ${r.line} (${code}): Kategorie höchstens 60 Zeichen.`);
      continue;
    }
    const n = normalizeCode(code);
    if (seen.has(n)) {
      errors.push(`Zeile ${r.line}: „${code}“ kommt mehrfach vor.`);
      continue;
    }
    seen.add(n);
    rows.push({ code, bezeichnung, kategorie });
  }
  if (rows.length > 2000) return { rows: [], errors: ['Höchstens 2000 Einträge je Import.'] };
  return { rows, errors };
}

/** Eigene Einträge übernehmen: vorhandene Kürzel (auch aus dem Landesverzeichnis) werden zu eigenen Einträgen. */
export async function importOwnList(rows: ImportRow[], userId: string | null) {
  const res = { added: 0, updated: 0, unchanged: 0 };
  await tx(async (db) => {
    await db.query(`LOCK TABLE fire_keywords IN SHARE ROW EXCLUSIVE MODE`);
    const existing = await many<KeywordRow>(`SELECT id, code, label, category, details, source, aliases, active FROM fire_keywords`, [], db);
    const byNorm = new Map(existing.map((r) => [normalizeCode(r.code), r]));
    for (const r of rows) {
      const row = byNorm.get(normalizeCode(r.code));
      if (!row) {
        await db.query(`INSERT INTO fire_keywords (code, label, category, source, created_by) VALUES ($1,$2,$3,'eigen',$4)`, [r.code, r.bezeichnung, r.kategorie, userId]);
        res.added++;
      } else if (row.label === r.bezeichnung && row.category === r.kategorie && row.source === OWN_LIST && row.active) res.unchanged++;
      else {
        await db.query(`UPDATE fire_keywords SET label = $2, category = $3, source = 'eigen', active = true WHERE id = $1`, [row.id, r.bezeichnung, r.kategorie]);
        res.updated++;
      }
    }
  });
  invalidateKeywords();
  return res;
}

const csvCell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Export der ganzen Liste (aktiv und inaktiv) – als CSV wieder importierbar (code;bezeichnung;kategorie zuerst). */
export async function exportKeywords(format: 'csv' | 'json') {
  const rows = await many<KeywordRow>(`SELECT code, label, category, details, source, active FROM fire_keywords ORDER BY code`);
  if (format === 'json') return JSON.stringify(rows.map((r) => ({ code: r.code, bezeichnung: r.label, kategorie: r.category, meldebild: r.details, quelle: r.source, aktiv: r.active })), null, 2);
  const lines = ['code;bezeichnung;kategorie;quelle;aktiv'];
  for (const r of rows) lines.push([r.code, r.label, r.category, r.source, r.active ? 'ja' : 'nein'].map(csvCell).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Beim Start: Verzeichnis des eingestellten Landes auffrischen (neue Fassung nach einem Update), ohne zu aktivieren. */
export async function refreshKeywordCatalog() {
  const state = String((await getSettings(true))['general.state'] ?? '');
  if (!CATALOGS[state]) return null;
  return syncCatalog(state, { activate: false });
}
