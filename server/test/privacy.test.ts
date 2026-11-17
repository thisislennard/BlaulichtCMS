import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { setSettings } from '../src/lib/settings.js';
import { hashPassword } from '../src/auth/passwords.js';
import { invalidateRoles } from '../src/auth/roles.js';
import { ipHash } from '../src/lib/public-security.js';
import { PERSON_COLUMN, PERSON_COLUMN_TYPES, PRIVACY_COVERAGE, TEXT_AREAS } from '../src/lib/privacy-coverage.js';

/**
 * Datenschutzanfragen (#141, #245) gegen eine echte PostgreSQL-Datenbank (TEST_DATABASE_URL): Abdeckung aller Tabellen
 * und die Bereiche seit v0.3.0 (Presse-Postfach, Versandprotokolle, Kalender, Einsatzliste, Benachrichtigungen,
 * weitere Texte). Die Datenbank wird zu Beginn geleert (die Testdateien laufen nacheinander).
 */
let app: FastifyInstance;
const PASSWORD = 'Langes-Passwort-2026';
const here = path.dirname(fileURLToPath(import.meta.url));

class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async raw(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as any,
      remoteAddress: '10.79.5.1',
      url: `/api/v1${url}`,
      payload: body === undefined ? undefined : JSON.stringify(body),
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
    return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload };
  }
  get = (u: string) => this.raw('GET', u);
  post = (u: string, b: unknown = {}) => this.raw('POST', u, b);
  put = (u: string, b: unknown = {}) => this.raw('PUT', u, b);
}

