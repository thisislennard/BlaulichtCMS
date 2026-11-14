import { Cron } from 'croner';
import type mqttType from 'mqtt';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { readSecret, revokeSecret, storeSecret } from '../lib/secrets.js';
import { lookup } from '../lib/template.js';
import { preview } from '../lib/mask.js';
import { getSettings } from '../lib/settings.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { normalizeAlarm, normalizeCalendarPush, fetchCalendar, calendarEventHash } from '../connectors/alamos.js';
import { pollImap } from '../connectors/email.js';
import { mqttConnect, topicAllowed } from '../connectors/messaging.js';
import { nodeType } from '../nodes/registry.js';
import { loadRuntimeConnection } from './connections.js';
import { createRun, newCorrelationId } from './executor.js';
import { triggerNode } from './graph.js';
import type { Graph, GraphNode } from './types.js';

/* ------------------------------------ Webhooks -------------------------------------- */

const SIGNATURE_TOLERANCE_SEC = 300;
const SAFE_HEADERS = ['content-type', 'user-agent', 'x-event-id', 'idempotency-key', 'x-request-id', 'x-github-event'];

export function webhookUrl(token: string): string {
  return `/hooks/${token}`;
}

/** Legt (falls nötig) den stabilen Endpunkt eines Webhook-Triggers an. Das Geheimnis wird nur beim Anlegen zurückgegeben. */
export async function ensureWebhookEndpoint(workflowId: string, nodeId: string, authMode: 'hmac' | 'token', userId: string | null, db: Queryable = pool) {
  const existing = await one<any>('SELECT * FROM webhook_endpoints WHERE workflow_id = $1 AND node_id = $2', [workflowId, nodeId], db);
  if (existing) {
    if (existing.auth_mode !== authMode) await db.query('UPDATE webhook_endpoints SET auth_mode = $2 WHERE id = $1', [existing.id, authMode]);
    return { endpoint: { ...existing, auth_mode: authMode }, secret: null as string | null };
  }
  const token = randomToken(24);
  const row = await one<any>(
    `INSERT INTO webhook_endpoints (workflow_id, node_id, token, auth_mode) VALUES ($1,$2,$3,$4) RETURNING *`,
    [workflowId, nodeId, token, authMode],
    db,
  );
  const secret = `whsec_${randomToken(32)}`;
  const meta = await storeSecret('webhook', row.id, secret, userId, db);
  await db.query('UPDATE webhook_endpoints SET secret_id = $2 WHERE id = $1', [row.id, meta.id]);
  return { endpoint: { ...row, secret_id: meta.id }, secret };
}

/** Neues Geheimnis; das alte bleibt 24 Stunden gültig, damit Absender umstellen können. */
export async function rotateWebhookSecret(endpointId: string, userId: string | null, graceHours = 24) {
  return tx(async (db) => {
    const ep = await one<any>('SELECT * FROM webhook_endpoints WHERE id = $1 FOR UPDATE', [endpointId], db);
    if (!ep) return null;
    if (ep.previous_secret_id) await revokeSecret(ep.previous_secret_id, db);
    const secret = `whsec_${randomToken(32)}`;
    const meta = await storeSecret('webhook', ep.id, secret, userId, db);
    await db.query(
      `UPDATE webhook_endpoints SET previous_secret_id = secret_id, previous_valid_until = now() + make_interval(hours => $3), secret_id = $2, status = 'active' WHERE id = $1`,
      [ep.id, meta.id, graceHours],
    );
    return { secret, previousValidHours: graceHours };
  });
}

export interface IncomingRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  rawBody: Buffer;
  ip: string;
}

export interface IncomingResult {
  status: number;
  body: Record<string, unknown>;
}

