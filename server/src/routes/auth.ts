import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { clearSessionCookie, createSession, mustUse2fa, requireAuth, SESSION_COOKIE } from '../auth/context.js';
import { burnPasswordTime, hashPassword, passwordProblems, verifyPassword } from '../auth/passwords.js';
import { generateRecoveryCodes, generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { permissionsFor, ROLES } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';

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

const totpAad = (userId: string) => `totp:${userId}`;

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

export async function authRoutes(app: FastifyInstance) {
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/auth/state', async () => {
    const s = await getSettings();
    const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM users');
    return { setupRequired: count!.n === 0, instanceName: s['general.instance_name'], version: config.version };
  });

  app.post('/auth/setup', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ token: z.string().min(1), name: z.string().trim().min(2).max(80), email: z.email().max(200), password: z.string() }).parse(req.body);
    const s = await getSettings();
    const problem = passwordProblems(body.password, s['security.password_min_length']);
    if (problem) throw badRequest(problem);
    const expected = fs.existsSync(SETUP_FILE()) ? fs.readFileSync(SETUP_FILE(), 'utf8').trim() : '';
    if (!expected || !safeEqual(expected, body.token.trim())) throw new AppError(403, 'bad_setup_token', 'Einrichtungsschlüssel ist falsch.');
    const user = await tx(async (db) => {
      await db.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM users', [], db);
      if (n!.n > 0) throw new AppError(409, 'already_setup', 'LifeLink ist bereits eingerichtet.');
      return one<any>(
        `INSERT INTO users (email, name, password_hash, roles, status, password_changed_at) VALUES ($1,$2,$3,'{platform_admin}','active', now()) RETURNING *`,
        [body.email.toLowerCase(), body.name, await hashPassword(body.password)],
        db,
      );
    });
    fs.rmSync(SETUP_FILE(), { force: true });
    await setSettings({ 'setup.completed': true }, user.id);
    await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'setup.complete', { type: 'user', id: user.id, label: user.email });
    const stage = mustUse2fa(user.roles, s) ? 'mfa_setup' : 'full';
    await createSession(reply, req, user.id, stage);
    return { next: stage === 'full' ? 'done' : 'mfa_setup' };
  });

  app.post('/auth/login', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(300) }).parse(req.body);
    const s = await getSettings();
    const user = await one<any>('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
    const fail = async (reason: string) => {
      await audit({ id: user?.id ?? null, name: user?.name ?? body.email.slice(0, 100), type: 'user', ip: req.ip }, 'auth.login', { type: 'user', id: user?.id, label: body.email.slice(0, 100) }, { grund: reason }, 'failed');
      throw unauthorized('E-Mail oder Passwort ist falsch.');
    };
    if (!user) {
      await burnPasswordTime(body.password);
      return fail('unbekannt');
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new AppError(423, 'locked', `Konto vorübergehend gesperrt (zu viele Fehlversuche). Bitte später erneut versuchen.`);
    }
    const ok = await verifyPassword(user.password_hash, body.password);
    if (!ok || user.status !== 'active') {
      if (user.status === 'active') {
        const attempts = user.failed_logins + 1;
        const lock = attempts >= s['security.lockout_attempts'];
        await pool.query(
          `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
          [user.id, lock ? 0 : attempts, lock, s['security.lockout_minutes']],
        );
      }
      return fail(user.status !== 'active' ? 'inaktiv' : 'passwort');
    }
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
    const stage = user.totp_enabled ? 'mfa' : mustUse2fa(user.roles, s) ? 'mfa_setup' : 'full';
    await createSession(reply, req, user.id, stage);
    if (stage === 'full') {
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'auth.login', { type: 'user', id: user.id, label: user.email });
    }
    return { next: stage === 'full' ? 'done' : stage };
  });

  async function upgradeSession(req: any, reply: any, userId: string) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
    await createSession(reply, req, userId, 'full');
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  }

  app.post('/auth/mfa', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ code: z.string().trim().min(6).max(20) }).parse(req.body);
    if (!req.auth || req.auth.stage !== 'mfa' || !req.auth.user) throw unauthorized();
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth.user.id]);
    const actor = { id: user.id, name: user.name, type: 'user' as const, ip: req.ip };
    const secret = decrypt(user.totp_secret_enc, totpAad(user.id));
    const counter = verifyTotp(secret, body.code);
    if (counter !== null) {
      if (user.totp_last_counter != null && counter <= Number(user.totp_last_counter)) throw unauthorized('Dieser Code wurde bereits verwendet. Bitte den nächsten abwarten.');
      await pool.query('UPDATE users SET totp_last_counter = $2 WHERE id = $1', [user.id, counter]);
    } else {
      const hash = sha256Hex(body.code.toUpperCase().replace(/\s/g, ''));
      if (!user.recovery_codes.includes(hash)) {
        await audit(actor, 'auth.mfa', { type: 'user', id: user.id, label: user.email }, {}, 'failed');
        throw unauthorized('Code ist ungültig.');
      }
      await pool.query('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1', [user.id, hash]);
      await audit(actor, 'auth.recovery_code_used', { type: 'user', id: user.id, label: user.email });
    }
    await upgradeSession(req, reply, user.id);
    await audit(actor, 'auth.login', { type: 'user', id: user.id, label: user.email }, { mfa: true });
    return { next: 'done' };
  });

  app.get('/auth/mfa/setup', async (req) => {
    if (!req.auth?.user || !['mfa_setup', 'full'].includes(req.auth.stage)) throw unauthorized();
    const user = req.auth.user;
    if (user.totp_enabled) throw badRequest('Zwei-Faktor-Anmeldung ist bereits eingerichtet.');
    const s = await getSettings();
    const secret = generateTotpSecret();
    await pool.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [user.id, encrypt(secret, totpAad(user.id))]);
    const url = otpauthUrl(secret, user.email, `LifeLink ${s['general.instance_name']}`.trim());
    return { secret, otpauth: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  });

  app.post('/auth/mfa/setup', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ code: z.string().trim() }).parse(req.body);
    if (!req.auth?.user || !['mfa_setup', 'full'].includes(req.auth.stage)) throw unauthorized();
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth.user.id]);
    if (!user.totp_secret_enc) throw badRequest('Bitte die Einrichtung neu starten.');
    const counter = verifyTotp(decrypt(user.totp_secret_enc, totpAad(user.id)), body.code);
    if (counter === null) throw badRequest('Code stimmt nicht. Uhrzeit des Telefons prüfen und erneut versuchen.');
    const codes = generateRecoveryCodes();
    await pool.query('UPDATE users SET totp_enabled = true, totp_last_counter = $2, recovery_codes = $3 WHERE id = $1', [user.id, counter, codes.map((c) => sha256Hex(c))]);
    await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'auth.mfa_enabled', { type: 'user', id: user.id, label: user.email });
    if (req.auth.stage === 'mfa_setup') await upgradeSession(req, reply, user.id);
    return { recoveryCodes: codes };
  });

  app.post('/auth/mfa/disable', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth!.user!.id]);
    const s = await getSettings();
    if (mustUse2fa(user.roles, s)) throw badRequest('Für deine Rolle ist die Zwei-Faktor-Anmeldung vorgeschrieben.');
    if (!(await verifyPassword(user.password_hash, body.password))) throw badRequest('Passwort ist falsch.');
    await pool.query(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE id = $1`, [user.id]);
    await audit(req.auth!.actor, 'auth.mfa_disabled', { type: 'user', id: user.id, label: user.email });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth?.sessionId) {
      await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
      if (req.auth.stage === 'full') await audit(req.auth.actor, 'auth.logout', { type: 'user', id: req.auth.user?.id, label: req.auth.user?.email });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/auth/logout-all', { preHandler: requireAuth() }, async (req, reply) => {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.auth!.user!.id]);
    await audit(req.auth!.actor, 'auth.logout_all', { type: 'user', id: req.auth!.user!.id, label: req.auth!.user!.email });
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
      roleLabels: ROLES.filter((r) => u.roles.includes(r.id)).map((r) => r.label),
      instance: { name: s['general.instance_name'], subtitle: s['general.instance_subtitle'], timezone: s['general.timezone'], language: s['general.language'] },
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
      })
      .parse(req.body);
    await pool.query(`UPDATE users SET preferences = preferences || $2::jsonb WHERE id = $1`, [req.auth!.user!.id, JSON.stringify(prefs)]);
    return { ok: true };
  });

  app.post('/auth/password', { preHandler: requireAuth(), ...loginLimit }, async (req, reply) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const user = await one<any>('SELECT * FROM users WHERE id = $1', [req.auth!.user!.id]);
    if (!(await verifyPassword(user.password_hash, body.current))) throw badRequest('Aktuelles Passwort ist falsch.');
    const s = await getSettings();
    const problem = passwordProblems(body.next, s['security.password_min_length']);
    if (problem) throw badRequest(problem);
    await pool.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [user.id, await hashPassword(body.next)]);
    // Alle anderen Sitzungen beenden
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, req.auth!.sessionId]);
    await audit(req.auth!.actor, 'auth.password_changed', { type: 'user', id: user.id, label: user.email });
    return { ok: true };
  });

  app.get('/auth/sessions', { preHandler: requireAuth() }, async (req) => {
    const rows = await many<any>(
      `SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND stage = 'full' ORDER BY last_seen_at DESC`,
      [req.auth!.user!.id],
    );
    return rows.map((r) => ({ ...r, current: r.id === req.auth!.sessionId }));
  });

  app.delete('/auth/sessions/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2', [id, req.auth!.user!.id]);
    return { ok: true };
  });

  /* Einladung / Passwort-Link */
  app.get('/auth/invite/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.params);
    const inv = await one<any>(
      `SELECT i.*, u.email, u.name, u.status FROM invitations i JOIN users u ON u.id = i.user_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
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
    const problem = passwordProblems(body.password, s['security.password_min_length']);
    if (problem) throw badRequest(problem);
    const user = await tx(async (db) => {
      const inv = await one<any>(`SELECT * FROM invitations WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256Hex(token)], db);
      if (!inv) throw new AppError(404, 'invite_invalid', 'Der Link ist ungültig oder abgelaufen.');
      await db.query('UPDATE invitations SET used_at = now() WHERE id = $1', [inv.id]);
      const u = await one<any>(
        `UPDATE users SET name = $2, password_hash = $3, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, password_changed_at = now(), failed_logins = 0, locked_until = NULL
          WHERE id = $1 RETURNING *`,
        [inv.user_id, body.name, await hashPassword(body.password)],
        db,
      );
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      return u;
    });
    await audit({ id: user.id, name: user.name, type: 'user', ip: req.ip }, 'auth.invite_accepted', { type: 'user', id: user.id, label: user.email });
    if (user.status !== 'active') throw new AppError(403, 'disabled', 'Das Konto ist deaktiviert.');
    const stage = user.totp_enabled ? 'mfa' : mustUse2fa(user.roles, s) ? 'mfa_setup' : 'full';
    await createSession(reply, req, user.id, stage);
    return { next: stage === 'full' ? 'done' : stage };
  });

  void SESSION_COOKIE;
}
