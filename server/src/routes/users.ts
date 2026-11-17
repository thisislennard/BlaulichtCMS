import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { assertRecentAuth, requireAnyAuth, requireAuth } from '../auth/context.js';
import { ADMIN_ROLE, hasAdminPermissions, roleExists, roleLabel } from '../auth/permissions.js';
import { rolesWithinOwn } from './roles.js';
import { revokeTrustedDevices } from '../auth/devices.js';
import { audit } from '../lib/audit.js';
import { notifyAffectedUser, securityAlert } from '../lib/security-alerts.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { publicBase } from '../lib/urls.js';

async function inviteLink(req: any, token: string) {
  return `${await publicBase(req)}/einladung/${token}`;
}

async function createInvite(userId: string, createdBy: string | null, hours: number, db: any = pool) {
  const token = randomToken(24);
  await db.query('UPDATE invitations SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [userId, createdBy]);
  await db.query(`INSERT INTO invitations (user_id, token_hash, expires_at, created_by) VALUES ($1,$2, now() + make_interval(hours => $3), $4)`, [userId, sha256Hex(token), Math.max(1, Math.round(Number(hours) || 72)), createdBy]);
  return token;
}

/** Mindestens ein aktiver Plattform-Admin muss bleiben. */
async function assertAdminRemains(db: any, excludingUserId: string) {
  // Transaktionsweite Sperre: zwei gleichzeitige Rollenentzüge laufen nacheinander, der zweite zählt nach dem Commit
  // des ersten (#79). Advisory-Lock statt Zeilensperren, weil jede Transaktion ihre Zielzeile schon hält (Deadlock).
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('blaulichtcms:platform-admins'))`);
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE status = 'active' AND 'platform_admin' = ANY(roles) AND id <> $1`, [excludingUserId], db);
  if (r!.n === 0) throw conflict('Es muss mindestens ein aktiver Plattform-Admin bleiben.');
}

const rolesSchema = z.array(z.string().min(1).max(40)).min(1).max(30);

/** Nur vorhandene Rollen, jede höchstens einmal. */
function cleanRoles(roles: string[]): string[] {
  const unique = [...new Set(roles)];
  const unknown = unique.filter((r) => !roleExists(r));
  if (unknown.length) throw badRequest(`Unbekannte Rolle: ${unknown.slice(0, 3).join(', ')}.`);
  return unique;
}

/**
 * Keine Rechteausweitung über die Benutzerverwaltung: Rollen vergeben oder entziehen und Konten übernehmen
 * (Passwort-Link, Zwei-Faktor zurücksetzen), sperren oder löschen darf nur, wer selbst alle Rechte dieser Rollen hat.
 */
