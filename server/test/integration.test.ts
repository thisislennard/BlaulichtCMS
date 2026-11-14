import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, one, many } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { executeRun } from '../src/engine/executor.js';
import { completeJob } from '../src/engine/queue.js';
import { setSettings } from '../src/lib/settings.js';
import type { Graph } from '../src/engine/types.js';

/**
 * Durchläufe gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL, Standard lifelink_test).
 * Die Datenbank wird zu Beginn komplett geleert.
 */
let app: FastifyInstance;
let target: http.Server;
let targetPort = 0;
const hits: { path: string; auth?: string; idem?: string; body: string }[] = [];
let failNext = 0;

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as any,
      url: `/api/v1${url}`,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-lifelink-request': '1' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b: unknown = {}) => this.req('POST', u, b);
  put = (u: string, b: unknown = {}) => this.req('PUT', u, b);
  patch = (u: string, b: unknown = {}) => this.req('PATCH', u, b);
}

async function drainRuns() {
  // Worker-Ersatz wie im echten Worker: Auftrag beanspruchen (running), ausführen, abschließen
  for (let i = 0; i < 20; i++) {
    const jobs = await many<any>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '60 seconds'
        WHERE status = 'queued' AND kind = 'run.execute' AND run_at <= now() RETURNING id, payload`,
    );
    if (!jobs.length) return;
    for (const j of jobs) {
      await executeRun(Number(j.payload.runId));
      await completeJob(j.id);
    }
  }
}

const node = (id: string, type: string, key: string, config: Record<string, any> = {}, extra: Record<string, any> = {}) => ({ id, type, key, name: key, position: { x: 0, y: 0 }, config, ...extra });
const edge = (s: string, t: string, port = 'out') => ({ id: `${s}-${port}-${t}`, source: s, sourcePort: port, target: t });

let admin: Client;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  app = await buildApp();
  target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string, body });
      if (req.url?.startsWith('/langsam')) return setTimeout(() => res.end('{}'), 3000);
      if (failNext > 0) {
        failNext--;
        res.statusCode = 503;
        return res.end('nicht bereit');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null, token: 'antwort-ohne-geheimnis' }));
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  targetPort = (target.address() as any).port;
  admin = new Client(app);
});

afterAll(async () => {
  await app?.close();
  target?.close();
  await pool.end();
});

describe('Einrichtung und Anmeldung', () => {
  it('verlangt Einrichtungsschlüssel und CSRF-Header', async () => {
    const st = await admin.get('/auth/state');
    expect(st.json.setupRequired).toBe(true);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.LIFELINK_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    const bad = await admin.post('/auth/setup', { token: 'falsch', name: 'Admin', email: 'admin@test.de', password: 'Langes-Passwort-2026' });
    expect(bad.status).toBe(403);
    // ohne CSRF-Header
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { token, name: 'x', email: 'x@y.de', password: 'Langes-Passwort-2026' } });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await admin.post('/auth/setup', { token, name: 'Admin', email: 'admin@test.de', password: 'Langes-Passwort-2026' });
    expect(ok.status).toBe(200);
    // Admin muss 2FA einrichten (Standard: Pflicht für Admins)
    expect(ok.json.next).toBe('mfa_setup');
    expect((await admin.get('/workflows')).status).toBe(401);
    await setSettings({ 'security.require_2fa_admins': false });
    const login = await admin.post('/auth/login', { email: 'admin@test.de', password: 'Langes-Passwort-2026' });
    expect(login.json.next).toBe('done');
    expect((await admin.get('/workflows')).status).toBe(200);
  });

  it('sperrt nach zu vielen Fehlversuchen', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.post('/auth/login', { email: 'admin@test.de', password: 'falsch' })).status).toBe(401);
    expect((await c.post('/auth/login', { email: 'admin@test.de', password: 'Langes-Passwort-2026' })).status).toBe(423);
    await pool.query(`UPDATE users SET locked_until = NULL, failed_logins = 0`);
  });

  it('prüft Rechte serverseitig (WordPress-Redakteur sieht keine Workflows)', async () => {
    const inv = await admin.post('/users/invite', { email: 'redaktion@test.de', roles: ['wp_editor'] });
    expect(inv.status).toBe(200);
    const token = inv.json.link.split('/einladung/')[1];
    const red = new Client(app);
    const acc = await red.post(`/auth/invite/${token}`, { name: 'Redaktion', password: 'Redaktion-Passwort-2026' });
    expect(acc.json.next).toBe('done');
    expect((await red.get('/workflows')).status).toBe(403);
    expect((await red.get('/banners')).status).toBe(200);
    expect((await red.get('/updates')).status).toBe(403);
    // Einladungslink nur einmal nutzbar
    expect((await new Client(app).post(`/auth/invite/${token}`, { name: 'Xaver', password: 'Noch-ein-Passwort-2026' })).status).toBe(404);
  });
});

describe('Workflow-Ausführung', () => {
  let connId = '';
  it('legt eine REST-Verbindung mit Geheimnis an, ohne es zurückzugeben', async () => {
    const r = await admin.post('/connections', {
      connector: 'http',
      name: 'Testziel',
      config: { baseUrl: `http://127.0.0.1:${targetPort}`, authType: 'bearer', allowPrivate: true },
      secrets: { token: 'super-geheimes-token-123' },
    });
    expect(r.status).toBe(200);
    connId = r.json.id;
    const detail = await admin.get(`/connections/${connId}`);
    expect(JSON.stringify(detail.json)).not.toContain('super-geheimes-token-123');
    expect(detail.json.secret.fields.token.set).toBe(true);
  });

  it('führt einen veröffentlichten Workflow aus, maskiert Geheimnisse und wiederholt vorübergehende Fehler', async () => {
    const wf = await admin.post('/workflows', { name: 'Integrationstest' });
    const graph: Graph = {
      nodes: [
        node('t', 'trigger.manual', 'start', { sample: '{}' }),
        node('m', 'data.set', 'daten', { mappings: [{ key: 'titel', value: 'Hallo {{ start.data.name }}' }] }),
        node('h', 'http.request', 'anfrage', { method: 'PUT', url: '/ziel', bodyType: 'json', body: '{"titel":"{{ daten.titel }}"}' }, { connectionId: connId, settings: { retries: 3, retryDelaySec: 1 } }),
        node('l', 'control.log', 'protokoll', { message: 'fertig {{ anfrage.status }}' }),
      ],
      edges: [edge('t', 'm'), edge('m', 'h'), edge('h', 'l')],
    };
    const d = await admin.get(`/workflows/${wf.json.id}`);
    expect((await admin.put(`/workflows/${wf.json.id}/draft`, { revision: d.json.draft_revision, graph })).status).toBe(200);
    // veraltete Revision → Konflikt
    expect((await admin.put(`/workflows/${wf.json.id}/draft`, { revision: d.json.draft_revision, graph })).status).toBe(409);
    const pub = await admin.post(`/workflows/${wf.json.id}/publish`, { changeNote: 'erste Version' });
    expect(pub.status).toBe(200);
    expect(pub.json.needsApproval).toBe(false);
    failNext = 2;
    const run = await admin.post(`/workflows/${wf.json.id}/run`, { data: { name: 'Wache' } });
    expect(run.status).toBe(200);
    await drainRuns();
    const r = await admin.get(`/runs/${run.json.runId}`);
    expect(r.json.status).toBe('success');
    const httpSteps = r.json.steps.filter((s: any) => s.node_id === 'h');
    expect(httpSteps.map((s: any) => s.status)).toEqual(['error', 'error', 'success']);
    const last = hits[hits.length - 1];
    expect(last.auth).toBe('Bearer super-geheimes-token-123');
    expect(JSON.parse(last.body)).toEqual({ titel: 'Hallo Wache' });
    expect(last.idem).toBeUndefined(); // PUT ist idempotent, kein Schlüssel nötig
    expect(JSON.stringify(r.json)).not.toContain('super-geheimes-token-123');
  });

  it('plant lange Wiederholungen als Folgeauftrag ein, statt den Lauf hängen zu lassen', async () => {
    const wf = await admin.post('/workflows', { name: 'Lange Wiederholung' });
    const graph: Graph = {
      nodes: [node('t', 'trigger.manual', 'start'), node('h', 'http.request', 'anfrage', { method: 'PUT', url: '/spaeter', bodyType: 'none' }, { connectionId: connId, settings: { retries: 2, retryDelaySec: 30 } })],
      edges: [edge('t', 'h')],
    };
    const d = await admin.get(`/workflows/${wf.json.id}`);
    await admin.put(`/workflows/${wf.json.id}/draft`, { revision: d.json.draft_revision, graph });
    await admin.post(`/workflows/${wf.json.id}/publish`, {});
    failNext = 1;
    const run = await admin.post(`/workflows/${wf.json.id}/run`, {});
    await drainRuns();
    expect((await admin.get(`/runs/${run.json.runId}`)).json.status).toBe('running');
    const next = await many<any>(`SELECT id FROM jobs WHERE dedup_key = $1 AND status = 'queued' AND run_at > now()`, [`run:${run.json.runId}`]);
    expect(next).toHaveLength(1);
    await pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [next[0].id]);
    await drainRuns();
    expect((await admin.get(`/runs/${run.json.runId}`)).json.status).toBe('success');
  });

  it('verhindert Doppelwirkung bei unklarem Ergebnis und verlangt Bestätigung beim Wiederholen', async () => {
    const wf = await admin.post('/workflows', { name: 'Unklar' });
    const graph: Graph = {
      nodes: [node('t', 'trigger.manual', 'start'), node('h', 'http.request', 'senden', { method: 'POST', url: '/langsam', bodyType: 'none', sendIdempotencyKey: false }, { connectionId: connId, settings: { timeoutSec: 1, retries: 3 } })],
      edges: [edge('t', 'h')],
    };
    const d = await admin.get(`/workflows/${wf.json.id}`);
    await admin.put(`/workflows/${wf.json.id}/draft`, { revision: d.json.draft_revision, graph });
    await admin.post(`/workflows/${wf.json.id}/publish`, {});
    const before = hits.filter((h) => h.path === '/langsam').length;
    const run = await admin.post(`/workflows/${wf.json.id}/run`, {});
    await drainRuns();
    const r = await admin.get(`/runs/${run.json.runId}`);
    expect(r.json.status).toBe('needs_review');
    expect(hits.filter((h) => h.path === '/langsam').length - before).toBe(1); // keine automatische Wiederholung
    expect(r.json.replay.warning).toMatch(/Doppelwirkung|unklar/i);
    const noConfirm = await admin.post(`/runs/${run.json.runId}/replay`, { kind: 'from_failed' });
    expect(noConfirm.status).toBe(409);
    const ok = await admin.post(`/runs/${run.json.runId}/replay`, { kind: 'from_failed', confirm: true });
    expect(ok.status).toBe(200);
    expect((await one<any>('SELECT parent_run_id, replay_kind FROM runs WHERE id = $1', [ok.json.runId])).replay_kind).toBe('from_failed');
  });

  it('pausiert bei „Warten“ und setzt danach fort', async () => {
    const wf = await admin.post('/workflows', { name: 'Warten' });
    const graph: Graph = {
      nodes: [node('t', 'trigger.manual', 'start'), node('w', 'control.wait', 'pause', { amount: 1, unit: 'seconds' }), node('x', 'data.text', 'text', { template: 'nach {{ pause.waited_until }}' })],
      edges: [edge('t', 'w'), edge('w', 'x')],
    };
    const d = await admin.get(`/workflows/${wf.json.id}`);
    await admin.put(`/workflows/${wf.json.id}/draft`, { revision: d.json.draft_revision, graph });
    await admin.post(`/workflows/${wf.json.id}/publish`, {});
    const run = await admin.post(`/workflows/${wf.json.id}/run`, {});
    await drainRuns();
    expect((await admin.get(`/runs/${run.json.runId}`)).json.status).toBe('waiting');
    await new Promise((r) => setTimeout(r, 1300));
    await drainRuns();
    expect((await admin.get(`/runs/${run.json.runId}`)).json.status).toBe('success');
  });

  it('simuliert Aktionen im Testlauf', async () => {
    const before = hits.length;
    const wfs = await admin.get('/workflows');
    const id = wfs.json.find((w: any) => w.name === 'Integrationstest').id;
    const t = await admin.post(`/workflows/${id}/test`, { simulate: true, input: { data: { name: 'Test' } } });
    await drainRuns();
    const r = await admin.get(`/runs/${t.json.runId}`);
    expect(r.json.mode).toBe('test');
    expect(r.json.steps.find((s: any) => s.node_id === 'h').status).toBe('simulated');
    expect(hits.length).toBe(before);
  });
});

