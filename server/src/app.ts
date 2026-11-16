import { getSettings } from './lib/settings.js';
import { one } from './db/pool.js';
import { sha256Hex } from './lib/crypto.js';
import { uploadLinkUrl } from './routes/media.js';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import { z, ZodError } from 'zod';

// Prüfmeldungen auf Deutsch (statt „Too small: expected …“)
z.config(z.locales.de());

/** Lesbare Feldnamen für Prüfmeldungen (API-Pfad → Bezeichnung in der Oberfläche). */
const FIELD_LABELS: Record<string, string> = {
  title: 'Titel', body: 'Text', excerpt: 'Kurzfassung', text: 'Text', name: 'Name', email: 'E-Mail-Adresse', password: 'Passwort',
  days: 'Gültigkeit (Tage)', maxFiles: 'Dateien je Link', label: 'Bezeichnung', purpose: 'Zweck', note: 'Hinweis', url: 'Adresse',
  startsAt: 'Beginn', endsAt: 'Ende', linkUrl: 'Link', linkText: 'Linktext', priority: 'Priorität', tone: 'Art', siteId: 'Website',
  code: 'Kürzel', key: 'Schlüssel', options: 'Antworten', conditions: 'Bedingungen', level: 'Warnstufe', reason: 'Begründung',
  recipients: 'Empfänger', area: 'Gebiet', host: 'Server', port: 'Port', from: 'Absender', testRecipient: 'Testempfänger', to: 'Empfänger',
  intervalMinutes: 'Abrufintervall', ars: 'Regionalschlüssel', size: 'Dateigröße', roles: 'Rollen', publishAt: 'Termin',
};
/** Häufige Prüffehler in Alltagssprache; alles Übrige liefert das deutsche Zod-Sprachpaket. */
function issueText(i: any): string {
  if (i.message && !/^(Zu |Ungültig|Invalid|Too )/.test(i.message)) return i.message; // eigene Meldungen aus den Schemas
  const n = (x: unknown) => Number(x).toLocaleString('de-DE');
  if (i.code === 'too_small' && i.origin === 'string') return Number(i.minimum) <= 1 ? 'darf nicht leer sein' : `mindestens ${n(i.minimum)} Zeichen`;
  if (i.code === 'too_big' && i.origin === 'string') return `höchstens ${n(i.maximum)} Zeichen`;
  if (i.code === 'too_small' && (i.origin === 'number' || i.origin === 'int')) return `mindestens ${n(i.minimum)}`;
  if (i.code === 'too_big' && (i.origin === 'number' || i.origin === 'int')) return `höchstens ${n(i.maximum)}`;
  if (i.code === 'too_small' && i.origin === 'array') return Number(i.minimum) <= 1 ? 'mindestens ein Eintrag' : `mindestens ${n(i.minimum)} Einträge`;
  if (i.code === 'too_big' && i.origin === 'array') return `höchstens ${n(i.maximum)} Einträge`;
  if (i.code === 'invalid_format' && i.format === 'email') return 'keine gültige E-Mail-Adresse';
  if (i.code === 'invalid_format' && i.format === 'url') return 'keine gültige Adresse';
  if (i.code === 'invalid_format' && i.format === 'datetime') return 'kein gültiger Zeitpunkt';
  if (i.code === 'invalid_type') return 'fehlt oder hat das falsche Format';
  if (i.code === 'invalid_value') return 'ist kein erlaubter Wert';
  return i.message;
}

