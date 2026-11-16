import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { assertRecentAuth, clearSessionCookie, createSession, mustUse2fa, REAUTH_MINUTES, requireAuth, SESSION_COOKIE } from '../auth/context.js';
import { burnPasswordTime, hashPassword, needsRehash, passwordProblems, verifyPassword } from '../auth/passwords.js';
import { generateRecoveryCodes, generateTotpSecret, otpauthUrl, recoveryCodeCandidates, recoveryCodeHash, verifyTotp } from '../auth/totp.js';
import { activeRoles, permissionsFor } from '../auth/permissions.js';
import { clearFailures, isLocked, knownDevice, registerFailure } from '../auth/lockout.js';
import { confirmIdentity } from '../auth/stepup.js';
import { revokeTrustedDevices, trustDevice, trustedDeviceId } from '../auth/devices.js';
import { audit } from '../lib/audit.js';
import { checkFailedLoginRate, notifyAffectedUser, securityAlert } from '../lib/security-alerts.js';
import { aad, decrypt, encrypt, fingerprint, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { getSettings, privacyIncomplete, privacyInfo, setSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';
import { normalizePublicUrl } from '../lib/urls.js';

const SETUP_FILE = () => path.join(config.dataDir, 'setup-token.txt');

/** Beim ersten Start ohne Benutzer: Einrichtungsschlüssel erzeugen (nur im Log und in /data sichtbar). */
export async function ensureSetupToken() {
  const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if (count!.n > 0) {
    fs.rmSync(SETUP_FILE(), { force: true });
    return;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  let token = fs.existsSync(SETUP_FILE()) ? fs.readFileSync(SETUP_FILE(), 'utf8').trim() : '';
  if (!token) {
    token = randomToken(18);
    fs.writeFileSync(SETUP_FILE(), token + '\n', { mode: 0o600 });
  }
  // Nur Konsole/Container-Protokoll, nicht ins Systemprotokoll der Datenbank
  console.warn(JSON.stringify({ t: new Date().toISOString(), level: 'warn', source: 'setup', message: `Ersteinrichtung offen. Einrichtungsschlüssel: ${token} (auch in ${SETUP_FILE()})` }));
}

const totpAad = aad.totp;

/**
 * Bezeichnung einer Anmeldung mit unbekanntem Konto fürs Audit (#128): E-Mail-förmige Eingaben bleiben lesbar
 * (Erkennen von Passwort-Spraying), alles andere nur als nicht umkehrbarer Fingerabdruck.
 */
export function loginAttemptLabel(input: string): string {
  const v = input.trim();
  if (v.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return v.toLowerCase();
  return `unbekanntes Konto (Eingabe ohne E-Mail-Format, Kennung ${fingerprint(v)})`;
}

function userPayload(u: any) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    roles: u.roles,
    totp_enabled: u.totp_enabled,
    preferences: u.preferences ?? {},
  };
}

/** Einheitliche Antwort jeder fehlgeschlagenen Anmeldung (unbekannt, falsch, inaktiv, gesperrt). */
const LOGIN_FAILED = 'E-Mail oder Passwort ist falsch – oder die Anmeldung ist nach mehreren Fehlversuchen vorübergehend gesperrt.';

export async function authRoutes(app: FastifyInstance) {
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // Ohne Anmeldung erreichbar: keine Programmversion (#125) – die steht nach der Anmeldung in /auth/me
  app.get('/auth/state', async () => {
    const s = await getSettings();
    const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM users');
    return {
      setupRequired: count!.n === 0,
      instanceName: s['general.instance_name'],
      organization: s['general.organization'],
      suggestedPublicUrl: count!.n === 0 ? config.publicUrl || null : null,
      // Für die Ankreuzfelder „Angemeldet bleiben“ und „Auf diesem Gerät … nicht nach dem Code fragen“
      remember: { enabled: s['security.remember_enabled'], days: s['security.remember_days'] },
      mfaRemember: { enabled: s['security.mfa_remember_enabled'], days: s['security.mfa_remember_days'] },
    };
  });

  app.post('/auth/setup', { ...loginLimit }, async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(1),
        name: z.string().trim().min(2).max(80),
        email: z.email().max(200),
        password: z.string(),
        organization: z.string().trim().min(2).max(120),
        publicUrl: z.string().trim().min(1).max(300),
        timezone: z.string().trim().min(1).max(60).default('Europe/Berlin'),
      })
      .parse(req.body);
    const s = await getSettings();
    const problem = passwordProblems(body.password, s['security.password_min_length'], [body.email, body.name, body.organization]);
    if (problem) throw badRequest(problem);
    const publicUrl = normalizePublicUrl(body.publicUrl);
    try {
      new Intl.DateTimeFormat('de-DE', { timeZone: body.timezone });
    } catch {
      throw badRequest('Unbekannte Zeitzone.');
    }
    const expected = fs.existsSync(SETUP_FILE()) ? fs.readFileSync(SETUP_FILE(), 'utf8').trim() : '';
    if (!expected || !safeEqual(expected, body.token.trim())) throw new AppError(403, 'bad_setup_token', 'Einrichtungsschlüssel ist falsch.');
    const user = await tx(async (db) => {
      await db.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM users', [], db);
      if (n!.n > 0) throw new AppError(409, 'already_setup', 'BlaulichtCMS ist bereits eingerichtet.');
      return one<any>(
        `INSERT INTO users (email, name, password_hash, roles, status, password_changed_at) VALUES ($1,$2,$3,'{platform_admin}','active', now()) RETURNING *`,
        [body.email.toLowerCase(), body.name, await hashPassword(body.password)],
        db,
      );
    });
    fs.rmSync(SETUP_FILE(), { force: true });
    await setSettings(
      { 'setup.completed': true, 'general.organization': body.organization, 'general.sender_name': body.organization, 'general.public_url': publicUrl, 'general.timezone': body.timezone },
      user.id,
    );
    await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'setup.complete', { type: 'user', id: user.id, label: user.email });
    const stage = mustUse2fa(user.roles, s) ? 'mfa_setup' : 'full';
    await createSession(reply, req, user.id, stage);
    return { next: stage === 'full' ? 'done' : 'mfa_setup' };
  });

  app.post('/auth/login', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(300), remember: z.boolean().optional() }).parse(req.body);
    const s = await getSettings();
    const user = await one<any>('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
    const fail = async (reason: string) => {
      // Unbekannte Konten: die rohe Eingabe nur speichern, wenn sie wie eine E-Mail-Adresse aussieht – sonst könnte
      // ein versehentlich ins Benutzerfeld getipptes Passwort im Audit-Protokoll landen (#128)
      const label = user ? user.email : loginAttemptLabel(body.email);
      await audit({ id: user?.id ?? null, name: user?.name ?? label, type: 'user', ip: req.ip }, 'auth.login', { type: 'user', id: user?.id, label }, { grund: reason }, 'failed');
      await checkFailedLoginRate();
      throw unauthorized(LOGIN_FAILED);
    };
    if (!user) {
      await burnPasswordTime(body.password);
      return fail('unbekannt');
    }
    // Gesperrt: dieselbe Antwort und Laufzeit wie bei falschem Passwort – sonst verrät 423, dass das Konto
    // existiert (#124). Der Grund steht nur im Audit; auch ein richtiges Passwort wird nicht bestätigt.
    // Bekannte Geräte sind von der Kontosperre ausgenommen und zählen für sich (#110, siehe auth/lockout.ts)
    const device = knownDevice(req, user.id);
    if (await isLocked(user, device)) {
      await verifyPassword(user.password_hash, body.password);
      return fail(device ? 'gesperrt (Gerät)' : 'gesperrt');
    }
    const ok = await verifyPassword(user.password_hash, body.password);
    if (!ok || user.status !== 'active') {
      if (user.status === 'active') await registerFailure(user, 'failed_logins', s, device);
      return fail(user.status !== 'active' ? 'inaktiv' : 'passwort');
    }
    await clearFailures(user, 'failed_logins', device);
    // Alte, schwächere Parameter: mit dem gerade bestätigten Passwort neu berechnen (#129)
    if (needsRehash(user.password_hash)) {
      await pool.query('UPDATE users SET password_hash = $3 WHERE id = $1 AND password_hash = $2', [user.id, user.password_hash, await hashPassword(body.password)]);
    }
    // Vertrauenswürdiges Gerät (Code auf diesem Gerät zuletzt bestätigt, serverseitig hinterlegt): nur das Passwort
    const trusted = user.totp_enabled ? await trustedDeviceId(req, user.id, s) : null;
    const stage = user.totp_enabled && !trusted ? 'mfa' : !user.totp_enabled && mustUse2fa(user.roles, s) ? 'mfa_setup' : 'full';
    const session = await createSession(reply, req, user.id, stage, { remember: body.remember });
    if (stage === 'full') {
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      if (trusted) await pool.query('UPDATE trusted_devices SET last_used_at = now() WHERE id = $1', [trusted]);
      await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'auth.login', { type: 'user', id: user.id, label: user.email }, {
        ...(trusted ? { mfa: 'vertrauenswürdiges Gerät' } : {}),
        ...(session.remembered ? { angemeldet_bleiben: true } : {}),
      });
    }
    return { next: stage === 'full' ? 'done' : stage };
  });

  /** Zwischenstufe → volle Sitzung mit neuem Token; der Wunsch „Angemeldet bleiben“ aus der Anmeldung gilt weiter. */
  async function upgradeSession(req: any, reply: any, userId: string) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
    const session = await createSession(reply, req, userId, 'full', { remember: !!req.auth.remember });
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    return session;
  }

  app.post('/auth/mfa', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ code: z.string().trim().min(6).max(20), trustDevice: z.boolean().optional() }).parse(req.body);
    if (!req.auth || req.auth.stage !== 'mfa' || !req.auth.user) throw unauthorized();
    const s = await getSettings();
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth.user.id]);
    const device = knownDevice(req, user.id);
    // Hier ist das Passwort schon bestätigt – die Sperrmeldung verrät nichts Neues
    if (await isLocked(user, device)) {
      throw new AppError(423, 'locked', 'Konto vorübergehend gesperrt (zu viele Fehlversuche). Bitte später erneut versuchen.');
    }
    const actor = { id: user.id, name: user.name, type: 'user' as const, ip: req.ip };
    const failMfa = async (msg: string) => {
      await registerFailure(user, 'mfa_failed', s, device);
      await audit(actor, 'auth.mfa', { type: 'user', id: user.id, label: user.email }, {}, 'failed');
      await checkFailedLoginRate();
      throw unauthorized(msg);
    };
    const secret = decrypt(user.totp_secret_enc, totpAad(user.id));
    const counter = verifyTotp(secret, body.code);
    // Nur ein Code aus der App macht ein Gerät vertrauenswürdig – ein Wiederherstellungscode (Telefon verloren) nie
    let viaTotp = false;
    if (counter !== null) {
      viaTotp = true;
      // Bedingt aktualisieren: zwei parallele Anfragen mit demselben Code gelingen nicht beide (#64)
      const r = await pool.query('UPDATE users SET totp_last_counter = $2 WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)', [user.id, counter]);
      if (!r.rowCount) return failMfa('Dieser Code wurde bereits verwendet. Bitte den nächsten abwarten.');
    } else {
      const [current, legacy] = recoveryCodeCandidates(user.id, body.code);
      const r = await pool.query(
        'UPDATE users SET recovery_codes = array_remove(array_remove(recovery_codes, $2), $3) WHERE id = $1 AND recovery_codes && ARRAY[$2, $3]::text[]',
        [user.id, current, legacy],
      );
      if (!r.rowCount) return failMfa('Code ist ungültig.');
      await audit(actor, 'auth.recovery_code_used', { type: 'user', id: user.id, label: user.email });
      // Wiederherstellungscode = Telefon verloren oder zweiter Faktor kompromittiert (#101)
      const left = (await one<{ n: number }>('SELECT cardinality(recovery_codes)::int AS n FROM users WHERE id = $1', [user.id]))?.n ?? 0;
      await securityAlert('recovery_code_used', { title: `Wiederherstellungscode benutzt: ${user.email}`, body: `Anmeldung mit einem Wiederherstellungscode von ${req.ip}; noch ${left} Code(s) übrig.`, link: '/benutzer', permission: 'user.lock', kind: 'info' });
      await notifyAffectedUser(user.id, 'Anmeldung mit einem Wiederherstellungscode', `Für dein Konto wurde ein Wiederherstellungscode benutzt (noch ${left} übrig). Warst du das nicht, bitte sofort das Passwort ändern und die Administration informieren.`);
    }
    await clearFailures(user, 'mfa_failed', device);
    const session = await upgradeSession(req, reply, user.id);
    await audit(actor, 'auth.login', { type: 'user', id: user.id, label: user.email }, { mfa: true, ...(session.remembered ? { angemeldet_bleiben: true } : {}) });
    if (body.trustDevice && viaTotp && s['security.mfa_remember_enabled'] && session.device) {
      await trustDevice(user.id, session.device, String(req.headers['user-agent'] ?? ''), s);
      await audit(actor, 'auth.trusted_device_added', { type: 'user', id: user.id, label: user.email }, { tage: s['security.mfa_remember_days'] });
      await notifyAffectedUser(
        user.id,
        'Gerät für die Zwei-Faktor-Anmeldung gemerkt',
        `Auf einem Gerät wird ${s['security.mfa_remember_days']} Tage lang kein Code abgefragt (nur das Passwort). Warst du das nicht, unter „Mein Konto“ das Gerät entfernen, das Passwort ändern und die Administration informieren.`,
      );
    }
    return { next: 'done' };
  });

  app.get('/auth/mfa/setup', async (req) => {
    if (!req.auth?.user || !['mfa_setup', 'full'].includes(req.auth.stage)) throw unauthorized();
    const user = req.auth.user;
    if (user.totp_enabled) throw badRequest('Zwei-Faktor-Anmeldung ist bereits eingerichtet.');
    // In einer vollen Sitzung nur mit frischer Passwortbestätigung (#144): sonst trägt jemand mit kurz übernommener
    // Sitzung sein eigenes Gerät als zweiten Faktor ein. Direkt nach der Anmeldung (mfa_setup) ist sie frisch.
    if (req.auth.stage === 'full') assertRecentAuth(req);
    const s = await getSettings();
    const secret = generateTotpSecret();
    await pool.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [user.id, encrypt(secret, totpAad(user.id))]);
    const url = otpauthUrl(secret, user.email, `BlaulichtCMS ${s['general.instance_name']}`.trim());
    return { secret, otpauth: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  });

  app.post('/auth/mfa/setup', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ code: z.string().trim() }).parse(req.body);
    if (!req.auth?.user || !['mfa_setup', 'full'].includes(req.auth.stage)) throw unauthorized();
    if (req.auth.stage === 'full') assertRecentAuth(req);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth.user.id]);
    if (user.totp_enabled) throw badRequest('Zwei-Faktor-Anmeldung ist bereits eingerichtet.');
    if (!user.totp_secret_enc) throw badRequest('Bitte die Einrichtung neu starten.');
    const counter = verifyTotp(decrypt(user.totp_secret_enc, totpAad(user.id)), body.code);
    if (counter === null || (user.totp_last_counter != null && counter <= Number(user.totp_last_counter))) throw badRequest('Code stimmt nicht. Uhrzeit des Telefons prüfen und erneut versuchen.');
    const codes = generateRecoveryCodes();
    await pool.query('UPDATE users SET totp_enabled = true, totp_last_counter = $2, recovery_codes = $3 WHERE id = $1', [user.id, counter, codes.map((c) => recoveryCodeHash(user.id, c))]);
    // Alle anderen Sitzungen beenden – sie müssen sich mit dem neuen zweiten Faktor neu anmelden (#144)
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, req.auth.sessionId]);
    await revokeTrustedDevices(user.id);
    await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'auth.mfa_enabled', { type: 'user', id: user.id, label: user.email });
    await notifyAffectedUser(user.id, 'Zwei-Faktor-Anmeldung eingerichtet', 'Für dein Konto wurde die Zwei-Faktor-Anmeldung eingerichtet; andere Sitzungen wurden beendet. Warst du das nicht, bitte sofort die Administration informieren.');
    if (req.auth.stage === 'mfa_setup') await upgradeSession(req, reply, user.id);
    return { recoveryCodes: codes };
  });

  /**
   * Neue Wiederherstellungscodes: verlangt Passwort und einen aktuellen Code aus der App (kein Wiederverwenden).
   * Alle bisherigen Codes werden ungültig.
   */
  app.post('/auth/mfa/recovery-codes', { preHandler: requireAuth(), ...loginLimit }, async (req) => {
    const body = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(8) }).parse(req.body);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth!.user!.id]);
    if (!user.totp_enabled || !user.totp_secret_enc) throw badRequest('Die Zwei-Faktor-Anmeldung ist nicht eingerichtet.');
    await confirmIdentity(req, user, body, { requireCode: true, purpose: 'Wiederherstellungscodes' });
    const codes = generateRecoveryCodes();
    await pool.query('UPDATE users SET recovery_codes = $2 WHERE id = $1', [user.id, codes.map((c) => recoveryCodeHash(user.id, c))]);
    await audit(req.auth!.actor, 'auth.recovery_codes_renewed', { type: 'user', id: user.id, label: user.email });
    await notifyAffectedUser(user.id, 'Neue Wiederherstellungscodes erzeugt', 'Für dein Konto wurden neue Wiederherstellungscodes erzeugt, die bisherigen sind ungültig. Warst du das nicht, bitte sofort die Administration informieren.');
    return { recoveryCodes: codes };
  });

  /** Abschalten verlangt Passwort und aktuellen Code (#99); danach werden alle anderen Sitzungen beendet. */
  app.post('/auth/mfa/disable', { preHandler: requireAuth(), ...loginLimit }, async (req) => {
    const body = z.object({ password: z.string().min(1).max(300), code: z.string().trim().max(8).optional() }).parse(req.body);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth!.user!.id]);
    const s = await getSettings();
    if (mustUse2fa(user.roles, s)) throw badRequest('Für deine Rolle ist die Zwei-Faktor-Anmeldung vorgeschrieben.');
    await confirmIdentity(req, user, body, { requireCode: true, purpose: 'Zwei-Faktor abschalten' });
    await pool.query(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE id = $1`, [user.id]);
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, req.auth!.sessionId]);
    await revokeTrustedDevices(user.id);
    await audit(req.auth!.actor, 'auth.mfa_disabled', { type: 'user', id: user.id, label: user.email });
    await notifyAffectedUser(user.id, 'Zwei-Faktor-Anmeldung abgeschaltet', 'Für dein Konto wurde die Zwei-Faktor-Anmeldung abgeschaltet; andere Sitzungen wurden beendet. Warst du das nicht, bitte sofort das Passwort ändern und die Administration informieren.');
    await securityAlert('mfa_disabled', { title: `Zwei-Faktor abgeschaltet: ${user.email}`, body: 'Die Person hat die Zwei-Faktor-Anmeldung für ihr Konto selbst abgeschaltet.', link: '/benutzer', permission: 'user.lock', kind: 'info' });
    return { ok: true };
  });

  /**
   * Erneute Bestätigung für kritische Aktionen (#109): Passwort und – bei eingerichteter Zwei-Faktor-Anmeldung –
   * aktueller Code. Gilt REAUTH_MINUTES für diese Sitzung.
   */
  app.post('/auth/reauth', { preHandler: requireAuth(), ...loginLimit }, async (req) => {
    if (req.auth!.kind !== 'session') throw badRequest('Nur für angemeldete Personen.');
    const body = z.object({ password: z.string().min(1).max(300), code: z.string().trim().max(8).optional() }).parse(req.body);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth!.user!.id]);
    await confirmIdentity(req, user, body, { requireCode: true, purpose: 'kritische Aktion bestätigen' });
    await pool.query('UPDATE sessions SET reauth_at = now() WHERE id = $1', [req.auth!.sessionId]);
    await audit(req.auth!.actor, 'auth.reauth', { type: 'user', id: user.id, label: user.email });
    return { ok: true, validMinutes: REAUTH_MINUTES };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth?.sessionId) {
      await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
      if (req.auth.stage === 'full') await audit(req.auth.actor, 'auth.logout', { type: 'user', id: req.auth.user?.id, label: req.auth.user?.email });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Alle Sitzungen dieses Kontos beenden und alle vertrauenswürdigen Geräte entfernen. */
  app.post('/auth/logout-all', { preHandler: requireAuth() }, async (req, reply) => {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.auth!.user!.id]);
    const devices = await revokeTrustedDevices(req.auth!.user!.id);
    await audit(req.auth!.actor, 'auth.logout_all', { type: 'user', id: req.auth!.user!.id, label: req.auth!.user!.email }, { vertrauenswuerdige_geraete: devices });
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (!req.auth || !req.auth.user) {
      if (req.auth?.kind === 'api_key') return { kind: 'api_key', permissions: [...req.auth.permissions] };
      throw unauthorized();
    }
    const s = await getSettings();
    const u = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth.user.id]);
    return {
      stage: req.auth.stage,
      user: userPayload(u),
      permissions: [...permissionsFor(req.auth.stage === 'full' ? u.roles : [])],
      roleLabels: activeRoles().filter((r) => u.roles.includes(r.id)).map((r) => r.label),
      instance: { name: s['general.instance_name'], organization: s['general.organization'], timezone: s['general.timezone'], language: s['general.language'], publicUrl: s['general.public_url'] || config.publicUrl || null, privacy: { controller: privacyInfo(s).controller, policy_url: privacyInfo(s).policy_url, incomplete: privacyIncomplete(s) } },
      version: config.version,
      recoveryCodesLeft: u.recovery_codes.length,
      mfaRequired: mustUse2fa(u.roles, s),
      passwordMinLength: s['security.password_min_length'],
    };
  });

  app.patch('/auth/preferences', { preHandler: requireAuth() }, async (req) => {
    const prefs = z
      .object({
        theme: z.enum(['dark', 'light', 'system']).optional(),
        reducedMotion: z.boolean().optional(),
        compactTables: z.boolean().optional(),
        sidebarCollapsed: z.boolean().optional(),
        language: z.enum(['de', 'en']).optional(),
        /** Benachrichtigungsarten, die die Person nicht sehen möchte (Medien: neue Dateien, Links, Speicher) */
        mutedNotifications: z.array(z.enum(['media_new', 'media_link', 'media_storage'])).max(10).optional(),
      })
      .parse(req.body);
    await pool.query(`UPDATE users SET preferences = preferences || $2::jsonb WHERE id = $1`, [req.auth!.user!.id, JSON.stringify(prefs)]);
    return { ok: true };
  });

  app.post('/auth/password', { preHandler: requireAuth(), ...loginLimit }, async (req, reply) => {
    const body = z.object({ current: z.string().min(1).max(300), next: z.string() }).parse(req.body);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth!.user!.id]);
    await confirmIdentity(req, user, { password: body.current }, { requireCode: false, purpose: 'Passwort ändern' });
    if (body.current === body.next) throw badRequest('Das neue Passwort muss sich vom bisherigen unterscheiden.');
    const s = await getSettings();
    const problem = passwordProblems(body.next, s['security.password_min_length'], [user.email, user.name, s['general.organization'], s['general.instance_name']]);
    if (problem) throw badRequest(problem);
    await pool.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [user.id, await hashPassword(body.next)]);
    // Alle anderen Sitzungen beenden und vertrauenswürdige Geräte entfernen (das alte Passwort gilt nirgends mehr)
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, req.auth!.sessionId]);
    await revokeTrustedDevices(user.id);
    await audit(req.auth!.actor, 'auth.password_changed', { type: 'user', id: user.id, label: user.email });
    await notifyAffectedUser(user.id, 'Passwort geändert', 'Das Passwort deines Kontos wurde geändert; andere Sitzungen wurden beendet und gemerkte Geräte der Zwei-Faktor-Anmeldung entfernt. Warst du das nicht, bitte sofort die Administration informieren.');
    return { ok: true };
  });

  app.get('/auth/sessions', { preHandler: requireAuth() }, async (req) => {
    const rows = await many<any>(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, remember FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND stage = 'full' ORDER BY last_seen_at DESC`,
      [req.auth!.user!.id],
    );
    return rows.map((r) => ({ ...r, current: r.id === req.auth!.sessionId }));
  });

  app.delete('/auth/sessions/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await one<{ remember: boolean }>('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING remember', [id, req.auth!.user!.id]);
    if (r) await audit(req.auth!.actor, 'auth.session_revoked', { type: 'user', id: req.auth!.user!.id, label: req.auth!.user!.email }, { sitzung: id, gemerkt: r.remember });
    return { ok: true };
  });

  /** Vertrauenswürdige Geräte der eigenen Zwei-Faktor-Anmeldung (ohne Gerätekennung, nur Browser und Zeiten). */
  app.get('/auth/trusted-devices', { preHandler: requireAuth() }, async (req) => {
    const s = await getSettings();
    const userId = req.auth!.user!.id;
    const current = await trustedDeviceId(req, userId, s);
    const rows = await many<any>(
      `SELECT id, user_agent, created_at, last_used_at, LEAST(expires_at, created_at + make_interval(days => $2)) AS expires_at FROM trusted_devices
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND created_at > now() - make_interval(days => $2) ORDER BY created_at DESC`,
      [userId, s['security.mfa_remember_days']],
    );
    return { enabled: s['security.mfa_remember_enabled'], days: s['security.mfa_remember_days'], devices: rows.map((r) => ({ ...r, current: r.id === current })) };
  });

  app.delete('/auth/trusted-devices/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const r = await pool.query('UPDATE trusted_devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, req.auth!.user!.id]);
    if (r.rowCount) await audit(req.auth!.actor, 'auth.trusted_device_removed', { type: 'user', id: req.auth!.user!.id, label: req.auth!.user!.email }, { geraet: id });
    return { ok: true };
  });

  /* Einladung / Passwort-Link */
  app.get('/auth/invite/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.params);
    const inv = await one<any>(
      `SELECT i.*, u.email, u.name, u.status FROM invitations i JOIN users u ON u.id = i.user_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND u.status <> 'disabled'`,
      [sha256Hex(token)],
    );
    if (!inv) throw new AppError(404, 'invite_invalid', 'Der Link ist ungültig oder abgelaufen. Bitte einen neuen anfordern.');
    const s = await getSettings();
    return { email: inv.email, name: inv.name, reset: inv.status === 'active', minLength: s['security.password_min_length'], instanceName: s['general.instance_name'] };
  });

  app.post('/auth/invite/:token', { ...loginLimit }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(2).max(80), password: z.string() }).parse(req.body);
    const s = await getSettings();
    const invited = await one<{ email: string }>('SELECT u.email FROM invitations i JOIN users u ON u.id = i.user_id WHERE i.token_hash = $1', [sha256Hex(token)]);
    const problem = passwordProblems(body.password, s['security.password_min_length'], [invited?.email, body.name, s['general.organization'], s['general.instance_name']]);
    if (problem) throw badRequest(problem);
    const user = await tx(async (db) => {
      const inv = await one<any>(`SELECT * FROM invitations WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256Hex(token)], db);
      if (!inv) throw new AppError(404, 'invite_invalid', 'Der Link ist ungültig oder abgelaufen.');
      const target = await one<any>('SELECT status FROM users WHERE id = $1', [inv.user_id], db);
      if (target?.status === 'disabled') throw new AppError(404, 'invite_invalid', 'Der Link ist ungültig oder abgelaufen.');
      await db.query('UPDATE invitations SET used_at = now() WHERE id = $1', [inv.id]);
      const u = await one<any>(
        `UPDATE users SET name = $2, password_hash = $3, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, password_changed_at = now(), failed_logins = 0, locked_until = NULL
          WHERE id = $1 RETURNING *`,
        [inv.user_id, body.name, await hashPassword(body.password)],
        db,
      );
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await revokeTrustedDevices(u.id, db);
      return u;
    });
    await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'auth.invite_accepted', { type: 'user', id: user.id, label: user.email });
    if (user.last_login_at) await notifyAffectedUser(user.id, 'Passwort über einen Link neu gesetzt', 'Das Passwort deines Kontos wurde über einen Passwort-Link neu gesetzt; alle Sitzungen wurden beendet. Warst du das nicht, bitte sofort die Administration informieren.');
    if (user.status !== 'active') throw new AppError(403, 'disabled', 'Das Konto ist deaktiviert.');
    const stage = user.totp_enabled ? 'mfa' : mustUse2fa(user.roles, s) ? 'mfa_setup' : 'full';
    await createSession(reply, req, user.id, stage);
    return { next: stage === 'full' ? 'done' : stage };
  });

  void SESSION_COOKIE;
}
