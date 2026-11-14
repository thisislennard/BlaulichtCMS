import crypto from 'node:crypto';
import { one, pool } from '../db/pool.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { ERROR_CLASS_LABELS, isRetryableClass, StepError, toStepError } from '../lib/errors.js';
import { preview } from '../lib/mask.js';
import { render, renderValue, setTemplateTimeZone } from '../lib/template.js';
import { getSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';
import { isIdempotent, nodeType } from '../nodes/registry.js';
import { breakerCheck, breakerResult, loadRuntimeConnection, markConnectionUsed } from './connections.js';
import { topoOrder, triggerNode } from './graph.js';
import { backoffMs, enqueue, enqueueFollowUp } from './queue.js';
import type { ExecContext, Graph, GraphNode, NodeResult, RuntimeConnection } from './types.js';

/** Zustand eines Laufs – verschlüsselt in runs.context_enc, damit Wiederholungen möglich sind. */
export interface RunState {
  data: Record<string, unknown>;
  done: Record<string, { port: string | null; status: 'success' | 'skipped' | 'error' }>;
  attempts: Record<string, number>;
  waiting?: { nodeId: string; until: number; stepId: number } | null;
  rootRunId: number;
}

const aad = (runId: number) => `run-context:${runId}`;

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

async function saveState(runId: number, state: RunState) {
  await pool.query('UPDATE runs SET context_enc = $2 WHERE id = $1', [runId, encrypt(JSON.stringify(state), aad(runId))]);
}

export async function loadState(runId: number): Promise<RunState | null> {
  const r = await one<{ context_enc: string | null }>('SELECT context_enc FROM runs WHERE id = $1', [runId]);
  if (!r?.context_enc) return null;
  return JSON.parse(decrypt(r.context_enc, aad(runId)));
}

export interface CreateRunInput {
  workflowId: string;
  versionId: string | null;
  versionNumber: number | null;
  graph: Graph;
  mode: 'production' | 'test';
  simulate: boolean;
  triggerKind: string;
  triggerLabel: string;
  triggerOutput: unknown;
  eventId?: number | null;
  correlationId?: string;
  startedBy?: string | null;
  parentRunId?: number | null;
  replayKind?: 'full' | 'from_failed' | null;
  /** Für „ab fehlerhaftem Node“: übernommene Ergebnisse */
  carryState?: RunState | null;
}

/** Legt einen Lauf an, protokolliert den Trigger-Schritt und reiht die Ausführung ein. */
export async function createRun(input: CreateRunInput): Promise<number> {
  const trig = triggerNode(input.graph);
  if (!trig) throw new Error('Workflow hat keinen Trigger.');
  const correlationId = input.correlationId ?? newCorrelationId();
  const run = await one<{ id: number }>(
    `INSERT INTO runs (workflow_id, version_id, version_number, graph, mode, simulate, trigger_kind, trigger_label, event_id, correlation_id,
                       started_by, parent_run_id, replay_kind, input_preview, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued') RETURNING id`,
    [
      input.workflowId,
      input.versionId,
      input.versionNumber,
      input.mode === 'test' ? JSON.stringify(input.graph) : null,
      input.mode,
      input.simulate,
      input.triggerKind,
      input.triggerLabel,
      input.eventId ?? null,
      correlationId,
      input.startedBy ?? null,
      input.parentRunId ?? null,
      input.replayKind ?? null,
      JSON.stringify(preview(input.triggerOutput)),
    ],
  );
  const runId = run!.id;
  let state: RunState;
  if (input.carryState) {
    state = { ...input.carryState, attempts: {}, waiting: null };
  } else {
    state = {
      data: { trigger: input.triggerOutput, [trig.key]: input.triggerOutput },
      done: { [trig.id]: { port: 'out', status: 'success' } },
      attempts: {},
      waiting: null,
      rootRunId: runId,
    };
  }
  await saveState(runId, state);
  // Trigger-Schritt bzw. übernommene Schritte sichtbar machen
  if (input.carryState) {
    for (const [nodeId, d] of Object.entries(state.done)) {
      const n = input.graph.nodes.find((x) => x.id === nodeId);
      if (!n) continue;
      await insertStep(runId, n, d.status === 'skipped' ? 'skipped' : 'success', { output: state.data[n.key], statusText: 'Aus vorherigem Lauf übernommen', port: d.port });
    }
  } else {
    await insertStep(runId, trig, 'success', { output: input.triggerOutput, statusText: input.triggerLabel, port: 'out' });
  }
  await enqueue('run.execute', { runId }, { dedupKey: `run:${runId}`, maxAttempts: 3 });
  return runId;
}

async function insertStep(
  runId: number,
  node: GraphNode,
  status: 'running' | 'success' | 'error' | 'skipped' | 'waiting' | 'simulated',
  extra: { output?: unknown; input?: unknown; error?: unknown; statusText?: string; port?: string | null; attempt?: number; secrets?: string[]; durationMs?: number; externalRef?: string },
): Promise<number> {
  const t = nodeType(node.type);
  const r = await one<{ id: number }>(
    `INSERT INTO step_runs (run_id, node_id, node_type, node_name, category, status, attempt, finished_at, duration_ms, output_port, input_preview, output_preview, error, status_text, external_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'running' OR $6 = 'waiting' THEN NULL ELSE now() END, $8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      runId,
      node.id,
      node.type,
      node.name,
      t?.category ?? 'control',
      status,
      extra.attempt ?? 1,
      extra.durationMs ?? (status === 'running' ? null : 0),
      extra.port ?? null,
      extra.input !== undefined ? JSON.stringify(preview(extra.input, extra.secrets)) : null,
      extra.output !== undefined ? JSON.stringify(preview(extra.output, extra.secrets)) : null,
      extra.error ? JSON.stringify(extra.error) : null,
      extra.statusText ?? null,
      extra.externalRef ?? null,
    ],
  );
  return r!.id;
}

async function updateStep(id: number, status: string, extra: { output?: unknown; error?: unknown; statusText?: string; port?: string | null; secrets?: string[]; externalRef?: string }) {
  await pool.query(
    `UPDATE step_runs SET status = $2, finished_at = now(), duration_ms = (EXTRACT(EPOCH FROM now() - started_at) * 1000)::int,
            output_preview = COALESCE($3, output_preview), error = $4, status_text = $5, output_port = $6, external_ref = $7
      WHERE id = $1`,
    [id, status, extra.output !== undefined ? JSON.stringify(preview(extra.output, extra.secrets)) : null, extra.error ? JSON.stringify(extra.error) : null, extra.statusText ?? null, extra.port ?? null, extra.externalRef ?? null],
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new StepError('timeout_unknown', `Zeitlimit von ${Math.round(ms / 1000)} s überschritten.`, { sideEffectUnknown: true })), ms);
    }),
  ]);
}

function buildContext(run: any, node: GraphNode, state: RunState, conn: RuntimeConnection | null, timeoutMs: number, attempt: number, workflowName: string): ExecContext {
  const data = {
    ...state.data,
    run: { id: run.id, mode: run.mode, started_at: (run.started_at ?? new Date()).toISOString?.() ?? String(run.started_at), correlation_id: run.correlation_id, workflow: workflowName },
    now: new Date().toISOString(),
  };
  return {
    run: { id: run.id, mode: run.mode, simulate: run.simulate, correlationId: run.correlation_id, startedAt: String(run.started_at), workflowId: run.workflow_id, workflowName },
    node,
    data,
    render: (tpl, esc = 'none') => render(tpl, data, esc),
    renderValue: (tpl) => renderValue(tpl, data),
    connection: conn,
    timeoutMs,
    idempotencyKey: `${state.rootRunId}:${node.id}`,
    attempt,
    log: (m) => log('info', 'workflow', m, { lauf: run.id }, run.correlation_id),
  };
}

function errorInfo(err: StepError) {
  return { klasse: err.errorClass, klasse_text: ERROR_CLASS_LABELS[err.errorClass], meldung: err.message, hinweis: err.hint ?? null, technisch: err.technical?.slice(0, 1500) ?? null, doppelwirkung_moeglich: err.sideEffectUnknown };
}

async function loadGraph(run: any): Promise<Graph> {
  if (run.graph) return run.graph;
  const v = await one<{ graph: Graph }>('SELECT graph FROM workflow_versions WHERE id = $1', [run.version_id]);
  if (!v) throw new Error('Workflow-Version des Laufs existiert nicht mehr.');
  return v.graph;
}

/**
 * Führt einen Lauf aus (oder setzt ihn fort). Wird vom Worker für Jobs „run.execute“ aufgerufen.
 * Bricht nie mit unbehandeltem Fehler ab – Fehler landen im Lauf.
 */
export async function executeRun(runId: number, opts: { heartbeat?: () => Promise<void> } = {}): Promise<void> {
  const run = await one<any>(
    `SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1`,
    [runId],
  );
  if (!run || ['success', 'error', 'canceled', 'dead', 'needs_review'].includes(run.status)) return;
  const s = await getSettings();
  setTemplateTimeZone(s['general.timezone']);
  const state = await loadState(runId);
  if (!state) {
    await finishRun(run, 'error', new StepError('internal', 'Laufdaten sind nicht mehr vorhanden (Aufbewahrungsfrist abgelaufen).'), null);
    return;
  }
  await pool.query(`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1 WHERE id = $1`, [runId]);
  run.started_at ??= new Date();
  const graph = await loadGraph(run);
  const order = topoOrder(graph);
  if (!order) {
    await finishRun(run, 'error', new StepError('config', 'Der Workflow enthält eine Schleife.'), null);
    return;
  }
  const deadline = new Date(run.started_at).getTime() + s['execution.max_run_minutes'] * 60_000;
  const secrets: string[] = [];

  // Fortsetzung nach „Warten“
  if (state.waiting) {
    if (Date.now() < state.waiting.until - 500) {
      await pool.query(`UPDATE runs SET status = 'waiting' WHERE id = $1`, [runId]);
      await enqueueFollowUp('run.execute', { runId }, new Date(state.waiting.until), `run:${runId}`);
      return;
    }
    const w = state.waiting;
    const node = graph.nodes.find((n) => n.id === w.nodeId);
    state.done[w.nodeId] = { port: 'out', status: 'success' };
    state.waiting = null;
    await updateStep(w.stepId, 'success', { statusText: 'Pause beendet', port: 'out' });
    if (node) state.data[node.key] = { waited_until: new Date(w.until).toISOString() };
    await saveState(runId, state);
  }

  for (const node of order) {
    if (state.done[node.id]) continue;
    await opts.heartbeat?.();
    const current = await one<{ status: string }>('SELECT status FROM runs WHERE id = $1', [runId]);
    if (current?.status === 'canceled') return;
    const incoming = graph.edges.filter((e) => e.target === node.id);
    const active = incoming.some((e) => {
      const d = state.done[e.source];
      return d && d.status !== 'skipped' && d.port === e.sourcePort;
    });
    if (!active || node.disabled) {
      state.done[node.id] = { port: null, status: 'skipped' };
      await insertStep(runId, node, 'skipped', { statusText: node.disabled ? 'Deaktiviert – übersprungen' : 'Nicht ausgeführt' });
      continue;
    }
    if (Date.now() > deadline && run.status !== 'waiting') {
      await saveState(runId, state);
      await finishRun(run, 'error', new StepError('internal', `Der Lauf hat das Zeitlimit von ${s['execution.max_run_minutes']} Minuten überschritten.`), node.id);
      return;
    }

    const t = nodeType(node.type);
    if (!t) {
      await finishRun(run, 'error', new StepError('config', `Unbekannter Baustein „${node.type}“.`), node.id);
      return;
    }
    const settingsNode = node.settings ?? {};
    const maxRetries = settingsNode.retries ?? s['execution.default_retries'];
    const timeoutMs = Math.min(300, settingsNode.timeoutSec ?? s['execution.default_timeout_sec']) * 1000;
    const idem = isIdempotent(t, node.config);
    const simulate = run.simulate && (t.sideEffect || t.type === 'control.wait');

    for (;;) {
      const attempt = (state.attempts[node.id] ?? 0) + 1;
      state.attempts[node.id] = attempt;
      let conn: RuntimeConnection | null = null;
      const stepId = await insertStep(runId, node, 'running', { attempt });
      const idemKey = `${state.rootRunId}:${node.id}`;
      let idemClaimed = false;
      try {
        conn = node.connectionId ? await loadRuntimeConnection(node.connectionId) : null;
        if (conn) secrets.push(...Object.values(conn.secrets).filter((v) => typeof v === 'string' && v.length >= 4));
        if (conn && !simulate) breakerCheck(conn.id);
        const ctx = buildContext(run, node, state, conn, timeoutMs, attempt, run.workflow_name);
        let result: NodeResult;
        if (t.sideEffect && !simulate && !idem) {
          // Doppelwirkung vermeiden: bereits ausgeführte Aktion nicht erneut senden
          const prev = await one<{ state: string; result: any }>('SELECT state, result FROM idempotency_records WHERE key = $1', [idemKey]);
          if (prev?.state === 'done') {
            result = { output: prev.result, statusText: 'Bereits ausgeführt – Ergebnis übernommen' };
          } else if (prev) {
            throw new StepError('timeout_unknown', 'Diese Aktion wurde schon einmal gestartet; ob sie ausgeführt wurde, ist unklar.', {
              hint: 'Im Zielsystem prüfen und den Lauf danach bewusst wiederholen.',
              sideEffectUnknown: true,
            });
          } else {
            await pool.query(`INSERT INTO idempotency_records (key, state) VALUES ($1, 'started') ON CONFLICT DO NOTHING`, [idemKey]);
            idemClaimed = true;
            result = await withTimeout(t.execute(ctx), timeoutMs);
            await pool.query(`UPDATE idempotency_records SET state = 'done', result = $2 WHERE key = $1`, [idemKey, JSON.stringify(result.output ?? null)]);
          }
        } else {
          const fn = simulate ? (t.simulate ?? (async () => ({ output: { simuliert: true }, statusText: 'Simuliert' }))) : t.execute;
          result = await withTimeout(fn(ctx), timeoutMs);
        }
        if (conn && !simulate) {
          breakerResult(conn.id, true, false);
          markConnectionUsed(conn.id, true).catch(() => {});
        }
        state.data[node.key] = result.output ?? {};
        if (result.waitUntil && !simulate) {
          await updateStep(stepId, 'waiting', { output: result.output, statusText: result.statusText ?? 'Wartet', secrets });
          state.waiting = { nodeId: node.id, until: result.waitUntil, stepId };
          await saveState(runId, state);
          await pool.query(`UPDATE runs SET status = 'waiting', summary = $2 WHERE id = $1`, [runId, `Wartet bis ${new Date(result.waitUntil).toISOString()}`]);
          await enqueueFollowUp('run.execute', { runId }, new Date(result.waitUntil), `run:${runId}`);
          return;
        }
        const port = result.port ?? 'out';
        state.done[node.id] = { port, status: 'success' };
        await updateStep(stepId, simulate ? 'simulated' : 'success', { output: result.output, statusText: result.statusText, port, secrets, externalRef: result.externalRef });
        await saveState(runId, state);
        if (result.stopRun) {
          for (const n of order) if (!state.done[n.id]) await insertStep(runId, n, 'skipped', { statusText: 'Nicht ausgeführt (Lauf beendet)' });
          await finishRun(run, result.stopRun, result.stopRun === 'error' ? new StepError('config', result.statusText || 'Lauf wurde als Fehler beendet.') : null, result.stopRun === 'error' ? node.id : null);
          return;
        }
        break;
      } catch (e) {
        const err = toStepError(e);
        if (idemClaimed) {
          if (err.sideEffectUnknown) await pool.query(`UPDATE idempotency_records SET state = 'unknown' WHERE key = $1`, [idemKey]);
          else await pool.query(`DELETE FROM idempotency_records WHERE key = $1`, [idemKey]);
        }
        if (conn && !simulate) {
          breakerResult(conn.id, false, err.errorClass === 'transient');
          if (['auth', 'permission', 'config'].includes(err.errorClass)) markConnectionUsed(conn.id, false, err.message).catch(() => {});
        }
        const canRetry = isRetryableClass(err.errorClass) && attempt <= maxRetries && (idem || !err.sideEffectUnknown);
        await updateStep(stepId, 'error', { error: errorInfo(err), statusText: canRetry ? `${err.message} – neuer Versuch folgt` : err.message, secrets });
        if (canRetry) {
          const delay = err.retryAfterMs ?? backoffMs(attempt, (settingsNode.retryDelaySec ?? 5) * 1000);
          if (delay <= 10_000) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          await saveState(runId, state);
          await pool.query(`UPDATE runs SET summary = $2 WHERE id = $1`, [runId, `${node.name}: Versuch ${attempt + 1} geplant`]);
          await enqueueFollowUp('run.execute', { runId }, new Date(Date.now() + delay), `run:${runId}`);
          return;
        }
        if (settingsNode.onError === 'continue') {
          state.data[node.key] = { fehler: { meldung: err.message, klasse: err.errorClass } };
          state.done[node.id] = { port: 'error', status: 'error' };
          await saveState(runId, state);
          break;
        }
        await saveState(runId, state);
        await finishRun(run, err.sideEffectUnknown && !idem ? 'needs_review' : 'error', err, node.id);
        return;
      }
    }
  }
  await finishRun(run, 'success', null, null);
}

async function finishRun(run: any, status: 'success' | 'error' | 'needs_review', err: StepError | null, nodeId: string | null) {
  const s = await getSettings();
  const replayDays = s['execution.replay_window_days'];
  const retryBlocked =
    status === 'needs_review'
      ? 'Ergebnis der letzten Aktion ist unklar. Vor dem Wiederholen im Zielsystem prüfen, ob sie schon ausgeführt wurde.'
      : null;
  const node = nodeId ? ((await one<any>('SELECT node_name FROM step_runs WHERE run_id = $1 AND node_id = $2 ORDER BY id DESC LIMIT 1', [run.id, nodeId]))?.node_name ?? '') : '';
  const summary = status === 'success' ? 'Erfolgreich abgeschlossen' : `${node ? node + ': ' : ''}${err?.message ?? 'Fehler'}`;
  await pool.query(
    `UPDATE runs SET status = $2, finished_at = now(), duration_ms = (EXTRACT(EPOCH FROM now() - COALESCE(started_at, created_at)) * 1000)::int,
            error_code = $3, error_message = $4, error_node_id = $5, retryable = $6, retry_blocked_reason = $7,
            context_expires_at = now() + make_interval(days => $8), summary = $9
      WHERE id = $1`,
    [run.id, status, err?.errorClass ?? null, err?.message ?? null, nodeId, status !== 'success', retryBlocked, replayDays, summary.slice(0, 500)],
  );
  if (status !== 'success' && run.mode === 'production') {
    await enqueue('notify.run_failed', { runId: run.id }, { maxAttempts: 3 });
  }
  log(status === 'success' ? 'info' : 'warn', 'run', `Lauf #${run.id} (${run.workflow_name}): ${summary}`, { lauf: run.id, status }, run.correlation_id);
}

/** Einzelnen Baustein im Editor testen – ohne Lauf, standardmäßig ohne Seiteneffekte. */
export async function testSingleNode(graph: Graph, nodeId: string, sampleData: Record<string, unknown>, opts: { simulate: boolean; workflowId: string; workflowName: string }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new StepError('config', 'Baustein nicht gefunden.');
  const t = nodeType(node.type);
  if (!t) throw new StepError('config', 'Unbekannter Baustein.');
  const s = await getSettings();
  setTemplateTimeZone(s['general.timezone']);
  const conn = node.connectionId ? await loadRuntimeConnection(node.connectionId) : null;
  const secrets = conn ? Object.values(conn.secrets) : [];
  const state: RunState = { data: sampleData, done: {}, attempts: {}, rootRunId: 0 };
  const fakeRun = { id: 0, mode: 'test', simulate: opts.simulate, correlation_id: newCorrelationId(), started_at: new Date(), workflow_id: opts.workflowId };
  const ctx = buildContext(fakeRun, node, state, conn, (node.settings?.timeoutSec ?? 30) * 1000, 1, opts.workflowName);
  ctx.idempotencyKey = `test:${crypto.randomUUID()}`;
  const started = Date.now();
  try {
    const useSim = opts.simulate && (t.sideEffect || t.type === 'control.wait');
    const fn = useSim ? (t.simulate ?? (async () => ({ output: { simuliert: true } }))) : t.execute;
    const res = await withTimeout(fn(ctx), ctx.timeoutMs);
    return { ok: true, simulated: useSim, durationMs: Date.now() - started, port: res.port ?? 'out', output: preview(res.output, secrets), statusText: res.statusText ?? null };
  } catch (e) {
    const err = toStepError(e);
    return { ok: false, simulated: false, durationMs: Date.now() - started, error: errorInfo(err) };
  }
}