function fieldLabel(path: string): string {
  const parts = path.split('.');
  for (let i = parts.length - 1; i >= 0; i--) if (FIELD_LABELS[parts[i]]) return FIELD_LABELS[parts[i]];
  return path;
}
import { config } from './config.js';
import { CSRF_HEADER, resolveAuth } from './auth/context.js';
import { AppError } from './lib/errors.js';
import { auditThrottled } from './lib/audit.js';
import { log } from './lib/log.js';
import { simplePage } from './lib/error-page.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { roleRoutes } from './routes/roles.js';
import { collectRouteAccess, type RouteEntry } from './auth/route-access.js';
import { systemRoutes } from './routes/system.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { mediaRoutes } from './routes/media.js';
import { mediaOrganizeRoutes } from './routes/media-organize.js';
import { mediaTrashRoutes } from './routes/media-trash.js';
import { mediaAdminRoutes } from './routes/media-admin.js';
import { mediaDesignRoutes } from './routes/media-design.js';
import { postRoutes } from './routes/posts.js';
import { bridgeRoutes } from './routes/bridge.js';
import { uploadRoutes } from './routes/uploads.js';
import { bannerRoutes } from './routes/banners.js';
import { eventRoutes, stopEvents } from './routes/events.js';
import { rssRoutes } from './routes/rss.js';
import { warningRoutes } from './routes/warnings.js';
import { connectionRoutes } from './routes/connections.js';
import { privacyRoutes } from './routes/privacy.js';
import { updateRoutes } from './routes/updates.js';
import { automationRoutes } from './routes/automations.js';
import { legalRoutes } from './routes/legal.js';
import { notifyChannelRoutes } from './routes/notify-channels.js';
import { healthStatus, isLocalHealthRequest, publicHealth } from './routes/health.js';

export const PERMISSIONS_POLICY = [
  'accelerometer=()', 'ambient-light-sensor=()', 'autoplay=(self)', 'bluetooth=()', 'browsing-topics=()', 'camera=()',
  'display-capture=()', 'encrypted-media=()', 'fullscreen=(self)', 'geolocation=()', 'gyroscope=()', 'hid=()',
  'idle-detection=()', 'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'picture-in-picture=(self)',
  'publickey-credentials-get=()', 'screen-wake-lock=()', 'serial=()', 'usb=()', 'xr-spatial-tracking=()',
].join(', ');

/**
 * Verweigerte Zugriffe (fehlendes Recht, fehlende CSRF-Kennung) im Audit (#111). Gedrosselt je Person bzw. IP und
 * Route auf einen Eintrag in 10 Minuten, damit eine Oberfläche mit fehlendem Recht das Audit nicht flutet.
 * „Bitte bestätigen“ (reauth_required) ist kein Angriffszeichen und bleibt außen vor.
 */
const DENIED_AUDIT_CODES = new Set(['forbidden', 'csrf']);
/** Pfad ohne Schlüssel (Routenvorlage bevorzugt; sonst Tokens in bekannten Pfaden maskiert). */
export function safePath(req: FastifyRequest): string {
  return req.routeOptions?.url ?? redactPath(req.url);
}
export function redactPath(url: string): string {
  return url
    .split('?')[0]
    .replace(/^(\/api\/v1\/inbound\/fe2\/[^/]+\/)[^/]+/, '$1***')
    .replace(/^(\/u\/|\/l\/|\/einladung\/|\/api\/v1\/public\/upload\/|\/api\/v1\/auth\/invite\/|\/api\/v1\/m\/)[^/]+/, '$1***');
}

async function auditDenied(req: FastifyRequest, code: string) {
  const route = `${req.method} ${safePath(req)}`;
  const actor = req.auth?.actor ?? { id: null, name: 'nicht angemeldet', type: 'user' as const, ip: req.ip };
  await auditThrottled(`denied:${actor.id ?? req.ip}:${route}`, 10 * 60_000, actor, 'access.denied', { type: 'route', label: route }, { grund: code === 'csrf' ? 'ohne Sicherheitskennung' : 'fehlendes Recht' }, 'denied').catch(() => {});
}

/**
 * Im Wartungsmodus bleiben nur Anmeldung, Abmeldung, das Beenden des Wartungsmodus und die In-App-Updates möglich
 * (die Installation schaltet den Wartungsmodus selbst ein).
 */
