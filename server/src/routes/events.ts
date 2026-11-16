import pg from 'pg';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../auth/context.js';
import { log } from '../lib/log.js';
import { invalidateRoles } from '../auth/roles.js';

/**
 * Live-Status per Server-Sent Events. Ereignisse enthalten nur den Namen der geänderten Tabelle –
 * die Oberfläche lädt daraufhin den bestätigten Stand über die normale API (mit Rechteprüfung).
 * Nach einem Verbindungsabbruch lädt der Client grundsätzlich alles neu.
 */
const clients = new Set<FastifyReply>();
let listener: pg.Client | null = null;
let starting: Promise<void> | null = null;
const pending = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const data = JSON.stringify({ tables: [...pending] });
  pending.clear();
  for (const c of clients) c.raw.write(`event: change\ndata: ${data}\n\n`);
}

async function ensureListener() {
  if (listener) return;
  if (starting) return starting;
  starting = (async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl, application_name: 'blaulichtcms-api-events' });
    c.on('notification', (n) => {
      if (n.payload) pending.add(n.payload);
      // Rollen geändert (auch von einem anderen Prozess): Rechte ab der nächsten Anfrage neu laden
      if (n.payload === 'roles') invalidateRoles();
      // Mehrere Änderungen kurz hintereinander zu einem Ereignis bündeln
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    });
    c.on('error', (e) => {
      log('warn', 'events', `Ereignisverbindung verloren: ${e.message}`);
      listener = null;
      for (const r of clients) r.raw.end();
      clients.clear();
    });
    await c.connect();
    await c.query('LISTEN blaulichtcms_events');
    listener = c;
  })().finally(() => (starting = null));
  return starting;
}

export async function stopEvents() {
  for (const r of clients) r.raw.end();
  clients.clear();
  await listener?.end().catch(() => {});
  listener = null;
}

export async function eventRoutes(app: FastifyInstance) {
  app.get('/events', { preHandler: requireAuth() }, async (req, reply) => {
    await ensureListener();
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
    clients.add(reply);
    const beat = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(beat);
      clients.delete(reply);
    });
  });
}
