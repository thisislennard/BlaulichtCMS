import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { finePermissionsFor, hasAdminPermissions, isAdminRoleSet, permissionsFor } from './permissions.js';
import { ensureRolesFresh } from './roles.js';
import { deviceHash, issueDeviceCookie, knownDevice } from './lockout.js';

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
  /** Volle Sitzung: gemerkt („Angemeldet bleiben“); Zwischenstufe: Wunsch von der Anmeldeseite. */
  remember?: boolean;
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

export interface SessionOptions {
  /** „Angemeldet bleiben“: bei voller Sitzung gemerkt, bei Zwischenstufen als Wunsch für den Übergang gespeichert. */
  remember?: boolean;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: Math.max(60, Math.round(maxAgeSeconds)),
  });
}

/**
 * Neue Sitzung mit neuem Token (auch beim Übergang mfa → full, kein Weiterverwenden des Zwischentokens).
 *
 * Gemerkte Sitzungen („Angemeldet bleiben“, nur mit `security.remember_enabled`): keine Leerlaufabmeldung, Ablauf
 * `security.remember_days` nach der letzten Nutzung (gleitend, siehe fromSession), gebunden an das Geräte-Cookie.
 * Zwischenstufen (mfa, mfa_setup) bleiben immer 15 Minuten kurz; dort wird nur der Wunsch gespeichert.
 */
export async function createSession(
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
  stage: 'mfa' | 'mfa_setup' | 'full',
  opts: SessionOptions = {},
): Promise<{ id: string; device: string | null; remembered: boolean }> {
  const s = await getSettings();
  const token = randomToken(32);
  const full = stage === 'full';
  const remember = !!opts.remember && s['security.remember_enabled'];
  const remembered = full && remember;
  // Vollständig angemeldet: dieses Gerät gilt als bekannt (Ausnahme von der Kontosperre, #110)
  const device = full ? issueDeviceCookie(req, reply, userId) : null;
  const minutes = remembered ? s['security.remember_days'] * 1440 : full ? Math.round(s['security.session_max_hours'] * 60) : 15;
  const row = await one<{ id: string }>(
    `INSERT INTO sessions (token_hash, user_id, stage, expires_at, ip, user_agent, reauth_at, remember, device_hash)
     VALUES ($1,$2,$3, now() + make_interval(mins => $4), $5, $6, CASE WHEN $3 = 'full' THEN now() END, $7, $8) RETURNING id`,
    [sha256Hex(token), userId, stage, minutes, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), remember, remembered && device ? deviceHash(userId, device) : null],
  );
  setSessionCookie(reply, token, minutes * 60);
  return { id: row!.id, device, remembered };
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict', httpOnly: true });
}

/** Gleitenden Ablauf gemerkter Sitzungen höchstens so oft erneuern (Schreiblast, Cookie-Neuausstellung). */
const REMEMBER_RENEW_MS = 60 * 60_000;