function header(h: IncomingRequest['headers'], name: string): string {
  const v = h[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

async function verifyWebhookAuth(ep: any, req: IncomingRequest): Promise<string | null> {
  const secrets: string[] = [];
  const cur = await readSecret(ep.secret_id);
  if (cur) secrets.push(cur);
  if (ep.previous_secret_id && ep.previous_valid_until && new Date(ep.previous_valid_until).getTime() > Date.now()) {
    const prev = await readSecret(ep.previous_secret_id);
    if (prev) secrets.push(prev);
  }
  if (!secrets.length) return 'Für diesen Webhook ist kein gültiges Geheimnis hinterlegt.';
  if (ep.auth_mode === 'token') {
    const given = header(req.headers, 'x-lifelink-token') || header(req.headers, 'authorization').replace(/^Bearer\s+/i, '');
    return given && secrets.some((s) => safeEqual(s, given.trim())) ? null : 'Zugriffsschlüssel fehlt oder ist falsch.';
  }
  const ts = Number(header(req.headers, 'x-lifelink-timestamp'));
  const sig = header(req.headers, 'x-lifelink-signature');
  if (!ts || !sig) return 'Signatur-Header fehlen (X-LifeLink-Timestamp, X-LifeLink-Signature).';
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SEC) return 'Zeitstempel außerhalb des erlaubten Fensters (±5 Minuten).';
  const signed = Buffer.concat([Buffer.from(`${ts}.`), req.rawBody]);
  const ok = secrets.some((s) => safeEqual(`v1=${hmacHex(s, signed)}`, sig.trim()));
  if (!ok) return 'Signatur ungültig.';
  // Replay-Schutz: dieselbe Signatur nur einmal
  const res = await pool.query(
    `INSERT INTO webhook_nonces (signature_hash, expires_at) VALUES ($1, now() + interval '15 minutes') ON CONFLICT DO NOTHING RETURNING 1`,
    [sha256Hex(sig)],
  );
  if (!res.rowCount) return 'Diese Anfrage wurde bereits verarbeitet (Wiederholung abgewiesen).';
  return null;
}

function parseBody(req: IncomingRequest): unknown {
  const ct = header(req.headers, 'content-type').toLowerCase();
  const text = req.rawBody.toString('utf8');
  if (!text.trim()) return {};
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  if (ct.includes('json') || /^[\s]*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Ungültiges JSON.'), { statusCode: 400 });
    }
  }
  return { text };
}

