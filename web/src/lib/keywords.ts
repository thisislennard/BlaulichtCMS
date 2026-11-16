import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client';
import { useAuth } from './auth';

/**
 * Stichwortverzeichnis (#195): aktive Stichwortliste zum Nachschlagen. Der Abgleich entspricht
 * server/src/keywords/catalog.ts (resolveKeyword): Schreibweise egal, Untergliederungen wie „F2 W“ zählen zum
 * Stichwort „F 2“, unbekannte Stichworte bleiben roh stehen.
 */
export interface KeywordEntry {
  code: string;
  label: string;
  category: string;
  details: string;
  source: string;
  aliases: string[];
}
export interface KeywordsResponse {
  state: string;
  stateName: string;
  states: { id: string; name: string; catalog: boolean; hinweis: string | null }[];
  catalog: null | { land: string; name: string; version: string; titel: string; stand: string; gueltig: string; quelle: string; hinweis: string; vorgaenger: null | { titel: string; stand: string; quelle: string; hinweis: string }; anzahl: number };
  noCatalogText: string | null;
  entries: KeywordEntry[];
}

/** Bundesländer für die Einstellung – dieselben Kürzel wie server/src/keywords/catalog.ts (STATES). */
export const STATE_OPTIONS: { id: string; name: string }[] = [
  { id: 'BW', name: 'Baden-Württemberg' },
  { id: 'BY', name: 'Bayern' },
  { id: 'BE', name: 'Berlin' },
  { id: 'BB', name: 'Brandenburg' },
  { id: 'HB', name: 'Bremen' },
  { id: 'HH', name: 'Hamburg' },
  { id: 'HE', name: 'Hessen' },
  { id: 'MV', name: 'Mecklenburg-Vorpommern' },
  { id: 'NI', name: 'Niedersachsen' },
  { id: 'NW', name: 'Nordrhein-Westfalen' },
  { id: 'RP', name: 'Rheinland-Pfalz' },
  { id: 'SL', name: 'Saarland' },
  { id: 'SN', name: 'Sachsen' },
  { id: 'ST', name: 'Sachsen-Anhalt' },
  { id: 'SH', name: 'Schleswig-Holstein' },
  { id: 'TH', name: 'Thüringen' },
];
/** Länder mit mitgeliefertem Verzeichnis (für den Hinweis in den Einstellungen). */
export const STATES_WITH_CATALOG = ['BY', 'HE'];

export function normalizeCode(code: string): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[\s\-‐‑–—_]+/g, '');
}

export function resolveKeyword(raw: string | null | undefined, list: KeywordEntry[]): { entry: KeywordEntry; partial: boolean } | null {
  const n = normalizeCode(raw ?? '');
  if (!n) return null;
  let best: KeywordEntry | null = null;
  let bestLen = 0;
  for (const k of list) {
    for (const c of [k.code, ...(k.aliases ?? [])]) {
      const kn = normalizeCode(c);
      if (!kn) continue;
      if (kn === n) return { entry: k, partial: false };
      if (kn.length > bestLen && n.startsWith(kn)) {
        const next = n[kn.length];
        const boundary = !/[A-Z0-9ÄÖÜ]/.test(next) || /\d/.test(kn[kn.length - 1]) !== /\d/.test(next);
        if (boundary) {
          best = k;
          bestLen = kn.length;
        }
      }
    }
  }
  return best ? { entry: best, partial: true } : null;
}

/** Bedeutung ohne das Kürzel selbst (Verzeichnisse ohne Meldebild führen das Kürzel als Bezeichnung). */
export function meaning(k: KeywordEntry): string {
  return normalizeCode(k.label) === normalizeCode(k.code) ? '' : k.label;
}

/** Aktive Stichwortliste; nur mit einem der Leserechte (Warnvorgänge, Automationen, Verbindungen). */
export function useKeywords() {
  const { can } = useAuth();
  const allowed = can('warning.view') || can('automation.read') || can('connection.view');
  return useQuery({ queryKey: ['keywords'], queryFn: () => get<KeywordsResponse>('/keywords'), enabled: allowed, staleTime: 5 * 60_000 });
}