async function fromSession(req: FastifyRequest, reply?: FastifyReply): Promise<AuthContext | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const s = await getSettings();
  const row = await one<any>(
    `SELECT s.id AS session_id, s.stage, s.last_seen_at, s.reauth_at, s.remember, s.device_hash, s.expires_at,
            u.id, u.email, u.name, u.roles, u.status, u.totp_enabled, u.preferences
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  if (!row || row.status !== 'active') return null;
  const revoke = async () => {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.session_id]);
    return null;
  };
  const remembered = row.stage === 'full' && row.remember;
  const sinceSeen = Date.now() - new Date(row.last_seen_at).getTime();
  if (remembered) {
    // Funktion abgeschaltet: gemerkte Sitzungen gelten sofort nicht mehr (auch vor dem Aufräumen beim Speichern)
    if (!s['security.remember_enabled']) return revoke();
    // Gerätebindung: das Sitzungs-Cookie allein (z. B. kopiert) genügt nicht – das signierte Geräte-Cookie desselben
    // Browsers muss mitkommen
    const device = knownDevice(req, row.id);
    if (!device || !row.device_hash || !safeEqual(deviceHash(row.id, device), row.device_hash)) return revoke();
    // Gleitender Ablauf: höchstens einmal pro Stunde erneuern; eine verkürzte Frist greift beim nächsten Aufruf
    const target = Date.now() + s['security.remember_days'] * 86_400_000;
    if (Math.abs(target - new Date(row.expires_at).getTime()) > REMEMBER_RENEW_MS) {
      const r = await pool.query('UPDATE sessions SET expires_at = now() + make_interval(days => $2) WHERE id = $1 AND revoked_at IS NULL', [row.session_id, s['security.remember_days']]);
      if (r.rowCount && reply) {
        setSessionCookie(reply, token, s['security.remember_days'] * 86400);
        issueDeviceCookie(req, reply, row.id);
      }
    }
  } else if (sinceSeen > s['security.session_idle_minutes'] * 60_000) {
    return revoke();
  }
  let stage: AuthContext['stage'] = row.stage;
  // Zwei-Faktor-Pflicht bei jeder Anfrage, nicht nur bei der Anmeldung (#235): Gilt sie (inzwischen) für ein Konto ohne
  // zweiten Faktor – Pflicht eingeschaltet oder ausgeweitet, Rechte erweitert –, endet eine volle Sitzung, auch eine
  // gemerkte. Ist das Passwort in dieser Sitzung gerade erst bestätigt worden (z. B. von der Person, die die Pflicht
  // eben eingeschaltet hat), geht es stattdessen direkt zur Einrichtung – wie nach einer Anmeldung, kurz befristet.
  if (stage === 'full' && !row.totp_enabled && mustUse2fa(row.roles, s)) {
    const fresh = !!row.reauth_at && Date.now() - new Date(row.reauth_at).getTime() < REAUTH_MINUTES * 60_000;
    if (!fresh) return revoke();
    await pool.query(`UPDATE sessions SET stage = 'mfa_setup', device_hash = NULL, expires_at = LEAST(expires_at, now() + interval '15 minutes') WHERE id = $1`, [row.session_id]);
    stage = 'mfa_setup';
  }
  // last_seen höchstens einmal pro Minute schreiben
  if (sinceSeen > 60_000) {
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
  const full = stage === 'full';
  return {
    kind: 'session',
    user,
    sessionId: row.session_id,
    stage,
    remember: !!row.remember,
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

export async function resolveAuth(req: FastifyRequest, reply?: FastifyReply): Promise<AuthContext | null> {
  // Rollen und ihre Rechte: aktueller Stand (Änderungen gelten ab der nächsten Anfrage, siehe auth/roles.ts)
  await ensureRolesFresh();
  return (await fromApiKey(req)) ?? (await fromSession(req, reply));
}

/**
 * Zugriffsangabe einer Route. Jede Route unter /api/v1 trägt genau eine davon (oder steht in PUBLIC_ROUTES); die
 * Tests lesen sie aus der Routentabelle (app.routeAccess) und prüfen Vollständigkeit und die 403-Matrix.
 * - `login`: jede vollständig angemeldete Person (eigenes Konto, Dashboard, Benachrichtigungen)
 * - `all`: alle genannten Rechte (im Regelfall genau eines)
 * - `any`: eines der genannten Rechte; der Handler prüft je Feld oder Aktion das passende
 */
export interface RouteAccess {
  kind: 'login' | 'all' | 'any';
  permissions: string[];
}
export type Guard = ((req: FastifyRequest) => Promise<void>) & { access?: RouteAccess };

/** Prüft angemeldet + volle Sitzung (+ optional Rechte). */
export function requireAuth(...perms: string[]): Guard {
  const guard: Guard = async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.stage !== 'full') throw unauthorized();
    for (const p of perms) if (!a.permissions.has(p)) throw forbidden();
  };
  guard.access = { kind: perms.length ? 'all' : 'login', permissions: perms };
  return guard;
}

export function requireAnyAuth(...perms: string[]): Guard {
  const guard: Guard = async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.stage !== 'full') throw unauthorized();
    if (perms.length && !perms.some((p) => a.permissions.has(p))) throw forbidden();
  };
  guard.access = { kind: perms.length ? 'any' : 'login', permissions: perms };
  return guard;
}

/** Zusätzliche Bedingung hinter requireAuth: außerdem eines dieser Rechte (zählt nicht als Zugriffsangabe). */
export function alsoAny(...perms: string[]) {
  return async (req: FastifyRequest) => {
    if (!perms.some((p) => req.auth?.permissions.has(p))) throw forbidden();
  };
}

/** Zusätzliche Bedingung: nur mit Benutzerkonto, nicht per API-Schlüssel. */
export function requireSession() {
  return async (req: FastifyRequest) => {
    if (req.auth?.kind !== 'session') throw forbidden('Diese Aktion ist nur mit einer Benutzeranmeldung möglich, nicht per API-Schlüssel.');
  };
}

/** Nur die Rolle „Administration“ mit Benutzerkonto (kein API-Schlüssel). */
export function requirePlatformAdmin(): Guard {
  const guard: Guard = async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a || a.stage !== 'full') throw unauthorized();
    if (a.kind !== 'session' || !a.roles.includes('platform_admin')) throw forbidden('Nur Plattform-Admins dürfen das.');
  };
  guard.access = { kind: 'all', permissions: ['role.manage'] };
  return guard;
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

/**
 * Zwei-Faktor-Pflicht, ausgedrückt über Rechte statt über feste Rollen:
 * - `security.require_2fa_all`: alle Konten.
 * - `security.require_2fa_admins`: Konten mit Verwaltungsrechten (Konten, Rollen, Einstellungen, Sicherungen, Updates,
 *   Verbindungen, Kopplung von Websites, Datenschutzanfragen … – im Katalog als Verwaltungsrecht markiert). Mit den
 *   mitgelieferten Rollen trifft das wie bisher nur die Administration; eigene Rollen mit solchen Rechten zählen dazu.
 * - `security.require_2fa_media`: Konten mit „Originale herunterladen“ (GPS, ungesichtete Bürgerfotos; #140, Art. 32
 *   DSGVO) – bisher „Medien verwalten“.
 */
export function mustUse2fa(roles: string[], s: Awaited<ReturnType<typeof getSettings>>): boolean {
  return (
    s['security.require_2fa_all'] ||
    (s['security.require_2fa_admins'] && (isAdminRoleSet(roles) || hasAdminPermissions(roles))) ||
    (s['security.require_2fa_media'] && finePermissionsFor(roles).has('media.download_original'))
  );
}
