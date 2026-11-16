import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate, migrationFiles } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { getSettings, setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { PUBLIC_ROUTES } from '../src/auth/route-access.js';
import { invalidateRoles, reloadRoles } from '../src/auth/roles.js';
import { LEGACY_PERMISSIONS, PERMISSION_IDS, PERMISSIONS, finePermissionsFor, permissionsFor, withRequirements } from '../src/auth/permissions.js';

/**
 * Rollen und feine Rechte gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL): Übernahme des Stands 0.2.3,
 * Rollenpflege, Schutz vor Rechteausweitung, sofortige Wirkung, Vollständigkeit der Zugriffsangaben und 403-Matrix.
 * Die Datenbank wird zu Beginn komplett geleert (wie in integration.test.ts; die Dateien laufen nacheinander).
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
let ipCounter = 10;

class Client {
  cookie = '';
  ip = `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as any,
      remoteAddress: this.ip,
      url: `/api/v1${url}`,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
  del = (u: string, b: unknown = {}) => this.raw('DELETE', u, b);
  reauth = async () => expect((await this.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
}

let admin: Client;
let passwordHash: string;

async function mkUser(email: string, roles: string[]): Promise<{ client: Client; id: string }> {
  const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ($1,$2,$3,$4) RETURNING id`, [email, email.split('@')[0], passwordHash, roles]);
  const client = new Client(app);
  const r = await client.post('/auth/login', { email, password: PASSWORD });
  expect(r.json.next, email).toBe('done');
  return { client, id: u!.id };
}

const resetDb = async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateRoles();
};

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

/** Stand bis 0.2.3 – unabhängig vom Programm ausgeschrieben; „Automationen ansehen“ kommt mit 0.3.0 neu dazu. */
const OLD_ROLES: Record<string, string[]> = {
  media_manager: ['media.read', 'media.manage', 'post.read'],
  editor: ['media.read', 'media.manage', 'post.read', 'post.edit', 'automation.read'],
  approver: ['media.read', 'post.read', 'post.approve', 'audit.read', 'automation.read'],
  publisher: ['media.read', 'post.read', 'post.publish'],
  warning_author: ['warning.draft'],
  warning_approver: ['warning.draft', 'warning.level', 'warning.approve'],
  warning_sender: ['warning.send'],
  viewer: ['media.read', 'post.read'],
};

describe('Update von 0.2.3: Rollen und Rechte bleiben erhalten', () => {
  it('Konten jeder bisherigen Rolle haben nach der Migration dieselben Rechte', async () => {
    await resetDb();
    // Schema der Version 0.2.3: Migrationen bis einschließlich 049
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mig-023-'));
    for (const f of migrationFiles()) if (Number(f.slice(0, 3)) <= 49) fs.copyFileSync(path.join(config.migrationsDir, f), path.join(old, f));
    await migrate(() => {}, old);
    expect((await one<any>(`SELECT to_regclass('public.roles') AS t`))!.t).toBeNull();
    const combos: string[][] = [['platform_admin'], ...Object.keys(OLD_ROLES).map((r) => [r]), ['editor', 'publisher'], ['approver', 'warning_approver', 'warning_sender'], ['viewer', 'media_manager'], ['platform_admin', 'viewer']];
    for (const [i, roles] of combos.entries()) await pool.query(`INSERT INTO users (email, name, password_hash, roles) VALUES ($1,$2,$3,$4)`, [`alt${i}@example.org`, `Alt ${i}`, passwordHash, roles]);
    await pool.query(`INSERT INTO api_keys (name, prefix, key_hash, roles) VALUES ('Alt-Schlüssel', 'altpraefix', 'x', '{viewer}')`);
    await pool.query(`INSERT INTO notifications (kind, title, permission) VALUES ('info', 'Alte Meldung an die Veröffentlichung', 'post.publish')`);
    fs.rmSync(old, { recursive: true, force: true });

    // Update: alle weiteren Migrationen
    const applied = await migrate(() => {});
    expect(applied).toContain('075_roles.sql');
    await reloadRoles();
    const rows = await many<any>(`SELECT id, permissions, is_system FROM roles ORDER BY id`);
    expect(rows.map((r) => r.id).sort()).toEqual(['platform_admin', ...Object.keys(OLD_ROLES)].sort());
    expect(rows.every((r) => r.is_system && r.permissions === null)).toBe(true);

    const users = await many<any>(`SELECT email, roles FROM users ORDER BY email`);
    expect(users).toHaveLength(combos.length);
    for (const u of users) {
      const fine = [...finePermissionsFor(u.roles)].sort();
      if (u.roles.includes('platform_admin')) {
        expect(fine, u.email).toEqual([...PERMISSION_IDS].sort());
        continue;
      }
      const oldCoarse = [...new Set((u.roles as string[]).flatMap((r) => OLD_ROLES[r]))];
      expect(fine, u.email).toEqual([...new Set(oldCoarse.flatMap((c) => LEGACY_PERMISSIONS[c]))].sort());
      // Sammelbezeichnungen: genau die bisherigen groben Rechte
      const eff = permissionsFor(u.roles);
      expect(Object.keys(LEGACY_PERMISSIONS).filter((c) => eff.has(c)).sort(), u.email).toEqual(oldCoarse.sort());
    }
    // Rollen an Konten und API-Schlüsseln bleiben unverändert
    expect((await one<any>(`SELECT roles FROM api_keys WHERE prefix = 'altpraefix'`))!.roles).toEqual(['viewer']);
  });

  it('alte Benachrichtigungen mit groben Rechten bleiben für dieselben Personen sichtbar', async () => {
    app = await buildApp();
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
    const login = async (email: string) => {
      const c = new Client(app);
      expect((await c.post('/auth/login', { email, password: PASSWORD })).json.next).toBe('done');
      return c;
    };
    // alt4 = publisher, alt2 = editor (Reihenfolge der Kombinationen oben)
    const publisher = await login('alt4@example.org');
    const editor = await login('alt2@example.org');
    expect((await publisher.get('/notifications')).json.notifications.map((n: any) => n.title)).toContain('Alte Meldung an die Veröffentlichung');
    expect((await editor.get('/notifications')).json.notifications.map((n: any) => n.title)).not.toContain('Alte Meldung an die Veröffentlichung');
    // /auth/me liefert feine Rechte und die abgedeckten Sammelbezeichnungen
    const me = (await editor.get('/auth/me')).json;
    expect(me.permissions).toEqual(expect.arrayContaining(['post.edit', 'post.create', 'media.links', 'media.manage', 'post.read']));
    expect(me.permissions).not.toContain('publish.website');
    expect(me.roleLabels).toEqual(['Redaktion']);
    await app.close();
  });
});

describe('Rollen und feine Rechte', () => {
  beforeAll(async () => {
    await resetDb();
    await migrate(() => {});
    app = await buildApp();
    await pool.query(`INSERT INTO users (email, name, password_hash, roles) VALUES ('admin@example.org','Alex Admin',$1,'{platform_admin}')`, [passwordHash]);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
    admin = new Client(app);
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
  });

  /* ------------------------------------------------------------------ Zugriffsangaben */

  const fill = (url: string) => url.replace(/:(\w+)/g, (_m, name) => (['id', 'cid', 'aid'].includes(name) ? '00000000-0000-4000-8000-000000000000' : 'x'));
  const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

  it('jede Route unter /api/v1 hat eine Zugriffsangabe oder ist ausdrücklich öffentlich', () => {
    const table = app.routeAccess;
    expect(table.length).toBeGreaterThan(200);
    const known = new Set([...PERMISSION_IDS, ...Object.keys(LEGACY_PERMISSIONS)]);
    const missing = table.filter((r) => !r.access && !PUBLIC_ROUTES.includes(key(r))).map(key);
    expect(missing, 'Routen ohne requireAuth/requireAnyAuth und nicht in PUBLIC_ROUTES (auth/route-access.ts)').toEqual([]);
    // Öffentliche Liste enthält nichts Veraltetes und nichts, was zugleich ein Recht verlangt
    const all = new Set(table.map(key));
    expect(PUBLIC_ROUTES.filter((p) => !all.has(p)), 'veraltete Einträge in PUBLIC_ROUTES').toEqual([]);
    expect(table.filter((r) => r.access && PUBLIC_ROUTES.includes(key(r))).map(key)).toEqual([]);
    for (const r of table) {
      if (!r.access) continue;
      for (const p of r.access.permissions) expect(known.has(p), `${key(r)}: unbekanntes Recht ${p}`).toBe(true);
      // Regelfall: genau ein Recht je Route; „eines von“ nur bei Routen mit mehreren Aktionen (Prüfung im Handler)
      if (r.access.kind === 'all') expect(r.access.permissions, key(r)).toHaveLength(1);
    }
    // Routen dieses Stands verwenden ausschließlich feine Rechte
    const coarse = table.filter((r) => r.access?.permissions.some((p) => !PERMISSION_IDS.includes(p))).map(key);
    expect(coarse, 'Routen mit Sammelbezeichnung statt feinem Recht').toEqual([]);
    // Jedes Recht des Katalogs schützt mindestens eine Route oder wird im Handler geprüft
    const used = new Set(table.flatMap((r) => r.access?.permissions ?? []));
    const handlerOnly = ['media.download_original', 'post.archive', 'warning.delete_sent', 'dashboard.templates', 'warning.level', 'warning.approve', 'warning.rules', 'warning.send', 'warning.draft', 'automation.publish'];
    expect(PERMISSION_IDS.filter((p) => !used.has(p) && !handlerOnly.includes(p)), 'Rechte ohne Route').toEqual([]);
  });

  it('ohne Anmeldung: 401 auf jeder nicht öffentlichen Route', async () => {
    const anon = new Client(app);
    for (const r of app.routeAccess) {
      if (!r.access) continue;
      const res = await anon.raw(r.method, fill(r.url), r.method === 'GET' ? undefined : {});
      expect(res.status, key(r)).toBe(401);
    }
  });

  it('403-Matrix: eine Rolle ohne Rechte erreicht nur die Routen des eigenen Kontos', async () => {
    await admin.reauth();
    const role = await admin.post('/roles', { label: 'Nur Anmeldung', permissions: [] });
    expect(role.status).toBe(200);
    const { client } = await mkUser('nichts@example.org', [role.json.id]);
    expect((await client.get('/auth/me')).json.permissions).toEqual([]);
    let checked = 0;
    for (const r of app.routeAccess) {
      if (!r.access || r.access.kind === 'login') continue;
      const res = await client.raw(r.method, fill(r.url), r.method === 'GET' ? undefined : {});
      expect(res.status, key(r)).toBe(403);
      checked++;
    }
    expect(checked).toBeGreaterThan(180);
    // Routen des eigenen Kontos funktionieren
    expect((await client.get('/dashboard')).status).toBe(200);
    expect((await client.get('/notifications')).status).toBe(200);
    expect((await client.get('/search?q=test')).json.results).toEqual([]);
    expect((await client.get('/dashboard/layout')).json.widgets).toEqual([]);
  });

  it('genau das angegebene Recht zählt: alle Rechte außer diesem (und davon abhängigen) → 403', async () => {
    const role = await admin.post('/roles', { label: 'Fast alles', permissions: PERMISSION_IDS });
    expect(role.status).toBe(200);
    const { client } = await mkUser('fastalles@example.org', [role.json.id]);
    const byPerm = new Map<string, { method: string; url: string }[]>();
    for (const r of app.routeAccess) {
      if (r.access?.kind !== 'all') continue;
      byPerm.set(r.access.permissions[0], [...(byPerm.get(r.access.permissions[0]) ?? []), r]);
    }
    expect(byPerm.size).toBeGreaterThan(55);
    for (const [perm, routes] of byPerm) {
      // ohne dieses Recht und ohne alles, was es voraussetzt
      const rest = PERMISSION_IDS.filter((p) => !withRequirements([p]).includes(perm));
      await pool.query(`UPDATE roles SET permissions = $2 WHERE id = $1`, [role.json.id, rest]);
      await reloadRoles();
      for (const r of routes) {
        const res = await client.raw(r.method, fill(r.url), r.method === 'GET' ? undefined : {});
        expect(res.status, `${key(r)} ohne ${perm}`).toBe(403);
      }
    }
    await pool.query(`DELETE FROM users WHERE email = 'fastalles@example.org'`);
    await pool.query(`DELETE FROM roles WHERE id = $1`, [role.json.id]);
    await reloadRoles();
  });

  /* ------------------------------------------------------------------ Rollenpflege */

  let custom: string;

  it('Rollen anlegen, kopieren, umbenennen, Rechte ändern – mit Bestätigung, Audit und Meldung', async () => {
    const list = (await admin.get('/roles')).json;
    expect(list.roles.map((r: any) => r.id).slice(0, 9)).toEqual(['platform_admin', 'media_manager', 'editor', 'approver', 'publisher', 'warning_author', 'warning_approver', 'warning_sender', 'viewer']);
    expect(list.roles[0]).toMatchObject({ locked: true, system: true, editable: false, users: 1 });
    expect(list.roles[0].permissions).toEqual(PERMISSION_IDS);
    expect(list.permissions).toHaveLength(PERMISSIONS.length);
    expect(list.roles.find((r: any) => r.id === 'editor')).toMatchObject({ system: true, customized: false, editable: true, deletable: false, assignable: true });

    // Ohne frische Bestätigung keine Änderung
    await pool.query(`UPDATE sessions SET reauth_at = now() - interval '11 minutes'`);
    expect((await admin.post('/roles', { label: 'Pressefotos', permissions: ['media.redact'] })).json.error).toBe('reauth_required');
    await admin.reauth();
    expect((await admin.post('/roles', { label: 'Pressefotos', permissions: ['gibt.es.nicht'] })).status).toBe(400);
    expect((await admin.post('/roles', { label: 'P', permissions: [] })).status).toBe(400);
    const created = await admin.post('/roles', { label: 'Pressefotos', description: 'Sichtet und verpixelt.', permissions: ['media.redact', 'media.review'] });
    expect(created.status).toBe(200);
    custom = created.json.id;
    expect(custom).toMatch(/^r_pressefotos_[a-z0-9]{5}$/);
    // Voraussetzung „Medien ansehen“ kommt automatisch dazu
    expect(created.json.permissions).toEqual(['media.view', 'media.review', 'media.redact']);
    expect((await admin.post('/roles', { label: 'pressefotos', permissions: [] })).status).toBe(409);
    expect((await admin.post('/roles', { label: 'Redaktion', permissions: [] })).status).toBe(409);

    // Kopie einer mitgelieferten Rolle
    const editorRole = (await admin.get('/roles')).json.roles.find((r: any) => r.id === 'editor');
    const copy = await admin.post('/roles', { label: 'Kopie von Redaktion', permissions: editorRole.permissions, copyOf: 'editor' });
    expect(copy.json.permissions).toEqual(editorRole.permissions);

    // Umbenennen und Rechte ändern
    const upd = await admin.put(`/roles/${custom}`, { label: 'Bildredaktion', description: 'Neu', permissions: ['media.view', 'media.review', 'media.export', 'approval.post'] });
    expect(upd.status).toBe(200);
    expect(upd.json.added.sort()).toEqual(['approval.post', 'media.export', 'post.view']);
    expect(upd.json.removed).toEqual(['media.redact']);
    const after = (await admin.get('/roles')).json.roles.find((r: any) => r.id === custom);
    expect(after).toMatchObject({ label: 'Bildredaktion', description: 'Neu', system: false, deletable: true, users: 0 });
    expect(after.permissions).toEqual(['media.view', 'media.export', 'media.review', 'post.view', 'approval.post']);
    expect((await admin.put(`/roles/${custom}`, { label: 'Kopie von Redaktion' })).status).toBe(409);
    expect((await admin.put('/roles/gibt_es_nicht', { permissions: [] })).status).toBe(404);

    // Audit mit altem und neuem Stand
    const a = await one<any>(`SELECT details, actor_name FROM audit_events WHERE action = 'role.updated' AND object_id = $1 ORDER BY id DESC LIMIT 1`, [custom]);
    expect(a!.details.vorher).toEqual(['media.view', 'media.review', 'media.redact']);
    expect(a!.details.nachher).toEqual(after.permissions);
    expect(a!.details.neu.sort()).toEqual(['approval.post', 'media.export', 'post.view']);
    expect(a!.details).toMatchObject({ entfallen: ['media.redact'], name_vorher: 'Pressefotos', name_nachher: 'Bildredaktion' });
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'role.created' AND object_id = $1`, [copy.json.id]))!.details.kopie_von).toBe('editor');
    // Kritisches Recht vergeben: Sicherheitsmeldung an „Rollen verwalten“
    const n = await one<any>(`SELECT title, body, permission FROM notifications WHERE title LIKE 'Kritische Rechte der Rolle „Bildredaktion“%' ORDER BY id DESC LIMIT 1`);
    expect(n).toMatchObject({ permission: 'role.manage' });
    expect(n!.body).toContain('Beiträge freigeben');
    // Unkritische Änderung: keine Meldung
    const before = (await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'Kritische Rechte%'`))!.n;
    await admin.put(`/roles/${custom}`, { permissions: ['media.view', 'media.review', 'media.export', 'approval.post', 'media.organize'] });
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'Kritische Rechte%'`))!.n).toBe(before);
    await pool.query(`DELETE FROM roles WHERE id = $1`, [copy.json.id]);
    await reloadRoles();
  });

  it('Administration ist fest; mitgelieferte Rollen sind änderbar und lassen sich zurücksetzen, aber nicht löschen', async () => {
    await admin.reauth();
    expect((await admin.put('/roles/platform_admin', { permissions: [] })).status).toBe(409);
    expect((await admin.post('/roles/platform_admin/reset')).status).toBe(409);
    expect((await admin.del('/roles/platform_admin')).status).toBe(409);
    expect((await admin.del('/roles/viewer')).status).toBe(409);
    expect((await admin.put('/roles/viewer', { label: 'Gäste' })).status).toBe(400);

    const viewer = (await admin.get('/roles')).json.roles.find((r: any) => r.id === 'viewer');
    expect(viewer.defaultPermissions).toEqual(viewer.permissions);
    const narrowed = viewer.permissions.filter((p: string) => p !== 'media.export');
    expect((await admin.put('/roles/viewer', { permissions: narrowed })).json.removed).toEqual(['media.export']);
    let v = (await admin.get('/roles')).json.roles.find((r: any) => r.id === 'viewer');
    expect(v).toMatchObject({ customized: true, system: true, label: 'Lesezugriff' });
    expect(v.permissions).toEqual(narrowed);
    expect((await one<any>(`SELECT permissions FROM roles WHERE id = 'viewer'`))!.permissions).toEqual(narrowed);
    // Sammelbezeichnung „media.read“ gilt für die eingeschränkte Rolle nicht mehr
    expect(permissionsFor(['viewer']).has('media.read')).toBe(false);
    // Wieder genau die Vorgabe gespeichert: gilt als unverändert (NULL = folgt künftigen Vorgaben)
    await admin.put('/roles/viewer', { permissions: viewer.permissions });
    expect((await one<any>(`SELECT permissions FROM roles WHERE id = 'viewer'`))!.permissions).toBeNull();
    // Zurücksetzen
    await admin.put('/roles/viewer', { permissions: [...viewer.permissions, 'audit.view'] });
    const reset = await admin.post('/roles/viewer/reset');
    expect(reset.json.removed).toEqual(['audit.view']);
    v = (await admin.get('/roles')).json.roles.find((r: any) => r.id === 'viewer');
    expect(v.customized).toBe(false);
    expect(v.permissions).toEqual(viewer.permissions);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'role.reset' AND object_id = 'viewer'`))!.n).toBe(1);
    expect((await admin.post(`/roles/${custom}/reset`)).status).toBe(400);
  });

  it('Änderungen gelten sofort – ohne neue Anmeldung', async () => {
    const { client, id } = await mkUser('bild@example.org', [custom]);
    expect((await client.get('/collections')).status).toBe(200);
    expect((await client.get('/posts')).status).toBe(200);
    expect((await client.get('/banners')).status).toBe(403);
    expect((await client.post('/collections', { title: 'Neu' })).status).toBe(403);
    await admin.reauth();
    const current = (await admin.get('/roles')).json.roles.find((r: any) => r.id === custom).permissions;
    await admin.put(`/roles/${custom}`, { permissions: [...current, 'banner.view'] });
    expect((await client.get('/banners')).status).toBe(200);
    expect((await client.get('/auth/me')).json.permissions).toContain('banner.view');
    expect((await client.get('/auth/me')).json.roleLabels).toEqual(['Bildredaktion']);
    await admin.put(`/roles/${custom}`, { permissions: current.filter((p: string) => p !== 'post.view' && p !== 'approval.post') });
    expect((await client.get('/banners')).status).toBe(403);
    expect((await client.get('/posts')).status).toBe(403);
    expect((await client.get('/collections')).status).toBe(200);
    // Änderung durch einen anderen Prozess (nur Datenbank): spätestens nach der kurzen Frist wirksam
    await pool.query(`UPDATE roles SET permissions = '{post.view}' WHERE id = $1`, [custom]);
    invalidateRoles(); // entspricht der Meldung über NOTIFY bzw. dem Ablauf der Frist
    expect((await client.get('/posts')).status).toBe(200);
    expect((await client.get('/collections')).status).toBe(403);
    // Rolle am Konto ändern
    expect((await admin.patch(`/users/${id}`, { roles: ['gibt_es_nicht'] })).status).toBe(400);
    expect((await admin.patch(`/users/${id}`, { roles: ['viewer', custom] })).status).toBe(200);
    expect((await admin.get('/roles')).json.roles.find((r: any) => r.id === custom).users).toBe(1);
  });

  it('Rolle löschen: nur ohne Konten oder mit Ersatzrolle; Dashboard-Vorlage der Rolle entfällt', async () => {
    await admin.reauth();
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: custom, layout: { desktop: [{ id: 'media', size: 'l' }], mobile: ['media'] } })).status).toBe(200);
    expect((await admin.put('/dashboard/layout', { scope: 'role', role: 'gibt_es_nicht', layout: null })).status).toBe(400);
    expect(Object.keys((await getSettings(true))['dashboard.layouts'] as object)).toContain(custom);
    await pool.query(`UPDATE users SET roles = $1 WHERE email = 'bild@example.org'`, [[custom]]);
    const blocked = await admin.del(`/roles/${custom}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.details).toMatchObject({ users: 1 });
    expect((await admin.del(`/roles/${custom}`, { reassignTo: 'gibt_es_nicht' })).status).toBe(400);
    expect((await admin.del(`/roles/${custom}`, { reassignTo: custom })).status).toBe(400);
    const done = await admin.del(`/roles/${custom}`, { reassignTo: 'viewer' });
    expect(done.json).toMatchObject({ ok: true, reassigned: 1 });
    expect((await one<any>(`SELECT roles FROM users WHERE email = 'bild@example.org'`))!.roles).toEqual(['viewer']);
    expect((await admin.get('/roles')).json.roles.some((r: any) => r.id === custom)).toBe(false);
    expect(Object.keys((await getSettings(true))['dashboard.layouts'] as object)).not.toContain(custom);
    expect((await one<any>(`SELECT details FROM audit_events WHERE action = 'role.deleted' AND object_id = $1`, [custom]))!.details).toMatchObject({ konten: 1, ersatzrolle: 'viewer' });
    // Rolle ohne Konten: ohne Ersatzrolle
    const tmp = await admin.post('/roles', { label: 'Kurzlebig', permissions: ['post.view'] });
    expect((await admin.del(`/roles/${tmp.json.id}`)).json).toMatchObject({ ok: true, reassigned: 0 });
    expect((await admin.del(`/roles/${tmp.json.id}`)).status).toBe(404);
  });

  /* ------------------------------------------------------------------ Rechteausweitung */

  it('keine Rechteausweitung: vergeben, entziehen und ändern nur innerhalb der eigenen Rechte', async () => {
    await admin.reauth();
    const own = ['user.view', 'user.invite', 'user.edit', 'user.assign_roles', 'user.lock', 'user.sessions', 'user.delete', 'role.manage', 'post.view', 'post.create'];
    const hr = await admin.post('/roles', { label: 'Kontenpflege', permissions: own });
    expect(hr.status).toBe(200);
    const small = await admin.post('/roles', { label: 'Nur Beiträge lesen', permissions: ['post.view'] });
    const { client: pfleger, id: pflegerId } = await mkUser('pflege@example.org', [hr.json.id]);
    const { id: targetId } = await mkUser('ziel@example.org', ['viewer']);
    const adminId = (await one<any>(`SELECT id FROM users WHERE email = 'admin@example.org'`))!.id;
    await pfleger.reauth();

    const roles = (await pfleger.get('/roles')).json;
    expect(roles.grantable.sort()).toEqual([...own].sort());
    expect(roles.roles.find((r: any) => r.id === 'platform_admin')).toMatchObject({ assignable: false, editable: false });
    expect(roles.roles.find((r: any) => r.id === 'editor')).toMatchObject({ assignable: false, deletable: false });
    expect(roles.roles.find((r: any) => r.id === small.json.id)).toMatchObject({ assignable: true, deletable: true });

    // Rollen zuweisen: nur was man selbst vollständig hat
    expect((await pfleger.patch(`/users/${targetId}`, { roles: ['viewer', 'platform_admin'] })).status).toBe(403);
    expect((await pfleger.patch(`/users/${targetId}`, { roles: ['viewer', 'editor'] })).status).toBe(403);
    expect((await pfleger.patch(`/users/${pflegerId}`, { roles: [hr.json.id, 'platform_admin'] })).status).toBe(403);
    // „viewer“ entziehen geht nicht (Medienrechte hat die Kontenpflege nicht) – ergänzen schon
    expect((await pfleger.patch(`/users/${targetId}`, { roles: [small.json.id] })).status).toBe(403);
    expect((await pfleger.patch(`/users/${targetId}`, { roles: ['viewer', small.json.id] })).status).toBe(200);
    expect((await pfleger.post('/users/invite', { email: 'neu-admin@example.org', roles: ['platform_admin'] })).status).toBe(403);
    expect((await pfleger.post('/users/invite', { email: 'neu-leser@example.org', roles: [small.json.id] })).status).toBe(200);
    // Konten mit mehr Rechten: nicht übernehmen, sperren, löschen oder herabstufen
    expect((await pfleger.post(`/users/${adminId}/link`)).status).toBe(403);
    expect((await pfleger.post(`/users/${adminId}/reset-2fa`)).status).toBe(403);
    expect((await pfleger.patch(`/users/${adminId}`, { status: 'disabled' })).status).toBe(403);
    expect((await pfleger.patch(`/users/${adminId}`, { roles: ['viewer'] })).status).toBe(403);
    expect((await pfleger.raw('DELETE', `/users/${adminId}`, { confirm: 'admin@example.org' })).status).toBe(403);
    expect((await one<any>(`SELECT roles, status FROM users WHERE id = $1`, [adminId]))).toMatchObject({ roles: ['platform_admin'], status: 'active' });

    // Rollen pflegen: keine fremden Rechte vergeben oder entziehen
    expect((await pfleger.post('/roles', { label: 'Hintertür', permissions: ['settings.security'] })).status).toBe(403);
    expect((await pfleger.post('/roles', { label: 'Hintertür', permissions: PERMISSION_IDS })).status).toBe(403);
    expect((await pfleger.put(`/roles/${hr.json.id}`, { permissions: [...own, 'backup.download'] })).status).toBe(403);
    expect((await pfleger.put('/roles/viewer', { permissions: ['post.view'] })).status).toBe(403);
    expect((await pfleger.put('/roles/editor', { permissions: [] })).status).toBe(403);
    expect((await pfleger.post('/roles/editor/reset')).status).toBe(200); // nichts zu ändern
    expect((await pfleger.del('/roles/editor')).status).toBe(409);
    expect((await pfleger.put('/roles/platform_admin', { permissions: PERMISSION_IDS })).status).toBe(409);
    // Innerhalb der eigenen Rechte ist alles möglich
    const mine = await pfleger.post('/roles', { label: 'Autorinnen', permissions: ['post.create'] });
    expect(mine.json.permissions).toEqual(['post.view', 'post.create']);
    expect((await pfleger.put(`/roles/${mine.json.id}`, { permissions: ['post.view'] })).status).toBe(200);
    expect((await pfleger.put('/roles/viewer', { permissions: [...finePermissionsFor(['viewer']), 'post.create'] })).status).toBe(200);
    expect((await pfleger.post('/roles/viewer/reset')).status).toBe(200);
    expect((await pfleger.del(`/roles/${mine.json.id}`)).status).toBe(200);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied' AND actor_id = $1`, [pflegerId]))!.n).toBeGreaterThan(0);

    // Einzelrechte der Benutzerverwaltung greifen getrennt
    const only = await admin.post('/roles', { label: 'Nur umbenennen', permissions: ['user.edit'] });
    const { client: namer } = await mkUser('namen@example.org', [only.json.id]);
    expect((await namer.patch(`/users/${targetId}`, { name: 'Neuer Name' })).status).toBe(200);
    expect((await namer.patch(`/users/${targetId}`, { roles: [small.json.id] })).status).toBe(403);
    expect((await namer.patch(`/users/${targetId}`, { status: 'disabled' })).status).toBe(403);
    expect((await namer.post(`/users/${targetId}/end-sessions`)).status).toBe(403);
    expect((await namer.post('/roles', { label: 'X-Rolle', permissions: [] })).status).toBe(403);
  });

  it('Einstellungen: je Bereich ein eigenes Recht', async () => {
    await admin.reauth();
    const r = await admin.post('/roles', { label: 'Medieneinstellungen', permissions: ['settings.media'] });
    const { client } = await mkUser('einst@example.org', [r.json.id]);
    expect((await client.get('/settings')).status).toBe(200);
    expect((await client.patch('/settings', { 'media.link_default_days': 9 })).status).toBe(200);
    expect((await getSettings(true))['media.link_default_days']).toBe(9);
    expect((await client.patch('/settings', { 'general.organization': 'Fremd' })).status).toBe(403);
    expect((await client.patch('/settings', { 'media.link_default_days': 10, 'security.require_2fa_all': true })).status).toBe(403);
    expect((await getSettings(true))['media.link_default_days']).toBe(9);
    expect((await client.patch('/settings', { 'editorial.four_eyes': true })).status).toBe(403);
    expect((await client.post('/system/retention/run')).status).toBe(403);
    expect((await client.get('/backups')).status).toBe(403);
  });

  /* ------------------------------------------------------------------ Schutz vor dem Aussperren */

  it('mindestens ein aktives Konto mit der Rolle „Administration“ bleibt', async () => {
    await admin.reauth();
    const adminId = (await one<any>(`SELECT id FROM users WHERE email = 'admin@example.org'`))!.id;
    expect((await admin.patch(`/users/${adminId}`, { roles: ['viewer'] })).status).toBe(409);
    expect((await admin.patch(`/users/${adminId}`, { status: 'disabled' })).status).toBe(409);
    // Eine eigene Rolle mit allen Rechten ersetzt die Administration nicht
    const all = await admin.post('/roles', { label: 'Alles', permissions: PERMISSION_IDS });
    const { client: zweit, id: zweitId } = await mkUser('alles@example.org', [all.json.id]);
    await zweit.reauth();
    expect((await zweit.patch(`/users/${adminId}`, { roles: ['viewer'] })).status).toBe(409);
    expect((await zweit.raw('DELETE', `/users/${adminId}`, { confirm: 'admin@example.org' })).status).toBe(409);
    // Zweites Administrationskonto: dann darf das erste herabgestuft werden
    expect((await admin.patch(`/users/${zweitId}`, { roles: ['platform_admin'] })).status).toBe(200);
    expect((await admin.patch(`/users/${adminId}`, { roles: ['platform_admin', 'viewer'] })).status).toBe(200);
    expect((await one<any>(`SELECT count(*)::int AS n FROM users WHERE 'platform_admin' = ANY(roles) AND status = 'active'`))!.n).toBe(2);
    await pool.query(`UPDATE users SET roles = '{viewer}' WHERE id = $1`, [zweitId]);
  });

  it('Zwei-Faktor-Pflicht folgt den Rechten: neue Verwaltungsrechte melden Konten ohne zweiten Faktor ab', async () => {
    await admin.reauth();
    const r = await admin.post('/roles', { label: 'Sichtung', permissions: ['media.review'] });
    const { client, id } = await mkUser('sichtung@example.org', [r.json.id]);
    expect((await client.get('/collections')).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': true } as any);
    // Admin selbst hat keinen zweiten Faktor: eigene Sitzung bleibt bestehen
    const upd = await admin.put(`/roles/${r.json.id}`, { permissions: ['media.review', 'user.view', 'user.lock'] });
    expect(upd.json.signedOut).toBe(1);
    expect((await client.get('/collections')).status).toBe(401);
    expect((await admin.get('/roles')).status).toBe(200);
    const again = new Client(app);
    expect((await again.post('/auth/login', { email: 'sichtung@example.org', password: PASSWORD })).json.next).toBe('mfa_setup');
    // Originale herunterladen ↔ security.require_2fa_media
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': true } as any);
    await admin.put(`/roles/${r.json.id}`, { permissions: ['media.review'] });
    const c2 = new Client(app);
    expect((await c2.post('/auth/login', { email: 'sichtung@example.org', password: PASSWORD })).json.next).toBe('done');
    expect((await admin.put(`/roles/${r.json.id}`, { permissions: ['media.review', 'media.download_original'] })).json.signedOut).toBe(1);
    expect((await c2.get('/collections')).status).toBe(401);
    await setSettings({ 'security.require_2fa_media': false } as any);
    // Verwaltungsrechte an ein Konto vergeben: Meldung
    const before = (await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'Verwaltungsrechte vergeben%'`))!.n;
    await admin.put(`/roles/${r.json.id}`, { permissions: ['user.view', 'user.lock'] });
    const { id: neu } = await mkUser('neu@example.org', ['viewer']);
    expect((await admin.patch(`/users/${neu}`, { roles: ['viewer', r.json.id] })).status).toBe(200);
    expect((await one<any>(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'Verwaltungsrechte vergeben%'`))!.n).toBe(before + 1);
    expect(id).toBeTruthy();
  });

  it('Warnvorgänge, Beiträge und Medien: getrennte Rechte je Aktion', async () => {
    await admin.reauth();
    const r = await admin.post('/roles', { label: 'Archiv', permissions: ['post.archive', 'post.create', 'media.trash'] });
    const { client } = await mkUser('archiv@example.org', [r.json.id]);
    const post = await client.post('/posts', { title: 'Archivtest', kind: 'news' });
    expect(post.status, JSON.stringify(post.json)).toBe(200);
    const id = post.json.id;
    expect((await client.patch(`/posts/${id}`, { archived: true })).status).toBe(200);
    expect((await client.patch(`/posts/${id}`, { kind: 'news' })).status).toBe(403);
    expect((await client.put(`/posts/${id}/revision`, {})).status).toBe(403);
    expect((await client.post(`/posts/${id}/submit`)).status).toBe(403);
    // Sammelaktion: Löschen mit „Medien löschen“, Sichten nicht
    expect((await client.post('/media/bulk', { ids: ['00000000-0000-4000-8000-000000000000'], action: 'selection', selection: 'selected' })).status).toBe(403);
    expect((await client.post('/media/bulk', { ids: ['00000000-0000-4000-8000-000000000000'], action: 'delete' })).status).toBe(200);
  });
});
