import { pool } from '../db/pool.js';
import { deriveKey, hmacHex, sha256Hex } from './crypto.js';
import { log } from './log.js';

/*
 * Sicherheitsereignisse der öffentlichen Upload-Seiten wie LiFeOS (Paket 7). Nie Token, nie Namen oder E-Mail-Adressen,
 * keine Klar-IP – nur ein gekürzter HMAC der IP (Zuordnung gleicher Geräte, nicht umkehrbar ohne Master-Schlüssel).
 * Gleiche Ereignisse (Art, Link, Gerät) werden höchstens einmal in 10 Minuten gespeichert, damit Scanner das Protokoll
 * nicht fluten. Ereignisse ohne bekannten Link (erfundene Tokens) kommen nur gedrosselt ins Systemprotokoll.
 * Aufbewahrung: `media.security_log_days` (lib/retention.ts).
 */
export type PublicSecurityEvent =
  | 'rate_limited'
  | 'password_failed'
  | 'link_unavailable_hit'
  | 'file_rejected'
  | 'check_failed'
  | 'quota_reached'
  | 'storage_low'
  | 'force_released';

export const EVENT_LABELS: Record<PublicSecurityEvent, string> = {
  rate_limited: 'Zu viele Anfragen',
  password_failed: 'Falsches Passwort',
  link_unavailable_hit: 'Aufruf eines nicht (mehr) gültigen Links',
  file_rejected: 'Datei bei der Prüfung gesperrt',
  check_failed: 'Prüfung fehlgeschlagen',
  quota_reached: 'Kontingent erreicht',
  storage_low: 'Speicher voll – Upload abgewiesen',
  force_released: 'Trotz Prüfbefund freigegeben',
};

export function ipHash(ip: string | null | undefined): string {
  if (!ip) return '';
  return hmacHex(deriveKey('public-ip-hash'), ip).slice(0, 12);
}

const recent = new Map<string, number>();
const WINDOW_MS = 10 * 60_000;

/** Nur für Tests. */
export function resetSecurityEventThrottle() {
  recent.clear();
}

export async function logPublicEvent(event: PublicSecurityEvent, opts: { linkId?: string | null; mediaId?: string | null; ip?: string | null; detail?: string; throttle?: boolean } = {}) {
  try {
    const ih = ipHash(opts.ip);
    if (opts.throttle !== false) {
      const key = sha256Hex(`${event}|${opts.linkId ?? ''}|${ih}|${opts.mediaId ?? ''}`);
      const until = recent.get(key);
      if (until && until > Date.now()) return;
      if (recent.size > 5000) recent.clear();
      recent.set(key, Date.now() + WINDOW_MS);
    }
    await pool.query(`INSERT INTO public_security_events (event, link_id, media_id, ip_hash, detail) VALUES ($1,$2,$3,$4,$5)`, [
      event,
      opts.linkId ?? null,
      opts.mediaId ?? null,
      ih,
      (opts.detail ?? '').slice(0, 200),
    ]);
  } catch (e) {
    log('warn', 'security', `Sicherheitsereignis ${event} nicht gespeichert: ${(e as Error).message}`);
  }
}