/** Eingang eines Webhooks: prüfen, protokollieren, deduplizieren, Lauf einreihen. Antwortet schnell. */
export async function handleIncomingWebhook(token: string, req: IncomingRequest): Promise<IncomingResult> {
  const ep = await one<any>(
    `SELECT e.*, w.name AS workflow_name, w.status AS workflow_status, w.active_version_id, w.listen_until
       FROM webhook_endpoints e JOIN workflows w ON w.id = e.workflow_id WHERE e.token = $1`,
    [token],
  );
  if (!ep || ep.status !== 'active') return { status: 404, body: { error: 'unknown_webhook', message: 'Unbekannte oder widerrufene Adresse.' } };
  if (req.rawBody.length > ep.max_body_kb * 1024) return { status: 413, body: { error: 'too_large', message: `Höchstens ${ep.max_body_kb} KB.` } };
  const authError = await verifyWebhookAuth(ep, req);
  if (authError) {
    log('warn', 'webhook', `Webhook abgewiesen: ${authError}`, { workflow: ep.workflow_name, ip: req.ip });
    return { status: 401, body: { error: 'unauthorized', message: authError } };
  }
  let body: unknown;
  try {
    body = parseBody(req);
  } catch (e) {
    return { status: 400, body: { error: 'invalid_body', message: (e as Error).message } };
  }

  const listening = ep.listen_until && new Date(ep.listen_until).getTime() > Date.now();
  // Graph der aktiven Version (oder Entwurf beim Testempfang) laden
  const ver = ep.active_version_id ? await one<{ graph: Graph; number: number; id: string }>('SELECT id, number, graph FROM workflow_versions WHERE id = $1', [ep.active_version_id]) : null;
  const draft = listening ? await one<{ draft: Graph }>('SELECT draft FROM workflows WHERE id = $1', [ep.workflow_id]) : null;
  const graph = listening ? draft!.draft : ver?.graph;
  const node = graph?.nodes.find((n) => n.id === ep.node_id);
  if (!node) return { status: 409, body: { error: 'not_active', message: 'Workflow ist nicht aktiv.' } };

  const base = {
    body,
    query: req.query ?? {},
    headers: Object.fromEntries(SAFE_HEADERS.map((h) => [h, header(req.headers, h)]).filter(([, v]) => v)),
    received_at: new Date().toISOString(),
  };
  let output: Record<string, unknown> = base;
  let dedupKey: string | null = header(req.headers, 'idempotency-key') || header(req.headers, 'x-event-id') || null;
  let dedupMinutes = 24 * 60;
  let label = 'Webhook';
  if (node.type === 'alamos.alarm') {
    const kind = node.config.kind ?? 'alarm';
    output = kind === 'calendar' ? normalizeCalendarPush(body) : normalizeAlarm(body);
    label = kind === 'calendar' ? `Termin ${String(output.titel ?? '')}`.trim() : `Einsatz ${String(output.stichwort ?? '')}`.trim();
    const id = kind === 'calendar' ? output.termin_id : output.einsatz_id;
    dedupKey = id ? `${kind}:${id}` : dedupKey;
    dedupMinutes = Number(node.config.dedupMinutes ?? 30);
    // Filter schon beim Eingang: unpassende Einsätze erzeugen keinen Lauf
    const kw = String(node.config.keywordFilter ?? '').trim();
    if (kind === 'alarm' && kw && !listening) {
      const st = String(output.stichwort ?? '').toLowerCase();
      const ok = kw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((x) => st.startsWith(x));
      if (!ok) return { status: 202, body: { ok: true, ignored: true, reason: 'Stichwort nicht im Filter' } };
    }
    const cal = String(node.config.calendarFilter ?? '').trim().toLowerCase();
    if (kind === 'calendar' && cal && String(output.kalender ?? '').toLowerCase() !== cal && !listening) {
      return { status: 202, body: { ok: true, ignored: true, reason: 'Anderer Kalender' } };
    }
  } else if (node.config.dedupPath) {
    const v = lookup(output, String(node.config.dedupPath).split('.'));
    if (v != null && v !== '') dedupKey = String(v);
  }

  if (listening) {
    await pool.query('UPDATE workflows SET sample_event = $2, listen_until = NULL WHERE id = $1', [ep.workflow_id, JSON.stringify({ nodeId: node.id, data: output, received_at: new Date().toISOString() })]);
    await pool.query('UPDATE webhook_endpoints SET last_received_at = now(), received_count = received_count + 1 WHERE id = $1', [ep.id]);
    return { status: 202, body: { ok: true, test: true, message: 'Testereignis empfangen.' } };
  }
  if (ep.workflow_status !== 'active' || !ver) return { status: 409, body: { error: 'not_active', message: 'Workflow ist nicht aktiv.' } };

  const correlationId = header(req.headers, 'x-correlation-id').slice(0, 100) || newCorrelationId();
  const result = await tx(async (db) => {
    let duplicate = false;
    if (dedupKey) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ep.workflow_id}:${node.id}:${dedupKey}`]);
      const prev = await one(
        `SELECT id FROM event_receipts WHERE workflow_id = $1 AND node_id = $2 AND dedup_key = $3 AND duplicate = false
           AND received_at > now() - make_interval(mins => $4) LIMIT 1`,
        [ep.workflow_id, node.id, dedupKey, Math.max(1, dedupMinutes)],
        db,
      );
      duplicate = !!prev;
    }
    const ev = await one<{ id: number }>(
      `INSERT INTO event_receipts (workflow_id, node_id, source, dedup_key, correlation_id, payload_preview, duplicate)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ep.workflow_id, node.id, node.type, dedupKey, correlationId, JSON.stringify(preview(output)), duplicate],
      db,
    );
    await db.query('UPDATE webhook_endpoints SET last_received_at = now(), received_count = received_count + 1 WHERE id = $1', [ep.id]);
    await db.query('UPDATE trigger_bindings SET last_event_at = now() WHERE workflow_id = $1 AND node_id = $2', [ep.workflow_id, node.id]);
    return { eventId: ev!.id, duplicate };
  });
  if (result.duplicate) return { status: 202, body: { ok: true, duplicate: true, event_id: result.eventId, correlation_id: correlationId } };
  const runId = await createRun({
    workflowId: ep.workflow_id,
    versionId: ver.id,
    versionNumber: ver.number,
    graph: ver.graph,
    mode: 'production',
    simulate: false,
    triggerKind: node.type,
    triggerLabel: label,
    triggerOutput: output,
    eventId: result.eventId,
    correlationId,
  });
  return { status: 202, body: { ok: true, event_id: result.eventId, run_id: runId, correlation_id: correlationId } };
}