describe('Webhooks', () => {
  let path = '';
  let secret = '';
  let wfId = '';
  const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
    'x-lifelink-timestamp': String(ts),
    'x-lifelink-signature': 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'),
    'content-type': 'application/json',
  });
  it('gibt das Geheimnis beim ersten Veröffentlichen einmal zurück', async () => {
    const wf = await admin.post('/workflows', { name: 'Webhook-Test' });
    wfId = wf.json.id;
    const graph: Graph = {
      nodes: [node('t', 'trigger.webhook', 'webhook', { authMode: 'hmac', dedupPath: 'body.id' }), node('l', 'control.log', 'log', { message: '{{ webhook.body.titel }}' })],
      edges: [edge('t', 'l')],
    };
    const d = await admin.get(`/workflows/${wfId}`);
    await admin.put(`/workflows/${wfId}/draft`, { revision: d.json.draft_revision, graph });
    const pub = await admin.post(`/workflows/${wfId}/publish`, {});
    expect(pub.json.webhook.secret).toMatch(/^whsec_/);
    secret = pub.json.webhook.secret;
    path = pub.json.webhook.path;
    const again = await admin.post(`/workflows/${wfId}/status`, { status: 'active' });
    expect(again.json.webhook.secret).toBeNull();
  });
  it('prüft Signatur, Zeitfenster, Replay und Duplikate', async () => {
    const body = JSON.stringify({ id: 'E-1', titel: 'Einsatz' });
    const ok = await app.inject({ method: 'POST', url: path, payload: body, headers: sign(body) });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().run_id).toBeGreaterThan(0);
    const replay = await app.inject({ method: 'POST', url: path, payload: body, headers: sign(body) });
    // gleiche Sekunde → gleiche Signatur → Replay abgewiesen
    expect([401, 202]).toContain(replay.statusCode);
    if (replay.statusCode === 202) expect(replay.json().duplicate).toBe(true);
    const later = await app.inject({ method: 'POST', url: path, payload: body, headers: sign(body, Math.floor(Date.now() / 1000) - 1) });
    expect(later.json().duplicate).toBe(true);
    const old = await app.inject({ method: 'POST', url: path, payload: body, headers: sign(body, Math.floor(Date.now() / 1000) - 600) });
    expect(old.statusCode).toBe(401);
    const tampered = await app.inject({ method: 'POST', url: path, payload: body.replace('Einsatz', 'Falsch'), headers: sign(body) });
    expect(tampered.statusCode).toBe(401);
    const unknown = await app.inject({ method: 'POST', url: '/hooks/abcdefghijklmnopqrstuvwxyz', payload: body, headers: sign(body) });
    expect(unknown.statusCode).toBe(404);
  });
  it('rotiert das Geheimnis mit Übergangsfrist', async () => {
    const list = await admin.get('/webhooks');
    const ep = list.json.find((e: any) => e.workflow_id === wfId);
    const rot = await admin.post(`/webhooks/${ep.id}/rotate`, { graceHours: 1 });
    const oldSecret = secret;
    const body = JSON.stringify({ id: 'E-2' });
    expect((await app.inject({ method: 'POST', url: path, payload: body, headers: sign(body) })).statusCode).toBe(202); // altes noch gültig
    secret = rot.json.secret;
    const body3 = JSON.stringify({ id: 'E-3' });
    expect((await app.inject({ method: 'POST', url: path, payload: body3, headers: sign(body3) })).statusCode).toBe(202);
    expect(oldSecret).not.toBe(secret);
  });
});

