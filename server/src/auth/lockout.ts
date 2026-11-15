import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import { deriveKey, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { notifyAffectedUser, securityAlert } from '../lib/security-alerts.js';
import type { Settings } from '../lib/settings.js';

/**
 * Kontosperre nach Fehlversuchen (#110).
 *
 * Problem der reinen Kontosperre: Wer nur eine E-Mail-Adresse kennt, kann ein Konto anonym und dauerhaft aussperren
 * (alle 15 Minuten fünf falsche Passwörter). Deshalb zwei getrennte Zähler:
 *
 * - **Unbekannte Geräte** teilen sich den Kontozähler (users.failed_logins / mfa_failed / locked_until). Ist er voll,
 *   sind Anmeldungen von unbekannten Geräten für `security.lockout_minutes` gesperrt – Passwortraten bleibt begrenzt.
 * - **Bekannte Geräte** (Browser, in denen sich das Konto in den letzten 180 Tagen vollständig angemeldet hat; sie
 *   tragen ein signiertes Geräte-Cookie) sind von dieser Sperre ausgenommen und haben je Gerät einen eigenen Zähler
 *   (Tabelle auth_throttle). Wer ein Konto von außen sperrt, sperrt also nur neue Geräte – die Person meldet sich an
 *   ihrem gewohnten Gerät weiter an.
 *
 * Bei jeder Kontosperre werden die betroffene Person und alle mit „Benutzer verwalten“ benachrichtigt; Admins können
 * die Sperre in der Benutzerliste aufheben. Das Geräte-Cookie ersetzt keinen Faktor: Passwort und ggf. TOTP bleiben
 * Pflicht.
 */

export const DEVICE_COOKIE = config.cookieSecure ? '__Host-bc_device' : 'bc_device';
const DEVICE_DAYS = 180;

function deviceMac(payload: string): string {
  return crypto.createHmac('sha256', deriveKey('device-cookie')).update(payload).digest('base64url').slice(0, 32);
}

/** Geräte-Cookie nach vollständiger Anmeldung setzen bzw. erneuern (Kennung des Geräts bleibt erhalten). */
export function issueDeviceCookie(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const nonce = knownDevice(req, userId) ?? randomToken(12);
  const issued = Math.floor(Date.now() / 1000);
  const payload = `${userId}.${nonce}.${issued}`;
  reply.setCookie(DEVICE_COOKIE, `${payload}.${deviceMac(payload)}`, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: DEVICE_DAYS * 86400,
  });
}

/** Kennung des Geräts, wenn das Anfrage-Cookie gültig zu diesem Konto gehört – sonst null. */
export function knownDevice(req: FastifyRequest, userId: string): string | null {
  const raw = req.cookies?.[DEVICE_COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [uid, nonce, issued, mac] = parts;
  if (uid !== userId || !/^[A-Za-z0-9_-]{8,40}$/.test(nonce)) return null;
  if (!safeEqual(mac, deviceMac(`${uid}.${nonce}.${issued}`))) return null;
  const age = Date.now() / 1000 - Number(issued);
  if (!Number.isFinite(age) || age < -300 || age > DEVICE_DAYS * 86400) return null;
  return nonce;
}

const throttleKey = (userId: string, device: string) => sha256Hex(`device:${userId}:${device}`);

type LockUser = { id: string; email?: string; locked_until?: string | Date | null };

/** Ist die Anmeldung für dieses Konto von diesem Gerät gerade gesperrt? */
export async function isLocked(user: LockUser, device: string | null): Promise<boolean> {
  if (device) {
    const row = await one<{ locked: boolean }>('SELECT locked_until > now() AS locked FROM auth_throttle WHERE key = $1', [throttleKey(user.id, device)]);
    return !!row?.locked;
  }
  return !!user.locked_until && new Date(user.locked_until).getTime() > Date.now();
}

/**
 * Fehlversuch atomar zählen (#78: kein Lesen-dann-Schreiben, parallele Anfragen zählen alle). Bei Erreichen der
 * Grenze wird gesperrt und der Zähler zurückgesetzt. Bekannte Geräte zählen nur für sich (#110).
 */
export async function registerFailure(user: LockUser, column: 'failed_logins' | 'mfa_failed', s: Settings, device: string | null = null) {
  const limit = s['security.lockout_attempts'];
  const minutes = s['security.lockout_minutes'];
  if (device) {
    await pool.query(
      `INSERT INTO auth_throttle (key, user_id, failures) VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN auth_throttle.failures + 1 >= $3 THEN 0 ELSE auth_throttle.failures + 1 END,
         locked_until = CASE WHEN auth_throttle.failures + 1 >= $3 THEN now() + make_interval(mins => $4) ELSE auth_throttle.locked_until END,
         updated_at = now()`,
      [throttleKey(user.id, device), user.id, limit, minutes],
    );
    return;
  }
  const r = await one<{ locked_now: boolean; email: string }>(
    `WITH old AS (SELECT id, ${column} AS n FROM users WHERE id = $1 FOR UPDATE)
     UPDATE users u SET ${column} = CASE WHEN old.n + 1 >= $2 THEN 0 ELSE old.n + 1 END,
            locked_until = CASE WHEN old.n + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE u.locked_until END
       FROM old WHERE u.id = old.id
     RETURNING (old.n + 1 >= $2) AS locked_now, u.email`,
    [user.id, limit, minutes],
  );
  if (r?.locked_now) {
    const body = `Nach ${limit} Fehlversuchen sind Anmeldungen von unbekannten Geräten für ${minutes} Minuten gesperrt. Bereits benutzte Geräte sind nicht betroffen.`;
    await securityAlert('account_locked', { title: `Konto ${r.email} vorübergehend gesperrt`, body: `${body} Die Sperre lässt sich in der Benutzerverwaltung aufheben; Quelle der Versuche steht im Audit-Protokoll.`, link: '/benutzer', permission: 'user.manage' });
    await notifyAffectedUser(user.id, 'Dein Konto wurde nach Fehlversuchen vorübergehend gesperrt', `${body} Warst du das nicht, bitte die Administration informieren.`);
  }
}

/** Nach erfolgreicher Prüfung: Zähler zurücksetzen. Eine laufende Kontosperre bleibt für unbekannte Geräte bestehen. */
export async function clearFailures(user: LockUser, column: 'failed_logins' | 'mfa_failed', device: string | null) {
  if (device) await pool.query('DELETE FROM auth_throttle WHERE key = $1', [throttleKey(user.id, device)]);
  else await pool.query(`UPDATE users SET ${column} = 0, locked_until = CASE WHEN locked_until > now() THEN locked_until END WHERE id = $1`, [user.id]);
}
