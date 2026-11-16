import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../db/pool.js';
import { assertRecentAuth, mustUse2fa, requireAuth } from '../auth/context.js';
import {
  ADMIN_ROLE,
  MODULES,
  PERMISSIONS,
  PERMISSION_IDS,
  SYSTEM_ROLES,
  activeRole,
  activeRoles,
  finePermissionsFor,
  isAdminPermission,
  isCriticalPermission,
  permissionDef,
  withRequirements,
} from '../auth/permissions.js';
import { reloadRoles } from '../auth/roles.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { securityAlert } from '../lib/security-alerts.js';
import { getSettings, setSettings } from '../lib/settings.js';

/**
 * Rollen und ihre Rechte (Verwaltung → Benutzer und Rollen → Rollen).
 *
 * Schutz vor Rechteausweitung: Wer Rollen verwaltet, kann nur Rechte vergeben oder entziehen, die er selbst hat;
 * die Rolle „Administration“ ist fest. Jede Änderung verlangt eine frische Passwortbestätigung (Step-up), wird mit
 * altem und neuem Stand auditiert und bei kritischen Rechten zusätzlich gemeldet.
 */

const labels = (ids: string[]) => ids.map((id) => permissionDef(id)?.label ?? id);

/** Rechte, die die handelnde Person selbst hat (feine Rechte, ohne Sammelbezeichnungen). */
export const ownPermissions = (req: FastifyRequest) => finePermissionsFor(req.auth!.roles);

/** Alle Rechte dieser Rollen liegen innerhalb der eigenen Rechte? */
export function rolesWithinOwn(req: FastifyRequest, roles: string[]): boolean {
  const mine = ownPermissions(req);
  for (const p of finePermissionsFor(roles)) if (!mine.has(p)) return false;
  return true;
}

function assertWithinOwn(req: FastifyRequest, ids: string[], what: string) {
  const mine = ownPermissions(req);
  const missing = ids.filter((p) => !mine.has(p));
  if (missing.length) throw forbidden(`${what}: Diese Rechte hast du selbst nicht – ${labels(missing).slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}.`);
}

function cleanPermissions(input: string[]): string[] {
  const unknown = input.filter((p) => !PERMISSION_IDS.includes(p));
  if (unknown.length) throw badRequest(`Unbekanntes Recht: ${unknown.slice(0, 5).join(', ')}.`);
  // Voraussetzungen (z. B. Ansehen vor Ändern) gehören immer dazu
  return withRequirements(input);
}

const diff = (before: string[], after: string[]) => ({ added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) });

async function userCounts(): Promise<Map<string, number>> {
  const rows = await many<{ role: string; n: number }>(`SELECT r AS role, count(*)::int AS n FROM users u, unnest(u.roles) r GROUP BY r`);
  return new Map(rows.map((r) => [r.role, r.n]));
}

function newRoleId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `r_${slug || 'rolle'}_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 5)}`;
}

/**
 * Nach einer Rechteänderung: Wer jetzt unter die Zwei-Faktor-Pflicht fällt und noch keinen zweiten Faktor hat, wird
 * abgemeldet und richtet ihn bei der nächsten Anmeldung ein. Die eigene Sitzung bleibt.
 */
async function enforceTwoFactor(req: FastifyRequest, roleId: string): Promise<number> {
  const s = await getSettings();
  const users = await many<{ id: string; roles: string[] }>(`SELECT id, roles FROM users WHERE $1 = ANY(roles) AND NOT totp_enabled AND status = 'active'`, [roleId]);
  const ids = users.filter((u) => mustUse2fa(u.roles, s)).map((u) => u.id);
  if (!ids.length) return 0;
  const r = await one<{ n: number }>(
    `WITH x AS (UPDATE sessions SET revoked_at = now() WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2) RETURNING user_id)
     SELECT count(DISTINCT user_id)::int AS n FROM x`,
    [ids, req.auth!.sessionId ?? null],
  );
  return r?.n ?? 0;
}

