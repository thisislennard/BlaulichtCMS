import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { checkTemplate, render, renderValue, setTemplateTimeZone, testCondition, testConditions } from '../src/lib/template.js';
import { parseIcs, zonedToUtc } from '../src/lib/ics.js';
import { MASK, maskValue, preview } from '../src/lib/mask.js';
import { isPrivateAddress, hostMatches, httpRequest } from '../src/lib/http.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { totpAt, verifyTotp, base32Encode } from '../src/auth/totp.js';
import { canonicalString, signWordPress } from '../src/connectors/wordpress.js';
import { normalizeAlarm } from '../src/connectors/alamos.js';
import { topicAllowed, topicMatches } from '../src/connectors/messaging.js';
import { validateGraph, topoOrder } from '../src/engine/graph.js';
import { compareVersions } from '../src/updates/releases.js';
import { verifyUpdateSignature, UpdateSignatureError } from '../src/updates/signing.js';
import { permissionsFor, matrix } from '../src/auth/permissions.js';
import { nextScheduleRun } from '../src/engine/triggers.js';
import type { Graph } from '../src/engine/types.js';

describe('Ausdruckssprache', () => {
  const ctx = { webhook: { body: { titel: 'Brand', liste: ['a', 'b'], n: '3,5', html: '<b>x</b>' } }, alamos: { stichwort: 'B3' } };
  it('setzt Werte ein und wendet Filter an', () => {
    expect(render('Einsatz {{ alamos.stichwort }} – {{ webhook.body.titel | upper }}', ctx)).toBe('Einsatz B3 – BRAND');
    expect(render('{{ webhook.body.fehlt | default:"leer" }}', ctx)).toBe('leer');
    expect(render('{{ webhook.body.liste | join:" / " }}', ctx)).toBe('a / b');
    expect(render('{{ webhook.body.titel | truncate:3 }}', ctx)).toBe('Br…');
    expect(renderValue('{{ webhook.body.liste }}', ctx)).toEqual(['a', 'b']);
    expect(renderValue('{{ webhook.body.n | number }}', ctx)).toBe(3.5);
  });
  it('maskiert kontextgerecht', () => {
    expect(render('<p>{{ webhook.body.html }}</p>', ctx, 'html')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
    expect(render('{"t":"{{ webhook.body.html }}"}', { webhook: { body: { html: 'a"b\n' } } }, 'json')).toBe('{"t":"a\\"b\\n"}');
  });
  it('erlaubt keinen Zugriff auf Prototypen', () => {
    expect(render('{{ webhook.constructor }}', ctx)).toBe('');
    expect(render('{{ webhook.__proto__ }}', ctx)).toBe('');
  });
  it('meldet Syntaxfehler verständlich', () => {
    expect(checkTemplate('{{ a.b | gibtsnicht }}')).toMatch(/Unbekannter Filter/);
    expect(checkTemplate('{{ a.b ')).toMatch(/nicht geschlossen/i);
    expect(checkTemplate('Hallo {{ a.b }}')).toBeNull();
  });
  it('formatiert Daten in der Instanz-Zeitzone', () => {
    setTemplateTimeZone('Europe/Berlin');
    expect(render('{{ t | date:"dd.MM.yyyy HH:mm" }}', { t: '2026-10-29T16:08:00Z' })).toBe('29.10.2026 17:08');
    expect(render('{{ t | date:"HH:mm" }}', { t: '2026-07-01T16:08:00Z' })).toBe('18:08');
  });
  it('wertet Bedingungen aus', () => {
    expect(testCondition({ left: '{{ alamos.stichwort }}', op: 'starts_with', right: 'b' }, ctx)).toBe(true);
    expect(testCondition({ left: '{{ alamos.stichwort }}', op: 'in', right: 'B1, B2' }, ctx)).toBe(false);
    expect(testCondition({ left: '{{ webhook.body.n }}', op: 'gt', right: '3' }, ctx)).toBe(true);
    expect(testCondition({ left: '{{ webhook.body.fehlt }}', op: 'empty' }, ctx)).toBe(true);
    expect(testConditions([{ left: 'a', op: 'eq', right: 'b' }, { left: 'a', op: 'eq', right: 'a' }], 'any', {})).toBe(true);
    expect(testConditions([{ left: 'a', op: 'eq', right: 'b' }, { left: 'a', op: 'eq', right: 'a' }], 'all', {})).toBe(false);
  });
});

describe('iCal-Leser', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:einmal@fe2',
    'DTSTART;TZID=Europe/Berlin:20261102T183000',
    'DTEND;TZID=Europe/Berlin:20261102T203000',
    'SUMMARY:Übungsdienst\\, Atemschutz',
    'DESCRIPTION:Zeile 1\\nZeile 2',
    'LOCATION:Gerätehaus',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:serie@fe2',
    'DTSTART;TZID=Europe/Berlin:20261019T190000',
    'DURATION:PT2H',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'EXDATE;TZID=Europe/Berlin:20261102T190000',
    'SUMMARY:Wochendienst',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:ganz@fe2',
    'DTSTART;VALUE=DATE:20261107',
    'SUMMARY:Tag der offenen Tür',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = parseIcs(ics, { defaultTz: 'Europe/Berlin', windowStart: Date.UTC(2026, 9, 1), windowEnd: Date.UTC(2026, 11, 31) });
  it('liest Zeitzonen, Escapes und Ganztagestermine', () => {
    const e = events.find((x) => x.uid === 'einmal@fe2')!;
    expect(e.start).toBe('2026-11-02T17:30:00.000Z'); // Winterzeit UTC+1
    expect(e.title).toBe('Übungsdienst, Atemschutz');
    expect(e.description).toBe('Zeile 1\nZeile 2');
    const g = events.find((x) => x.uid === 'ganz@fe2')!;
    expect(g.all_day).toBe(true);
  });
  it('erweitert Serien über den Sommerzeitwechsel und beachtet EXDATE', () => {
    const s = events.filter((x) => x.uid === 'serie@fe2').map((x) => x.start);
    // 19.10. Sommerzeit (17 Uhr UTC), 26.10. Winterzeit (18 Uhr UTC), 02.11. ausgenommen, 09.11.
    expect(s).toEqual(['2026-10-19T17:00:00.000Z', '2026-10-26T18:00:00.000Z', '2026-11-09T18:00:00.000Z']);
    expect(events.find((x) => x.uid === 'serie@fe2')!.end).toBe('2026-10-19T19:00:00.000Z');
  });
  it('rechnet Wandzeit korrekt in UTC um', () => {
    expect(new Date(zonedToUtc(2026, 3, 29, 3, 0, 0, 'Europe/Berlin')).toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });
});

describe('Maskierung', () => {
  it('ersetzt sensible Felder und bekannte Geheimnisse', () => {
    const v = maskValue({ password: 'x', nested: { apiKey: 'abc', ok: 'Bearer abcdefghijklmnop' }, text: 'mein geheim-123 steht hier' }, ['geheim-123']) as any;
    expect(v.password).toBe(MASK);
    expect(v.nested.apiKey).toBe(MASK);
    expect(v.nested.ok).toBe(`Bearer ${MASK}`);
    expect(v.text).toBe(`mein ${MASK} steht hier`);
  });
  it('kürzt große Vorschauen', () => {
    const big = { a: 'x'.repeat(5000), list: Array.from({ length: 80 }, (_, i) => i) } as any;
    const p = preview(big) as any;
    expect(p.a.length).toBeLessThan(2100);
    expect(p.list).toHaveLength(51);
  });
});

describe('SSRF-Schutz', () => {
  it('erkennt interne Adressen (IPv4/IPv6, gemappt)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.4', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('blockiert Anfragen an interne Ziele ohne Freigabe', async () => {
    await expect(httpRequest({ method: 'GET', url: 'http://127.0.0.1:1/', timeoutMs: 2000 })).rejects.toThrow(/interne Adresse/);
    await expect(httpRequest({ method: 'GET', url: 'http://user:pw@example.org/' })).rejects.toThrow(/Zugangsdaten in der URL/);
    await expect(httpRequest({ method: 'GET', url: 'file:///etc/passwd' })).rejects.toThrow(/nicht erlaubt/);
  });
  it('vergleicht Host-Muster', () => {
    expect(hostMatches('api.beispiel.de', ['*.beispiel.de'])).toBe(true);
    expect(hostMatches('beispiel.de.evil.org', ['*.beispiel.de'])).toBe(false);
  });
});

describe('Kryptografie', () => {
  it('verschlüsselt mit Zweckbindung', () => {
    const c = encrypt('geheim', 'secret:connection:1:1');
    expect(decrypt(c, 'secret:connection:1:1')).toBe('geheim');
    expect(() => decrypt(c, 'secret:connection:2:1')).toThrow();
  });
  it('TOTP entspricht RFC 6238', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    const now = Date.now();
    expect(verifyTotp(secret, totpAt(secret, Math.floor(now / 30000)), now)).not.toBeNull();
    expect(verifyTotp(secret, '000000', now)).toBeNull();
  });
});

describe('WordPress-Signatur', () => {
  it('stimmt mit dem Testvektor des Plugins überein', () => {
    const route = '/lifelink/v1/banners/11111111-2222-3333-4444-555555555555';
    expect(canonicalString('PUT', route, 1767225600, 'abcdefghijklmnop', '{"revision":1}')).toBe(
      `PUT\n${route}\n1767225600\nabcdefghijklmnop\nd8560b7658c792bdded69837b055e2ed54708be6123b7bb4cc9fadf261ea091f`,
    );
    expect(signWordPress('test-secret-123', 'PUT', route, 1767225600, 'abcdefghijklmnop', '{"revision":1}')).toBe(
      'v1=73759e973f4831f4aec90b172e6da7669829bf12d5ec87feec84d42b21decc76',
    );
  });
});

describe('Alamos FE2', () => {
  it('vereinheitlicht Einsatzdaten verschiedener Feldnamen', () => {
    const a = normalizeAlarm({ Einsatznummer: 'E-1', Stichwort: 'B3', strasse: 'Hauptstr.', hausnummer: '12', plz: '65835', ort: 'Musterstadt', einheiten: 'HLF 1; DLK' });
    expect(a.einsatz_id).toBe('E-1');
    expect(a.stichwort).toBe('B3');
    expect(a.ort).toBe('Hauptstr. 12, 65835 Musterstadt');
    expect(a.stadt).toBe('Musterstadt');
    expect(a.einheiten).toEqual(['HLF 1', 'DLK']);
    const b = normalizeAlarm({ data: { keyword: 'TH1', units: [{ name: 'RW' }] } });
    expect(b.stichwort).toBe('TH1');
    expect(b.einheiten).toEqual(['RW']);
  });
});

describe('MQTT-Topics', () => {
  it('prüft Filter und Freigabeliste', () => {
    expect(topicMatches('feuerwehr/+/status', 'feuerwehr/hlf1/status')).toBe(true);
    expect(topicMatches('feuerwehr/#', 'feuerwehr/a/b')).toBe(true);
    expect(topicMatches('feuerwehr/+', 'feuerwehr/a/b')).toBe(false);
    expect(topicAllowed('feuerwehr/status/hlf1', ['feuerwehr/status/#'])).toBe(true);
    expect(topicAllowed('feuerwehr/status/#', ['feuerwehr/status/#'])).toBe(true);
    expect(topicAllowed('#', ['feuerwehr/status/#'])).toBe(false);
    expect(topicAllowed('andere/x', ['feuerwehr/#'])).toBe(false);
  });
});

describe('Graph-Validierung', () => {
  const node = (id: string, type: string, key: string, config: Record<string, any> = {}) => ({ id, type, key, name: key, position: { x: 0, y: 0 }, config });
  const conns = { connections: new Map() };
  it('verlangt genau einen Trigger und Verbindung zum Trigger', () => {
    const g: Graph = { nodes: [node('a', 'data.text', 'text', { template: 'x' })], edges: [] };
    const issues = validateGraph(g, conns).map((i) => i.message).join(' | ');
    expect(issues).toMatch(/genau einen Trigger/);
  });
  it('erkennt Schleifen und Variablen auf spätere Bausteine', () => {
    const g: Graph = {
      nodes: [node('t', 'trigger.manual', 'start'), node('a', 'data.text', 'a', { template: '{{ b.text }}' }), node('b', 'data.text', 'b', { template: 'x' })],
      edges: [
        { id: '1', source: 't', sourcePort: 'out', target: 'a' },
        { id: '2', source: 'a', sourcePort: 'out', target: 'b' },
      ],
    };
    expect(validateGraph(g, conns).some((i) => /verweist auf keinen vorherigen/.test(i.message))).toBe(true);
    const cyc: Graph = { ...g, edges: [...g.edges, { id: '3', source: 'b', sourcePort: 'out', target: 'a' }] };
    expect(topoOrder(cyc)).toBeNull();
    expect(validateGraph(cyc, conns).some((i) => /Schleife/.test(i.message))).toBe(true);
  });
  it('lehnt Variablen als E-Mail-Empfänger ab', () => {
    const g: Graph = {
      nodes: [node('t', 'trigger.webhook', 'webhook'), { ...node('m', 'email.send', 'mail', { to: ['{{ webhook.body.mail }}'], subject: 'x', text: 'y' }), connectionId: null }],
      edges: [{ id: '1', source: 't', sourcePort: 'out', target: 'm' }],
    };
    const msgs = validateGraph(g, conns).map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/Variablen sind bei Empfängern nicht erlaubt/);
    expect(msgs).toMatch(/Verbindung auswählen/);
  });
});

