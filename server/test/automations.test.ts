import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, one, many } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { claimJobs, completeJob, failJob } from '../src/jobs/queue.js';
import { executeRun } from '../src/automations/engine.js';
import { automationTick } from '../src/automations/events.js';
import { handleFe2Event } from '../src/connections/fe2.js';
import { loadConnection } from '../src/connections/common.js';
import { refreshWarnfeed } from '../src/connections/warnfeed.js';
import { refreshFeed } from '../src/routes/rss.js';
import { runRetention } from '../src/lib/retention.js';

/**
 * Automationen gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL): Rechte, Ein-/Ausgänge, Entwurf → Test →
 * Aktivierung, Ereignisse aus FE2, Warnfeed und RSS, Zeitplan mit Mail und Freigabe, Direktversand, Grenzen, Notbremse,
 * Protokoll und Löschfrist. Die Datenbank wird zu Beginn geleert; der Worker wird durch drain() ersetzt.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as any,
      url: `/api/v1${url}`,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
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
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  del = (u: string) => this.raw('DELETE', u, {});
}

let admin: Client;
let editor: Client;
let approver: Client;
let anonymous: Client;
let editorId: string;
let approverEmail = 'freigabe@example.org';

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return { client: c, userId: inv.json.user.id as string };
}

/** Worker-Ersatz: fällige Aufträge ausführen (Automationen) bzw. abhaken (alles andere). */
async function drain() {
  for (let i = 0; i < 20; i++) {
    const jobs = await claimJobs(20);
    if (!jobs.length) return;
    for (const j of jobs) {
      if (j.kind !== 'automation.run') {
        await completeJob(j.id);
        continue;
      }
      try {
        await executeRun(String(j.payload.runId), j);
        await completeJob(j.id);
      } catch (e) {
        await failJob(j, (e as Error).message, 0);
      }
    }
  }
}

const freshReauth = () => pool.query(`UPDATE sessions SET reauth_at = now()`);
const staleReauth = () => pool.query(`UPDATE sessions SET reauth_at = now() - interval '1 hour'`);
const node = (id: string, type: string, data: any, y = 0) => ({ id, type, position: { x: 0, y }, data });
const edge = (id: string, source: string, target: string, sourceHandle = 'out') => ({ id, source, target, sourceHandle });

async function saveGraph(id: string, graph: any, name = 'Automation') {
  const cur = await admin.get(`/automations/${id}`);
  const r = await admin.put(`/automations/${id}`, { name: cur.json.name ?? name, description: '', graph, baseHash: cur.json.draft_hash });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}
async function testAndActivate(id: string) {
  const t = await admin.post(`/automations/${id}/test`, {});
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  expect(t.json.status, JSON.stringify(t.json.steps)).toBe('succeeded');
  const a = await admin.post(`/automations/${id}/activate`);
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  return a.json.version as number;
}

let siteId: string;
let fe2Conn: any;
let igConn: any;
let waConn: any;
let fe2Input: string;
let postOutput: string;
let autoFe2: string;
let smtp: any;
const inbox: { to: string[]; subject: string; raw: string }[] = [];
let feedServer: http.Server;
let feedXml = '';
let capXml = '';

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
  anonymous = new Client(app);
  const { SMTPServer } = await import('smtp-server');
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    disableReverseLookup: true,
    logger: false,
    onData(stream: any, session: any, cb: any) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo.map((r: any) => r.address), subject: /^Subject: (.*)$/m.exec(Buffer.concat(chunks).toString())?.[1] ?? '', raw: Buffer.concat(chunks).toString() });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  feedServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/feed.xml')) return res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(feedXml);
    if (req.url?.startsWith('/cap.xml')) return res.writeHead(200, { 'content-type': 'application/xml' }).end(capXml);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => feedServer.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  smtp?.close();
  feedServer?.close();
  await app?.close();
  await pool.end();
});