let admin: Client;
let adminId: string;
const search = async (q: string) => {
  const r = await admin.get(`/privacy/search?q=${encodeURIComponent(q)}`);
  expect(r.status).toBe(200);
  return r.json.hits as any[];
};
const act = (kind: string, id: string, action: 'delete' | 'pseudonymize') => admin.post('/privacy/action', { kind, id, action });

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  invalidateRoles();
  await migrate(() => {});
  app = await buildApp();
  await setSettings({ 'security.require_2fa_admins': false, 'security.require_2fa_media': false, 'setup.completed': true } as any);
  const u = await one<any>(`INSERT INTO users (email, name, password_hash, roles) VALUES ('dsb@example.org', 'Dana Datenschutz', $1, '{platform_admin}') RETURNING id`, [await hashPassword(PASSWORD)]);
  adminId = u!.id;
  admin = new Client(app);
  expect((await admin.post('/auth/login', { email: 'dsb@example.org', password: PASSWORD })).json.next).toBe('done');
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('Datenschutzanfragen: Abdeckung aller Tabellen (#245)', () => {
  it('jede Tabelle ist in lib/privacy-coverage.ts eingetragen – durchsucht oder mit Begründung ausgenommen', async () => {
    const tables = (await many<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.t);
    expect(tables.length).toBeGreaterThan(50);
    const missing = tables.filter((t) => !(t in PRIVACY_COVERAGE));
    expect(missing, `Neue Tabelle(n) ohne Eintrag in server/src/lib/privacy-coverage.ts – in der Datenschutzsuche abdecken oder mit Begründung ausnehmen: ${missing.join(', ')}`).toEqual([]);
    expect(Object.keys(PRIVACY_COVERAGE).filter((t) => !tables.includes(t)), 'Einträge für Tabellen, die es nicht gibt').toEqual([]);
    for (const [t, c] of Object.entries(PRIVACY_COVERAGE)) {
      if ('excluded' in c) expect(c.excluded.length, `Begründung für ${t}`).toBeGreaterThan(10);
    }
  });

  it('personenbezogene Spalten durchsuchter Tabellen sind durchsucht oder begründet, eingetragene Spalten existieren', async () => {
    const cols = await many<{ t: string; c: string; type: string }>(`SELECT table_name AS t, column_name AS c, udt_name AS type FROM information_schema.columns WHERE table_schema = 'public'`);
    const problems: string[] = [];
    for (const [t, cov] of Object.entries(PRIVACY_COVERAGE)) {
      if (!('hit' in cov)) continue;
      const own = cols.filter((x) => x.t === t);
      for (const c of [...cov.search, ...Object.keys(cov.other ?? {})]) if (!own.some((x) => x.c === c)) problems.push(`${t}.${c} gibt es nicht`);
      for (const x of own) {
        if (!PERSON_COLUMN_TYPES.has(x.type) || !PERSON_COLUMN.test(x.c)) continue;
        if (!cov.search.includes(x.c) && !(x.c in (cov.other ?? {}))) problems.push(`${t}.${x.c} (${x.type}) weder durchsucht noch begründet`);
      }
    }
    expect(problems, 'server/src/lib/privacy-coverage.ts ergänzen').toEqual([]);
  });

  it('routes/privacy.ts fragt jede eingetragene Tabelle und Spalte ab', () => {
    const src = fs.readFileSync(path.join(here, '../src/routes/privacy.ts'), 'utf8');
    const textTables = new Set(TEXT_AREAS.map((a) => a.table));
    const problems: string[] = [];
    for (const [t, cov] of Object.entries(PRIVACY_COVERAGE)) {
      if (!('hit' in cov) || textTables.has(t)) continue;
      if (!new RegExp(`\\b${t}\\b`).test(src)) problems.push(`Tabelle ${t}`);
      for (const c of cov.search) if (!new RegExp(`\\.${c}\\b|\\b${c}\\s+(ILIKE|=)`).test(src)) problems.push(`${t}.${c}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('Datenschutzanfragen: Presse (#245)', () => {
  let requestId: string;
  const attachment = Buffer.from('%PDF-1.4 Unfallbericht mit Namen\n', 'utf8');

  beforeAll(async () => {
    const r = await one<any>(
      `INSERT INTO press_requests (case_no, channel, outlet, contact_name, contact_email, topic, body) VALUES ('PA-2026-0042', 'mailbox', 'Kreisblatt', 'Jana Journal', 'jana@kreisblatt.example', 'Unfall Ortsmitte', 'Bitte um Details.') RETURNING id`,
    );
    requestId = r!.id;
    const m = await one<any>(
      `INSERT INTO press_messages (request_id, direction, from_address, from_name, to_addresses, cc_addresses, subject, text_body, html_body, received_at)
       VALUES ($1, 'in', 'jana@kreisblatt.example', 'Jana Journal', '{presse@feuerwehr.example}', '{kollegin@kreisblatt.example}', 'Unfall Ortsmitte', 'Laut Zeugen war Erwin Beispielmann beteiligt.', '<p>Laut Zeugen war Erwin Beispielmann beteiligt.</p>', now()) RETURNING id`,
      [requestId],
    );
    await pool.query(`INSERT INTO press_attachments (message_id, filename, content_type, size, sha256, data) VALUES ($1, 'skizze-unfallstelle.pdf', 'application/pdf', $2, 'x', $3)`, [m!.id, attachment.length, attachment]);
    await pool.query(`INSERT INTO press_request_events (request_id, actor_name, kind, text) VALUES ($1, '', 'created', 'Eingang über das Presse-Postfach')`, [requestId]);
  });

  it('findet Personen, die nur in CC, im Mailtext oder als Anhangname stehen', async () => {
    for (const q of ['kollegin@kreisblatt.example', 'Erwin Beispielmann', 'skizze-unfallstelle']) {
      const hit = (await search(q)).find((h) => h.kind === 'press_request');
      expect(hit, q).toMatchObject({ id: requestId, actions: ['delete'], link: `/presse/${requestId}` });
    }
    const hit = (await search('Erwin Beispielmann')).find((h) => h.kind === 'press_request');
    expect(hit.fields.fundstellen).toEqual(['Mails (Absender, Empfänger, CC, Betreff, Text)']);
    expect(hit.fields).toMatchObject({ mails: 1, anhaenge: 1, anfragetext: 'Bitte um Details.' });
  });

  it('Auskunft (ZIP) enthält Anfrage mit Verlauf, Mails als Text und Anhänge im Original', async () => {
    const zip = await admin.raw('GET', `/privacy/export?q=${encodeURIComponent('jana@kreisblatt.example')}`);
    expect(zip.status).toBe(200);
    const AdmZip = (await import('adm-zip')).default;
    const z = new AdmZip(zip.raw);
    const names = z.getEntries().map((e: any) => e.entryName);
    expect(names).toEqual(expect.arrayContaining(['auskunft.json', 'presse/PA-2026-0042/anfrage.json', 'presse/PA-2026-0042/mails/01-eingang.txt', 'presse/PA-2026-0042/anhaenge/01-skizze-unfallstelle.pdf']));
    const doc = JSON.parse(z.readAsText('presse/PA-2026-0042/anfrage.json'));
    expect(doc).toMatchObject({ vorgang: 'PA-2026-0042', anfragetext: 'Bitte um Details.', name: 'Jana Journal', verlauf: [{ art: 'created' }] });
    expect(doc.mails[0]).toMatchObject({ cc: ['kollegin@kreisblatt.example'], anhaenge: ['skizze-unfallstelle.pdf'] });
    expect(z.readAsText('presse/PA-2026-0042/mails/01-eingang.txt')).toContain('Cc: kollegin@kreisblatt.example');
    expect(z.readAsText('presse/PA-2026-0042/mails/01-eingang.txt')).toContain('Erwin Beispielmann');
    expect(z.readFile('presse/PA-2026-0042/anhaenge/01-skizze-unfallstelle.pdf')).toEqual(attachment);
    expect(JSON.parse(z.readAsText('auskunft.json')).hinweis).toContain('Art. 15 Abs. 4');
    const au = await one<any>(`SELECT details FROM audit_events WHERE action = 'privacy.export' ORDER BY id DESC LIMIT 1`);
    expect(au.details).toMatchObject({ presseanfragen: 1, dateien: 2 });
  });

  it('Empfangsprotokoll des Presse-Postfachs: finden und löschen', async () => {
    const l = await one<any>(`INSERT INTO press_mailbox_log (outcome, subject, from_address) VALUES ('ignored', 'Bewerbung als Pressesprecher', 'bewerber.zufall@example.net') RETURNING id`);
    const hit = (await search('bewerber.zufall')).find((h) => h.kind === 'press_mailbox_log');
    expect(hit).toMatchObject({ id: String(l!.id), actions: ['delete'], fields: { absender: 'bewerber.zufall@example.net' } });
    expect((await act('press_mailbox_log', 'kein-wert', 'delete')).status).toBe(400);
    expect((await act('press_mailbox_log', hit.id, 'delete')).status).toBe(200);
    expect(await one(`SELECT 1 FROM press_mailbox_log WHERE id = $1`, [l!.id])).toBeNull();
    expect(await one(`SELECT 1 FROM audit_events WHERE action = 'privacy.deleted' AND object_type = 'press_mailbox_log' AND object_id = $1`, [String(l!.id)])).not.toBeNull();
  });

  it('Versandprotokolle: Adressen ohne Kontakt finden und pseudonymisieren; Kontakt löschen erfasst auch frühere Adressen', async () => {
    const rel = await one<any>(`INSERT INTO press_releases (subject, status, sent_at) VALUES ('Bilanz Brandschutzwoche', 'sent', now()) RETURNING id`);
    await pool.query(`INSERT INTO press_release_recipients (release_id, email, name, status, error, sent_at) VALUES ($1, 'ehemals@lokalradio.example', 'Ole Ehemals', 'failed', '550 <ehemals@lokalradio.example> unbekannt', now())`, [rel!.id]);
    const hit = (await search('ehemals@lokalradio')).find((h) => h.kind === 'press_recipient');
    expect(hit).toMatchObject({ actions: ['pseudonymize'], fields: { email: 'ehemals@lokalradio.example', pressemitteilungen: 1, kontakt_im_verteiler: false } });
    expect(hit.fields.betreffe[0]).toContain('Bilanz Brandschutzwoche');
    expect((await act('press_recipient', hit.id, 'delete')).status).toBe(400);
    expect((await act('press_recipient', hit.id, 'pseudonymize')).status).toBe(200);
    const row = await one<any>(`SELECT email, name, error, status FROM press_release_recipients WHERE release_id = $1`, [rel!.id]);
    expect(row).toMatchObject({ name: '', error: '(entfernt)', status: 'failed' });
    expect(row.email).toMatch(/^gelöscht:/);
    expect((await search('ehemals@lokalradio')).some((h) => h.kind === 'press_recipient')).toBe(false);

    // Kontakt, dessen Adresse sich geändert hat: frühere Versandzeilen hängen nur noch über contact_id am Kontakt
    const c = await one<any>(`INSERT INTO press_contacts (name, email) VALUES ('Nina Neu', 'nina.neu@zeitung.example') RETURNING id`);
    await pool.query(`INSERT INTO press_release_recipients (release_id, contact_id, email, name, status) VALUES ($1, $2, 'nina.alt@zeitung.example', 'Nina Neu', 'sent')`, [rel!.id, c!.id]);
    const ch = (await search('Nina Neu')).find((h) => h.kind === 'press_contact');
    expect(ch.fields.pressemitteilungen).toBe(1);
    expect((await act('press_contact', c!.id, 'delete')).status).toBe(200);
    expect(await one(`SELECT 1 FROM press_release_recipients WHERE email ILIKE '%nina%' OR name ILIKE '%nina%'`)).toBeNull();
  });
});

describe('Datenschutzanfragen: Kalender, Einsatzliste, Benachrichtigungen, weitere Texte (#245)', () => {
  it('Kalender: eigene Termine löschbar, eingelesene nur Auskunft mit Hinweis auf die Quelle', async () => {
    const own = await one<any>(`INSERT INTO calendar_events (title, description, starts_at, ends_at) VALUES ('Jubiläum', 'Ehrung für Hans Testmann', now(), now() + interval '1 hour') RETURNING id`);
    const src = await one<any>(`INSERT INTO calendar_sources (name, url_secret_id, url_host) VALUES ('Kreis', gen_random_uuid(), 'kalender.example') RETURNING id`);
    const ext = await one<any>(`INSERT INTO calendar_events (title, location, starts_at, ends_at, source, source_id, uid) VALUES ('Lehrgang', 'bei Familie Testmann', now(), now() + interval '1 hour', 'ical', $1, 'x1') RETURNING id`, [src!.id]);
    const hits = (await search('Testmann')).filter((h) => h.kind === 'calendar_event');
    expect(hits.find((h) => h.id === own!.id)).toMatchObject({ actions: ['delete'], fields: { art: 'eigener Termin' } });
    expect(hits.find((h) => h.id === ext!.id)).toMatchObject({ actions: [], fields: { art: 'eingelesen aus „Kreis“' } });
    expect((await act('calendar_event', ext!.id, 'delete')).status).toBe(409);
    expect((await act('calendar_event', own!.id, 'delete')).status).toBe(200);
    expect(await one(`SELECT 1 FROM calendar_events WHERE id = $1`, [own!.id])).toBeNull();
  });

  it('Einsatzliste: Einträge und Kopien in Aufträgen an die Website, die noch unterwegs sind', async () => {
    const site = await one<any>(`INSERT INTO wp_sites (name) VALUES ('Website') RETURNING id`);
    const e = await one<any>(`INSERT INTO incident_entries (title, report, alarm_at, content_hash) VALUES ('Brand Scheune', 'Bewohnerin Frieda Altfassung gerettet', now(), 'h1') RETURNING id`);
    const snapshot = (text: string) => JSON.stringify({ id: e!.id, revision: 1, title: 'Brand Scheune', report: text, media_ids: [] });
    const job = await one<any>(`INSERT INTO incident_jobs (entry_id, site_id, action, revision, payload, status) VALUES ($1, $2, 'upsert', 1, $3, 'queued') RETURNING id`, [e!.id, site!.id, snapshot('Bewohnerin Frieda Altfassung gerettet')]);
    let hit = (await search('Frieda Altfassung')).find((h) => h.kind === 'incident_entry');
    expect(hit).toMatchObject({ id: e!.id, actions: [], link: '/einsatzliste' });
    expect(hit.fields.fundstellen).toEqual(['aktuelle Fassung 1', 'Auftrag an die Website (Kopie einer Fassung bzw. Fehlermeldung)']);
    // Text im Eintrag korrigiert – die alte Fassung steht nur noch im Auftrag, der unterwegs ist
    await pool.query(`UPDATE incident_entries SET report = 'Eine Person gerettet', revision = 2 WHERE id = $1`, [e!.id]);
    hit = (await search('Frieda Altfassung')).find((h) => h.kind === 'incident_entry');
    expect(hit.fields.fundstellen).toEqual(['Auftrag an die Website (Kopie einer Fassung bzw. Fehlermeldung)']);
    // Abgeschlossen: die Kopie fällt weg (#242) – kein Treffer mehr
    await pool.query(`UPDATE incident_jobs SET status = 'done' WHERE id = $1`, [job!.id]);
    expect((await search('Frieda Altfassung')).some((h) => h.kind === 'incident_entry')).toBe(false);
  });

  it('Benachrichtigungen, Konto-Zubehör, Sicherheitsereignisse per IP und weitere Texte', async () => {
    const n = await one<any>(`INSERT INTO notifications (kind, title, body, category) VALUES ('info', 'Neue Presseanfrage: Unfall von Karl Klarname', '', 'press') RETURNING id`);
    const nh = (await search('Karl Klarname')).find((h) => h.kind === 'notification');
    expect(nh).toMatchObject({ id: String(n!.id), actions: ['delete'] });
    expect((await act('notification', String(n!.id), 'delete')).status).toBe(200);
    expect(await one(`SELECT 1 FROM notifications WHERE id = $1`, [n!.id])).toBeNull();

    await pool.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label) VALUES ($1, 'https://push.example/x', 'k', 'a', 'Firefox auf Android')`, [adminId]);
    const uh = (await search('Dana Datenschutz')).find((h) => h.kind === 'user');
    expect(uh.fields.push_geraete).toEqual(['Firefox auf Android']);
    expect(uh.fields.aktive_sitzungen).toBeGreaterThan(0);

    await pool.query(`INSERT INTO public_security_events (event, ip_hash) VALUES ('password_failed', $1)`, [ipHash('203.0.113.77')]);
    expect((await search('203.0.113.77')).find((h) => h.kind === 'security_event')).toMatchObject({ fields: { ereignis: 'Falsches Passwort' } });

    await pool.query(`INSERT INTO post_templates (name, kind, body) VALUES ('Standardtext', 'news', 'Pressesprecher Paul Vorlagenmann')`);
    expect((await search('Vorlagenmann')).find((h) => h.kind === 'text')).toMatchObject({ title: 'Beitragsvorlage: Standardtext', link: '/beitragsvorlagen', actions: [] });
  });

  it('Beiträge: auch frühere Fassungen werden gefunden', async () => {
    const p = await admin.post('/posts', { kind: 'news', title: 'Übung am Wochenende' });
    expect(p.status).toBe(200);
    expect((await admin.put(`/posts/${p.json.id}/revision`, { baseRevision: 1, title: 'Übung am Wochenende', body: 'Mit Kamerad Fritz Frühfassung' })).status).toBe(200);
    expect((await admin.put(`/posts/${p.json.id}/revision`, { baseRevision: 2, title: 'Übung am Wochenende', body: 'Ohne Namen' })).status).toBe(200);
    const hit = (await search('Fritz Frühfassung')).find((h) => h.kind === 'post');
    expect(hit).toMatchObject({ id: p.json.id, fields: { fundstellen: ['frühere Fassung'] } });
  });
});
