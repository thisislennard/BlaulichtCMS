import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth, requireAnyAuth } from '../auth/context.js';
import { ROLE_IDS } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { readSecretJson, revokeSecret, secretMeta, storeSecret } from '../lib/secrets.js';
import { catalog, connector } from '../nodes/registry.js';
import { wpRequest } from '../connectors/wordpress.js';
import { rotateWebhookSecret, webhookUrl } from '../engine/triggers.js';
import type { Connector, RuntimeConnection, TestStep } from '../engine/types.js';

function cleanConfig(c: Connector, input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(c.fields.map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) if (allowed.has(k)) out[k] = v;
  for (const f of c.fields) {
    if (out[f.key] === undefined && f.default !== undefined) out[f.key] = f.default;
    if (f.type === 'url' && out[f.key]) {
      try {
        const u = new URL(String(out[f.key]));
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      } catch {
        throw badRequest(`„${f.label}“ ist keine gültige http(s)-Adresse.`);
      }
    }
    if (f.required && (out[f.key] == null || out[f.key] === '')) throw badRequest(`„${f.label}“ fehlt.`);
  }
  return out;
}

function cleanSecrets(c: Connector, input: Record<string, unknown> | undefined): Record<string, string> {
  const allowed = new Set(c.secretFields.map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) if (allowed.has(k) && typeof v === 'string' && v !== '') out[k] = v.slice(0, 10_000);
  return out;
}

async function secretStatus(c: Connector, secretId: string | null) {
  const meta = await secretMeta(secretId);
  const values = secretId ? await readSecretJson(secretId) : {};
  return {
    version: meta?.version ?? null,
    savedAt: meta?.created_at ?? null,
    fields: Object.fromEntries(c.secretFields.map((f) => [f.key, { set: !!values[f.key] }])),
  };
}

async function runTest(c: Connector, conn: RuntimeConnection): Promise<{ ok: boolean; steps: TestStep[]; ms: number }> {
  const t0 = Date.now();
  if (!c.test) return { ok: true, steps: [{ label: 'Kein Test nötig', ok: true, ms: 0 }], ms: 0 };
  let steps: TestStep[];
  try {
    steps = await Promise.race([c.test(conn), new Promise<TestStep[]>((_, rej) => setTimeout(() => rej(new Error('Test hat zu lange gedauert (30 s).')), 30_000))]);
  } catch (e) {
    steps = [{ label: 'Verbindungstest', ok: false, ms: Date.now() - t0, message: (e as Error).message }];
  }
  return { ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0 };
}

const connectionBody = z.object({
  connector: z.string(),
  name: z.string().trim().min(1).max(100),
  config: z.record(z.string(), z.any()).default({}),
  secrets: z.record(z.string(), z.string()).optional(),
  credentialsExpireAt: z.string().nullable().optional(),
});

