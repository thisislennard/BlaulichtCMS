import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';
import { many, one, pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { masterKey } from './lib/crypto.js';
import { log } from './lib/log.js';
import { notify } from './lib/notify.js';
import { securityAlert } from './lib/security-alerts.js';
import { getSettings } from './lib/settings.js';
import { claimJobs, completeJob, failJob, heartbeatJob, HEARTBEAT_MS, requeueExpiredLeases, WORKER_ID, type Job } from './jobs/queue.js';
import { runBackup } from './ops/backup.js';
import { toStepError } from './lib/errors.js';
import { enqueuePendingLocationStrips, processMedia, removeDerivedFiles, stripStoredOriginal } from './media/process.js';
import { logPublicEvent } from './lib/public-security.js';
import { ensureMediaDirs, mediaPaths } from './media/storage.js';
import { cleanupUploadSessions } from './routes/uploads.js';
import { buildExport, cleanupExports } from './media/exports.js';
import { renderPublic } from './media/privacy.js';
import { refreshDueFeeds } from './routes/rss.js';
import { deliverWarningSend } from './warnings/mail.js';
import { runSocialPublication } from './connections/social.js';
import { refreshThreadsTokens } from './connections/threads.js';
import { redactAnonymousIps } from './lib/audit.js';
import { sealAudit, verifyAudit } from './lib/audit-chain.js';
import { cleanupMediaTokens } from './connections/meta.js';
import { refreshDueWarnfeeds } from './connections/warnfeed.js';
import { pollDueFeuersoftware } from './connections/feuersoftware.js';
import { runRetention } from './lib/retention.js';
import { checkExpiringLinks, checkStorage } from './lib/media-notify.js';
import { cleanupDesignImages } from './routes/media-design.js';
import { checkForUpdate, updateCheckDue } from './updates/github.js';
import { executeRun } from './automations/engine.js';
import { automationTick } from './automations/events.js';
import { deliverNotification } from './lib/notify-channels.js';
import { migratePlaintextSecrets } from './lib/secret-audit.js';
import { checkPressDeadlines } from './press/deadlines.js';

process.env.BLAULICHTCMS_ROLE ??= 'worker';

// Sicherheitsnetz: unbehandelte Ablehnungen protokollieren statt den Prozess zu beenden
process.on('unhandledRejection', (e) => log('error', 'worker', `Unbehandelter Fehler: ${(e as Error)?.message ?? String(e)}`, { stack: String((e as Error)?.stack ?? '').slice(0, 2000) }));

const running = new Map<number, Promise<void>>();
let stopping = false;
const LEADER_LOCK = 74_210_002;

const handlers: Record<string, (job: Job) => Promise<void>> = {
  'media.process': async (job) => {
    await processMedia(String(job.payload.mediaId));
  },
  // Standortdaten aus älteren Originalen entfernen (#119); Fehler werden am Medium vermerkt, nicht wiederholt
  'media.strip_location': async (job) => {
    await stripStoredOriginal(String(job.payload.mediaId));
  },
  // Öffentliche Fassung nach Datenschutz-Einstellungen neu erzeugen (#118, z. B. Video ohne Ton)
  'media.render_public': async (job) => {
    await renderPublic(String(job.payload.mediaId));
  },
  'export.zip': async (job) => {
    await buildExport(String(job.payload.exportId));
  },
  // Genau ein Versuch: ein automatischer Wiederholungsversand könnte eine Warnung doppelt zustellen
  'warning.send': async (job) => {
    await deliverWarningSend(String(job.payload.sendId));
  },
  // Ebenfalls genau ein Versuch je Anstoß; Wiederholung nur gezielt für den betroffenen Kanal
  'social.publish': async (job) => {
    await runSocialPublication(String(job.payload.id));
  },
  // Automationen: ein Lauf je Auftrag; Wiederholung überspringt erledigte Schritte (automations/engine.ts)
  'automation.run': async (job) => {
    await executeRun(String(job.payload.runId), job);
  },
  // Benachrichtigungen per Push/E-Mail (#191); Fehler einzelner Geräte/Postfächer werden protokolliert, nicht wiederholt
  'notify.deliver': async (job) => {
    await deliverNotification(Number(job.payload.id));
  },
};

async function processJob(job: Job) {
  const h = handlers[job.kind];
  // Lease verlängern, solange der Handler läuft – sonst vergibt claimJobs lange Aufträge (Instagram, ZIP, Video)
  // nach 60 s ein zweites Mal
  const beat = setInterval(() => heartbeatJob(job.id).catch((e) => log('warn', 'worker', `Heartbeat #${job.id}: ${e.message}`)), HEARTBEAT_MS);
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
      // Gesperrt statt gelöscht: Datei bleibt in der Quarantäne, „Erneut prüfen“ ist möglich (#73: Teildateien weg)
      const r = await pool.query(`UPDATE media SET status = 'blocked', reject_step = 'error', reject_reason = 'Prüfung wiederholt fehlgeschlagen.', processed_at = now() WHERE id = $1 AND status = 'quarantine' RETURNING upload_link_id`, [job.payload.mediaId]);
      removeDerivedFiles(String(job.payload.mediaId));
      if (r.rowCount) await logPublicEvent('check_failed', { linkId: r.rows[0].upload_link_id, mediaId: String(job.payload.mediaId), detail: err.message, throttle: false });
    }
  } finally {
    clearInterval(beat);
  }
}

