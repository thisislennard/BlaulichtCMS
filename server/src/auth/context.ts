import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { isAdminRoleSet, permissionsFor } from './permissions.js';
import { issueDeviceCookie } from './lockout.js';

export const SESSION_COOKIE = config.cookieSecure ? '__Host-bc_session' : 'bc_session';
/** Pflicht-Header für alle ändernden Anfragen mit Sitzungs-Cookie (CSRF-Schutz zusätzlich zu SameSite=Strict). */
export const CSRF_HEADER = 'x-blaulichtcms-request';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
  totp_enabled: boolean;
  preferences: Record<string, unknown>;
}

export interface AuthContext {
  kind: 'session' | 'api_key';
  user: AuthUser | null;
  apiKeyId?: string;
  sessionId?: string;
  stage: 'mfa' | 'mfa_setup' | 'full';
  /** Letzte Bestätigung mit Passwort in dieser Sitzung (Anmeldung oder /auth/reauth), siehe assertRecentAuth. */
  reauthAt?: Date | null;
  permissions: Set<string>;
  roles: string[];
  actor: Actor;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export async function createSession(
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
  stage: 'mfa' | 'mfa_setup' | 'full',
): Promise<string> {
  const s = await getSettings();
  const token = randomToken(32);
  const maxHours = stage === 'full' ? s['security.session_max_hours'] : 0.25;
  const row = await one<{ id: string }>(
    `INSERT INTO sessions (token_hash, user_id, stage, expires_at, ip, user_agent, reauth_at)
     VALUES ($1,$2,$3, now() + make_interval(mins => $4), $5, $6, CASE WHEN $3 = 'full' THEN now() END) RETURNING id`,
    [sha256Hex(token), userId, stage, Math.round(maxHours * 60), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: Math.round(maxHours * 3600),
  });
  // Vollständig angemeldet: dieses Gerät gilt als bekannt (Ausnahme von der Kontosperre, #110)
  if (stage === 'full') issueDeviceCookie(req, reply, userId);
  return row!.id;
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict', httpOnly: true });
}

async function fromSession(req: FastifyRequest): Promise<AuthContext | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const s = await getSettings();
  const row = await one<any>(
    `SELECT s.id AS session_id, s.stage, s.last_seen_at, s.reauth_at, u.id, u.email, u.name, u.roles, u.status, u.totp_enabled, u.preferences
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  if (!row || row.status !== 'active') return null;
  const idleMs = s['security.session_idle_minutes'] * 60_000;
  if (Date.now() - new Date(row.last_seen_at).getTime() > idleMs) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.session_id]);
    return null;
  }
  // last_seen höchstens einmal pro Minute schreiben
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => {});
    pool.query('UPDATE users SET last_active_at = now() WHERE id = $1', [row.id]).catch(() => {});
  }
  const user: AuthUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    roles: row.roles,
    status: row.status,
    totp_enabled: row.totp_enabled,
    preferences: row.preferences ?? {},
  };
  const full = row.stage === 'full';
  return {
    kind: 'session',
    user,
    sessionId: row.session_id,
    stage: row.stage,
    reauthAt: row.reauth_at ? new Date(row.reauth_at) : null,
    permissions: full ? permissionsFor(user.roles) : new Set(),
    roles: full ? user.roles : [],
    actor: { id: user.id, name: user.name, type: 'user', ip: req.ip },
  };
}

async function fromApiKey(req: FastifyRequest): Promise<AuthContext | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer bc_')) return null;
  const token = header.slice(7).trim();
  const [, prefix] = token.split('_');
  if (!prefix) return null;
  const row = await one<any>(
    `SELECT id, name, roles, key_hash FROM api_keys
      WHERE prefix = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [prefix],
  );
  if (!row || row.key_hash !== sha256Hex(token)) {
    // Ungültiger, abgelaufener oder widerrufener API-Schlüssel: auditieren und melden, gedrosselt (#101, #111)
    const { auditThrottled } = await import('../lib/audit.js');
    const { securityAlert } = await import('../lib/security-alerts.js');
    await auditThrottled(`apikey:${req.ip}:${prefix}`, 10 * 60_000, { id: null, name: 'API-Schlüssel (ungültig)', type: 'api_key', ip: req.ip }, 'api_key.auth', { type: 'api_key', label: `Präfix ${prefix.slice(0, 16)}` }, { grund: row ? 'Schlüssel falsch' : 'unbekannt, abgelaufen oder widerrufen' }, 'failed').catch(() => {});
    await securityAlert('api_key_auth', { title: 'Anmeldung mit ungültigem API-Schlüssel', body: `Von ${req.ip} (Präfix ${prefix.slice(0, 16)}). Abgelaufene oder widerrufene Schlüssel aus Skripten entfernen; bei unbekannter Herkunft das Audit-Protokoll prüfen.`, throttleKey: req.ip });
    return null;
  }
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  return {
    kind: 'api_key',
    user: null,
    apiKeyId: row.id,
    stage: 'full',
    permissions: permissionsFor(row.roles),
    roles: row.roles,
    actor: { id: row.id, name: `API-Schlüssel „${row.name}“`, type: 'api_key', ip: req.ip },
  };
}

