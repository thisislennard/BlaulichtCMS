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
import { handleFe2Event } from '../src/connections/fe2.js';
import { loadConnection } from '../src/connections/common.js';
import { refreshWarnfeed } from '../src/connections/warnfeed.js';
import { incidentKey, warningKey } from '../src/automations/follow.js';

/**
 * „Banner folgt dem Vorgang“ (#274) gegen eine echte PostgreSQL-Datenbank: amtliche Warnungen (CAP-Kette über den
 * Warnfeed-Abruf) und Einsätze (FE2). Aktualisierung → dasselbe Banner, Entwarnung/Einsatzende → Banner endet beim
 * Eingang (auch ohne abonnierten Vorgang und bei deaktiviertem Workflow), Freigabe-Fälle, von Hand beendet/geändert,
 * Option aus = bisheriges Verhalten. Die Datenbank wird zu Beginn geleert; der Worker wird durch drain() ersetzt.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as any,
      url: `/api/v1${url}`,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
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
}

let admin: Client;
let approver: Client;
let siteId: string;
let site2Id: string;
const caps: Record<string, string> = {};
let capServer: http.Server;

/** Worker-Ersatz: fällige Aufträge ausführen (Workflows) bzw. abhaken (alles andere). */
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

const node = (id: string, type: string, data: any, y = 0) => ({ id, type, position: { x: 0, y }, data });
const edge = (id: string, source: string, target: string, sourceHandle = 'out') => ({ id, source, target, sourceHandle });
const freshReauth = () => pool.query(`UPDATE sessions SET reauth_at = now()`);

/** CAP-Meldung des DWD (Erstmeldung, Aktualisierung oder Entwarnung mit Verweisen auf frühere Meldungen). */
function cap(id: string, o: { msgType?: 'Alert' | 'Update' | 'Cancel'; refs?: string[]; minute: number; headline: string; severity?: string; expires?: string }) {
  const sent = `2026-11-18T08:${String(o.minute).padStart(2, '0')}:00+01:00`;
  const refs = o.refs?.length ? `<references>${o.refs.map((r) => `opendata@dwd.de,${r},2026-11-18T07:00:00+01:00`).join(' ')}</references>` : '';
  return `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>opendata@dwd.de</sender><sent>${sent}</sent><status>Actual</status><msgType>${o.msgType ?? 'Alert'}</msgType><scope>Public</scope>${refs}<info><language>de-DE</language><event>STURMBÖEN</event><severity>${o.severity ?? 'Severe'}</severity><urgency>Immediate</urgency><headline>${o.headline}</headline><description>Es treten Sturmböen auf.</description><web>https://www.dwd.de/warnungen</web><expires>${o.expires ?? '2099-01-01T00:00:00+01:00'}</expires><area><areaDesc>Kreis Test</areaDesc></area></info></alert>`;
}

/** Warnfeed-Verbindung mit eigener Adresse; `deliver` legt die nächste Meldung bereit und ruft ab. */
async function warnfeed(name: string) {
  const c = await one<any>(
    `INSERT INTO connections (kind, name, status, config, private_target, private_approved_at) VALUES ('warnfeed', $1, 'active', $2, '127.0.0.1', now()) RETURNING id`,
    [name, JSON.stringify({ format: 'cap', url: `http://127.0.0.1:${(capServer.address() as any).port}/cap/${encodeURIComponent(name)}.xml`, areaFilter: {} })],
  );
  return {
    id: c!.id as string,
    deliver: async (xml: string) => {
      caps[name] = xml;
      await refreshWarnfeed(await loadConnection(c!.id));
    },
  };
}

/**
 * Workflow Auslöser → Banner-Aktion (optional mit Bedingung „stufe ≥ 3“), getestet und aktiviert. `direct` markiert die
 * Banner-Aktion für den Direktversand (Workflow mit Erlaubnis).
 */