describe('Zeitpläne', () => {
  it('berücksichtigt Zeitzone und Sommerzeit', () => {
    const next = nextScheduleRun({ mode: 'daily', time: '07:00' }, 'Europe/Berlin', new Date('2026-10-24T12:00:00Z'));
    expect(next?.toISOString()).toBe('2026-10-25T06:00:00.000Z'); // 25.10. ist Winterzeit
    const w = nextScheduleRun({ mode: 'weekly', time: '19:30', weekdays: ['1'] }, 'Europe/Berlin', new Date('2026-10-29T12:00:00Z'));
    expect(w?.toISOString()).toBe('2026-11-02T18:30:00.000Z');
    const i = nextScheduleRun({ mode: 'interval', intervalMinutes: 15 }, 'Europe/Berlin', new Date('2026-10-29T12:07:00Z'));
    expect(i?.toISOString()).toBe('2026-10-29T12:15:00.000Z');
  });
});

describe('Rechte', () => {
  it('Standard verweigern, Rollen kombinierbar', () => {
    expect(permissionsFor([]).size).toBe(0);
    const p = permissionsFor(['wp_editor', 'operator']);
    expect(p.has('wordpress.publish')).toBe(true);
    expect(p.has('workflow.edit')).toBe(false);
    expect(matrix().find((m) => m.module === 'users')!.cells.find((c) => c.role === 'platform_admin')!.level).toBe('full');
  });
});

