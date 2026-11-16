import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { getSettings, setSettings } from '../src/lib/settings.js';
import { pushPayload } from '../src/lib/notify-channels.js';

/**
 * Freigabe direkt aus der Push-Mitteilung (#216): Link der Benachrichtigung, Aktionsknöpfe im Push-Inhalt,
 * Freigabe-Ansicht (Stand der Anfrage, Änderungen, Vier-Augen) und dass die bestehenden Regeln unverändert gelten.
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
let editor: Client;
let approver: Client;

async function acceptInvite(email: string, roles: string[], name: string) {
  const inv = await admin.post('/users/invite', { email, roles });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json.link.split('/einladung/')[1];
  const c = new Client(app);
  const acc = await c.post(`/auth/invite/${token}`, { name, password: `${name}-Zugang-sicher-2026` });
  expect(acc.json.next).toBe('done');
  return c;
}

async function draft(c: Client, title: string, body: string) {
  const p = await c.post('/posts', { kind: 'news', title });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const r = await c.put(`/posts/${p.json.id}/revision`, { baseRevision: 1, title, body });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: p.json.id as string, revision: r.json.number as number };
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  await migrate(() => {});
  app = await buildApp();
  admin = new Client(app);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Freigabe aus der Push-Mitteilung', () => {
  let postId = '';

  it('richtet Konten ein', async () => {
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'editorial.four_eyes': true });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    editor = await acceptInvite('redaktion@example.org', ['editor'], 'Robin');
    approver = await acceptInvite('freigabe@example.org', ['approver'], 'Sam');
    expect((await getSettings(true))['editorial.four_eyes']).toBe(true);
  });

  it('Einreichen benachrichtigt mit Link auf die Freigabe-Ansicht genau dieser Fassung', async () => {
    const p = await draft(editor, 'Hochwasser am Fluss', 'Der Pegel steigt. Bitte Ufer meiden.');
    postId = p.id;
    expect((await editor.post(`/posts/${postId}/submit`, { revision: p.revision })).status).toBe(200);
    const n = await one(`SELECT * FROM notifications WHERE permission = 'approval.post' ORDER BY id DESC LIMIT 1`);
    expect(n.link).toBe(`/freigabe/beitrag/${postId}?fassung=${p.revision}`);
    expect(n.body).toBe(`Fassung ${p.revision} · eingereicht von Robin`);
    expect(n.category).toBe('approval');
  });

  it('Push-Inhalt: Aktionsknöpfe nur für Freigabe-Anfragen, eigenes Kennzeichen je Beitrag', async () => {
    const s = await getSettings();
    const pay = pushPayload({ title: 'Freigabe erbeten: X', link: `/freigabe/beitrag/${postId}?fassung=2` }, 'approval', s) as any;
    expect(pay.actions.map((a: any) => a.action)).toEqual(['review', 'reject']);
    expect(pay.tag).toBe(`blaulichtcms-freigabe-${postId}`);
    expect(JSON.stringify(pay)).not.toMatch(/approve|decision/);
    const other = pushPayload({ title: 'Neue Fotos', link: '/medien/1' }, 'media_new', s) as any;
    expect(other.actions).toBeUndefined();
    expect(other.tag).toBe('blaulichtcms-media_new');
    // Fremde oder manipulierte Links bekommen keine Knöpfe
    expect((pushPayload({ title: 'x', link: '/freigabe/beitrag/../../x' }, 'approval', s) as any).actions).toBeUndefined();
    expect((pushPayload({ title: 'x', link: 'https://evil.example/freigabe/beitrag/1' }, 'approval', s) as any).link).toBe('/benachrichtigungen');
  });

  it('Freigabe-Ansicht: nur mit Freigaberecht; offene Anfrage mit Vorschau-Daten', async () => {
    expect((await editor.get(`/posts/${postId}/review?fassung=2`)).status).toBe(403);
    const r = await approver.get(`/posts/${postId}/review?fassung=2`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ request: 'pending', can_decide: true, four_eyes_blocked: false, state: 'in_review' });
    expect(r.json.revision).toMatchObject({ number: 2, title: 'Hochwasser am Fluss', submitted_by_name: 'Robin' });
    expect(r.json.revision.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.base.number).toBe(1);
    expect((await approver.get(`/posts/${postId}/review?fassung=99`)).status).toBe(404);
  });

  it('Vier-Augen gilt weiter: wer geschrieben und eingereicht hat, sieht den Hinweis und kann nicht freigeben', async () => {
    const p = await draft(admin, 'Eigener Beitrag', 'Text der Administration.');
    expect((await admin.post(`/posts/${p.id}/submit`, { revision: p.revision })).status).toBe(200);
    const r = await admin.get(`/posts/${p.id}/review?fassung=${p.revision}`);
    expect(r.json).toMatchObject({ request: 'pending', four_eyes_blocked: true });
    const dec = await admin.post(`/posts/${p.id}/decision`, { revision: p.revision, contentHash: r.json.revision.content_hash, decision: 'approved', via: 'push' });
    expect(dec.status).toBe(403);
    expect(dec.json.message).toMatch(/Vier-Augen/);
  });

  it('Ablehnen verlangt eine Begründung; Entscheidung aus der Mitteilung wird im Audit vermerkt', async () => {
    const r = await approver.get(`/posts/${postId}/review?fassung=2`);
    const hash = r.json.revision.content_hash;
    expect((await approver.post(`/posts/${postId}/decision`, { revision: 2, contentHash: hash, decision: 'rejected', via: 'push' })).status).toBe(400);
    expect((await approver.post(`/posts/${postId}/decision`, { revision: 2, contentHash: hash, decision: 'rejected', note: 'Bitte Pegelstand ergänzen.', via: 'push' })).status).toBe(200);
    const a = await one(`SELECT details FROM audit_events WHERE action = 'post.rejected' ORDER BY id DESC LIMIT 1`);
    expect(a.details.ansicht).toBe('Freigabe-Ansicht (aus Push-Mitteilung)');
    const after = await approver.get(`/posts/${postId}/review?fassung=2`);
    expect(after.json).toMatchObject({ request: 'rejected', can_decide: false, decision: { decision: 'rejected', note: 'Bitte Pegelstand ergänzen.', decided_by_name: 'Sam' } });
  });

  it('neue Fassung: alte Anfrage ist überholt; Änderungen zur vorigen Fassung; Freigabe der aktuellen klappt', async () => {
    const r = await editor.put(`/posts/${postId}/revision`, { baseRevision: 2, title: 'Hochwasser am Fluss', body: 'Der Pegel steigt auf 6,20 m. Bitte Ufer meiden.' });
    expect(r.json.number).toBe(3);
    expect((await editor.post(`/posts/${postId}/submit`, { revision: 3 })).status).toBe(200);
    const old = await approver.get(`/posts/${postId}/review?fassung=2`);
    expect(old.json).toMatchObject({ request: 'superseded', can_decide: false, post: { current_revision: 3 } });
    const cur = await approver.get(`/posts/${postId}/review?fassung=3`);
    expect(cur.json.request).toBe('pending');
    expect(cur.json.base.number).toBe(2);
    expect(cur.json.base.body).toBe('Der Pegel steigt. Bitte Ufer meiden.');
    // Veraltete Prüfsumme (z. B. Ansicht der überholten Fassung offen gelassen) wird abgewiesen
    expect((await approver.post(`/posts/${postId}/decision`, { revision: 2, contentHash: old.json.revision.content_hash, decision: 'approved', via: 'push' })).status).toBe(409);
    const ok = await approver.post(`/posts/${postId}/decision`, { revision: 3, contentHash: cur.json.revision.content_hash, decision: 'approved', via: 'review' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const a = await one(`SELECT details FROM audit_events WHERE action = 'post.approved' ORDER BY id DESC LIMIT 1`);
    expect(a.details.ansicht).toBe('Freigabe-Ansicht');
    const done = await approver.get(`/posts/${postId}/review?fassung=3`);
    expect(done.json).toMatchObject({ request: 'approved', can_decide: false });
    // Im Beitrag (Editor) entschieden: kein Vermerk
    const p = await draft(editor, 'Dritter', 'Text.');
    await editor.post(`/posts/${p.id}/submit`, { revision: p.revision });
    const v = await approver.get(`/posts/${p.id}/review`);
    await approver.post(`/posts/${p.id}/decision`, { revision: p.revision, contentHash: v.json.revision.content_hash, decision: 'approved' });
    const a2 = await one(`SELECT details FROM audit_events WHERE action = 'post.approved' ORDER BY id DESC LIMIT 1`);
    expect(a2.details.ansicht).toBeUndefined();
  });
});
