import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { badRequest } from '../lib/errors.js';
import { postState } from './posts.js';

export async function dashboardRoutes(app: FastifyInstance) {
  /** Erstes Dashboard: offene Freigaben, bestätigter Veröffentlichungsstand, Medieneingang, Kanäle. */
  app.get('/dashboard', { preHandler: requireAuth() }, async (req) => {
    const perms = req.auth!.permissions;
    const out: Record<string, unknown> = {};
    if (perms.has('post.read')) {
      const submitted = await many<any>(
        `SELECT p.id, r.title, r.number, r.submitted_at, u.name AS submitted_by_name
           FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
           LEFT JOIN users u ON u.id = r.submitted_by
          WHERE p.archived_at IS NULL AND r.submitted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id = r.id AND a.revoked_at IS NULL AND a.decided_at >= r.submitted_at)
          ORDER BY r.submitted_at LIMIT 20`,
      );
      out.pendingApprovals = submitted;
      const approved = await many<any>(
        `SELECT p.id FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
          WHERE p.archived_at IS NULL AND EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id = r.id AND a.decision = 'approved' AND a.revoked_at IS NULL AND a.content_hash = r.content_hash)
          ORDER BY p.updated_at DESC LIMIT 20`,
      );
      const readyToPublish = [];
      for (const a of approved) {
        const st = await postState(a.id);
        if (st && st.state === 'approved') readyToPublish.push({ id: a.id, title: st.current.title, number: st.current.number, site_id: st.current.site_id });
      }
      out.readyToPublish = readyToPublish;
      out.publications = await many<any>(
        `SELECT pb.id, pb.post_id, pb.status, pb.remote_url, pb.error, pb.created_at, pb.fetched_at, pb.result_at, r.title, r.number AS revision_number, s.name AS site_name
           FROM publications pb JOIN post_revisions r ON r.id = pb.revision_id JOIN wp_sites s ON s.id = pb.site_id
          ORDER BY pb.created_at DESC LIMIT 15`,
      );
      out.sites = await many<any>(`SELECT id, name, status, site_url, last_seen_at, plugin_version FROM wp_sites WHERE status <> 'revoked' ORDER BY name`);
    }
    if (perms.has('media.read')) {
      out.media = await one<any>(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
                count(*) FILTER (WHERE status = 'quarantine')::int AS quarantine,
                count(*) FILTER (WHERE status = 'ready' AND selection = 'pending')::int AS unreviewed,
                count(*) FILTER (WHERE status = 'rejected' AND created_at > now() - interval '7 days')::int AS rejected_7d
           FROM media WHERE deleted_at IS NULL`,
      );
      out.recentCollections = await many<any>(
        `SELECT c.id, c.title, max(m.created_at) AS last_upload, count(m.id)::int AS uploads
           FROM collections c JOIN media m ON m.collection_id = c.id AND m.deleted_at IS NULL
          WHERE m.created_at > now() - interval '7 days' GROUP BY c.id ORDER BY last_upload DESC LIMIT 6`,
      );
    }
    return out;
  });

  /** QR-Code lokal erzeugen (SVG). Der Code enthält nur die URL – Rechte, Ablauf und Widerruf gelten weiter. */
  app.post('/qr', { preHandler: requireAuth(), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    if (!/^https?:\/\//i.test(text)) throw badRequest('Nur Web-Adressen können als QR-Code angezeigt werden.');
    const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } });
    return reply.type('image/svg+xml').header('cache-control', 'private, max-age=600').send(svg);
  });
}