describe('Automationen: Einrichtung und Rechte', () => {
  it('richtet Admin und Rollen ein; Lesen nur mit automation.read, Ändern nur mit automation.manage', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    const e = await acceptInvite('redaktion@example.org', ['editor'], 'Robin');
    editor = e.client;
    editorId = e.userId;
    approver = (await acceptInvite(approverEmail, ['approver'], 'Sam')).client;

    expect((await anonymous.get('/automations')).status).toBe(401);
    expect((await editor.get('/automations')).status).toBe(200);
    expect((await editor.get('/automations/catalog')).status).toBe(200);
    expect((await editor.post('/automations', { name: 'Nicht erlaubt' })).status).toBe(403);
    expect((await editor.post('/automation-inputs', { name: 'X', kind: 'manual', config: {} })).status).toBe(403);
    const cat = await admin.get('/automations/catalog');
    expect(cat.json.inputKinds.map((k: any) => k.kind)).toEqual(['fe2', 'feuersoftware', 'warnfeed', 'rss', 'upload', 'schedule', 'manual']);
    expect(cat.json.outputKinds.find((k: any) => k.kind === 'warning_draft').directCapable).toBe(false);
    expect((await editor.get('/automations/catalog')).json.users).toEqual([]);
  });

  it('Eingänge und Ausgänge werden serverseitig geprüft', async () => {
    siteId = (await one<any>(`INSERT INTO wp_sites (name, status, site_url, paired_at) VALUES ('Testseite', 'active', 'https://www.example.org', now()) RETURNING id`))!.id;
    fe2Conn = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('fe2', 'FE2 Leitstelle', 'active', '{}') RETURNING *`);
    const fs2 = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('warnfeed', 'Falsche Art', 'active', '{}') RETURNING *`);
    expect((await admin.post('/automation-inputs', { name: 'FE2', kind: 'fe2', config: { connectionId: fs2!.id, phases: ['neu'] } })).status).toBe(400);
    expect((await admin.post('/automation-inputs', { name: 'Zu oft', kind: 'schedule', config: { mode: 'interval', minutes: 5 } })).status).toBe(400);
    expect((await admin.post('/automation-inputs', { name: 'Manuell', kind: 'manual', config: { fields: [{ key: 'automation', label: 'reserviert' }] } })).status).toBe(400);
    const i = await admin.post('/automation-inputs', { name: 'FE2-Alarm', kind: 'fe2', config: { connectionId: fe2Conn.id, phases: ['neu'] } });
    expect(i.status, JSON.stringify(i.json)).toBe(200);
    fe2Input = i.json.id;
    expect((await admin.post('/automation-outputs', { name: 'Banner ohne Website', kind: 'banner', config: { siteIds: [], title: 'x' } })).status).toBe(400);
    expect((await admin.post('/automation-outputs', { name: 'Fremder Link', kind: 'notify', config: { roles: ['editor'], title: 'Hallo', link: 'https://example.org' } })).status).toBe(400);
    // Soziale Kanäle samt Story vorauswählen (#188, #189); Storys nur für Facebook/Instagram
    igConn = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('instagram', 'Instagram', 'active', '{}') RETURNING *`);
    waConn = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('whatsapp', 'WhatsApp-Kanal', 'active', '{}') RETURNING *`);
    expect((await admin.post('/automation-outputs', { name: 'Story im Kanal', kind: 'post', config: { title: 'x', socialTargets: [{ connectionId: waConn.id, format: 'story' }] } })).status).toBe(400);
    const o = await admin.post('/automation-outputs', { name: 'Einsatzentwurf', kind: 'post', config: { kind: 'incident', title: 'Einsatz {{stichwort}} in {{ort}}', body: '{{stichwort_text}} – Alarm {{alarmzeit}}', submit: true, socialTargets: [{ connectionId: igConn.id, format: 'story' }, { connectionId: waConn.id, format: 'feed' }] } });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    postOutput = o.json.id;
    const list = await editor.get('/automation-outputs');
    expect(list.json[0].needs).toEqual(['stichwort', 'ort', 'stichwort_text', 'alarmzeit']);
  });
});

