import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { CSRF_HEADER, resolveAuth } from './auth/context.js';
import { AppError } from './lib/errors.js';
import { log } from './lib/log.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { systemRoutes } from './routes/system.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { mediaRoutes } from './routes/media.js';
import { postRoutes } from './routes/posts.js';
import { bridgeRoutes } from './routes/bridge.js';
import { healthStatus } from './routes/health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    strictTransportSecurity: config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: false } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1, fields: 10 } });

  app.decorateRequest('auth', null);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details ?? null });
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'Eingaben sind unvollständig oder ungültig.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Zu viele Anfragen. Bitte kurz warten.' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'invalid_request', message: err.message });
    log('error', 'api', `Unerwarteter Fehler: ${err.message}`, { route: req.routeOptions?.url, stack: String(err.stack ?? '').slice(0, 2000) }, String(req.id));
    return reply.status(500).send({ error: 'internal', message: 'Interner Fehler. Details stehen im Systemprotokoll.', request_id: req.id });
  });

  // Authentisierung + CSRF-Schutz für die API
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    // Die Bridge authentisiert sich per eigenem Schlüssel und nutzt keine Cookies
    if (req.url.startsWith('/api/v1/bridge/')) return;
    req.auth = await resolveAuth(req);
    const changing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (changing && req.auth?.kind !== 'api_key' && req.headers[CSRF_HEADER] !== '1') {
      throw new AppError(403, 'csrf', 'Anfrage ohne Sicherheitskennung abgelehnt.');
    }
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(systemRoutes);
      await api.register(dashboardRoutes);
      await api.register(mediaRoutes);
      await api.register(postRoutes);
      await api.register(bridgeRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Gesundheit: 200 nur, wenn LifeLink Aufträge annehmen kann (Datenbank, Schema, Worker, Speicher)
  app.get('/healthz', async (_req, reply) => {
    const h = await healthStatus();
    return reply.status(h.ok ? 200 : 503).send(h);
  });

  // Weboberfläche (gebautes React-Frontend) mit SPA-Fallback
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false, maxAge: '1h', immutable: false });
    const indexHtml = fs.readFileSync(path.join(config.webDist, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml);
      }
      return reply.status(404).send({ error: 'not_found', message: 'Nicht gefunden.' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Nicht gefunden.' }));
  }

  return app;
}
