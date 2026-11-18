import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, one } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { foldSql, foldText, searchTerms } from '../src/routes/search.js';
import * as web from '../../web/src/lib/searchText.js';
import { SETTINGS_INDEX } from '../../web/src/config/settingsIndex.js';
import { navigation } from '../../web/src/config/navigation.js';

/**
 * Suche Strg K (#259): Inhalte aller Bereiche mit Leserecht, Vorgangsnummern, Umlaute und Wortanfänge (gegen eine
 * echte PostgreSQL-Datenbank) sowie die Indizes der Oberfläche für Seiten, Einstellungen und Hilfe.
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
const nav = JSON.parse(fs.readFileSync(path.join(__dirname, '../../web/src/i18n/de/nav.json'), 'utf8'));

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
}

let admin: Client;
let reader: Client;
const search = async (c: Client, q: string) => {
  const r = await c.get(`/search?q=${encodeURIComponent(q)}`);
  if (r.status !== 200) throw new Error(`Suche „${q}“: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as { results: any[]; more: Record<string, string> };
};
const groups = (r: { results: any[] }) => [...new Set(r.results.map((x) => x.group))];

describe('Suche: Vereinheitlichung (Server und Oberfläche gleich)', () => {
  const samples = ['Übungsdienst', 'Uebungsdienst', 'ubungsdienst', 'Stichwörter & Regeln', 'Gartenhütte', 'GARTENHUETTE', 'Straße', 'Strasse', 'Café', 'Fußgängerzone'];
  it('foldText ist in Server und Oberfläche identisch; ö = oe = o, ß = ss = s', () => {
    for (const s of samples) expect(web.foldText(s), s).toBe(foldText(s));
    expect(foldText('Übungsdienst')).toBe(foldText('uebungsdienst'));
    expect(foldText('Übungsdienst')).toBe(foldText('Ubungsdienst'));
    expect(foldText('Straße')).toBe(foldText('Strasse'));
    expect(foldText('Stichwörter')).toContain(foldText('Stichwort'));
    expect(searchTerms('  Brand   Gartenhütte ')).toEqual(['brand', 'gartenhutte']);
    expect(searchTerms('100%_\\')).toEqual(['100\\%\\_\\\\']);
  });

  it('Rangfolge: Titelanfang vor Wortanfang vor Teilwort; fehlendes Wort → kein Treffer', () => {
    expect(web.rank(['brand'], 'Brand Gartenhütte')).toBe(0);
    expect(web.rank(['garten'], 'Brand Gartenhütte')).toBe(1);
    expect(web.rank(['hutte'], 'Brand Gartenhütte')).toBe(2);
    expect(web.rank(['brand', 'keller'], 'Brand Gartenhütte')).toBeNull();
  });
});

describe('Suche: Seiten, Einstellungen und Hilfe (Oberfläche)', () => {
  const settingsSrc = ['pages/admin/Settings.tsx', 'pages/admin/NotifySettings.tsx', 'pages/admin/OffsiteBackup.tsx', 'pages/admin/Updates.tsx', 'pages/NotifyPrefs.tsx']
    .map((f) => fs.readFileSync(path.join(__dirname, '../../web/src', f), 'utf8'))
    .join('\n');
  const find = (q: string) =>
    SETTINGS_INDEX.map((s) => ({ s, r: web.rank(web.searchTerms(q), s.title, `${s.keywords} ${s.where}`) }))
      .filter((x) => x.r !== null)
      .map((x) => x.s.title);

  it('jedes Ziel des Einstellungs-Index existiert (Abschnittsanker bzw. Seite)', () => {
    for (const s of SETTINGS_INDEX) {
      const [p, anchor] = s.href.split('#');
      expect(['/einstellungen', '/profil', '/stichwoerter-regeln'], s.title).toContain(p);
      if (anchor) expect(settingsSrc, `${s.title}: #${anchor}`).toMatch(new RegExp(`["']${anchor}["']`));
    }
  });

  it('Beispiele aus #259: SMTP, Mail, Sicherung, Zeitzone finden die Einstellung', () => {
    expect(find('SMTP')).toEqual(expect.arrayContaining(['Benachrichtigungen und E-Mail', 'SMTP-Server und Testmail']));
    expect(find('Mail')).toEqual(expect.arrayContaining(['Benachrichtigungen und E-Mail', 'SMTP-Server und Testmail']));
    expect(find('Sicherung')).toEqual(expect.arrayContaining(['Sicherung', 'Sicherung außer Haus']));
    expect(find('Zeitzone')).toEqual(['Allgemein']);
  });

  it('„Stichwort“ findet den Menüpunkt „Stichwörter & Regeln“ (Umlaut)', () => {
    const labels = navigation.flatMap((g) => g.items.map((i) => nav[i.label.replace(/^nav\./, '')] as string));
    expect(labels.filter((l) => web.rank(web.searchTerms('Stichwort'), l) !== null)).toEqual(['Stichwörter & Regeln']);
  });

  it('„Sicherung“ findet das Hilfe-Kapitel', async () => {
    const h = await import('../../web/src/pages/help/search.js');
    const hits = h.search('Sicherung', h.markdownDocs(), 10);
    expect(hits.some((x) => x.doc.chapter === 'sicherung')).toBe(true);
  });
});

describe('Suche: Inhalte aller Bereiche mit Leserecht (Server)', () => {
  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    fs.rmSync(process.env.BLAULICHTCMS_DATA_DIR!, { recursive: true, force: true });
    await migrate(() => {});
    app = await buildApp();
    admin = new Client(app);
    const { ensureSetupToken } = await import('../src/routes/auth.js');
    await ensureSetupToken();
    const token = fs.readFileSync(path.join(process.env.BLAULICHTCMS_DATA_DIR!, 'setup-token.txt'), 'utf8').trim();
    expect((await admin.post('/auth/setup', { token, name: 'Alex Admin', email: 'admin@example.org', password: PASSWORD, organization: 'Musterorganisation', publicUrl: 'https://blaulichtcms.example.org/', timezone: 'Europe/Berlin' })).status).toBe(200);
    await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false });
    expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
    // Person, die nur Beiträge lesen darf
    const role = await admin.post('/roles', { label: 'Nur Beiträge lesen', permissions: ['post.view'] });
    expect(role.status, JSON.stringify(role.json)).toBe(200);
    const inv = await admin.post('/users/invite', { email: 'lesen@example.org', roles: [role.json.id] });
    reader = new Client(app);
    expect((await reader.post(`/auth/invite/${inv.json.link.split('/einladung/')[1]}`, { name: 'Lea Lesen', password: 'Lea-Zugang-sicher-2026' })).json.next).toBe('done');
    // Testdaten (fiktiv)
    expect((await admin.post('/posts', { title: 'Brand Gartenhütte', kind: 'news' })).status).toBe(200);
    expect((await admin.post('/collections', { title: 'Fotos Gartenhütte', purpose: 'Einsatz' })).status).toBe(200);
    expect((await admin.post('/press/requests', { topic: 'Rückfragen zum Brand der Gartenhütte', outlet: 'Testzeitung' })).status).toBe(200);
    expect((await admin.post('/incidents', { alarmAt: '2026-11-14T13:30:00.000Z', keyword: 'F 2', title: 'Kaminbrand', location: 'Nord' })).status).toBe(200);
    expect((await admin.post('/calendar/events', { title: 'Übungsdienst', location: 'Gerätehaus', start: '2026-12-04T18:30:00.000Z', end: '2026-12-04T21:00:00.000Z' })).status).toBe(200);
    expect((await admin.post('/warnings', { kind: 'initial' })).status).toBe(200);
    expect((await admin.post('/automations', { name: 'Unwetter-Banner', description: 'Banner bei Warnung' })).status).toBe(200);
    expect((await admin.post('/design-templates', { title: 'Logo Gartenfest' })).status).toBe(200);
    expect((await admin.post('/connections', { kind: 'fe2', name: 'FE2 Leitstelle' })).status).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it('die SQL-Vereinheitlichung entspricht foldText', async () => {
    for (const s of ['Übungsdienst', 'Gartenhütte', 'Straße', 'Stichwörter', 'Café ÄÖÜ äöü ß']) {
      const r = await one<{ f: string }>(`SELECT ${foldSql('$1::text')} AS f`, [s]);
      expect(r!.f, s).toBe(foldText(s));
    }
  });

  it('„Gartenhütte“ findet Beitrag, Sammlung, Presseanfrage und Designvorlage (nicht „Gartenfest“ ohne „hütte“)', async () => {
    const r = await search(admin, 'Gartenhütte');
    expect(groups(r)).toEqual(expect.arrayContaining(['Beiträge', 'Medien', 'Presse']));
    expect(r.results.find((x) => x.group === 'Presse')).toMatchObject({ title: 'Rückfragen zum Brand der Gartenhütte', subtitle: expect.stringMatching(/^P-\d{4}-0001 · Testzeitung$/), href: expect.stringMatching(/^\/presse\/[0-9a-f-]{36}$/) });
    expect(r.results.some((x) => x.title === 'Logo Gartenfest')).toBe(false);
    // ohne Umlaut, anders geschrieben, mit zwei Wörtern
    expect(groups(await search(admin, 'gartenhuette'))).toEqual(groups(r));
    expect((await search(admin, 'brand garten')).results.map((x) => x.title)).toEqual(expect.arrayContaining(['Brand Gartenhütte', 'Rückfragen zum Brand der Gartenhütte']));
  });

  it('Einsatzliste, Kalender, Workflows, Verbindungen und Designvorlagen', async () => {
    expect((await search(admin, 'Kaminbrand')).results).toEqual([expect.objectContaining({ group: 'Einsatzliste', title: 'Kaminbrand', subtitle: 'F 2 · Nord · 14.11.2026', href: '/einsatzliste?suche=Kaminbrand' })]);
    const ev = (await search(admin, 'ubungsdienst')).results;
    expect(ev).toEqual([expect.objectContaining({ group: 'Kalender', title: 'Übungsdienst', subtitle: '04.12.2026 · Gerätehaus', href: expect.stringMatching(/^\/kalender\?termin=[0-9a-f-]{36}$/) })]);
    expect((await search(admin, 'Unwetter')).results[0]).toMatchObject({ group: 'Workflows', title: 'Unwetter-Banner' });
    expect((await search(admin, 'Leitstelle')).results[0]).toMatchObject({ group: 'Verbindungen', title: 'FE2 Leitstelle' });
    expect((await search(admin, 'Gartenfest')).results[0]).toMatchObject({ group: 'Designvorlagen', title: 'Logo Gartenfest', subtitle: 'Designvorlage' });
  });

  it('Vorgangsnummern führen direkt zum Vorgang (auch ohne führende Nullen)', async () => {
    const year = new Date().getFullYear();
    const p = await search(admin, `p-${year}-1`);
    expect(p.results[0]).toMatchObject({ exact: true, group: 'Presse', title: 'Rückfragen zum Brand der Gartenhütte' });
    const w = await search(admin, `W-${year}-0001`);
    expect(w.results[0]).toMatchObject({ exact: true, group: 'Warnentwürfe', title: `W-${year}-0001`, href: expect.stringMatching(/^\/warnungen\//) });
  });

  it('keine Treffer aus Bereichen ohne Leserecht', async () => {
    const r = await search(reader, 'Gartenhütte');
    expect(groups(r)).toEqual(['Beiträge']);
    for (const q of ['Kaminbrand', 'Übungsdienst', 'Unwetter', 'Leitstelle', `P-${new Date().getFullYear()}-0001`]) expect((await search(reader, q)).results, q).toEqual([]);
    expect((await reader.get('/search?q=')).status).toBe(400);
  });

  it('höchstens fünf je Bereich, „Alle Treffer in …“ mit gefilterter Liste', async () => {
    for (let i = 1; i <= 6; i++) expect((await admin.post('/press/requests', { topic: `Sammelanfrage ${i}`, outlet: 'Zeitung' })).status).toBe(200);
    const r = await search(admin, 'Sammelanfrage');
    expect(r.results.filter((x) => x.group === 'Presse')).toHaveLength(5);
    expect(r.more).toEqual({ Presse: '/presse?filter=all&suche=Sammelanfrage' });
    // LIKE-Sonderzeichen werden nicht als Platzhalter verwendet
    expect((await search(admin, '%')).results).toEqual([]);
  });
});
