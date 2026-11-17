import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, one, many } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { claimJobs, completeJob, failJob } from '../src/jobs/queue.js';
import { executeRun } from '../src/automations/engine.js';
import { syncCatalog } from '../src/keywords/store.js';
import { mediaPaths } from '../src/media/storage.js';

/**
 * Einsatzliste (#213) gegen eine echte PostgreSQL-Datenbank: Rechte, Ort nur grob (Allowlist und Adressprüfung),
 * Freigabe genau dieser Fassung mit Vier-Augen-Prinzip, Aufträge an die Bridge (erst ab 0.9.0), Rückmeldung,
 * Zurückziehen, Vorschläge aus Einsatzmeldungen, CSV-Import (Format der „Einsatzverwaltung“), Sammelaktionen und der
 * Workflow-Ausgang „Einsatz in Einsatzliste“.
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
  get = (u: string, h?: Record<string, string>) => this.raw('GET', u, undefined, h);
  post = (u: string, b: unknown = {}, h?: Record<string, string>) => this.raw('POST', u, b, h);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  del = (u: string) => this.raw('DELETE', u, {});
}

let admin: Client;
let editor: Client;
let approver: Client;
let publisher: Client;
let anonymous: Client;
let siteId = '';
let key = '';
const bridge = (v: string | null = '0.9.0') => ({ authorization: `Bearer ${key}`, ...(v ? { 'x-blaulichtcms-bridge-version': v } : {}) });

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return c;
}

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

const base = { alarmAt: '2026-11-14T13:30:00.000Z', keyword: 'F 2', title: 'Kaminbrand', location: 'Nord', vehicles: 'HLF, DLK', units: 'Polizei' };
const entry = async (c: Client, id: string) => (await c.get(`/incidents/${id}`)).json;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
  anonymous = new Client(app);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Einsatzliste: Einrichtung, Rechte und Datenschutz', () => {
  it('richtet Konten, Website und Stichwortverzeichnis ein', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    editor = await acceptInvite('redaktion@example.org', ['editor'], 'Robin');
    approver = await acceptInvite('freigabe@example.org', ['approver'], 'Sam');
    publisher = await acceptInvite('veroeffentlichung@example.org', ['publisher'], 'Kim');
    const s = await admin.post('/sites', { name: 'Feuerwehr-Website' });
    siteId = s.json.site.id;
    const prefix = crypto.randomBytes(6).toString('hex');
    key = `bcb_${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
    await pool.query(`UPDATE wp_sites SET status = 'active', key_prefix = $2, key_hash = $3, pairing_code_hash = NULL, site_url = 'https://wehr.example.org', paired_at = now() WHERE id = $1`, [siteId, prefix, crypto.createHash('sha256').update(key).digest('hex')]);
    await syncCatalog('HE', { activate: true });
  });

  it('Rechte: Lesen, Bearbeiten, Freigeben, Veröffentlichen und Einstellungen getrennt', async () => {
    expect((await anonymous.get('/incidents')).status).toBe(401);
    expect((await editor.get('/incidents')).status).toBe(200);
    expect((await editor.put('/incidents/config', { locations: ['Nord'] })).status).toBe(403);
    expect((await approver.post('/incidents', base)).status).toBe(403);
    // Rollen-Vorgaben: Redaktion bearbeitet, Freigabe gibt frei, Veröffentlichung veröffentlicht
    const me = async (c: Client) => (await c.get('/auth/me')).json.permissions as string[];
    expect(await me(editor)).toEqual(expect.arrayContaining(['incident.view', 'incident.edit']));
    expect(await me(editor)).not.toContain('approval.incident');
    expect(await me(approver)).toContain('approval.incident');
    expect(await me(publisher)).toContain('incident.publish');
  });

  it('Ort nur grob: ohne Allowlist keine Straßen/Hausnummern, mit Allowlist nur erlaubte Ortsangaben', async () => {
    const bad = await editor.post('/incidents', { ...base, location: 'Hauptstraße 5' });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/Ortsteil/);
    expect((await editor.post('/incidents', { ...base, location: 'Im Brühl' })).status).toBe(400);
    expect((await admin.put('/incidents/config', { locations: ['Nord', 'Süd', 'Musterstadt', 'nord'], defaultSiteId: siteId })).json.locations).toEqual(['Nord', 'Süd', 'Musterstadt']);
    expect((await admin.put('/incidents/config', { locations: ['Hauptstraße 5'] })).status).toBe(400);
    expect((await editor.post('/incidents', { ...base, location: 'Ost' })).status).toBe(400);
    const cfg = (await editor.get('/incidents/config')).json;
    expect(cfg.locations).toHaveLength(3);
    expect(cfg.sites[0]).toMatchObject({ id: siteId, supports_list: false });
  });
});

describe('Einsatzliste: Freigabe, Veröffentlichung, Zurückziehen', () => {
  let id = '';

  it('legt an (Bedeutung und Kategorie aus dem Stichwortverzeichnis), reicht ein und gibt genau diese Fassung frei', async () => {
    const c = await editor.post('/incidents', { ...base, location: 'nord' });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    id = c.json.id;
    expect(c.json).toMatchObject({ location: 'Nord', category: 'Brand', site_id: siteId, state: 'draft', source: 'manual' });
    expect(c.json.keyword_label).not.toBe('');
    // Nicht eingereicht → keine Freigabe
    expect((await approver.post(`/incidents/${id}/approve`, { contentHash: c.json.content_hash })).status).toBe(409);
    expect((await editor.post(`/incidents/${id}/submit`)).status).toBe(200);
    expect((await editor.post(`/incidents/${id}/approve`, { contentHash: c.json.content_hash })).status).toBe(403);
    expect((await approver.post(`/incidents/${id}/approve`, { contentHash: 'x'.repeat(64) })).status).toBe(409);
    expect((await approver.post(`/incidents/${id}/approve`, { contentHash: c.json.content_hash })).status).toBe(200);
    expect((await entry(editor, id)).state).toBe('approved');
    expect(await one(`SELECT 1 FROM notifications WHERE permission = 'approval.incident'`)).not.toBeNull();
  });

  it('Vier-Augen-Prinzip: wer angelegt oder eingereicht hat, gibt nicht selbst frei', async () => {
    await setSettings({ 'editorial.four_eyes': true });
    const c = await admin.post('/incidents', { ...base, title: 'Eigener Eintrag' });
    await admin.post(`/incidents/${c.json.id}/submit`);
    const r = await admin.post(`/incidents/${c.json.id}/approve`, { contentHash: c.json.content_hash });
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/Vier-Augen/);
    expect((await admin.del(`/incidents/${c.json.id}`)).status).toBe(200);
    await setSettings({ 'editorial.four_eyes': false });
  });

  it('veröffentlicht erst ab Bridge 0.9.0; die Bridge meldet zurück', async () => {
    const e = await entry(publisher, id);
    expect((await editor.post(`/incidents/${id}/publish`, { contentHash: e.content_hash })).status).toBe(403);
    const p = await publisher.post(`/incidents/${id}/publish`, { contentHash: e.content_hash });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect((await publisher.post(`/incidents/${id}/publish`, { contentHash: e.content_hash })).json.duplicate).toBe(true);
    expect((await entry(editor, id)).state).toBe('publishing');
    // Ältere Bridge: Auftrag wartet
    const old = await anonymous.get('/bridge/jobs', bridge('0.8.0'));
    expect(old.json.jobs.filter((j: any) => j.type.startsWith('incident.'))).toEqual([]);
    const jobs = (await anonymous.get('/bridge/jobs', bridge())).json.jobs.filter((j: any) => j.type === 'incident.upsert');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].incident).toMatchObject({ id, title: 'Kaminbrand', location: 'Nord', keyword: 'F 2', category: 'Brand', vehicles: 'HLF, DLK', units: 'Polizei', featured: false, false_alarm: false, cover_media_id: null });
    expect(jobs[0].incident.alarm_at).toBe('2026-11-14T13:30:00.000Z');
    expect(jobs[0].media).toEqual([]);
    const r = await anonymous.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_id: 42, url: 'https://wehr.example.org/einsatz/kaminbrand/' }, bridge());
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await anonymous.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_id: 42, url: 'https://wehr.example.org/einsatz/kaminbrand/' }, bridge())).json.duplicate).toBe(true);
    const now = await entry(editor, id);
    expect(now.state).toBe('live');
    expect(now.job.remote_url).toBe('https://wehr.example.org/einsatz/kaminbrand/');
    // Steht auf der Website: nicht löschbar
    expect((await editor.del(`/incidents/${id}`)).status).toBe(409);
  });

  it('Änderung ergibt eine neue Fassung ohne Freigabe; die alte bleibt bis zum erneuten Veröffentlichen', async () => {
    const e = await entry(editor, id);
    const u = await editor.put(`/incidents/${id}`, { ...base, location: 'Nord', report: 'Kurz gelöscht.', siteId });
    expect(u.json.changed).toBe(true);
    expect(u.json.revision).toBe(e.revision + 1);
    expect(u.json.approved_at).toBeNull();
    const pub = await publisher.post(`/incidents/${id}/publish`, { contentHash: u.json.content_hash });
    expect(pub.status).toBe(409);
    // unveränderte Speicherung ändert nichts
    expect((await editor.put(`/incidents/${id}`, { ...base, location: 'Nord', report: 'Kurz gelöscht.', siteId })).json.changed).toBe(false);
  });

  it('zurückziehen: Auftrag zum Entfernen, danach löschbar', async () => {
    expect((await editor.post(`/incidents/${id}/withdraw`)).status).toBe(403);
    expect((await publisher.post(`/incidents/${id}/withdraw`)).status).toBe(200);
    expect((await entry(editor, id)).state).toBe('withdrawing');
    const jobs = (await anonymous.get('/bridge/jobs', bridge())).json.jobs.filter((j: any) => j.type === 'incident.delete');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].incident).toEqual({ id });
    await anonymous.post(`/bridge/jobs/${jobs[0].id}/result`, { status: 'published', remote_status: 'deleted' }, bridge());
    expect((await entry(editor, id)).state).toBe('withdrawn');
    expect((await publisher.post(`/incidents/${id}/withdraw`)).status).toBe(409);
    expect((await editor.del(`/incidents/${id}`)).status).toBe(200);
    expect((await editor.get(`/incidents/${id}`)).status).toBe(404);
  });

  it('zurückweisen mit Begründung geht an die einreichende Person', async () => {
    const c = await editor.post('/incidents', { ...base, title: 'Wasserschaden', keyword: 'H 1' });
    await editor.post(`/incidents/${c.json.id}/submit`);
    expect((await approver.post(`/incidents/${c.json.id}/reject`, { note: '' })).status).toBe(400);
    expect((await approver.post(`/incidents/${c.json.id}/reject`, { note: 'Bitte Fahrzeuge ergänzen.' })).status).toBe(200);
    const e = await entry(editor, c.json.id);
    expect(e).toMatchObject({ state: 'draft', rejected_note: 'Bitte Fahrzeuge ergänzen.' });
    expect(await one(`SELECT 1 FROM notifications WHERE category = 'decision' AND title LIKE '%Wasserschaden%'`)).not.toBeNull();
  });
});

describe('Einsatzliste: Vorschläge, Import, Sammelaktionen, Workflow', () => {
  it('schlägt Einträge aus Einsatzmeldungen vor (nur Allowlist-Felder, Ort grob) und übernimmt jede nur einmal', async () => {
    const ev = await one<any>(
      `INSERT INTO fe2_events (event_key, keyword, title, fields, status, source) VALUES ('x:1', 'F 2', 'Brand', $1, 'open', 'fe2') RETURNING id`,
      [JSON.stringify({ keyword: 'F 2', keyword_text: 'Wohnungsbrand', district: 'Süd', municipality: 'Musterstadt', started_at: '2026-11-15T20:40:00.000Z', units: 'HLF 1' })],
    );
    const sr = await editor.get('/incidents/suggestions');
    expect(sr.status, JSON.stringify(sr.json)).toBe(200);
    const s = sr.json;
    expect(s.find((x: any) => x.id === ev.id)).toMatchObject({ title: 'Wohnungsbrand', location: 'Süd', keyword: 'F 2' });
    const r = await editor.post(`/incidents/suggestions/${ev.id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await editor.post(`/incidents/suggestions/${ev.id}`)).status).toBe(409);
    expect((await editor.get('/incidents/suggestions')).json.find((x: any) => x.id === ev.id)).toBeUndefined();
    const e = await entry(editor, r.json.id);
    expect(e).toMatchObject({ source: 'alarm', location: 'Süd', units: 'HLF 1', alarm_at: '2026-11-15T20:40:00.000Z', site_id: siteId });
  });

  const csv = [
    '﻿"Einsatznummer","Lfd.","Alarmierungsart","Alarmzeit","Einsatzende","Dauer (Minuten)","Einsatzort","Einsatzart","Fahrzeuge","Externe Einsatzmittel","Mannschaftsstärke","Einsatzleiter","Berichtstitel","Berichtstext","Besonderer Einsatz","Fehlalarm"',
    '"202500081","81","","2025-11-14 14:30","","0","Gartenstraße , Musterstadt","H 1 Y TÜR R 2","","","","Max Muster","Notfalltüröffnung","Text mit Namen","Nein","Nein"',
    '"202500080","80","","2025-11-06 17:28","","35","Im Brühl","H 1","HLF","Polizei, Rettungsdienst","9","Erika Beispiel","Wasserschaden","","Nein","Nein"',
    '"202500079","79","","2025-11-01 20:40","","60","Nord","F 2","HLF, DLK","Rettungsdienst","12","","Kaminbrand","Kurzbericht","Ja","Nein"',
    '"202500078","78","","kein Datum","","0","","F 1","","","","","Unlesbar","","Nein","Nein"',
  ].join('\r\n');

  it('importiert den CSV-Export der „Einsatzverwaltung“: Vorschau, Ort grob, keine Namen, keine Doppelten', async () => {
    const dry = await editor.post('/incidents/import', { csv, dryRun: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json).toMatchObject({ total: 3, duplicates: 0, created: 0 });
    expect(dry.json.errors[0]).toMatch(/Zeile 5/);
    expect(dry.json.preview.map((p: any) => p.location)).toEqual(['Musterstadt', '', 'Nord']);
    expect(dry.json.location_removed).toBe(1);
    expect(await one(`SELECT 1 FROM incident_entries WHERE source = 'import'`)).toBeNull();
    const real = await editor.post('/incidents/import', { csv, dryRun: false, submit: true, siteId });
    expect(real.json.created).toBe(3);
    const rows = await many<any>(`SELECT * FROM incident_entries WHERE source = 'import' ORDER BY alarm_at`);
    expect(rows.map((r) => r.number)).toEqual([79, 80, 81]);
    expect(rows[0]).toMatchObject({ featured: true, vehicles: 'HLF, DLK', units: 'Rettungsdienst', report: '', category: 'Brand' });
    expect(rows.map((r) => r.report).join('')).toBe('');
    expect(JSON.stringify(rows)).not.toMatch(/Max Muster|Erika|Gartenstraße/);
    // Ortszeit: 14:30 in Berlin (Winterzeit) = 13:30 UTC
    expect(new Date(rows[2].alarm_at).toISOString()).toBe('2025-11-14T13:30:00.000Z');
    expect((await editor.post('/incidents/import', { csv, dryRun: true })).json.duplicates).toBe(3);
    expect((await editor.post('/incidents/import', { csv, dryRun: false })).json.created).toBe(0);
    expect((await editor.post('/incidents/import', { csv: 'a;b\n1;2', dryRun: true })).json.errors[0]).toMatch(/Alarmzeit/);
    const years = (await editor.get('/incidents?year=2025')).json;
    expect(years.entries).toHaveLength(3);
    expect(years.years.map((y: any) => y.year)).toEqual([2026, 2025]);
  });

  it('Sammelaktionen: freigeben und veröffentlichen (mit Prüfsumme je Eintrag)', async () => {
    const list = (await approver.get('/incidents?year=2025')).json.entries;
    const items = list.map((e: any) => ({ id: e.id, contentHash: e.content_hash }));
    const a = await approver.post('/incidents/bulk/approve', { items: [...items, { id: items[0].id, contentHash: 'y'.repeat(64) }] });
    expect(a.json.done).toBe(3);
    expect(a.json.skipped).toHaveLength(1);
    const p = await publisher.post('/incidents/bulk/publish', { items });
    expect(p.json).toMatchObject({ done: 3, skipped: [] });
    const jobs = (await anonymous.get('/bridge/jobs', bridge())).json.jobs.filter((j: any) => j.type === 'incident.upsert');
    expect(jobs).toHaveLength(3);
    expect(jobs.find((j: any) => j.incident.number === 79).incident.featured).toBe(true);
  });

  it('Workflow-Ausgang „Einsatz in Einsatzliste“: legt je Einsatz einen Eintrag an, Ort gegen die Allowlist', async () => {
    const out = await admin.post('/automation-outputs', { name: 'Einsatzliste', kind: 'incident_entry', config: { title: '{{titel}}', keyword: '{{stw}}', alarmAt: '{{zeit}}', location: '{{ort}}', submit: true } });
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    const inp = await admin.post('/automation-inputs', {
      name: 'Von Hand',
      kind: 'manual',
      config: { fields: [{ key: 'titel', label: 'Titel', example: 'Brand' }, { key: 'stw', label: 'Stichwort', example: 'F 1' }, { key: 'zeit', label: 'Zeit', example: '2026-11-16T07:00:00.000Z' }, { key: 'ort', label: 'Ort', example: 'Nord' }] },
    });
    const auto = (await admin.post('/automations', { name: 'Einsatzliste füllen' })).json.id;
    const cur = await admin.get(`/automations/${auto}`);
    const graph = {
      nodes: [
        { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { inputId: inp.json.id } },
        { id: 'o', type: 'output', position: { x: 0, y: 100 }, data: { outputId: out.json.id } },
      ],
      edges: [{ id: 'e1', source: 'in', target: 'o', sourceHandle: 'out' }],
    };
    expect((await admin.put(`/automations/${auto}`, { name: 'Einsatzliste füllen', description: '', graph, baseHash: cur.json.draft_hash })).status).toBe(200);
    await pool.query(`UPDATE sessions SET reauth_at = now()`);
    const t = await admin.post(`/automations/${auto}/test`, {});
    expect(t.json.status, JSON.stringify(t.json.steps)).toBe('succeeded');
    expect((await admin.post(`/automations/${auto}/activate`)).status).toBe(200);
    const payload = { titel: 'Verkehrsunfall', stw: 'H 2', zeit: '2026-11-16T06:12:00.000Z', ort: 'Landstraße 3, Musterstadt' };
    expect((await admin.post(`/automations/${auto}/run`, { inputNodeId: 'in', payload })).status).toBe(200);
    await drain();
    // Aktualisierung desselben Einsatzes: kein zweiter Eintrag
    expect((await admin.post(`/automations/${auto}/run`, { inputNodeId: 'in', payload: { ...payload, titel: 'Verkehrsunfall (Update)' } })).status).toBe(200);
    await drain();
    const runs = await many<any>(`SELECT r.status, r.error, s.error AS step_error FROM automation_runs r LEFT JOIN automation_steps s ON s.run_id = r.id AND s.error IS NOT NULL WHERE r.automation_id = $1 AND r.mode = 'live'`, [auto]);
    expect(runs.map((r) => r.status), JSON.stringify(runs)).toEqual(['succeeded', 'succeeded']);
    const rows = await many<any>(`SELECT * FROM incident_entries WHERE source = 'workflow'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Verkehrsunfall', location: 'Musterstadt', keyword: 'H 2', category: 'Hilfeleistung', site_id: siteId });
    expect(rows[0].submitted_at).not.toBeNull();
    expect(new Date(rows[0].alarm_at).toISOString()).toBe('2026-11-16T06:12:00.000Z');
  });
});

describe('Einsatzliste: Datenschutz-Prüfung für Bilder (#241)', () => {
  let colId = '';
  /** Geprüftes Bild mit öffentlicher Fassung (Datei als Platzhalter), optional markiert bzw. mit Gesichtsvorschlägen */
  const addImage = async (flags: string[] = [], faces: unknown[] = []) => {
    const m = await one<any>(
      `INSERT INTO media (collection_id, original_name, size_bytes, sha256, status, kind, has_preview, has_public, processed_at, sensitive_flags, face_proposals)
       VALUES ($1, 'bild.jpg', 10, md5(random()::text) || md5(random()::text), 'ready', 'image', true, true, now(), $2, $3) RETURNING id`,
      [colId, flags, JSON.stringify(faces)],
    );
    const f = mediaPaths.publicFile(m!.id, 'jpg');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    return m!.id as string;
  };
  const submitted = async (title: string, mediaIds: string[]) => {
    const c = await editor.post('/incidents', { ...base, title, location: 'Nord', siteId, mediaIds });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect((await editor.post(`/incidents/${c.json.id}/submit`)).status).toBe(200);
    return c.json as { id: string; content_hash: string };
  };
  const listed = async (id: string) => (await approver.get('/incidents?year=alle')).json.entries.find((e: any) => e.id === id);
  const media = (id: string) => anonymous.get(`/bridge/media/${id}`, bridge());
  const bridgeJobs = async () => (await anonymous.get('/bridge/jobs', bridge())).json.jobs.filter((j: any) => j.type.startsWith('incident.'));
  const done = (jobId: string, url = 'https://wehr.example.org/einsatz/x/') => anonymous.post(`/bridge/jobs/${jobId}/result`, { status: 'published', remote_id: 7, url }, bridge());
  let flaggedEntry = '';
  let laterEntry = '';
  let laterImage = '';

  it('richtet eine Sammlung für die Bilder ein', async () => {
    const col = await admin.post('/collections', { title: 'Einsatzfotos', createLink: false });
    expect(col.status, JSON.stringify(col.json)).toBe(200);
    colId = col.json.collection.id;
  });

  it('markiertes Bild: Freigabe nur mit bestätigter Datenschutz-Prüfung, Sammelfreigabe überspringt', async () => {
    const img = await addImage(['health']);
    const e = await submitted('Verkehrsunfall mit Foto', [img]);
    flaggedEntry = e.id;
    expect((await listed(e.id)).privacy).toMatchObject({ flagged: 1, faces: 0, flags: ['health'], approve_check: true });
    const no = await approver.post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash });
    expect(no.status).toBe(400);
    expect(no.json.error).toBe('privacy_check_required');
    const bulk = await approver.post('/incidents/bulk/approve', { items: [{ id: e.id, contentHash: e.content_hash }] });
    expect(bulk.json.done).toBe(0);
    expect(bulk.json.skipped[0].reason).toMatch(/Datenschutz-Prüfung/);
    const ok = await approver.post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash, privacyChecked: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const a = await one<any>(`SELECT details FROM audit_events WHERE action = 'incident.approved' AND object_id = $1::text ORDER BY id DESC LIMIT 1`, [e.id]);
    expect(a!.details).toMatchObject({ datenschutz_geprueft: true, markierte_medien: 1 });
    // Bestätigt bei der Freigabe → Veröffentlichen ohne erneute Nachfrage
    expect((await listed(e.id)).privacy.publish_check).toBe(false);
    expect((await publisher.post(`/incidents/${e.id}/publish`, { contentHash: e.content_hash })).status).toBe(200);
  });

  it('offene Gesichtsvorschläge verlangen dieselbe Prüfung', async () => {
    const img = await addImage([], [{ id: 'ab12cd34', x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9, status: 'open' }]);
    const e = await submitted('Brand mit Gesichtern', [img]);
    expect((await listed(e.id)).privacy).toMatchObject({ flagged: 0, faces: 1, approve_check: true });
    const no = await approver.post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash });
    expect(no.status).toBe(400);
    expect(no.json.message).toMatch(/Gesichtsvorschläge/);
    expect((await approver.post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash, privacyChecked: true })).status).toBe(200);
  });

  it('nach der Freigabe markiert: Veröffentlichen verlangt die Bestätigung (einzeln, Sammelaktion überspringt)', async () => {
    laterImage = await addImage();
    const e = await submitted('Kaminbrand mit Foto', [laterImage]);
    laterEntry = e.id;
    expect((await listed(e.id)).privacy.approve_check).toBe(false);
    expect((await approver.post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash })).status).toBe(200);
    await pool.query(`UPDATE media SET sensitive_flags = '{persons}' WHERE id = $1`, [laterImage]);
    expect((await listed(e.id)).privacy).toMatchObject({ approve_check: true, publish_check: true });
    const no = await publisher.post(`/incidents/${e.id}/publish`, { contentHash: e.content_hash });
    expect(no.status).toBe(400);
    expect(no.json.error).toBe('privacy_check_required');
    expect((await publisher.post('/incidents/bulk/publish', { items: [{ id: e.id, contentHash: e.content_hash }] })).json.done).toBe(0);
    const ok = await publisher.post(`/incidents/${e.id}/publish`, { contentHash: e.content_hash, privacyChecked: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const a = await one<any>(`SELECT details FROM audit_events WHERE action = 'incident.published' AND object_id = $1::text ORDER BY id DESC LIMIT 1`, [e.id]);
    expect(a!.details).toMatchObject({ datenschutz_geprueft: true, markierte_medien: 1 });
    expect((await listed(e.id)).privacy.publish_check).toBe(false);
  });
});