/* ------------------------------ Aktivieren / Deaktivieren ---------------------------- */

export function nextScheduleRun(cfg: Record<string, any>, tz: string, from: Date): Date | null {
  const zone = cfg.timezone || tz;
  if (cfg.mode === 'interval') {
    const ms = Math.max(1, Number(cfg.intervalMinutes ?? 15)) * 60_000;
    return new Date(Math.floor(from.getTime() / ms) * ms + ms);
  }
  let pattern: string;
  if (cfg.mode === 'cron') pattern = String(cfg.cron ?? '').trim();
  else {
    const [h, m] = String(cfg.time ?? '07:00').split(':').map(Number);
    pattern = cfg.mode === 'weekly' ? `${m} ${h} * * ${(cfg.weekdays ?? ['1']).join(',')}` : `${m} ${h} * * *`;
  }
  try {
    return new Cron(pattern, { timezone: zone, paused: true }).nextRun(from) ?? null;
  } catch {
    return null;
  }
}

export function validateSchedule(cfg: Record<string, any>, tz: string): string | null {
  return nextScheduleRun(cfg, tz, new Date()) ? null : 'Zeitplan ergibt keinen gültigen nächsten Termin (Cron-Ausdruck prüfen).';
}

/** Erzeugt die Trigger-Bindung der veröffentlichten Version (in derselben Transaktion wie die Aktivierung). */
/** Gibt bei neu angelegtem Webhook-Endpunkt einmalig dessen Geheimnis zurück. */
export async function activateBinding(db: Queryable, workflowId: string, versionId: string, graph: Graph, userId: string | null): Promise<{ webhookSecret: string | null; webhookPath: string | null }> {
  await db.query('DELETE FROM trigger_bindings WHERE workflow_id = $1', [workflowId]);
  const trig = triggerNode(graph);
  if (!trig) return { webhookSecret: null, webhookPath: null };
  const t = nodeType(trig.type)!;
  const s = await getSettings();
  let next: Date | null = null;
  if (t.trigger === 'schedule') next = nextScheduleRun(trig.config, s['general.timezone'], new Date());
  if (t.trigger === 'imap' || t.trigger === 'ics') next = new Date();
  await db.query(
    `INSERT INTO trigger_bindings (workflow_id, version_id, node_id, kind, config, next_run_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [workflowId, versionId, trig.id, t.trigger, JSON.stringify({ ...trig.config, connectionId: trig.connectionId ?? null }), next],
  );
  let webhookSecret: string | null = null;
  let webhookPath: string | null = null;
  if (t.trigger === 'webhook') {
    const res = await ensureWebhookEndpoint(workflowId, trig.id, trig.type === 'alamos.alarm' ? 'token' : (trig.config.authMode ?? 'hmac'), userId, db);
    const kb = Math.min(5120, Math.max(1, Number(trig.config.maxBodyKb ?? 256) || 256));
    await db.query('UPDATE webhook_endpoints SET max_body_kb = $2 WHERE id = $1', [res.endpoint.id, kb]);
    webhookSecret = res.secret;
    webhookPath = webhookUrl(res.endpoint.token);
  }
  await db.query(`SELECT pg_notify('lifelink_bindings', $1)`, [workflowId]);
  return { webhookSecret, webhookPath };
}

export async function deactivateBinding(db: Queryable, workflowId: string) {
  await db.query('DELETE FROM trigger_bindings WHERE workflow_id = $1', [workflowId]);
  await db.query(`SELECT pg_notify('lifelink_bindings', $1)`, [workflowId]);
}

/* ---------------------------------- Zeitgesteuert ----------------------------------- */

async function versionFor(workflowId: string) {
  return one<{ id: string; number: number; graph: Graph; name: string }>(
    `SELECT v.id, v.number, v.graph, w.name FROM workflows w JOIN workflow_versions v ON v.id = w.active_version_id WHERE w.id = $1 AND w.status = 'active'`,
    [workflowId],
  );
}

async function startFromBinding(b: any, node: GraphNode, output: unknown, label: string, dedupKey: string | null) {
  const ver = await versionFor(b.workflow_id);
  if (!ver) return;
  const ev = await one<{ id: number }>(
    `INSERT INTO event_receipts (workflow_id, node_id, source, dedup_key, correlation_id, payload_preview) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [b.workflow_id, node.id, node.type, dedupKey, newCorrelationId(), JSON.stringify(preview(output))],
  );
  await createRun({ workflowId: b.workflow_id, versionId: ver.id, versionNumber: ver.number, graph: ver.graph, mode: 'production', simulate: false, triggerKind: node.type, triggerLabel: label, triggerOutput: output, eventId: ev!.id });
}