async function flow(o: { name: string; input: { kind: 'warnfeed' | 'fe2'; connectionId: string; phases: string[] }; banner?: Record<string, unknown>; direct?: boolean; condition?: boolean }) {
  const inp = await admin.post('/automation-inputs', { name: `${o.name} – Auslöser`, kind: o.input.kind, config: { connectionId: o.input.connectionId, phases: o.input.phases, ...(o.input.kind === 'warnfeed' ? { onlyInArea: true } : {}) } });
  expect(inp.status, JSON.stringify(inp.json)).toBe(200);
  const title = o.input.kind === 'warnfeed' ? '{{ueberschrift}}' : 'Einsatz: {{stichwort}} in {{ort}}';
  const out = await admin.post('/automation-outputs', { name: `${o.name} – Banner`, kind: 'banner', config: { siteIds: [siteId], title, text: o.input.kind === 'warnfeed' ? '{{gebiete}} – Quelle: {{quelle}}' : 'Bitte den Bereich meiden.', tone: 'auto', priority: 3, durationHours: 6, linkUrl: '{{link}}', linkText: 'Zur Warnung', ...(o.banner ?? {}) } });
  expect(out.status, JSON.stringify(out.json)).toBe(200);
  const a = (await admin.post('/automations', { name: o.name })).json.id as string;
  const cur = await admin.get(`/automations/${a}`);
  const nodes = [node('in', 'input', { inputId: inp.json.id }), node('b', 'output', { outputId: out.json.id, ...(o.direct ? { direct: true } : {}) }, 200)];
  const edges = [edge('e1', 'in', 'b')];
  if (o.condition) {
    nodes.push(node('if', 'condition', { combinator: 'and', rules: [{ field: 'stufe', op: 'gte', value: '3' }] }, 100));
    edges.splice(0, 1, edge('e1', 'in', 'if'), edge('e2', 'if', 'b', 'true'));
  }
  const saved = await admin.put(`/automations/${a}`, { name: o.name, description: '', graph: { nodes, edges }, baseHash: cur.json.draft_hash });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect((await admin.post(`/automations/${a}/test`, {})).json.status).toBe('succeeded');
  if (o.direct) {
    await freshReauth();
    expect((await admin.post(`/automations/${a}/direct-publish`, { enabled: true })).status).toBe(200);
  }
  await freshReauth();
  const act = await admin.post(`/automations/${a}/activate`);
  expect(act.status, JSON.stringify(act.json)).toBe(200);
  return { automationId: a, outputId: out.json.id as string };
}

const bannersOf = (automationId: string) => many<any>(`SELECT * FROM banners WHERE automation_id = $1 ORDER BY created_at`, [automationId]);
const stepsOf = (automationId: string) =>
  many<any>(`SELECT s.status, s.info, r.payload->>'vorgang' AS vorgang FROM automation_steps s JOIN automation_runs r ON r.id = s.run_id WHERE r.automation_id = $1 AND r.mode = 'live' AND s.node_id = 'b' ORDER BY r.created_at`, [automationId]);
const jobsOf = (bannerId: string) => many<any>(`SELECT action, revision, status FROM banner_jobs WHERE banner_id = $1 ORDER BY created_at`, [bannerId]);

/** Freigeben (Person mit Freigaberecht), veröffentlichen und den Abruf durch die Bridge nachstellen. */
async function approveAndPublish(b: any) {
  const ap = await approver.post(`/banners/${b.id}/approve`, { contentHash: b.content_hash });
  expect(ap.status, JSON.stringify(ap.json)).toBe(200);
  const pub = await admin.post(`/banners/${b.id}/publish`, { contentHash: b.content_hash });
  expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  await pool.query(`UPDATE banner_jobs SET status = 'done', result_at = now() WHERE banner_id = $1 AND status = 'queued'`, [b.id]);
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
  capServer = http.createServer((req, res) => {
    const m = /^\/cap\/(.+)\.xml/.exec(req.url ?? '');
    const xml = m ? caps[decodeURIComponent(m[1])] : undefined;
    if (xml) return res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => capServer.listen(0, '127.0.0.1', r));
  const { ensureSetupToken } = await import('../src/routes/auth.js');
  await ensureSetupToken();
  const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
  expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'security.allowed_private_hosts': ['127.0.0.1'] });
  expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
  const inv = await admin.post('/users/invite', { email: 'freigabe@example.org', roles: ['approver'] });
  approver = new Client(app);
  expect((await approver.post(`/auth/invite/${inv.json.link.split('/einladung/')[1]}`, { name: 'Sam', password: 'Sam-Zugang-sicher-2026' })).json.next).toBe('done');
  siteId = (await one<any>(`INSERT INTO wp_sites (name, status, site_url, paired_at) VALUES ('Testseite', 'active', 'https://www.example.org', now()) RETURNING id`))!.id;
  site2Id = (await one<any>(`INSERT INTO wp_sites (name, status, site_url, paired_at) VALUES ('Zweite Seite', 'active', 'https://zwei.example.org', now()) RETURNING id`))!.id;
});