describe('Automationen: Entwurf, Test, Aktivierung', () => {
  it('speichert mit optimistischer Sperre, zeigt Fehler an Knoten und verlangt einen erfolgreichen Test', async () => {
    const c = await admin.post('/automations', { name: 'B-Einsätze als Entwurf' });
    expect(c.status).toBe(200);
    autoFe2 = c.json.id;
    const broken = { nodes: [node('in', 'input', { inputId: fe2Input }), node('out', 'output', { outputId: postOutput }, 200)], edges: [] };
    const saved = await saveGraph(autoFe2, broken);
    expect(saved.validation.ok).toBe(false);
    expect(saved.validation.errors.some((e: any) => e.nodeId === 'out')).toBe(true);
    expect((await admin.post(`/automations/${autoFe2}/test`, {})).status).toBe(400);
    const stale = await admin.put(`/automations/${autoFe2}`, { name: 'Veraltet', graph: broken, baseHash: 'a'.repeat(64) });
    expect(stale.status).toBe(409);
    const graph = {
      nodes: [node('in', 'input', { inputId: fe2Input }), node('if', 'condition', { combinator: 'and', rules: [{ field: 'stichwort', op: 'starts_with', value: 'B' }] }, 100), node('out', 'output', { outputId: postOutput }, 200)],
      edges: [edge('e1', 'in', 'if'), edge('e2', 'if', 'out', 'true')],
    };
    const ok = await saveGraph(autoFe2, graph);
    expect(ok.validation.errors).toEqual([]);
    expect(ok.tested).toBe(false);
    const act = await admin.post(`/automations/${autoFe2}/activate`);
    expect(act.status).toBe(409);
    expect(act.json.error).toBe('not_tested');
  });

  it('Testlauf (Trockenlauf) legt nichts an und beschreibt, was passieren würde', async () => {
    const before = (await one<any>(`SELECT count(*)::int AS n FROM posts`))!.n;
    const t = await admin.post(`/automations/${autoFe2}/test`, { payload: { stichwort: 'B2', ort: 'Testort', unbekannt: 'wird ignoriert' } });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json.status).toBe('succeeded');
    expect(t.json.mode).toBe('test');
    const out = t.json.steps.find((s: any) => s.node_id === 'out');
    expect(out.info).toMatch(/Testlauf: würde den Beitrag „Einsatz B2 in Testort“/);
    expect(t.json.payload.unbekannt).toBeUndefined();
    expect((await one<any>(`SELECT count(*)::int AS n FROM posts`))!.n).toBe(before);
    expect((await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'automation.run'`))!.n).toBe(0);
    const v = await admin.post(`/automations/${autoFe2}/activate`);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json.version).toBe(1);
    const d = await admin.get(`/automations/${autoFe2}`);
    expect(d.json.status).toBe('active');
    expect(d.json.active.current).toBe(true);
  });

  it('ein geänderter Ausgang verlangt einen neuen Test; die aktive Version läuft unverändert weiter', async () => {
    const o = await admin.put(`/automation-outputs/${postOutput}`, { name: 'Einsatzentwurf', config: { kind: 'incident', title: 'Einsatz {{stichwort}} in {{ort}}', body: '{{stichwort_text}}', submit: true, siteId } });
    expect(o.status).toBe(200);
    const d = await admin.get(`/automations/${autoFe2}`);
    expect(d.json.tested).toBe(false);
    expect(d.json.active.current).toBe(false);
    expect((await admin.post(`/automations/${autoFe2}/activate`)).json.error).toBe('not_tested');
    // In Verwendung: nicht löschbar
    expect((await admin.del(`/automation-outputs/${postOutput}`)).status).toBe(409);
    expect((await admin.del(`/automation-inputs/${fe2Input}`)).status).toBe(409);
  });
});

describe('Automationen: Ereignisse', () => {
  it('FE2-Alarm mit Stichwort B* legt genau einen Beitragsentwurf an (Duplikat startet keinen Lauf)', async () => {
    const c = await loadConnection(fe2Conn.id);
    await handleFe2Event(c, { einsatz: { id: 'E-1', stichwort: 'B3', stichwort_text: 'Brand Wohngebäude', ort: 'Nord', alarmzeit: '2026-11-16T06:12:00Z', melder: 'Max Muster', strasse: 'Hauptstraße 1' } });
    await handleFe2Event(c, { einsatz: { id: 'E-1', stichwort: 'B3', stichwort_text: 'Brand Wohngebäude', ort: 'Nord', alarmzeit: '2026-11-16T06:12:00Z' } });
    await drain();
    const runs = await many<any>(`SELECT * FROM automation_runs WHERE automation_id = $1 AND mode = 'live'`, [autoFe2]);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('succeeded');
    // Nur Felder der Allowlist – keine Straße, kein Meldender
    expect(JSON.stringify(runs[0].payload)).not.toMatch(/Hauptstraße|Max Muster/);
    const p = await one<any>(`SELECT p.id, p.kind, r.title, r.body, r.submitted_at FROM posts p JOIN post_revisions r ON r.post_id = p.id WHERE r.title = 'Einsatz B3 in Nord'`);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('incident');
    const rv = await one<any>(`SELECT social_targets, social_formats FROM post_revisions WHERE post_id = $1`, [p!.id]);
    expect(rv.social_targets.sort()).toEqual([igConn.id, waConn.id].sort());
    expect(rv.social_formats).toEqual({ [igConn.id]: 'story' });
    // Automationen posten nie selbst in sozialen Netzwerken
    expect(await one(`SELECT 1 FROM social_publications WHERE post_id = $1`, [p!.id])).toBeNull();
    expect(p!.submitted_at).not.toBeNull();
    expect(await one(`SELECT 1 FROM approvals WHERE post_id = $1`, [p!.id])).toBeNull();
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.post_created' AND object_id = $1`, [p!.id])).not.toBeNull();
    // Wiederholung des Laufs (z. B. nach Absturz) legt nichts doppelt an
    await pool.query(`UPDATE automation_runs SET status = 'running' WHERE id = $1`, [runs[0].id]);
    await executeRun(runs[0].id);
    expect((await one<any>(`SELECT count(*)::int AS n FROM post_revisions WHERE title = 'Einsatz B3 in Nord'`))!.n).toBe(1);
  });

  it('Bedingung trifft nicht zu: Lauf endet ohne Ausgang; nicht abonnierte Vorgänge starten keinen Lauf', async () => {
    const c = await loadConnection(fe2Conn.id);
    await handleFe2Event(c, { einsatz: { id: 'E-2', stichwort: 'TH1', ort: 'Süd' } });
    await handleFe2Event(c, { einsatz: { id: 'E-1', stichwort: 'B3', ort: 'Nord', status: 'beendet' } });
    await drain();
    const runs = await many<any>(`SELECT r.*, (SELECT status FROM automation_steps s WHERE s.run_id = r.id AND s.node_id = 'out') AS out_status FROM automation_runs r WHERE automation_id = $1 AND mode = 'live' ORDER BY created_at`, [autoFe2]);
    expect(runs.length).toBe(2);
    expect(runs[1].status).toBe('succeeded');
    expect(runs[1].out_status).toBe('skipped');
    expect(await one(`SELECT 1 FROM post_revisions WHERE title LIKE 'Einsatz TH1%'`)).toBeNull();
  });

  it('Warnfeed: DWD-Unwetter ab Stufe 3 → Banner-Entwurf im Stil „Gefahr“ und Benachrichtigung der Redaktion, nur einmal', async () => {
    const w = await one<any>(
      `INSERT INTO connections (kind, name, status, config, private_target, private_approved_at) VALUES ('warnfeed', 'DWD', 'active', $1, '127.0.0.1', now()) RETURNING id`,
      [JSON.stringify({ format: 'cap', url: `http://127.0.0.1:${(feedServer.address() as any).port}/cap.xml`, areaFilter: {} })],
    );
    const inp = await admin.post('/automation-inputs', { name: 'DWD-Warnungen', kind: 'warnfeed', config: { connectionId: w!.id, phases: ['neu'] } });
    const banner = await admin.post('/automation-outputs', { name: 'Unwetter-Banner', kind: 'banner', config: { siteIds: [siteId], title: '{{ueberschrift}}', text: '{{gebiete}} – Quelle: {{quelle}}', tone: 'auto', priority: 3, durationHours: 6, linkUrl: '{{link}}', linkText: 'Zur Warnung' } });
    expect(banner.status, JSON.stringify(banner.json)).toBe(200);
    const note = await admin.post('/automation-outputs', { name: 'Redaktion informieren', kind: 'notify', config: { roles: ['editor'], title: 'Unwetter: {{ereignis}}', body: 'Banner-Entwurf liegt zur Freigabe.', link: '{{banner_link}}' } });
    const a = (await admin.post('/automations', { name: 'Unwetter-Banner' })).json.id;
    await saveGraph(a, {
      nodes: [node('in', 'input', { inputId: inp.json.id }), node('if', 'condition', { combinator: 'and', rules: [{ field: 'stufe', op: 'gte', value: '3' }] }, 100), node('b', 'output', { outputId: banner.json.id }, 200), node('n', 'output', { outputId: note.json.id }, 300)],
      edges: [edge('e1', 'in', 'if'), edge('e2', 'if', 'b', 'true'), edge('e3', 'b', 'n')],
    });
    await testAndActivate(a);
    capXml = `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>DWD-TEST-1</identifier><sender>opendata@dwd.de</sender><sent>2026-11-16T06:00:00+01:00</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>de-DE</language><event>STURMBÖEN</event><severity>Severe</severity><urgency>Immediate</urgency><headline>Amtliche Unwetterwarnung vor Sturmböen</headline><description>Es treten Sturmböen auf.</description><web>https://www.dwd.de/warnungen</web><expires>2099-01-01T00:00:00+01:00</expires><area><areaDesc>Kreis Test</areaDesc></area></info></alert>`;
    const c = await loadConnection(w!.id);
    await refreshWarnfeed(c);
    await refreshWarnfeed(await loadConnection(w!.id));
    await drain();
    const runs = await many<any>(`SELECT status FROM automation_runs WHERE automation_id = $1 AND mode = 'live'`, [a]);
    expect(runs).toEqual([{ status: 'succeeded' }]);
    const b = await one<any>(`SELECT * FROM banners WHERE title = 'Amtliche Unwetterwarnung vor Sturmböen'`);
    expect(b!.tone).toBe('danger');
    expect(b!.submitted_at).not.toBeNull();
    expect(b!.approved_hash).toBeNull();
    expect(b!.link_url).toBe('https://www.dwd.de/warnungen');
    expect(b!.text).toMatch(/Kreis Test – Quelle: Deutscher Wetterdienst/);
    expect(await one(`SELECT 1 FROM banner_jobs WHERE banner_id = $1`, [b!.id])).toBeNull();
    const n = await one<any>(`SELECT * FROM notifications WHERE user_id = $1 AND title = 'Unwetter: STURMBÖEN'`, [editorId]);
    expect(n!.link).toBe('/banner');
  });

  it('RSS: neue Einträge beim regulären Abruf starten je einen Lauf, das erste Einlesen nicht', async () => {
    await setSettings({ 'security.allowed_private_hosts': ['127.0.0.1'] });
    const item = (n: number) => `<item><title>Meldung ${n}</title><link>https://example.org/${n}</link><guid>m${n}</guid><description>Text ${n}</description></item>`;
    feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Stadt</title><link>https://example.org</link>${item(1)}</channel></rss>`;
    const f = await admin.raw('POST', '/rss/feeds', { url: `http://127.0.0.1:${(feedServer.address() as any).port}/feed.xml`, intervalMin: 5 });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    const inp = await admin.post('/automation-inputs', { name: 'Stadt-Feed', kind: 'rss', config: { feedId: f.json.feed.id } });
    const out = await admin.post('/automation-outputs', { name: 'RSS-Hinweis', kind: 'notify', config: { roles: ['editor'], title: 'Neu: {{titel}}', body: '{{zusammenfassung}}' } });
    const a = (await admin.post('/automations', { name: 'RSS-Hinweise' })).json.id;
    await saveGraph(a, { nodes: [node('in', 'input', { inputId: inp.json.id }), node('o', 'output', { outputId: out.json.id }, 100)], edges: [edge('e1', 'in', 'o')] });
    await testAndActivate(a);
    feedXml = feedXml.replace('</channel>', `${item(2)}</channel>`);
    await refreshFeed((await one<any>(`SELECT * FROM rss_feeds WHERE id = $1`, [f.json.feed.id]))!);
    await drain();
    expect((await many<any>(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND mode = 'live'`, [a])).length).toBe(1);
    expect(await one(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Neu: Meldung 2'`, [editorId])).not.toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Neu: Meldung 1'`)).toBeNull();
  });
});