/** Fällige Zeitpläne und Abfragen (IMAP, iCal) ausführen. Läuft im Worker alle paar Sekunden. */
export async function runDueBindings(): Promise<number> {
  const s = await getSettings();
  const due = await many<any>(
    `SELECT b.* FROM trigger_bindings b WHERE b.next_run_at <= now() AND b.kind IN ('schedule','imap','ics') ORDER BY b.next_run_at LIMIT 20`,
  );
  let count = 0;
  for (const cand of due) {
    // Bindung exklusiv sperren, damit mehrere Worker nicht doppelt starten
    const claimed = await tx(async (db) => {
      const b = await one<any>('SELECT * FROM trigger_bindings WHERE id = $1 AND next_run_at <= now() FOR UPDATE SKIP LOCKED', [cand.id], db);
      if (!b) return null;
      let next: Date | null;
      if (b.kind === 'schedule') {
        next = nextScheduleRun(b.config, s['general.timezone'], new Date());
      } else {
        next = new Date(Date.now() + Math.max(1, Number(b.config.intervalMinutes ?? (b.kind === 'ics' ? 15 : 5))) * 60_000);
      }
      await db.query('UPDATE trigger_bindings SET next_run_at = $2 WHERE id = $1', [b.id, next]);
      return b;
    });
    if (!claimed) continue;
    count++;
    const ver = await versionFor(claimed.workflow_id);
    const node = ver?.graph.nodes.find((n) => n.id === claimed.node_id);
    if (!ver || !node) continue;
    try {
      if (claimed.kind === 'schedule') {
        const scheduledAt = new Date(claimed.next_run_at);
        const lateMs = Date.now() - scheduledAt.getTime();
        const catchUp = lateMs > 120_000;
        if (catchUp && (claimed.config.missed ?? 'once') === 'skip') {
          log('info', 'scheduler', `Verpasster Termin übersprungen: ${ver.name}`, { geplant: scheduledAt.toISOString() });
          continue;
        }
        await startFromBinding(claimed, node, { scheduled_at: scheduledAt.toISOString(), fired_at: new Date().toISOString(), catch_up: catchUp }, catchUp ? 'Zeitplan (nachgeholt)' : 'Zeitplan', null);
      } else if (claimed.kind === 'imap') {
        const conn = await loadRuntimeConnection(claimed.config.connectionId);
        if (!conn) continue;
        const res = await pollImap(conn, claimed.cursor ?? {}, { fromFilter: claimed.config.fromFilter, subjectFilter: claimed.config.subjectFilter });
        await pool.query('UPDATE trigger_bindings SET cursor = $2, last_error = NULL WHERE id = $1', [claimed.id, JSON.stringify(res.cursor)]);
        for (const m of res.messages) await startFromBinding(claimed, node, m, `E-Mail: ${String(m.subject ?? '').slice(0, 60)}`, String(m.message_id ?? m.uid));
      } else if (claimed.kind === 'ics') {
        await pollCalendar(claimed, node, s['general.timezone']);
      }
      await pool.query('UPDATE trigger_bindings SET last_error = NULL WHERE id = $1', [claimed.id]);
    } catch (e) {
      const msg = (e as Error).message;
      const prevErr = claimed.last_error;
      await pool.query('UPDATE trigger_bindings SET last_error = $2 WHERE id = $1', [claimed.id, msg.slice(0, 500)]);
      log('warn', 'trigger', `Trigger „${node.name}“ (${ver.name}) fehlgeschlagen: ${msg}`);
      if (!prevErr) await notify({ kind: 'warning', title: `Trigger von „${ver.name}“ meldet einen Fehler`, body: msg, link: `/workflows/${claimed.workflow_id}`, permission: 'workflow.read' });
    }
  }
  return count;
}

