import pg from 'pg';
import { config } from './config.js';
import { many, one, pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { masterKey } from './lib/crypto.js';
import { log } from './lib/log.js';
import { notify } from './lib/notify.js';
import { getSettings } from './lib/settings.js';
import { executeRun } from './engine/executor.js';
import { claimJobs, completeJob, enqueue, failJob, heartbeatJob, WORKER_ID, type Job } from './engine/queue.js';
import { MqttManager, runDueBindings } from './engine/triggers.js';
import { loadRuntimeConnection } from './engine/connections.js';
import { syncBanner } from './content/banners.js';
import { runBackup } from './ops/backup.js';
import { checkForUpdate } from './updates/github.js';
import { sendMailNode } from './connectors/email.js';
import { render } from './lib/template.js';
import { toStepError } from './lib/errors.js';

process.env.LIFELINK_ROLE ??= 'worker';

// Sicherheitsnetz: unbehandelte Ablehnungen protokollieren statt den Prozess zu beenden
process.on('unhandledRejection', (e) => log('error', 'worker', `Unbehandelter Fehler: ${(e as Error)?.message ?? String(e)}`, { stack: String((e as Error)?.stack ?? '').slice(0, 2000) }));

const running = new Map<number, Promise<void>>();
let stopping = false;
const LEADER_LOCK = 74_210_002;

const handlers: Record<string, (job: Job) => Promise<void>> = {
  'run.execute': async (job) => {
    await executeRun(Number(job.payload.runId), { heartbeat: () => heartbeatJob(job.id) });
  },
  'banner.sync': async (job) => {
    const ok = await syncBanner(String(job.payload.bannerId));
    if (!ok) throw new Error('WordPress nicht erreichbar.');
  },
  'notify.run_failed': async (job) => {
    const run = await one<any>(`SELECT r.id, r.summary, r.status, r.workflow_id, w.name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1`, [job.payload.runId]);
    if (!run) return;
    const s = await getSettings();
    const title = run.status === 'needs_review' ? `Lauf #${run.id} muss geprüft werden` : `Lauf #${run.id} fehlgeschlagen`;
    if (s['notify.on_failure_inapp']) {
      await notify({ kind: 'error', title, body: `${run.name}: ${run.summary}`, link: `/ausfuehrungen/${run.id}`, permission: 'run.read' });
    }
    if (s['notify.on_failure_email'] && s['notify.email_connection_id'] && s['notify.email_recipients'].length) {
      const conn = await loadRuntimeConnection(s['notify.email_connection_id']);
      if (!conn) return;
      const url = config.publicUrl ? `${config.publicUrl}/ausfuehrungen/${run.id}` : `Lauf #${run.id}`;
      const ctx: any = {
        node: { config: { to: s['notify.email_recipients'], subject: `[LifeLink] ${title}`, text: `Workflow: ${run.name}\n${run.summary}\n\nDetails: ${url}`, format: 'text' } },
        connection: conn,
        run: { id: 0 },
        render: (t: string) => render(t, {}),
        timeoutMs: 30_000,
      };
      await sendMailNode.execute(ctx);
    }
  },
};

async function processJob(job: Job) {
  const h = handlers[job.kind];
  try {
    if (!h) throw new Error(`Unbekannter Auftragstyp ${job.kind}`);
    await h(job);
    await completeJob(job.id);
  } catch (e) {
    const err = toStepError(e);
    const res = await failJob(job, err.message, err.retryAfterMs);
    log(res === 'dead' ? 'error' : 'warn', 'worker', `Auftrag ${job.kind} #${job.id} fehlgeschlagen (${res === 'dead' ? 'endgültig' : 'wird wiederholt'}): ${err.message}`);
    if (job.kind === 'run.execute' && res === 'dead') {
      await pool.query(`UPDATE runs SET status = 'dead', finished_at = now(), error_message = $2, summary = $3, retryable = true WHERE id = $1 AND status NOT IN ('success','error','canceled','needs_review')`, [
        job.payload.runId,
        err.message,
        `Ausführung wiederholt abgebrochen: ${err.message}`.slice(0, 500),
      ]);
      await enqueue('notify.run_failed', { runId: job.payload.runId });
    }
  }
}

async function pump() {
  if (stopping) return;
  const s = await getSettings();
  const free = Math.max(0, Math.min(32, s['execution.concurrency']) - running.size);
  if (!free) return;
  const jobs = await claimJobs(free);
  for (const job of jobs) {
    const p = processJob(job).finally(() => running.delete(job.id));
    running.set(job.id, p);
  }
}

/* --------------------------------- Wartungsaufgaben -------------------------------- */

async function cleanup() {
  const s = await getSettings();
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p).catch((e) => log('warn', 'cleanup', e.message));
  await q(`DELETE FROM app_logs WHERE at < now() - make_interval(days => $1)`, [s['execution.log_retention_days']]);
  await q(`DELETE FROM audit_events WHERE at < now() - make_interval(days => $1)`, [s['execution.audit_retention_days']]);
  await q(`DELETE FROM runs WHERE created_at < now() - make_interval(days => $1) AND status NOT IN ('queued','running','waiting')`, [s['execution.run_retention_days']]);
  await q(`UPDATE step_runs SET input_preview = NULL, output_preview = NULL WHERE started_at < now() - make_interval(days => $1) AND (input_preview IS NOT NULL OR output_preview IS NOT NULL)`, [s['execution.preview_retention_days']]);
  await q(`UPDATE runs SET input_preview = NULL WHERE created_at < now() - make_interval(days => $1) AND input_preview IS NOT NULL`, [s['execution.preview_retention_days']]);
  await q(`UPDATE runs SET context_enc = NULL WHERE context_enc IS NOT NULL AND context_expires_at < now()`);
  await q(`UPDATE event_receipts SET payload_preview = NULL WHERE received_at < now() - make_interval(days => $1) AND payload_preview IS NOT NULL`, [s['execution.event_retention_days']]);
  await q(`DELETE FROM event_receipts WHERE received_at < now() - make_interval(days => $1)`, [s['execution.run_retention_days']]);
  await q(`DELETE FROM webhook_nonces WHERE expires_at < now()`);
  await q(`DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'`);
  await q(`DELETE FROM jobs WHERE status = 'dead' AND updated_at < now() - interval '30 days'`);
  await q(`DELETE FROM notifications WHERE created_at < now() - interval '60 days'`);
  await q(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
  await q(`DELETE FROM invitations WHERE expires_at < now() - interval '30 days'`);
  await q(`DELETE FROM idempotency_records WHERE created_at < now() - interval '30 days'`);
  await q(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`);
  await q(`UPDATE backups SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Prozess beendet)' WHERE status = 'running' AND started_at < now() - interval '1 hour'`);
}

async function expiryWarnings() {
  const rows = await many<any>(`SELECT id, name, credentials_expire_at FROM connections WHERE credentials_expire_at BETWEEN now() AND now() + interval '14 days' AND status <> 'disabled'`);
  for (const r of rows) {
    const exists = await one(`SELECT 1 FROM notifications WHERE link = $1 AND created_at > now() - interval '7 days'`, [`/verbindungen/${r.id}`]);
    if (!exists) await notify({ kind: 'warning', title: `Zugangsdaten von „${r.name}“ laufen bald ab`, body: `Ablauf: ${new Date(r.credentials_expire_at).toLocaleDateString('de-DE')}`, link: `/verbindungen/${r.id}`, permission: 'credential.manage' });
  }
}

const timers: Record<string, number> = {};
function due(name: string, everyMs: number) {
  const now = Date.now();
  if (!timers[name] || now - timers[name] >= everyMs) {
    timers[name] = now;
    return true;
  }
  return false;
}

async function maintenance(isLeader: boolean) {
  if (!isLeader) return;
  const s = await getSettings();
  if (due('cleanup', 60 * 60_000)) await cleanup();
  if (due('expiry', 6 * 60 * 60_000)) await expiryWarnings();
  if (s['updates.enabled'] && due('updates', Math.max(1, s['updates.check_hours']) * 60 * 60_000)) await checkForUpdate();
  if (s['backup.enabled'] && due('backup-check', 10 * 60_000)) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: s['general.timezone'] }));
    if (now.getHours() === s['backup.hour']) {
      const today = await one(`SELECT 1 FROM backups WHERE trigger = 'schedule' AND started_at > now() - interval '20 hours'`);
      if (!today) await runBackup('schedule', null).catch(() => {});
    }
  }
}