describe('Automationen: Direktversand je Automation', () => {
  it('Markieren, Erlauben und Aktivieren verlangen automation.publish, frische Bestätigung und einen Test', async () => {
    const cur = await admin.get(`/automations/${autoFe2}`);
    const graph = cur.json.graph;
    graph.nodes.find((n: any) => n.id === 'out').data.direct = true;
    expect((await editor.put(`/automations/${autoFe2}`, { name: cur.json.name, graph, baseHash: cur.json.draft_hash })).status).toBe(403);
    await saveGraph(autoFe2, graph);
    // Ohne Erlaubnis kein Aktivieren mit Direktversand
    expect((await admin.post(`/automations/${autoFe2}/test`, {})).json.status).toBe('succeeded');
    await freshReauth();
    expect((await admin.post(`/automations/${autoFe2}/activate`)).json.error).toBe('direct_not_allowed');
    // Erlauben: Redaktion darf nicht, veraltete Bestätigung reicht nicht
    expect((await editor.post(`/automations/${autoFe2}/direct-publish`, { enabled: true })).status).toBe(403);
    await staleReauth();
    const r1 = await admin.post(`/automations/${autoFe2}/direct-publish`, { enabled: true });
    expect(r1.status).toBe(403);
    expect(r1.json.error).toBe('reauth_required');
    await freshReauth();
    expect((await admin.post(`/automations/${autoFe2}/direct-publish`, { enabled: true })).status).toBe(200);
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Direktversand erlaubt%'`)).not.toBeNull();
    await staleReauth();
    expect((await admin.post(`/automations/${autoFe2}/activate`)).json.error).toBe('reauth_required');
    await freshReauth();
    const act = await admin.post(`/automations/${autoFe2}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Automation mit Direktversand aktiviert%'`)).not.toBeNull();
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.direct_enabled'`)).not.toBeNull();
    const list = await editor.get('/automations');
    expect(list.json.find((x: any) => x.id === autoFe2).direct_publish).toBe(true);
  });

  it('markierter Ausgang veröffentlicht direkt (Freigabe durch die Automation, Auftrag für die Website) – nach Entzug wieder nur Entwurf', async () => {
    const c = await loadConnection(fe2Conn.id);
    await handleFe2Event(c, { einsatz: { id: 'E-3', stichwort: 'B5', stichwort_text: 'Großbrand', ort: 'West' } });
    await drain();
    const p = await one<any>(`SELECT p.id FROM posts p JOIN post_revisions r ON r.post_id = p.id WHERE r.title = 'Einsatz B5 in West'`);
    const a = await one<any>(`SELECT * FROM approvals WHERE post_id = $1`, [p!.id]);
    expect(a!.decision).toBe('approved');
    expect(a!.decided_by).toBeNull();
    expect(await one(`SELECT 1 FROM publications WHERE post_id = $1 AND site_id = $2 AND status = 'queued'`, [p!.id, siteId])).not.toBeNull();
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.post_published' AND object_id = $1`, [p!.id])).not.toBeNull();
    // Notbremse für den Direktversand: entziehen (auch ohne automation.publish) → nächster Lauf legt nur einen Entwurf an
    expect((await admin.post(`/automations/${autoFe2}/direct-publish`, { enabled: false })).status).toBe(200);
    await handleFe2Event(c, { einsatz: { id: 'E-4', stichwort: 'B1', ort: 'Ost' } });
    await drain();
    const p2 = await one<any>(`SELECT p.id FROM posts p JOIN post_revisions r ON r.post_id = p.id WHERE r.title = 'Einsatz B1 in Ost'`);
    expect(p2).not.toBeNull();
    expect(await one(`SELECT 1 FROM approvals WHERE post_id = $1`, [p2!.id])).toBeNull();
    expect(await one(`SELECT 1 FROM publications WHERE post_id = $1`, [p2!.id])).toBeNull();
  });
});