/**
 * Freie Plätze mit wartenden Aufträgen füllen. Nach jedem fertigen Auftrag sofort nachziehen (#192): vorher wartete der
 * Worker bis zum nächsten 2-s-Takt – kurze Aufträge (Benachrichtigungen, Standortbereinigung) kamen so auf höchstens
 * „Parallele Aufträge ÷ 2“ pro Sekunde, 1 000 Aufträge dauerten über 8 Minuten. Überlappende Aufrufe werden zu einem
 * zusammengefasst, damit nie mehr als die eingestellte Zahl Aufträge läuft.
 */
let pumping = false;
let pumpAgain = false;
async function pump(): Promise<void> {
  if (stopping) return;
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      const s = await getSettings();
      // Wartungsmodus: laufende Aufträge zu Ende führen, aber keine neuen beginnen
      // (abgestürzte Aufträge trotzdem freigeben, sonst blockieren sie die Update-Vorabprüfung dauerhaft)
      if (s['system.maintenance']) return await requeueExpiredLeases();
      const free = Math.max(0, Math.min(32, s['jobs.concurrency']) - running.size);
      if (!free) return;
      const jobs = await claimJobs(free, [...running.keys()]);
      for (const job of jobs) {
        const p = processJob(job).finally(() => {
          running.delete(job.id);
          if (!stopping) pump().catch((e) => log('error', 'worker', e.message));
        });
        running.set(job.id, p);
      }
    } while (pumpAgain && !stopping);
  } finally {
    pumping = false;
  }
}

/* --------------------------------- Wartungsaufgaben -------------------------------- */

