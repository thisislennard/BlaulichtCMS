import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';
import { many, one, pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { masterKey } from './lib/crypto.js';
import { log } from './lib/log.js';
import { notify } from './lib/notify.js';
import { getSettings } from './lib/settings.js';
import { claimJobs, completeJob, failJob, WORKER_ID, type Job } from './jobs/queue.js';
import { runBackup } from './ops/backup.js';
import { toStepError } from './lib/errors.js';
import { processMedia } from './media/process.js';
import { ensureMediaDirs, mediaPaths } from './media/storage.js';
import { cleanupUploadSessions } from './routes/uploads.js';
import { buildExport, cleanupExports } from './media/exports.js';
import { refreshDueFeeds } from './routes/rss.js';
import { deliverWarningSend } from './warnings/mail.js';

process.env.LIFELINK_ROLE ??= 'worker';

// Sicherheitsnetz: unbehandelte Ablehnungen protokollieren statt den Prozess zu beenden
process.on('unhandledRejection', (e) => log('error', 'worker', `Unbehandelter Fehler: ${(e as Error)?.message ?? String(e)}`, { stack: String((e as Error)?.stack ?? '').slice(0, 2000) }));

const running = new Map<number, Promise<void>>();
let stopping = false;
const LEADER_LOCK = 74_210_002;

const handlers: Record<string, (job: Job) => Promise<void>> = {
  'media.process': async (job) => {
    await processMedia(String(job.payload.mediaId));
  },
  'export.zip': async (job) => {
    await buildExport(String(job.payload.exportId));
  },
  // Genau ein Versuch: ein automatischer Wiederholungsversand könnte eine Warnung doppelt zustellen
  'warning.send': async (job) => {
    await deliverWarningSend(String(job.payload.sendId));
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
    if (job.kind === 'export.zip' && res === 'dead') {
      await pool.query(`UPDATE exports SET status = 'failed', error = $2 WHERE id = $1`, [job.payload.exportId, err.message.slice(0, 300)]);
    }
    if (job.kind === 'media.process' && res === 'dead') {
      await pool.query(`UPDATE media SET status = 'rejected', reject_reason = 'Prüfung wiederholt fehlgeschlagen.', processed_at = now() WHERE id = $1 AND status = 'quarantine'`, [job.payload.mediaId]);
    }
  }
}

async function pump() {
  if (stopping) return;
  const s = await getSettings();
  const free = Math.max(0, Math.min(32, s['jobs.concurrency']) - running.size);
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
  await q(`DELETE FROM app_logs WHERE at < now() - make_interval(days => $1)`, [s['retention.log_days']]);
  await q(`DELETE FROM audit_events WHERE at < now() - make_interval(days => $1)`, [s['retention.audit_days']]);
  await q(`DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'`);
  await q(`DELETE FROM jobs WHERE status = 'dead' AND updated_at < now() - interval '30 days'`);
  await q(`DELETE FROM notifications WHERE created_at < now() - interval '60 days'`);
  await q(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
  await q(`DELETE FROM invitations WHERE expires_at < now() - interval '30 days'`);
  await q(`DELETE FROM idempotency_records WHERE created_at < now() - interval '30 days'`);
  await q(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`);
  await q(`UPDATE backups SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Prozess beendet)' WHERE status = 'running' AND started_at < now() - interval '1 hour'`);
  await cleanupUploadSessions().catch((e) => log('warn', 'cleanup', e.message));
  await cleanupExports().catch((e) => log('warn', 'cleanup', e.message));
  // Liegengebliebene temporäre Upload-Dateien (abgebrochene Übertragungen) entfernen
  try {
    const dir = mediaPaths.tmp();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (!f.startsWith('upload-') && Date.now() - fs.statSync(p).mtimeMs > 6 * 3600_000) fs.rmSync(p, { force: true });
    }
  } catch {
    /* Ordner fehlt */
  }
}

/** Abgeholt, aber ohne Rückmeldung: Ergebnis gilt als unbekannt. Die Bridge prüft beim nächsten Abruf die Website. */
async function markUnknownPublications() {
  const rows = await many<any>(
    `UPDATE publications SET status = 'unknown' WHERE status = 'sent' AND fetched_at < now() - interval '15 minutes' RETURNING id, post_id`,
  );
  for (const r of rows) {
    await notify({ kind: 'warning', title: 'Veröffentlichung: Ergebnis unbekannt', body: 'Die Website hat den Auftrag abgeholt, aber noch kein Ergebnis gemeldet.', link: `/beitraege/${r.post_id}`, permission: 'post.publish' });
  }
}

/** Dateien, die nach einem Neustart noch in der Quarantäne liegen, erneut zur Prüfung einplanen. */
async function requeueQuarantine() {
  await pool.query(
    `INSERT INTO jobs (kind, payload, dedup_key)
     SELECT 'media.process', jsonb_build_object('mediaId', m.id), 'media.process:' || m.id FROM media m
      WHERE m.status = 'quarantine' AND m.deleted_at IS NULL AND m.created_at < now() - interval '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedup_key = 'media.process:' || m.id AND j.status IN ('queued','running'))
     ON CONFLICT DO NOTHING`,
  );
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
  if (due('publications', 60_000)) await markUnknownPublications();
  if (due('quarantine', 10 * 60_000)) await requeueQuarantine();
  if (due('rss', 60_000)) await refreshDueFeeds().catch((e) => log('warn', 'rss', e.message));
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
  ensureMediaDirs();
  const startedAt = new Date();
  log('info', 'worker', `Worker ${WORKER_ID} gestartet (LifeLink ${config.version})`);

  // Eigene Verbindung für LISTEN/NOTIFY und den Leader-Lock (Zeitpläne, MQTT, Wartung nur einmal)
  const listener = new pg.Client({ connectionString: config.databaseUrl, application_name: 'lifelink-worker-listen' });
  await listener.connect();
  await listener.query('LISTEN lifelink_jobs');
  let isLeader = false;
  listener.on('notification', (n) => {
    if (n.channel === 'lifelink_jobs') pump().catch(() => {});
  });
  listener.on('error', (e) => {
    log('error', 'worker', `Datenbankverbindung verloren: ${e.message}`);
    process.exit(1);
  });

  const beat = async () => {
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, started_at, last_seen_at, version, jobs_running, info) VALUES ($1,$2,now(),$3,$4,$5)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), jobs_running = EXCLUDED.jobs_running, info = EXCLUDED.info`,
      [WORKER_ID, startedAt, config.version, running.size, JSON.stringify({ leader: isLeader })],
    );
  };

  const tick = async () => {
    if (!isLeader) {
      const r = await listener.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
      if (r.rows[0].ok) {
        isLeader = true;
        log('info', 'worker', 'Dieser Worker übernimmt Zeitpläne und Wartung.');
      }
    }
    await maintenance(isLeader);
  };

  const loops = [
    setInterval(() => pump().catch((e) => log('error', 'worker', e.message)), 2_000),
    setInterval(() => beat().catch(() => {}), 10_000),
    setInterval(() => tick().catch((e) => log('error', 'worker', `Zeitsteuerung: ${e.message}`)), 5_000),
  ];
  await beat();
  await tick();
  await pump();
  process.send?.({ type: 'ready', role: 'worker', version: config.version });

  const stop = async () => {
    stopping = true;
    loops.forEach(clearInterval);
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
