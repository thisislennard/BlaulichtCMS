import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { invalidateRoles } from '../src/auth/roles.js';
import { invalidateKeywords, lookupKeyword, refreshKeywordCatalog, withKeywordText } from '../src/keywords/store.js';

/**
 * Stichwortverzeichnisse (#195) gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL): Bundesland wählen,
 * Verzeichnis übernehmen, eigene Liste importieren/exportieren, Vorrang eigener Einträge, Nachschlagen für
 * Einsatzmeldungen und Rechte. Die Datenbank wird zu Beginn geleert (die Testdateien laufen nacheinander).
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
let ipCounter = 10;

class Client {
  cookie = '';
  ip = `10.78.0.${ipCounter++}`;
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
    return { status: res.statusCode, json, headers: res.headers };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
  patch = (u: string, b: unknown = {}) => this.raw('PATCH', u, b);
}

let admin: Client;
let reader: Client;
let passwordHash: string;
const byCode = async () => Object.fromEntries((await admin.get('/keywords')).json.entries.map((e: any) => [e.code, e]));

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateRoles();
  invalidateKeywords();
  await migrate(() => {});
  app = await buildApp();
  await pool.query(`INSERT INTO users (email, name, password_hash, roles) VALUES ('admin@example.org','Alex Admin',$1,'{platform_admin}')`, [passwordHash]);
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
  admin = new Client(app);
  expect((await admin.post('/auth/login', { email: 'admin@example.org', password: PASSWORD })).json.next).toBe('done');
  // Nur „Automationen ansehen“: darf nachschlagen, aber nichts ändern
  const role = await admin.post('/roles', { label: 'Automationen lesen', permissions: ['automation.read'] });
  expect(role.status).toBe(200);
  await pool.query(`INSERT INTO users (email, name, password_hash, roles) VALUES ('leser@example.org','Lea Leser',$1,$2)`, [passwordHash, [role.json.id]]);
  reader = new Client(app);
  expect((await reader.post('/auth/login', { email: 'leser@example.org', password: PASSWORD })).json.next).toBe('done');
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Stichwortverzeichnis', () => {
  it('ohne Bundesland: leere Liste, alle Länder wählbar', async () => {
    const r = await admin.get('/keywords');
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('');
    expect(r.json.entries).toEqual([]);
    expect(r.json.states).toHaveLength(16);
    expect(r.json.states.filter((s: any) => s.catalog).map((s: any) => s.id).sort()).toEqual(['BY', 'HE']);
    expect(await refreshKeywordCatalog()).toBeNull();
  });

  it('Bundesland Hessen übernimmt das Verzeichnis', async () => {
    expect((await admin.patch('/settings', { 'general.state': 'XX' })).status).toBe(400);
    expect((await admin.patch('/settings', { 'general.state': 'HE' })).status).toBe(200);
    const r = await admin.get('/keywords');
    expect(r.json.catalog).toMatchObject({ land: 'HE', stand: '30. August 2024', anzahl: 58 });
    expect(r.json.noCatalogText).toBeNull();
    expect(r.json.entries).toHaveLength(58);
    const k = await byCode();
    expect(k['F 2']).toMatchObject({ label: 'Brand', category: 'Brand', source: 'HE' });
    expect(k['F 2'].details).toContain('Wohnungsbrand');
    expect(k['H SCHIFF 1 Y'].aliases).toEqual(['H SCHIFF Y 1']);
    expect((await one<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'keywords.state_changed'`))!.n).toBe(1);
    // Neustart: Auffrischen ändert nichts
    expect(await refreshKeywordCatalog()).toEqual({ added: 0, updated: 0, deactivated: 0, ownKept: 0 });
  });

  it('Nachschlagen für Einsatzmeldungen: Schreibweise, Untergliederung, unbekannt', async () => {
    invalidateKeywords();
    expect(await lookupKeyword('F2')).toMatchObject({ code: 'F 2', label: 'Brand', category: 'Brand', partial: false });
    expect(await lookupKeyword('F2 W')).toMatchObject({ code: 'F 2', partial: true });
    expect(await lookupKeyword('B3')).toBeNull();
    expect(await withKeywordText({ keyword: 'F 3 Y' })).toEqual({ keyword: 'F 3 Y', keyword_text: 'Ausgedehnter Brand in Sondergebäuden mit Menschenleben in Gefahr' });
    // gelieferter Klartext bleibt, unbekanntes Stichwort bleibt roh
    expect(await withKeywordText({ keyword: 'F 2', keyword_text: 'Zimmerbrand' })).toEqual({ keyword: 'F 2', keyword_text: 'Zimmerbrand' });
    expect(await withKeywordText({ keyword: 'B3' })).toEqual({ keyword: 'B3' });
  });

  it('eigene Liste: Import überschreibt und ergänzt, Rechte', async () => {
    const csv = 'code;bezeichnung;kategorie\nF2;Brand mittel (eigene Bezeichnung);Brand\nX 1;Eigenes Stichwort;Sonstiges\n;kaputt;\n';
    expect((await reader.get('/keywords')).status).toBe(200);
    expect((await reader.post('/keywords/import', { text: csv })).status).toBe(403);
    expect((await reader.post('/keywords/sync')).status).toBe(403);
    expect((await admin.post('/keywords/import', { text: 'nur;x' })).status).toBe(400);
    const dry = await admin.post('/keywords/import', { text: csv, dryRun: true });
    expect(dry.json).toEqual({ rows: 2, errors: [expect.stringContaining('Zeile 4')] });
    const r = await admin.post('/keywords/import', { text: csv });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ added: 1, updated: 1, unchanged: 0 });
    const k = await byCode();
    expect(k['F 2']).toMatchObject({ label: 'Brand mittel (eigene Bezeichnung)', source: 'eigen' });
    expect(k['X 1']).toMatchObject({ label: 'Eigenes Stichwort', category: 'Sonstiges', source: 'eigen' });
    // gleiches Kürzel in anderer Schreibweise gilt als vorhanden
    expect((await admin.post('/warning-keywords', { code: 'x1', label: 'Doppelt' })).status).toBe(409);
    // Verzeichnis neu übernehmen: eigene Einträge bleiben
    const s = await admin.post('/keywords/sync');
    expect(s.json).toMatchObject({ added: 0, ownKept: 1 });
    expect((await byCode())['F 2'].label).toBe('Brand mittel (eigene Bezeichnung)');
  });

  it('Bezeichnung eines Verzeichniseintrags ändern macht ihn zum eigenen Eintrag; Deaktivieren nicht', async () => {
    const row = await one<any>(`SELECT id, label, aliases FROM fire_keywords WHERE code = 'F 1'`);
    expect((await admin.put(`/warning-keywords/${row.id}`, { label: row.label, aliases: row.aliases, active: false })).status).toBe(200);
    expect((await one<any>(`SELECT source, active FROM fire_keywords WHERE id = $1`, [row.id]))).toEqual({ source: 'HE', active: false });
    // Auffrischen lässt den von Hand deaktivierten Eintrag aus
    await admin.post('/keywords/sync');
    expect((await one<any>(`SELECT active FROM fire_keywords WHERE id = $1`, [row.id]))!.active).toBe(false);
    const long = 'Brand (PKW, Mülltonne) – lokale Fassung mit sehr ausführlicher Beschreibung, die länger als hundertzwanzig Zeichen ist, damit auch lange Bezeichnungen gehen';
    expect((await admin.put(`/warning-keywords/${row.id}`, { label: long, category: 'Brand', aliases: [], active: true })).status).toBe(200);
    expect((await one<any>(`SELECT source, active, label FROM fire_keywords WHERE id = $1`, [row.id]))).toEqual({ source: 'eigen', active: true, label: long });
  });

  it('Wechsel nach Bayern und in ein Land ohne Verzeichnis', async () => {
    await admin.patch('/settings', { 'general.state': 'BY' });
    let k = await byCode();
    expect(k['B 1']).toMatchObject({ label: 'B 1', category: 'Brand', source: 'BY' });
    expect(k['F 3']).toBeUndefined(); // hessischer Eintrag deaktiviert, nicht gelöscht
    expect(k['F 2'].source).toBe('eigen');
    expect(Object.keys(k)).toHaveLength(125 + 3);
    expect((await one<any>(`SELECT active FROM fire_keywords WHERE code = 'F 3'`))!.active).toBe(false);

    await admin.patch('/settings', { 'general.state': 'NW' });
    const r = await admin.get('/keywords');
    expect(r.json.catalog).toBeNull();
    expect(r.json.noCatalogText).toBe('Kein öffentliches Verzeichnis hinterlegt – eigene Liste importieren.');
    expect(r.json.entries.map((e: any) => e.code).sort()).toEqual(['F 1', 'F 2', 'X 1']);
    expect((await admin.post('/keywords/sync')).status).toBe(400);

    // zurück nach Hessen: Verzeichnis wieder aktiv, eigene Einträge unverändert
    await admin.patch('/settings', { 'general.state': 'HE' });
    k = await byCode();
    expect(Object.keys(k)).toHaveLength(58 + 1);
    expect(k['F 3'].source).toBe('HE');
    expect(k['F 2'].label).toBe('Brand mittel (eigene Bezeichnung)');
  });

  it('Export als CSV (wieder importierbar) und JSON', async () => {
    const c = await admin.get('/keywords/export?format=csv');
    expect(c.status).toBe(200);
    expect(String(c.headers['content-type'])).toContain('text/csv');
    expect(c.json).toContain('code;bezeichnung;kategorie;quelle;aktiv');
    expect(c.json).toContain('F 2;Brand mittel (eigene Bezeichnung);Brand;eigen;ja');
    expect(c.json).toContain('F 3;Ausgedehnter Brand in Sondergebäuden;Brand;HE;ja');
    const j = await admin.get('/keywords/export?format=json');
    expect(j.json.find((x: any) => x.code === 'R MANV')).toMatchObject({ kategorie: 'Rettungsdienst', quelle: 'HE', aktiv: true });
    // Re-Import des eigenen Exports ist ohne Fehler möglich
    expect((await admin.post('/keywords/import', { text: c.json, dryRun: true })).json.errors).toEqual([]);
    expect((await many<any>(`SELECT 1 FROM fire_keywords`)).length).toBeGreaterThan(180);
  });
});
