import { getSettings } from './lib/settings.js';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
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
import { uploadRoutes } from './routes/uploads.js';
import { bannerRoutes } from './routes/banners.js';
import { eventRoutes, stopEvents } from './routes/events.js';
import { rssRoutes } from './routes/rss.js';
import { warningRoutes } from './routes/warnings.js';
import { connectionRoutes } from './routes/connections.js';
import { healthStatus } from './routes/health.js';

/** Im Wartungsmodus bleiben nur Anmeldung, Abmeldung und das Beenden des Wartungsmodus möglich. */
const MAINTENANCE_ALLOWED = ['/api/v1/auth/', '/api/v1/system/maintenance', '/api/v1/notifications/read'];
async function assertNotMaintenance() {
  const m = (await getSettings())['system.maintenance'];
  if (m) throw new AppError(503, 'maintenance', `Wartung: ${m.reason || 'Update wird vorbereitet'}. Änderungen sind kurz nicht möglich.`);
}

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
  // Komprimierung für API-Antworten (JSON, SVG); Medien sind bereits komprimiert und bleiben unangetastet
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'], customTypes: /^(application\/json|image\/svg\+xml|text\/(html|plain|css|javascript))/, brotliOptions: { params: { 1: 4 } } as any });
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
    // FE2-Eingang (eigener Zugangsschlüssel) und zeitlich begrenzte Medien-URLs (Abruf durch Meta) ohne Sitzung
    if (req.url.startsWith('/api/v1/inbound/')) return assertNotMaintenance();
    if (req.url.startsWith('/api/v1/m/')) return;
    req.auth = await resolveAuth(req);
    const changing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (changing && req.auth?.kind !== 'api_key' && req.headers[CSRF_HEADER] !== '1') {
      throw new AppError(403, 'csrf', 'Anfrage ohne Sicherheitskennung abgelehnt.');
    }
    if (changing && !MAINTENANCE_ALLOWED.some((p) => req.url.startsWith(p))) await assertNotMaintenance();
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
      await api.register(uploadRoutes);
      await api.register(bannerRoutes);
      await api.register(eventRoutes);
      await api.register(rssRoutes);
      await api.register(warningRoutes);
      await api.register(connectionRoutes);
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
    // Vorkomprimierte Dateien (.br/.gz aus dem Build); Assets mit Hash im Namen ein Jahr cachebar
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      wildcard: false,
      preCompressed: true,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const rel = path.relative(config.webDist, filePath);
        if (rel.startsWith('assets' + path.sep)) res.header('cache-control', 'public, max-age=31536000, immutable');
        else if (rel === 'sw.js' || rel === 'index.html' || rel.endsWith('.webmanifest')) res.header('cache-control', 'no-cache');
        else res.header('cache-control', 'public, max-age=86400');
      },
    });
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

  app.addHook('onClose', async () => stopEvents());
  return app;
}