afterAll(async () => {
  capServer?.close();
  await app?.close();
  await pool.end();
});

describe('Banner folgt dem Vorgang: amtliche Warnungen (#274)', () => {
  let wf: Awaited<ReturnType<typeof warnfeed>>;
  let f: Awaited<ReturnType<typeof flow>>;

  it('Erstmeldung → genau ein Banner mit Herkunft, Vorgang und „folgt“', async () => {
    wf = await warnfeed('DWD Haupt');
    f = await flow({ name: 'Unwetter → Banner', input: { kind: 'warnfeed', connectionId: wf.id, phases: ['neu', 'aktualisierung'] }, condition: true });
    await wf.deliver(cap('A1', { minute: 0, headline: 'Unwetterwarnung vor Sturmböen' }));
    await drain();
    const bs = await bannersOf(f.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Unwetterwarnung vor Sturmböen', source_key: warningKey('A1'), automation_output_id: f.outputId, follows: true, revision: 1, tone: 'danger' });
    expect(bs[0].submitted_at).not.toBeNull();
    expect(bs[0].follow_hash).toBe(bs[0].content_hash);
    expect((await one<any>(`SELECT chain_root FROM official_warnings WHERE identifier = 'A1'`))!.chain_root).toBe('A1');
    const steps = await stepsOf(f.automationId);
    expect(steps[0].info).toMatch(/angelegt und zur Freigabe eingereicht.*folgt der Warnung/);
    // Oberfläche: Herkunft „aus Workflow … · folgt der Warnung“
    const list = (await admin.get('/banners')).json.find((x: any) => x.id === bs[0].id);
    expect(list).toMatchObject({ automation_id: f.automationId, automation_name: 'Unwetter → Banner', follows: true, source_kind: 'warnung', ended_reason: null, state: 'in_review' });
  });

  it('Aktualisierung → dasselbe Banner (noch nicht freigegeben: liegt weiter zur Freigabe), kein zweites', async () => {
    await wf.deliver(cap('U1', { msgType: 'Update', refs: ['A1'], minute: 10, headline: 'Unwetterwarnung vor schweren Sturmböen', severity: 'Extreme' }));
    await drain();
    const bs = await bannersOf(f.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Unwetterwarnung vor schweren Sturmböen', revision: 2, source_key: warningKey('A1') });
    expect(bs[0].submitted_at).not.toBeNull();
    expect(bs[0].approved_hash).toBeNull();
    expect(bs[0].follow_hash).toBe(bs[0].content_hash);
    const steps = await stepsOf(f.automationId);
    expect(steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(steps[1].info).toMatch(/aktualisiert – liegt weiter zur Freigabe/);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'automation.banner_updated' AND object_id = $1`, [bs[0].id])).not.toBeNull();
  });

  it('zweite Aktualisierung, die nur auf die erste verweist, gehört zum selben Vorgang', async () => {
    await wf.deliver(cap('U2', { msgType: 'Update', refs: ['U1'], minute: 20, headline: 'Unwetterwarnung vor orkanartigen Böen' }));
    await drain();
    expect((await one<any>(`SELECT chain_root FROM official_warnings WHERE identifier = 'U2'`))!.chain_root).toBe('A1');
    const bs = await bannersOf(f.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Unwetterwarnung vor orkanartigen Böen', revision: 3 });
  });

  it('schon freigegeben und veröffentlicht → neue Fassung zur Freigabe, die veröffentlichte bleibt auf der Website', async () => {
    const [b] = await bannersOf(f.automationId);
    await approveAndPublish(b);
    await wf.deliver(cap('U3', { msgType: 'Update', refs: ['U2'], minute: 30, headline: 'Unwetterwarnung vor Orkanböen' }));
    await drain();
    const [u] = await bannersOf(f.automationId);
    expect(u).toMatchObject({ title: 'Unwetterwarnung vor Orkanböen', revision: 4, approved_hash: b.content_hash });
    expect(u.content_hash).not.toBe(b.content_hash);
    expect(u.submitted_at).not.toBeNull();
    // kein neuer Auftrag an die Website: dort steht weiter Fassung 3
    expect(await jobsOf(u.id)).toEqual([{ action: 'upsert', revision: 3, status: 'done' }]);
    const list = (await admin.get('/banners')).json.find((x: any) => x.id === u.id);
    expect(list).toMatchObject({ state: 'in_review', live_revision: 3, revision: 4 });
    expect((await stepsOf(f.automationId)).at(-1)!.info).toMatch(/neue Fassung ist zur Freigabe eingereicht; auf der Website bleibt die bisherige Fassung/);
    // Freigabe-Benachrichtigung verweist auf genau dieses Banner
    expect(await one(`SELECT 1 FROM notifications WHERE permission = 'approval.banner' AND resolved_at IS NULL AND link = $1`, [`/banner?banner=${u.id}`])).not.toBeNull();
  });

  it('Entwarnung (Auslöser ohne „Entwarnung“) beendet das Banner beim Eingang: Ende, Auftrag zum Entfernen, Audit, kein Lauf', async () => {
    const runsBefore = (await stepsOf(f.automationId)).length;
    await wf.deliver(cap('C1', { msgType: 'Cancel', refs: ['U3'], minute: 40, headline: 'Entwarnung', severity: 'Minor' }));
    await drain();
    const bs = await bannersOf(f.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0].ended_at).not.toBeNull();
    expect(bs[0].ended_reason).toBe('entwarnung');
    expect((await jobsOf(bs[0].id)).at(-1)).toMatchObject({ action: 'delete', status: 'queued' });
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'banner.follow_ended' AND object_id = $1`, [bs[0].id])).not.toBeNull();
    expect((await stepsOf(f.automationId)).length).toBe(runsBefore);
    expect(await one(`SELECT 1 FROM banner_follow_ends WHERE source_key = $1 AND reason = 'entwarnung'`, [warningKey('A1')])).not.toBeNull();
    // Die offene Freigabe-Anfrage ist erledigt
    expect(await one(`SELECT 1 FROM notifications WHERE permission = 'approval.banner' AND resolved_at IS NULL`)).toBeNull();
    const list = (await admin.get('/banners')).json.find((x: any) => x.id === bs[0].id);
    expect(list).toMatchObject({ state: 'ended', ended_reason: 'entwarnung', live_revision: null });
  });

  it('Auslöser nur „Neue Warnung“: Aktualisierung startet nichts, die Entwarnung beendet trotzdem', async () => {
    const w = await warnfeed('DWD Nur neu');
    const g = await flow({ name: 'Nur neue Warnungen', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu'] } });
    await w.deliver(cap('B1', { minute: 0, headline: 'Glätte' }));
    await drain();
    await w.deliver(cap('B2', { msgType: 'Update', refs: ['B1'], minute: 5, headline: 'Strenger Frost' }));
    await drain();
    let bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Glätte', revision: 1 });
    await w.deliver(cap('B3', { msgType: 'Cancel', refs: ['B2'], minute: 9, headline: 'Entwarnung' }));
    await drain();
    bs = await bannersOf(g.automationId);
    expect(bs[0].ended_reason).toBe('entwarnung');
    // nie veröffentlicht → kein Auftrag zum Entfernen
    expect(await jobsOf(bs[0].id)).toEqual([]);
  });

  it('Workflow inzwischen deaktiviert: die Entwarnung beendet das Banner trotzdem', async () => {
    const w = await warnfeed('DWD Deaktiviert');
    const g = await flow({ name: 'Später deaktiviert', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung', 'entwarnung'] } });
    await w.deliver(cap('D1', { minute: 0, headline: 'Dauerregen' }));
    await drain();
    expect((await admin.post(`/automations/${g.automationId}/disable`)).status).toBe(200);
    await w.deliver(cap('D2', { msgType: 'Cancel', refs: ['D1'], minute: 30, headline: 'Entwarnung' }));
    await drain();
    const bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0].ended_reason).toBe('entwarnung');
  });

  it('Entwarnung erreicht die Banner-Aktion: kein neues Banner (übersprungen mit Hinweis); ohne früheres Banner entsteht nichts', async () => {
    const w = await warnfeed('DWD Mit Entwarnung');
    const g = await flow({ name: 'Mit Entwarnung', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung', 'entwarnung'] } });
    await w.deliver(cap('E1', { minute: 0, headline: 'Gewitter' }));
    await drain();
    await w.deliver(cap('E2', { msgType: 'Cancel', refs: ['E1'], minute: 15, headline: 'Entwarnung Gewitter' }));
    await drain();
    let bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0].ended_reason).toBe('entwarnung');
    let steps = await stepsOf(g.automationId);
    expect(steps.at(-1)).toMatchObject({ status: 'skipped', vorgang: 'entwarnung' });
    expect(steps.at(-1)!.info).toMatch(/Entwarnung – kein neues Banner.*1 Banner dieses Vorgangs wurde beim Eingang beendet/);
    // Entwarnung zu einer unbekannten Meldung: Lauf, aber kein Banner
    await w.deliver(cap('E9', { msgType: 'Cancel', refs: ['UNBEKANNT-1'], minute: 20, headline: 'Entwarnung unbekannt' }));
    await drain();
    bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    steps = await stepsOf(g.automationId);
    expect(steps.at(-1)!.status).toBe('skipped');
    expect(steps.at(-1)!.info).toMatch(/Ein aktives Banner dieser Aktion gab es zu diesem Vorgang nicht/);
  });

  it('von Hand beendet → Aktualisierung legt kein neues Banner an; von Hand geändert → nicht überschrieben', async () => {
    const w = await warnfeed('DWD Von Hand');
    const g = await flow({ name: 'Von Hand', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung'] } });
    await w.deliver(cap('H1', { minute: 0, headline: 'Nebel' }));
    await drain();
    const [b] = await bannersOf(g.automationId);
    expect((await admin.post(`/banners/${b.id}/end`)).status).toBe(200);
    await w.deliver(cap('H2', { msgType: 'Update', refs: ['H1'], minute: 5, headline: 'Dichter Nebel' }));
    await drain();
    let bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0].title).toBe('Nebel');
    expect(bs[0].ended_reason).toBeNull();
    let steps = await stepsOf(g.automationId);
    expect(steps.at(-1)).toMatchObject({ status: 'skipped' });
    expect(steps.at(-1)!.info).toMatch(/wurde von Hand beendet – nicht neu angelegt/);

    await w.deliver(cap('H5', { minute: 10, headline: 'Schneefall' }));
    await drain();
    bs = await bannersOf(g.automationId);
    const s = bs.find((x) => x.title === 'Schneefall')!;
    const edit = await admin.put(`/banners/${s.id}`, { siteId, title: 'Schneefall – Winterdienst unterwegs', text: s.text, tone: s.tone, priority: s.priority, endsAt: new Date(s.ends_at).toISOString(), linkUrl: s.link_url, linkText: s.link_text, display: s.display });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    await w.deliver(cap('H6', { msgType: 'Update', refs: ['H5'], minute: 15, headline: 'Starker Schneefall' }));
    await drain();
    const after = (await bannersOf(g.automationId)).find((x) => x.id === s.id)!;
    expect(after.title).toBe('Schneefall – Winterdienst unterwegs');
    expect((await bannersOf(g.automationId)).length).toBe(2);
    steps = await stepsOf(g.automationId);
    expect(steps.at(-1)!.info).toMatch(/von Hand geändert – Aktualisierung nicht übernommen/);
    // Die Entwarnung beendet auch das von Hand geänderte Banner
    await w.deliver(cap('H7', { msgType: 'Cancel', refs: ['H6'], minute: 20, headline: 'Entwarnung' }));
    expect((await one<any>(`SELECT ended_reason FROM banners WHERE id = $1`, [s.id]))!.ended_reason).toBe('entwarnung');
  });

  it('Direktversand: Aktualisierung wird direkt veröffentlicht', async () => {
    const w = await warnfeed('DWD Direkt');
    const g = await flow({ name: 'Direkt', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung'] }, direct: true });
    await w.deliver(cap('X1', { minute: 0, headline: 'Hitze' }));
    await drain();
    const [b] = await bannersOf(g.automationId);
    expect(b.approved_hash).toBe(b.content_hash);
    await pool.query(`UPDATE banner_jobs SET status = 'done' WHERE banner_id = $1`, [b.id]);
    await w.deliver(cap('X2', { msgType: 'Update', refs: ['X1'], minute: 5, headline: 'Extreme Hitze' }));
    await drain();
    const bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Extreme Hitze', revision: 2 });
    expect(bs[0].approved_hash).toBe(bs[0].content_hash);
    expect(await jobsOf(b.id)).toEqual([
      { action: 'upsert', revision: 1, status: 'done' },
      { action: 'upsert', revision: 2, status: 'queued' },
    ]);
    expect((await stepsOf(g.automationId)).at(-1)!.info).toMatch(/aktualisiert und direkt veröffentlicht/);
  });

  it('Entwurf ohne Einreichen: Aktualisierung bleibt Entwurf; zwei Websites je ein Banner, beide aktualisiert', async () => {
    const w = await warnfeed('DWD Entwurf');
    const g = await flow({ name: 'Entwurf zwei Seiten', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung'] }, banner: { submit: false, siteIds: [siteId, site2Id] } });
    await w.deliver(cap('Y1', { minute: 0, headline: 'Sturm' }));
    await drain();
    await w.deliver(cap('Y2', { msgType: 'Update', refs: ['Y1'], minute: 5, headline: 'Schwerer Sturm' }));
    await drain();
    const bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(2);
    for (const b of bs) expect(b).toMatchObject({ title: 'Schwerer Sturm', revision: 2, submitted_at: null, approved_hash: null });
    expect((await stepsOf(g.automationId)).at(-1)!.info).toMatch(/Testseite – aktualisiert \(Entwurf\); Zweite Seite – aktualisiert \(Entwurf\)/);
  });

  it('ältere Meldung überschreibt keinen neueren Stand', async () => {
    const w = await warnfeed('DWD Reihenfolge');
    const g = await flow({ name: 'Reihenfolge', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung'] } });
    await w.deliver(cap('R1', { minute: 0, headline: 'Starkregen' }));
    await drain();
    // Zwei Aktualisierungen kommen an, bevor eine ausgeführt ist; der Lauf der älteren wird zuletzt ausgeführt
    await w.deliver(cap('R2', { msgType: 'Update', refs: ['R1'], minute: 5, headline: 'Starkregen – älter' }));
    await w.deliver(cap('R3', { msgType: 'Update', refs: ['R2'], minute: 6, headline: 'Starkregen – neuer' }));
    const runs = await many<any>(`SELECT id FROM automation_runs WHERE automation_id = $1 AND mode = 'live' AND status = 'queued' ORDER BY created_at`, [g.automationId]);
    expect(runs.length).toBe(2);
    await executeRun(runs[1].id);
    await executeRun(runs[0].id);
    const [b] = await bannersOf(g.automationId);
    expect(b.title).toBe('Starkregen – neuer');
    const older = await one<any>(`SELECT status, info FROM automation_steps WHERE run_id = $1 AND node_id = 'b'`, [runs[0].id]);
    expect(older).toMatchObject({ status: 'skipped' });
    expect(older.info).toMatch(/zeigt schon einen neueren Stand – ältere Meldung nicht übernommen/);
    await drain();
  });

  it('Option aus: bisheriges Verhalten – jede Meldung ein eigenes Banner, die Entwarnung beendet nichts', async () => {
    const w = await warnfeed('DWD Ohne Folgen');
    const g = await flow({ name: 'Ohne Folgen', input: { kind: 'warnfeed', connectionId: w.id, phases: ['neu', 'aktualisierung'] }, banner: { follow: false } });
    await w.deliver(cap('O1', { minute: 0, headline: 'Wind' }));
    await drain();
    await w.deliver(cap('O2', { msgType: 'Update', refs: ['O1'], minute: 5, headline: 'Starker Wind' }));
    await drain();
    await w.deliver(cap('O3', { msgType: 'Cancel', refs: ['O2'], minute: 9, headline: 'Entwarnung' }));
    await drain();
    const bs = await bannersOf(g.automationId);
    expect(bs.map((b) => b.title)).toEqual(['Wind', 'Starker Wind']);
    for (const b of bs) expect(b).toMatchObject({ follows: false, ended_at: null });
    expect((await admin.get('/banners')).json.find((x: any) => x.id === bs[0].id)).toMatchObject({ follows: false, automation_name: 'Ohne Folgen' });
  });
});

describe('Banner folgt dem Vorgang: Einsätze aus FE2 (#274)', () => {
  it('neuer Einsatz → Banner, Aktualisierung → dasselbe Banner, Einsatz beendet → Banner endet und wird entfernt', async () => {
    const conn = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('fe2', 'FE2 Leitstelle', 'active', '{}') RETURNING *`);
    const g = await flow({ name: 'Großeinsatz → Banner', input: { kind: 'fe2', connectionId: conn!.id, phases: ['neu', 'aktualisierung'] }, banner: { tone: 'warning', linkUrl: '' } });
    const c = await loadConnection(conn!.id);
    await handleFe2Event(c, { einsatz: { id: 'GE-1', stichwort: 'B3', stichwort_text: 'Brand Wohngebäude', ort: 'Nord' } });
    await drain();
    let bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Einsatz: B3 in Nord', source_key: incidentKey(conn!.id, 'GE-1'), follows: true });
    expect((await stepsOf(g.automationId))[0].info).toMatch(/folgt dem Einsatz/);
    await handleFe2Event(c, { einsatz: { id: 'GE-1', stichwort: 'B4', stichwort_text: 'Brand Großobjekt', ort: 'Nord' } });
    await drain();
    bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0]).toMatchObject({ title: 'Einsatz: B4 in Nord', revision: 2 });
    await approveAndPublish(bs[0]);
    await handleFe2Event(c, { einsatz: { id: 'GE-1', stichwort: 'B4', stichwort_text: 'Brand Großobjekt', ort: 'Nord', status: 'beendet' } });
    bs = await bannersOf(g.automationId);
    expect(bs.length).toBe(1);
    expect(bs[0].ended_reason).toBe('einsatz_beendet');
    expect((await jobsOf(bs[0].id)).at(-1)).toMatchObject({ action: 'delete', status: 'queued' });
    expect((await admin.get('/banners')).json.find((x: any) => x.id === bs[0].id)).toMatchObject({ state: 'ended', ended_reason: 'einsatz_beendet', source_kind: 'einsatz' });
    await drain();
    expect((await bannersOf(g.automationId)).length).toBe(1);
  });

  it('Einsatz beendet, bevor der Lauf der Erstmeldung ausgeführt ist: kein Banner', async () => {
    const conn = await one<any>(`INSERT INTO connections (kind, name, status, config) VALUES ('fe2', 'FE2 Kurz', 'active', '{}') RETURNING *`);
    const g = await flow({ name: 'Kurzer Einsatz', input: { kind: 'fe2', connectionId: conn!.id, phases: ['neu'] }, banner: { linkUrl: '' } });
    const c = await loadConnection(conn!.id);
    await handleFe2Event(c, { einsatz: { id: 'K-1', stichwort: 'TH1', ort: 'Süd' } });
    await handleFe2Event(c, { einsatz: { id: 'K-1', stichwort: 'TH1', ort: 'Süd', status: 'beendet' } });
    await drain();
    expect(await bannersOf(g.automationId)).toEqual([]);
    const steps = await stepsOf(g.automationId);
    expect(steps).toMatchObject([{ status: 'skipped' }]);
    expect(steps[0].info).toMatch(/Der Vorgang ist schon beendet \(Einsatz beendet\) – kein Banner angelegt/);
  });
});