async function main() {
  masterKey();
  await migrate((m) => log('info', 'migrate', m));
  const startedAt = new Date();
  log('info', 'worker', `Worker ${WORKER_ID} gestartet (LifeLink ${config.version})`);

  // Eigene Verbindung für LISTEN/NOTIFY und den Leader-Lock (Zeitpläne, MQTT, Wartung nur einmal)
  const listener = new pg.Client({ connectionString: config.databaseUrl, application_name: 'lifelink-worker-listen' });
  await listener.connect();
  await listener.query('LISTEN lifelink_jobs');
  await listener.query('LISTEN lifelink_bindings');
  const mqtt = new MqttManager();
  let isLeader = false;
  listener.on('notification', (n) => {
    if (n.channel === 'lifelink_jobs') pump().catch(() => {});
    if (n.channel === 'lifelink_bindings' && isLeader) mqtt.sync().catch(() => {});
  });
  listener.on('error', (e) => {
    log('error', 'worker', `Datenbankverbindung verloren: ${e.message}`);
    process.exit(1);
  });

  const beat = async () => {
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, started_at, last_seen_at, version, jobs_running, info) VALUES ($1,$2,now(),$3,$4,$5)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), jobs_running = EXCLUDED.jobs_running, info = EXCLUDED.info`,
      [WORKER_ID, startedAt, config.version, running.size, JSON.stringify({ leader: isLeader, mqtt: mqtt.count() })],
    );
  };

  const tick = async () => {
    if (!isLeader) {
      const r = await listener.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
      if (r.rows[0].ok) {
        isLeader = true;
        log('info', 'worker', 'Dieser Worker übernimmt Zeitpläne, MQTT und Wartung.');
        await mqtt.sync();
      }
    }
    if (isLeader) await runDueBindings();
    await maintenance(isLeader);
  };

  const loops = [
    setInterval(() => pump().catch((e) => log('error', 'worker', e.message)), 2_000),
    setInterval(() => beat().catch(() => {}), 10_000),
    setInterval(() => tick().catch((e) => log('error', 'worker', `Zeitsteuerung: ${e.message}`)), 5_000),
    setInterval(() => (isLeader ? mqtt.sync().catch(() => {}) : undefined), 60_000),
  ];
  await beat();
  await tick();
  await pump();
  process.send?.({ type: 'ready', role: 'worker', version: config.version });

  const stop = async () => {
    stopping = true;
    loops.forEach(clearInterval);
    mqtt.stop();
    // laufende Aufträge maximal 20 s abschließen lassen, danach übernimmt die Lease
    await Promise.race([Promise.allSettled([...running.values()]), new Promise((r) => setTimeout(r, 20_000))]);
    await pool.query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [WORKER_ID]).catch(() => {});
    await listener.end().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('[worker] Start fehlgeschlagen:', err?.message ?? err);
  process.exit(1);
});
