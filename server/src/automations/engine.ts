import crypto from 'node:crypto';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { audit, type Actor } from '../lib/audit.js';
import { StepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { getSettings, type Settings } from '../lib/settings.js';
import { bannerHash, enqueueBannerJob } from '../routes/banners.js';
import { revisionHash } from '../routes/posts.js';
import { warningHash } from '../routes/warnings.js';
import { classifySmtpError, smtpTransport } from '../warnings/mail.js';
import { OUTPUT_KINDS, type NodeType } from './catalog.js';
import { graphHash, inputFields, topoOrder, type Graph, type GraphNode, type InputRef, type OutputRef } from './graph.js';
import { dedupKey, evaluateGroup, redactForLog, renderTemplate, valueText, type Data, type Group } from './logic.js';

/*
 * Ausführung von Automationen als Auftrag in der Warteschlange (`automation.run`).
 *
 * - Jeder Lauf arbeitet auf einer festen Momentaufnahme (Ablauf + Ein-/Ausgänge der aktiven Version bzw. beim Test des
 *   Entwurfs). Spätere Änderungen wirken erst nach neuem Test und neuer Aktivierung.
 * - Knoten laufen in topologischer Reihenfolge; ein Knoten läuft, wenn mindestens ein eingehender Weg aktiv ist.
 * - Je Lauf und Knoten genau ein Schritt (automation_steps). Wiederholung und Fortsetzung (Warten, Freigabe)
 *   überspringen erledigte Schritte; Ausgänge schreiben ihr Ergebnis und den Schritt in derselben Transaktion – ein Lauf
 *   legt nie denselben Entwurf oder dasselbe Banner zweimal an.
 * - Testläufe (mode = test) legen nichts an und senden nichts: Ausgänge beschreiben nur, was sie tun würden.
 */

export interface Snapshot extends Graph {
  refs: { inputs: Record<string, InputRef>; outputs: Record<string, OutputRef> };
}

/** Dauerhafter Fehler: kein automatischer neuer Versuch. */
export class PermanentError extends Error {}

const TERMINAL = ['succeeded', 'failed', 'canceled', 'limited'];

/** Prüfsumme aus Ablauf und den Einstellungen aller verwendeten Ein- und Ausgänge. */
export function snapshotHash(s: Snapshot): string {
  const refs = Object.fromEntries(
    [...Object.entries(s.refs.inputs).map(([k, v]) => [`i:${k}`, [v.kind, v.config]]), ...Object.entries(s.refs.outputs).map(([k, v]) => [`o:${k}`, [v.kind, v.config]])].sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  return crypto.createHash('sha256').update(`${graphHash(s)}|${JSON.stringify(refs)}`).digest('hex');
}

/** Alle Ein- und Ausgänge (auch gelöschte, für Hinweise). */
export async function loadRefs(db: Queryable = pool): Promise<{ inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }> {
  const ins = await many<any>(`SELECT id, name, kind, config, archived_at FROM automation_inputs`, [], db);
  const outs = await many<any>(`SELECT id, name, kind, config, archived_at FROM automation_outputs`, [], db);
  return {
    inputs: new Map(ins.map((r) => [r.id, { id: r.id, name: r.name, kind: r.kind, config: r.config ?? {}, archived: !!r.archived_at }])),
    outputs: new Map(outs.map((r) => [r.id, { id: r.id, name: r.name, kind: r.kind, config: r.config ?? {}, archived: !!r.archived_at }])),
  };
}

/** Momentaufnahme eines Ablaufs mit genau den verwendeten Ein- und Ausgängen. */
export function buildSnapshot(g: Graph, refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }): Snapshot {
  const inputs: Record<string, InputRef> = {};
  const outputs: Record<string, OutputRef> = {};
  for (const n of g.nodes) {
    if (n.type === 'input' && refs.inputs.has(n.data?.inputId)) inputs[n.data.inputId] = refs.inputs.get(n.data.inputId)!;
    if (n.type === 'output' && refs.outputs.has(n.data?.outputId)) outputs[n.data.outputId] = refs.outputs.get(n.data.outputId)!;
  }
  return { nodes: g.nodes, edges: g.edges, refs: { inputs, outputs } };
}

const actorFor = (name: string): Actor => ({ id: null, name: `Automation „${name}“`, type: 'system' });

/* ------------------------------------------------------------------ Läufe anlegen */

export interface NewRun {
  automationId: string;
  version: number | null;
  mode: 'live' | 'test';
  trigger: 'event' | 'schedule' | 'manual' | 'test';
  inputNode: string;
  eventKey?: string | null;
  snapshot: Snapshot;
  directAllowed?: boolean;
  payload: Data;
  createdBy?: string | null;
  runAt?: Date;
}

/**
 * Lauf anlegen und (live) als Auftrag einplanen. Gleiches Ereignis je Automation nur einmal (eindeutiger Index auf
 * event_key). Grenze je Automation und Minute: darüber wird ein Lauf mit Status „limited“ protokolliert (höchstens einer
 * je Minute) und die Verwaltung benachrichtigt. Rückgabe: Lauf-ID oder null (Duplikat bzw. Grenze).
 */
export async function createRun(r: NewRun, db: Queryable = pool): Promise<string | null> {
  if (r.mode === 'live') {
    const s = await getSettings();
    const recent = await one<{ n: number; limited: number }>(
      `SELECT count(*) FILTER (WHERE status <> 'limited')::int AS n, count(*) FILTER (WHERE status = 'limited')::int AS limited
         FROM automation_runs WHERE automation_id = $1 AND mode = 'live' AND created_at > now() - interval '1 minute'`,
      [r.automationId],
      db,
    );
    if (recent!.n >= s['automations.max_runs_per_minute']) {
      if (!recent!.limited) {
        await db.query(
          `INSERT INTO automation_runs (automation_id, version, mode, trigger, input_node, status, graph, graph_hash, payload, error, finished_at)
           VALUES ($1,$2,'live',$3,$4,'limited',$5,$6,'{}',$7, now())`,
          [r.automationId, r.version, r.trigger, r.inputNode, JSON.stringify({ nodes: [], edges: [], refs: { inputs: {}, outputs: {} } }), '', `Grenze von ${s['automations.max_runs_per_minute']} Läufen je Minute erreicht – weitere Ereignisse in dieser Minute wurden verworfen.`],
        );
        await notify({ kind: 'warning', title: 'Automation: zu viele Läufe', body: `Eine Automation wurde in einer Minute mehr als ${s['automations.max_runs_per_minute']}-mal ausgelöst. Weitere Ereignisse wurden verworfen. Bitte Bedingungen und Eingänge prüfen.`, link: `/automationen/${r.automationId}`, permission: 'automation.manage' });
      }
      return null;
    }
  }
  const row = await one<{ id: string }>(
    `INSERT INTO automation_runs (automation_id, version, mode, trigger, input_node, event_key, graph, graph_hash, direct_allowed, payload, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (automation_id, event_key) WHERE event_key IS NOT NULL AND mode = 'live' DO NOTHING RETURNING id`,
    [r.automationId, r.version, r.mode, r.trigger, r.inputNode, r.eventKey ?? null, JSON.stringify(r.snapshot), snapshotHash(r.snapshot), !!r.directAllowed, JSON.stringify(r.payload), r.createdBy ?? null],
    db,
  );
  if (!row) return null;
  if (r.mode === 'live') await enqueue('automation.run', { runId: row.id }, { dedupKey: `automation.run:${row.id}`, maxAttempts: 4, runAt: r.runAt }, db);
  return row.id;
}

/* ------------------------------------------------------------------ Ausführung */

interface StepRow {
  node_id: string;
  status: string;
  ports: string[];
  output: any;
  attempts: number;
  info: string | null;
}

interface Ctx {
  run: any;
  snap: Snapshot;
  settings: Settings;
  test: boolean;
  direct: boolean;
  actor: Actor;
  tz: string;
}

interface Result {
  ports: string[];
  produced?: Data;
  info?: string;
  log?: unknown;
}

type Pause = { pause: true };

async function upsertStep(db: Queryable, runId: string, node: GraphNode, f: { status: string; ports?: string[]; input?: unknown; output?: unknown; info?: string | null; error?: string | null; started?: number; attempt?: boolean }) {
  const dur = f.started ? Date.now() - f.started : null;
  await db.query(
    `INSERT INTO automation_steps (run_id, node_id, node_type, status, ports, input, output, info, error, attempts, finished_at, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $4 IN ('done','skipped','failed','unknown') THEN now() END, $11)
     ON CONFLICT (run_id, node_id) DO UPDATE SET status = EXCLUDED.status, ports = EXCLUDED.ports,
       input = COALESCE(EXCLUDED.input, automation_steps.input), output = COALESCE(EXCLUDED.output, automation_steps.output),
       info = COALESCE(EXCLUDED.info, automation_steps.info), error = EXCLUDED.error,
       attempts = automation_steps.attempts + $10, finished_at = EXCLUDED.finished_at,
       duration_ms = COALESCE(EXCLUDED.duration_ms, automation_steps.duration_ms)`,
    [
      runId,
      node.id,
      node.type,
      f.status,
      f.ports ?? [],
      f.input === undefined ? null : JSON.stringify(redactForLog(f.input)),
      f.output === undefined ? null : JSON.stringify(f.output),
      f.info ?? null,
      f.error ? f.error.slice(0, 1000) : null,
      f.attempt ? 1 : 0,
      dur,
    ],
  );
}

async function finishRun(runId: string, status: 'succeeded' | 'failed' | 'canceled', error: string | null = null, db: Queryable = pool) {
  await db.query(`UPDATE automation_runs SET status = $2, error = $3, finished_at = now(), resume_at = NULL WHERE id = $1 AND status NOT IN ('succeeded','failed','canceled','limited')`, [runId, status, error ? error.slice(0, 1000) : null]);
}

/** Lauf fortsetzen (nach Warten oder Freigabe) – eigener Auftrag je Fortsetzung, die Sperre je Lauf verhindert Parallelität. */
export async function resumeRun(runId: string, db: Queryable = pool, runAt?: Date) {
  await enqueue('automation.run', { runId }, { dedupKey: `automation.run:${runId}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`, maxAttempts: 8, runAt }, db);
}

/**
 * Einen Lauf ausführen bzw. fortsetzen. `job` ist der Warteschlangen-Auftrag (fehlt bei Testläufen, die direkt in der
 * Anfrage laufen). Vorübergehende Fehler werfen weiter (Wiederholung mit Backoff), solange Versuche übrig sind.
 * Je Lauf arbeitet höchstens ein Prozess (Advisory-Lock auf einer eigenen Verbindung; ein Absturz gibt ihn frei).
 */
export async function executeRun(runId: string, job?: { attempts: number; max_attempts: number }): Promise<string> {
  const lock = await pool.connect();
  try {
    const got = (await lock.query(`SELECT pg_try_advisory_lock(74210100, hashtext($1)) AS ok`, [runId])).rows[0].ok;
    if (!got) throw new StepError('transient', 'Der Lauf wird gerade schon ausgeführt.', { retryAfterMs: 15_000 });
    try {
      return await executeLocked(runId, job);
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(74210100, hashtext($1))`, [runId]).catch(() => {});
    }
  } finally {
    lock.release();
  }
}

async function executeLocked(runId: string, job?: { attempts: number; max_attempts: number }): Promise<string> {
  const run = await one<any>(
    `SELECT r.*, a.name AS automation_name, a.status AS automation_status, a.direct_publish AS automation_direct, a.deleted_at AS automation_deleted
       FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.id = $1`,
    [runId],
  );
  if (!run || TERMINAL.includes(run.status)) return run?.status ?? 'missing';
  const settings = await getSettings();
  const test = run.mode === 'test';
  if (!test) {
    if (!settings['automations.enabled']) return cancelRun(run, 'Automationen sind unter Einstellungen → Automationen abgeschaltet.');
    if (run.automation_status !== 'active' || run.automation_deleted) return cancelRun(run, 'Die Automation wurde deaktiviert.');
  }
  await pool.query(`UPDATE automation_runs SET status = 'running', started_at = COALESCE(started_at, now()), resume_at = NULL WHERE id = $1`, [runId]);
  const snap = run.graph as Snapshot;
  const ctx: Ctx = {
    run,
    snap,
    settings,
    test,
    // Direktveröffentlichung nur, wenn die Version damit aktiviert wurde UND die Automation sie jetzt noch darf (Notbremse)
    direct: !test && !!run.direct_allowed && !!run.automation_direct,
    actor: actorFor(run.automation_name),
    tz: settings['general.timezone'] || 'Europe/Berlin',
  };
  const order = topoOrder(snap);
  if (!order) {
    await finishRun(runId, 'failed', 'Der Ablauf enthält einen Kreis.');
    return 'failed';
  }
  const steps = new Map((await many<StepRow>(`SELECT node_id, status, ports, output, attempts, info FROM automation_steps WHERE run_id = $1`, [runId])).map((s) => [s.node_id, s]));
  const results = new Map<string, { ports: string[]; data: Data }>();
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const payload = await refreshPayload(run, snap);
  /** Knoten, die in diesem Lauf ausgeführt wurden (für „nicht erreicht“) */
  const reached = new Set<string>();

  for (const nid of order) {
    const node = byId.get(nid)!;
    const prev = steps.get(nid);
    let data: Data;
    if (node.type === 'input') {
      if (nid !== run.input_node) {
        results.set(nid, { ports: [], data: {} });
        continue;
      }
      data = { automation: run.automation_name, lauf: String(run.id).slice(0, 8), jetzt: new Date(run.created_at).toISOString(), ...payload };
    } else {
      const active = snap.edges.filter((e) => e.target === nid && results.get(e.source)?.ports.includes(e.sourceHandle ?? 'out'));
      if (!active.length) {
        // Nicht erreicht (anderer Zweig) – nur protokollieren, wenn ein Vorgänger gelaufen ist
        const touched = snap.edges.some((e) => e.target === nid && reached.has(e.source));
        if (!prev && touched) await upsertStep(pool, runId, node, { status: 'skipped', info: 'Nicht erreicht (anderer Zweig oder Doppel).' });
        results.set(nid, { ports: [], data: {} });
        continue;
      }
      data = Object.assign({}, ...active.map((e) => results.get(e.source)!.data));
    }
    reached.add(nid);
    if (prev?.status === 'done' || prev?.status === 'skipped') {
      results.set(nid, { ports: prev.ports ?? [], data: { ...data, ...(pureProduced(node, data, ctx) ?? prev.output?.produced ?? {}) } });
      continue;
    }
    const started = Date.now();
    try {
      const r = await runNode(ctx, node, data, prev);
      if ('pause' in r) return 'waiting';
      results.set(nid, { ports: r.ports, data: { ...data, ...(r.produced ?? {}) } });
    } catch (e) {
      const err = e as Error;
      const permanent = e instanceof PermanentError || test || !job || job.attempts >= job.max_attempts;
      await upsertStep(pool, runId, node, { status: 'failed', input: data, error: err.message, started, attempt: true });
      if (permanent) {
        await finishRun(runId, 'failed', `${nodeTitle(ctx, node)}: ${err.message}`);
        if (!test) await notifyFailure(run, nodeTitle(ctx, node), err.message);
        return 'failed';
      }
      log('warn', 'automation', `Lauf ${String(runId).slice(0, 8)} („${run.automation_name}“), ${nodeTitle(ctx, node)}: ${err.message} – wird wiederholt`);
      throw err;
    }
  }
  await finishRun(runId, 'succeeded');
  if (test) {
    // Erfolgreicher Test genau dieses Entwurfs (Prüfsumme über Ablauf und verwendete Ein-/Ausgänge)
    await pool.query(`UPDATE automations SET tested_hash = $2, tested_at = now(), tested_by = $3 WHERE id = $1`, [run.automation_id, run.graph_hash, run.created_by]);
  }
  return 'succeeded';
}

async function cancelRun(run: any, why: string) {
  await finishRun(run.id, 'canceled', why);
  await pool.query(`UPDATE automation_approvals SET status = 'canceled' WHERE run_id = $1 AND status = 'pending'`, [run.id]);
  return 'canceled';
}

async function notifyFailure(run: any, where: string, msg: string) {
  await notify({ kind: 'error', title: `Automation „${run.automation_name}“ fehlgeschlagen`.slice(0, 200), body: `${where}: ${msg}`.slice(0, 500), link: `/automationen/${run.automation_id}?lauf=${run.id}`, permission: 'automation.manage' }).catch(() => {});
  log('warn', 'automation', `Lauf ${String(run.id).slice(0, 8)} („${run.automation_name}“) fehlgeschlagen: ${where}: ${msg}`);
}

function nodeTitle(ctx: Ctx, n: GraphNode): string {
  if (n.data?.label) return `„${n.data.label}“`;
  if (n.type === 'output') return `Ausgang „${ctx.snap.refs.outputs[n.data.outputId]?.name ?? '?'}“`;
  if (n.type === 'input') return `Eingang „${ctx.snap.refs.inputs[n.data.inputId]?.name ?? '?'}“`;
  return n.type;
}

/** Felder, die reine Knoten erzeugen (bei Fortsetzung neu berechnet statt aus dem gekürzten Protokoll gelesen). */
function pureProduced(node: GraphNode, data: Data, ctx: Ctx): Data | null {
  if (node.type !== 'template') return null;
  const out: Data = {};
  for (const f of node.data.fields as { key: string; template: string }[]) out[f.key] = renderTemplate(f.template, { ...data, ...out }, { timeZone: ctx.tz, maxLength: 5000 }).text;
  return out;
}

/** Bündel neuer Uploads: Anzahl erst beim Lauf (Ende des Zeitfensters) zählen. */
async function refreshPayload(run: any, snap: Snapshot): Promise<Data> {
  const p: Data = { ...(run.payload ?? {}) };
  const node = snap.nodes.find((n) => n.id === run.input_node);
  const inp = node ? snap.refs.inputs[node.data?.inputId] : null;
  if (inp?.kind === 'upload' && p._collection_id && p._since) {
    const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE collection_id = $1 AND upload_link_id IS NOT NULL AND status = 'ready' AND deleted_at IS NULL AND created_at >= $2`, [p._collection_id, p._since]);
    p.anzahl = String(r?.n ?? p.anzahl ?? 0);
  }
  for (const k of Object.keys(p)) if (k.startsWith('_')) delete p[k];
  return p;
}

async function runNode(ctx: Ctx, node: GraphNode, data: Data, prev: StepRow | undefined): Promise<Result | Pause> {
  const started = Date.now();
  const runId = ctx.run.id;
  const done = async (r: Result, db: Queryable = pool) => {
    await upsertStep(db, runId, node, { status: 'done', ports: r.ports, input: data, output: { produced: r.produced ?? {}, ...(r.log !== undefined ? { log: redactForLog(r.log) } : {}) }, info: r.info ?? null, started, attempt: !prev || prev.status === 'failed' });
    return r;
  };
  switch (node.type as NodeType) {
    case 'input':
    case 'merge':
      return done({ ports: ['out'] });
    case 'condition': {
      const ok = evaluateGroup(node.data as Group, data);
      return done({ ports: [ok ? 'true' : 'false'], info: ok ? 'Bedingung trifft zu.' : 'Bedingung trifft nicht zu.' });
    }
    case 'switch': {
      const v = valueText(data[node.data.field], ctx.tz).trim().toLocaleLowerCase('de-DE');
      const hit = (node.data.cases as { id: string; value: string }[]).find((c) => c.value.trim().toLocaleLowerCase('de-DE') === v);
      return done({ ports: [hit ? `case:${hit.id}` : 'default'], info: hit ? `Wert „${hit.value}“` : 'Kein Fall passt – „sonst“.' });
    }
    case 'template': {
      const produced = pureProduced(node, data, ctx)!;
      const missing = (node.data.fields as { template: string }[]).flatMap((f) => renderTemplate(f.template, data).missing);
      return done({ ports: ['out'], produced, log: produced, info: missing.length ? `Leere Felder: ${[...new Set(missing)].join(', ')}` : undefined });
    }
    case 'delay': {
      const minutes = Number(node.data.minutes);
      if (ctx.test) return done({ ports: ['out'], info: `Testlauf: würde ${minutes} Minute(n) warten.` });
      if (prev?.status === 'waiting') {
        const until = new Date(prev.output?.until ?? 0).getTime();
        if (until > Date.now() + 1000) {
          // Zu früh fortgesetzt (z. B. durch eine Freigabe in einem anderen Zweig): Wartezeit einhalten
          await pool.query(`UPDATE automation_runs SET status = 'waiting', resume_at = $2 WHERE id = $1`, [runId, new Date(until)]);
          return { pause: true };
        }
        return done({ ports: ['out'], info: `${minutes} Minute(n) gewartet.` });
      }
      const until = new Date(Date.now() + minutes * 60_000);
      await tx(async (db) => {
        await upsertStep(db, runId, node, { status: 'waiting', input: data, output: { until: until.toISOString() }, info: `Wartet ${minutes} Minute(n).`, attempt: true });
        await db.query(`UPDATE automation_runs SET status = 'waiting', resume_at = $2 WHERE id = $1`, [runId, until]);
        await resumeRun(runId, db, until);
      });
      return { pause: true };
    }
    case 'dedup': {
      const key = dedupKey(ctx.run.automation_id, node.id, node.data.fields, data);
      const windowMin = Number(node.data.windowMinutes);
      if (ctx.test) {
        const seen = await one(`SELECT 1 FROM automation_dedup WHERE automation_id = $1 AND node_id = $2 AND key_hash = $3 AND expires_at > now()`, [ctx.run.automation_id, node.id, key]);
        return done({ ports: seen ? [] : ['out'], info: seen ? 'Testlauf: wäre als Doppel verworfen worden.' : 'Testlauf: erster Lauf für diesen Schlüssel.' });
      }
      return tx(async (db) => {
        const r = await db.query(
          `INSERT INTO automation_dedup (automation_id, node_id, key_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))
           ON CONFLICT (automation_id, node_id, key_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at WHERE automation_dedup.expires_at <= now()`,
          [ctx.run.automation_id, node.id, key, windowMin],
        );
        const first = (r.rowCount ?? 0) > 0;
        return done({ ports: first ? ['out'] : [], info: first ? `Erster Lauf für diesen Schlüssel (${windowMin} min).` : 'Doppelt im Zeitfenster – Lauf endet hier.' }, db);
      });
    }
    case 'approval': {
      const title = renderTemplate(node.data.title || 'Freigabe für {{automation}}', data, { timeZone: ctx.tz, maxLength: 200 }).text || `Freigabe für ${ctx.run.automation_name}`;
      const summary = renderTemplate(node.data.summary, data, { timeZone: ctx.tz, maxLength: 1000 }).text;
      if (ctx.test) return done({ ports: ['approved'], info: `Testlauf: würde die Freigabe „${title}“ anfordern und mit „freigegeben“ weitermachen.` });
      return awaitApproval(ctx, node, data, prev, { kind: 'approval', title, summary, hours: Number(node.data.timeoutHours) }, async (decision, note) =>
        done({ ports: [decision === 'approved' ? 'approved' : 'rejected'], info: decision === 'approved' ? `Freigegeben${note ? `: ${note}` : ''}` : decision === 'expired' ? 'Frist abgelaufen – gilt als abgelehnt.' : `Abgelehnt${note ? `: ${note}` : ''}` }),
      );
    }
    case 'output':
      return runOutput(ctx, node, data, prev, done);
    default:
      throw new PermanentError(`Unbekannter Knotentyp ${node.type}.`);
  }
}

/**
 * Freigabe abwarten: legt beim ersten Erreichen die Freigabe an (Benachrichtigung an „Fassungen freigeben“) und hält
 * den Lauf an; nach der Entscheidung (oder Ablauf der Frist) geht es mit `then` weiter.
 */
async function awaitApproval(
  ctx: Ctx,
  node: GraphNode,
  data: Data,
  prev: StepRow | undefined,
  a: { kind: 'approval' | 'mail'; title: string; summary: string; hours: number },
  then: (decision: 'approved' | 'rejected' | 'expired', note: string) => Promise<Result>,
): Promise<Result | Pause> {
  const runId = ctx.run.id;
  if (prev?.status === 'waiting') {
    const ap = await one<any>(`SELECT status, note FROM automation_approvals WHERE run_id = $1 AND node_id = $2`, [runId, node.id]);
    if (!ap || ap.status === 'pending') {
      await pool.query(`UPDATE automation_runs SET status = 'waiting' WHERE id = $1`, [runId]);
      return { pause: true };
    }
    if (ap.status === 'canceled') throw new PermanentError('Die Freigabe wurde abgebrochen.');
    return then(ap.status, ap.note ?? '');
  }
  await tx(async (db) => {
    await db.query(
      `INSERT INTO automation_approvals (automation_id, run_id, node_id, kind, title, summary, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7)) ON CONFLICT (run_id, node_id) DO NOTHING`,
      [ctx.run.automation_id, runId, node.id, a.kind, a.title, a.summary, a.hours],
    );
    await upsertStep(db, runId, node, { status: 'waiting', input: data, info: `Wartet auf Freigabe (höchstens ${a.hours} h).`, attempt: true });
    await db.query(`UPDATE automation_runs SET status = 'waiting', resume_at = now() + make_interval(hours => $2) WHERE id = $1`, [runId, a.hours]);
    await audit(ctx.actor, 'automation.approval_requested', { type: 'automation', id: ctx.run.automation_id, label: a.title }, { lauf: String(runId).slice(0, 8), art: a.kind }, 'ok', db);
  });
  await notify({ kind: 'info', title: `Freigabe erbeten: ${a.title}`.slice(0, 200), body: `Aus der Automation „${ctx.run.automation_name}“.`, link: '/freigaben', permission: 'approval.automation' });
  return { pause: true };
}

/* ------------------------------------------------------------------ Ausgänge */

const TONE_BY_LEVEL = (lvl: unknown): 'info' | 'warning' | 'danger' => {
  const n = Number(String(lvl ?? '').replace(',', '.'));
  if (n >= 3) return 'danger';
  if (n >= 2) return 'warning';
  return 'info';
};

async function usersWithRoles(roles: string[], db: Queryable = pool) {
  if (!roles.length) return [];
  return many<{ id: string; email: string; name: string }>(`SELECT id, email, name FROM users WHERE status = 'active' AND roles && $1::text[]`, [roles], db);
}

async function runOutput(ctx: Ctx, node: GraphNode, data: Data, prev: StepRow | undefined, done: (r: Result, db?: Queryable) => Promise<Result>): Promise<Result | Pause> {
  const out = ctx.snap.refs.outputs[node.data.outputId];
  if (!out) throw new PermanentError('Ausgang fehlt in der Version.');
  const c = out.config ?? {};
  const direct = ctx.direct && !!node.data.direct && OUTPUT_KINDS[out.kind].directCapable;
  const r = (t: string, max: number) => renderTemplate(t, data, { timeZone: ctx.tz, maxLength: max }).text.trim();
  const auditDetails = { lauf: String(ctx.run.id).slice(0, 8), knoten: node.id, direkt: direct };

  switch (out.kind) {
    case 'banner': {
      const title = r(c.title, 120) || ctx.run.automation_name.slice(0, 120);
      const text = r(c.text, 500);
      const tone = c.tone === 'auto' ? TONE_BY_LEVEL(data.stufe) : c.tone;
      const fieldEnd = c.endFromField && data.gueltig_bis && !Number.isNaN(Date.parse(String(data.gueltig_bis))) ? new Date(String(data.gueltig_bis)) : null;
      const ends = fieldEnd && fieldEnd > new Date() ? fieldEnd : new Date(Date.now() + Number(c.durationHours || 6) * 3600_000);
      const link = r(c.linkUrl, 500);
      const linkUrl = /^https:\/\/[^\s]+$/i.test(link) ? link : null;
      const linkText = linkUrl ? r(c.linkText, 60) || null : null;
      const sites = await many<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM wp_sites WHERE id = ANY($1::uuid[])`, [c.siteIds ?? []]);
      const usable = sites.filter((s) => s.status === 'active');
      if (!usable.length) throw new PermanentError('Keine der gewählten Websites ist gekoppelt.');
      const what = direct ? 'direkt veröffentlichen' : c.submit !== false ? 'als Entwurf anlegen und zur Freigabe einreichen' : 'als Entwurf anlegen';
      const desc = { titel: title, text, art: tone, prioritaet: c.priority, ende: ends.toISOString(), link: linkUrl, websites: usable.map((s) => s.name) };
      if (ctx.test) return done({ ports: ['out'], produced: { banner_link: '/banner' }, info: `Testlauf: würde das Banner „${title}“ für ${usable.map((s) => s.name).join(', ')} ${what}.`, log: desc });
      return tx(async (db) => {
        const ids: string[] = [];
        for (const site of usable) {
          const row = { site_id: site.id, title, text, tone, priority: Number(c.priority) || 2, starts_at: new Date(), ends_at: ends, link_url: linkUrl, link_text: linkText };
          const hash = bannerHash(row);
          const b = await one<any>(
            `INSERT INTO banners (site_id, title, text, tone, priority, starts_at, ends_at, link_url, link_text, content_hash, submitted_at, approved_hash, approved_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11 THEN now() END, CASE WHEN $12 THEN $10 END, CASE WHEN $12 THEN now() END) RETURNING *`,
            [site.id, title, text, tone, row.priority, row.starts_at, ends, linkUrl, linkText, hash, c.submit !== false || direct, direct],
            db,
          );
          if (direct) await enqueueBannerJob(db, b, 'upsert', null);
          ids.push(b.id);
          await audit(ctx.actor, direct ? 'automation.banner_published' : 'automation.banner_created', { type: 'banner', id: b.id, label: title }, { ...auditDetails, website: site.name }, 'ok', db);
        }
        return done({ ports: ['out'], produced: { banner_link: '/banner' }, info: `Banner „${title}“ ${direct ? 'direkt veröffentlicht' : c.submit !== false ? 'angelegt und zur Freigabe eingereicht' : 'als Entwurf angelegt'} (${usable.length} Website(s)).`, log: { ...desc, banner: ids } }, db);
      }).then(async (res) => {
        if (!direct && c.submit !== false) await notify({ kind: 'info', title: `Banner zur Freigabe: ${title}`.slice(0, 200), body: `Aus der Automation „${ctx.run.automation_name}“.`, link: '/banner', permission: 'approval.banner' });
        return res;
      });
    }

    case 'post': {
      const title = r(c.title, 200) || ctx.run.automation_name.slice(0, 200);
      const body = r(c.body, 50_000);
      const excerpt = r(c.excerpt, 1000);
      const variants: Record<string, any> = {};
      const wp = { title: r(c.variants?.wordpress?.title ?? '', 200), body: r(c.variants?.wordpress?.body ?? '', 50_000) };
      if (wp.title || wp.body) variants.wordpress = Object.fromEntries(Object.entries(wp).filter(([, v]) => v));
      const fb = r(c.variants?.facebook?.body ?? '', 60_000);
      if (fb) variants.facebook = { body: fb };
      const ig = r(c.variants?.instagram?.body ?? '', 2200);
      if (ig) variants.instagram = { body: ig };
      let site: { id: string; name: string; status: string } | null = null;
      if (c.siteId) site = await one<any>(`SELECT id, name, status FROM wp_sites WHERE id = $1`, [c.siteId]);
      if (direct && (!site || site.status !== 'active')) throw new PermanentError('Direkt veröffentlichen braucht eine gekoppelte Website als Zielkanal.');
      const siteId = site && site.status !== 'revoked' ? site.id : null;
      const submit = (c.submit || direct) && !!body;
      const what = direct ? `direkt auf „${site!.name}“ veröffentlichen` : submit ? 'als Entwurf anlegen und zur Freigabe einreichen' : 'als Entwurf anlegen';
      const desc = { art: c.kind, titel: title, text: body.slice(0, 300), zielkanal: site?.name ?? null };
      if (ctx.test) return done({ ports: ['out'], produced: { beitrag_link: '/beitraege', beitrag_titel: title }, info: `Testlauf: würde den Beitrag „${title}“ ${what}.`, log: desc });
      const res = await tx(async (db) => {
        const p = await one<any>(`INSERT INTO posts (kind, title) VALUES ($1,$2) RETURNING id`, [c.kind || 'news', title], db);
        const rev = { title, body, excerpt, media_ids: [] as string[], cover_id: null, site_id: siteId, variants };
        const hash = revisionHash(rev);
        const rv = await one<any>(
          `INSERT INTO post_revisions (post_id, number, title, body, excerpt, site_id, content_hash, change_note, variants, submitted_at) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END) RETURNING id`,
          [p.id, title, body, excerpt, siteId, hash, `Automatisch aus der Automation „${ctx.run.automation_name}“`, JSON.stringify(variants), submit],
          db,
        );
        if (direct) {
          const a = await one<any>(
            `INSERT INTO approvals (post_id, revision_id, content_hash, decision, note, decided_by) VALUES ($1,$2,$3,'approved',$4,NULL) RETURNING id`,
            [p.id, rv.id, hash, `Automatisch freigegeben: Direktveröffentlichung der Automation „${ctx.run.automation_name}“`.slice(0, 500)],
            db,
          );
          await db.query(`INSERT INTO publications (post_id, revision_id, approval_id, site_id, created_by, run_at) VALUES ($1,$2,$3,$4,NULL, now())`, [p.id, rv.id, a.id, siteId]);
        }
        await audit(ctx.actor, direct ? 'automation.post_published' : 'automation.post_created', { type: 'post', id: p.id, label: title }, { ...auditDetails, website: site?.name ?? null }, 'ok', db);
        return done({ ports: ['out'], produced: { beitrag_link: `/beitraege/${p.id}`, beitrag_titel: title }, info: `Beitrag „${title}“ ${direct ? `direkt an „${site!.name}“ übergeben` : submit ? 'angelegt und zur Freigabe eingereicht' : 'als Entwurf angelegt'}.`, log: { ...desc, beitrag: p.id } }, db);
      });
      if (submit && !direct) await notify({ kind: 'info', title: `Freigabe erbeten: ${title}`.slice(0, 200), body: `Fassung 1 – aus der Automation „${ctx.run.automation_name}“`, link: res.produced?.beitrag_link as string, permission: 'approval.post' });
      else if (!direct) await notify({ kind: 'info', title: `Neuer Beitragsentwurf: ${title}`.slice(0, 200), body: `Aus der Automation „${ctx.run.automation_name}“.`, link: res.produced?.beitrag_link as string, permission: 'post.edit' });
      return res;
    }

    case 'mail': {
      const subject = r(c.subject, 300);
      const body = r(c.body, 10_000);
      const internal = (await usersWithRoles(c.roles ?? [])).map((u) => u.email);
      const resp = c.responsibilityIds?.length ? await many<{ name: string; recipients: string[] }>(`SELECT name, recipients FROM responsibilities WHERE id = ANY($1::uuid[]) AND active`, [c.responsibilityIds]) : [];
      let external = [...new Set(resp.flatMap((x) => x.recipients))];
      const testMode = !!ctx.settings['warnings.test_mode'];
      if (external.length && testMode) {
        const t = String(ctx.settings['warnings.test_recipient'] ?? '').trim();
        if (!t) throw new PermanentError('Testmodus des Mailversands ist an, aber kein Testempfänger eingetragen (Warnentwurf → Einstellungen).');
        external = [t];
      }
      const to = [...new Set([...internal, ...external])];
      if (!to.length) throw new PermanentError('Keine Empfänger gefunden (Rollen ohne aktive Personen, Zuständigkeiten inaktiv).');
      const desc = { betreff: subject, empfaenger: to, intern: internal.length, extern: external.length, testmodus: testMode && external.length > 0 };
      // Interne Empfänger (Konten mit Rollen) sind wie eine Benachrichtigung; externe Empfänger nur nach Freigabe oder Direktversand
      const needsApproval = external.length > 0 && !direct;
      if (ctx.test) {
        return done({ ports: ['out'], info: `Testlauf: würde die E-Mail „${subject}“ an ${to.length} Empfänger senden${needsApproval ? ' – nach Freigabe (externe Empfänger)' : ''}${desc.testmodus ? ' (Testmodus: nur an den Testempfänger)' : ''}.`, log: desc });
      }
      if (prev?.status === 'running' || prev?.status === 'unknown') {
        // Unterbrochener Versand: Ergebnis unklar – nie automatisch erneut senden
        await upsertStep(pool, ctx.run.id, node, { status: 'unknown', error: 'Versand wurde unterbrochen – Ergebnis unbekannt. Bitte beim Mailserver bzw. den Empfängern prüfen.' });
        throw new PermanentError('Versand wurde unterbrochen – Ergebnis unbekannt, kein automatischer Neuversand.');
      }
      if (needsApproval && (!prev || prev.status === 'waiting')) {
        const gate = await awaitApproval(ctx, node, data, prev, { kind: 'mail', title: `E-Mail-Versand: ${subject}`.slice(0, 200), summary: `An ${external.length} externe und ${internal.length} interne Empfänger (${resp.map((x) => x.name).join(', ')}).\n\n${body.slice(0, 700)}`, hours: 24 }, async (decision, note) => ({ ports: decision === 'approved' ? ['__send'] : [], info: note }));
        if ('pause' in gate) return gate;
        if (!gate.ports.includes('__send')) return done({ ports: [], info: 'Versand nicht freigegeben.' });
      }
      await upsertStep(pool, ctx.run.id, node, { status: 'running', input: data, info: 'Versand läuft …', attempt: true });
      const { transport, from } = await smtpTransport().catch((e) => {
        throw new PermanentError(e.message);
      });
      try {
        // Alle Empfänger als Blindkopie: niemand sieht die anderen Adressen
        await transport.sendMail({ from, bcc: to, subject, text: `${body}\n\n—\nAutomatisch versendet von BlaulichtCMS (Automation „${ctx.run.automation_name}“).`, messageId: `<automation-${ctx.run.id}-${node.id}@blaulichtcms.invalid>` });
      } catch (e: any) {
        const outcome = classifySmtpError(e);
        if (outcome === 'unknown') {
          await upsertStep(pool, ctx.run.id, node, { status: 'unknown', error: `Ergebnis unbekannt: ${e?.message ?? e}` });
          throw new PermanentError(`Versand abgebrochen – Ergebnis unbekannt (${e?.message ?? e}). Kein automatischer Neuversand.`);
        }
        // Sicher nicht angenommen: vorübergehend → neuer Versuch durch die Warteschlange
        await upsertStep(pool, ctx.run.id, node, { status: 'failed', error: String(e?.message ?? e) });
        throw new Error(`Mailserver hat nicht angenommen: ${e?.message ?? e}`);
      } finally {
        transport.close();
      }
      await audit(ctx.actor, 'automation.mail_sent', { type: 'automation', id: ctx.run.automation_id, label: subject }, { ...auditDetails, empfaenger_anzahl: to.length, extern: external.length, testmodus: desc.testmodus });
      return done({ ports: ['out'], info: `E-Mail „${subject}“ an ${to.length} Empfänger übergeben${desc.testmodus ? ' (Testmodus)' : ''}.`, log: desc });
    }

    case 'notify': {
      const title = r(c.title, 200) || ctx.run.automation_name;
      const body = r(c.body, 1000);
      const link = r(c.link, 300);
      const safeLink = /^\/[A-Za-z0-9/_?=&.%-]*$/.test(link) ? link : null;
      const users = [...new Map([...(await usersWithRoles(c.roles ?? [])), ...(c.userIds?.length ? await many<any>(`SELECT id, email, name FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'`, [c.userIds]) : [])].map((u) => [u.id, u])).values()];
      if (ctx.test) return done({ ports: ['out'], info: `Testlauf: würde ${users.length} Person(en) benachrichtigen: „${title}“.`, log: { titel: title, text: body, link: safeLink, personen: users.length } });
      return tx(async (db) => {
        for (const u of users) await db.query('INSERT INTO notifications (kind, title, body, link, user_id) VALUES ($1,$2,$3,$4,$5)', [c.kind === 'warning' ? 'warning' : 'info', title.slice(0, 200), body.slice(0, 1000), safeLink, u.id]);
        return done({ ports: ['out'], info: `${users.length} Person(en) benachrichtigt.`, log: { titel: title, personen: users.length } }, db);
      });
    }

    case 'warning_draft': {
      const t = await one<any>(`SELECT id, fields FROM warning_templates WHERE status = 'active' ORDER BY created_at DESC, version DESC LIMIT 1`);
      if (!t) throw new PermanentError('Es ist keine aktive Warnvorlage vorhanden.');
      const keys = new Set((t.fields as { key: string }[]).map((f) => f.key));
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries((c.data ?? {}) as Record<string, string>)) if (keys.has(k)) values[k] = r(v, 2000);
      const ignored = Object.keys(c.data ?? {}).filter((k) => !keys.has(k));
      const respIds = c.responsibilityIds?.length ? (await many<{ id: string }>(`SELECT id FROM responsibilities WHERE id = ANY($1::uuid[]) AND active`, [c.responsibilityIds])).map((x) => x.id) : [];
      if (ctx.test) return done({ ports: ['out'], produced: { warnentwurf_link: '/warnungen', warnentwurf_nr: 'W-…' }, info: `Testlauf: würde einen Warnentwurf mit ${Object.keys(values).length} vorausgefüllten Feldern vorbereiten${ignored.length ? ` (unbekannte Felder ignoriert: ${ignored.join(', ')})` : ''}.`, log: values });
      const res = await tx(async (db) => {
        const year = new Intl.DateTimeFormat('en', { timeZone: ctx.tz, year: 'numeric' }).format(new Date());
        const seq = (await one<any>(`SELECT nextval('warning_case_seq') AS n`, [], db)).n;
        const caseNo = `W-${year}-${String(seq).padStart(4, '0')}`;
        const w = await one<any>(`INSERT INTO warnings (case_no, kind, template_id) VALUES ($1,'initial',$2) RETURNING id`, [caseNo, t.id], db);
        const rev = { template_id: t.id, kind: 'initial', data: values, responsibility_ids: respIds, keyword: null, answers: {}, level_decision: null };
        await db.query(`INSERT INTO warning_revisions (warning_id, number, data, responsibility_ids, keyword, answers, content_hash) VALUES ($1,1,$2,$3,NULL,'{}',$4)`, [w.id, JSON.stringify(values), respIds, warningHash(rev)]);
        await audit(ctx.actor, 'automation.warning_prepared', { type: 'warning', id: w.id, label: caseNo }, auditDetails, 'ok', db);
        return done({ ports: ['out'], produced: { warnentwurf_link: `/warnungen/${w.id}`, warnentwurf_nr: caseNo }, info: `Warnentwurf ${caseNo} vorbereitet – Warnstufe, Freigabe und Versand bleiben bei Menschen.`, log: values }, db);
      });
      await notify({ kind: 'info', title: `Warnentwurf vorbereitet: ${res.produced?.warnentwurf_nr}`, body: `Aus der Automation „${ctx.run.automation_name}“ – bitte prüfen und ergänzen.`, link: res.produced?.warnentwurf_link as string, permission: 'warning.draft' });
      return res;
    }
  }
  throw new PermanentError(`Unbekannte Art von Ausgang.`);
}

