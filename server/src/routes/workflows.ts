import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { diffGraphs, publishPreview, triggerNode, validateGraph, emptyGraph } from '../engine/graph.js';
import { createRun, testSingleNode } from '../engine/executor.js';
import { activateBinding, deactivateBinding, ensureWebhookEndpoint, validateSchedule, webhookUrl, nextScheduleRun } from '../engine/triggers.js';
import { nodeType } from '../nodes/registry.js';
import { TEMPLATES } from '../nodes/templates.js';
import type { Graph } from '../engine/types.js';

const nodeSchema = z.object({
  id: z.string().min(1).max(60),
  type: z.string().min(1).max(60),
  key: z.string().max(41),
  name: z.string().max(80),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.any()).default({}),
  settings: z
    .object({
      retries: z.number().int().min(0).max(10).optional(),
      retryDelaySec: z.number().int().min(1).max(3600).optional(),
      timeoutSec: z.number().int().min(1).max(300).optional(),
      onError: z.enum(['stop', 'continue']).optional(),
    })
    .optional(),
  connectionId: z.uuid().nullable().optional(),
  disabled: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});
const graphSchema = z.object({
  nodes: z.array(nodeSchema).max(200),
  edges: z.array(z.object({ id: z.string().max(200), source: z.string(), sourcePort: z.string().max(80), target: z.string(), targetPort: z.string().optional() })).max(500),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
});

async function connectionMap() {
  const rows = await many<any>('SELECT id, connector, name, status FROM connections');
  return new Map(rows.map((r) => [r.id, { connector: r.connector, name: r.name, status: r.status }]));
}

async function loadWorkflow(id: string) {
  const w = await one<any>('SELECT * FROM workflows WHERE id = $1', [id]);
  if (!w) throw notFound('Workflow nicht gefunden.');
  return w;
}

/** Einstellungen, die vor dem Speichern geprüft werden (Geheimnisse gehören nie in den Graphen). */
function scrubGraph(g: Graph): Graph {
  const json = JSON.stringify(g);
  if (json.length > 1_000_000) throw badRequest('Workflow ist zu groß (max. 1 MB).');
  return g;
}

function exportGraph(g: Graph) {
  // Exporte enthalten nie Geheimnisse – Verbindungen nur als Referenz
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, connectionId: n.connectionId ? `ref:${n.connectionId}` : null })) };
}