export async function resolveAuth(req: FastifyRequest): Promise<AuthContext | null> {
  return (await fromApiKey(req)) ?? (await fromSession(req));
}

/** Prüft angemeldet + volle Sitzung (+ optional Rechte). */
export function requireAuth(...perms: string[]) {
  return async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.stage !== 'full') throw unauthorized();
    for (const p of perms) if (!a.permissions.has(p)) throw forbidden();
  };
}

export function requireAnyAuth(...perms: string[]) {
  return async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.stage !== 'full') throw unauthorized();
    if (perms.length && !perms.some((p) => a.permissions.has(p))) throw forbidden();
  };
}

/** Updates einspielen = beliebigen Code ausführen: nur Plattform-Admins mit Benutzerkonto (kein API-Schlüssel). */
export function requirePlatformAdmin() {
  return async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.stage !== 'full') throw unauthorized();
    if (a.kind !== 'session' || !a.roles.includes('platform_admin')) throw forbidden('Nur Plattform-Admins dürfen das.');
  };
}

/** So lange gilt eine Bestätigung mit Passwort für kritische Aktionen (#109). */
export const REAUTH_MINUTES = 10;

export function hasRecentAuth(a: AuthContext | null | undefined): boolean {
  return !!a && a.kind === 'session' && !!a.reauthAt && Date.now() - a.reauthAt.getTime() < REAUTH_MINUTES * 60_000;
}

/**
 * Step-up für kritische Aktionen (#109): Rechte an Admins vergeben, Zwei-Faktor fremder Konten zurücksetzen,
 * Passwort-Links für Admins, Sicherheitseinstellungen. Verlangt eine Sitzung, deren letzte Passwortbestätigung
 * höchstens REAUTH_MINUTES alt ist; die Oberfläche fragt dann Passwort (und Code) ab und wiederholt die Aktion.
 * API-Schlüssel können sich nicht erneut bestätigen und dürfen diese Aktionen nicht ausführen.
 */
export function assertRecentAuth(req: FastifyRequest) {
  const a = req.auth;
  if (!a || a.kind !== 'session') throw forbidden('Diese Aktion ist nur mit einer Benutzeranmeldung möglich, nicht per API-Schlüssel.');
  if (!hasRecentAuth(a)) throw new AppError(403, 'reauth_required', 'Bitte diese Aktion mit deinem Passwort bestätigen.', { minutes: REAUTH_MINUTES });
}

export function mustUse2fa(roles: string[], s: Awaited<ReturnType<typeof getSettings>>): boolean {
  return (
    s['security.require_2fa_all'] ||
    (s['security.require_2fa_admins'] && isAdminRoleSet(roles)) ||
    // Zugriff auf Originale (GPS, ungesichtete Bürgerfotos) nur mit zweitem Faktor (#140, Art. 32 DSGVO)
    (s['security.require_2fa_media'] && permissionsFor(roles).has('media.manage'))
  );
}
