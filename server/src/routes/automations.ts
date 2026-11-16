import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { assertRecentAuth, requireAnyAuth, requireAuth } from '../auth/context.js';
import { activeRoles } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { securityAlert } from '../lib/security-alerts.js';
import { getSettings } from '../lib/settings.js';
import { INPUT_KINDS, LIMITS, NODE_TYPES, OPERATORS, OUTPUT_KINDS, outputPorts, type InputKind, type OutputKind } from '../automations/catalog.js';
import { INPUT_CONFIG, OUTPUT_CONFIG } from '../automations/configs.js';
import { approvalConflict, buildSnapshot, cancelOpenRuns, createRun, decideApproval, examplePayload, executeRun, loadRefs, snapshotHash, type Snapshot } from '../automations/engine.js';
import { graphSchema, inputFields, outputNeeds, validateGraph, type Graph } from '../automations/graph.js';
import { redactForLog } from '../automations/logic.js';
import { buildExport, mappedGraph, parseTransferFile, suggestions, TRANSFER_MAX_AUTOMATIONS, TRANSFER_MAX_BYTES, TransferError, type TransferFile } from '../automations/transfer.js';
import { config } from '../config.js';

/**
 * Automationen: Eingänge und Ausgänge (wiederverwendbare Bausteine), Abläufe mit Entwurf, Test, Aktivierung und
 * Notbremse, Läufe und Freigaben. Rechte: automation.read / automation.manage / automation.publish (Direktversand).
 */

const uuidParam = z.object({ id: z.uuid() });
const draftHash = (g: Graph) => crypto.createHash('sha256').update(JSON.stringify(g)).digest('hex');
const directNodes = (g: Graph) => g.nodes.filter((n) => n.type === 'output' && n.data?.direct === true).map((n) => n.id).sort();

async function loadAutomation(id: string) {
  const a = await one<any>(`SELECT * FROM automations WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!a) throw notFound('Automation nicht gefunden.');
  return a;
}

/** Wo wird ein Eingang bzw. Ausgang verwendet (Entwurf oder aktive Version)? */
async function usage(key: 'inputId' | 'outputId', id: string) {
  const probe = JSON.stringify([{ data: { [key]: id } }]);
  return many<{ id: string; name: string }>(
    `SELECT a.id, a.name FROM automations a WHERE a.deleted_at IS NULL AND (a.graph->'nodes' @> $1::jsonb
        OR EXISTS (SELECT 1 FROM automation_versions v WHERE v.automation_id = a.id AND v.version = a.active_version AND v.graph->'nodes' @> $1::jsonb))
      ORDER BY a.name`,
    [probe],
  );
}

/** Bezüge eines Eingangs prüfen (Verbindung der passenden Art, Quelle, Sammlung). */
async function checkInputRefs(kind: InputKind, cfg: any) {
  const def = INPUT_KINDS[kind];
  if (def.source === 'connection') {
    const c = await one<any>(`SELECT kind, deleted_at FROM connections WHERE id = $1`, [cfg.connectionId]);
    if (!c || c.deleted_at || c.kind !== def.connectionKind) throw badRequest('Die gewählte Verbindung gibt es nicht (mehr) oder sie hat die falsche Art.');
  }
  if (kind === 'rss' && cfg.feedId && !(await one(`SELECT 1 FROM rss_feeds WHERE id = $1`, [cfg.feedId]))) throw badRequest('Die gewählte Quelle gibt es nicht.');
  if (kind === 'upload' && cfg.collectionId && !(await one(`SELECT 1 FROM collections WHERE id = $1 AND deleted_at IS NULL`, [cfg.collectionId]))) throw badRequest('Die gewählte Sammlung gibt es nicht.');
  if (kind === 'manual') {
    const keys = (cfg.fields as { key: string }[]).map((f) => f.key);
    const reserved = new Set(inputFields({ kind: 'manual', config: {} }).map((f) => f.key));
    if (new Set(keys).size !== keys.length) throw badRequest('Feldnamen müssen eindeutig sein.');
    const clash = keys.filter((k) => reserved.has(k));
    if (clash.length) throw badRequest(`Reservierte Feldnamen: ${clash.join(', ')}`);
  }
}

async function checkOutputRefs(kind: OutputKind, cfg: any) {
  if (kind === 'banner') {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM wp_sites WHERE id = ANY($1::uuid[]) AND status <> 'revoked'`, [cfg.siteIds]);
    if (n!.n !== new Set(cfg.siteIds).size) throw badRequest('Mindestens eine gewählte Website ist nicht verfügbar.');
  }
  if (kind === 'post' && cfg.siteId && !(await one(`SELECT 1 FROM wp_sites WHERE id = $1 AND status <> 'revoked'`, [cfg.siteId]))) throw badRequest('Der gewählte Zielkanal ist nicht verfügbar.');
  if ((kind === 'mail' || kind === 'warning_draft') && cfg.responsibilityIds?.length) {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM responsibilities WHERE id = ANY($1::uuid[])`, [cfg.responsibilityIds]);
    if (n!.n !== new Set(cfg.responsibilityIds).size) throw badRequest('Mindestens eine gewählte Zuständigkeit gibt es nicht.');
  }
  if (kind === 'notify' && cfg.userIds?.length) {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])`, [cfg.userIds]);
    if (n!.n !== new Set(cfg.userIds).size) throw badRequest('Mindestens eine gewählte Person gibt es nicht.');
  }
  if (kind === 'notify' && cfg.link && !/^(\/|\{\{)/.test(cfg.link)) throw badRequest('Link: nur Seiten innerhalb von BlaulichtCMS (beginnend mit /) oder ein Link-Feld wie {{beitrag_link}}.');
}

/** Zustand einer Automation für Liste und Editor. */
async function describe(a: any, refs: Awaited<ReturnType<typeof loadRefs>>) {
  const graph = a.graph as Graph;
  const snap = buildSnapshot(graph, refs);
  const current = snapshotHash(snap);
  const active = a.active_version ? await one<any>(`SELECT version, graph_hash, direct_publish, activated_at, activated_by, (SELECT name FROM users WHERE id = activated_by) AS activated_by_name FROM automation_versions WHERE automation_id = $1 AND version = $2`, [a.id, a.active_version]) : null;
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status as 'draft' | 'active' | 'disabled',
    active_version: a.active_version,
    active: active ? { version: active.version, activated_at: active.activated_at, activated_by_name: active.activated_by_name, direct_publish: active.direct_publish, current: active.graph_hash === current } : null,
    tested: a.tested_hash === current,
    tested_at: a.tested_at,
    direct_publish: a.direct_publish,
    direct_publish_at: a.direct_publish_at,
    direct_nodes: directNodes(graph).length,
    updated_at: a.updated_at,
    draft_hash: a.graph_hash,
    inputs: [...new Set(graph.nodes.filter((n) => n.type === 'input').map((n) => refs.inputs.get(n.data?.inputId)?.kind).filter(Boolean))],
  };
}

