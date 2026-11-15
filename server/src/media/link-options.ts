import { badRequest } from '../lib/errors.js';

/*
 * Erweiterte Optionen eines Upload-Links wie LiFeOS (Paket 6): abgefragte Angaben der Hochladenden (je aus, optional,
 * Pflicht), Bestätigung vor dem Upload und Grenzen. Reine Funktionen ohne Datenbank.
 */
export const FIELD_KEYS = ['name', 'email', 'note', 'place', 'date'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export type FieldMode = 'off' | 'optional' | 'required';
export type Fields = Record<FieldKey, FieldMode>;

export const FIELD_LABELS: Record<FieldKey, string> = { name: 'Name', email: 'E-Mail-Adresse', note: 'Hinweis', place: 'Aufnahmeort', date: 'Aufnahmedatum' };

/** Standard wie bisher in BlaulichtCMS: nur ein freiwilliger Hinweis, bewusst ohne Namen. */
export const DEFAULT_FIELDS: Fields = { name: 'off', email: 'off', note: 'optional', place: 'off', date: 'off' };

export function cleanFields(raw: unknown): Fields {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_FIELDS };
  for (const k of FIELD_KEYS) if (src[k] === 'off' || src[k] === 'optional' || src[k] === 'required') out[k] = src[k] as FieldMode;
  return out;
}

export interface UploaderInput {
  name?: string;
  email?: string;
  place?: string;
  date?: string;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/**
 * Angaben der Hochladenden prüfen und bereinigen: abgeschaltete Felder werden verworfen, Pflichtfelder verlangt.
 * Der Hinweis (note) läuft wie bisher getrennt (uploader_note). Ergebnis: Objekt nur mit ausgefüllten Feldern oder null.
 */
export function cleanUploader(fields: Fields, input: UploaderInput | undefined, note: string): Record<string, string> | null {
  const v = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const out: Record<string, string> = {};
  const values: Record<Exclude<FieldKey, 'note'>, string> = { name: v(input?.name, 120), email: v(input?.email, 200), place: v(input?.place, 200), date: v(input?.date, 10) };
  for (const k of ['name', 'email', 'place', 'date'] as const) {
    if (fields[k] === 'off') continue;
    if (!values[k]) {
      if (fields[k] === 'required') throw badRequest(`Bitte „${FIELD_LABELS[k]}“ angeben.`);
      continue;
    }
    out[k] = values[k];
  }
  if (fields.note === 'required' && !note.trim()) throw badRequest('Bitte einen Hinweis angeben.');
  if (out.email && !EMAIL_RE.test(out.email)) throw badRequest('Bitte eine gültige E-Mail-Adresse angeben.');
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw badRequest('Aufnahmedatum: bitte als Datum angeben.');
  return Object.keys(out).length ? out : null;
}

export interface LinkUsage {
  uploads: number;
  bytes: number;
}

/** Ist das Kontingent eines Links erreicht (Uploads oder Gesamtgröße)? 0 = unbegrenzt. */
export function linkIsFull(l: { max_uploads?: number | null; max_total_bytes?: number | string | null }, usage: LinkUsage): boolean {
  if (Number(l.max_uploads) > 0 && usage.uploads >= Number(l.max_uploads)) return true;
  return Number(l.max_total_bytes) > 0 && usage.bytes >= Number(l.max_total_bytes);
}
