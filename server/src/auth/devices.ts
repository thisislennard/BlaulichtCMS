import type { FastifyRequest } from 'fastify';
import { one, pool, type Queryable } from '../db/pool.js';
import type { Settings } from '../lib/settings.js';
import { deviceHash, knownDevice } from './lockout.js';

/**
 * Vertrauenswürdige Geräte („Auf diesem Gerät 30 Tage nicht nach dem Code fragen“) und gemerkte Sitzungen.
 *
 * - Ein Gerät wird nur nach einer erfolgreichen Prüfung mit einem Code aus der Authenticator-App vertrauenswürdig
 *   (nicht mit einem Wiederherstellungscode) und nur, wenn die Person es ausdrücklich wählt.
 * - Grundlage ist die Kennung im signierten Geräte-Cookie (auth/lockout.ts). Gespeichert wird nur ein Hash; ohne
 *   gültigen Eintrag in `trusted_devices` hilft das Cookie nichts – ein Merker im Browser allein genügt nie.
 * - Das Passwort bleibt bei jeder Anmeldung Pflicht, ebenso Passwort und Code bei kritischen Aktionen (Step-up).
 * - Widerruf: Passwortänderung, Zwei-Faktor einrichten/abschalten/zurücksetzen, „Überall abmelden“, Sperren oder
 *   Passwort-Link durch die Administration, Master-Schlüsselwechsel, Abschalten der Funktion, Ablauf.
 */

/** Ist dieses Gerät für das Konto als vertrauenswürdig hinterlegt (gültig, nicht widerrufen, Funktion an)? */
export async function trustedDeviceId(req: FastifyRequest, userId: string, s: Settings): Promise<string | null> {
  if (!s['security.mfa_remember_enabled']) return null;
  const device = knownDevice(req, userId);
  if (!device) return null;
  // Auch eine nachträglich verkürzte Frist gilt sofort (created_at), ebenso eine spätere Passwortänderung
  const row = await one<{ id: string }>(
    `SELECT t.id FROM trusted_devices t JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND t.device_hash = $2 AND t.revoked_at IS NULL AND t.expires_at > now()
        AND t.created_at > now() - make_interval(days => $3)
        AND (u.password_changed_at IS NULL OR t.created_at >= u.password_changed_at)`,
    [userId, deviceHash(userId, device), s['security.mfa_remember_days']],
  );
  return row?.id ?? null;
}

/** Gerät nach erfolgreicher TOTP-Prüfung als vertrauenswürdig hinterlegen (ein Eintrag je Konto und Gerät). */
export async function trustDevice(userId: string, device: string, userAgent: string, s: Settings): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO trusted_devices (user_id, device_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))
     ON CONFLICT (user_id, device_hash) WHERE revoked_at IS NULL
     DO UPDATE SET created_at = now(), expires_at = EXCLUDED.expires_at, user_agent = EXCLUDED.user_agent, last_used_at = NULL
     RETURNING id`,
    [userId, deviceHash(userId, device), userAgent.slice(0, 300), s['security.mfa_remember_days']],
  );
  return row!.id;
}

/** Alle vertrauenswürdigen Geräte eines Kontos widerrufen. Gibt die Anzahl zurück. */
export async function revokeTrustedDevices(userId: string, db: Queryable = pool): Promise<number> {
  const r = await db.query('UPDATE trusted_devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return r.rowCount ?? 0;
}
