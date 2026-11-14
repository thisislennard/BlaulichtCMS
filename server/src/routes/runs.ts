import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createRun, loadState } from '../engine/executor.js';
import { ERROR_CLASS_LABELS } from '../lib/errors.js';
import { isIdempotent, nodeType } from '../nodes/registry.js';
import type { Graph } from '../engine/types.js';

const STATUS_GROUPS: Record<string, string[]> = {
  error: ['error', 'dead', 'needs_review'],
  running: ['queued', 'running', 'waiting'],
  success: ['success'],
};

async function runGraph(run: any): Promise<Graph | null> {
  if (run.graph) return run.graph;
  if (!run.version_id) return null;
  return (await one<any>('SELECT graph FROM workflow_versions WHERE id = $1', [run.version_id]))?.graph ?? null;
}

/** Kann ab dem fehlerhaften Baustein wiederholt werden? Mit Begründung, wenn nicht. */
async function replayInfo(run: any) {
  const terminalFail = ['error', 'dead', 'needs_review'].includes(run.status);
  const contextAvailable = !!run.context_enc && (!run.context_expires_at || new Date(run.context_expires_at).getTime() > Date.now());
  const graph = await runGraph(run);
  const failedNode = graph?.nodes.find((n) => n.id === run.error_node_id);
  const t = failedNode ? nodeType(failedNode.type) : undefined;
  const sideEffect = !!t?.sideEffect;
  const idem = t && failedNode ? isIdempotent(t, failedNode.config) : true;
  let fromFailed: { allowed: boolean; reason?: string } = { allowed: false, reason: 'Nur bei fehlgeschlagenen Läufen möglich.' };
  if (terminalFail) {
    if (!contextAvailable) fromFailed = { allowed: false, reason: 'Die Laufdaten sind nicht mehr gespeichert (Aufbewahrungsfrist abgelaufen).' };
    else if (!failedNode) fromFailed = { allowed: false, reason: 'Der fehlerhafte Baustein ist nicht mehr bekannt.' };
    else if (!graph) fromFailed = { allowed: false, reason: 'Die Workflow-Version existiert nicht mehr.' };
    else fromFailed = { allowed: true };
  }
  return {
    fromFailed,
    full: { allowed: terminalFail || run.status === 'success' || run.status === 'canceled' },
    warning:
      run.status === 'needs_review'
        ? 'Unklar, ob die letzte Aktion schon ausgeführt wurde. Vor dem Wiederholen im Zielsystem prüfen – sonst droht eine Doppelwirkung.'
        : sideEffect && !idem
          ? `„${failedNode?.name}“ ist nicht wiederholungssicher. Eine Wiederholung kann eine Doppelwirkung erzeugen (z. B. zweite E-Mail).`
          : null,
  };
}

