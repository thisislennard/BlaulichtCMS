import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { getSettings, setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { invalidateRoles, reloadRoles } from '../src/auth/roles.js';
import { setupChecklist } from '../src/lib/setup-checklist.js';
import { unusedModules } from '../src/routes/dashboard.js';

/**
 * Dashboard je Rolle mit neuen Kacheln (#254), Checkliste „BlaulichtCMS startklar“ und Begrüßung neuer Konten (#255)
 * gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL). Die Datenbank wird zu Beginn geleert.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
let ipCounter = 10;

class Client {
  cookie = '';
  ip = `10.81.0.${ipCounter++}`;
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as any,
      remoteAddress: this.ip,
      url: `/api/v1${url}`,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-blaulichtcms-request': '1' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
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
}

const USERS: [string, string, string[]][] = [
  ['admin@example.org', 'Alex Admin', ['platform_admin']],
  ['redaktion@example.org', 'Robin Redaktion', ['editor', 'media_manager']],
  ['freigabe@example.org', 'Sam Freigabe', ['approver']],
  ['online@example.org', 'Olli Online', ['publisher']],
  ['lesen@example.org', 'Lea Lesen', ['viewer']],
  ['warnung@example.org', 'Wim Warnung', ['warning_author']],
  ['presse@example.org', 'Kim Presse', ['r_pressestelle_x1']],
];
const c: Record<string, Client> = {};
const ids: Record<string, string> = {};

const login = async (email: string) => {
  const cl = new Client(app);
  expect((await cl.post('/auth/login', { email, password: PASSWORD })).json.next).toBe('done');
  return cl;
};
const layout = async (who: string) => (await c[who].get('/dashboard/layout')).json;
const panels = (l: any) => l.layout.columns.flatMap((x: any) => x.widgets);

beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateRoles();
  await migrate(() => {});
  // Eigene Rolle „Pressestelle“: nur Presse-Rechte (keine Redaktion) → Profil „press“
  await pool.query(`INSERT INTO roles (id, label, permissions) VALUES ('r_pressestelle_x1', 'Pressestelle', $1)`, [['press.view', 'press.manage', 'press.reply', 'post.view', 'calendar.view']]);
  await reloadRoles();
  app = await buildApp();
  for (const [email, name, roles] of USERS) {
    const r = await one<{ id: string }>(`INSERT INTO users (email, name, password_hash, roles) VALUES ($1, $2, $3, $4) RETURNING id`, [email, name, hash, roles]);
    ids[email.split('@')[0]] = r!.id;
  }
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
  for (const [email] of USERS) c[email.split('@')[0]] = await login(email);
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Standardansicht je Rolle (#254)', () => {
  it('frische Instanz: jede Rolle hat ihre eigene Ansicht, nicht eingerichtete Module fehlen, nie ein leeres Dashboard', async () => {
    const unused = await unusedModules();
    for (const m of ['website', 'rss', 'calendar', 'press', 'warnings', 'incidents', 'automations', 'connections', 'social']) expect(unused.has(m as any), m).toBe(true);

    const admin = await layout('admin');
    expect(admin.source).toBe('default');
    expect(admin.profile).toBe('platform_admin');
    // Verbindungsfehler ohne Verbindung, Websites ohne Website, Workflows ohne Workflow: nicht im Standard
    expect(admin.layout.badges).toEqual(['badge_services']);
    expect(panels(admin)).toEqual(['setup', 'approvals']);

    const editor = await layout('redaktion');
    expect(editor.profile).toBe('editor');
    expect(editor.layout.badges).toEqual([]);
    expect(panels(editor)).toEqual(['media', 'my_drafts']);

    expect((await layout('freigabe')).profile).toBe('approver');
    expect(panels(await layout('freigabe'))).toEqual(['approvals', 'ready']);
    expect((await layout('online')).profile).toBe('publisher');
    expect(panels(await layout('online'))).toEqual(['ready']);

    // Lesezugriff hat nur Veröffentlichungen und Kalender – beide ohne Inhalt: dann die Ansicht ohne Modulfilter
    const viewer = await layout('lesen');
    expect(viewer.profile).toBe('viewer');
    expect(panels(viewer)).toEqual(['publications', 'calendar_upcoming']);

    // Warnentwurf: nur die Kachel „Warnungen“ (Recht warning.view), sonst nichts
    const warn = await layout('warnung');
    expect(warn.profile).toBe('warning_author');
    expect(warn.widgets).toEqual(['warnings']);
    expect(panels(warn)).toEqual(['warnings']);

    // Eigene Rolle mit Presse-Rechten ohne Redaktion → Presse-Ansicht
    const press = await layout('presse');
    expect(press.profile).toBe('press');
    expect(panels(press)).toEqual(['my_press', 'calendar_upcoming', 'publications']);
  });

  it('Kacheln erscheinen, sobald das Modul genutzt wird; Vorlagen und eigene Layouts bleiben unverändert', async () => {
    // Presseanfrage, Termin und Website → Module in Gebrauch
    await pool.query(`INSERT INTO press_requests (case_no, topic, assignee_id, due_at) VALUES ('P-TEST-1', 'Fiktive Anfrage zur Übung', $1, now() - interval '2 hours'), ('P-TEST-2', 'Zweite Anfrage', $1, now() + interval '2 days'), ('P-TEST-3', 'Ohne Zuständigkeit', NULL, NULL)`, [ids.presse]);
    const ev = await c.redaktion.post('/calendar/events', { title: 'Dienstabend (fiktiv)', start: new Date(Date.now() + 60 * 60_000).toISOString(), end: new Date(Date.now() + 2 * 60 * 60_000).toISOString() });
    expect(ev.status, JSON.stringify(ev.json)).toBe(200);
    await pool.query(`INSERT INTO wp_sites (name, status, site_url, last_seen_at) VALUES ('Musterwehr (fiktiv)', 'active', 'https://example.org', now())`);
    const unused = await unusedModules();
    expect(unused.has('press') || unused.has('calendar') || unused.has('website')).toBe(false);

    expect(panels(await layout('redaktion'))).toEqual(['media', 'my_drafts', 'calendar_upcoming', 'my_press']);
    expect(panels(await layout('online'))).toEqual(['ready', 'publications', 'sites']);
    expect((await layout('online')).layout.badges).toEqual(['badge_banners']);
    expect(panels(await layout('admin'))).toEqual(['setup', 'approvals', 'sites']);

    // Dashboard-Vorlage der Administration hat Vorrang (auch ohne Modulfilter)
    const tpl = { badges: ['badge_ready'], columns: [{ weight: 3, widgets: ['rss', 'approvals'] }], mobile: [] };
    expect((await c.admin.put('/dashboard/layout', { scope: 'role', role: 'approver', layout: tpl })).status).toBe(200);
    const fromTpl = await layout('freigabe');
    expect(fromTpl.source).toBe('role');
    expect(fromTpl.layout.columns).toEqual([{ weight: 3, widgets: ['rss', 'approvals'] }]);
    expect((await c.admin.put('/dashboard/layout', { scope: 'role', role: 'approver', layout: null })).status).toBe(200);
    // Eigenes Layout bleibt; „Standard wiederherstellen“ (null) führt zurück zur Standardansicht der Rolle
    const mine = { badges: ['badge_uploads'], columns: [{ weight: 5, widgets: ['uploads'] }], mobile: ['uploads'] };
    expect((await c.redaktion.put('/dashboard/layout', { scope: 'personal', layout: mine })).status).toBe(200);
    expect((await layout('redaktion')).layout).toEqual({ version: 2, ...mine });
    expect((await c.redaktion.put('/dashboard/layout', { scope: 'personal', layout: null })).status).toBe(200);
    const back = await layout('redaktion');
    expect(back.source).toBe('default');
    expect(panels(back)).toEqual(['media', 'my_drafts', 'calendar_upcoming', 'my_press']);
  });
});

describe('Neue Kacheln aus GET /dashboard (#254)', () => {
  it('Meine Entwürfe, nächste Termine samt Presse-Fristen, eigene Presseanfragen – überfällige zuerst', async () => {
    const p = await c.redaktion.post('/posts', { title: 'Entwurf: Tag der offenen Tür (fiktiv)' });
    expect(p.status).toBe(200);
    const d = (await c.redaktion.get('/dashboard')).json;
    expect(d.myDrafts.map((x: any) => x.title)).toContain('Entwurf: Tag der offenen Tür (fiktiv)');
    expect(d.myDrafts[0].state).toBe('draft');
    expect(d.calendar.today).toBeGreaterThanOrEqual(1);
    expect(d.calendar.upcoming.map((e: any) => e.title)).toContain('Dienstabend (fiktiv)');
    expect(d.calendar.upcoming.find((e: any) => e.kind === 'event').link).toMatch(/^\/kalender\?termin=/);
    // Robin (Redaktion) hat Presse-Rechte, aber keine eigene Anfrage
    expect(d.myPress).toEqual([]);
    expect(d.pressUnassigned).toBe(1);
    // Fristen anderer erscheinen im Kalender (Recht „Presseanfragen ansehen“), die überschrittene bleibt sichtbar
    const deadlines = d.calendar.upcoming.filter((e: any) => e.kind === 'press');
    expect(deadlines.some((e: any) => e.overdue)).toBe(true);

    const k = (await c.presse.get('/dashboard')).json;
    expect(k.myPress.map((r: any) => r.case_no)).toEqual(['P-TEST-1', 'P-TEST-2']);
    expect(k.myPress[0].overdue).toBe(true);
    expect(k.myPress[0].total).toBe(2);
    // Keine Kontaktdaten in der Kachel
    expect(JSON.stringify(k.myPress)).not.toMatch(/contact/);
    // Ohne Medienrecht keine Medien-Daten (Begrüßungszeile zählt nur Eigenes)
    expect(k.media).toBeUndefined();
    expect(k.myDrafts).toBeUndefined();
  });

  it('Warnungen, Einsatzliste, Workflows, Dienste und Checkliste nur mit dem jeweiligen Recht', async () => {
    const w = (await c.warnung.get('/dashboard')).json;
    expect(Object.keys(w).sort()).toEqual(['confirmedAt', 'warnings']);
    expect(w.warnings.cases).toEqual([]);
    expect(w.warnings.official).toBeUndefined();
    // Redaktion: amtliche Warnungen ja (official.view), Warnentwürfe nein
    const r = (await c.redaktion.get('/dashboard')).json;
    expect(r.warnings.official).toEqual([]);
    expect(r.warnings.cases).toBeUndefined();
    expect(r.incidents).toEqual({ counts: { failed: 0, in_review: 0, approved: 0 }, items: [] });
    expect(r.automations.failed).toEqual([]);

    // Einsatzliste: eingereichter Eintrag und Übertragungsfehler erscheinen, Fehler zuerst
    const site = (await one<{ id: string }>(`SELECT id FROM wp_sites LIMIT 1`))!.id;
    await pool.query(
      `INSERT INTO incident_entries (title, content_hash, alarm_at, submitted_at) VALUES ('Brand Scheune (fiktiv)', 'h1', now(), now()), ('Ölspur (fiktiv)', 'h2', now() - interval '1 day', now())`,
    );
    const ol = (await one<{ id: string }>(`UPDATE incident_entries SET approved_hash = content_hash, approved_at = now() WHERE title = 'Ölspur (fiktiv)' RETURNING id`))!.id;
    await pool.query(`INSERT INTO incident_jobs (entry_id, site_id, action, revision, payload, status, error) VALUES ($1, $2, 'upsert', 1, '{}', 'failed', 'Website nicht erreichbar (Test)')`, [ol, site]);
    const inc = (await c.online.get('/dashboard')).json.incidents;
    expect(inc.counts).toEqual({ failed: 1, in_review: 1, approved: 0 });
    expect(inc.items.map((e: any) => e.state)).toEqual(['failed', 'in_review']);
    expect(inc.items[0].error).toMatch(/nicht erreichbar/);

    // Workflows: fehlgeschlagener Livelauf zählt, Testlauf nicht
    const a = (await one<{ id: string }>(`INSERT INTO automations (name, graph_hash) VALUES ('Alarm → Banner (fiktiv)', 'x') RETURNING id`))!.id;
    await pool.query(
      `INSERT INTO automation_runs (automation_id, mode, trigger, input_node, status, graph, graph_hash, error, finished_at) VALUES ($1, 'live', 'event', 'n1', 'failed', '{}', 'x', 'Zeitüberschreitung (Test)', now()), ($1, 'test', 'test', 'n1', 'failed', '{}', 'x', 'Test', now())`,
      [a],
    );
    const au = (await c.admin.get('/dashboard')).json.automations;
    expect(au.failed).toHaveLength(1);
    expect(au.failed[0]).toMatchObject({ name: 'Alarm → Banner (fiktiv)', failures: 1, last_error: 'Zeitüberschreitung (Test)' });
    // Workflow gelöscht → zählt nicht mehr
    await pool.query(`UPDATE automations SET deleted_at = now() WHERE id = $1`, [a]);
    expect((await c.admin.get('/dashboard')).json.automations.failed).toEqual([]);

    // Dienste und Checkliste haben eigene Abfragen (Statuszeile bzw. GET /setup/checklist) – GET /dashboard bleibt leicht
    const ad = (await c.admin.get('/dashboard')).json;
    expect(ad.services).toBeUndefined();
    expect(ad.setup).toBeUndefined();
  });
});

describe('Checkliste „BlaulichtCMS startklar“ (#255)', () => {
  const item = (cl: any, id: string) => cl.items.find((i: any) => i.id === id);

  it('nur für die Administration; erkennt den Stand aus Einstellungen und Daten', async () => {
    expect((await c.redaktion.get('/setup/checklist')).status).toBe(403);
    expect((await c.redaktion.put('/setup/checklist', { hide: ['website'] })).status).toBe(403);
    let cl = (await c.admin.get('/setup/checklist')).json;
    expect(cl.items.map((i: any) => i.id)).toEqual(['organization', 'public_url', 'privacy', 'mail', 'state', 'backup', 'invite', 'update_helper', 'two_factor', 'website', 'test_post']);
    for (const i of cl.items) expect(i.href.startsWith('/'), i.id).toBe(true);
    // Ziele in den Einstellungen (#256): Unterseite existiert, Feld bzw. Abschnittsanker steht auf der Seite
    const { SETTINGS_PAGES } = await import('../../web/src/config/settingsPages.js');
    const dir = path.join(__dirname, '../../web/src/pages/admin/settings');
    const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const i of cl.items.filter((x: any) => x.href.startsWith('/einstellungen'))) {
      const [page, anchor] = i.href.split('#');
      expect(SETTINGS_PAGES.map((p: { id: string }) => `/einstellungen/${p.id}`), i.id).toContain(page);
      if (anchor?.startsWith('s-')) expect(src, i.id).toMatch(new RegExp(`["']${anchor.slice(2).replace('-', '\\.')}["']`));
      else if (anchor) expect(src, i.id).toMatch(new RegExp(`["']${anchor}["']`));
    }
    // Frisch: Pflichtangaben fehlen
    expect(item(cl, 'organization').done).toBe(false);
    expect(item(cl, 'privacy').done).toBe(false);
    expect(item(cl, 'privacy').detail).toMatch(/verantwortliche Stelle, Datenschutzerklärung, Impressum/);
    expect(item(cl, 'mail').done).toBe(false);
    expect(item(cl, 'state').done).toBe(false);
    expect(item(cl, 'backup').done).toBe(false);
    expect(item(cl, 'backup').detail).toMatch(/Ziel außer Haus/);
    expect(item(cl, 'update_helper').done).toBe(false);
    expect(item(cl, 'test_post').done).toBe(false);
    expect(cl.requiredDone).toBe(false);
    expect(cl.visible).toBe(true);
    // Mehrere Konten, gekoppelte Website (aus dem Test davor)
    expect(item(cl, 'invite').done).toBe(true);
    expect(item(cl, 'invite').detail).toMatch(/7 Konten/);
    expect(item(cl, 'website').done).toBe(true);

    // Angaben nachtragen → ohne weiteres Zutun erledigt
    await setSettings({ 'general.organization': 'Musterwehr', 'general.public_url': 'https://cms.example.org', 'general.state': 'eigen', 'privacy.controller': 'Musterwehr, Musterstraße 1', 'legal.privacy_text': '# Datenschutz', 'legal.imprint_text': '# Impressum' });
    await pool.query(`INSERT INTO restore_drills (source, file_name, trigger, status, finished_at) VALUES ('local', 'test.dump', 'manual', 'ok', now())`);
    cl = (await c.admin.get('/setup/checklist')).json;
    for (const id of ['organization', 'public_url', 'privacy', 'state']) expect(item(cl, id).done, id).toBe(true);
    expect(item(cl, 'two_factor').detail).toMatch(/7 aktive Konten von 7 ohne Zwei-Faktor/);
    // Zwei-Faktor-Pflicht für alle (direkt geprüft – die Pflicht würde die Testsitzungen sonst zur Einrichtung schicken)
    await setSettings({ 'security.require_2fa_all': true });
    expect(item(await setupChecklist(new Set(['settings.security'])), 'two_factor').done).toBe(true);
    await setSettings({ 'security.require_2fa_all': false });
    expect(item(cl, 'state').detail).toMatch(/Eigene Liste/);
    // Probe bestanden, Ziel außer Haus fehlt weiter
    expect(item(cl, 'backup').detail).not.toMatch(/Probe/);
    expect(item(cl, 'backup').done).toBe(false);
    // Öffentliche Adresse ohne HTTPS gilt nicht
    await setSettings({ 'general.public_url': 'http://cms.example.org' });
    expect(item((await c.admin.get('/setup/checklist')).json, 'public_url').detail).toMatch(/kein HTTPS/);
    await setSettings({ 'general.public_url': 'https://cms.example.org' });

    // Testmail: nur mit passendem Prüfwert der aktuellen Versandeinstellungen
    await setSettings({ 'smtp.host': 'mail.example.org', 'smtp.from': 'cms@example.org', 'smtp.verified': { fp: 'falsch', at: new Date().toISOString() } } as any);
    expect(item((await c.admin.get('/setup/checklist')).json, 'mail').detail).toMatch(/noch keine Testmail/);
    const { smtpFingerprint, storedSmtpSettings } = await import('../src/warnings/mail.js');
    await setSettings({ 'smtp.verified': { fp: smtpFingerprint(await storedSmtpSettings()), at: new Date().toISOString() } } as any);
    expect(item((await c.admin.get('/setup/checklist')).json, 'mail').done).toBe(true);
    // Mailserver später geändert → wieder offen
    await setSettings({ 'smtp.host': 'anderer.example.org' } as any);
    expect(item((await c.admin.get('/setup/checklist')).json, 'mail').done).toBe(false);
  });

  it('offene Punkte einzeln oder gesammelt ausblenden, wieder einblenden; erledigte kommen bei Rückfall zurück', async () => {
    expect((await c.admin.put('/setup/checklist', { hide: ['gibt-es-nicht'] })).status).toBe(400);
    let cl = (await c.admin.put('/setup/checklist', { hide: ['backup', 'website'] })).json;
    // website ist erledigt → wird nicht ausgeblendet (würde bei einem Rückfall sonst verschwinden)
    expect(item(cl, 'backup').hidden).toBe(true);
    expect(item(cl, 'website').hidden).toBe(false);
    expect(cl.hidden).toBe(1);
    expect((await getSettings(true))['setup.checklist_hidden']).toEqual(['backup', 'website']);
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'setup.checklist_changed'`)).not.toBeNull();
    expect(item((await c.admin.get('/setup/checklist')).json, 'backup').hidden).toBe(true);
    // Website fällt weg → Punkt offen und ausgeblendet (weil gemerkt) – anderes Beispiel: mail war nie ausgeblendet → sichtbar
    expect(item(cl, 'mail').hidden).toBe(false);
    cl = (await c.admin.put('/setup/checklist', { show: 'all' })).json;
    expect(cl.hidden).toBe(0);
    expect((await getSettings(true))['setup.checklist_hidden']).toEqual([]);
    // Kachel verschwindet erst, wenn nichts mehr offen und sichtbar ist
    const open = cl.items.filter((i: any) => !i.done).map((i: any) => i.id);
    cl = (await c.admin.put('/setup/checklist', { hide: open })).json;
    expect(cl.visible).toBe(false);
    expect(cl.done).toBe(cl.total);
    cl = (await c.admin.put('/setup/checklist', { show: 'all' })).json;
    expect(cl.visible).toBe(true);
  });

  it('zeigt nur Punkte, die die Person mit ihren Rechten erledigen kann', async () => {
    const cl = await setupChecklist(new Set(['settings.view', 'settings.general']));
    expect(cl.items.map((i) => i.id)).toEqual(['organization', 'public_url', 'state']);
  });
});

describe('Begrüßung neuer Konten (#255)', () => {
  it('Merker im Konto; die Migration markiert alle bis dahin angelegten Konten', async () => {
    expect((await c.lesen.get('/auth/me')).json.user.preferences.welcomeDone).toBeUndefined();
    expect((await c.lesen.patch('/auth/preferences', { welcomeDone: true })).status).toBe(200);
    expect((await c.lesen.get('/auth/me')).json.user.preferences.welcomeDone).toBe(true);
    expect((await c.lesen.patch('/auth/preferences', { welcomeDone: 'ja' })).status).toBe(400);

    const sql = fs.readFileSync(path.join(__dirname, '../migrations/230_welcome_existing_accounts.sql'), 'utf8');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(sql);
      const r = await db.query(`SELECT count(*)::int AS n FROM users WHERE NOT (preferences ? 'welcomeDone') OR preferences->'welcomeDone' <> 'true'::jsonb`);
      expect(r.rows[0].n).toBe(0);
      // Andere Einstellungen im Konto bleiben erhalten
      const t = await db.query(`SELECT preferences FROM users WHERE email = 'lesen@example.org'`);
      expect(t.rows[0].preferences.welcomeDone).toBe(true);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
    expect((await c.redaktion.get('/auth/me')).json.user.preferences.welcomeDone).toBeUndefined();
  });
});