describe('Update-Signatur', () => {
  it('akzeptiert nur korrekt signierte Pakete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llsig-'));
    const keyFile = path.join(dir, 'k.pem');
    const pubFile = path.join(dir, 'k.pub');
    const tool = path.resolve(import.meta.dirname, '..', '..', 'tools', 'update-signing.mjs');
    const out = execFileSync(process.execPath, [tool, 'keygen', '--out', keyFile], { encoding: 'utf8' });
    const pub = /Öffentlicher Schlüssel: (\S+)/.exec(out)![1];
    fs.writeFileSync(pubFile, `# test\n${pub}\n`);
    const zip = path.join(dir, 'lifelink-update-v9.9.9.zip');
    fs.writeFileSync(zip, crypto.randomBytes(2048));
    execFileSync(process.execPath, [tool, 'sign', zip, '--key', keyFile, '--pub', pubFile]);
    const sig = fs.readFileSync(`${zip}.sig`);
    expect(verifyUpdateSignature(zip, sig, pubFile)).toMatch(/^[a-f0-9]{64}$/);
    fs.appendFileSync(zip, 'x');
    expect(() => verifyUpdateSignature(zip, sig, pubFile)).toThrow(UpdateSignatureError);
    expect(() => verifyUpdateSignature(zip, null, pubFile)).toThrow(/fehlt/);
    expect(() => verifyUpdateSignature(zip, sig, path.join(dir, 'gibtsnicht.pub'))).toThrow(/kein öffentlicher Signaturschlüssel/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('vergleicht Versionen numerisch', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.0.0', '2.0')).toBe(0);
    expect(compareVersions('2.0.1', '2.1.0')).toBeLessThan(0);
  });
});

describe('Variablen als Filterargument', () => {
  it('erlaubt default mit anderem Feld', () => {
    expect(render('{{ a.leer | default:a.stadt }}', { a: { leer: '', stadt: 'Musterstadt' } })).toBe('Musterstadt');
    expect(render('{{ a.x | default:"fest" }}', { a: {} })).toBe('fest');
  });
});