export async function runRoutes(app: FastifyInstance) {
  app.get('/runs', { preHandler: requireAuth('run.read') }, async (req) => {
    const q = z
      .object({
        status: z.enum(['all', 'error', 'running', 'success']).default('all'),
        workflowId: z.uuid().optional(),
        mode: z.enum(['production', 'test', 'all']).default('all'),
        q: z.string().max(100).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        since: z.string().optional(),
      })
      .parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status !== 'all') {
      params.push(STATUS_GROUPS[q.status]);
      where.push(`r.status = ANY($${params.length})`);
    }
    if (q.workflowId) {
      params.push(q.workflowId);
      where.push(`r.workflow_id = $${params.length}`);
    }
    if (q.mode !== 'all') {
      params.push(q.mode);
      where.push(`r.mode = $${params.length}`);
    }
    if (q.before) {
      params.push(q.before);
      where.push(`r.id < $${params.length}`);
    }
    if (q.since) {
      params.push(q.since);
      where.push(`r.created_at >= $${params.length}::timestamptz`);
    }
    if (q.q) {
      const idq = q.q.replace(/^#/, '');
      if (/^\d+$/.test(idq)) {
        params.push(Number(idq));
        where.push(`r.id = $${params.length}`);
      } else {
        params.push(`%${q.q}%`);
        where.push(`(w.name ILIKE $${params.length} OR r.trigger_label ILIKE $${params.length} OR r.summary ILIKE $${params.length} OR r.correlation_id ILIKE $${params.length})`);
      }
    }
    params.push(q.limit);
    const rows = await many<any>(
      `SELECT r.id, r.workflow_id, w.name AS workflow_name, r.version_number, r.mode, r.simulate, r.trigger_kind, r.trigger_label, r.status,
              r.created_at, r.started_at, r.finished_at, r.duration_ms, r.error_message, r.summary, r.parent_run_id, r.replay_kind
         FROM runs r JOIN workflows w ON w.id = r.workflow_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.id DESC LIMIT $${params.length}`,
      params,
    );
    const counts = await one<any>(
      `SELECT count(*) FILTER (WHERE status = ANY('{error,dead,needs_review}'))::int AS error,
              count(*) FILTER (WHERE status = ANY('{queued,running,waiting}'))::int AS running,
              count(*) FILTER (WHERE status = 'success')::int AS success, count(*)::int AS all
         FROM runs WHERE created_at > now() - interval '30 days'`,
    );
    return { runs: rows, counts, nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null };
  });

  app.get('/runs/:id', { preHandler: requireAuth('run.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const run = await one<any>(
      `SELECT r.*, w.name AS workflow_name, u.name AS started_by_name FROM runs r JOIN workflows w ON w.id = r.workflow_id LEFT JOIN users u ON u.id = r.started_by WHERE r.id = $1`,
      [id],
    );
    if (!run) throw notFound('Lauf nicht gefunden.');
    const steps = await many<any>('SELECT * FROM step_runs WHERE run_id = $1 ORDER BY id', [id]);
    const graph = await runGraph(run);
    const event = run.event_id ? await one<any>('SELECT id, received_at, source, dedup_key, correlation_id, duplicate FROM event_receipts WHERE id = $1', [run.event_id]) : null;
    const children = await many<any>('SELECT id, status, replay_kind, created_at FROM runs WHERE parent_run_id = $1 ORDER BY id', [id]);
    const { context_enc, graph: _g, ...safe } = run;
    return {
      ...safe,
      error_class_label: run.error_code ? (ERROR_CLASS_LABELS as any)[run.error_code] ?? run.error_code : null,
      steps: steps.map((s) => ({ ...s, category: s.category, retryNote: s.status === 'error' && s.status_text?.includes('neuer Versuch') })),
      graph: graph ? { nodes: graph.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, key: n.key, position: n.position, category: nodeType(n.type)?.category ?? 'control', icon: nodeType(n.type)?.icon ?? 'Box' })), edges: graph.edges } : null,
      event,
      children,
      replay: await replayInfo(run),
    };
  });

  app.post('/runs/:id/replay', { preHandler: requireAuth('run.replay') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ kind: z.enum(['full', 'from_failed']), confirm: z.boolean().default(false) }).parse(req.body);
    const run = await one<any>('SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1', [id]);
    if (!run) throw notFound();
    const info = await replayInfo(run);
    if (body.kind === 'from_failed' && !info.fromFailed.allowed) throw badRequest(info.fromFailed.reason ?? 'Nicht möglich.');
    if (body.kind === 'full' && !info.full.allowed) throw badRequest('Laufende Läufe können nicht wiederholt werden.');
    if (info.warning && !body.confirm) throw conflict('Bitte die mögliche Doppelwirkung bestätigen.', { warning: info.warning });
    const graph = await runGraph(run);
    if (!graph) throw badRequest('Die Workflow-Version existiert nicht mehr.');
    const state = await loadState(id);
    let carry = null;
    let triggerOutput: unknown = run.input_preview;
    if (state) {
      const trig = graph.nodes.find((n) => state.done[n.id] && nodeType(n.type)?.category === 'trigger');
      triggerOutput = state.data.trigger ?? (trig ? state.data[trig.key] : run.input_preview);
    }
    if (body.kind === 'from_failed' && state) {
      // Ergebnisse bis vor den fehlerhaften Baustein übernehmen; dieser und alles danach läuft neu
      const done: typeof state.done = {};
      for (const [k, v] of Object.entries(state.done)) if (k !== run.error_node_id && v.status !== 'error') done[k] = v;
      carry = { ...state, done, rootRunId: state.rootRunId };
      // Fehler-Wiederholung nicht-idempotenter Aktion: Idempotenzsperre bewusst aufheben (Nutzer hat bestätigt)
      await pool.query('DELETE FROM idempotency_records WHERE key = $1', [`${state.rootRunId}:${run.error_node_id}`]);
    }
    const newId = await createRun({
      workflowId: run.workflow_id,
      versionId: run.version_id,
      versionNumber: run.version_number,
      graph,
      mode: run.mode,
      simulate: run.simulate,
      triggerKind: run.trigger_kind,
      triggerLabel: body.kind === 'full' ? `Wiederholung von #${id}` : `Fortsetzung von #${id}`,
      triggerOutput,
      eventId: run.event_id,
      correlationId: run.correlation_id,
      startedBy: req.auth!.user?.id ?? null,
      parentRunId: id,
      replayKind: body.kind,
      carryState: carry,
    });
    await audit(req.auth!.actor, 'run.replayed', { type: 'run', id, label: `#${id} ${run.workflow_name}` }, { art: body.kind, neuer_lauf: newId, warnung_bestaetigt: !!info.warning });
    return { runId: newId };
  });

  app.post('/runs/:id/cancel', { preHandler: requireAuth('run.replay') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const run = await one<any>(
      `UPDATE runs SET status = 'canceled', finished_at = now(), summary = 'Abgebrochen', duration_ms = (EXTRACT(EPOCH FROM now() - COALESCE(started_at, created_at)) * 1000)::int
        WHERE id = $1 AND status IN ('queued','waiting','running') RETURNING id, workflow_id`,
      [id],
    );
    if (!run) throw badRequest('Lauf ist bereits beendet.');
    await pool.query(`UPDATE jobs SET status = 'done' WHERE kind = 'run.execute' AND status = 'queued' AND (payload->>'runId')::bigint = $1`, [id]);
    await audit(req.auth!.actor, 'run.canceled', { type: 'run', id, label: `#${id}` });
    return { ok: true };
  });
}
