import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { many, one, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { setSettings } from '../src/lib/settings.js';
import { refreshFeed } from '../src/routes/rss.js';
import { refreshWarnfeed } from '../src/connections/warnfeed.js';
import { Receipt } from '../src/connections/receipts.js';

/**
 * Fremdtext aus RSS- und Warnquellen (#249, Nachtrag zu #237) gegen eine echte PostgreSQL-Datenbank
 * (TEST_DATABASE_URL): NUL und andere Steuerzeichen entfallen, und ein einzelner Eintrag, der sich nicht abrufen oder
 * speichern lässt, verhindert nie den ganzen Abruf. Die Datenbank wird zu Beginn geleert.
 */
let server: http.Server;
let base = '';
let rss = '';
let cap = '';
const nina: Record<string, { status: number; body: string }> = {};

const rssDoc = (items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Wehr\u0000-News</title><link>https://news.example.org/</link>${items.join('')}</channel></rss>`;
const item = (guid: string, title: string, desc = 'Text') => `<item><guid>${guid}</guid><title>${title}</title><link>https://news.example.org/${guid}</link><description>${desc}</description></item>`;
const alert = (identifier: string, headline: string, description = 'Fiktive Testmeldung') => ({
  identifier,
  sender: 'test@example.org',
  sent: '2026-11-17T10:00:00+01:00',
  status: 'Actual',
  msgType: 'Alert',
  scope: 'Public',
  info: [{ language: 'de-DE', category: ['Met'], event: 'STURM', severity: 'Moderate', urgency: 'Immediate', headline, description, area: [{ areaDesc: 'Gemeinde Musterstadt', geocode: [{ valueName: 'ARS', value: '099990001001' }] }] }],
});

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await setSettings({ 'security.allowed_private_hosts': ['127.0.0.1'] } as any);
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/rss') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rss);
    }
    if (url === '/cap.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(cap);
    }
    const n = nina[url];
    if (n) {
      res.writeHead(n.status, { 'content-type': 'application/json' });
      return res.end(n.body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server?.close();
  await pool.end();
});

describe('RSS-Quellen: Fremdtext und einzelne fehlerhafte Einträge (#249)', () => {
  let feedId: string;
  const feed = async () => (await one<any>('SELECT * FROM rss_feeds WHERE id = $1', [feedId]))!;
  const titles = async () => (await many<any>('SELECT title FROM rss_items WHERE feed_id = $1 ORDER BY title', [feedId])).map((r) => r.title);

  it('NUL und Steuerzeichen in Titel, Beschreibung und Kennung entfallen', async () => {
    feedId = (await one<any>(`INSERT INTO rss_feeds (url, title) VALUES ($1, 'Testquelle') RETURNING id`, [`${base}/rss`]))!.id;
    rss = rssDoc([item('a', 'Erste'), item('n\u0000ul', 'Funk\u0000übung\u001b', 'Mit\u0000 NUL'), item('b', 'Letzte')]);
    await refreshFeed(await feed());
    expect(await titles()).toEqual(['Erste', 'Funkübung', 'Letzte']);
    expect((await one<any>(`SELECT summary FROM rss_items WHERE feed_id = $1 AND title = 'Funkübung'`, [feedId]))!.summary).toBe('Mit NUL');
    expect(await feed()).toMatchObject({ last_error: null, last_warning: null });
  });

  it('ein Eintrag, der sich nicht speichern lässt, wird übersprungen – die übrigen kommen an, die Quelle bleibt in Ordnung', async () => {
    // Speicherfehler eines einzelnen Eintrags, nachgestellt über eine Prüfregel der Datenbank
    await pool.query(`ALTER TABLE rss_items ADD CONSTRAINT test_kaputt CHECK (title NOT LIKE 'Kaputt%')`);
    try {
      rss = rssDoc([item('c', 'Neu davor'), item('k', 'Kaputt'), item('d', 'Neu danach')]);
      await refreshFeed(await feed());
      expect(await titles()).toEqual(['Erste', 'Funkübung', 'Letzte', 'Neu danach', 'Neu davor']);
      const f = await feed();
      expect(f.last_error).toBeNull();
      expect(f.last_success_at).not.toBeNull();
      expect(f.last_warning).toMatch(/^1 Eintrag\/Einträge konnten nicht übernommen werden und wurden übersprungen: „Kaputt“\. Details im Systemprotokoll\.$/);
    } finally {
      await pool.query('ALTER TABLE rss_items DROP CONSTRAINT test_kaputt');
    }
    // nächster Abruf: der Eintrag kommt nach, der Hinweis verschwindet
    await refreshFeed(await feed());
    expect(await titles()).toContain('Kaputt');
    expect((await feed()).last_warning).toBeNull();
  });
});

describe('Warnquellen: Fremdtext und einzelne fehlerhafte Meldungen (#249)', () => {
  const conn = async (name: string, config: object) =>
    (await one<any>(`INSERT INTO connections (kind, name, status, config, private_target, private_approved_at) VALUES ('warnfeed', $1, 'active', $2, '127.0.0.1', now()) RETURNING *`, [name, JSON.stringify(config)]))!;
  const lastReceipt = async (connectionId: string) => {
    const r = (await one<any>(`SELECT * FROM connection_receipts WHERE connection_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [connectionId]))!;
    const items = await many<any>(`SELECT decision, reason, info FROM connection_receipt_items WHERE receipt_id = $1 ORDER BY position`, [r.id]);
    return { ...r, items };
  };
  let capConn: any;

  it('CAP mit NUL in Kennung und Texten: gespeichert und protokolliert, ohne Steuerzeichen', async () => {
    capConn = await conn('NUL-Feed', { format: 'cap', url: `${base}/cap.json` });
    cap = JSON.stringify([alert('NUL\u0000-1', 'Sturm\u0000warnung', 'Text\u0000 mit NUL'), alert('NORMAL-2', 'Glätte')]);
    expect(await refreshWarnfeed(capConn, { trigger: 'manual' })).toEqual({ total: 2, added: 2 });
    const rows = await many<any>(`SELECT identifier, headline, description FROM official_warnings WHERE connection_id = $1 ORDER BY identifier`, [capConn.id]);
    expect(rows).toEqual([
      { identifier: 'NORMAL-2', headline: 'Glätte', description: 'Fiktive Testmeldung' },
      { identifier: 'NUL-1', headline: 'Sturmwarnung', description: 'Text mit NUL' },
    ]);
    const rec = await lastReceipt(capConn.id);
    expect(rec).toMatchObject({ ok: true, received: 2, accepted: 2, errors: 0 });
    expect(rec.items.map((i: any) => i.info.identifier).sort()).toEqual(['NORMAL-2', 'NUL-1']);
  });

  it('scheitert das gemeinsame „gesehen“ an einer Meldung, laufen die übrigen einzeln weiter', async () => {
    await pool.query(
      `INSERT INTO official_warnings (connection_id, identifier, msg_type, headline, effective_at, received_at, last_seen_at, in_area) VALUES ($1, 'KAPUTT-3', 'Alert', 'Altbestand (fiktiv)', now(), now(), NULL, true)`,
      [capConn.id],
    );
    await pool.query(`UPDATE official_warnings SET last_seen_at = now() - interval '1 day' WHERE connection_id = $1 AND identifier = 'NORMAL-2'`, [capConn.id]);
    await pool.query(`ALTER TABLE official_warnings ADD CONSTRAINT test_kaputt CHECK (identifier <> 'KAPUTT-3' OR last_seen_at IS NULL)`);
    try {
      cap = JSON.stringify([alert('NORMAL-2', 'Glätte'), alert('KAPUTT-3', 'Altbestand'), alert('NEU-4', 'Gewitter')]);
      expect(await refreshWarnfeed(capConn)).toEqual({ total: 3, added: 1 });
    } finally {
      await pool.query('ALTER TABLE official_warnings DROP CONSTRAINT test_kaputt');
    }
    const seen = (await one<any>(`SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM official_warnings WHERE connection_id = $1 AND identifier = 'NORMAL-2'`, [capConn.id]))!;
    expect(seen.fresh).toBe(true);
    expect(await one(`SELECT 1 FROM official_warnings WHERE connection_id = $1 AND identifier = 'NEU-4'`, [capConn.id])).not.toBeNull();
    expect(await lastReceipt(capConn.id)).toMatchObject({ ok: true, received: 3, accepted: 1 });
  });

  it('NINA: eine nicht abrufbare Meldung steht als Fehler im Protokoll, die übrigen werden übernommen', async () => {
    const c = await conn('NINA-Test', { format: 'nina', baseUrl: `${base}/nina`, ars: '099990000000' });
    nina['/nina/dashboard/099990000000.json'] = { status: 200, body: JSON.stringify([{ payload: { id: 'test.kaputt' } }, { payload: { id: 'test.gut' } }]) };
    nina['/nina/warnings/test.kaputt.json'] = { status: 500, body: '{}' };
    nina['/nina/warnings/test.gut.json'] = { status: 200, body: JSON.stringify(alert('NINA-GUT', 'Hochwasser')) };
    expect(await refreshWarnfeed(c)).toEqual({ total: 1, added: 1 });
    expect(await one(`SELECT 1 FROM official_warnings WHERE connection_id = $1 AND identifier = 'NINA-GUT'`, [c.id])).not.toBeNull();
    const rec = await lastReceipt(c.id);
    expect(rec).toMatchObject({ ok: true, received: 2, accepted: 1, errors: 1 });
    expect(rec.items.find((i: any) => i.decision === 'error').reason).toMatch(/Meldung test\.kaputt nicht abrufbar oder nicht lesbar: HTTP 500/);
  });

  it('Empfangsprotokoll: NUL in Grund oder Angaben kostet nie den ganzen Eintrag', async () => {
    const rec = new Receipt(capConn.id, 'manual');
    rec.add({ decision: 'error', reason: 'Grund\u0000 mit NUL', info: { headline: 'A\u0000B', liste: ['x\u0000y'], ['k\u0000ey']: 1 } });
    const id = await rec.finish({ ok: true });
    expect(id).not.toBeNull();
    const row = (await one<any>(`SELECT reason, info FROM connection_receipt_items WHERE receipt_id = $1`, [id]))!;
    expect(row).toEqual({ reason: 'Grund mit NUL', info: { headline: 'AB', liste: ['xy'], key: 1 } });
  });
});