/* ------------------------------------------------------------------ Freigaben und Wartung */

/** Entscheidung über eine Freigabe aus einem Ablauf; setzt den Lauf fort. */
export async function decideApproval(id: string, decision: 'approved' | 'rejected', note: string, actor: Actor, userId: string | null): Promise<void> {
  const a = await tx(async (db) => {
    const ap = await one<any>(`UPDATE automation_approvals SET status = $2, note = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [id, decision, note, userId], db);
    if (!ap) return null;
    await audit(actor, decision === 'approved' ? 'automation.approval_approved' : 'automation.approval_rejected', { type: 'automation', id: ap.automation_id, label: ap.title }, { lauf: String(ap.run_id).slice(0, 8), notiz: note || null }, 'ok', db);
    await resumeRun(ap.run_id, db);
    return ap;
  });
  if (!a) throw new Error('not_pending');
}

/** Worker (Leader): abgelaufene Freigaben schließen und die Läufe fortsetzen. */
export async function expireApprovals(): Promise<number> {
  const rows = await many<any>(`UPDATE automation_approvals SET status = 'expired', decided_at = now() WHERE status = 'pending' AND expires_at < now() RETURNING run_id`);
  for (const r of rows) await resumeRun(r.run_id).catch((e) => log('warn', 'automation', `Fortsetzen nach Fristablauf: ${e.message}`));
  return rows.length;
}

/** Laufende/wartende Läufe einer Automation abbrechen (Deaktivieren, Löschen). */
export async function cancelOpenRuns(automationId: string, why: string, db: Queryable = pool): Promise<number> {
  const r = await db.query(`UPDATE automation_runs SET status = 'canceled', error = $2, finished_at = now(), resume_at = NULL WHERE automation_id = $1 AND mode = 'live' AND status IN ('queued','waiting')`, [automationId, why]);
  await db.query(`UPDATE automation_approvals SET status = 'canceled' WHERE automation_id = $1 AND status = 'pending'`, [automationId]);
  return r.rowCount ?? 0;
}

/** Felder eines Eingangs als Beispieldaten (für Testläufe ohne eigene Eingaben). */
export function examplePayload(input: InputRef): Data {
  const out: Data = {};
  for (const f of inputFields(input)) if (!['automation', 'lauf', 'jetzt'].includes(f.key)) out[f.key] = f.example;
  if (input.kind === 'manual') for (const f of (input.config.fields ?? []) as { key: string; example?: string }[]) out[f.key] = f.example ?? '';
  return out;
}

/** Wer darf über eine Freigabe entscheiden (Vier-Augen: nicht, wer die laufende Version aktiviert oder den Ablauf zuletzt geändert hat)? */
export async function approvalConflict(approvalId: string, userId: string, db: Queryable = pool): Promise<boolean> {
  const r = await one<any>(
    `SELECT a.updated_by, v.activated_by FROM automation_approvals ap JOIN automation_runs r ON r.id = ap.run_id JOIN automations a ON a.id = ap.automation_id
       LEFT JOIN automation_versions v ON v.automation_id = a.id AND v.version = r.version WHERE ap.id = $1`,
    [approvalId],
    db,
  );
  return !!r && [r.updated_by, r.activated_by].includes(userId);
}
