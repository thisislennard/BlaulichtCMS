import { badRequest } from '../lib/errors.js';

/**
 * Reine Hilfen für Upload-Links (Gültigkeit, Zustand) – ohne Datenbank, damit sie sich einzeln testen lassen.
 *
 * Gültigkeit wie in LiFeOS: feste Dauer in Stunden oder Tagen (Voreinstellungen 6 h, 24 h, 3 Tage, 7 Tage) oder
 * „Bis Termin“ (Datum und Uhrzeit). Ein Termin liegt mindestens 5 Minuten in der Zukunft und höchstens
 * `media.link_max_days` Tage entfernt.
 */
export const LINK_MIN_LEAD_MS = 5 * 60_000;

export type LinkState = 'active' | 'paused' | 'expired' | 'revoked';

export function linkState(l: { revoked_at?: unknown; paused_at?: unknown; expires_at: string | Date }, now = Date.now()): LinkState {
  if (l.revoked_at) return 'revoked';
  if (new Date(l.expires_at).getTime() <= now) return 'expired';
  if (l.paused_at) return 'paused';
  return 'active';
}

export interface ExpiryInput {
  hours?: number;
  days?: number;
  /** ISO-Zeitpunkt („Bis Termin“) */
  expiresAt?: string;
}

/** Ablaufzeitpunkt eines neuen Links bzw. eines neuen Termins; wirft 400 mit verständlicher Meldung. */
export function computeExpiry(input: ExpiryInput, opts: { defaultDays: number; maxDays: number }, now = Date.now()): Date {
  const maxMs = opts.maxDays * 86400_000;
  if (input.expiresAt) {
    const t = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(t)) throw badRequest('Ablauftermin: bitte Datum und Uhrzeit angeben.');
    if (t < now + LINK_MIN_LEAD_MS) throw badRequest('Ablauftermin: muss mindestens 5 Minuten in der Zukunft liegen.');
    if (t > now + maxMs) throw badRequest(`Ablauftermin: höchstens ${opts.maxDays} Tage ab jetzt.`);
    return new Date(t);
  }
  const hours = input.hours ?? (input.days ?? opts.defaultDays) * 24;
  if (!Number.isFinite(hours) || hours < 1) throw badRequest('Gültigkeit: mindestens 1 Stunde.');
  return new Date(now + Math.min(hours * 3600_000, maxMs));
}

/** Verlängern um eine Dauer: ab dem bisherigen Ablauf (bzw. ab jetzt, wenn schon abgelaufen), höchstens bis zur Grenze. */
export function extendExpiry(current: string | Date, hours: number, maxDays: number, now = Date.now()): Date {
  if (!Number.isFinite(hours) || hours < 1) throw badRequest('Verlängerung: mindestens 1 Stunde.');
  const base = Math.max(new Date(current).getTime(), now);
  return new Date(Math.min(base + hours * 3600_000, now + maxDays * 86400_000));
}

/** Einheitliche Meldung für unbekannte, abgelaufene, pausierte, widerrufene und geschlossene Links (verrät nichts). */
export const LINK_UNAVAILABLE = 'Dieser Link funktioniert nicht (mehr). Bitte bei der Redaktion einen aktuellen Link oder QR-Code erfragen.';