describe('Vier-Augen-Freigabe', () => {
  it('verhindert Selbstfreigabe', async () => {
    await setSettings({ 'execution.four_eyes': true });
    const wf = await admin.post('/workflows', { name: 'Freigabe' });
    const d = await admin.get(`/workflows/${wf.json.id}`);
    await admin.put(`/workflows/${wf.json.id}/draft`, { revision: d.json.draft_revision, graph: { nodes: [node('t', 'trigger.manual', 'start'), node('x', 'data.text', 'text', { template: 'x' })], edges: [edge('t', 'x')] } });
    const pub = await admin.post(`/workflows/${wf.json.id}/publish`, {});
    expect(pub.json.needsApproval).toBe(true);
    const self = await admin.post(`/workflows/${wf.json.id}/versions/${pub.json.version.id}/decision`, { approve: true });
    expect(self.status).toBe(403);
    await setSettings({ 'execution.four_eyes': false });
  });
});

describe('Updates', () => {
  it('lehnt Pakete ohne gültige Signatur ab', async () => {
    const boundary = '----lltest';
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="zip"; filename="lifelink-update-v9.0.0.zip"\r\nContent-Type: application/zip\r\n\r\nPK-falsch\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="sig"; filename="x.sig"\r\nContent-Type: text/plain\r\n\r\n${Buffer.alloc(64).toString('base64')}\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const res = await app.inject({ method: 'POST', url: '/api/v1/updates/upload', payload: parts, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-lifelink-request': '1', cookie: admin.cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Signatur|Schlüssel/);
    const audit = await one<any>(`SELECT result FROM audit_events WHERE action = 'update.install' ORDER BY id DESC LIMIT 1`);
    expect(audit.result).toBe('failed');
  });
});
