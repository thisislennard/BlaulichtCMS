import type { FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { checkFailedLoginRate } from '../lib/security-alerts.js';
import { decrypt } from '../lib/crypto.js';
import { AppError, badRequest } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { clearFailures, isLocked, knownDevice, registerFailure } from './lockout.js';
import { verifyPassword } from './passwords.js';
import { verifyTotp } from './totp.js';

/**
 * Bestätigung der eigenen Identität in einer bestehenden Sitzung (Passwort, bei eingerichteter Zwei-Faktor-Anmeldung
 * auf Wunsch zusätzlich ein aktueller Code). Falsche Eingaben zählen wie bei der Anmeldung zur Kontosperre (#99) und
 * werden auditiert – eine übernommene Sitzung erlaubt kein unbegrenztes Passwortraten.
 */
export async function confirmIdentity(
  req: FastifyRequest,
  user: any,
  input: { password: string; code?: string | null },
  opts: { requireCode: boolean; purpose: string },
): Promise<void> {
  const s = await getSettings();
  const device = knownDevice(req, user.id);
  if (await isLocked(user, device)) {
    throw new AppError(423, 'locked', 'Zu viele Fehlversuche – bitte später erneut versuchen oder die Administration um Entsperren bitten.');
  }
  const object = { type: 'user', id: user.id, label: user.email };
  const actor = req.auth?.actor ?? { id: user.id, name: user.name, type: 'user' as const, ip: req.ip };
  if (!(await verifyPassword(user.password_hash, input.password))) {
    await registerFailure(user, 'failed_logins', s, device);
    await audit(actor, 'auth.confirm', object, { zweck: opts.purpose, grund: 'passwort' }, 'failed');
    await checkFailedLoginRate();
    throw badRequest('Passwort ist falsch.');
  }
  if (opts.requireCode && user.totp_enabled && user.totp_secret_enc) {
    const counter = input.code ? verifyTotp(decrypt(user.totp_secret_enc, `totp:${user.id}`), input.code) : null;
    if (counter === null) {
      if (!input.code) throw new AppError(400, 'code_required', 'Bitte zusätzlich den aktuellen Code aus der Authenticator-App eingeben.');
      await registerFailure(user, 'mfa_failed', s, device);
      await audit(actor, 'auth.confirm', object, { zweck: opts.purpose, grund: 'code' }, 'failed');
      await checkFailedLoginRate();
      throw badRequest('Code stimmt nicht. Uhrzeit des Telefons prüfen und erneut versuchen.');
    }
    // Kein Wiederverwenden desselben Codes (wie bei der Anmeldung, #64)
    const r = await pool.query('UPDATE users SET totp_last_counter = $2 WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)', [user.id, counter]);
    if (!r.rowCount) throw badRequest('Dieser Code wurde schon verwendet. Bitte auf den nächsten Code warten.');
    await clearFailures(user, 'mfa_failed', device);
  }
  await clearFailures(user, 'failed_logins', device);
}