async function pollCalendar(b: any, node: GraphNode, tz: string) {
  const conn = await loadRuntimeConnection(b.config.connectionId);
  if (!conn) return;
  const events = await fetchCalendar(conn, tz, Number(b.config.horizonDays ?? 60));
  const filter = String(b.config.titleFilter ?? '').toLowerCase();
  const list = filter ? events.filter((e) => e.title.toLowerCase().includes(filter)) : events;
  const cursor: { seen?: Record<string, { h: string; start: string; title: string }>; started?: string[]; initialized?: boolean } = b.cursor ?? {};
  const seen = cursor.seen ?? {};
  const started = new Set(cursor.started ?? []);
  const wanted = new Set<string>(b.config.events ?? ['new', 'changed', 'deleted']);
  const now = Date.now();
  const nextSeen: typeof seen = {};
  const emit: { kind: string; e: any }[] = [];
  for (const e of list) {
    const h = calendarEventHash(e);
    nextSeen[e.key] = { h, start: e.start, title: e.title };
    if (!cursor.initialized) continue; // Erstabruf: Bestand merken, nichts auslösen
    const prev = seen[e.key];
    const cancelled = e.status === 'CANCELLED';
    if (!prev && !cancelled) emit.push({ kind: 'neu', e });
    else if (prev && prev.h !== h) emit.push({ kind: cancelled ? 'geloescht' : 'geaendert', e });
    if (wanted.has('starting')) {
      const lead = Number(b.config.leadMinutes ?? 60) * 60_000;
      const st = new Date(e.start).getTime();
      if (st > now && st - now <= lead && !started.has(e.key) && !cancelled) {
        started.add(e.key);
        emit.push({ kind: 'beginnt_bald', e });
      }
    }
  }
  if (cursor.initialized) {
    for (const [key, prev] of Object.entries(seen)) {
      if (!nextSeen[key] && new Date(prev.start).getTime() > now) emit.push({ kind: 'geloescht', e: { uid: key.split('|')[0], key, title: prev.title, start: prev.start, end: null, description: '', location: '', all_day: false, categories: [] } });
    }
  }
  const kindMap: Record<string, string> = { neu: 'new', geaendert: 'changed', geloescht: 'deleted', beginnt_bald: 'starting' };
  for (const { kind, e } of emit) {
    if (!wanted.has(kindMap[kind])) continue;
    const out = { aenderung: kind, titel: e.title, beschreibung: e.description, ort: e.location, beginn: e.start, ende: e.end, ganztaegig: e.all_day, kategorien: e.categories, uid: e.uid };
    await startFromBinding(b, node, out, `Termin ${kind.replace('_', ' ')}: ${e.title}`.slice(0, 80), `${kind}:${e.key}:${calendarEventHash(e)}`);
  }
  const startedArr = [...started].filter((k) => nextSeen[k]).slice(-1000);
  await pool.query('UPDATE trigger_bindings SET cursor = $2 WHERE id = $1', [b.id, JSON.stringify({ seen: nextSeen, started: startedArr, initialized: true })]);
}