describe('Automationen: Zeitplan, E-Mail und Freigabe', () => {
  it('täglicher Zeitplan → Übersicht per Mail; externe Empfänger nur nach Freigabe (Vier-Augen) und im Testmodus nur ans Testpostfach', async () => {
    await setSettings({ 'smtp.host': '127.0.0.1', 'smtp.port': (smtp.server.address() as any).port, 'smtp.security': 'none', 'smtp.from': 'blaulichtcms@example.org', 'warnings.test_mode': true, 'warnings.test_recipient': 'testpostfach@example.org', 'editorial.four_eyes': true });
    process.env.BLAULICHTCMS_SMTP_TIMEOUT_MS = '3000';
    const resp = await one<any>(`INSERT INTO responsibilities (name, area, recipients) VALUES ('Leitstelle (fiktiv)', 'Test', '{leitstelle@example.invalid}') RETURNING id`);
    const inp = await admin.post('/automation-inputs', { name: 'Alle 15 Minuten', kind: 'schedule', config: { mode: 'interval', minutes: 15 } });
    expect(inp.status, JSON.stringify(inp.json)).toBe(200);
    const mail = await admin.post('/automation-outputs', { name: 'Übersicht per Mail', kind: 'mail', config: { roles: ['approver'], responsibilityIds: [resp!.id], subject: 'Offene Freigaben: {{offene_beitraege}}', body: 'Beiträge:\n{{offene_beitraege_liste}}' } });
    expect(mail.status, JSON.stringify(mail.json)).toBe(200);
    const a = (await admin.post('/automations', { name: 'Übersicht offene Freigaben' })).json.id;
    await saveGraph(a, { nodes: [node('in', 'input', { inputId: inp.json.id }), node('m', 'output', { outputId: mail.json.id }, 100)], edges: [edge('e1', 'in', 'm')] });
    await testAndActivate(a);
    const activated = new Date((await one<any>(`SELECT activated_at FROM automation_versions WHERE automation_id = $1`, [a]))!.activated_at).getTime();
    const step = 15 * 60_000;
    const at = Math.ceil(activated / step) * step + 60_000;
    expect((await automationTick(at)).started).toBe(1);
    expect((await automationTick(at + 30_000)).started).toBe(0);
    await drain();
    const run = await one<any>(`SELECT * FROM automation_runs WHERE automation_id = $1 AND mode = 'live'`, [a]);
    expect(run!.trigger).toBe('schedule');
    expect(run!.status).toBe('waiting');
    const list = await approver.get('/automation-approvals');
    expect(list.json.length).toBe(1);
    expect(list.json[0].kind).toBe('mail');
    expect(list.json[0].can_decide).toBe(true);
    // Vier-Augen: wer die Version aktiviert hat, darf nicht freigeben; Redaktion hat kein Freigaberecht
    expect((await admin.post(`/automation-approvals/${list.json[0].id}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await editor.post(`/automation-approvals/${list.json[0].id}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await approver.post(`/automation-approvals/${list.json[0].id}/decision`, { decision: 'rejected' })).status).toBe(400);
    expect((await approver.post(`/automation-approvals/${list.json[0].id}/decision`, { decision: 'approved', note: 'passt' })).status).toBe(200);
    expect((await approver.post(`/automation-approvals/${list.json[0].id}/decision`, { decision: 'approved' })).status).toBe(409);
    await drain();
    expect((await one<any>(`SELECT status FROM automation_runs WHERE id = $1`, [run!.id]))!.status).toBe('succeeded');
    expect(inbox.length).toBe(1);
    expect(inbox[0].to.sort()).toEqual([approverEmail, 'testpostfach@example.org'].sort());
    expect(inbox[0].subject).toMatch(/Offene Freigaben/);
    // Protokoll: Adressen nur gekürzt
    const d = await admin.get(`/automation-runs/${run!.id}`);
    const log = JSON.stringify(d.json.steps.find((s: any) => s.node_id === 'm').output);
    expect(log).not.toContain(approverEmail);
    expect(log).toContain('f…@example.org');
    await setSettings({ 'editorial.four_eyes': false });
  });
});

describe('Automationen: Verarbeitung, Grenzen, Notbremse, Löschfrist', () => {
  let manualAuto: string;
  let manualInput: string;
  it('manueller Start, Einmal je Vorgang und Warten (der Lauf hält an und wird fortgesetzt)', async () => {
    const inp = await admin.post('/automation-inputs', { name: 'Von Hand', kind: 'manual', config: { fields: [{ key: 'ort', label: 'Ort', example: 'Nord' }] } });
    manualInput = inp.json.id;
    const out = await admin.post('/automation-outputs', { name: 'Hinweis an mich', kind: 'notify', config: { userIds: [editorId], title: 'Manuell: {{ort}} ({{gestartet_von}})' } });
    manualAuto = (await admin.post('/automations', { name: 'Manuell mit Warten' })).json.id;
    await saveGraph(manualAuto, {
      nodes: [node('in', 'input', { inputId: manualInput }), node('d', 'dedup', { fields: ['ort'], windowMinutes: 60 }, 100), node('w', 'delay', { minutes: 5 }, 200), node('o', 'output', { outputId: out.json.id }, 300)],
      edges: [edge('e1', 'in', 'd'), edge('e2', 'd', 'w'), edge('e3', 'w', 'o')],
    });
    expect((await admin.post(`/automations/${manualAuto}/run`, { inputNodeId: 'in', payload: { ort: 'Nord' } })).status).toBe(409);
    await testAndActivate(manualAuto);
    const r1 = await admin.post(`/automations/${manualAuto}/run`, { inputNodeId: 'in', payload: { ort: 'Nord', fremd: 'x' } });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    await drain();
    expect((await one<any>(`SELECT status FROM automation_runs WHERE id = $1`, [r1.json.runId]))!.status).toBe('waiting');
    const job = await one<any>(`SELECT run_at FROM jobs WHERE kind = 'automation.run' AND status = 'queued' AND payload->>'runId' = $1`, [r1.json.runId]);
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    // Zeit vorspulen
    await pool.query(`UPDATE automation_steps SET output = jsonb_build_object('until', now() - interval '1 second') WHERE run_id = $1 AND node_id = 'w'`, [r1.json.runId]);
    await pool.query(`UPDATE jobs SET run_at = now() WHERE kind = 'automation.run' AND payload->>'runId' = $1 AND status = 'queued'`, [r1.json.runId]);
    await drain();
    expect((await one<any>(`SELECT status FROM automation_runs WHERE id = $1`, [r1.json.runId]))!.status).toBe('succeeded');
    expect(await one(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Manuell: Nord (Alex Admin)'`, [editorId])).not.toBeNull();
    // Gleicher Ort im Zeitfenster: Lauf endet am Entprellen
    const r2 = await admin.post(`/automations/${manualAuto}/run`, { inputNodeId: 'in', payload: { ort: 'nord' } });
    await drain();
    const steps = await many<any>(`SELECT node_id, status FROM automation_steps WHERE run_id = $1 ORDER BY id`, [r2.json.runId]);
    expect(steps.find((s) => s.node_id === 'd')!.status).toBe('done');
    expect(steps.find((s) => s.node_id === 'w')!.status).toBe('skipped');
    expect(steps.some((s) => s.node_id === 'o')).toBe(false);
  });

  it('Grenze je Minute: darüber wird verworfen und protokolliert', async () => {
    await setSettings({ 'automations.max_runs_per_minute': 3 });
    let limited = 0;
    for (let i = 0; i < 4; i++) {
      const r = await admin.post(`/automations/${manualAuto}/run`, { inputNodeId: 'in', payload: { ort: `Ort ${i}` } });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(1);
    expect(await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND status = 'limited'`, [manualAuto])).not.toBeNull();
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Automation: zu viele Läufe'`)).not.toBeNull();
    await setSettings({ 'automations.max_runs_per_minute': 20 });
  });

  it('Freigabe anfordern: Frist abgelaufen gilt als abgelehnt', async () => {
    const out = await admin.post('/automation-outputs', { name: 'Nach Freigabe', kind: 'notify', config: { userIds: [editorId], title: 'Freigegeben: {{ort}}' } });
    const a = (await admin.post('/automations', { name: 'Mit Freigabe' })).json.id;
    await saveGraph(a, {
      nodes: [node('in', 'input', { inputId: manualInput }), node('ap', 'approval', { title: 'Bitte prüfen: {{ort}}', summary: '', timeoutHours: 1 }, 100), node('o', 'output', { outputId: out.json.id }, 200)],
      edges: [edge('e1', 'in', 'ap'), edge('e2', 'ap', 'o', 'approved')],
    });
    await testAndActivate(a);
    const r = await admin.post(`/automations/${a}/run`, { inputNodeId: 'in', payload: { ort: 'Mitte' } });
    await drain();
    expect((await one<any>(`SELECT status FROM automation_runs WHERE id = $1`, [r.json.runId]))!.status).toBe('waiting');
    expect((await approver.get('/automation-approvals')).json.some((x: any) => x.title === 'Bitte prüfen: Mitte')).toBe(true);
    await pool.query(`UPDATE automation_approvals SET expires_at = now() - interval '1 minute' WHERE run_id = $1`, [r.json.runId]);
    expect((await automationTick()).expired).toBe(1);
    await drain();
    expect((await one<any>(`SELECT status FROM automation_runs WHERE id = $1`, [r.json.runId]))!.status).toBe('succeeded');
    expect(await one(`SELECT 1 FROM notifications WHERE title = 'Freigegeben: Mitte'`)).toBeNull();
  });

  it('Notbremse: Deaktivieren bricht offene Läufe ab, der globale Schalter hält alles an', async () => {
    const r = await admin.post(`/automations/${manualAuto}/run`, { inputNodeId: 'in', payload: { ort: 'Kurz vor Schluss' } });
    expect(r.status).toBe(200);
    const d = await admin.post(`/automations/${manualAuto}/disable`);
    expect(d.json.canceled).toBeGreaterThanOrEqual(1);
    expect((await one<any>(`SELECT status FROM automation_runs WHERE id = $1`, [r.json.runId]))!.status).toBe('canceled');
    expect((await admin.post(`/automations/${manualAuto}/run`, { inputNodeId: 'in', payload: {} })).status).toBe(409);
    // Global aus: Ereignisse starten nichts, wartende Läufe werden beim Fortsetzen abgebrochen
    await setSettings({ 'automations.enabled': false });
    const c = await loadConnection(fe2Conn.id);
    await handleFe2Event(c, { einsatz: { id: 'E-9', stichwort: 'B9', ort: 'Aus' } });
    expect(await one(`SELECT 1 FROM automation_runs WHERE payload->>'ort' = 'Aus'`)).toBeNull();
    await setSettings({ 'automations.enabled': true });
  });

  it('Löschfrist für Laufprotokolle; gelöschte Automationen verschwinden aus der Liste', async () => {
    await pool.query(`UPDATE automation_runs SET finished_at = now() - interval '40 days' WHERE automation_id = $1`, [manualAuto]);
    const dry = await runRetention({ dryRun: true });
    expect(dry.categories.find((c) => c.key === 'automation_runs')!.count).toBeGreaterThan(0);
    await runRetention({ dryRun: false });
    expect(await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1`, [manualAuto])).toBeNull();
    expect((await admin.del(`/automations/${manualAuto}`)).status).toBe(200);
    expect((await admin.get('/automations')).json.some((x: any) => x.id === manualAuto)).toBe(false);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.deleted'`)).not.toBeNull();
  });
});

describe('Automationen: Export und Import (#196)', () => {
  let exported: any;
  it('Export enthält Ablauf und Bezüge nach Art und Name – keine Kennungen, keine Zugangsdaten', async () => {
    const r = await editor.raw('GET', `/automations/export?ids=${autoFe2}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    exported = r.json;
    expect(exported.format).toBe('blaulichtcms.automations');
    expect(exported.schemaVersion).toBe(1);
    expect(typeof exported.appVersion).toBe('string');
    expect(exported.automations).toHaveLength(1);
    expect(exported.references.inputs).toEqual([{ ref: 'in1', kind: 'fe2', name: 'FE2-Alarm' }]);
    expect(exported.references.outputs).toEqual([{ ref: 'out1', kind: 'post', name: 'Einsatzentwurf' }]);
    const text = JSON.stringify(exported);
    for (const secret of [fe2Input, postOutput, fe2Conn.id, siteId, autoFe2]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain('"direct"');
    expect((await admin.raw('GET', '/automations/export?ids=kaputt')).status).toBe(400);
    expect((await anonymous.raw('GET', '/automations/export')).status).toBe(401);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.exported'`)).not.toBeNull();
  });

  it('Vorschau schlägt gleichnamige Ein-/Ausgänge vor; Import legt einen inaktiven Entwurf an (Roundtrip)', async () => {
    expect((await editor.post('/automations/import/preview', { file: exported })).status).toBe(403);
    const p = await admin.post('/automations/import/preview', { file: exported });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.automations[0].finalName).toBe('B-Einsätze als Entwurf (Import)');
    expect(p.json.inputs[0].suggested).toBe(fe2Input);
    expect(p.json.outputs[0].suggested).toBe(postOutput);
    expect(p.json.outputs[0].candidates.map((c: any) => c.id)).toContain(postOutput);
    const i = await admin.post('/automations/import', { file: exported, mapping: { inputs: { in1: fe2Input }, outputs: { out1: postOutput } } });
    expect(i.status, JSON.stringify(i.json)).toBe(200);
    expect(i.json.created).toHaveLength(1);
    expect(i.json.created[0].open).toBe(0);
    const d = await admin.get(`/automations/${i.json.created[0].id}`);
    expect(d.json.name).toBe('B-Einsätze als Entwurf (Import)');
    expect(d.json.status).toBe('draft');
    expect(d.json.tested).toBe(false);
    expect(d.json.active_version).toBeNull();
    expect(d.json.validation.ok).toBe(true);
    const orig = await admin.get(`/automations/${autoFe2}`);
    // Direktversand wird nie übernommen (verlangt automation.publish und eine eigene Freigabe je Automation)
    const strip = (g: any) => g.nodes.map((n: any) => [n.id, n.type, (({ direct: _d, ...rest }) => rest)(n.data)]);
    expect(strip(d.json.graph)).toEqual(strip(orig.json.graph));
    expect(d.json.graph.nodes.some((n: any) => n.data.direct)).toBe(false);
    expect(d.json.graph.edges.length).toBe(orig.json.graph.edges.length);
    // Erneut exportiert: gleiche Datei (bis auf Zeitpunkt und Namen)
    const again = (await admin.raw('GET', `/automations/export?ids=${i.json.created[0].id}`)).json;
    expect(again.automations[0].graph).toEqual(exported.automations[0].graph);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.imported'`)).not.toBeNull();
  });

  it('ohne Zuordnung bleiben Bezüge offen; falsche Zuordnungen werden abgelehnt', async () => {
    const i = await admin.post('/automations/import', { file: exported });
    expect(i.status, JSON.stringify(i.json)).toBe(200);
    expect(i.json.created[0].name).toBe('B-Einsätze als Entwurf (Import 2)');
    expect(i.json.created[0].open).toBe(2);
    const d = await admin.get(`/automations/${i.json.created[0].id}`);
    expect(d.json.status).toBe('draft');
    expect(d.json.validation.ok).toBe(false);
    expect(d.json.graph.nodes.find((n: any) => n.type === 'input').data.inputId).toBeUndefined();
    // Ausgang als Eingang zugeordnet bzw. unbekannte Kennung
    expect((await admin.post('/automations/import', { file: exported, mapping: { inputs: { in1: postOutput }, outputs: {} } })).status).toBe(400);
    expect((await admin.post('/automations/import', { file: exported, mapping: { inputs: { in1: 'kein-uuid' } } })).status).toBe(400);
  });

  it('lehnt fremde, neuere, beschädigte und zu große Dateien verständlich ab', async () => {
    const bad = async (file: unknown) => admin.post('/automations/import/preview', { file });
    let r = await bad({ hallo: 'welt' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_file');
    expect(r.json.message).toMatch(/keine Exportdatei/);
    r = await bad([1, 2, 3]);
    expect(r.json.error).toBe('invalid_file');
    r = await bad({ ...exported, schemaVersion: 99, appVersion: '9.0.0' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/neueren BlaulichtCMS-Version/);
    r = await bad({ ...exported, automations: [] });
    expect(r.json.message).toMatch(/unvollständig oder beschädigt/);
    expect(r.json.details.problems[0].message).toMatch(/keine Automation/);
    const tamper = (fn: (a: any) => void) => {
      const c = structuredClone(exported);
      fn(c);
      return c;
    };
    r = await bad(tamper((c) => (c.automations[0].graph.nodes[0].data = { inputId: fe2Input })));
    expect(r.status).toBe(400);
    expect(r.json.details.problems[0].message).toMatch(/unerwarteten Angaben/);
    r = await bad(tamper((c) => (c.automations[0].graph.nodes[0].data = { inputRef: 'in7' })));
    expect(r.json.details.problems[0].message).toMatch(/unbekannten Bezug/);
    r = await bad(tamper((c) => (c.automations[0].graph.nodes.find((n: any) => n.type === 'condition').data = { combinator: 'xor', rules: [] })));
    expect(r.json.details.problems[0].message).toMatch(/Bedingung/);
    r = await bad(tamper((c) => (c.automations[0].graph.edges[0].target = 'gibtsnicht')));
    expect(r.json.details.problems[0].message).toMatch(/unbekannten Knoten/);
    r = await bad(tamper((c) => (c.automations = Array.from({ length: 51 }, () => c.automations[0]))));
    expect(r.status).toBe(400);
    // Zu groß: knapp über der Dateigrenze (eigene Prüfung) und weit darüber (Grenze der Anfrage)
    r = await bad({ ...exported, padding: 'x'.repeat(1024 * 1024) });
    expect(r.status).toBe(413);
    r = await bad({ ...exported, padding: 'x'.repeat(3 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect((await one<any>(`SELECT count(*)::int AS n FROM automations WHERE name LIKE '%(Import%'`))!.n).toBe(2);
  });
});