async function cleanup() {
  const s = await getSettings();
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p).catch((e) => log('warn', 'cleanup', e.message));
  await q(`DELETE FROM app_logs WHERE at < now() - make_interval(days => $1)`, [s['retention.log_days']]);
  await q(`DELETE FROM audit_events WHERE at < now() - make_interval(days => $1)`, [s['retention.audit_days']]);
  await redactAnonymousIps(s['privacy.upload_ip_retention_days']).catch((e) => log('warn', 'cleanup', e.message));
  await q(`DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'`);
  await q(`DELETE FROM jobs WHERE status = 'dead' AND updated_at < now() - interval '30 days'`);
  await q(`DELETE FROM notifications WHERE created_at < now() - interval '60 days'`);
  await q(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
  await q(`DELETE FROM trusted_devices WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
  await q(`DELETE FROM invitations WHERE expires_at < now() - interval '30 days'`);
  await q(`DELETE FROM auth_throttle WHERE updated_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`);
  // Abgelaufene Sammeldownloads (Datei schon entfernt) und alte Importberichte (#116)
  await q(`DELETE FROM exports WHERE status IN ('expired', 'failed') AND created_at < now() - interval '30 days'`);
  await q(`DELETE FROM import_runs WHERE created_at < now() - make_interval(days => $1)`, [s['retention.audit_days']]);
  await q(`DELETE FROM idempotency_records WHERE created_at < now() - interval '30 days'`);
  // Prüfsummen übernommener Einsätze (Schutz vor erneuter Anlage gelöschter Einsätze) – die Quelle liefert nur Stunden zurück
  await q(`DELETE FROM connection_seen_events WHERE seen_at < now() - interval '30 days'`);
  await q(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`);
  // Widerrufene Geheimnisse (alte SMTP-Passwörter, rotierte Verbindungs-Tokens) nach 30 Tagen endgültig löschen (#172).
  await q(`DELETE FROM secrets WHERE revoked_at < now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.secret_id = secrets.id)`);
  await q(`UPDATE backups SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Prozess beendet)' WHERE status = 'running' AND started_at < now() - interval '1 hour'`);
  await cleanupUploadSessions().catch((e) => log('warn', 'cleanup', e.message));
  await cleanupExports().catch((e) => log('warn', 'cleanup', e.message));
  await cleanupMediaTokens().catch((e) => log('warn', 'cleanup', e.message));
  await cleanupDesignImages().catch((e) => log('warn', 'cleanup', e.message));
  // Löschfristen für Sammlungen, Medien und weitere personenbezogene Daten (#97)
  await runRetention({ dryRun: false, settings: s }).catch((e) => log('warn', 'retention', e.message));
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
    await notify({ kind: 'warning', title: 'Veröffentlichung: Ergebnis unbekannt', body: 'Die Website hat den Auftrag abgeholt, aber noch kein Ergebnis gemeldet.', link: `/beitraege/${r.post_id}`, permission: 'publish.website' });
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

async function verifyAuditDaily(retentionDays: number) {
  try {
    const v = await verifyAudit(retentionDays);
    if (v.ok) return log('info', 'audit', `Audit-Kette geprüft: ${v.checked} Einträge in Ordnung.`);
    log('error', 'audit', `Audit-Kette beschädigt: ${v.problems.length} Auffälligkeit(en).`, { probleme: v.problems.slice(0, 10) });
    await securityAlert('audit_integrity', { kind: 'error', title: 'Audit-Protokoll: Manipulation oder Lücke erkannt', body: `${v.problems[0]?.text ?? ''} Einzelheiten unter Systemstatus → Audit-Integrität. Vorgehen bei Sicherheitsvorfällen: Hilfe → Sicherheit.`, link: '/system' });
  } catch (e) {
    log('warn', 'audit', `Prüfung der Audit-Kette fehlgeschlagen: ${(e as Error).message}`);
  }
}

async function maintenance(isLeader: boolean) {
  if (!isLeader) return;
  const s = await getSettings();
  if (due('cleanup', 60 * 60_000)) await cleanup();
  if (due('publications', 60_000)) await markUnknownPublications();
  // Audit-Kette (#112): neue Einträge jede Minute versiegeln, täglich die ganze Kette prüfen
  if (due('audit-seal', 60_000)) await sealAudit().catch((e) => log('warn', 'audit', `Versiegeln: ${e.message}`));
  if (due('audit-verify', 24 * 60 * 60_000)) await verifyAuditDaily(s['retention.audit_days']);
  if (due('quarantine', 10 * 60_000)) await requeueQuarantine();
  // Medien-Benachrichtigungen: Links, die bald ablaufen, und knapper Speicher (Paket 5)
  if (due('media-notices', 10 * 60_000)) {
    await checkExpiringLinks().catch((e) => log('warn', 'notify', `Ablaufende Links: ${e.message}`));
    await checkStorage().catch((e) => log('warn', 'notify', `Speicherwarnung: ${e.message}`));
  }
  if (s['media.strip_location'] && due('strip-location', 10 * 60_000)) await enqueuePendingLocationStrips().catch((e) => log('warn', 'media', `Standort-Bereinigung: ${e.message}`));
  if (due('rss', 60_000)) await refreshDueFeeds().catch((e) => log('warn', 'rss', e.message));
  // In-App-Updates: neues Release im eingestellten Abstand prüfen (installiert wird nur von Hand)
  if (due('update-check', 10 * 60_000) && (await updateCheckDue())) await checkForUpdate();
  if (due('warnfeed', 60_000)) await refreshDueWarnfeeds().catch((e) => log('warn', 'warnfeed', e.message));
  // Feuersoftware Connect: jede aktive Verbindung in ihrem Abstand (60–300 s); geprüft wird alle 10 s
  if (due('feuersoftware', 10_000)) await pollDueFeuersoftware().catch((e) => log('warn', 'feuersoftware', e.message));
  // Automationen: Zeitpläne starten, abgelaufene Freigaben schließen
  // Threads-Anmeldungen (60 Tage gültig) rechtzeitig verlängern
  if (due('threads-token', 24 * 60 * 60_000)) await refreshThreadsTokens().catch((e) => log('warn', 'threads', e.message));
  if (due('automations', 30_000)) await automationTick().catch((e) => log('warn', 'automation', e.message));
  // Presseanfragen: Erinnerung vor Ablauf der Frist und bei Überschreitung (#204)
  if (due('press-deadlines', 60_000)) await checkPressDeadlines().catch((e) => log('warn', 'press', `Fristen: ${e.message}`));
  if (s['backup.enabled'] && due('backup-check', 10 * 60_000)) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: s['general.timezone'] }));
    if (now.getHours() === s['backup.hour']) {
      const today = await one(`SELECT 1 FROM backups WHERE trigger = 'schedule' AND started_at > now() - interval '20 hours'`);
      if (!today) await runBackup('schedule', null).catch(() => {});
    }
  }
}

