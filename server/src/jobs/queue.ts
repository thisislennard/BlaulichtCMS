import os from 'node:os';
import { many, pool, tx, type Queryable } from '../db/pool.js';

/**
 * Persistente Warteschlange in PostgreSQL: Jobs werden mit Lease beansprucht
 * (FOR UPDATE SKIP LOCKED), per Heartbeat verlängert und nach Lease-Ablauf (Absturz) erneut
 * vergeben. Wiederholungen mit exponentiellem Backoff + Jitter, danach „dead“.
 */
export const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LEASE_SEC = 60;

export interface Job {
  id: number;
  kind: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupKey?: string; maxAttempts?: number } = {},
  db: Queryable = pool,
): Promise<number | null> {
  const res = await db.query(
    `INSERT INTO jobs (kind, payload, run_at, dedup_key, max_attempts)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('queued','running') DO NOTHING
     RETURNING id`,
    [kind, JSON.stringify(payload), opts.runAt ?? null, opts.dedupKey ?? null, opts.maxAttempts ?? 5],
  );
  if (res.rows[0]) await db.query("SELECT pg_notify('blaulichtcms_jobs', $1)", [kind]);
  return res.rows[0]?.id ?? null;
}

/**
 * Folgejob aus einem laufenden Job heraus einplanen (Wiederholung, Warten). Der aufrufende Job hält denselben
 * dedup_key noch im Status „running“ – ON CONFLICT würde den Folgejob sonst still verwerfen und der Lauf hinge.
 */
export async function enqueueFollowUp(kind: string, payload: Record<string, unknown>, runAt: Date, dedupKey: string): Promise<void> {
  await tx(async (db) => {
    await db.query(`UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = now() WHERE dedup_key = $1 AND status = 'running'`, [dedupKey]);
    const id = await enqueue(kind, payload, { runAt, dedupKey }, db);
    if (id === null) throw new Error(`Folgejob ${dedupKey} konnte nicht eingeplant werden.`);
  });
}

/**
 * @param busy Jobs, die dieser Worker gerade selbst ausführt – nie ein zweites Mal beanspruchen.
 * @param filter nur diese Arten (`kinds`) bzw. alle außer diesen (`excludeKinds`)
 */
export async function claimJobs(limit: number, busy: number[] = [], filter: { kinds?: readonly string[]; excludeKinds?: readonly string[] } = {}): Promise<Job[]> {
  if (limit <= 0) return [];
  return many<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + make_interval(secs => $2),
            locked_by = $3, updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE ((status = 'queued' AND run_at <= now()) OR (status = 'running' AND lease_until < now()))
           AND NOT (id = ANY($4::bigint[]))
           AND ($5::text[] IS NULL OR kind = ANY($5::text[]))
           AND ($6::text[] IS NULL OR NOT (kind = ANY($6::text[])))
         ORDER BY run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, payload, attempts, max_attempts`,
    [limit, LEASE_SEC, WORKER_ID, busy, filter.kinds ? [...filter.kinds] : null, filter.excludeKinds ? [...filter.excludeKinds] : null],
  );
}

/**
 * Aufträge, die auf fremde Dienste warten (soziale Netzwerke, Workflows mit Aktionen, Presseversand, NAS) und dabei
 * lange brauchen oder hängen können (#240). Sie dürfen nie alle Plätze belegen: Warnversand, Benachrichtigungen,
 * Medienprüfung und Exporte behalten immer mindestens einen Platz.
 */
export const EXTERNAL_KINDS = ['social.publish', 'automation.run', 'press.reply', 'press.release', 'backup.offsite', 'backup.drill'] as const;
export const isExternalKind = (kind: string) => (EXTERNAL_KINDS as readonly string[]).includes(kind);

/**
 * Plätze für den nächsten Abruf: `free` insgesamt, davon höchstens `external` für EXTERNAL_KINDS. Reserviert bleibt
 * ein Viertel der Plätze (mindestens einer); bei nur einem Platz insgesamt ist nichts zu reservieren.
 */
export function slotPlan(concurrency: number, runningKinds: string[]): { free: number; external: number } {
  const cap = Math.max(1, Math.min(32, Math.floor(concurrency) || 1));
  const free = Math.max(0, cap - runningKinds.length);
  const reserved = cap >= 2 ? Math.max(1, Math.floor(cap / 4)) : 0;
  const externalRunning = runningKinds.filter(isExternalKind).length;
  return { free, external: Math.min(free, Math.max(0, cap - reserved - externalRunning)) };
}

/**
 * Freie Plätze füllen: zuerst Aufträge mit fremden Diensten bis zu ihrer Grenze, den Rest mit allen anderen Arten.
 * @param running Aufträge, die dieser Worker gerade ausführt
 */
export async function claimForSlots(concurrency: number, running: { id: number; kind: string }[]): Promise<Job[]> {
  const plan = slotPlan(concurrency, running.map((r) => r.kind));
  if (!plan.free) return [];
  const busy = running.map((r) => r.id);
  const jobs = plan.external ? await claimJobs(plan.external, busy, { kinds: EXTERNAL_KINDS }) : [];
  const rest = plan.free - jobs.length;
  if (rest > 0) jobs.push(...(await claimJobs(rest, [...busy, ...jobs.map((j) => j.id)], { excludeKinds: EXTERNAL_KINDS })));
  return jobs;
}

/** Abgelaufene Leases (abgestürzter Worker) zurück in die Warteschlange, ohne sie zu beanspruchen (Wartungsmodus). */
export async function requeueExpiredLeases() {
  await pool.query(`UPDATE jobs SET status = 'queued', lease_until = NULL, locked_by = NULL, updated_at = now() WHERE status = 'running' AND lease_until < now()`);
}

/** Lease alle 20 s verlängern, solange der Auftrag läuft (Lease 60 s). */
export const HEARTBEAT_MS = 20_000;

export async function heartbeatJob(id: number) {
  await pool.query(`UPDATE jobs SET lease_until = now() + make_interval(secs => $2), updated_at = now() WHERE id = $1 AND locked_by = $3`, [id, LEASE_SEC, WORKER_ID]);
}

export async function completeJob(id: number) {
  await pool.query(`UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = now() WHERE id = $1`, [id]);
}

export function backoffMs(attempt: number, baseMs = 5_000, maxMs = 15 * 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

/** Fehlgeschlagener Job: erneut einplanen oder endgültig als „dead“ markieren. */
export async function failJob(job: Job, error: string, retryAfterMs?: number): Promise<'retry' | 'dead'> {
  if (job.attempts >= job.max_attempts) {
    await pool.query(`UPDATE jobs SET status = 'dead', last_error = $2, lease_until = NULL, updated_at = now() WHERE id = $1`, [job.id, error.slice(0, 2000)]);
    return 'dead';
  }
  const delay = retryAfterMs ?? backoffMs(job.attempts);
  await pool.query(
    `UPDATE jobs SET status = 'queued', last_error = $2, lease_until = NULL, run_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
    [job.id, error.slice(0, 2000), delay / 1000],
  );
  return 'retry';
}

export async function queueStats() {
  const r = await pool.query(`SELECT
      count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS ready,
      count(*) FILTER (WHERE status = 'queued' AND run_at > now())::int AS scheduled,
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'dead')::int AS dead,
      COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())), 0)::int AS oldest_ready_sec
    FROM jobs`);
  return r.rows[0] as { ready: number; scheduled: number; running: number; dead: number; oldest_ready_sec: number };
}