export async function workflowRoutes(app: FastifyInstance) {
  app.get('/workflows', { preHandler: requireAuth('workflow.read') }, async (req) => {
    const q = z.object({ archived: z.enum(['true', 'false', '1', '0']).optional() }).parse(req.query);
    const rows = await many<any>(
      `SELECT w.id, w.name, w.description, w.folder, w.status, w.draft_updated_at, w.created_at, w.draft, w.active_version_id,
              v.number AS active_version, v.approved_at AS published_at,
              (SELECT max(number) FROM workflow_versions x WHERE x.workflow_id = w.id) AS latest_version,
              (SELECT count(*)::int FROM workflow_versions x WHERE x.workflow_id = w.id AND x.state = 'pending_approval') AS pending_approvals,
              s.last_run_at, s.last_status, s.runs_30d, s.ok_30d, s.recent
         FROM workflows w
         LEFT JOIN workflow_versions v ON v.id = w.active_version_id
         LEFT JOIN LATERAL (
           SELECT max(created_at) AS last_run_at,
                  (array_agg(status ORDER BY created_at DESC))[1] AS last_status,
                  count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS runs_30d,
                  count(*) FILTER (WHERE created_at > now() - interval '30 days' AND status = 'success')::int AS ok_30d,
                  (array_agg(status ORDER BY created_at DESC))[1:30] AS recent
             FROM runs r WHERE r.workflow_id = w.id AND r.mode = 'production') s ON true
        WHERE ($1::boolean IS TRUE OR w.status <> 'archived')
        ORDER BY lower(w.name)`,
      [q.archived === 'true' || q.archived === '1'],
    );
    return rows.map(({ draft, ...w }) => ({
      ...w,
      success_rate: w.runs_30d ? Math.round((w.ok_30d / w.runs_30d) * 1000) / 10 : null,
      connectors: [...new Set((draft as Graph).nodes.map((n) => nodeType(n.type)?.connector ?? (n.type.startsWith('alamos') ? 'alamos' : n.type === 'trigger.webhook' ? 'webhook' : null)).filter(Boolean))],
      trigger: (() => {
        const t = triggerNode(draft);
        return t ? nodeType(t.type)?.title ?? t.type : null;
      })(),
    }));
  });

  app.get('/workflow-templates', { preHandler: requireAuth('workflow.read') }, async () =>
    TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, connectors: t.connectors, nodes: t.graph.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name })), edges: t.graph.edges.map((e) => ({ source: e.source, target: e.target, sourcePort: e.sourcePort })) })),
  );

  app.post('/workflows', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000).default(''),
        folder: z.string().max(80).default(''),
        templateId: z.string().optional(),
        graph: graphSchema.optional(),
      })
      .parse(req.body);
    let graph: Graph = emptyGraph();
    if (body.templateId) {
      const t = TEMPLATES.find((x) => x.id === body.templateId);
      if (!t) throw badRequest('Vorlage nicht gefunden.');
      graph = structuredClone(t.graph);
    } else if (body.graph) {
      // Import: Verbindungsreferenzen nur übernehmen, wenn sie hier existieren
      const conns = await connectionMap();
      graph = body.graph as Graph;
      for (const n of graph.nodes) {
        const ref = typeof n.connectionId === 'string' ? n.connectionId.replace(/^ref:/, '') : null;
        n.connectionId = ref && conns.has(ref) ? ref : null;
      }
    }
    const w = await one<any>(
      `INSERT INTO workflows (name, description, folder, draft, created_by, draft_updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id, name`,
      [body.name, body.description, body.folder, JSON.stringify(scrubGraph(graph)), req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, body.graph ? 'workflow.imported' : 'workflow.created', { type: 'workflow', id: w.id, label: w.name }, { vorlage: body.templateId ?? null });
    return w;
  });

  app.get('/workflows/:id', { preHandler: requireAuth('workflow.read') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const w = await loadWorkflow(id);
    const versions = await many<any>(
      `SELECT v.id, v.number, v.state, v.change_note, v.requested_at, v.approved_at, v.requested_by, ru.name AS requested_by_name, au.name AS approved_by_name,
              (v.id = $2) AS active
         FROM workflow_versions v
         LEFT JOIN users ru ON ru.id = v.requested_by LEFT JOIN users au ON au.id = v.approved_by
        WHERE v.workflow_id = $1 ORDER BY v.number DESC`,
      [id, w.active_version_id],
    );
    const endpoints = await many<any>('SELECT id, node_id, token, auth_mode, status, last_received_at, received_count FROM webhook_endpoints WHERE workflow_id = $1', [id]);
    const binding = await one<any>('SELECT kind, next_run_at, last_event_at, last_error FROM trigger_bindings WHERE workflow_id = $1', [id]);
    const s = await getSettings();
    return {
      ...w,
      sample_event: w.sample_event,
      listening: w.listen_until && new Date(w.listen_until).getTime() > Date.now(),
      versions,
      endpoints: endpoints.map((e) => ({ ...e, url: `${config.publicUrl}${webhookUrl(e.token)}`, path: webhookUrl(e.token), token: undefined })),
      binding,
      fourEyes: s['execution.four_eyes'],
    };
  });

  /** Autosave des Entwurfs mit Revisionsprüfung (verhindert, dass zwei Personen sich überschreiben). */
  app.put('/workflows/:id/draft', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ revision: z.number().int(), graph: graphSchema }).parse(req.body);
    const graph = scrubGraph(body.graph as Graph);
    const row = await one<any>(
      `UPDATE workflows SET draft = $3, draft_revision = draft_revision + 1, draft_updated_at = now(), draft_updated_by = $4
        WHERE id = $1 AND draft_revision = $2 AND status <> 'archived' RETURNING draft_revision, draft_updated_at`,
      [id, body.revision, JSON.stringify(graph), req.auth!.user?.id ?? null],
    );
    if (!row) {
      const cur = await one<any>('SELECT w.draft_revision, w.draft_updated_at, u.name FROM workflows w LEFT JOIN users u ON u.id = w.draft_updated_by WHERE w.id = $1', [id]);
      if (!cur) throw notFound();
      throw conflict(`Der Entwurf wurde inzwischen von ${cur.name ?? 'jemand anderem'} geändert. Bitte neu laden.`, { revision: cur.draft_revision });
    }
    return row;
  });

  app.patch('/workflows/:id', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(1000).optional(), folder: z.string().max(80).optional() }).parse(req.body);
    const w = await one<any>(
      `UPDATE workflows SET name = COALESCE($2, name), description = COALESCE($3, description), folder = COALESCE($4, folder) WHERE id = $1 RETURNING id, name, description, folder`,
      [id, body.name ?? null, body.description ?? null, body.folder ?? null],
    );
    if (!w) throw notFound();
    await audit(req.auth!.actor, 'workflow.updated', { type: 'workflow', id, label: w.name }, { felder: Object.keys(body) });
    return w;
  });

  app.post('/workflows/:id/validate', { preHandler: requireAuth('workflow.read') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const w = await loadWorkflow(id);
    const conns = await connectionMap();
    const issues = validateGraph(w.draft, { connections: conns });
    const s = await getSettings();
    const trig = triggerNode(w.draft);
    if (trig?.type === 'trigger.schedule') {
      const p = validateSchedule(trig.config, s['general.timezone']);
      if (p) issues.push({ severity: 'error', nodeId: trig.id, message: p });
    }
    const active = w.active_version_id ? await one<any>('SELECT graph, number FROM workflow_versions WHERE id = $1', [w.active_version_id]) : null;
    return {
      valid: !issues.some((i) => i.severity === 'error'),
      issues,
      preview: publishPreview(w.draft, conns),
      diff: diffGraphs(active?.graph ?? null, w.draft),
      activeVersion: active?.number ?? null,
      nextScheduledRun: trig?.type === 'trigger.schedule' ? nextScheduleRun(trig.config, s['general.timezone'], new Date()) : null,
    };
  });

  /** Veröffentlichen: erzeugt eine unveränderliche Version. Mit Vier-Augen-Prinzip zunächst „wartet auf Freigabe“. */
  app.post('/workflows/:id/publish', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ changeNote: z.string().max(500).default(''), activate: z.boolean().default(true) }).parse(req.body ?? {});
    const s = await getSettings();
    const conns = await connectionMap();
    const result = await tx(async (db) => {
      const w = await one<any>('SELECT * FROM workflows WHERE id = $1 FOR UPDATE', [id], db);
      if (!w) throw notFound();
      if (w.status === 'archived') throw badRequest('Archivierte Workflows können nicht veröffentlicht werden.');
      const issues = validateGraph(w.draft, { connections: conns });
      if (issues.some((i) => i.severity === 'error')) throw new AppError(422, 'invalid_graph', 'Der Workflow ist noch nicht vollständig.', issues);
      const trig = triggerNode(w.draft);
      if (trig?.type === 'trigger.schedule') {
        const p = validateSchedule(trig.config, s['general.timezone']);
        if (p) throw new AppError(422, 'invalid_graph', p);
      }
      const active = w.active_version_id ? await one<any>('SELECT graph FROM workflow_versions WHERE id = $1', [w.active_version_id], db) : null;
      if (active && diffGraphs(active.graph, w.draft).identical) throw badRequest('Keine Änderungen gegenüber der aktiven Version.');
      await db.query(`UPDATE workflow_versions SET state = 'rejected' WHERE workflow_id = $1 AND state = 'pending_approval'`, [id]);
      const num = await one<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM workflow_versions WHERE workflow_id = $1', [id], db);
      const canPublish = req.auth!.permissions.has('workflow.publish');
      const needsApproval = s['execution.four_eyes'] || !canPublish;
      const v = await one<any>(
        `INSERT INTO workflow_versions (workflow_id, number, graph, state, change_note, requested_by, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, number, state`,
        [id, num!.n, JSON.stringify(w.draft), needsApproval ? 'pending_approval' : 'published', body.changeNote, req.auth!.user?.id ?? null, needsApproval ? null : (req.auth!.user?.id ?? null), needsApproval ? null : new Date()],
        db,
      );
      let webhook: { secret: string | null; path: string | null } | null = null;
      if (!needsApproval) {
        if (w.active_version_id) await db.query(`UPDATE workflow_versions SET state = 'superseded' WHERE id = $1`, [w.active_version_id]);
        const makeActive = body.activate || w.status === 'active';
        await db.query(`UPDATE workflows SET active_version_id = $2, status = $3 WHERE id = $1`, [id, v.id, makeActive ? 'active' : 'inactive']);
        if (makeActive) {
          const b = await activateBinding(db, id, v.id, w.draft, req.auth!.user?.id ?? null);
          if (b.webhookPath) webhook = { secret: b.webhookSecret, path: b.webhookPath };
        }
      }
      return { version: v, name: w.name, needsApproval, webhook: webhook ? { ...webhook, url: `${config.publicUrl}${webhook.path}` } : null };
    });
    await audit(req.auth!.actor, result.needsApproval ? 'workflow.approval_requested' : 'workflow.published', { type: 'workflow', id, label: result.name }, { version: result.version.number, notiz: body.changeNote });
    if (result.needsApproval) {
      await notify({ kind: 'info', title: `Freigabe angefragt: ${result.name} v${result.version.number}`, body: body.changeNote, link: `/workflows/${id}`, permission: 'workflow.approve' });
    }
    return result;
  });

  app.post('/workflows/:id/versions/:versionId/decision', { preHandler: requireAuth('workflow.approve') }, async (req) => {
    const { id, versionId } = z.object({ id: z.uuid(), versionId: z.uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean(), comment: z.string().max(500).default(''), activate: z.boolean().default(true) }).parse(req.body);
    const res = await tx(async (db) => {
      const w = await one<any>('SELECT * FROM workflows WHERE id = $1 FOR UPDATE', [id], db);
      const v = await one<any>(`SELECT * FROM workflow_versions WHERE id = $1 AND workflow_id = $2 AND state = 'pending_approval' FOR UPDATE`, [versionId, id], db);
      if (!w || !v) throw notFound('Keine offene Freigabe gefunden.');
      if (v.requested_by && v.requested_by === req.auth!.user?.id) throw forbidden('Die eigene Änderung kann nicht selbst freigegeben werden (Vier-Augen-Prinzip).');
      if (!body.approve) {
        await db.query(`UPDATE workflow_versions SET state = 'rejected', approved_by = $2, approved_at = now(), change_note = change_note || $3 WHERE id = $1`, [versionId, req.auth!.user?.id ?? null, body.comment ? `\nAbgelehnt: ${body.comment}` : '']);
        return { w, v, approved: false, webhook: null };
      }
      if (w.active_version_id) await db.query(`UPDATE workflow_versions SET state = 'superseded' WHERE id = $1`, [w.active_version_id]);
      await db.query(`UPDATE workflow_versions SET state = 'published', approved_by = $2, approved_at = now() WHERE id = $1`, [versionId, req.auth!.user?.id ?? null]);
      const makeActive = body.activate || w.status === 'active';
      await db.query(`UPDATE workflows SET active_version_id = $2, status = $3 WHERE id = $1`, [id, versionId, makeActive ? 'active' : 'inactive']);
      const b = makeActive ? await activateBinding(db, id, versionId, v.graph, req.auth!.user?.id ?? null) : null;
      return { w, v, approved: true, webhook: b?.webhookPath ? { secret: b.webhookSecret, path: b.webhookPath, url: `${config.publicUrl}${b.webhookPath}` } : null };
    });
    await audit(req.auth!.actor, res.approved ? 'workflow.approved' : 'workflow.rejected', { type: 'workflow', id, label: res.w.name }, { version: res.v.number, kommentar: body.comment });
    if (res.v.requested_by) await notify({ kind: res.approved ? 'success' : 'warning', title: `${res.w.name} v${res.v.number} ${res.approved ? 'freigegeben' : 'abgelehnt'}`, body: body.comment, link: `/workflows/${id}`, userId: res.v.requested_by });
    return { ok: true, approved: res.approved, webhook: res.webhook };
  });

  app.post('/workflows/:id/status', { preHandler: requireAuth('workflow.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ status: z.enum(['active', 'inactive', 'archived']) }).parse(req.body);
    const w = await tx(async (db) => {
      const w = await one<any>('SELECT * FROM workflows WHERE id = $1 FOR UPDATE', [id], db);
      if (!w) throw notFound();
      if (body.status === 'active') {
        if (!w.active_version_id) throw badRequest('Es gibt noch keine veröffentlichte Version. Bitte zuerst veröffentlichen.');
        const v = await one<any>('SELECT graph FROM workflow_versions WHERE id = $1', [w.active_version_id], db);
        const b = await activateBinding(db, id, w.active_version_id, v.graph, req.auth!.user?.id ?? null);
        if (b.webhookPath) w.webhook = { secret: b.webhookSecret, path: b.webhookPath, url: `${config.publicUrl}${b.webhookPath}` };
      } else {
        await deactivateBinding(db, id);
      }
      await db.query('UPDATE workflows SET status = $2 WHERE id = $1', [id, body.status]);
      return w;
    });
    await audit(req.auth!.actor, `workflow.${body.status === 'active' ? 'activated' : body.status === 'inactive' ? 'deactivated' : 'archived'}`, { type: 'workflow', id, label: w.name }, { vorher: w.status });
    return { ok: true, previous: w.status, webhook: w.webhook ?? null };
  });

  app.post('/workflows/:id/rollback', { preHandler: requireAuth('workflow.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { versionId } = z.object({ versionId: z.uuid() }).parse(req.body);
    const res = await tx(async (db) => {
      const w = await one<any>('SELECT * FROM workflows WHERE id = $1 FOR UPDATE', [id], db);
      const v = await one<any>(`SELECT * FROM workflow_versions WHERE id = $1 AND workflow_id = $2 AND state IN ('published','superseded')`, [versionId, id], db);
      if (!w || !v) throw notFound('Version nicht gefunden.');
      if (w.active_version_id) await db.query(`UPDATE workflow_versions SET state = 'superseded' WHERE id = $1`, [w.active_version_id]);
      await db.query(`UPDATE workflow_versions SET state = 'published' WHERE id = $1`, [versionId]);
      await db.query(`UPDATE workflows SET active_version_id = $2, draft = $3, draft_revision = draft_revision + 1, draft_updated_at = now() WHERE id = $1`, [id, versionId, JSON.stringify(v.graph)]);
      const b = w.status === 'active' ? await activateBinding(db, id, versionId, v.graph, req.auth!.user?.id ?? null) : null;
      return { w, v, webhook: b?.webhookPath ? { secret: b.webhookSecret, path: b.webhookPath, url: `${config.publicUrl}${b.webhookPath}` } : null };
    });
    await audit(req.auth!.actor, 'workflow.rolled_back', { type: 'workflow', id, label: res.w.name }, { version: res.v.number });
    return { ok: true, version: res.v.number, webhook: res.webhook };
  });

  app.get('/workflows/:id/versions/:versionId', { preHandler: requireAuth('workflow.read') }, async (req) => {
    const { id, versionId } = z.object({ id: z.uuid(), versionId: z.uuid() }).parse(req.params);
    const v = await one<any>('SELECT * FROM workflow_versions WHERE id = $1 AND workflow_id = $2', [versionId, id]);
    if (!v) throw notFound();
    const w = await loadWorkflow(id);
    const active = w.active_version_id && w.active_version_id !== versionId ? await one<any>('SELECT graph FROM workflow_versions WHERE id = $1', [w.active_version_id]) : null;
    return { ...v, diffToActive: active ? diffGraphs(active.graph, v.graph) : null, diffToDraft: diffGraphs(v.graph, w.draft) };
  });

  app.post('/workflows/:id/duplicate', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const w = await loadWorkflow(id);
    const copy = await one<any>(
      `INSERT INTO workflows (name, description, folder, draft, created_by, draft_updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id, name`,
      [`${w.name} (Kopie)`.slice(0, 120), w.description, w.folder, JSON.stringify(w.draft), req.auth!.user?.id ?? null],
    );
    await audit(req.auth!.actor, 'workflow.duplicated', { type: 'workflow', id: copy.id, label: copy.name }, { quelle: id });
    return copy;
  });

  app.get('/workflows/:id/export', { preHandler: requireAuth('workflow.read') }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const w = await loadWorkflow(id);
    await audit(req.auth!.actor, 'workflow.exported', { type: 'workflow', id, label: w.name });
    reply.header('content-disposition', `attachment; filename="lifelink-workflow-${w.name.replace(/[^\w-]+/g, '_').slice(0, 50)}.json"`);
    return { format: 'lifelink-workflow', version: 1, exported_at: new Date().toISOString(), name: w.name, description: w.description, folder: w.folder, graph: exportGraph(w.draft) };
  });

  app.delete('/workflows/:id', { preHandler: requireAuth('workflow.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    const w = await loadWorkflow(id);
    if (confirm.trim() !== w.name.trim()) throw badRequest('Zur Bestätigung den Namen des Workflows eingeben.');
    await tx(async (db) => {
      await deactivateBinding(db, id);
      await db.query('DELETE FROM workflows WHERE id = $1', [id]);
    });
    await audit(req.auth!.actor, 'workflow.deleted', { type: 'workflow', id, label: w.name });
    return { ok: true };
  });

  /* ------------------------------- Testen im Editor -------------------------------- */

  app.post('/workflows/:id/test', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ input: z.any().optional(), simulate: z.boolean().default(true) }).parse(req.body ?? {});
    const w = await loadWorkflow(id);
    const conns = await connectionMap();
    const issues = validateGraph(w.draft, { connections: conns }).filter((i) => i.severity === 'error');
    if (issues.length) throw new AppError(422, 'invalid_graph', 'Bitte zuerst die markierten Probleme beheben.', issues);
    if (!body.simulate) {
      // Echte Aktionen im Testlauf: wie Veröffentlichen zu behandeln
      if (!req.auth!.permissions.has('workflow.publish')) throw forbidden('Testläufe mit echten Aktionen dürfen nur Personen mit Veröffentlichungsrecht starten.');
    }
    const trig = triggerNode(w.draft)!;
    const t = nodeType(trig.type);
    const input = body.input ?? w.sample_event?.data ?? (trig.type === 'trigger.manual' ? { data: safeJson(trig.config.sample) } : t?.sampleOutput ?? {});
    const runId = await createRun({
      workflowId: id,
      versionId: null,
      versionNumber: null,
      graph: w.draft,
      mode: 'test',
      simulate: body.simulate,
      triggerKind: trig.type,
      triggerLabel: body.simulate ? 'Testlauf (simuliert)' : 'Testlauf (echte Aktionen)',
      triggerOutput: input,
      startedBy: req.auth!.user?.id ?? null,
    });
    await audit(req.auth!.actor, 'workflow.test_run', { type: 'workflow', id, label: w.name }, { lauf: runId, simuliert: body.simulate });
    return { runId };
  });

  app.post('/workflows/:id/run', { preHandler: requireAuth('workflow.publish') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ data: z.any().optional() }).parse(req.body ?? {});
    const w = await loadWorkflow(id);
    if (w.status !== 'active' || !w.active_version_id) throw badRequest('Nur aktive Workflows können gestartet werden.');
    const v = await one<any>('SELECT id, number, graph FROM workflow_versions WHERE id = $1', [w.active_version_id]);
    const trig = triggerNode(v.graph)!;
    if (trig.type !== 'trigger.manual') throw badRequest('Dieser Workflow wird über seinen Trigger gestartet, nicht manuell.');
    const runId = await createRun({
      workflowId: id,
      versionId: v.id,
      versionNumber: v.number,
      graph: v.graph,
      mode: 'production',
      simulate: false,
      triggerKind: trig.type,
      triggerLabel: `Manuell: ${req.auth!.actor.name}`,
      triggerOutput: { data: body.data ?? safeJson(trig.config.sample) ?? {}, started_by: req.auth!.actor.name },
      startedBy: req.auth!.user?.id ?? null,
    });
    await audit(req.auth!.actor, 'workflow.manual_run', { type: 'workflow', id, label: w.name }, { lauf: runId });
    return { runId };
  });

  app.post('/workflows/:id/nodes/:nodeId/test', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id, nodeId } = z.object({ id: z.uuid(), nodeId: z.string() }).parse(req.params);
    const body = z.object({ data: z.record(z.string(), z.any()).default({}), simulate: z.boolean().default(true), graph: graphSchema.optional() }).parse(req.body ?? {});
    const w = await loadWorkflow(id);
    if (!body.simulate && !req.auth!.permissions.has('workflow.publish')) throw forbidden('Echte Aktionen beim Testen erfordern das Veröffentlichungsrecht.');
    const graph = (body.graph as Graph) ?? w.draft;
    const res = await testSingleNode(graph, nodeId, body.data, { simulate: body.simulate, workflowId: id, workflowName: w.name });
    if (!body.simulate) await audit(req.auth!.actor, 'workflow.node_test_live', { type: 'workflow', id, label: w.name }, { baustein: nodeId, ok: res.ok });
    return res;
  });

  /** Webhook-Adresse eines Trigger-Bausteins (wird bei Bedarf angelegt). Das Geheimnis gibt es nur beim ersten Mal. */
  app.post('/workflows/:id/nodes/:nodeId/webhook', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id, nodeId } = z.object({ id: z.uuid(), nodeId: z.string() }).parse(req.params);
    const w = await loadWorkflow(id);
    const node = (w.draft as Graph).nodes.find((n) => n.id === nodeId);
    if (!node || nodeType(node.type)?.trigger !== 'webhook') throw badRequest('Dieser Baustein hat keine Webhook-Adresse.');
    const mode = node.type === 'alamos.alarm' ? 'token' : (node.config.authMode ?? 'hmac');
    const { endpoint, secret } = await ensureWebhookEndpoint(id, nodeId, mode, req.auth!.user?.id ?? null);
    if (secret) await audit(req.auth!.actor, 'webhook.created', { type: 'webhook', id: endpoint.id, label: w.name });
    return { id: endpoint.id, url: `${config.publicUrl}${webhookUrl(endpoint.token)}`, path: webhookUrl(endpoint.token), authMode: mode, secret, status: endpoint.status };
  });

  app.post('/workflows/:id/listen', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { stop } = z.object({ stop: z.boolean().default(false) }).parse(req.body ?? {});
    await pool.query(`UPDATE workflows SET listen_until = CASE WHEN $2 THEN NULL ELSE now() + interval '5 minutes' END WHERE id = $1`, [id, stop]);
    return { ok: true, listening: !stop };
  });

  app.delete('/workflows/:id/sample', { preHandler: requireAuth('workflow.edit') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await pool.query('UPDATE workflows SET sample_event = NULL WHERE id = $1', [id]);
    return { ok: true };
  });

  /** Beispielwerte für den Variablen-Picker: Ausgaben des letzten Laufs je Baustein. */
  app.get('/workflows/:id/last-outputs', { preHandler: requireAuth('workflow.read') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const run = await one<any>(`SELECT id FROM runs WHERE workflow_id = $1 AND status IN ('success','error','needs_review') ORDER BY id DESC LIMIT 1`, [id]);
    if (!run) return { runId: null, outputs: {} };
    const steps = await many<any>(`SELECT DISTINCT ON (node_id) node_id, output_preview FROM step_runs WHERE run_id = $1 ORDER BY node_id, id DESC`, [run.id]);
    return { runId: run.id, outputs: Object.fromEntries(steps.map((s) => [s.node_id, s.output_preview])) };
  });
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