function cleanPayload(p: Record<string, unknown> | undefined, allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (allowed.has(k) && v != null && typeof v !== 'object') out[k] = String(v).slice(0, 2000);
  return out;
}

const actorUser = (req: FastifyRequest) => req.auth!.user?.id ?? null;

export async function automationRoutes(app: FastifyInstance) {
  const read = requireAuth('automation.read');
  const manage = requireAuth('automation.manage');

  /* ------------------------------------------------------------ Katalog */

  app.get('/automations/catalog', { preHandler: read }, async (req) => {
    const s = await getSettings();
    const canManage = req.auth!.permissions.has('automation.manage');
    return {
      enabled: s['automations.enabled'],
      maxRunsPerMinute: s['automations.max_runs_per_minute'],
      inputKinds: Object.entries(INPUT_KINDS).map(([kind, d]) => ({ kind, ...d, fields: inputFields({ kind: kind as InputKind, config: {} }) })),
      outputKinds: Object.entries(OUTPUT_KINDS).map(([kind, d]) => ({ kind, ...d })),
      nodeTypes: Object.entries(NODE_TYPES).map(([type, d]) => ({ type, ...d })),
      operators: OPERATORS,
      limits: LIMITS,
      roles: activeRoles().map((r) => ({ id: r.id, label: r.label })),
      connections: await many<any>(`SELECT id, kind, name, status FROM connections WHERE deleted_at IS NULL AND kind IN ('fe2','feuersoftware','warnfeed') ORDER BY name`),
      feeds: await many<any>(`SELECT id, title FROM rss_feeds ORDER BY title`),
      collections: await many<any>(`SELECT id, title FROM collections WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200`),
      // Kategorien der Website, wie die Bridge sie meldet (#186) – Auswahl im Beitrags-Ausgang
      sites: await many<any>(`SELECT id, name, status, COALESCE(bridge_report->'categories', '[]'::jsonb) AS categories FROM wp_sites WHERE status <> 'revoked' ORDER BY name`),
      responsibilities: await many<any>(`SELECT id, name, area FROM responsibilities WHERE active ORDER BY name`),
      warningFields: ((await one<any>(`SELECT fields FROM warning_templates WHERE status = 'active' ORDER BY created_at DESC, version DESC LIMIT 1`))?.fields ?? []).map((f: any) => ({ key: f.key, label: f.label, required: !!f.required })),
      users: canManage ? await many<any>(`SELECT id, name FROM users WHERE status = 'active' ORDER BY name`) : [],
    };
  });

  /* ------------------------------------------------------------ Eingänge */

  app.get('/automation-inputs', { preHandler: read }, async () => {
    const rows = await many<any>(`SELECT i.*, u.name AS updated_by_name FROM automation_inputs i LEFT JOIN users u ON u.id = i.updated_by WHERE i.archived_at IS NULL ORDER BY i.name`);
    return Promise.all(rows.map(async (r) => ({ id: r.id, name: r.name, kind: r.kind, config: r.config, updated_at: r.updated_at, updated_by_name: r.updated_by_name, fields: inputFields(r), used_by: await usage('inputId', r.id) })));
  });

  app.post('/automation-inputs', { preHandler: manage }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(Object.keys(INPUT_KINDS) as [InputKind, ...InputKind[]]), config: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const cfg = INPUT_CONFIG[b.kind].parse(b.config);
    await checkInputRefs(b.kind, cfg);
    const row = await one<any>(`INSERT INTO automation_inputs (name, kind, config, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *`, [b.name, b.kind, JSON.stringify(cfg), actorUser(req)]);
    await audit(req.auth!.actor, 'automation.input_created', { type: 'automation_input', id: row.id, label: b.name }, { art: b.kind });
    return row;
  });

  app.put('/automation-inputs/:id', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120), config: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const cur = await one<any>(`SELECT * FROM automation_inputs WHERE id = $1 AND archived_at IS NULL`, [id]);
    if (!cur) throw notFound('Eingang nicht gefunden.');
    const cfg = INPUT_CONFIG[cur.kind as InputKind].parse(b.config);
    await checkInputRefs(cur.kind, cfg);
    const row = await one<any>(`UPDATE automation_inputs SET name = $2, config = $3, updated_at = now(), updated_by = $4 WHERE id = $1 RETURNING *`, [id, b.name, JSON.stringify(cfg), actorUser(req)]);
    await audit(req.auth!.actor, 'automation.input_updated', { type: 'automation_input', id, label: b.name }, { art: cur.kind });
    return { ...row, used_by: await usage('inputId', id) };
  });

  app.delete('/automation-inputs/:id', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const cur = await one<any>(`SELECT * FROM automation_inputs WHERE id = $1 AND archived_at IS NULL`, [id]);
    if (!cur) throw notFound('Eingang nicht gefunden.');
    const used = await usage('inputId', id);
    if (used.length) throw conflict(`Der Eingang wird noch verwendet: ${used.map((u) => `„${u.name}“`).join(', ')}. Bitte zuerst aus den Abläufen entfernen.`, { used_by: used });
    await pool.query(`UPDATE automation_inputs SET archived_at = now(), updated_by = $2 WHERE id = $1`, [id, actorUser(req)]);
    await audit(req.auth!.actor, 'automation.input_deleted', { type: 'automation_input', id, label: cur.name });
    return { ok: true };
  });

  /* ------------------------------------------------------------ Ausgänge */

  app.get('/automation-outputs', { preHandler: read }, async () => {
    const rows = await many<any>(`SELECT o.*, u.name AS updated_by_name FROM automation_outputs o LEFT JOIN users u ON u.id = o.updated_by WHERE o.archived_at IS NULL ORDER BY o.name`);
    return Promise.all(rows.map(async (r) => ({ id: r.id, name: r.name, kind: r.kind, config: r.config, updated_at: r.updated_at, updated_by_name: r.updated_by_name, needs: outputNeeds(r), used_by: await usage('outputId', r.id) })));
  });

  app.post('/automation-outputs', { preHandler: manage }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(Object.keys(OUTPUT_KINDS) as [OutputKind, ...OutputKind[]]), config: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const cfg = OUTPUT_CONFIG[b.kind].parse(b.config);
    await checkOutputRefs(b.kind, cfg);
    const row = await one<any>(`INSERT INTO automation_outputs (name, kind, config, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *`, [b.name, b.kind, JSON.stringify(cfg), actorUser(req)]);
    await audit(req.auth!.actor, 'automation.output_created', { type: 'automation_output', id: row.id, label: b.name }, { art: b.kind });
    return row;
  });

  app.put('/automation-outputs/:id', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120), config: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const cur = await one<any>(`SELECT * FROM automation_outputs WHERE id = $1 AND archived_at IS NULL`, [id]);
    if (!cur) throw notFound('Ausgang nicht gefunden.');
    const cfg = OUTPUT_CONFIG[cur.kind as OutputKind].parse(b.config);
    await checkOutputRefs(cur.kind, cfg);
    const row = await one<any>(`UPDATE automation_outputs SET name = $2, config = $3, updated_at = now(), updated_by = $4 WHERE id = $1 RETURNING *`, [id, b.name, JSON.stringify(cfg), actorUser(req)]);
    await audit(req.auth!.actor, 'automation.output_updated', { type: 'automation_output', id, label: b.name }, { art: cur.kind });
    return { ...row, used_by: await usage('outputId', id) };
  });

  app.delete('/automation-outputs/:id', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const cur = await one<any>(`SELECT * FROM automation_outputs WHERE id = $1 AND archived_at IS NULL`, [id]);
    if (!cur) throw notFound('Ausgang nicht gefunden.');
    const used = await usage('outputId', id);
    if (used.length) throw conflict(`Der Ausgang wird noch verwendet: ${used.map((u) => `„${u.name}“`).join(', ')}. Bitte zuerst aus den Abläufen entfernen.`, { used_by: used });
    await pool.query(`UPDATE automation_outputs SET archived_at = now(), updated_by = $2 WHERE id = $1`, [id, actorUser(req)]);
    await audit(req.auth!.actor, 'automation.output_deleted', { type: 'automation_output', id, label: cur.name });
    return { ok: true };
  });

  /* ------------------------------------------------------------ Automationen */

  app.get('/automations', { preHandler: read }, async () => {
    const refs = await loadRefs();
    const rows = await many<any>(
      `SELECT a.*, lr.status AS last_status, lr.created_at AS last_at,
              (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.mode = 'live' AND r.created_at > now() - interval '24 hours') AS runs_24h,
              (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.mode = 'live' AND r.status = 'failed' AND r.created_at > now() - interval '24 hours') AS failed_24h,
              (SELECT count(*)::int FROM automation_approvals ap WHERE ap.automation_id = a.id AND ap.status = 'pending') AS pending_approvals
         FROM automations a
         LEFT JOIN LATERAL (SELECT status, created_at FROM automation_runs r WHERE r.automation_id = a.id AND r.mode = 'live' ORDER BY created_at DESC LIMIT 1) lr ON true
        WHERE a.deleted_at IS NULL ORDER BY a.name`,
    );
    return Promise.all(rows.map(async (a) => ({ ...(await describe(a, refs)), last_run: a.last_status ? { status: a.last_status, at: a.last_at } : null, runs_24h: a.runs_24h, failed_24h: a.failed_24h, pending_approvals: a.pending_approvals })));
  });

  app.post('/automations', { preHandler: manage }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default('') }).parse(req.body);
    const graph: Graph = { nodes: [], edges: [] };
    const row = await one<any>(`INSERT INTO automations (name, description, graph, graph_hash, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`, [b.name, b.description, JSON.stringify(graph), draftHash(graph), actorUser(req)]);
    await audit(req.auth!.actor, 'automation.created', { type: 'automation', id: row.id, label: b.name });
    return { id: row.id };
  });

  /* ------------------------------------------------------------ Export und Import (#196) */

  /** Ausgewählte (ids, kommagetrennt) oder alle Automationen als JSON-Datei – ohne Kennungen und Zugangsdaten. */
  app.get('/automations/export', { preHandler: read, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = z.object({ ids: z.string().max(40 * TRANSFER_MAX_AUTOMATIONS).optional() }).parse(req.query);
    const ids = (q.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (ids.some((x) => !z.uuid().safeParse(x).success)) throw badRequest('Ungültige Auswahl.');
    const rows = await many<any>(`SELECT id, name, description, graph FROM automations WHERE deleted_at IS NULL ${ids.length ? 'AND id = ANY($1::uuid[])' : ''} ORDER BY name`, ids.length ? [ids] : []);
    if (!rows.length) throw notFound('Keine Automation zum Exportieren gefunden.');
    if (rows.length > TRANSFER_MAX_AUTOMATIONS) throw badRequest(`Höchstens ${TRANSFER_MAX_AUTOMATIONS} Automationen auf einmal exportieren – bitte eine Auswahl treffen.`);
    const file = buildExport(rows, await loadRefs(), config.version);
    await audit(req.auth!.actor, 'automation.exported', { type: 'automation', id: rows.length === 1 ? rows[0].id : undefined, label: rows.length === 1 ? rows[0].name : `${rows.length} Automationen` }, { anzahl: rows.length });
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="automationen-${stamp}.json"`);
    return file;
  });

  const importBody = z.object({
    file: z.unknown(),
    mapping: z
      .object({ inputs: z.record(z.string().max(10), z.uuid().nullable()).default({}), outputs: z.record(z.string().max(10), z.uuid().nullable()).default({}) })
      .default({ inputs: {}, outputs: {} }),
  });
  const importOpts = { preHandler: manage, bodyLimit: TRANSFER_MAX_BYTES + 64 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  /** Datei prüfen; Fehler verständlich als 400 invalid_file mit Liste. */
  const readFile = (raw: unknown): TransferFile => {
    if (raw !== undefined && JSON.stringify(raw).length > TRANSFER_MAX_BYTES) throw new AppError(413, 'too_large', `Die Datei ist zu groß (höchstens ${TRANSFER_MAX_BYTES / 1024 / 1024} MB).`);
    try {
      return parseTransferFile(raw);
    } catch (e) {
      if (e instanceof TransferError) throw new AppError(400, 'invalid_file', e.message, { problems: e.details });
      throw e;
    }
  };

  /** Freier Name: bei Gleichstand „(Import)“, „(Import 2)“ … anhängen. */
  const uniqueName = (name: string, taken: Set<string>) => {
    let n = name;
    for (let i = 1; taken.has(n.toLocaleLowerCase('de')); i++) {
      const suffix = i === 1 ? ' (Import)' : ` (Import ${i})`;
      n = name.slice(0, 120 - suffix.length) + suffix;
    }
    taken.add(n.toLocaleLowerCase('de'));
    return n;
  };
  const takenNames = async () => new Set((await many<{ name: string }>(`SELECT name FROM automations WHERE deleted_at IS NULL`)).map((r) => r.name.toLocaleLowerCase('de')));

  /** Vorschau: was angelegt würde und welche Ein-/Ausgänge zuzuordnen sind (mit Vorschlag bei gleichem Namen). */
  app.post('/automations/import/preview', importOpts, async (req) => {
    const b = importBody.parse(req.body);
    const file = readFile(b.file);
    const refs = await loadRefs();
    const taken = await takenNames();
    return {
      schemaVersion: file.schemaVersion,
      appVersion: file.appVersion ?? null,
      exportedAt: file.exportedAt ?? null,
      automations: file.automations.map((a) => ({
        name: a.name,
        finalName: uniqueName(a.name, taken),
        description: a.description,
        nodes: a.graph.nodes.length,
        edges: a.graph.edges.length,
        steps: Object.entries(a.graph.nodes.reduce<Record<string, number>>((acc, n) => ((acc[n.type] = (acc[n.type] ?? 0) + 1), acc), {})).map(([type, count]) => ({ type, label: NODE_TYPES[type as keyof typeof NODE_TYPES].label, count })),
      })),
      inputs: file.references.inputs.map((r) => ({ ...r, kindLabel: INPUT_KINDS[r.kind].label, ...suggestions(r, refs.inputs.values()) })),
      outputs: file.references.outputs.map((r) => ({ ...r, kindLabel: OUTPUT_KINDS[r.kind].label, ...suggestions(r, refs.outputs.values()) })),
    };
  });

  /** Import: legt die Automationen als Entwürfe an (nicht aktiv, nicht getestet, ohne Direktversand). */
  app.post('/automations/import', importOpts, async (req) => {
    const b = importBody.parse(req.body);
    const file = readFile(b.file);
    const refs = await loadRefs();
    // Zuordnungen prüfen: nur vorhandene, nicht gelöschte Ein-/Ausgänge derselben Art
    for (const r of file.references.inputs) {
      const id = b.mapping.inputs[r.ref];
      const t = id ? refs.inputs.get(id) : null;
      if (id && (!t || t.archived || t.kind !== r.kind)) throw badRequest(`Die Zuordnung für den Eingang „${r.name}“ passt nicht (gelöscht oder andere Art).`);
    }
    for (const r of file.references.outputs) {
      const id = b.mapping.outputs[r.ref];
      const t = id ? refs.outputs.get(id) : null;
      if (id && (!t || t.archived || t.kind !== r.kind)) throw badRequest(`Die Zuordnung für den Ausgang „${r.name}“ passt nicht (gelöscht oder andere Art).`);
    }
    const created = await tx(async (db) => {
      const taken = await takenNames();
      const out: { id: string; name: string; open: number }[] = [];
      for (const a of file.automations) {
        const { graph, open } = mappedGraph(a, file, b.mapping, refs);
        const name = uniqueName(a.name, taken);
        const row = await one<{ id: string }>(
          `INSERT INTO automations (name, description, status, graph, graph_hash, created_by, updated_by) VALUES ($1,$2,'draft',$3,$4,$5,$5) RETURNING id`,
          [name, a.description, JSON.stringify(graph), draftHash(graph), actorUser(req)],
          db,
        );
        await audit(req.auth!.actor, 'automation.imported', { type: 'automation', id: row!.id, label: name }, { knoten: graph.nodes.length, offene_bezuege: open || undefined, version_der_datei: file.appVersion }, 'ok', db);
        out.push({ id: row!.id, name, open });
      }
      return out;
    });
    return { created };
  });

  app.get('/automations/:id', { preHandler: read }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const a = await loadAutomation(id);
    const refs = await loadRefs();
    const graph = a.graph as Graph;
    const versions = await many<any>(`SELECT v.version, v.activated_at, v.direct_publish, u.name AS activated_by_name FROM automation_versions v LEFT JOIN users u ON u.id = v.activated_by WHERE v.automation_id = $1 ORDER BY v.version DESC LIMIT 20`, [id]);
    return { ...(await describe(a, refs)), graph, validation: validateGraph(graph, refs), versions };
  });

  /** Entwurf prüfen, ohne zu speichern (Editor zeigt Fehler direkt an den Knoten). */
  app.post('/automations/:id/validate', { preHandler: read }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    await loadAutomation(id);
    const graph = graphSchema.parse((req.body as any)?.graph);
    return validateGraph(graph, await loadRefs());
  });

  app.put('/automations/:id', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default(''), graph: graphSchema, baseHash: z.string().length(64) }).parse(req.body);
    const res = await tx(async (db) => {
      const a = await one<any>(`SELECT * FROM automations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], db);
      if (!a) throw notFound('Automation nicht gefunden.');
      if (a.graph_hash !== b.baseHash) throw conflict('Die Automation wurde inzwischen von jemand anderem geändert. Bitte neu laden.');
      // Ausgänge als „direkt veröffentlichen“ markieren oder die Markierung ändern: nur mit automation.publish
      const before = directNodes(a.graph);
      const after = directNodes(b.graph);
      if (JSON.stringify(before) !== JSON.stringify(after) && !req.auth!.permissions.has('automation.publish')) throw forbidden('Nur mit dem Recht „Automationen direkt veröffentlichen lassen“ dürfen Ausgänge für den Direktversand markiert werden.');
      const hash = draftHash(b.graph);
      await db.query(`UPDATE automations SET name = $2, description = $3, graph = $4, graph_hash = $5, updated_at = now(), updated_by = $6 WHERE id = $1`, [id, b.name, b.description, JSON.stringify(b.graph), hash, actorUser(req)]);
      if (a.graph_hash !== hash || a.name !== b.name) await audit(req.auth!.actor, 'automation.updated', { type: 'automation', id, label: b.name }, { knoten: b.graph.nodes.length, verbindungen: b.graph.edges.length, direkt_markiert: after.length, direkt_geaendert: JSON.stringify(before) !== JSON.stringify(after) || undefined }, 'ok', db);
      return hash;
    });
    const a = await loadAutomation(id);
    const refs = await loadRefs();
    return { ...(await describe(a, refs)), draft_hash: res, validation: validateGraph(a.graph, refs) };
  });

  app.delete('/automations/:id', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const a = await loadAutomation(id);
    await tx(async (db) => {
      await db.query(`UPDATE automations SET deleted_at = now(), status = 'disabled', updated_by = $2 WHERE id = $1`, [id, actorUser(req)]);
      await cancelOpenRuns(id, 'Die Automation wurde gelöscht.', db);
      await audit(req.auth!.actor, 'automation.deleted', { type: 'automation', id, label: a.name }, {}, 'ok', db);
    });
    return { ok: true };
  });

  /** Testlauf des Entwurfs mit Beispieldaten: läuft sofort, legt nichts an und sendet nichts. */
  app.post('/automations/:id/test', { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const b = z.object({ inputNodeId: z.string().max(40).optional(), payload: z.record(z.string(), z.any()).optional() }).parse(req.body ?? {});
    const a = await loadAutomation(id);
    const refs = await loadRefs();
    const graph = a.graph as Graph;
    const v = validateGraph(graph, refs);
    if (!v.ok) throw new AppError(400, 'invalid_graph', 'Der Ablauf hat noch Fehler und kann nicht getestet werden.', { errors: v.errors });
    const node = graph.nodes.find((n) => n.type === 'input' && (!b.inputNodeId || n.id === b.inputNodeId));
    if (!node) throw badRequest('Eingang für den Test nicht gefunden.');
    const input = refs.inputs.get(node.data.inputId)!;
    const allowed = new Set(inputFields(input).map((f) => f.key));
    const payload = { ...examplePayload(input), ...cleanPayload(b.payload, allowed), ...(input.kind === 'manual' ? { gestartet_von: req.auth!.actor.name } : {}) };
    const snap = buildSnapshot(graph, refs);
    const runId = await createRun({ automationId: id, version: null, mode: 'test', trigger: 'test', inputNode: node.id, snapshot: snap, payload, createdBy: actorUser(req) });
    const status = await executeRun(runId!);
    await audit(req.auth!.actor, 'automation.tested', { type: 'automation', id, label: a.name }, { lauf: runId!.slice(0, 8), ergebnis: status }, status === 'succeeded' ? 'ok' : 'failed');
    return runDetail(runId!);
  });

  /** Aktivieren: nur der getestete Entwurf; Direktversand nur mit Recht, frischer Bestätigung und erlaubter Automation. */
  app.post('/automations/:id/activate', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const a = await loadAutomation(id);
    const refs = await loadRefs();
    const graph = a.graph as Graph;
    const v = validateGraph(graph, refs);
    if (!v.ok) throw new AppError(400, 'invalid_graph', 'Der Ablauf hat noch Fehler.', { errors: v.errors });
    const snap = buildSnapshot(graph, refs);
    const hash = snapshotHash(snap);
    if (a.tested_hash !== hash) throw new AppError(409, 'not_tested', 'Bitte diesen Stand zuerst erfolgreich testen. Jede Änderung am Ablauf oder an einem verwendeten Ein- oder Ausgang verlangt einen neuen Test.');
    const direct = v.directNodes.length > 0;
    if (direct) {
      if (!req.auth!.permissions.has('automation.publish')) throw forbidden('Ausgänge mit Direktversand: Aktivieren nur mit dem Recht „Automationen direkt veröffentlichen lassen“.');
      assertRecentAuth(req);
      if (!a.direct_publish) throw new AppError(409, 'direct_not_allowed', 'Für diese Automation ist „Darf direkt veröffentlichen/versenden“ nicht eingeschaltet.');
    }
    const testRun = await one<{ id: string }>(`SELECT id FROM automation_runs WHERE automation_id = $1 AND mode = 'test' AND status = 'succeeded' AND graph_hash = $2 ORDER BY created_at DESC LIMIT 1`, [id, hash]);
    const version = await tx(async (db) => {
      const n = (await one<{ n: number }>(`SELECT COALESCE(max(version), 0) + 1 AS n FROM automation_versions WHERE automation_id = $1`, [id], db))!.n;
      await db.query(`INSERT INTO automation_versions (automation_id, version, graph, graph_hash, direct_publish, test_run_id, activated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, n, JSON.stringify(snap), hash, direct, testRun?.id ?? null, actorUser(req)]);
      await db.query(`UPDATE automations SET status = 'active', active_version = $2, updated_at = now() WHERE id = $1`, [id, n]);
      await audit(req.auth!.actor, 'automation.activated', { type: 'automation', id, label: a.name }, { version: n, direktversand: direct ? v.directNodes.length : 0, test: testRun?.id.slice(0, 8) ?? null }, 'ok', db);
      return n;
    });
    if (direct) {
      await securityAlert('automation_direct_publish', {
        title: `Automation mit Direktversand aktiviert: „${a.name}“`,
        body: `${req.auth!.actor.name} hat Version ${version} aktiviert. ${v.directNodes.length} Ausgang/Ausgänge veröffentlichen bzw. versenden ohne menschliche Freigabe. Abschalten: Automationen → „${a.name}“ → Deaktivieren.`,
        link: `/automationen/${id}`,
      });
    }
    return { ok: true, version };
  });

  /** Notbremse: sofort deaktivieren, offene Läufe und Freigaben abbrechen. */
  app.post('/automations/:id/disable', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const a = await loadAutomation(id);
    const canceled = await tx(async (db) => {
      await db.query(`UPDATE automations SET status = 'disabled', updated_at = now() WHERE id = $1`, [id]);
      const n = await cancelOpenRuns(id, 'Die Automation wurde deaktiviert.', db);
      await audit(req.auth!.actor, 'automation.disabled', { type: 'automation', id, label: a.name }, { abgebrochen: n }, 'ok', db);
      return n;
    });
    return { ok: true, canceled };
  });

  /** „Darf direkt veröffentlichen/versenden“: Einschalten mit automation.publish, frischer Bestätigung und erfolgreichem Test. */
  app.post('/automations/:id/direct-publish', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const a = await loadAutomation(id);
    if (enabled) {
      if (!req.auth!.permissions.has('automation.publish')) throw forbidden('Dafür ist das Recht „Automationen direkt veröffentlichen lassen“ nötig.');
      assertRecentAuth(req);
      const refs = await loadRefs();
      if (a.tested_hash !== snapshotHash(buildSnapshot(a.graph, refs))) throw new AppError(409, 'not_tested', 'Bitte den aktuellen Stand zuerst erfolgreich testen.');
    }
    if (a.direct_publish === enabled) return { ok: true, direct_publish: enabled };
    await tx(async (db) => {
      await db.query(`UPDATE automations SET direct_publish = $2, direct_publish_by = $3, direct_publish_at = now() WHERE id = $1`, [id, enabled, actorUser(req)]);
      await audit(req.auth!.actor, enabled ? 'automation.direct_enabled' : 'automation.direct_disabled', { type: 'automation', id, label: a.name }, {}, 'ok', db);
    });
    await securityAlert('automation_direct_publish', {
      kind: enabled ? 'warning' : 'info',
      title: enabled ? `Direktversand erlaubt: Automation „${a.name}“` : `Direktversand entzogen: Automation „${a.name}“`,
      body: enabled
        ? `${req.auth!.actor.name} hat erlaubt, dass markierte Ausgänge dieser Automation ohne menschliche Freigabe veröffentlichen bzw. versenden. Wirksam erst mit einer aktivierten Version, die solche Ausgänge enthält.`
        : `${req.auth!.actor.name} hat den Direktversand abgeschaltet. Markierte Ausgänge legen ab sofort wieder nur Entwürfe an bzw. fordern eine Freigabe an.`,
      link: `/automationen/${id}`,
    });
    return { ok: true, direct_publish: enabled };
  });

  /** Manueller Start einer aktiven Automation (Eingang „Manueller Start“). */
  app.post('/automations/:id/run', { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const b = z.object({ inputNodeId: z.string().max(40), payload: z.record(z.string(), z.any()).default({}) }).parse(req.body);
    const a = await loadAutomation(id);
    if (a.status !== 'active' || !a.active_version) throw conflict('Die Automation ist nicht aktiv.');
    if (!(await getSettings())['automations.enabled']) throw conflict('Automationen sind unter Einstellungen abgeschaltet.');
    const v = await one<any>(`SELECT * FROM automation_versions WHERE automation_id = $1 AND version = $2`, [id, a.active_version]);
    const snap = v.graph as Snapshot;
    const node = snap.nodes.find((n) => n.id === b.inputNodeId && n.type === 'input');
    const input = node ? snap.refs.inputs[node.data.inputId] : null;
    if (!node || input?.kind !== 'manual') throw badRequest('Dieser Eingang lässt sich nicht von Hand starten.');
    const allowed = new Set(((input.config.fields ?? []) as { key: string }[]).map((f) => f.key));
    const payload = { ...cleanPayload(b.payload, allowed), gestartet_von: req.auth!.actor.name };
    const runId = await createRun({ automationId: id, version: v.version, mode: 'live', trigger: 'manual', inputNode: node.id, snapshot: snap, directAllowed: !!v.direct_publish && !!a.direct_publish, payload, createdBy: actorUser(req) });
    if (!runId) throw new AppError(429, 'limited', 'Zu viele Läufe in der letzten Minute.');
    await audit(req.auth!.actor, 'automation.started', { type: 'automation', id, label: a.name }, { lauf: runId.slice(0, 8) });
    return { runId };
  });

  /* ------------------------------------------------------------ Läufe */

  app.get('/automations/:id/runs', { preHandler: read }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return many<any>(
      `SELECT r.id, r.version, r.mode, r.trigger, r.status, r.error, r.created_at, r.started_at, r.finished_at, r.resume_at, u.name AS created_by_name,
              (SELECT count(*)::int FROM automation_steps s WHERE s.run_id = r.id) AS steps
         FROM automation_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.automation_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [id, q.limit],
    );
  });

  async function runDetail(runId: string) {
    const r = await one<any>(`SELECT r.*, a.name AS automation_name, u.name AS created_by_name FROM automation_runs r JOIN automations a ON a.id = r.automation_id LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`, [runId]);
    if (!r) throw notFound('Lauf nicht gefunden.');
    const steps = await many<any>(`SELECT node_id, node_type, status, ports, input, output, info, error, attempts, started_at, finished_at, duration_ms FROM automation_steps WHERE run_id = $1 ORDER BY id`, [runId]);
    const snap = r.graph as Snapshot;
    const label = (nid: string) => {
      const n = snap.nodes?.find((x) => x.id === nid);
      if (!n) return nid;
      if (n.data?.label) return n.data.label;
      if (n.type === 'input') return snap.refs.inputs[n.data.inputId]?.name ?? 'Eingang';
      if (n.type === 'output') return snap.refs.outputs[n.data.outputId]?.name ?? 'Ausgang';
      return NODE_TYPES[n.type as keyof typeof NODE_TYPES]?.label ?? n.type;
    };
    return {
      id: r.id,
      automation_id: r.automation_id,
      automation_name: r.automation_name,
      version: r.version,
      mode: r.mode,
      trigger: r.trigger,
      status: r.status,
      error: r.error,
      created_at: r.created_at,
      started_at: r.started_at,
      finished_at: r.finished_at,
      resume_at: r.resume_at,
      created_by_name: r.created_by_name,
      payload: redactForLog(Object.fromEntries(Object.entries(r.payload ?? {}).filter(([k]) => !k.startsWith('_')))),
      steps: steps.map((s) => ({ ...s, label: label(s.node_id), port_labels: (() => {
        const n = snap.nodes?.find((x) => x.id === s.node_id);
        return n ? outputPorts(n).filter((p) => (s.ports ?? []).includes(p.id)).map((p) => p.label) : [];
      })() })),
    };
  }

  app.get('/automation-runs/:id', { preHandler: read }, async (req) => runDetail(uuidParam.parse(req.params).id));

  app.post('/automation-runs/:id/cancel', { preHandler: manage }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const r = await one<any>(`UPDATE automation_runs SET status = 'canceled', error = 'Von Hand abgebrochen.', finished_at = now(), resume_at = NULL WHERE id = $1 AND status IN ('queued','waiting') RETURNING automation_id`, [id]);
    if (!r) throw conflict('Der Lauf ist bereits abgeschlossen oder läuft gerade.');
    await pool.query(`UPDATE automation_approvals SET status = 'canceled' WHERE run_id = $1 AND status = 'pending'`, [id]);
    await audit(req.auth!.actor, 'automation.run_canceled', { type: 'automation', id: r.automation_id }, { lauf: id.slice(0, 8) });
    return { ok: true };
  });

  /* ------------------------------------------------------------ Freigaben aus Abläufen */

  app.get('/automation-approvals', { preHandler: requireAnyAuth('approval.automation', 'automation.manage') }, async (req) => {
    const uid = req.auth!.user?.id ?? null;
    const four = (await getSettings())['editorial.four_eyes'];
    const rows = await many<any>(
      `SELECT ap.id, ap.kind, ap.title, ap.summary, ap.status, ap.created_at, ap.expires_at, ap.run_id, a.id AS automation_id, a.name AS automation_name, a.updated_by, v.activated_by
         FROM automation_approvals ap JOIN automations a ON a.id = ap.automation_id JOIN automation_runs r ON r.id = ap.run_id
         LEFT JOIN automation_versions v ON v.automation_id = a.id AND v.version = r.version
        WHERE ap.status = 'pending' ORDER BY ap.created_at`,
    );
    return rows.map(({ updated_by, activated_by, ...r }) => ({
      ...r,
      can_decide: req.auth!.permissions.has('approval.automation') && !(four && uid && [updated_by, activated_by].includes(uid)),
    }));
  });

  app.post('/automation-approvals/:id/decision', { preHandler: requireAuth('approval.automation') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).default('') }).parse(req.body);
    if (b.decision === 'rejected' && !b.note) throw badRequest('Bitte kurz begründen, warum abgelehnt wird.');
    const uid = req.auth!.user?.id ?? null;
    if ((await getSettings())['editorial.four_eyes'] && uid && (await approvalConflict(id, uid))) {
      throw forbidden('Vier-Augen-Prinzip: Wer die Automation zuletzt geändert oder aktiviert hat, kann ihre Freigaben nicht selbst erteilen.');
    }
    try {
      await decideApproval(id, b.decision, b.note, req.auth!.actor, uid);
    } catch (e) {
      if ((e as Error).message === 'not_pending') throw conflict('Diese Freigabe ist nicht mehr offen.');
      throw e;
    }
    return { ok: true };
  });
}