function assertRolesWithinOwn(req: any, roles: string[], message: string) {
  if (!rolesWithinOwn(req, roles)) throw forbidden(message);
}
const ABOVE = 'Dieses Konto hat Rechte, die du selbst nicht hast. Das darf nur, wer mindestens dieselben Rechte hat.';

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: requireAuth('user.view') }, async () => {
    const users = await many<any>(
      `SELECT u.id, u.email, u.name, u.roles, u.status, u.totp_enabled, u.last_active_at, u.last_login_at, u.created_at,
              CASE WHEN u.locked_until > now() THEN u.locked_until END AS locked_until, u.failed_logins, u.mfa_failed,
              (SELECT max(expires_at) FROM invitations i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.revoked_at IS NULL) AS invite_expires_at,
              (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.stage = 'full' AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
              (SELECT count(*)::int FROM trusted_devices t WHERE t.user_id = u.id AND t.revoked_at IS NULL AND t.expires_at > now()) AS trusted_devices
         FROM users u ORDER BY u.status = 'disabled', lower(u.name)`,
    );
    const keys = await many<any>(`SELECT id, name, roles, last_used_at, created_at FROM api_keys WHERE revoked_at IS NULL ORDER BY name`);
    return { users, serviceAccounts: keys };
  });

  app.post('/users/invite', { preHandler: requireAuth('user.invite') }, async (req) => {
    const body = z.object({ email: z.email().max(200), name: z.string().trim().max(80).optional(), roles: rolesSchema }).parse(req.body);
    body.roles = cleanRoles(body.roles);
    assertRolesWithinOwn(req, body.roles, 'Du kannst nur Rollen vergeben, deren Rechte du selbst vollständig hast.');
    const existing = await one('SELECT id FROM users WHERE lower(email) = lower($1)', [body.email]);
    if (existing) throw conflict('Für diese E-Mail-Adresse gibt es schon ein Konto.');
    // Konten mit Verwaltungsrechten anlegen: nur mit frischer Passwortbestätigung (#109)
    if (hasAdminPermissions(body.roles)) assertRecentAuth(req);
    const hours = (await getSettings())['invites.valid_hours'];
    // Konto und Einladung gemeinsam: scheitert die Einladung, bleibt kein verwaistes Konto zurück
    // Die Vorprüfung oben ist nur für die Meldung; die eigentliche Absicherung ist der eindeutige Index
    // users_email_uq. Gleichzeitige Einladungen derselben Adresse enden dort als 409 statt 500 (#174).
    const { user, token } = await tx(async (db) => {
      const user = await one<any>(
        `INSERT INTO users (email, name, roles, status, created_by) VALUES ($1,$2,$3,'invited',$4)
         ON CONFLICT ((lower(email))) DO NOTHING RETURNING id, email, name`,
        [body.email.toLowerCase(), body.name || body.email.split('@')[0], body.roles, req.auth!.user?.id ?? null],
        db,
      );
      if (!user) throw conflict('Für diese E-Mail-Adresse gibt es schon ein Konto.');
      return { user, token: await createInvite(user.id, req.auth!.user?.id ?? null, hours, db) };
    });
    await audit(req.auth!.actor, 'user.invited', { type: 'user', id: user.id, label: user.email }, { rollen: body.roles });
    return { user, link: await inviteLink(req, token), expiresHours: hours };
  });

  app.post('/users/:id/link', { preHandler: requireAuth('user.invite') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const user = await one<any>('SELECT id, email, status, roles FROM users WHERE id = $1', [id]);
    if (!user) throw notFound();
    if (user.status === 'disabled') throw badRequest('Das Konto ist deaktiviert.');
    // Ein Passwort-Link übernimmt das Konto: nie für Konten mit mehr Rechten, bei Verwaltungsrechten nur mit
    // frischer Passwortbestätigung (#109)
    assertRolesWithinOwn(req, user.roles, ABOVE);
    if (hasAdminPermissions(user.roles)) assertRecentAuth(req);
    const hours = user.status === 'invited' ? (await getSettings())['invites.valid_hours'] : Math.min(24, (await getSettings())['invites.valid_hours']);
    const token = await createInvite(id, req.auth!.user?.id ?? null, hours);
    // Passwort-Link = Verdacht auf vergessenes oder bekanntes Passwort: gemerkte Geräte der Zwei-Faktor-Anmeldung entfernen
    const devices = user.status === 'active' ? await revokeTrustedDevices(id) : 0;
    await audit(req.auth!.actor, user.status === 'invited' ? 'user.invite_renewed' : 'user.password_reset_link', { type: 'user', id, label: user.email }, devices ? { vertrauenswuerdige_geraete: devices } : {});
    return { link: await inviteLink(req, token), expiresHours: hours };
  });

  /** Offene Einladung bzw. offenen Passwort-Link widerrufen. Der Link funktioniert danach nicht mehr. */
  app.post('/users/:id/revoke-link', { preHandler: requireAuth('user.invite') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const user = await one<any>('SELECT id, email FROM users WHERE id = $1', [id]);
    if (!user) throw notFound();
    const r = await pool.query('UPDATE invitations SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()', [id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'user.invite_revoked', { type: 'user', id, label: user.email }, { anzahl: r.rowCount });
    return { revoked: r.rowCount };
  });

  app.patch('/users/:id', { preHandler: requireAnyAuth('user.edit', 'user.assign_roles', 'user.lock') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        roles: rolesSchema.optional(),
        status: z.enum(['active', 'disabled']).optional(),
      })
      .parse(req.body);
    const perms = req.auth!.permissions;
    if (body.name !== undefined && !perms.has('user.edit')) throw forbidden('Zum Umbenennen fehlt das Recht „Benutzer umbenennen“.');
    if (body.roles && !perms.has('user.assign_roles')) throw forbidden('Zum Ändern der Rollen fehlt das Recht „Rollen zuweisen“.');
    if (body.status && !perms.has('user.lock')) throw forbidden('Zum Sperren und Entsperren fehlt das Recht „Konten sperren und entsperren“.');
    if (body.roles) {
      const current = await one<any>('SELECT roles FROM users WHERE id = $1', [id]);
      if (current) {
        // Rollen, die bleiben, dürfen auch unbekannt sein (gelöschte Rolle); neue müssen existieren
        const kept = body.roles.filter((r) => current.roles.includes(r));
        const added = cleanRoles(body.roles.filter((r) => !current.roles.includes(r)));
        const removed = (current.roles as string[]).filter((r) => !body.roles!.includes(r));
        body.roles = [...new Set([...kept, ...added])];
        assertRolesWithinOwn(req, added, 'Du kannst nur Rollen vergeben, deren Rechte du selbst vollständig hast.');
        assertRolesWithinOwn(req, removed, 'Du kannst nur Rollen entziehen, deren Rechte du selbst vollständig hast.');
        if (hasAdminPermissions(body.roles) && !hasAdminPermissions(current.roles)) assertRecentAuth(req);
      }
    }
    const result = await tx(async (db) => {
      const user = await one<any>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id], db);
      if (!user) throw notFound();
      if (body.status === 'active' && user.status === 'invited') throw badRequest('Eingeladene Konten werden durch Annehmen der Einladung aktiv.');
      // Reaktivieren gibt dem Konto alle Rechte seiner Rollen zurück: dieselbe Obergrenze wie beim Sperren und bei der
      // Rollenvergabe (geprüft an den Rollen nach der Änderung) und frische Passwortbestätigung (#238)
      if (body.status === 'active' && user.status === 'disabled') {
        assertRolesWithinOwn(req, body.roles ?? user.roles, ABOVE);
        assertRecentAuth(req);
      }
      // Ein Konto ohne Passwort (Einladung nie angenommen) wird beim Reaktivieren wieder „eingeladen“, nicht „aktiv“
      if (body.status === 'active' && !user.password_hash) body.status = 'invited' as any;
      if (body.status === 'disabled') assertRolesWithinOwn(req, user.roles, ABOVE);
      const losesAdmin = (body.roles && user.roles.includes(ADMIN_ROLE) && !body.roles.includes(ADMIN_ROLE)) || (body.status === 'disabled' && user.roles.includes(ADMIN_ROLE));
      if (losesAdmin) await assertAdminRemains(db, id);
      const updated = await one<any>(
        `UPDATE users SET name = COALESCE($2, name), roles = COALESCE($3, roles), status = COALESCE($4, status) WHERE id = $1 RETURNING id, email, name, roles, status`,
        [id, body.name ?? null, body.roles ?? null, body.status ?? null],
        db,
      );
      // Rechte geändert/deaktiviert: Sitzungen beenden – bei Änderungen am eigenen Konto die aktuelle Sitzung behalten
      const keep = id === req.auth!.user?.id ? (req.auth!.sessionId ?? null) : null;
      if (body.status === 'disabled' || body.roles) await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [id, keep]);
      if (body.status === 'disabled') await revokeTrustedDevices(id, db);
      // Deaktivieren macht offene Einladungen und Passwort-Links unbrauchbar
      if (body.status === 'disabled') await db.query('UPDATE invitations SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [id, req.auth!.user?.id ?? null]);
      return { before: user, updated };
    });
    if (body.roles) await audit(req.auth!.actor, 'user.roles_changed', { type: 'user', id, label: result.updated.email }, { vorher: result.before.roles, nachher: body.roles });
    if (body.roles && hasAdminPermissions(body.roles) && !hasAdminPermissions(result.before.roles)) {
      await securityAlert('admin_granted', { title: `Verwaltungsrechte vergeben: ${result.updated.email}`, body: `Vergeben von ${req.auth!.actor.name}. Rollen jetzt: ${body.roles.map(roleLabel).join(', ')}.`, link: '/benutzer', permission: 'user.assign_roles' });
    }
    if (body.roles && !hasAdminPermissions(body.roles) && hasAdminPermissions(result.before.roles)) {
      await securityAlert('admin_removed', { title: `Verwaltungsrechte entzogen: ${result.updated.email}`, body: `Entzogen von ${req.auth!.actor.name}.`, link: '/benutzer', permission: 'user.assign_roles', kind: 'info' });
    }
    const reenabled = body.status !== 'disabled' && result.before.status === 'disabled' && result.updated.status !== 'disabled';
    if (body.status) await audit(req.auth!.actor, body.status === 'disabled' ? 'user.disabled' : 'user.enabled', { type: 'user', id, label: result.updated.email }, reenabled ? { rollen: result.updated.roles, status: result.updated.status } : {});
    if (reenabled && hasAdminPermissions(result.updated.roles)) {
      await securityAlert('admin_granted', { title: `Konto mit Verwaltungsrechten reaktiviert: ${result.updated.email}`, body: `Reaktiviert von ${req.auth!.actor.name}. Rollen: ${result.updated.roles.map(roleLabel).join(', ')}.`, link: '/benutzer', permission: 'user.lock' });
    }
    if (body.name) await audit(req.auth!.actor, 'user.renamed', { type: 'user', id, label: result.updated.email });
    return result.updated;
  });

  app.post('/users/:id/reset-2fa', { preHandler: requireAuth('user.lock') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    assertRecentAuth(req);
    const target = await one<any>('SELECT roles FROM users WHERE id = $1', [id]);
    if (!target) throw notFound();
    assertRolesWithinOwn(req, target.roles, ABOVE);
    const user = await one<any>(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE id = $1 RETURNING email`, [id]);
    if (!user) throw notFound();
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await revokeTrustedDevices(id);
    await audit(req.auth!.actor, 'user.mfa_reset', { type: 'user', id, label: user.email });
    await notifyAffectedUser(id, 'Deine Zwei-Faktor-Anmeldung wurde zurückgesetzt', `Zurückgesetzt von ${req.auth!.actor.name}. Warst du das nicht, bitte sofort die Administration informieren.`);
    await securityAlert('mfa_reset', { title: `Zwei-Faktor zurückgesetzt: ${user.email}`, body: `Durch ${req.auth!.actor.name}.`, link: '/benutzer', permission: 'user.lock', kind: 'info' });
    return { ok: true };
  });

  /**
   * Alle Sitzungen eines Kontos beenden (auch gemerkte) und alle vertrauenswürdigen Geräte entfernen – z. B. bei
   * verlorenem Telefon oder Verdacht auf eine übernommene Sitzung. Beim eigenen Konto bleibt diese Sitzung bestehen.
   */
  app.post('/users/:id/end-sessions', { preHandler: requireAuth('user.sessions') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const user = await one<any>('SELECT id, email FROM users WHERE id = $1', [id]);
    if (!user) throw notFound();
    const keep = id === req.auth!.user?.id ? (req.auth!.sessionId ?? null) : null;
    const r = await pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [id, keep]);
    const devices = await revokeTrustedDevices(id);
    await audit(req.auth!.actor, 'user.sessions_ended', { type: 'user', id, label: user.email }, { sitzungen: r.rowCount ?? 0, vertrauenswuerdige_geraete: devices });
    if (id !== req.auth!.user?.id) {
      await notifyAffectedUser(id, 'Du wurdest auf allen Geräten abgemeldet', `Abgemeldet von ${req.auth!.actor.name}; gemerkte Geräte der Zwei-Faktor-Anmeldung wurden entfernt. Bitte neu anmelden.`);
    }
    return { sessions: r.rowCount ?? 0, trustedDevices: devices };
  });

  /**
   * Sperre nach Fehlversuchen vorzeitig aufheben (Passwort und 2FA). Wie beim Sperren nur für Konten innerhalb der
   * eigenen Rechte (#238) – sonst ließe sich die Bremse gegen das Erraten eines Admin-Passworts lösen.
   */
  app.post('/users/:id/unlock', { preHandler: requireAuth('user.lock') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const target = await one<any>('SELECT roles FROM users WHERE id = $1', [id]);
    if (!target) throw notFound();
    assertRolesWithinOwn(req, target.roles, ABOVE);
    const user = await one<any>(`UPDATE users SET locked_until = NULL, failed_logins = 0, mfa_failed = 0 WHERE id = $1 RETURNING email`, [id]);
    if (!user) throw notFound();
    await pool.query('DELETE FROM auth_throttle WHERE user_id = $1', [id]);
    await audit(req.auth!.actor, 'user.unlocked', { type: 'user', id, label: user.email });
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: requireAuth('user.delete') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (id === req.auth!.user?.id) throw badRequest('Das eigene Konto kann nicht gelöscht werden.');
    await tx(async (db) => {
      const user = await one<any>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id], db);
      if (!user) throw notFound();
      if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) throw badRequest('Zur Bestätigung die E-Mail-Adresse des Kontos eingeben.');
      assertRolesWithinOwn(req, user.roles, ABOVE);
      if (user.roles.includes(ADMIN_ROLE)) await assertAdminRemains(db, id);
      await db.query('DELETE FROM users WHERE id = $1', [id]);
      await audit(req.auth!.actor, 'user.deleted', { type: 'user', id, label: user.email }, {}, 'ok', db);
    });
    return { ok: true };
  });
}