async function alertIfCritical(req: FastifyRequest, role: { id: string; label: string }, d: { added: string[]; removed: string[] }, users: number) {
  const added = d.added.filter((p) => isCriticalPermission(p) || isAdminPermission(p));
  const removed = d.removed.filter((p) => isCriticalPermission(p) || isAdminPermission(p));
  if (!added.length && !removed.length) return;
  const lines = [
    `Geändert von ${req.auth!.actor.name}; betrifft ${users} Konto/Konten.`,
    added.length ? `Neu: ${labels(added).join(', ')}.` : '',
    removed.length ? `Entzogen: ${labels(removed).join(', ')}.` : '',
  ].filter(Boolean);
  await securityAlert('role_changed', {
    title: `Kritische Rechte der Rolle „${role.label}“ geändert`,
    body: lines.join('\n').slice(0, 900),
    link: '/benutzer?tab=rollen',
    permission: 'role.manage',
    kind: added.length ? 'warning' : 'info',
  });
}

export async function roleRoutes(app: FastifyInstance) {
  /** Rollen, Bereiche und Rechte-Katalog – Grundlage für Benutzerverwaltung und Rollen-Editor. */
  app.get('/roles', { preHandler: requireAuth('user.view') }, async (req) => {
    const counts = await userCounts();
    const mine = ownPermissions(req);
    const manage = req.auth!.permissions.has('role.manage');
    return {
      roles: activeRoles().map((r) => {
        const within = r.permissions.every((p) => mine.has(p));
        const def = SYSTEM_ROLES.find((s) => s.id === r.id);
        return {
          id: r.id,
          label: r.label,
          description: r.description,
          permissions: r.permissions,
          system: r.system,
          customized: r.customized,
          /** „Administration“: immer alle Rechte, nicht änderbar */
          locked: r.id === ADMIN_ROLE,
          users: counts.get(r.id) ?? 0,
          defaultPermissions: def && r.id !== ADMIN_ROLE ? def.permissions : null,
          /** Darf die anfragende Person diese Rolle Konten zuweisen (alle Rechte der Rolle selbst vorhanden)? */
          assignable: within,
          editable: manage && r.id !== ADMIN_ROLE,
          deletable: manage && !r.system && within,
        };
      }),
      modules: MODULES,
      permissions: PERMISSIONS,
      /** Rechte, die die anfragende Person vergeben darf */
      grantable: [...mine],
    };
  });

  app.post('/roles', { preHandler: requireAuth('role.manage') }, async (req) => {
    const body = z
      .object({
        label: z.string().trim().min(2).max(60),
        description: z.string().trim().max(300).default(''),
        permissions: z.array(z.string().max(60)).max(500),
        copyOf: z.string().max(40).optional(),
      })
      .parse(req.body);
    assertRecentAuth(req);
    const permissions = cleanPermissions(body.permissions);
    assertWithinOwn(req, permissions, 'Rolle anlegen');
    if (activeRoles().some((r) => r.label.toLowerCase() === body.label.toLowerCase()) || (await one('SELECT 1 FROM roles WHERE lower(btrim(label)) = lower($1)', [body.label]))) {
      throw conflict('Eine Rolle mit diesem Namen gibt es schon.');
    }
    const id = newRoleId(body.label);
    await tx(async (db) => {
      await db.query(`INSERT INTO roles (id, label, description, permissions, is_system, created_by, updated_by) VALUES ($1,$2,$3,$4,false,$5,$5)`, [id, body.label, body.description, permissions, req.auth!.user?.id ?? null]);
      await audit(req.auth!.actor, 'role.created', { type: 'role', id, label: body.label }, { rechte: permissions, ...(body.copyOf ? { kopie_von: body.copyOf } : {}) }, 'ok', db);
    });
    await reloadRoles();
    await alertIfCritical(req, { id, label: body.label }, { added: permissions, removed: [] }, 0);
    return { id, label: body.label, description: body.description, permissions };
  });

  app.put('/roles/:id', { preHandler: requireAuth('role.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const body = z
      .object({ label: z.string().trim().min(2).max(60).optional(), description: z.string().trim().max(300).optional(), permissions: z.array(z.string().max(60)).max(500).optional() })
      .parse(req.body);
    if (id === ADMIN_ROLE) throw conflict('Die Rolle „Administration“ hat immer alle Rechte und lässt sich nicht ändern.');
    assertRecentAuth(req);
    const current = activeRole(id);
    if (!current) throw notFound('Rolle nicht gefunden.');
    if (current.system && ((body.label !== undefined && body.label !== current.label) || (body.description !== undefined && body.description !== current.description))) {
      throw badRequest('Name und Beschreibung mitgelieferter Rollen sind fest. Für eine eigene Bezeichnung die Rolle kopieren.');
    }
    const permissions = body.permissions ? cleanPermissions(body.permissions) : null;
    const result = await tx(async (db) => {
      const row = await one<any>('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id], db);
      if (!row) throw notFound('Rolle nicht gefunden.');
      const before = current.permissions;
      const after = permissions ?? before;
      const d = diff(before, after);
      // Weder vergeben noch entziehen, was man selbst nicht hat
      assertWithinOwn(req, [...d.added, ...d.removed], 'Rechte ändern');
      if (!row.is_system && body.label && body.label.toLowerCase() !== String(row.label).toLowerCase()) {
        if (await one('SELECT 1 FROM roles WHERE lower(btrim(label)) = lower($1) AND id <> $2', [body.label, id], db)) throw conflict('Eine Rolle mit diesem Namen gibt es schon.');
      }
      const def = SYSTEM_ROLES.find((s) => s.id === id);
      // Mitgelieferte Rolle wieder auf Vorgabe: NULL speichern, damit künftige Rechte der Vorgabe ankommen
      const isDefault = !!def && row.is_system && def.permissions.length === after.length && def.permissions.every((p) => after.includes(p));
      await db.query(
        `UPDATE roles SET label = CASE WHEN is_system THEN label ELSE COALESCE($2, label) END, description = CASE WHEN is_system THEN description ELSE COALESCE($3, description) END,
                permissions = CASE WHEN $6 THEN permissions WHEN $5 THEN NULL ELSE $4::text[] END, updated_at = now(), updated_by = $7 WHERE id = $1`,
        [id, body.label ?? null, body.description ?? null, after, isDefault, permissions === null, req.auth!.user?.id ?? null],
      );
      const label = row.is_system ? current.label : (body.label ?? row.label);
      const renamed = !row.is_system && ((body.label && body.label !== row.label) || (body.description !== undefined && body.description !== row.description));
      if (d.added.length || d.removed.length || renamed) {
        await audit(
          req.auth!.actor,
          'role.updated',
          { type: 'role', id, label },
          { ...(renamed ? { name_vorher: row.label, name_nachher: label } : {}), ...(d.added.length || d.removed.length ? { vorher: before, nachher: after, neu: d.added, entfallen: d.removed } : {}) },
          'ok',
          db,
        );
      }
      return { label, d, after };
    });
    await reloadRoles();
    const counts = await userCounts();
    const signedOut = result.d.added.length ? await enforceTwoFactor(req, id) : 0;
    await alertIfCritical(req, { id, label: result.label }, result.d, counts.get(id) ?? 0);
    return { id, label: result.label, permissions: result.after, added: result.d.added, removed: result.d.removed, users: counts.get(id) ?? 0, signedOut };
  });

  /** Mitgelieferte Rolle auf die Vorgabe des Programms zurücksetzen. */
  app.post('/roles/:id/reset', { preHandler: requireAuth('role.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    if (id === ADMIN_ROLE) throw conflict('Die Rolle „Administration“ hat immer alle Rechte und lässt sich nicht ändern.');
    assertRecentAuth(req);
    const current = activeRole(id);
    const def = SYSTEM_ROLES.find((s) => s.id === id);
    if (!current) throw notFound('Rolle nicht gefunden.');
    if (!def || !current.system) throw badRequest('Nur mitgelieferte Rollen lassen sich auf den Standard zurücksetzen.');
    const d = diff(current.permissions, def.permissions);
    assertWithinOwn(req, [...d.added, ...d.removed], 'Auf Standard zurücksetzen');
    await tx(async (db) => {
      await db.query(
        `INSERT INTO roles (id, label, description, permissions, is_system, updated_by) VALUES ($1,$2,$3,NULL,true,$4)
         ON CONFLICT (id) DO UPDATE SET permissions = NULL, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [id, def.label, def.description, req.auth!.user?.id ?? null],
      );
      if (d.added.length || d.removed.length) await audit(req.auth!.actor, 'role.reset', { type: 'role', id, label: def.label }, { vorher: current.permissions, nachher: def.permissions, neu: d.added, entfallen: d.removed }, 'ok', db);
    });
    await reloadRoles();
    const counts = await userCounts();
    const signedOut = d.added.length ? await enforceTwoFactor(req, id) : 0;
    await alertIfCritical(req, { id, label: def.label }, d, counts.get(id) ?? 0);
    return { id, permissions: def.permissions, added: d.added, removed: d.removed, signedOut };
  });

  /**
   * Eigene Rolle löschen. Haben noch Konten oder API-Schlüssel die Rolle, muss eine Ersatzrolle genannt werden
   * (`reassignTo`) – niemand bleibt ohne Rolle zurück. Gemeinsame Dashboards der Rolle werden mit entfernt.
   */
  app.delete('/roles/:id', { preHandler: requireAuth('role.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const body = z.object({ reassignTo: z.string().max(40).optional() }).parse(req.body ?? {});
    assertRecentAuth(req);
    const current = activeRole(id);
    if (!current) throw notFound('Rolle nicht gefunden.');
    if (current.system) throw conflict('Mitgelieferte Rollen lassen sich nicht löschen.');
    assertWithinOwn(req, current.permissions, 'Rolle löschen');
    const target = body.reassignTo ? activeRole(body.reassignTo) : null;
    if (body.reassignTo && (!target || target.id === id)) throw badRequest('Die Ersatzrolle gibt es nicht.');
    if (target) assertWithinOwn(req, target.permissions, 'Ersatzrolle zuweisen');
    const moved = await tx(async (db) => {
      const row = await one<any>('SELECT id, label FROM roles WHERE id = $1 AND NOT is_system FOR UPDATE', [id], db);
      if (!row) throw notFound('Rolle nicht gefunden.');
      const users = await many<{ id: string; email: string }>('SELECT id, email FROM users WHERE $1 = ANY(roles) FOR UPDATE', [id], db);
      const keys = await many<{ id: string }>('SELECT id FROM api_keys WHERE $1 = ANY(roles) AND revoked_at IS NULL', [id], db);
      if ((users.length || keys.length) && !target) {
        throw conflict(`Die Rolle ist noch ${users.length} Konto/Konten${keys.length ? ` und ${keys.length} API-Schlüssel(n)` : ''} zugewiesen. Bitte eine Ersatzrolle wählen.`, { users: users.length, apiKeys: keys.length });
      }
      const swap = `ARRAY(SELECT DISTINCT x FROM unnest(array_replace(roles, $1::text, $2::text)) x WHERE x IS NOT NULL)`;
      if (users.length) await db.query(`UPDATE users SET roles = ${swap} WHERE $1 = ANY(roles)`, [id, target!.id]);
      // Auch widerrufene Schlüssel bereinigen; ohne Ersatzrolle entfällt die Kennung
      await db.query(`UPDATE api_keys SET roles = ${swap} WHERE $1 = ANY(roles)`, [id, target?.id ?? null]);
      await db.query('DELETE FROM roles WHERE id = $1', [id]);
      await audit(req.auth!.actor, 'role.deleted', { type: 'role', id, label: row.label }, { rechte: current.permissions, konten: users.length, ...(target ? { ersatzrolle: target.id } : {}) }, 'ok', db);
      return users.length;
    });
    // Gemeinsames Dashboard dieser Rolle entfernen
    const s = await getSettings(true);
    const layouts = { ...((s['dashboard.layouts'] ?? {}) as Record<string, unknown>) };
    if (id in layouts) {
      delete layouts[id];
      await setSettings({ 'dashboard.layouts': layouts } as any, req.auth!.user?.id ?? null);
    }
    await reloadRoles();
    const signedOut = target && moved ? await enforceTwoFactor(req, target.id) : 0;
    await alertIfCritical(req, { id, label: current.label }, { added: [], removed: current.permissions }, moved);
    return { ok: true, reassigned: moved, signedOut };
  });
}
