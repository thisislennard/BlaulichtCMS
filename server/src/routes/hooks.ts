import type { FastifyInstance } from 'fastify';
import { handleIncomingWebhook } from '../engine/triggers.js';
import { log } from '../lib/log.js';

/** Öffentlicher Eingang für Webhooks (/hooks/<token>). Liest den Rohtext für die Signaturprüfung. */
export async function hookRoutes(app: FastifyInstance) {
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    hooks.post(
      '/hooks/:token',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const { token } = req.params as { token: string };
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return reply.status(404).send({ error: 'unknown_webhook' });
        try {
          const res = await handleIncomingWebhook(token, {
            method: req.method,
            headers: req.headers,
            query: (req.query ?? {}) as Record<string, unknown>,
            rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
            ip: req.ip,
          });
          return reply.status(res.status).header('cache-control', 'no-store').send(res.body);
        } catch (e) {
          log('error', 'webhook', `Webhook-Verarbeitung fehlgeschlagen: ${(e as Error).message}`);
          return reply.status(503).send({ error: 'unavailable', message: 'Vorübergehend nicht verfügbar, bitte später erneut senden.', retryable: true });
        }
      },
    );
  });
}
