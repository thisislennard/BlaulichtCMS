import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { invalidateRoles } from '../src/auth/roles.js';
import { hashPassword } from '../src/auth/passwords.js';
import { getSettings, setSettings } from '../src/lib/settings.js';
import { pushPayload } from '../src/lib/notify-channels.js';
import { sweepApprovalNotices } from '../src/approvals/notices.js';

/**
 * Freigaben über alle Arten (#251) und Benachrichtigungen dazu (#253) gegen eine echte PostgreSQL-Datenbank:
 * je Art einreichen → in GET /approvals/pending für die berechtigte Person, für andere nicht; Vier-Augen ausgegraut;
 * Zähler in Dashboard; eine gebündelte Meldung je Art, nach der Entscheidung erledigt (bei niemandem mehr ungelesen);
 * Glocke je Art abschaltbar; Push ohne Einzelheiten bleibt beim knappen Titel.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
let passwordHash = '';

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
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
  del = (u: string) => this.raw('DELETE', u, {});
}

async function login(email: string, name: string, roles: string[]) {
  const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ($1,$2,$3,$4) RETURNING id`, [email, name, passwordHash, roles]);
  const client = new Client(app);
  expect((await client.post('/auth/login', { email, password: PASSWORD })).json.next).toBe('done');
  return { client, id: u!.id as string };
}

let admin: Client;
let robin: Client; // Redaktion
let sam: Client; // Freigabe
let wanda: Client; // Warnfreigabe
let will: Client; // Warnentwurf
let pia: Client; // Veröffentlichung
let lea: Client; // Lesezugriff
let samId = '';
let siteId = '';

const pending = async (c: Client) => {
  const r = await c.get('/approvals/pending');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const notes = async (c: Client) => (await c.get('/notifications')).json;
const approvalNote = async (c: Client, kind: string) => (await notes(c)).notifications.find((n: any) => n.object_type === kind && !n.resolved_at);

const warningData = {
  area: 'Musterstadt, Ortsteil Nord (fiktiv)',
  starts_at: '2026-11-14T10:00',
  valid_until: '2026-11-14T18:00',
  headline: 'Starke Rauchentwicklung (Übung)',
  situation: 'Fiktive Lage für den Test.',
  advice: 'Fenster und Türen geschlossen halten.',
  sender: 'Musterorganisation',
  callback: 'Testperson, 0000 000000',
};

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
  invalidateRoles();
  await migrate(() => {});
  app = await buildApp();
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true, 'smtp.from': 'presse@example.org' } as any);
  admin = (await login('admin@example.org', 'Alex Admin', ['platform_admin'])).client;
  robin = (await login('redaktion@example.org', 'Robin Redaktion', ['editor'])).client;
  const s = await login('freigabe@example.org', 'Sam Freigabe', ['approver']);
  sam = s.client;
  samId = s.id;
  wanda = (await login('warnfreigabe@example.org', 'Wanda Warnfreigabe', ['warning_approver'])).client;
  will = (await login('warnentwurf@example.org', 'Will Warnentwurf', ['warning_author'])).client;
  pia = (await login('veroeffentlichung@example.org', 'Pia Veröffentlichung', ['publisher'])).client;
  lea = (await login('leser@example.org', 'Lea Leser', ['viewer'])).client;
  siteId = (await admin.post('/sites', { name: 'Testseite' })).json.site.id;
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Freigaben-Liste über alle Arten (#251)', () => {
  let postId = '';
  let bannerId = '';
  let incidentId = '';
  let warningId = '';
  let replyId = '';
  let requestId = '';

  it('zeigt nur Arten, über die die Person entscheiden darf; ohne passendes Recht 403', async () => {
    const s = await pending(sam);
    expect(s.kinds.map((k: any) => k.kind)).toEqual(['post', 'banner', 'incident', 'press', 'automation']);
    expect(s).toMatchObject({ items: [], total: 0, open: 0 });
    expect((await pending(wanda)).kinds.map((k: any) => k.kind)).toEqual(['warning']);
    // Veröffentlichung: keine Freigabeart, aber die Liste „bereit zur Veröffentlichung“
    expect((await pending(pia)).kinds).toEqual([]);
    expect((await robin.get('/approvals/pending')).status).toBe(403);
    expect((await lea.get('/approvals/pending')).status).toBe(403);
  });

  it('Beitrag eingereicht → in der Liste der Freigabe, nicht bei Warnfreigabe; Link auf die Freigabe-Ansicht', async () => {
    const p = await robin.post('/posts', { kind: 'news', title: 'Tag der offenen Tür' });
    postId = p.json.id;
    const r = await robin.put(`/posts/${postId}/revision`, { baseRevision: 1, title: 'Tag der offenen Tür', body: 'Am Samstag am Gerätehaus.' });
    expect((await robin.post(`/posts/${postId}/submit`, { revision: r.json.number })).status).toBe(200);
    const s = await pending(sam);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'post', id: postId, title: 'Tag der offenen Tür', revision: 2, submitted_by_name: 'Robin Redaktion', link: `/freigabe/beitrag/${postId}?fassung=2`, blocked: null });
    expect(s.kinds.find((k: any) => k.kind === 'post')).toMatchObject({ count: 1, open: 1 });
    expect((await pending(wanda)).items).toEqual([]);
  });

  it('Banner, Eintrag der Einsatzliste und Antwort an die Presse erscheinen ebenso – mit Link auf die Prüfansicht', async () => {
    const b = await robin.post('/banners', { siteId, title: 'Sperrung Ortsdurchfahrt', tone: 'warning', endsAt: new Date(Date.now() + 6 * 3600_000).toISOString() });
    bannerId = b.json.id;
    expect((await robin.post(`/banners/${bannerId}/submit`)).status).toBe(200);
    const e = await robin.post('/incidents', { alarmAt: '2026-11-14T13:30:00.000Z', keyword: 'F 2', title: 'Brand Scheune', location: 'Ost' });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    incidentId = e.json.id;
    expect((await robin.post(`/incidents/${incidentId}/submit`)).status).toBe(200);
    await setSettings({ 'press.reply_approval': true } as any);
    requestId = (await robin.post('/press/requests', { topic: 'Brand Scheune', outlet: 'Zeitung Muster' })).json.id;
    const rep = await robin.post(`/press/requests/${requestId}/replies`, { to: ['redaktion@zeitung.example'], subject: 'AW: Brand Scheune', body: 'Entwurf der Antwort.' });
    expect(rep.json.status).toBe('pending');
    replyId = rep.json.id;

    const s = await pending(sam);
    const byKind = Object.fromEntries(s.items.map((i: any) => [i.kind, i]));
    expect(byKind.banner).toMatchObject({ id: bannerId, title: 'Sperrung Ortsdurchfahrt', link: `/banner?banner=${bannerId}`, meta: { tone: 'warning', site_name: 'Testseite' } });
    expect(byKind.incident).toMatchObject({ id: incidentId, title: 'Brand Scheune', link: `/einsatzliste?eintrag=${incidentId}`, meta: { keyword: 'F 2', location: 'Ost' } });
    expect(byKind.press).toMatchObject({ id: replyId, title: `AW: Brand Scheune [${byKind.press.meta.case_no}]`, link: `/presse/${requestId}?antwort=${replyId}` });
    expect(s.total).toBe(4);
    expect(s.open).toBe(4);
    // neueste zuerst
    expect(s.items.map((i: any) => i.kind)).toEqual(['press', 'incident', 'banner', 'post']);
    // Warnfreigabe sieht nichts davon
    expect((await pending(wanda)).items).toEqual([]);
  });

  it('Warnentwurf eingereicht → nur bei der Warnfreigabe, Link auf „Prüfen & PDF“', async () => {
    const resp = (await admin.post('/responsibilities', { name: 'Leitstelle (fiktiv)', area: 'Musterkreis', recipients: ['leitstelle@example.invalid'] })).json.id;
    warningId = (await will.post('/warnings', { kind: 'initial' })).json.id;
    let d = (await will.get(`/warnings/${warningId}`)).json;
    expect((await will.put(`/warnings/${warningId}/revision`, { baseRevision: d.revision.number, data: { ...d.revision.data, ...warningData }, responsibilityIds: [resp], keywordId: null, answers: {} })).status).toBe(200);
    d = (await will.get(`/warnings/${warningId}`)).json;
    expect((await wanda.post(`/warnings/${warningId}/level`, { revision: d.revision.number, level: 2, reason: 'Fiktive Lage ohne Stichwort.' })).status).toBe(200);
    d = (await will.get(`/warnings/${warningId}`)).json;
    expect((await will.post(`/warnings/${warningId}/submit`, { revision: d.revision.number })).status).toBe(200);
    const w = await pending(wanda);
    expect(w.items).toHaveLength(1);
    expect(w.items[0]).toMatchObject({ kind: 'warning', id: warningId, link: `/warnungen/${warningId}?schritt=pruefen`, submitted_by_name: 'Will Warnentwurf', blocked: null });
    expect(w.items[0].title).toContain('Starke Rauchentwicklung (Übung)');
    expect((await pending(sam)).items.some((i: any) => i.kind === 'warning')).toBe(false);
  });

  it('Dashboard: Kennzahl und Begrüßung zählen alle Arten (dieselbe Quelle)', async () => {
    const d = (await sam.get('/dashboard')).json;
    expect(d.approvals).toMatchObject({ total: 4, open: 4 });
    expect((await wanda.get('/dashboard')).json.approvals).toMatchObject({ total: 1, open: 1 });
    expect((await lea.get('/dashboard')).json.approvals).toBeUndefined();
    // Warnfreigabe ohne „Beiträge ansehen“ bekommt die Freigaben-Kacheln im Dashboard
    const w = (await wanda.get('/dashboard/layout')).json.widgets;
    expect(w).toEqual(expect.arrayContaining(['badge_approvals', 'approvals']));
    expect(w).not.toContain('publications');
  });

  it('Vier-Augen-Prinzip: selbst eingereichte Vorgänge erscheinen ausgegraut mit Grund statt zu fehlen', async () => {
    await setSettings({ 'editorial.four_eyes': true });
    try {
      // Admin darf alles entscheiden – aber nicht, was er selbst angelegt hat
      const b = await admin.post('/banners', { siteId, title: 'Eigenes Banner', endsAt: new Date(Date.now() + 3600_000).toISOString() });
      await admin.post(`/banners/${b.json.id}/submit`);
      await setSettings({ 'press.reply_approval': true } as any);
      const own = await admin.post(`/press/requests/${requestId}/replies`, { to: ['redaktion@zeitung.example'], subject: 'AW: eigene', body: 'x' });
      const a = await pending(admin);
      const mine = a.items.find((i: any) => i.id === b.json.id);
      expect(mine.blocked).toMatch(/Vier-Augen-Prinzip/);
      expect(a.items.find((i: any) => i.id === own.json.id).blocked).toMatch(/zweite Person/);
      expect(a.items.find((i: any) => i.id === bannerId).blocked).toBeNull();
      expect(a.open).toBe(a.total - 2);
      // Die Liste sagt dasselbe wie der Endpunkt der Entscheidung
      const cur = (await admin.get('/banners')).json.find((x: any) => x.id === b.json.id);
      expect((await admin.post(`/banners/${b.json.id}/approve`, { contentHash: cur.content_hash })).status).toBe(403);
      // Für Sam ist das Banner frei
      expect((await pending(sam)).items.find((i: any) => i.id === b.json.id).blocked).toBeNull();
      await admin.post(`/banners/${b.json.id}/end`);
      await admin.del(`/press/replies/${own.json.id}`);
    } finally {
      await setSettings({ 'editorial.four_eyes': false });
    }
  });

  it('nach der Entscheidung verschwindet der Vorgang; Freigegebenes erscheint bei der Veröffentlichung als bereit', async () => {
    const hash = (await one<any>(`SELECT content_hash FROM post_revisions WHERE post_id = $1 AND number = 2`, [postId]))!.content_hash;
    expect((await sam.post(`/posts/${postId}/decision`, { revision: 2, contentHash: hash, decision: 'approved' })).status).toBe(200);
    const banner = (await robin.get('/banners')).json.find((x: any) => x.id === bannerId);
    expect((await sam.post(`/banners/${bannerId}/approve`, { contentHash: banner.content_hash })).status).toBe(200);
    const s = await pending(sam);
    expect(s.items.map((i: any) => i.kind).sort()).toEqual(['incident', 'press']);
    // Banner freigegeben, Website noch nicht gekoppelt: bereit für „Banner veröffentlichen“
    const p = await pending(pia);
    expect(p.ready.map((r: any) => [r.kind, r.id])).toEqual([['banner', bannerId]]);
    expect(p.ready[0]).toMatchObject({ approved_by_name: 'Sam Freigabe', link: `/banner?banner=${bannerId}` });
    // Rein interner Beitrag ohne Veröffentlichungsziel wartet auf nichts
    expect(p.ready.some((r: any) => r.id === postId)).toBe(false);
    // Freigabe hat kein Veröffentlichungsrecht → keine Liste „bereit“
    expect(s.ready).toEqual([]);
  });

  it('Eintrag der Einsatzliste nach dem Zurückziehen erneut eingereicht: wartet wieder auf Freigabe', async () => {
    const { entryState } = await import('../src/incidents/list.js');
    const e = { content_hash: 'b', approved_hash: 'a', submitted_at: new Date(), withdrawn_at: new Date(), revision: 3 };
    expect(entryState(e, { action: 'delete', status: 'done', revision: 2 })).toBe('in_review');
    expect(entryState({ ...e, submitted_at: null }, { action: 'delete', status: 'done', revision: 2 })).toBe('withdrawn');
    expect(entryState({ ...e, approved_hash: 'b' }, { action: 'delete', status: 'done', revision: 2 })).toBe('withdrawn');
  });
});

describe('Benachrichtigungen zu Freigaben (#253)', () => {
  it('Einreichen erzeugt eine Meldung mit Objektbezug; nach der Entscheidung zählt sie bei niemandem mehr als ungelesen', async () => {
    // Einsatz und Presseantwort aus dem ersten Teil sind noch offen
    const inc = await approvalNote(sam, 'incident');
    expect(inc).toMatchObject({ title: 'Einsatzliste: Freigabe erbeten – Brand Scheune', read: false, group: 'approvals', count: 1 });
    expect(inc.link).toMatch(/^\/einsatzliste\?eintrag=/);
    expect(await approvalNote(admin, 'incident')).toMatchObject({ id: inc.id, read: false });
    const unreadBefore = (await notes(sam)).unread;
    const e = (await robin.get(`/incidents/${inc.object_id}`)).json;
    expect((await sam.post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash })).status).toBe(200);
    for (const c of [sam, admin]) {
      const n = (await notes(c)).notifications.find((x: any) => x.id === inc.id);
      expect(n).toMatchObject({ read: true, resolved_note: 'freigegeben von Sam Freigabe' });
      expect(n.resolved_at).toBeTruthy();
    }
    expect((await notes(sam)).unread).toBe(unreadBefore - 1);
  });

  it('Beitrag, Banner und Warnentwurf: Anfrage nach der Entscheidung erledigt (auch Zurückweisen)', async () => {
    // Beitrag und Banner wurden im ersten Teil freigegeben
    for (const kind of ['post', 'banner']) {
      const all = (await notes(sam)).notifications.filter((n: any) => n.object_type === kind);
      expect(all.length, kind).toBeGreaterThan(0);
      expect(all.every((n: any) => n.resolved_at && n.read), kind).toBe(true);
    }
    // Warnentwurf zurückweisen
    const w = await approvalNote(wanda, 'warning');
    expect(w).toMatchObject({ title: expect.stringMatching(/^Warnentwurf zur Freigabe: W-\d{4}-\d{4}$/), link: `/warnungen/${w.object_id}?schritt=pruefen`, read: false });
    const d = (await wanda.get(`/warnings/${w.object_id}`)).json;
    expect((await wanda.post(`/warnings/${w.object_id}/decision`, { revision: d.revision.number, contentHash: d.revision.content_hash, decision: 'rejected', note: 'Gebiet genauer angeben.' })).status).toBe(200);
    const after = (await notes(wanda)).notifications.find((n: any) => n.id === w.id);
    expect(after).toMatchObject({ read: true, resolved_note: 'zurückgewiesen von Wanda Warnfreigabe' });
  });

  it('mehrere gleichartige Anfragen: eine gebündelte Meldung mit Anzahl und Link auf die gefilterte Liste', async () => {
    const ids: string[] = [];
    for (const t of ['Brand A', 'Brand B', 'Brand C']) {
      const e = await robin.post('/incidents', { alarmAt: '2026-11-15T10:00:00.000Z', keyword: 'B 1', title: t, location: 'West' });
      ids.push(e.json.id);
    }
    await robin.post(`/incidents/${ids[0]}/submit`);
    const first = await approvalNote(sam, 'incident');
    expect(first).toMatchObject({ title: 'Einsatzliste: Freigabe erbeten – Brand A', count: 1 });
    await sam.post('/notifications/read', { ids: [first.id] });
    const r = await robin.post('/incidents/bulk/submit', { ids: ids.slice(1) });
    expect(r.json.done).toBe(2);
    const n = await approvalNote(sam, 'incident');
    expect(n.id).toBe(first.id); // dieselbe Meldung, keine drei Einträge
    expect(n).toMatchObject({ title: 'Einsatzliste: 3 Einträge warten auf Freigabe', body: expect.stringMatching(/^Zuletzt: Brand [BC]$/), link: '/einsatzliste?stand=in_review&jahr=alle', count: 3, object_id: null, read: false });
    expect((await many(`SELECT id FROM notifications WHERE object_type = 'incident' AND resolved_at IS NULL`)).length).toBe(1);
    // Push ohne Einzelheiten: nur die Art und der Link; mit Einzelheiten der Titel der Glocke
    const s = await getSettings();
    expect(pushPayload(n, 'approval', s)).toMatchObject({ title: 'Freigabe angefordert', body: 'Einzelheiten nach der Anmeldung in BlaulichtCMS.', link: '/einsatzliste?stand=in_review&jahr=alle' });
    expect(JSON.stringify(pushPayload(n, 'approval', s))).not.toContain('Brand');
    expect(pushPayload(n, 'approval', { ...s, 'notify.push_details': true }).title).toBe('Einsatzliste: 3 Einträge warten auf Freigabe');
    // Entscheidungen zählen herunter; einzeln wieder genau der Eintrag; erledigt erst, wenn nichts mehr offen ist
    const list = (await robin.get('/incidents?year=alle')).json.entries;
    const hash = (id: string) => list.find((x: any) => x.id === id).content_hash;
    const bulk = await sam.post('/incidents/bulk/approve', { items: ids.slice(0, 2).map((id) => ({ id, contentHash: hash(id) })) });
    expect(bulk.json.done).toBe(2);
    const one1 = (await notes(sam)).notifications.find((x: any) => x.id === first.id);
    expect(one1).toMatchObject({ title: 'Einsatzliste: Freigabe erbeten – Brand C', count: 1, object_id: ids[2], link: `/einsatzliste?eintrag=${ids[2]}` });
    expect(one1.resolved_at).toBeNull();
    // Ändern statt Entscheiden: die eingereichte Fassung ist überholt, die Anfrage erledigt
    const c = (await robin.get(`/incidents/${ids[2]}`)).json;
    expect((await robin.put(`/incidents/${ids[2]}`, { alarmAt: c.alarm_at, keyword: 'B 1', title: 'Brand C (korrigiert)', location: 'West' })).json.changed).toBe(true);
    const done = (await notes(sam)).notifications.find((x: any) => x.id === first.id);
    expect(done.resolved_note).toBe('geändert – neue Fassung nicht eingereicht');
    expect(done.read).toBe(true);
  });

  it('Abgleich im Worker erledigt Anfragen ohne eigenen Aufruf und ältere Einzelmeldungen', async () => {
    // Ältere Einzelmeldung (vor #253) zu einem längst freigegebenen Eintrag, Objektbezug aus der Migration
    const e = (await robin.get('/incidents?year=alle')).json.entries.find((x: any) => x.state === 'approved');
    const legacy = await one<any>(
      `INSERT INTO notifications (kind, title, link, permission, category, object_type, object_id) VALUES ('info', 'Einsatzliste: Freigabe erbeten – alt', $1, 'approval.incident', 'approval', 'incident', $2) RETURNING id`,
      [`/einsatzliste?eintrag=${e.id}`, e.id],
    );
    const bulkOld = await one<any>(`INSERT INTO notifications (kind, title, link, permission, category, object_type) VALUES ('info', 'Einsatzliste: 14 Einträge zur Freigabe', '/einsatzliste', 'approval.incident', 'approval', 'incident') RETURNING id`);
    expect((await notes(sam)).notifications.find((n: any) => n.id === legacy!.id).read).toBe(false);
    // Banner läuft ab, während es auf Freigabe wartet
    const b = await robin.post('/banners', { siteId, title: 'Kurzes Banner', endsAt: new Date(Date.now() + 3600_000).toISOString() });
    await robin.post(`/banners/${b.json.id}/submit`);
    expect((await approvalNote(sam, 'banner')).object_id).toBe(b.json.id);
    await pool.query(`UPDATE banners SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE id = $1`, [b.json.id]);
    await sweepApprovalNotices();
    const after = (await notes(sam)).notifications;
    expect(after.find((n: any) => n.id === legacy!.id)).toMatchObject({ read: true, resolved_note: 'nicht mehr offen' });
    expect(after.find((n: any) => n.id === bulkOld!.id).read).toBe(true);
    expect(await approvalNote(sam, 'banner')).toBeUndefined();
    expect((await pending(sam)).items.some((i: any) => i.id === b.json.id)).toBe(false);
  });

  it('Presseantwort: Link auf die Antwort; Verwerfen erledigt die Anfrage', async () => {
    const n = await approvalNote(sam, 'press');
    expect(n.link).toMatch(/^\/presse\/[0-9a-f-]{36}\?antwort=[0-9a-f-]{36}$/);
    expect((await robin.del(`/press/replies/${n.object_id}`)).status).toBe(200);
    expect((await notes(sam)).notifications.find((x: any) => x.id === n.id)).toMatchObject({ read: true, resolved_note: 'Antwort verworfen' });
  });

  it('Filtergruppe je Meldung; Glocke je Art abschaltbar (eine Matrix), Sicherheits- und Kontomeldungen nicht', async () => {
    const r = await notes(sam);
    expect(r.groups.map((g: any) => g.id)).toEqual(['approvals', 'publishing', 'press', 'warnings', 'media', 'workflows', 'system']);
    const prefs = (await sam.get('/notify/preferences')).json.categories;
    const approval = prefs.find((c: any) => c.id === 'approval');
    expect(approval).toMatchObject({ bell: true, bellLocked: false, group: 'approvals', channels: ['push', 'mail'] });
    expect(prefs.find((c: any) => c.id === 'account')).toMatchObject({ bell: true, bellLocked: true });
    // Jede Art steht genau einmal in der Matrix (früher „Neue Dateien“ doppelt)
    expect(new Set(prefs.map((c: any) => c.id)).size).toBe(prefs.length);
    expect((await sam.put('/notify/preferences', { bell: { approval: false, account: false } })).status).toBe(200);
    const stored = await one<any>(`SELECT preferences->'mutedNotifications' AS m FROM users WHERE id = $1`, [samId]);
    expect(stored.m).toEqual(['approval']);
    expect((await sam.get('/notify/preferences')).json.categories.find((c: any) => c.id === 'approval').bell).toBe(false);
    expect((await notes(sam)).notifications.some((n: any) => n.category === 'approval')).toBe(false);
    // Über die bisherige Schnittstelle: nur abschaltbare Arten
    expect((await sam.patch('/auth/preferences', { mutedNotifications: ['account'] })).status).toBe(400);
    expect((await sam.put('/notify/preferences', { bell: { approval: true } })).status).toBe(200);
    expect((await notes(sam)).notifications.some((n: any) => n.category === 'approval')).toBe(true);
  });
});
