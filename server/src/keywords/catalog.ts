/**
 * Stichwortverzeichnisse der Länder (#195). Mitgeliefert werden nur Verzeichnisse, die eine Landesstelle öffentlich
 * bereitstellt und die wortgetreu abgeschrieben sind (catalogs/*.json mit Quelle, Titel und Stand). Für alle anderen
 * Länder gibt es nur den Hinweis, eine eigene Liste zu importieren – nichts wird ergänzt oder erfunden.
 *
 * Das gewählte Verzeichnis (Einstellung `general.state`) wird in `fire_keywords` übernommen (keywords/store.ts); dort
 * stehen auch die eigenen Einträge (Quelle „eigen“), die gleichnamige Einträge des Verzeichnisses überschreiben.
 */
import he from './catalogs/he.json' with { type: 'json' };
import by from './catalogs/by.json' with { type: 'json' };

export interface CatalogPart {
  titel?: string;
  punkte?: string[];
}
export interface CatalogEntry {
  code: string;
  kategorie: string;
  /** Frühere Schreibweise desselben Stichworts (z. B. aus der Vorgängerfassung), nur für den Abgleich */
  aliase?: string[];
  /** Spalte „Meldebild“: Überschriften und Aufzählungspunkte wie im Dokument (leer, wenn das Dokument nur Kürzel nennt) */
  meldebild: CatalogPart[];
}
export interface Catalog {
  land: string;
  version: string;
  titel: string;
  stand: string;
  gueltig: string;
  quelle: string;
  hinweis: string;
  vorgaenger?: { titel: string; stand: string; quelle: string; hinweis: string };
  kategorien: Record<string, string>;
  eintraege: CatalogEntry[];
}

export interface StateDef {
  id: string;
  name: string;
  /** Kurzer, belegter Hinweis, warum kein Verzeichnis hinterlegt ist (nur wo eine amtliche Aussage gefunden wurde) */
  hinweis?: string;
}

export const STATES: StateDef[] = [
  { id: 'BW', name: 'Baden-Württemberg', hinweis: 'Landeseinheitliche Einsatzstichworte sind laut Innenministerium noch zu entwickeln.' },
  { id: 'BY', name: 'Bayern' },
  { id: 'BE', name: 'Berlin', hinweis: 'Die Stichworte der Berliner Feuerwehr sind nicht öffentlich (Verschlusssache).' },
  { id: 'BB', name: 'Brandenburg', hinweis: 'Die Regionalleitstellen nutzen einen gemeinsamen Katalog, der aber nicht vom Land veröffentlicht wird.' },
  { id: 'HB', name: 'Bremen' },
  { id: 'HH', name: 'Hamburg' },
  { id: 'HE', name: 'Hessen' },
  { id: 'MV', name: 'Mecklenburg-Vorpommern' },
  { id: 'NI', name: 'Niedersachsen' },
  { id: 'NW', name: 'Nordrhein-Westfalen' },
  { id: 'RP', name: 'Rheinland-Pfalz' },
  { id: 'SL', name: 'Saarland' },
  { id: 'SN', name: 'Sachsen', hinweis: 'Die Landesrettungsdienstplanverordnung gibt nur Rahmen-Stichworte mit Kategorien vor, kein vollständiges Verzeichnis.' },
  { id: 'ST', name: 'Sachsen-Anhalt' },
  { id: 'SH', name: 'Schleswig-Holstein' },
  { id: 'TH', name: 'Thüringen' },
];

/** Eigene Liste: kein mitgeliefertes Verzeichnis, nur selbst gepflegte bzw. importierte Einträge. */
export const OWN_LIST = 'eigen';
export const STATE_IDS = [...STATES.map((s) => s.id), OWN_LIST];

export const CATALOGS: Record<string, Catalog> = { HE: he as Catalog, BY: by as Catalog };

