import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { matrix, MODULES, PERMISSIONS, ROLE_IDS, ROLES } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

function inviteLink(req: any, token: string) {
  const base = config.publicUrl || `${req.protocol}://${req.headers.host}`;
  return `${base}/einladung/${token}`;
}

async function createInvite(userId: string, createdBy: string | null, hours: number) {
  const token = randomToken(24);
  await pool.query('UPDATE invitations SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await pool.query(`INSERT INTO invitations (user_id, token_hash, expires_at, created_by) VALUES ($1,$2, now() + make_interval(hours => $3), $4)`, [userId, sha256Hex(token), hours, createdBy]);
  return token;
}

/** Mindestens ein aktiver Plattform-Admin muss bleiben. */
async function assertAdminRemains(db: any, excludingUserId: string) {
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE status = 'active' AND 'platform_admin' = ANY(roles) AND id <> $1`, [excludingUserId], db);
  if (r!.n === 0) throw conflict('Es muss mindestens ein aktiver Plattform-Admin bleiben.');
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/roles', { preHandler: requireAuth('user.read') }, async () => ({
    roles: ROLES,
    modules: MODULES,
    permissions: PERMISSIONS,
    matrix: matrix(),
  }));

  app.get('/users', { preHandler: requireAuth('user.read') }, async () => {
    const users = await many<any>(
      `SELECT u.id, u.email, u.name, u.roles, u.status, u.totp_enabled, u.last_active_at, u.last_login_at, u.created_at,
              (SELECT max(expires_at) FROM invitations i WHERE i.user_id = u.id AND i.used_at IS NULL) AS invite_expires_at
         FROM users u ORDER BY u.status = 'disabled', lower(u.name)`,
    );
    const keys = await many<any>(`SELECT id, name, roles, last_used_at, created_at FROM api_keys WHERE revoked_at IS NULL ORDER BY name`);
    return { users, serviceAccounts: keys };
  });

  app.post('/users/invite', { preHandler: requireAuth('user.manage') }, async (req) => {
    const body = z.object({ email: z.email().max(200), name: z.string().trim().max(80).optional(), roles: z.array(z.enum(ROLE_IDS as [string, ...string[]])).min(1) }).parse(req.body);
    const existing = await one('SELECT id FROM users WHERE lower(email) = lower($1)', [body.email]);
    if (existing) throw conflict('Für diese E-Mail-Adresse gibt es schon ein Konto.');
    const user = await one<any>(
      `INSERT INTO users (email, name, roles, status, created_by) VALUES ($1,$2,$3,'invited',$4) RETURNING id, email, name`,
      [body.email.toLowerCase(), body.name || body.email.split('@')[0], body.roles, req.auth!.user?.id ?? null],
    );
    const token = await createInvite(user.id, req.auth!.user?.id ?? null, 72);
    await audit(req.auth!.actor, 'user.invited', { type: 'user', id: user.id, label: user.email }, { rollen: body.roles });
    return { user, link: inviteLink(req, token), expiresHours: 72 };
  });

  app.post('/users/:id/link', { preHandler: requireAuth('user.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const user = await one<any>('SELECT id, email, status FROM users WHERE id = $1', [id]);
    if (!user) throw notFound();
    if (user.status === 'disabled') throw badRequest('Das Konto ist deaktiviert.');
    const token = await createInvite(id, req.auth!.user?.id ?? null, user.status === 'invited' ? 72 : 24);
    await audit(req.auth!.actor, user.status === 'invited' ? 'user.invite_renewed' : 'user.password_reset_link', { type: 'user', id, label: user.email });
    return { link: inviteLink(req, token), expiresHours: user.status === 'invited' ? 72 : 24 };
  });

  app.patch('/users/:id', { preHandler: requireAuth('user.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        roles: z.array(z.enum(ROLE_IDS as [string, ...string[]])).min(1).optional(),
        status: z.enum(['active', 'disabled']).optional(),
      })
      .parse(req.body);
    const result = await tx(async (db) => {
      const user = await one<any>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id], db);
      if (!user) throw notFound();
      if (body.status === 'active' && user.status === 'invited') throw badRequest('Eingeladene Konten werden durch Annehmen der Einladung aktiv.');
      const losesAdmin = (body.roles && user.roles.includes('platform_admin') && !body.roles.includes('platform_admin')) || (body.status === 'disabled' && user.roles.includes('platform_admin'));
      if (losesAdmin) await assertAdminRemains(db, id);
      const updated = await one<any>(
        `UPDATE users SET name = COALESCE($2, name), roles = COALESCE($3, roles), status = COALESCE($4, status) WHERE id = $1 RETURNING id, email, name, roles, status`,
        [id, body.name ?? null, body.roles ?? null, body.status ?? null],
        db,
      );
      if (body.status === 'disabled' || body.roles) await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      return { before: user, updated };
    });
    if (body.roles) await audit(req.auth!.actor, 'user.roles_changed', { type: 'user', id, label: result.updated.email }, { vorher: result.before.roles, nachher: body.roles });
    if (body.status) await audit(req.auth!.actor, body.status === 'disabled' ? 'user.disabled' : 'user.enabled', { type: 'user', id, label: result.updated.email });
    if (body.name) await audit(req.auth!.actor, 'user.renamed', { type: 'user', id, label: result.updated.email });
    return result.updated;
  });

  app.post('/users/:id/reset-2fa', { preHandler: requireAuth('user.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const user = await one<any>(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, recovery_codes = '{}' WHERE id = $1 RETURNING email`, [id]);
    if (!user) throw notFound();
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(req.auth!.actor, 'user.mfa_reset', { type: 'user', id, label: user.email });
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: requireAuth('user.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (id === req.auth!.user?.id) throw badRequest('Das eigene Konto kann nicht gelöscht werden.');
    await tx(async (db) => {
      const user = await one<any>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id], db);
      if (!user) throw notFound();
      if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) throw badRequest('Zur Bestätigung die E-Mail-Adresse des Kontos eingeben.');
      if (user.roles.includes('platform_admin')) await assertAdminRemains(db, id);
      await db.query('DELETE FROM users WHERE id = $1', [id]);
      await audit(req.auth!.actor, 'user.deleted', { type: 'user', id, label: user.email }, {}, 'ok', db);
    });
    return { ok: true };
  });
}