const MAINTENANCE_ALLOWED = ['/api/v1/auth/', '/api/v1/system/maintenance', '/api/v1/notifications/read', '/api/v1/updates/'];
async function assertNotMaintenance() {
  const m = (await getSettings())['system.maintenance'];
  if (m) throw new AppError(503, 'maintenance', `Wartung: ${m.reason || 'Update wird vorbereitet'}. Änderungen sind kurz nicht möglich.`);
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Alle Routen unter /api/v1 mit ihrer Zugriffsangabe (auth/route-access.ts) */
    routeAccess: RouteEntry[];
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Nur die eingetragenen Proxys dürfen die Client-IP per X-Forwarded-For setzen (#92)
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Stylesheets nur als Dateien (#132): keine <style>-Elemente mehr, also kein 'unsafe-inline' für Stylesheets
        // (CSS-Injektion mit Attributselektoren zur Datenausleitung ist damit gesperrt). Nur style-Attribute bleiben
        // erlaubt – React setzt Laufzeitwerte (Breiten, Positionen) darüber; ein Attribut kann keine Selektoren
        // enthalten und Bilder nur von img-src ('self', data:, blob:) laden. Abwägung in docs/sicherheitspruefung.md.
        styleSrc: ["'self'"],
        styleSrcElem: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
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
    strictTransportSecurity: config.cookieSecure ? { maxAge: config.hsts.maxAge, includeSubDomains: config.hsts.includeSubDomains, preload: config.hsts.preload } : false,
    xFrameOptions: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  // Browser-Funktionen, die BlaulichtCMS nicht braucht, für die eigene Seite und eingebettete Inhalte abschalten (#132).
  // Kamera bleibt aus: Fotos kommen über das Dateifeld (Kamera-App des Geräts), nicht über getUserMedia.
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('permissions-policy', PERMISSIONS_POLICY);
  });
  // Komprimierung für API-Antworten (JSON, SVG); Medien sind bereits komprimiert und bleiben unangetastet
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'], customTypes: /^(application\/json|image\/svg\+xml|text\/(html|plain|css|javascript))/, brotliOptions: { params: { 1: 4 } } as any });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1, fields: 10 } });

  app.decorateRequest('auth', null);
  // Routentabelle mit Zugriffsangaben (Tests: Vollständigkeit und 403-Matrix)
  app.decorate('routeAccess', collectRouteAccess(app));

  app.setErrorHandler(async (err: any, req, reply) => {
    if (err instanceof AppError && err.status === 403 && DENIED_AUDIT_CODES.has(err.code) && req.url.startsWith('/api/')) await auditDenied(req, err.code);
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details ?? null });
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'Eingaben sind unvollständig oder ungültig.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), label: i.path.length ? fieldLabel(i.path.join('.')) : null, message: issueText(i) })),
      });
    }
    // Datenbank-Konflikte aus gleichzeitigen Änderungen (#174): eindeutiger Index bzw. inzwischen gelöschter
    // Bezug. Verständliche 409-Meldung statt „Interner Fehler“; das Systemprotokoll erhält einen Hinweis.
    if (err.code === '23505' || err.code === '23503') {
      log('warn', 'api', `Datenbank-Konflikt (${err.code}): ${err.constraint ?? err.message}`, { route: req.routeOptions?.url }, String(req.id));
      return reply.status(409).send({
        error: 'conflict',
        message: err.code === '23505' ? 'Dieser Eintrag ist bereits vorhanden. Bitte die Ansicht neu laden.' : 'Ein zugehöriger Eintrag wurde inzwischen gelöscht. Bitte die Ansicht neu laden.',
      });
    }
    if (err.statusCode === 429) {
      // Wartezeit auch im Inhalt, damit die Oberfläche sie ohne Header-Zugriff anzeigen kann (#194)
      const retryAfter = Number(reply.getHeader('retry-after')) || null;
      return reply.status(429).send({ error: 'rate_limited', message: retryAfter ? `Zu viele Anfragen. Bitte ${retryAfter} Sekunden warten.` : 'Zu viele Anfragen. Bitte kurz warten.', details: { retryAfter } });
    }
    if (err.statusCode === 400 && String(err.code ?? '').startsWith('FST_ERR_CTP')) return reply.status(400).send({ error: 'invalid_request', message: 'Der Inhalt der Anfrage ist kein gültiges JSON.' });
    if (err.statusCode === 413) return reply.status(413).send({ error: 'too_large', message: 'Die Anfrage ist zu groß.' });
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
    req.auth = await resolveAuth(req, reply);
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
      await api.register(roleRoutes);
      await api.register(systemRoutes);
      await api.register(dashboardRoutes);
      await api.register(mediaRoutes);
      await api.register(mediaOrganizeRoutes);
      await api.register(mediaTrashRoutes);
      await api.register(mediaAdminRoutes);
      await api.register(mediaDesignRoutes);
      await api.register(postRoutes);
      await api.register(bridgeRoutes);
      await api.register(uploadRoutes);
      await api.register(bannerRoutes);
      await api.register(eventRoutes);
      await api.register(rssRoutes);
      await api.register(warningRoutes);
      await api.register(connectionRoutes);
      await api.register(privacyRoutes);
      await api.register(updateRoutes);
      await api.register(automationRoutes);
      await api.register(legalRoutes);
      await api.register(notifyChannelRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Befristete Weiterleitung übernommener Alt-Links (Import) auf den neuen Upload-Link
  app.get('/l/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(token)) return reply.status(404).send('Nicht gefunden.');
    const row = await one<any>(
      `SELECT l.id, l.token_enc FROM legacy_links g JOIN upload_links l ON l.id = g.link_id
        WHERE g.old_token_hash = $1 AND g.expires_at > now() AND l.revoked_at IS NULL AND l.paused_at IS NULL AND l.expires_at > now() AND l.token_enc IS NOT NULL`,
      [sha256Hex(token)],
    );
    if (!row) return reply.status(410).type('text/html; charset=utf-8').send(simplePage('Link ungültig', 'Dieser Upload-Link ist nicht mehr gültig. Bitte bei der Redaktion einen neuen Link erfragen.', { code: '410' }));
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    return reply.redirect((await uploadLinkUrl(req, row.token_enc, row.id))!, 302);
  });

  // Gesundheit: 200 nur, wenn BlaulichtCMS Aufträge annehmen kann (Datenbank, Schema, Worker, Speicher)
  // Öffentlich nur Status je Prüfung; Version und Details nur für Aufrufe aus dem Container selbst (#125)
  app.get('/healthz', async (req, reply) => {
    const h = await healthStatus();
    reply.header('cache-control', 'no-store');
    return reply.status(h.ok ? 200 : 503).send(isLocalHealthRequest(req.socket.remoteAddress, req.headers) ? h : publicHealth(h));
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
      // Fehlende Dateien (Skripte einer älteren Fassung, Bilder …) bekommen eine echte 404 statt der App – sonst
      // scheitert das Nachladen mit einem MIME-Fehler. Seiten ohne Dateiendung zeigt die App selbst (Seite nicht gefunden).
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && !p.startsWith('/api/') && (p.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(p))) {
        reply.header('cache-control', 'no-store');
        if (!/\.html?$/i.test(p) && !String(req.headers.accept ?? '').includes('text/html')) return reply.status(404).type('text/plain; charset=utf-8').send('Nicht gefunden.');
        return reply.status(404).type('text/html; charset=utf-8').send(simplePage('Seite nicht gefunden', 'Diese Adresse gibt es nicht (mehr). Bitte den Link prüfen oder zur Startseite wechseln.', { code: '404', link: { href: '/', label: 'Zur Startseite' } }));
      }
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