/* -------------------------------------- MQTT ---------------------------------------- */

/** Hält MQTT-Abos für aktive MQTT-Trigger (nur im Worker, nur ein Worker per Advisory-Lock). */
export class MqttManager {
  private clients = new Map<string, { client: mqttType.MqttClient; signature: string }>();

  async sync() {
    const bindings = await many<any>(`SELECT * FROM trigger_bindings WHERE kind = 'mqtt'`);
    const wanted = new Map(bindings.map((b) => [b.id as string, b]));
    for (const [id, c] of this.clients) {
      const b = wanted.get(id);
      if (!b || JSON.stringify(b.config) !== c.signature) {
        c.client.end(true);
        this.clients.delete(id);
      }
    }
    for (const b of bindings) {
      if (this.clients.has(b.id)) continue;
      try {
        await this.subscribe(b);
      } catch (e) {
        await pool.query('UPDATE trigger_bindings SET last_error = $2 WHERE id = $1', [b.id, (e as Error).message.slice(0, 500)]);
      }
    }
  }

  private async subscribe(b: any) {
    const conn = await loadRuntimeConnection(b.config.connectionId);
    if (!conn) return;
    const topic = String(b.config.topic ?? '');
    if (!topicAllowed(topic, conn.config.topics ?? [])) throw new Error(`Topic „${topic}“ ist in der Verbindung nicht freigegeben.`);
    const client = await mqttConnect({ ...conn, config: { ...conn.config, clientId: conn.config.clientId ? `${conn.config.clientId}-${b.id.slice(0, 6)}` : '' } });
    client.options.reconnectPeriod = 10_000;
    await client.subscribeAsync(topic, { qos: Number(conn.config.qos ?? 1) as 0 | 1 | 2 });
    const max = Number(b.config.maxBytes ?? 65_536);
    client.on('message', async (t, payload, packet) => {
      try {
        if (payload.length > max) {
          log('warn', 'mqtt', `Nachricht auf ${t} zu groß (${payload.length} Byte) – ignoriert.`);
          return;
        }
        const ver = await versionFor(b.workflow_id);
        const node = ver?.graph.nodes.find((n) => n.id === b.node_id);
        if (!node) return;
        let data: unknown = payload.toString('utf8');
        if (b.config.parseJson !== false) {
          try {
            data = JSON.parse(String(data));
          } catch {
            /* Text bleibt Text */
          }
        }
        await startFromBinding(b, node, { topic: t, payload: data, retained: packet.retain }, `MQTT ${t}`, null);
      } catch (e) {
        log('error', 'mqtt', `MQTT-Nachricht konnte nicht verarbeitet werden: ${(e as Error).message}`);
      }
    });
    client.on('error', (err) => pool.query('UPDATE trigger_bindings SET last_error = $2 WHERE id = $1', [b.id, err.message.slice(0, 500)]).catch(() => {}));
    client.on('connect', () => pool.query('UPDATE trigger_bindings SET last_error = NULL WHERE id = $1', [b.id]).catch(() => {}));
    this.clients.set(b.id, { client, signature: JSON.stringify(b.config) });
  }

  count() {
    return this.clients.size;
  }

  stop() {
    for (const c of this.clients.values()) c.client.end(true);
    this.clients.clear();
  }
}