export async function connectionRoutes(app: FastifyInstance) {
  app.get('/catalog', { preHandler: requireAnyAuth() }, async () => catalog());

  app.get('/connections', { preHandler: requireAnyAuth('connection.read', 'workflow.edit', 'wordpress.read') }, async () => {
    const rows = await many<any>(
      `SELECT c.id, c.connector, c.name, c.config, c.status, c.status_message, c.last_test_at, c.last_test_ms, c.last_used_at, c.credentials_expire_at, c.created_at, c.updated_at,
              u.name AS owner_name,
              (SELECT count(DISTINCT w.id)::int FROM workflows w WHERE w.status <> 'archived' AND w.draft::text LIKE '%' || c.id::text || '%') AS workflow_count
         FROM connections c LEFT JOIN users u ON u.id = c.owner_id ORDER BY lower(c.name)`,
    );
    return rows;
  });

  app.get('/connections/:id', { preHandler: requireAuth('connection.read') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one<any>('SELECT * FROM connections WHERE id = $1', [id]);
    if (!row) throw notFound();
    const c = connector(row.connector);
    const versions = await many<any>(
      `SELECT s.id, s.version, s.fingerprint, s.created_at, s.revoked_at, u.name AS created_by_name FROM secrets s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.owner_type = 'connection' AND s.owner_id = $1 ORDER BY s.version DESC`,
      [id],
    );
    const workflows = await many<any>(`SELECT id, name, status FROM workflows WHERE status <> 'archived' AND draft::text LIKE '%' || $1 || '%' ORDER BY name`, [id]);
    const { secret_id, ...safe } = row;
    return { ...safe, secret: c ? await secretStatus(c, secret_id) : null, secretVersions: versions.map((v) => ({ ...v, current: v.id === secret_id })), workflows };
  });

  /** Verbindung testen, bevor sie gespeichert wird (Assistent Schritt 3). Geheimnisse einer bestehenden Verbindung werden ergänzt. */
  app.post('/connections/test', { preHandler: requireAuth('connection.edit') }, async (req) => {
    const body = connectionBody.extend({ id: z.uuid().optional() }).parse(req.body);
    const c = connector(body.connector);
    if (!c) throw badRequest('Unbekannte Integration.');
    let secrets = cleanSecrets(c, body.secrets);
    if (body.id) {
      const row = await one<any>('SELECT secret_id FROM connections WHERE id = $1', [body.id]);
      secrets = { ...(await readSecretJson(row?.secret_id)), ...secrets };
    }
    return runTest(c, { id: body.id ?? 'test', name: body.name, connector: c.id, config: cleanConfig(c, body.config), secrets });
  });

  app.post('/connections', { preHandler: requireAuth('connection.edit') }, async (req) => {
    const body = connectionBody.parse(req.body);
    const c = connector(body.connector);
    if (!c) throw badRequest('Unbekannte Integration.');
    const cfg = cleanConfig(c, body.config);
    const secrets = cleanSecrets(c, body.secrets);
    if (Object.keys(secrets).length && !req.auth!.permissions.has('credential.manage')) throw badRequest('Zum Hinterlegen von Zugangsdaten fehlt das Recht „Zugangsdaten verwalten“.');
    const row = await tx(async (db) => {
      const r = await one<any>(
        `INSERT INTO connections (connector, name, config, owner_id, credentials_expire_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, name`,
        [c.id, body.name, JSON.stringify(cfg), req.auth!.user?.id ?? null, body.credentialsExpireAt || null],
        db,
      );
      if (Object.keys(secrets).length) {
        const meta = await storeSecret('connection', r.id, secrets, req.auth!.user?.id ?? null, db);
        await db.query('UPDATE connections SET secret_id = $2 WHERE id = $1', [r.id, meta.id]);
      }
      return r;
    });
    await audit(req.auth!.actor, 'connection.created', { type: 'connection', id: row.id, label: row.name }, { integration: c.id, zugangsdaten: Object.keys(secrets) });
    // Direkt testen, damit der Status stimmt
    const test = await runTest(c, { id: row.id, name: row.name, connector: c.id, config: cfg, secrets });
    await pool.query(`UPDATE connections SET status = $2, status_message = $3, last_test_at = now(), last_test_ms = $4 WHERE id = $1`, [row.id, test.ok ? 'ok' : 'error', test.ok ? null : test.steps.find((s) => !s.ok)?.message ?? null, test.ms]);
    return { ...row, test };
  });

  app.patch('/connections/:id', { preHandler: requireAuth('connection.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), config: z.record(z.string(), z.any()).optional(), credentialsExpireAt: z.string().nullable().optional() }).parse(req.body);
    const row = await one<any>('SELECT * FROM connections WHERE id = $1', [id]);
    if (!row) throw notFound();
    const c = connector(row.connector)!;
    const cfg = body.config ? cleanConfig(c, { ...row.config, ...body.config }) : row.config;
    await pool.query(
      `UPDATE connections SET name = COALESCE($2, name), config = $3, credentials_expire_at = CASE WHEN $5 THEN $4::timestamptz ELSE credentials_expire_at END, status = CASE WHEN status = 'disabled' THEN status ELSE 'untested' END, updated_at = now() WHERE id = $1`,
      [id, body.name ?? null, JSON.stringify(cfg), body.credentialsExpireAt || null, body.credentialsExpireAt !== undefined],
    );
    await audit(req.auth!.actor, 'connection.updated', { type: 'connection', id, label: body.name ?? row.name }, { felder: Object.keys(body.config ?? {}) });
    return { ok: true };
  });

  /** Zugangsdaten ersetzen (neue Version). Nicht übergebene Felder bleiben erhalten. */
  app.put('/connections/:id/secrets', { preHandler: requireAuth('connection.edit', 'credential.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ values: z.record(z.string(), z.string()) }).parse(req.body);
    const row = await one<any>('SELECT * FROM connections WHERE id = $1', [id]);
    if (!row) throw notFound();
    const c = connector(row.connector)!;
    const changes = cleanSecrets(c, body.values);
    if (!Object.keys(changes).length) throw badRequest('Keine Zugangsdaten übergeben.');
    const merged = { ...(await readSecretJson(row.secret_id)), ...changes };
    const meta = await storeSecret('connection', id, merged, req.auth!.user?.id ?? null);
    await pool.query(`UPDATE connections SET secret_id = $2, status = CASE WHEN status = 'disabled' THEN status ELSE 'untested' END, updated_at = now() WHERE id = $1`, [id, meta.id]);
    await audit(req.auth!.actor, 'connection.credentials_replaced', { type: 'connection', id, label: row.name }, { felder: Object.keys(changes), version: meta.version });
    return { version: meta.version };
  });

  app.post('/connections/:id/secrets/:secretId/activate', { preHandler: requireAuth('connection.edit', 'credential.manage') }, async (req) => {
    const { id, secretId } = z.object({ id: z.uuid(), secretId: z.uuid() }).parse(req.params);
    const s = await one<any>(`SELECT * FROM secrets WHERE id = $1 AND owner_type = 'connection' AND owner_id = $2 AND revoked_at IS NULL`, [secretId, id]);
    if (!s) throw notFound('Version nicht gefunden oder widerrufen.');
    await pool.query(`UPDATE connections SET secret_id = $2, status = 'untested', updated_at = now() WHERE id = $1`, [id, secretId]);
    await audit(req.auth!.actor, 'connection.credentials_rollback', { type: 'connection', id }, { version: s.version });
    return { ok: true };
  });

  app.post('/connections/:id/secrets/:secretId/revoke', { preHandler: requireAuth('connection.edit', 'credential.manage') }, async (req) => {
    const { id, secretId } = z.object({ id: z.uuid(), secretId: z.uuid() }).parse(req.params);
    const row = await one<any>('SELECT secret_id, name FROM connections WHERE id = $1', [id]);
    if (!row) throw notFound();
    if (row.secret_id === secretId) throw badRequest('Die aktive Version kann nicht widerrufen werden – zuerst ersetzen.');
    await revokeSecret(secretId);
    await audit(req.auth!.actor, 'connection.credentials_revoked', { type: 'connection', id, label: row.name });
    return { ok: true };
  });

  app.post('/connections/:id/test', { preHandler: requireAuth('connection.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one<any>('SELECT * FROM connections WHERE id = $1', [id]);
    if (!row) throw notFound();
    const c = connector(row.connector)!;
    const test = await runTest(c, { id, name: row.name, connector: c.id, config: row.config, secrets: await readSecretJson(row.secret_id) });
    await pool.query(
      `UPDATE connections SET status = CASE WHEN status = 'disabled' THEN status WHEN $2 THEN 'ok' ELSE 'error' END, status_message = $3, last_test_at = now(), last_test_ms = $4 WHERE id = $1`,
      [id, test.ok, test.ok ? null : test.steps.find((s) => !s.ok)?.message ?? null, test.ms],
    );
    await audit(req.auth!.actor, 'connection.tested', { type: 'connection', id, label: row.name }, { ok: test.ok }, test.ok ? 'ok' : 'failed');
    return test;
  });

  app.post('/connections/:id/status', { preHandler: requireAuth('connection.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const row = await one<any>(`UPDATE connections SET status = CASE WHEN $2 THEN 'untested' ELSE 'disabled' END, updated_at = now() WHERE id = $1 RETURNING name`, [id, enabled]);
    if (!row) throw notFound();
    await audit(req.auth!.actor, enabled ? 'connection.enabled' : 'connection.disabled', { type: 'connection', id, label: row.name });
    return { ok: true };
  });

  app.delete('/connections/:id', { preHandler: requireAuth('connection.edit', 'credential.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    const row = await one<any>('SELECT * FROM connections WHERE id = $1', [id]);
    if (!row) throw notFound();
    if (confirm.trim() !== row.name.trim()) throw badRequest('Zur Bestätigung den Namen der Verbindung eingeben.');
    const used = await many<any>(`SELECT name FROM workflows WHERE status = 'active' AND draft::text LIKE '%' || $1 || '%'`, [id]);
    if (used.length) throw conflict(`Die Verbindung wird noch von aktiven Workflows genutzt: ${used.map((u) => u.name).join(', ')}.`);
    await tx(async (db) => {
      await db.query('UPDATE connections SET secret_id = NULL WHERE id = $1', [id]);
      await db.query(`DELETE FROM secrets WHERE owner_type = 'connection' AND owner_id = $1`, [id]);
      await db.query('DELETE FROM connections WHERE id = $1', [id]);
    });
    await audit(req.auth!.actor, 'connection.deleted', { type: 'connection', id, label: row.name });
    return { ok: true };
  });

  /** Zielseiten einer WordPress-Verbindung (für Banner-Formulare und Node-Konfiguration). */
  app.get('/connections/:id/wp-pages', { preHandler: requireAnyAuth('wordpress.read', 'workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one<any>(`SELECT * FROM connections WHERE id = $1 AND connector = 'wordpress'`, [id]);
    if (!row) throw notFound();
    try {
      const res = await wpRequest({ id, name: row.name, connector: 'wordpress', config: row.config, secrets: await readSecretJson(row.secret_id) }, 'GET', '/pages', undefined, 10_000);
      return { pages: res.pages ?? [], online: true };
    } catch (e) {
      return { pages: [{ id: 'all', label: 'Alle Seiten' }, { id: 'front', label: 'Startseite' }], online: false, error: (e as Error).message };
    }
  });

  /* ------------------------------------ Webhooks ------------------------------------ */

  app.get('/webhooks', { preHandler: requireAuth('connection.read') }, async () => {
    const rows = await many<any>(
      `SELECT e.id, e.workflow_id, w.name AS workflow_name, w.status AS workflow_status, e.node_id, e.token, e.auth_mode, e.status, e.created_at, e.last_received_at, e.received_count,
              e.previous_valid_until, s.created_at AS secret_created_at, s.fingerprint
         FROM webhook_endpoints e JOIN workflows w ON w.id = e.workflow_id LEFT JOIN secrets s ON s.id = e.secret_id ORDER BY w.name`,
    );
    return rows.map((r) => ({ ...r, url: `${config.publicUrl}${webhookUrl(r.token)}`, path: webhookUrl(r.token), token: undefined }));
  });

  app.post('/webhooks/:id/rotate', { preHandler: requireAuth('credential.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { graceHours } = z.object({ graceHours: z.number().int().min(0).max(168).default(24) }).parse(req.body ?? {});
    const res = await rotateWebhookSecret(id, req.auth!.user?.id ?? null, graceHours);
    if (!res) throw notFound();
    await audit(req.auth!.actor, 'webhook.secret_rotated', { type: 'webhook', id }, { uebergang_stunden: graceHours });
    return res;
  });

  app.post('/webhooks/:id/status', { preHandler: requireAuth('credential.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    await pool.query(`UPDATE webhook_endpoints SET status = $2, previous_secret_id = CASE WHEN $2 = 'revoked' THEN NULL ELSE previous_secret_id END WHERE id = $1`, [id, active ? 'active' : 'revoked']);
    await audit(req.auth!.actor, active ? 'webhook.reactivated' : 'webhook.revoked', { type: 'webhook', id });
    return { ok: true };
  });

  /* ---------------------------------- API-Schlüssel --------------------------------- */

  app.get('/api-keys', { preHandler: requireAuth('system.manage') }, async () =>
    many<any>(
      `SELECT k.id, k.name, k.prefix, k.roles, k.created_at, k.last_used_at, k.expires_at, k.revoked_at, u.name AS created_by_name
         FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
    ),
  );

  app.post('/api-keys', { preHandler: requireAuth('system.manage') }, async (req) => {
    const body = z
      .object({ name: z.string().trim().min(2).max(80), roles: z.array(z.enum(ROLE_IDS as [string, ...string[]])).min(1), expiresDays: z.number().int().min(1).max(730).nullable().default(365) })
      .parse(req.body);
    if (body.roles.includes('platform_admin')) throw badRequest('API-Schlüssel dürfen keine Plattform-Admin-Rolle haben.');
    const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
    const key = `ll_${prefix}_${randomToken(32)}`;
    const row = await one<any>(
      `INSERT INTO api_keys (name, prefix, key_hash, roles, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END) RETURNING id, name, prefix, expires_at`,
      [body.name, prefix, sha256Hex(key), body.roles, req.auth!.user?.id ?? null, body.expiresDays],
    );
    await audit(req.auth!.actor, 'api_key.created', { type: 'api_key', id: row.id, label: row.name }, { rollen: body.roles });
    return { ...row, key };
  });

  app.post('/api-keys/:id/revoke', { preHandler: requireAuth('system.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one<any>('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING name', [id]);
    if (!row) throw notFound();
    await audit(req.auth!.actor, 'api_key.revoked', { type: 'api_key', id, label: row.name });
    return { ok: true };
  });
}
