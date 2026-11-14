import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { upcomingBannerEnds } from '../content/banners.js';
import { systemStatus } from './system.js';

const RANGES = {
  '24h': { interval: '24 hours', bucket: 'hour', buckets: 24 },
  '7d': { interval: '7 days', bucket: 'day', buckets: 7 },
  '30d': { interval: '30 days', bucket: 'day', buckets: 30 },
} as const;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', { preHandler: requireAuth('run.read') }, async (req) => {
    const { range } = z.object({ range: z.enum(['24h', '7d', '30d']).default('24h') }).parse(req.query);
    const r = RANGES[range];
    const series = await many<any>(
      `WITH b AS (SELECT generate_series(date_trunc('${r.bucket}', now()) - interval '${r.buckets - 1} ${r.bucket}', date_trunc('${r.bucket}', now()), interval '1 ${r.bucket}') AS t)
       SELECT b.t,
              count(x.id) FILTER (WHERE x.status = 'success')::int AS ok,
              count(x.id) FILTER (WHERE x.status IN ('error','dead','needs_review'))::int AS err
         FROM b LEFT JOIN runs x ON x.mode = 'production' AND date_trunc('${r.bucket}', x.created_at) = b.t
        GROUP BY b.t ORDER BY b.t`,
    );
    const totals = await one<any>(
      `SELECT count(*) FILTER (WHERE status = 'success')::int AS ok,
              count(*) FILTER (WHERE status IN ('error','dead','needs_review'))::int AS err,
              count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('queued','running','waiting'))::int AS running
         FROM runs WHERE mode = 'production' AND created_at > now() - interval '${r.interval}'`,
    );
    const prev = await one<any>(
      `SELECT count(*) FILTER (WHERE status = 'success')::int AS ok, count(*) FILTER (WHERE status IN ('error','dead','needs_review'))::int AS err
         FROM runs WHERE mode = 'production' AND created_at BETWEEN now() - 2 * interval '${r.interval}' AND now() - interval '${r.interval}'`,
    );
    const workflows = await one<any>(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status <> 'archived')::int AS total FROM workflows`);
    const conns = await one<any>(`SELECT count(*) FILTER (WHERE status = 'ok')::int AS ok, count(*) FILTER (WHERE status <> 'disabled')::int AS total, count(*) FILTER (WHERE status IN ('error','warning'))::int AS problems FROM connections`);
    const events = await one<any>(`SELECT count(*)::int AS n FROM event_receipts WHERE received_at > now() - interval '24 hours'`);
    const eventSeries = await many<any>(
      `WITH b AS (SELECT generate_series(date_trunc('hour', now()) - interval '23 hour', date_trunc('hour', now()), interval '1 hour') AS t)
       SELECT b.t, count(e.id)::int AS n FROM b LEFT JOIN event_receipts e ON date_trunc('hour', e.received_at) = b.t GROUP BY b.t ORDER BY b.t`,
    );
    const recent = await many<any>(
      `SELECT r.id, r.workflow_id, w.name AS workflow_name, r.trigger_kind, r.trigger_label, r.status, r.created_at, r.duration_ms, r.mode
         FROM runs r JOIN workflows w ON w.id = r.workflow_id ORDER BY r.id DESC LIMIT 8`,
    );
    const failures = await many<any>(
      `SELECT r.id, w.name AS workflow_name, r.summary, r.created_at, r.error_code FROM runs r JOIN workflows w ON w.id = r.workflow_id
        WHERE r.mode = 'production' AND r.status IN ('error','dead','needs_review') AND r.created_at > now() - interval '24 hours' ORDER BY r.id DESC LIMIT 5`,
    );
    const approvals = await many<any>(
      `SELECT v.id, v.number, w.id AS workflow_id, w.name, v.requested_at, u.name AS requested_by FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
         LEFT JOIN users u ON u.id = v.requested_by WHERE v.state = 'pending_approval' ORDER BY v.requested_at`,
    );
    const expiring = await many<any>(
      `SELECT id, name, credentials_expire_at FROM connections WHERE credentials_expire_at IS NOT NULL AND credentials_expire_at < now() + interval '30 days' AND status <> 'disabled' ORDER BY credentials_expire_at`,
    );
    const status = await systemStatus();
    const lastUpdated = await one<any>(`SELECT max(updated_at) AS t FROM jobs`);
    return {
      range,
      kpis: {
        activeWorkflows: { value: workflows.active, total: workflows.total },
        successful: { value: totals.ok, previous: prev.ok, spark: series.map((s) => s.ok) },
        failed: { value: totals.err, previous: prev.err, spark: series.map((s) => s.err) },
        connected: { value: conns.ok, total: conns.total, problems: conns.problems },
        events24h: { value: events.n, spark: eventSeries.map((s) => s.n) },
        running: totals.running,
      },
      series: series.map((s) => ({ t: s.t, ok: s.ok, err: s.err })),
      totalRuns: totals.total,
      services: status.services,
      connections: status.connections,
      queue: status.queue,
      recent,
      failures,
      approvals,
      expiring,
      bannerEnds: req.auth!.permissions.has('wordpress.read') ? await upcomingBannerEnds(5) : [],
      lastActivityAt: lastUpdated?.t ?? null,
    };
  });
}