/**
 * Niedrigere CPU-Priorität für den Worker (#192): Medienprüfung (sharp, ffmpeg), ZIP-Exporte und Sicherungen laufen
 * im selben Container wie die API (Standard 2 CPUs). Mit nice 10 bekommt die API bei Volllast zuerst Rechenzeit –
 * Seiten und Anmeldungen bleiben flüssig, die Hintergrundarbeit dauert nur etwas länger. ffmpeg, pg_dump und die
 * sharp-Threads erben die Priorität. Erhöhen der nice-Stufe braucht keine besonderen Rechte.
 */
const WORKER_NICE = 10;
function lowerPriority() {
  try {
    if (os.getPriority() < WORKER_NICE) os.setPriority(WORKER_NICE);
  } catch (e) {
    log('warn', 'worker', `CPU-Priorität nicht gesenkt: ${(e as Error).message}`);
  }
}

async function main() {
  masterKey();
  lowerPriority();
  await migrate((m) => log('info', 'migrate', m));
  ensureMediaDirs();
  // Zugangsdaten im Klartext (Altbestand, Import) in den verschlüsselten Speicher verschieben bzw. melden (#190)
  await migratePlaintextSecrets().catch((e) => log('warn', 'security', `Prüfung auf Zugangsdaten im Klartext fehlgeschlagen: ${e.message}`));
  const startedAt = new Date();
  log('info', 'worker', `Worker ${WORKER_ID} gestartet (BlaulichtCMS ${config.version})`);

  // Eigene Verbindung für LISTEN/NOTIFY und den Leader-Lock (Zeitpläne, MQTT, Wartung nur einmal)
  const listener = new pg.Client({ connectionString: config.databaseUrl, application_name: 'blaulichtcms-worker-listen' });
  await listener.connect();
  await listener.query('LISTEN blaulichtcms_jobs');
  let isLeader = false;
  listener.on('notification', (n) => {
    if (n.channel === 'blaulichtcms_jobs') pump().catch(() => {});
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