export const NO_CATALOG_TEXT = 'Kein öffentliches Verzeichnis hinterlegt – eigene Liste importieren.';

export function stateName(id: string): string {
  if (id === OWN_LIST) return 'Eigene Liste';
  return STATES.find((s) => s.id === id)?.name ?? '';
}

/** Vergleichsform eines Stichworts: Groß-/Kleinschreibung, Leerzeichen und Bindestriche zählen nicht („F2“ = „F 2“). */
export function normalizeCode(code: string): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[\s\-‐‑–—_]+/g, '');
}

const OPEN_END = /\s(eines|einer|einem|in|von|mit)$/;
const lowerStart = (s: string) => /^[a-zäöü]/.test(s);
const joinParts = (parts: string[]) => parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}${lowerStart(p) ? ' ' : '; '}${p}`), '');
const points = (p: CatalogPart) => (p.punkte ?? []).filter((x) => x !== 'ähnliche Meldebilder');

/**
 * Kurzbezeichnung aus dem Meldebild, nur aus Wörtern des Dokuments: Überschriften; endet eine Überschrift offen
 * („Brand eines“) oder fehlt sie, kommen die Aufzählungspunkte dazu. Leer, wenn das Dokument nur das Kürzel nennt.
 */
export function entryLabel(e: CatalogEntry): string {
  return joinParts(
    e.meldebild
      .map((p) => {
        if (!p.titel) return points(p).join(', ');
        return OPEN_END.test(p.titel) && points(p).length ? `${p.titel} ${points(p).join(', ')}` : p.titel;
      })
      .filter(Boolean),
  );
}

/** Ausführliche Beschreibung: Überschriften mit allen Aufzählungspunkten. */
export function entryDetails(e: CatalogEntry): string {
  return joinParts(
    e.meldebild
      .map((p) => {
        const pts = points(p);
        if (p.titel && pts.length) return `${p.titel} (${pts.join(', ')})`;
        return p.titel || pts.join(', ');
      })
      .filter(Boolean),
  );
}

export interface ResolvableKeyword {
  code: string;
  aliases?: string[];
}

/**
 * Stichwort einer Einsatzmeldung im Verzeichnis finden: zuerst genau (auch über Aliase), sonst das längste Stichwort,
 * das als Präfix mit erkennbarer Grenze davorsteht – der hessische Erlass erlaubt Untergliederungen wie „F2 W“ oder
 * „F2.1“. „H 10“ gilt dagegen nicht als „H 1“. Unbekannte Stichworte bleiben unaufgelöst (null).
 */
export function resolveKeyword<T extends ResolvableKeyword>(raw: string, list: T[]): { entry: T; partial: boolean } | null {
  const n = normalizeCode(raw);
  if (!n) return null;
  let best: T | null = null;
  let bestLen = 0;
  for (const k of list) {
    for (const c of [k.code, ...(k.aliases ?? [])]) {
      const kn = normalizeCode(c);
      if (!kn) continue;
      if (kn === n) return { entry: k, partial: false };
      if (kn.length > bestLen && n.startsWith(kn)) {
        const next = n[kn.length];
        const last = kn[kn.length - 1];
        const boundary = !/[A-Z0-9ÄÖÜ]/.test(next) || /\d/.test(last) !== /\d/.test(next);
        if (boundary) {
          best = k;
          bestLen = kn.length;
        }
      }
    }
  }
  return best ? { entry: best, partial: true } : null;
}

/** Beschreibung des gewählten Verzeichnisses für Oberfläche und Hilfe (ohne Einträge). */
export function catalogInfo(state: string) {
  const c = CATALOGS[state];
  if (!c) return null;
  return { land: c.land, name: stateName(c.land), version: c.version, titel: c.titel, stand: c.stand, gueltig: c.gueltig, quelle: c.quelle, hinweis: c.hinweis, vorgaenger: c.vorgaenger ?? null, anzahl: c.eintraege.length };
}
