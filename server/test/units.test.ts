import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, SETTING_RANGES } from '../src/lib/settings.js';
import { describe, expect, it } from 'vitest';
import { MASK, maskValue, preview } from '../src/lib/mask.js';
import { isPrivateAddress, hostMatches, httpRequest } from '../src/lib/http.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { totpAt, verifyTotp, base32Encode } from '../src/auth/totp.js';
import { permissionsFor, matrix } from '../src/auth/permissions.js';
import { revisionHash } from '../src/routes/posts.js';
import { normalizePublicUrl } from '../src/lib/urls.js';
import { fileSlug, publicFileName } from '../src/media/names.js';

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
    await expect(httpRequest({ method: 'GET', url: 'http://127.0.0.1:1/', timeoutMs: 2000 })).rejects.toThrow(/internes Netz und ist gesperrt/);
    // Keine aufgelöste IP in der Meldung (#148)
    const err = await httpRequest({ method: 'GET', url: 'http://localhost:1/', timeoutMs: 2000 }).catch((e) => e);
    expect(String(err.message)).toMatch(/„localhost“ zeigt auf ein internes Netz/);
    expect(String(err.message)).not.toMatch(/127\.0\.0\.1|::1/);
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

describe('Rechte', () => {
  it('Standard verweigern, Rollen kombinierbar', () => {
    expect(permissionsFor([]).size).toBe(0);
    const p = permissionsFor(['editor', 'publisher']);
    expect(p.has('post.edit')).toBe(true);
    expect(p.has('post.publish')).toBe(true);
    expect(p.has('post.approve')).toBe(false);
    expect(p.has('user.manage')).toBe(false);
    expect(matrix().find((m) => m.module === 'users')!.cells.find((c) => c.role === 'platform_admin')!.level).toBe('full');
  });
  it('trennt Warnentwurf, Warnfreigabe und Versand', () => {
    expect(permissionsFor(['warning_author']).has('warning.approve')).toBe(false);
    expect(permissionsFor(['warning_approver']).has('warning.send')).toBe(false);
    expect(permissionsFor(['warning_sender']).has('warning.draft')).toBe(false);
  });
});

describe('Fassungen', () => {
  const base = { title: 'Titel', body: 'Text', excerpt: '', media_ids: ['a', 'b'], cover_id: null, site_id: null };
  it('Prüfsumme ändert sich bei Text, Medien, Reihenfolge und Zielkanal', () => {
    const h = revisionHash(base);
    expect(revisionHash({ ...base })).toBe(h);
    expect(revisionHash({ ...base, body: 'Text!' })).not.toBe(h);
    expect(revisionHash({ ...base, media_ids: ['b', 'a'] })).not.toBe(h);
    expect(revisionHash({ ...base, site_id: '1' })).not.toBe(h);
  });
});

describe('Öffentliche Adresse', () => {
  it('vereinheitlicht und prüft die Basisadresse', () => {
    expect(normalizePublicUrl('https://blaulichtcms.example.org/')).toBe('https://blaulichtcms.example.org');
    expect(normalizePublicUrl('https://example.org/blaulichtcms/')).toBe('https://example.org/blaulichtcms');
    expect(() => normalizePublicUrl('ftp://example.org')).toThrow();
    expect(() => normalizePublicUrl('https://u:p@example.org')).toThrow();
    expect(() => normalizePublicUrl('kein link')).toThrow();
  });
});

describe('FE2-Eingang: Zuordnung', () => {
  it('liest das Standardformat (einsatz.*), Einheiten als Namen oder Objekte, nur über die Zuordnung', async () => {
    const { parseFe2 } = await import('../src/connections/fe2.js');
    const std = parseFe2({ einsatz: { id: 'E-1', stichwort: 'B2', ort: 'Musterstadt', einheiten: ['HLF 1', 'DLK'], alarmzeit: '14.11.2026 18:35' } }, {});
    expect(std.eventId).toBe('E-1');
    expect(std.fields).toMatchObject({ keyword: 'B2', municipality: 'Musterstadt', units: 'HLF 1, DLK', started_at: '2026-11-14T17:35:00.000Z' });
    const objs = parseFe2({ einsatz: { id: 'E-3', einheiten: [{ name: 'LF 10', address: '123' }, { address: 'ELW' }] } }, {});
    expect(objs.fields.units).toBe('LF 10, ELW');
    // Andere Feldnamen oder Hüllen greifen nur mit eingetragener Zuordnung
    const flat = { einsatznummer: 'E-2', stichwort: 'TH1' };
    expect(parseFe2(flat, {}).eventId).toBeNull();
    const mapped = parseFe2(flat, { event_id: 'einsatznummer', keyword: 'stichwort' });
    expect(mapped.eventId).toBe('E-2');
    expect(mapped.fields.keyword).toBe('TH1');
  });
  it('eingetragene Zuordnung hat Vorrang; Adresse, Meldungstext und Koordinaten bleiben draußen', async () => {
    const { parseFe2 } = await import('../src/connections/fe2.js');
    const p = parseFe2({ nr: 'X-9', stichwort: 'B3', ort: 'A', strasse: 'Hauptstraße', hausnummer: '1', meldung: 'Person vermisst', lat: 50.1, lng: 8.5, einsatz: { id: 'nicht-diese' } }, { event_id: 'nr', keyword: 'stichwort', municipality: 'ort' });
    expect(p.eventId).toBe('X-9');
    expect(JSON.stringify(p.fields)).not.toMatch(/Hauptstraße|vermisst|50\.1/);
  });
  it('normalisiert Alarmzeiten (Unix, ISO, deutsches Format inkl. Sommerzeit)', async () => {
    const { normalizeTime } = await import('../src/connections/fe2.js');
    expect(normalizeTime('1794679200')).toBe('2026-11-14T18:00:00.000Z');
    expect(normalizeTime('1794679200000')).toBe('2026-11-14T18:00:00.000Z');
    expect(normalizeTime('2026-07-01T10:00:00+02:00')).toBe('2026-07-01T08:00:00.000Z');
    expect(normalizeTime('01.07.2026 10:00')).toBe('2026-07-01T08:00:00.000Z');
    expect(normalizeTime('gleich')).toBe('gleich');
  });
});

describe('Meta Graph API', () => {
  it('nutzt v27.0 für Graph API, Instagram und OAuth-Dialog', async () => {
    const { META_API_VERSION, FB_GRAPH, FB_DIALOG, IG_GRAPH } = await import('../src/connections/meta.js');
    expect(META_API_VERSION).toBe('v27.0');
    if (!process.env.BLAULICHTCMS_META_GRAPH_URL) expect(FB_GRAPH()).toBe('https://graph.facebook.com/v27.0');
    if (!process.env.BLAULICHTCMS_META_DIALOG_URL) expect(FB_DIALOG()).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    if (!process.env.BLAULICHTCMS_IG_GRAPH_URL) expect(IG_GRAPH()).toBe('https://graph.instagram.com/v27.0');
  });
});

describe('Feuersoftware Connect: Felder, Filter, Pausen', () => {
  it('Feldnamen in PascalCase und camelCase; nur Ort ohne Straße, keine Personen- oder Sachverhaltsdaten', async () => {
    const { normalizeKeys, operationFields, locationArea } = await import('../src/connections/feuersoftware.js');
    const op = normalizeKeys({ id: 'A1', keyword: 'B3', category: 'Brand', start: '2026-07-01T08:00:00Z', facts: 'Person verletzt', reporter: { name: 'Erika', phoneNumber: '0123' }, address: { street: 'Hauptstraße', houseNumber: '1', city: 'Musterstadt', cityWithDistrict: 'Musterstadt - Nord' } });
    expect(op.Address.CityWithDistrict).toBe('Musterstadt - Nord');
    expect(locationArea(op)).toBe('Musterstadt - Nord');
    expect(locationArea({ Address: { City: 'Musterstadt', Street: 'X' } })).toBe('Musterstadt');
    const f = operationFields(op);
    expect(f).toEqual({ eventId: 'A1', closed: false, fields: { keyword: 'B3', category: 'Brand', municipality: 'Musterstadt - Nord', started_at: '2026-07-01T08:00:00.000Z' } });
    expect(operationFields({ Id: 'x'.repeat(65) }).eventId).toBeNull();
    expect(operationFields({ Id: 'A2', End: '2026-07-01T09:00:00Z' })).toMatchObject({ closed: true, fields: { status: 'beendet' } });
  });
  it('RIC als ganzes Wort oder gleich (ohne Leerzeichen bei Zahlen-RICs), Stichwort als Teilwort', async () => {
    const { ricHit, matchReason } = await import('../src/connections/feuersoftware.js');
    expect(ricHit('2-Drohne', 'KEL 2-Drohne TE')).toBe(true);
    expect(ricHit('123', '1234567')).toBe(false);
    expect(ricHit('12 34', '1234; 999')).toBe(true);
    expect(ricHit('musterwehr  vollalarm', 'Musterwehr Vollalarm, Drehleiter')).toBe(true);
    expect(matchReason({ Ric: 'X' }, {}).ok).toBe(true);
    expect(matchReason({ Ric: 'Nachbar', Keyword: 'TH 1' }, { rics: ['Musterwehr'], keywords: ['B3'] })).toMatchObject({ ok: false });
    expect(matchReason({ Ric: 'Nachbar', Keyword: 'B3 Wohnung' }, { rics: ['Musterwehr'], keywords: ['b3'] })).toMatchObject({ ok: true, reason: 'Stichwort enthält „b3“' });
  });
  it('nur Einsätze der letzten 24 Stunden', async () => {
    const { isRecent } = await import('../src/connections/feuersoftware.js');
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(isRecent({ Start: '2026-11-15T01:00:00Z' }, now)).toBe(true);
    expect(isRecent({ Start: '2026-11-13T12:00:00Z' }, now)).toBe(false);
    expect(isRecent({ CreatedAt: '2026-11-15T11:00:00Z' }, now)).toBe(true);
    expect(isRecent({}, now)).toBe(true);
  });
  it('Retry-After als Sekunden oder Datum, begrenzt auf 1 s bis 1 h', async () => {
    const { retryAfterSeconds } = await import('../src/connections/feuersoftware.js');
    expect(retryAfterSeconds('120')).toBe(120);
    expect(retryAfterSeconds(undefined)).toBe(60);
    expect(retryAfterSeconds('99999')).toBe(3600);
    const in90 = retryAfterSeconds(new Date(Date.now() + 90_000).toUTCString());
    expect(in90).toBeGreaterThanOrEqual(88);
    expect(in90).toBeLessThanOrEqual(91);
  });
});

describe('Amtliche Warnungen: Gebietsfilter', () => {
  it('Gebiete überschneiden sich in beide Richtungen (Kreis-/Landeswarnung betrifft die Gemeinde)', async () => {
    const { inArea } = await import('../src/connections/warnfeed.js');
    const w = (...g: string[]) => ({ geocodes: g, areas: [] }) as any;
    expect(inArea(w('064360008008'), { codes: ['064360000000'] })).toBe(true); // Gemeinde im Kreis
    expect(inArea(w('064360000000'), { codes: ['064360008008'] })).toBe(true); // Kreiswarnung (z. B. DWD über das Dashboard)
    expect(inArea(w('060000000000'), { codes: ['064360008008'] })).toBe(true); // Landeswarnung
    expect(inArea(w('064340000000'), { codes: ['064360008008'] })).toBe(false); // Nachbarkreis
    expect(inArea(w('053740012012'), { codes: ['053700000000'] })).toBe(false); // #60 bleibt
    expect(inArea(w('809190000'), { codes: ['8'] })).toBe(true); // Warncell: nur Präfix in eine Richtung
    expect(inArea(w('8'), { codes: ['809190000'] })).toBe(false);
  });
});

describe('Amtliche Warnungen: Bannertext', () => {
  it('nennt nur Orte aus dem eigenen Gebiet und immer die Quelle', async () => {
    const { warningBannerText } = await import('../src/connections/warnfeed.js');
    const dwd = { sender: 'opendata@dwd.de', areas: ['Gemeinde Manubach', 'Stadt Monschau', 'Gemeinde Liederbach am Taunus', 'Wiesbaden-Nord'] };
    expect(warningBannerText(dwd, { names: ['Liederbach'] })).toBe('Gemeinde Liederbach am Taunus – Details und Verhaltenshinweise bei der Originalquelle. Quelle: Deutscher Wetterdienst.');
    expect(warningBannerText(dwd)).toBe('Details und Verhaltenshinweise bei der Originalquelle. Quelle: Deutscher Wetterdienst.');
    expect(warningBannerText({ identifier: 'mow.DE-HE-WI-SE012-20261114-12-000', areas: ['Stadt Musterstadt'] })).toContain('Stadt Musterstadt – ');
    expect(warningBannerText({ identifier: 'mow.DE-HE-WI-SE012-20261114-12-000', areas: [] })).toContain('Quelle: MoWaS (BBK).');
  });
});

describe('Code-Signatur der Bridge (#107)', () => {
  it('Nachrichtenformat ist fest (identisch in class-signature.php)', async () => {
    const { canonicalMessage } = await import('../src/lib/bridge-signature.js');
    expect(canonicalMessage('1.2.0', { 'z.php': 'b'.repeat(64), 'a/b.php': 'a'.repeat(64), 'B.txt': 'c'.repeat(64) }).toString()).toBe(
      `BLAULICHTCMS-BRIDGE-SIGNATURE-V1\nversion: 1.2.0\n${'c'.repeat(64)} B.txt\n${'a'.repeat(64)} a/b.php\n${'b'.repeat(64)} z.php\n`,
    );
  });

  it('signiert eine Kopie des Plugins und erkennt jede Veränderung', async () => {
    const crypto = await import('node:crypto');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { config } = await import('../src/config.js');
    const sig = await import('../src/lib/bridge-signature.js');
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-bridge-')), 'blaulichtcms-bridge');
    fs.cpSync(config.pluginDir, dir, { recursive: true });
    fs.rmSync(path.join(dir, sig.SIGNATURE_FILE), { force: true });
    fs.writeFileSync(path.join(dir, sig.KEYS_FILE), '<?php\nreturn array(\n);\n');
    expect(sig.verifyBridgeSignature(dir).state).toBe('not_configured');

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = sig.rawPublicKey(privateKey);
    expect(Buffer.from(pub, 'base64')).toHaveLength(32);
    fs.writeFileSync(path.join(dir, sig.KEYS_FILE), `<?php\nreturn array(\n\t'${pub}',\n);\n`);
    expect(sig.pinnedKeys(dir)).toEqual([pub]);
    expect(sig.verifyBridgeSignature(dir).state).toBe('unsigned');

    const write = () => fs.writeFileSync(path.join(dir, sig.SIGNATURE_FILE), JSON.stringify(sig.signBridge(dir, privateKey)));
    write();
    expect(sig.verifyBridgeSignature(dir)).toMatchObject({ state: 'valid', key: pub });
    // Geänderte Datei
    const admin = path.join(dir, 'includes/class-admin.php');
    const orig = fs.readFileSync(admin);
    fs.appendFileSync(admin, '\n// eingeschleust\n');
    expect(sig.verifyBridgeSignature(dir).state).toBe('invalid');
    fs.writeFileSync(admin, orig);
    expect(sig.verifyBridgeSignature(dir).state).toBe('valid');
    // Zusätzliche Datei
    fs.writeFileSync(path.join(dir, 'includes/extra.php'), '<?php');
    expect(sig.verifyBridgeSignature(dir).state).toBe('invalid');
    fs.rmSync(path.join(dir, 'includes/extra.php'));
    // Manipulierte Dateiliste (Prüfsumme passend zur geänderten Datei eingetragen) → Signatur ungültig
    const s = JSON.parse(fs.readFileSync(path.join(dir, sig.SIGNATURE_FILE), 'utf8'));
    fs.appendFileSync(admin, '\n// eingeschleust\n');
    s.files['includes/class-admin.php'] = crypto.createHash('sha256').update(fs.readFileSync(admin)).digest('hex');
    fs.writeFileSync(path.join(dir, sig.SIGNATURE_FILE), JSON.stringify(s));
    expect(sig.verifyBridgeSignature(dir)).toMatchObject({ state: 'invalid', reason: 'Signatur ungültig.' });
    fs.writeFileSync(admin, orig);
    write();
    // Fremder Schlüssel (z. B. von einem übernommenen Server): nicht hinterlegt → abgelehnt
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.writeFileSync(path.join(dir, sig.SIGNATURE_FILE), JSON.stringify(sig.signBridge(dir, other)));
    expect(sig.verifyBridgeSignature(dir).state).toBe('invalid');
    // Die installierte Bridge prüft mit IHREN Schlüsseln, nicht mit denen im Paket
    expect(sig.verifyBridgeSignature(dir, [sig.rawPublicKey(other)]).state).toBe('valid');
    expect(sig.verifyBridgeSignature(dir, [pub]).state).toBe('invalid');
  });

  it('die Bridge im Repository ist gültig signiert oder ohne hinterlegten Schlüssel', async () => {
    const { config } = await import('../src/config.js');
    const { verifyBridgeSignature } = await import('../src/lib/bridge-signature.js');
    const r = verifyBridgeSignature(config.pluginDir);
    // Schlägt fehl, wenn die Bridge nach dem Signieren geändert wurde: `node scripts/bridge-signing.mjs sign <schlüssel>`
    expect(['valid', 'not_configured'], r.reason).toContain(r.state);
  });
});

describe('Vertrauenswürdige Proxys (#92)', () => {
  it('liest TRUSTED_PROXIES, behandelt TRUST_PROXY=true als „private“ mit Warnung und lehnt Unsinn ab', async () => {
    const { parseTrustedProxies } = await import('../src/config.js');
    expect(parseTrustedProxies({})).toEqual({ list: [], warning: null });
    expect(parseTrustedProxies({ TRUST_PROXY: 'false' }).list).toEqual([]);
    const legacy = parseTrustedProxies({ TRUST_PROXY: 'true' });
    expect(legacy.list).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(legacy.warning).toContain('TRUSTED_PROXIES');
    expect(parseTrustedProxies({ TRUST_PROXY: 'true', TRUSTED_PROXIES: '172.18.0.0/16, 10.0.0.5 ::1' })).toEqual({ list: ['172.18.0.0/16', '10.0.0.5', '::1'], warning: null });
    expect(parseTrustedProxies({ TRUST_PROXY: 'true', TRUSTED_PROXIES: 'none' }).list).toEqual([]);
    expect(() => parseTrustedProxies({ TRUSTED_PROXIES: 'proxy.example.org' })).toThrow(/TRUSTED_PROXIES/);
    expect(() => parseTrustedProxies({ TRUSTED_PROXIES: '10.0.0.0/33' })).toThrow();
    expect(() => parseTrustedProxies({ TRUSTED_PROXIES: '300.1.1.1' })).toThrow();
  });

  it('ein vom Client mitgeschicktes X-Forwarded-For ändert req.ip nicht', async () => {
    const Fastify = (await import('fastify')).default;
    const { parseTrustedProxies } = await import('../src/config.js');
    const app = Fastify({ trustProxy: parseTrustedProxies({ TRUSTED_PROXIES: 'private' }).list });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    // Über den Proxy (privat): Proxy hängt die echte Adresse an, der gefälschte linke Eintrag zählt nicht
    const viaProxy = await app.inject({ url: '/ip', remoteAddress: '172.18.0.2', headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' } });
    expect(viaProxy.json().ip).toBe('203.0.113.9');
    // Direkt aus dem Internet: Header wird ignoriert
    const direct = await app.inject({ url: '/ip', remoteAddress: '203.0.113.50', headers: { 'x-forwarded-for': '198.51.100.7' } });
    expect(direct.json().ip).toBe('203.0.113.50');
    await app.close();
  });
});

describe('Audit fehlgeschlagener Anmeldungen (#128)', () => {
  it('speichert nur E-Mail-förmige Eingaben, sonst einen Fingerabdruck', async () => {
    const { loginAttemptLabel } = await import('../src/routes/auth.js');
    expect(loginAttemptLabel(' Jemand@Example.org ')).toBe('jemand@example.org');
    const pw = loginAttemptLabel('Mein-Geheimes-Passwort-2026');
    expect(pw).not.toContain('Geheim');
    expect(pw).toMatch(/^unbekanntes Konto .*Kennung [0-9a-f]{8}\)$/);
    expect(loginAttemptLabel('Mein-Geheimes-Passwort-2026')).toBe(pw);
    expect(loginAttemptLabel('a@b')).not.toContain('a@b');
  });
});

describe('Argon2id-Parameter (#129)', () => {
  it('hasht mit m=64 MiB, t=3, p=4 und erkennt alte Hashes', async () => {
    const { hashPassword, needsRehash, verifyPassword } = await import('../src/auth/passwords.js');
    const h = await hashPassword('Ein-langes-Passwort-2026');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword(h, 'Ein-langes-Passwort-2026')).toBe(true);
    const { hash, Algorithm } = await import('@node-rs/argon2');
    const old = await hash('x', { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    expect(needsRehash(old)).toBe(true);
    expect(await verifyPassword(old, 'x')).toBe(true);
    expect(needsRehash('$2b$10$abc')).toBe(true);
    expect(needsRehash(null)).toBe(false);
  });
});

describe('Wiederherstellungscodes (#130)', () => {
  it('haben 80 Bit und werden mit Schlüssel und Konto als Salz gespeichert', async () => {
    const { generateRecoveryCodes, recoveryCodeHash, recoveryCodeCandidates } = await import('../src/auth/totp.js');
    const { sha256Hex } = await import('../src/lib/crypto.js');
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(new Set(codes).size).toBe(10);
    const h = recoveryCodeHash('konto-a', codes[0]);
    expect(h).toMatch(/^h1:[0-9a-f]{64}$/);
    expect(h).not.toBe(sha256Hex(codes[0]));
    expect(recoveryCodeHash('konto-b', codes[0])).not.toBe(h);
    // Eingabe ohne Bindestriche, klein, mit Leerzeichen
    expect(recoveryCodeHash('konto-a', ` ${codes[0].replace(/-/g, '').toLowerCase()} `)).toBe(h);
    // Frühere Codes (ungesalzenes SHA-256) bleiben gültig
    expect(recoveryCodeCandidates('konto-a', 'abcde-12345')).toContain(sha256Hex('ABCDE-12345'));
  });
});

describe('Passwort-Sperrliste (#131)', () => {
  it('lehnt häufige Passwörter und Varianten ab, lässt eigene Sätze zu', async () => {
    const { passwordProblems, passwordCore } = await import('../src/auth/passwords.js');
    expect(passwordCore('Sommer2026!!')).toBe('sommer');
    expect(passwordCore('P@ssw0rt1')).toBe('passwort');
    for (const bad of ['Sommer2026!!', 'Feuerwehr112', 'Feuerwehr112!!!!!!', 'P@ssw0rt12345', 'qwertzuiop12', 'Dezember2026!', 'Fussball1234', '123456789012', 'abcabcabcabc', 'Schalke04!!!!', 'Muenchen2026', 'München2026!']) {
      expect(passwordProblems(bad, 12), bad).not.toBeNull();
    }
    for (const ok of ['Morgens zwei Kaffee, abends drei Tee', 'Langes-Passwort-2026', 'Robin-Zugang-sicher-2026', 'Blaue Gießkanne am Gartenzaun']) {
      expect(passwordProblems(ok, 12), ok).toBeNull();
    }
    // Name, E-Mail oder Organisation mit Zahlen
    expect(passwordProblems('Musterorganisation2026', 12, ['Musterorganisation'])).toContain('Namen');
    expect(passwordProblems('alex.beispiel!2026', 12, ['alex.beispiel@example.org'])).not.toBeNull();
    expect(passwordProblems('Musterorganisation2026', 12)).toBeNull();
  });
});

describe('Zwei-Faktor-Pflicht (#140)', () => {
  it('gilt standardmäßig für Admins und Rollen mit „Medien verwalten“', async () => {
    const { mustUse2fa } = await import('../src/auth/context.js');
    const { DEFAULT_SETTINGS } = await import('../src/lib/settings.js');
    const s = { ...DEFAULT_SETTINGS } as any;
    expect(mustUse2fa(['platform_admin'], s)).toBe(true);
    expect(mustUse2fa(['media_manager'], s)).toBe(true);
    expect(mustUse2fa(['editor'], s)).toBe(true);
    expect(mustUse2fa(['viewer'], s)).toBe(false);
    expect(mustUse2fa(['approver'], s)).toBe(false);
    expect(mustUse2fa(['media_manager'], { ...s, 'security.require_2fa_media': false })).toBe(false);
    expect(mustUse2fa(['viewer'], { ...s, 'security.require_2fa_all': true })).toBe(true);
  });
});

describe('Audit-Weiterleitung und Hash-Kette (#112)', () => {
  it('Syslog-Zeile nach RFC 5424 mit Facility authpriv', async () => {
    const { syslogLine } = await import('../src/lib/audit-forward.js');
    const line = syslogLine(4, '{"a":1}', new Date('2026-11-15T10:00:00Z'));
    expect(line).toMatch(/^<84>1 2026-11-15T10:00:00\.000Z \S+ blaulichtcms \d+ audit - \{"a":1\}$/);
  });
  it('Kettenhash hängt von Vorgänger und Inhalt ab', async () => {
    const { chainHash } = await import('../src/lib/audit-chain.js');
    const k = Buffer.from('k');
    expect(chainHash(k, 'genesis', 'a')).not.toBe(chainHash(k, 'genesis', 'b'));
    expect(chainHash(k, 'x', 'a')).not.toBe(chainHash(k, 'genesis', 'a'));
    expect(chainHash(k, 'genesis', 'a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Neutrale Dateinamen (#137)', () => {
  it('bildet Kurzformen ohne Sonderzeichen', () => {
    expect(fileSlug('Unfall Müller, Hauptstraße 5!')).toBe('unfall-mueller-hauptstrasse-5');
    expect(fileSlug('  ---  ')).toBe('');
    expect(fileSlug('Café à la carte')).toBe('cafe-a-la-carte');
    expect(fileSlug('a'.repeat(80)).length).toBe(40);
  });
  it('verwendet nie den Originalnamen', () => {
    const id = '0123abcd-0000-4000-8000-000000000000';
    expect(publicFileName(id, 'jpg')).toBe(`${id}.jpg`);
    expect(publicFileName(id, 'mp4', { index: 7 })).toBe('007-0123abcd.mp4');
    expect(publicFileName(id, 'jpg', { prefix: 'Brand in der Altstadt', index: 2 })).toBe('brand-in-der-altstadt-2.jpg');
    expect(publicFileName(id, 'jpg', { prefix: '!!!', index: 2 })).toBe('002-0123abcd.jpg');
  });
});

describe('Videospuren (#150)', () => {
  it('prüft alle Videospuren und wählt die erste echte', async () => {
    const { pickVideoStream } = await import('../src/media/process.js');
    const small = { index: 0, codec_type: 'video', width: 320, height: 240 };
    const huge = { index: 1, codec_type: 'video', width: 16384, height: 16384 };
    expect(() => pickVideoStream([small, huge])).toThrow(/zu hoch/);
    expect(() => pickVideoStream([{ index: 0, codec_type: 'audio' }])).toThrow(/keine Videospur/);
    // Titelbild (attached_pic) zählt nicht als Videospur und wird nicht gewählt
    const cover = { index: 0, codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } };
    expect(pickVideoStream([cover, { ...small, index: 1 }, { index: 2, codec_type: 'audio' }]).index).toBe(1);
    expect(() => pickVideoStream([cover])).toThrow(/keine Videospur/);
    expect(() => pickVideoStream([{ index: 0, codec_type: 'video', width: 'x', height: 10 }])).toThrow(/zu hoch/);
  });
});

describe('Standortdaten aus Originalen entfernen (#119)', () => {
  const exif = {
    IFD0: { Make: 'Testkamera', Artist: 'Erika Muster' },
    IFD2: { BodySerialNumber: 'SN-123456', DateTimeOriginal: '2026:11:15 10:00:00' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 6/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '8/1 41/1 0/1' },
  };
  const xmp =
    '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="50,6N"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

  for (const fmt of ['jpeg', 'png', 'webp'] as const) {
    it(`entfernt GPS, Seriennummer, Autor und XMP verlustfrei (${fmt})`, async () => {
      const sharp = (await import('sharp')).default;
      const { scrubImage } = await import('../src/media/scrub.js');
      const base = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 40 } } });
      const buf: Buffer = await (base as any)[fmt](fmt === 'webp' ? { lossless: true } : {}).withExif(exif).withXmp(xmp).toBuffer();
      const before = buf.toString('latin1');
      expect(before).toContain('SN-123456');
      // PNG speichert XMP ggf. komprimiert (iTXt) – dann über die Metadaten prüfen
      if (fmt === 'png') expect((await sharp(buf).metadata()).xmp).toBeDefined();
      else expect(before).toContain('GPSLatitude=');
      const r = scrubImage(buf, `image/${fmt}`);
      expect(r.changed).toBe(true);
      expect(r.gps).toBe(true);
      const after = r.data.toString('latin1');
      expect(after).not.toContain('SN-123456');
      expect(after).not.toContain('Erika Muster');
      expect(after).not.toContain('GPSLatitude=');
      expect(after).toContain('Testkamera');
      const meta = await sharp(r.data).metadata();
      expect(meta.xmp).toBeUndefined();
      expect(meta.width).toBe(64);
      // Bildpunkte unverändert
      expect((await sharp(r.data).raw().toBuffer()).equals(await sharp(buf).raw().toBuffer())).toBe(true);
      // Kein GPS-Verweis mehr im EXIF
      if (meta.exif) expect(meta.exif.includes(Buffer.from([0x88, 0x25])) || meta.exif.includes(Buffer.from([0x25, 0x88]))).toBe(false);
      // Zweiter Durchlauf ändert nichts mehr
      expect(scrubImage(r.data, `image/${fmt}`).changed).toBe(false);
    });
  }

  it('bereinigt HEIF an Ort und Stelle (gleiche Länge)', async () => {
    const sharp = (await import('sharp')).default;
    const { scrubHeif } = await import('../src/media/scrub.js');
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().withExif(exif).toBuffer();
    const exifSeg = jpeg.subarray(jpeg.indexOf('Exif\0\0', 0, 'latin1'));
    // Stellvertreter für einen ISO-BMFF-Container: Kopf, EXIF-Element, XMP-Paket, Bilddaten
    const fake = Buffer.concat([Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'), exifSeg.subarray(0, 600), Buffer.from(xmp, 'latin1'), Buffer.from('BILDDATEN')]);
    const r = scrubHeif(fake);
    expect(r.gps).toBe(true);
    expect(r.data.length).toBe(fake.length);
    const s = r.data.toString('latin1');
    expect(s).not.toContain('SN-123456');
    expect(s).not.toContain('GPSLatitude=');
    expect(s.endsWith('BILDDATEN')).toBe(true);
  });

  it('lässt unbekannte oder beschädigte Daten unverändert', async () => {
    const { scrubImage, scrubTiff } = await import('../src/media/scrub.js');
    const junk = Buffer.from('kein Bild');
    expect(scrubImage(junk, 'image/jpeg').data).toBe(junk);
    expect(scrubImage(junk, 'image/gif').changed).toBe(false);
    const bad = Buffer.from('II*\0\xff\xff\xff\xff', 'latin1');
    expect(scrubTiff(bad, 0)).toEqual({ gps: false, changed: false });
  });
});

describe('ClamAV INSTREAM (#133)', () => {
  /** Kleiner clamd-Stellvertreter: liest zINSTREAM, sammelt die Blöcke und antwortet je nach Inhalt. */
  async function fakeClamd(behaviour: 'normal' | 'silent' | 'error' = 'normal') {
    const net = await import('node:net');
    const seen: { command: string; chunks: number; data: Buffer }[] = [];
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let command: string | null = null;
      const parts: Buffer[] = [];
      let chunks = 0;
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (command === null) {
          const z = buf.indexOf(0);
          if (z === -1) return;
          command = buf.subarray(0, z).toString();
          buf = buf.subarray(z + 1);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            const data = Buffer.concat(parts);
            seen.push({ command, chunks, data });
            if (behaviour === 'silent') return;
            if (behaviour === 'error') return void sock.end('INSTREAM size limit exceeded. ERROR\0');
            sock.end(data.includes('EICAR-TEST') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (buf.length < 4 + len) return;
          parts.push(buf.subarray(4, 4 + len));
          chunks++;
          buf = buf.subarray(4 + len);
        }
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port as number;
    return { port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const tmpFile = async (content: Buffer) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const f = path.join(os.tmpdir(), `clam-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(f, content);
    return f;
  };

  it('überträgt die Datei in Blöcken und erkennt saubere Dateien', async () => {
    const { scanFile } = await import('../src/media/clamav.js');
    const srv = await fakeClamd();
    try {
      const data = Buffer.alloc(200_000, 7);
      const r = await scanFile(await tmpFile(data), { host: '127.0.0.1', port: srv.port, timeoutMs: 5000, chunkSize: 64 * 1024 });
      expect(r).toEqual({ status: 'clean' });
      expect(srv.seen[0].command).toBe('zINSTREAM');
      expect(srv.seen[0].chunks).toBeGreaterThanOrEqual(4);
      expect(srv.seen[0].data.equals(data)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('meldet Treffer mit Signatur', async () => {
    const { scanFile } = await import('../src/media/clamav.js');
    const srv = await fakeClamd();
    try {
      const r = await scanFile(await tmpFile(Buffer.from('xxx EICAR-TEST yyy')), { host: '127.0.0.1', port: srv.port, timeoutMs: 5000 });
      expect(r).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
    } finally {
      await srv.close();
    }
  });

  it('nicht erreichbar, Zeitüberschreitung und Fehlerantwort gelten als „nicht prüfbar“', async () => {
    const { scanFile, ScannerUnavailable } = await import('../src/media/clamav.js');
    const f = await tmpFile(Buffer.from('daten'));
    // geschlossener Port
    const tmp = await fakeClamd();
    const closedPort = tmp.port;
    await tmp.close();
    await expect(scanFile(f, { host: '127.0.0.1', port: closedPort, timeoutMs: 2000 })).rejects.toBeInstanceOf(ScannerUnavailable);
    const silent = await fakeClamd('silent');
    try {
      await expect(scanFile(f, { host: '127.0.0.1', port: silent.port, timeoutMs: 300 })).rejects.toThrow(/antwortet nicht/);
    } finally {
      await silent.close();
    }
    const err = await fakeClamd('error');
    try {
      await expect(scanFile(f, { host: '127.0.0.1', port: err.port, timeoutMs: 2000 })).rejects.toThrow(/size limit/);
    } finally {
      await err.close();
    }
  });

  it('wertet Antworten aus', async () => {
    const { parseClamdReply, pingClamd } = await import('../src/media/clamav.js');
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
    expect(() => parseClamdReply('')).toThrow();
    expect(await pingClamd({ host: '127.0.0.1', port: 1, timeoutMs: 500 })).toBe(false);
  });
});

describe('Unkenntlich machen und Zuschnitt (#118)', () => {
  it('rechnet Bereiche in Bildpunkte um, ohne das Bild zu verlassen', async () => {
    const { toPx } = await import('../src/media/privacy.js');
    expect(toPx({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 400, 200)).toEqual({ left: 100, top: 100, width: 200, height: 50 });
    expect(toPx({ x: 0.999, y: 0.999, w: 0.001, h: 0.001 }, 100, 100)).toEqual({ left: 99, top: 99, width: 1, height: 1 });
    expect(toPx({ x: 0, y: 0, w: 1, h: 1 }, 7, 3)).toEqual({ left: 0, top: 0, width: 7, height: 3 });
  });
  it('überträgt Bereiche in den Zuschnitt und verwirft Bereiche außerhalb', async () => {
    const { regionInCrop } = await import('../src/media/privacy.js');
    const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
    expect(regionInCrop({ x: 0, y: 0, w: 0.4, h: 0.4, mode: 'blur' }, crop)).toBeNull();
    const r = regionInCrop({ x: 0.4, y: 0.2, w: 0.2, h: 0.2, mode: 'box' }, crop)!;
    expect(r.mode).toBe('box');
    expect([r.x, r.y, r.w, r.h].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.2, 0.2, 0.2]);
    expect(regionInCrop({ x: 0.75, y: 0.5, w: 0.25, h: 0.5 }, crop)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(regionInCrop({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, null)).toEqual({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
  });
  it('neuer Bridge-Schlüssel je neu erzeugter öffentlicher Fassung', async () => {
    const { bridgeMediaKey } = await import('../src/routes/bridge.js');
    const id = '0123abcd-0000-4000-8000-000000000000';
    expect(bridgeMediaKey({ id, public_rev: 0 })).toBe(id);
    expect(bridgeMediaKey({ id })).toBe(id);
    expect(bridgeMediaKey({ id, public_rev: 3 })).toBe(`${id}.3`);
  });
  it('prüft Eingaben', async () => {
    const { privacyInput } = await import('../src/media/privacy.js');
    expect(() => privacyInput.parse({ redactions: [{ x: 0.9, y: 0, w: 0.5, h: 0.1 }] })).toThrow();
    expect(() => privacyInput.parse({ flags: ['unbekannt'] })).toThrow();
    expect(privacyInput.parse({ redactions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }).redactions![0].mode).toBe('pixelate');
  });
});

describe('SMTP-Einstellungen (#100)', () => {
  it('ohne TLS keine Anmeldung, nur bekannte Verschlüsselungsarten', async () => {
    const { smtpConfigProblem } = await import('../src/warnings/mail.js');
    expect(smtpConfigProblem({ security: 'starttls', user: 'a', password: 'b' })).toBeNull();
    expect(smtpConfigProblem({ security: 'tls', user: 'a' })).toBeNull();
    expect(smtpConfigProblem({ security: 'none', user: '' })).toBeNull();
    expect(smtpConfigProblem({ security: 'none', user: 'a' })).toContain('Klartext');
    expect(smtpConfigProblem({ security: 'none', user: '', password: 'x' })).toContain('Klartext');
    expect(smtpConfigProblem({ security: 'foo' })).toContain('Unbekannte');
    expect(smtpConfigProblem({ security: '' })).toContain('Unbekannte');
  });
});

describe('Echtbetrieb nur nach erfolgreicher Testmail', () => {
  it('Prüfwert hängt an genau den Versandeinstellungen, nicht an Groß-/Kleinschreibung des Servers', async () => {
    const { smtpFingerprint } = await import('../src/warnings/mail.js');
    const base = { host: 'smtp.example.org', port: 587, security: 'starttls', user: 'postfach', from: 'warnung@example.org', password: 'geheim' };
    const fp = smtpFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain('geheim');
    expect(smtpFingerprint({ ...base, host: ' SMTP.example.org ' })).toBe(fp);
    for (const change of [{ host: 'smtp.example.net' }, { port: 465 }, { security: 'tls' }, { user: 'anderes' }, { from: 'x@example.org' }, { password: 'anders' }]) {
      expect(smtpFingerprint({ ...base, ...change })).not.toBe(fp);
    }
    // Ohne Anmeldung spielt das Passwort keine Rolle
    const anon = { ...base, user: '', password: '' };
    expect(smtpFingerprint({ ...anon, password: 'egal' })).toBe(smtpFingerprint(anon));
  });
});

describe('Verbindungen: neuer Test nach Änderungen', () => {
  it('nur testrelevante Einstellungen zählen', async () => {
    const { retestRelevantConfig: r } = await import('../src/connections/common.js');
    const fe2 = { mapping: { event_id: 'einsatz.id' }, createDrafts: true };
    expect(r({ ...fe2, createDrafts: false })).toBe(r(fe2));
    expect(r({ mapping: { event_id: 'einsatz.id', keyword: '' } })).toBe(r({ mapping: { event_id: 'einsatz.id' } }));
    expect(r({ mapping: { event_id: 'einsatz.nummer' } })).not.toBe(r(fe2));
    const wf = { format: 'nina', ars: '053150000000', url: '', areaFilter: { codes: [], names: ['Musterstadt'] }, intervalMinutes: 5, autoBanner: false, bannerSiteId: null };
    expect(r({ ...wf, intervalMinutes: 30, autoBanner: true, bannerSiteId: 'x', review: { approvedAt: 'jetzt' } })).toBe(r(wf));
    expect(r({ ...wf, ars: '053160000000' })).not.toBe(r(wf));
    expect(r({ ...wf, areaFilter: { codes: [], names: ['Nordheim'] } })).not.toBe(r(wf));
    expect(r({ appId: '1', pageId: 'P1' })).not.toBe(r({ appId: '1', pageId: 'P2' }));
    expect(r({ appId: '1', oauthState: { hash: 'a' } })).toBe(r({ appId: '1' }));
  });
});

describe('Warnfeeds nur über HTTPS (#108)', () => {
  it('erkennt unverschlüsselte Quellen, localhost ausgenommen', async () => {
    const { insecureFeed, insecureFeedUrl } = await import('../src/connections/warnfeed.js');
    expect(insecureFeedUrl('https://warnung.bund.de/api31')).toBe(false);
    expect(insecureFeedUrl('http://warn.example.org/cap.xml')).toBe(true);
    expect(insecureFeedUrl('http://127.0.0.1:8080/cap.xml')).toBe(false);
    expect(insecureFeedUrl('http://localhost/cap.xml')).toBe(false);
    expect(insecureFeedUrl('kaputt')).toBe(true);
    expect(insecureFeed({ format: 'nina' })).toBe(false);
    expect(insecureFeed({ format: 'nina', baseUrl: 'http://x.example.org' })).toBe(true);
    expect(insecureFeed({ format: 'cap', url: 'http://x.example.org/a.xml' })).toBe(true);
  });
});

describe('Link „Originalquelle“ aus Warnfeeds (#158)', () => {
  it('übernimmt nur http(s)-Adressen', async () => {
    const { normalizeCap } = await import('../src/connections/warnfeed.js');
    const base = { identifier: 'X', info: { language: 'de-DE', headline: 'Test' } };
    expect(normalizeCap({ ...base, info: { ...base.info, web: "javascript:fetch('/api/v1/x')" } })!.web).toBeNull();
    expect(normalizeCap({ ...base, info: { ...base.info, web: 'data:text/html,abc' } })!.web).toBeNull();
    expect(normalizeCap({ ...base, info: { ...base.info, web: 'https://warnung.bund.de/x' } })!.web).toBe('https://warnung.bund.de/x');
  });
});

describe('Import: Datumsprüfung (#154)', () => {
  it('lässt nur gültige ISO-Daten zu', async () => {
    const { isValidIsoDate } = await import('../src/ops/import.js');
    for (const ok of ['2026-11-14', '2026-11-14T10:00:00Z', '2026-11-14T10:00:00+01:00', '2028-02-29T00:00:00.123Z']) expect(isValidIsoDate(ok), ok).toBe(true);
    for (const bad of ['2026-13-01', '2026-02-31', '2026-02-29', '1', '', 'morgen', '2026-11-14T25:00:00Z']) expect(isValidIsoDate(bad), bad).toBe(false);
  });
});

describe('Einstellungskatalog ohne Drift (#175)', () => {
  const root = path.resolve(__dirname, '..', '..');
  const read = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? read(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const sources = [...read(path.join(root, 'server', 'src')), ...read(path.join(root, 'web', 'src'))]
    .filter((f) => !/server[\/]src[\/](lib[\/]settings|routes[\/]system)\.ts$/.test(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const ui = fs.readFileSync(path.join(root, 'web', 'src', 'pages', 'admin', 'Settings.tsx'), 'utf8');

  it('jeder Schlüssel wird außerhalb von Katalog und Validierung gelesen', () => {
    const dead = Object.keys(DEFAULT_SETTINGS).filter((k) => !sources.includes(`'${k}'`) && !sources.includes(`"${k}"`));
    expect(dead).toEqual([]);
  });
  it('die Oberfläche kennt nur Schlüssel aus dem Katalog', () => {
    const used = [...ui.matchAll(/(?:k=|v\[|draft\??\.?\[)"([a-z0-9_]+\.[a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((k) => !(k in DEFAULT_SETTINGS))).toEqual([]);
  });
  it('Zahlenbereiche der Oberfläche entsprechen denen des Servers', () => {
    const block = ui.slice(ui.indexOf('const RANGES'), ui.indexOf('};', ui.indexOf('const RANGES')));
    const web = Object.fromEntries([...block.matchAll(/'([a-z0-9_.]+)': \[(\d+), (\d+)\]/g)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
    expect(web).toEqual(SETTING_RANGES);
    const numeric = Object.entries(DEFAULT_SETTINGS).filter(([, v]) => typeof v === 'number').map(([k]) => k).sort();
    expect(Object.keys(SETTING_RANGES).sort()).toEqual(numeric);
  });
});

describe('Zustand eines Warnvorgangs (#184)', () => {
  it('leitet den Zustand aus Fassung, letzter Entscheidung und letztem Versand ab', async () => {
    const { warningState } = await import('../src/routes/warnings.js');
    const rev = { id: 'r2', content_hash: 'h2', submitted_at: '2026-11-15T10:00:00Z' };
    expect(warningState({ ...rev, submitted_at: null }, null, null).state).toBe('draft');
    expect(warningState(rev, null, null).state).toBe('in_review');
    expect(warningState(rev, { decision: 'rejected', content_hash: 'h2', decided_at: '2026-11-15T11:00:00Z' }, null).state).toBe('rejected');
    const ok = { decision: 'approved', content_hash: 'h2', decided_at: '2026-11-15T11:00:00Z' };
    expect(warningState(rev, { ...ok, content_hash: 'alt' }, null).valid).toBeNull();
    expect(warningState(rev, ok, null).state).toBe('approved');
    const send = { revision_id: 'r2', status: 'accepted', resolution: null, acknowledged_at: null };
    expect(warningState(rev, ok, send).state).toBe('sent');
    expect(warningState(rev, ok, { ...send, acknowledged_at: '2026-11-15T12:00:00Z' }).state).toBe('acknowledged');
    expect(warningState(rev, ok, { ...send, status: 'failed' }).state).toBe('send_failed');
    expect(warningState(rev, ok, { ...send, status: 'unknown' }).state).toBe('send_unknown');
    expect(warningState(rev, ok, { ...send, status: 'unknown', resolution: 'delivered' }).state).toBe('sent');
    expect(warningState(rev, ok, { ...send, status: 'queued' }).state).toBe('sending');
    // Versand einer früheren Fassung zählt nicht
    expect(warningState(rev, ok, { ...send, revision_id: 'r1' }).state).toBe('approved');
  });
});

describe('Empfängeränderung im Audit ohne Adressen (#185)', () => {
  it('zählt Empfänger, nennt Domains und Änderungen', async () => {
    const { recipientAudit } = await import('../src/routes/warnings.js');
    expect(recipientAudit([], ['a@x.example', 'b@y.example'])).toEqual({ empfaenger_anzahl: 2, empfaenger_domains: ['x.example', 'y.example'] });
    const u = recipientAudit(['a@x.example', 'b@y.example'], ['A@x.example ', 'c@x.example']);
    expect(u).toEqual({ empfaenger_anzahl: 2, empfaenger_domains: ['x.example'], hinzugefuegt: 1, entfernt: 1 });
    expect(JSON.stringify(u)).not.toContain('@');
  });
});

describe('In-App-Updates: Versionen, Paket, Signatur, Manifest, Zeiger', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bc-upd-'));
  const requiredSet = async () => (await import('../src/updates/core.js')).REQUIRED_FILES.map((name) => ({ name, size: 10, isDirectory: false, mode: 0o100644 }));

  it('vergleicht nur vollständige Versionen X.Y.Z', async () => {
    const { compareVersions, parseVersion } = await import('../src/updates/core.js');
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    for (const bad of ['1.2', '1.2.3-beta', 'x', '', '1.2.3.4', '1.2.x']) expect(parseVersion(bad), bad).toBeNull();
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', 'v1.0.1')).toBeLessThan(0);
    expect(compareVersions('kaputt', '0.0.0')).toBeLessThan(0);
  });

  it('weist unsichere ZIP-Einträge ab', async () => {
    const { checkZipEntries } = await import('../src/updates/core.js');
    const base = await requiredSet();
    expect(checkZipEntries(base)).toHaveLength(base.length);
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['absolut', { name: '/etc/passwd' }, /absoluter Pfad/],
      ['Laufwerk', { name: 'C:/x/server/dist/a.js' }, /absoluter Pfad/],
      ['Elternpfad', { name: 'server/dist/../../x.js' }, /\.\./],
      ['Rückwärtsschrägstrich', { name: ['server', 'dist', 'a.js'].join(String.fromCharCode(92)) }, /Rückwärtsschrägstrich/],
      ['Symlink', { name: 'server/dist/link.js', mode: 0o120777 }, /Symbolische Links/],
      ['.env', { name: 'server/dist/.env' }, /Umgebungsdatei/],
      ['node_modules', { name: 'server/dist/node_modules/x/index.js' }, /node_modules/],
      ['Schlüssel', { name: 'server/dist/geheim.pem' }, /Schlüssel/],
      ['fremder Ort', { name: 'scripts/x.sh' }, /unerwartetem Ort/],
      ['zu groß', { name: 'server/dist/gross.js', size: 300 * 1024 ** 2 }, /zu groß/],
    ];
    for (const [label, e, re] of bad) {
      expect(() => checkZipEntries([...base, { name: 'x', size: 1, isDirectory: false, mode: 0o100644, ...e } as any]), label).toThrow(re);
    }
    expect(() => checkZipEntries([...base, { ...base[0] }])).toThrow(/Doppelter Eintrag/);
    expect(() => checkZipEntries(base.filter((b) => b.name !== 'server/dist/cli.js'))).toThrow(/server\/dist\/cli\.js/);
    expect(() => checkZipEntries(Array.from({ length: 20_001 }, (_, i) => ({ name: `web/dist/f${i}.js`, size: 1, isDirectory: false, mode: 0 })))).toThrow(/zu viele/);
  });

  it('prüft echte ZIP-Dateien inklusive Symlink-Attribut', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const { checkZipEntries, zipEntryInfos } = await import('../src/updates/core.js');
    const z = new AdmZip();
    for (const e of await requiredSet()) z.addFile(e.name, Buffer.from('x'), '', (0o100644 << 16) >>> 0);
    expect(() => checkZipEntries(zipEntryInfos(new AdmZip(z.toBuffer())))).not.toThrow();
    z.addFile('web/dist/link', Buffer.from('/etc/passwd'));
    // addFile setzt immer „reguläre Datei“ – Symlink-Typ wie in einem präparierten Paket nachträglich setzen
    z.getEntry('web/dist/link')!.attr = (0o120777 << 16) >>> 0;
    expect(() => checkZipEntries(zipEntryInfos(new AdmZip(z.toBuffer())))).toThrow(/Symbolische Links/);
  });

  it('Signatur: gültig, falscher Schlüssel, veränderte Prüfsumme, kein Schlüssel', async () => {
    const crypto = await import('node:crypto');
    const { rawPublicKeyBase64, signDigest, signatureFileText, verifyDigestSignature, parseSignature, publicKeyStatus } = await import('../src/updates/signing.js');
    const dir = tmp();
    const a = crypto.generateKeyPairSync('ed25519');
    const b = crypto.generateKeyPairSync('ed25519');
    const pub = path.join(dir, 'a.pub');
    fs.writeFileSync(pub, `# Kommentar\n${rawPublicKeyBase64(a.publicKey)}\n`);
    const digest = crypto.createHash('sha256').update('paket').digest('hex');
    const sig = signatureFileText('x.zip', signDigest(digest, a.privateKey));
    expect(() => verifyDigestSignature(digest, Buffer.from(sig), pub)).not.toThrow();
    expect(() => verifyDigestSignature(digest, signatureFileText('x.zip', signDigest(digest, b.privateKey)), pub)).toThrow(/ungültig/);
    const other = crypto.createHash('sha256').update('verändert').digest('hex');
    expect(() => verifyDigestSignature(other, sig, pub)).toThrow(/ungültig/);
    expect(() => verifyDigestSignature(digest, sig, path.join(dir, 'fehlt.pub'))).toThrow(/kein öffentlicher Signaturschlüssel/);
    fs.writeFileSync(path.join(dir, 'leer.pub'), '# nur Kommentar\n');
    expect(() => verifyDigestSignature(digest, sig, path.join(dir, 'leer.pub'))).toThrow(/kein öffentlicher Signaturschlüssel/);
    expect(() => parseSignature(null)).toThrow(/fehlt/);
    expect(() => parseSignature('# x\nabc\n')).toThrow(/Format/);
    // Der Kontext gehört zur Signatur: eine Signatur nur über die Prüfsumme gilt nicht
    const bare = crypto.sign(null, Buffer.from(digest), a.privateKey).toString('base64');
    expect(() => verifyDigestSignature(digest, bare, pub)).toThrow(/ungültig/);
    // Der im Repository angeheftete Schlüssel ist gültig
    expect(publicKeyStatus(path.resolve(__dirname, '..', 'update-signing-key.pub'))).toBe('ok');
  });

  it('Manifest: Mindest-Image, Node.js, PostgreSQL und ffmpeg', async () => {
    const { compatibilityProblem, parseManifest } = await import('../src/updates/core.js');
    const m = parseManifest(JSON.stringify({ name: 'blaulichtcms', version: '0.3.0', minImageVersion: '0.2.0', requires: { nodeMajor: 24, postgresMajor: 18, ffmpeg: true } }));
    const image = { version: '0.2.0', nodeMajor: 26, postgresMajor: 18, ffmpeg: true };
    expect(compatibilityProblem(m, image)).toBeNull();
    expect(compatibilityProblem(m, { ...image, version: '0.1.9' })).toMatch(/mindestens 0\.2\.0.*install\.sh/);
    expect(compatibilityProblem(m, { ...image, nodeMajor: 22 })).toMatch(/Node\.js 24/);
    expect(compatibilityProblem(m, { ...image, postgresMajor: 17 })).toMatch(/PostgreSQL 18/);
    expect(compatibilityProblem(m, { ...image, ffmpeg: false })).toMatch(/ffmpeg/);
    expect(() => parseManifest('{"name":"andere-app","version":"1.0.0","minImageVersion":"1.0.0"}')).toThrow(/BlaulichtCMS/);
    expect(() => parseManifest('{"name":"blaulichtcms","version":"1.0.0"}')).toThrow(/minImageVersion/);
    expect(() => parseManifest('kein json')).toThrow(/JSON/);
  });

  it('Laufzeit-Abhängigkeiten: nur der Server-Baum zählt', async () => {
    const { compareRuntimeDependencies, runtimeDependencies } = await import('../src/updates/core.js');
    const lock = (over: Record<string, any> = {}) => ({
      packages: {
        '': { workspaces: ['server', 'web'] },
        server: { dependencies: { a: '^1', b: '^1' } },
        web: { dependencies: { react: '^19' } },
        'node_modules/@blaulichtcms/server': { link: true, resolved: 'server' },
        'node_modules/a': { version: '1.0.0', integrity: 'sha-a', dependencies: { c: '^1' } },
        'node_modules/b': { version: '1.0.0', integrity: 'sha-b', optionalDependencies: { 'b-linux': '1' } },
        'node_modules/c': { version: '1.0.0', integrity: 'sha-c1' },
        'node_modules/react': { version: '19.0.0', integrity: 'sha-r' },
        'node_modules/vite': { version: '8.0.0', integrity: 'sha-v', dev: true },
        ...over,
      },
    });
    expect([...runtimeDependencies(lock()).keys()].sort()).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/c']);
    // verschachtelte Auflösung: server/node_modules/c hat Vorrang vor node_modules/c für den Server selbst
    const nested = runtimeDependencies(lock({ server: { dependencies: { a: '^1', c: '^2' } }, 'server/node_modules/c': { version: '2.0.0', integrity: 'sha-c2' } }));
    expect(nested.get('server/node_modules/c')).toBe('2.0.0#sha-c2');
    expect(nested.get('node_modules/c')).toBe('1.0.0#sha-c1');
    expect(compareRuntimeDependencies(lock(), lock({ 'node_modules/react': { version: '19.1.0', integrity: 'x' }, 'node_modules/vite': { version: '9', dev: true } })).same).toBe(true);
    expect(compareRuntimeDependencies(lock(), lock({ 'node_modules/c': { version: '1.0.1', integrity: 'neu' } }))).toEqual({ same: false, diff: ['c'] });
    // Die echte package-lock.json des Repositorys lässt sich auswerten und enthält die nativen Module
    const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package-lock.json'), 'utf8'));
    const keys = [...runtimeDependencies(real).keys()];
    expect(keys).toContain('node_modules/sharp');
    expect(keys).toContain('node_modules/fastify');
    expect(keys.some((k) => k.endsWith('/react'))).toBe(false);
    expect(keys.some((k) => k.endsWith('/vitest'))).toBe(false);
  });

  it('Zeiger: Release nur, wenn gültig und neuer als das Image', async () => {
    const { resolveActiveRoot, writePointer, releasesDir, cleanupReleases } = await import('../src/updates/releases.js');
    const data = tmp();
    const image = tmp();
    fs.writeFileSync(path.join(image, 'VERSION'), '0.2.0\n');
    const makeRelease = (v: string, opts: { minImage?: string; skip?: string } = {}) => {
      const dir = path.join(releasesDir(data), v);
      for (const f of ['server/dist/api.js', 'server/dist/worker.js', 'server/dist/cli.js', 'web/dist/index.html']) {
        if (f === opts.skip) continue;
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), '');
      }
      fs.mkdirSync(path.join(dir, 'server', 'migrations'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'VERSION'), v);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'blaulichtcms', version: v, minImageVersion: opts.minImage ?? '0.1.0' }));
      return dir;
    };
    expect(resolveActiveRoot(image, data)).toMatchObject({ source: 'image', version: '0.2.0', dropPointer: null });
    const r3 = makeRelease('0.3.0');
    writePointer(data, { version: '0.3.0', path: r3 });
    expect(resolveActiveRoot(image, data)).toMatchObject({ source: 'update', version: '0.3.0', root: fs.realpathSync(r3) });
    // Image am Host aktualisiert (gleich oder neuer): Code des Images, Zeiger veraltet
    fs.writeFileSync(path.join(image, 'VERSION'), '0.3.0\n');
    expect(resolveActiveRoot(image, data)).toMatchObject({ source: 'image', dropPointer: expect.stringMatching(/nicht älter/) });
    fs.writeFileSync(path.join(image, 'VERSION'), '0.2.0\n');
    // Unvollständiger Ordner, falscher Name, zu altes Image, Ordner außerhalb
    const r4 = makeRelease('0.4.0', { skip: 'server/dist/api.js' });
    writePointer(data, { version: '0.4.0', path: r4 });
    expect(resolveActiveRoot(image, data).dropPointer).toMatch(/api\.js/);
    writePointer(data, { version: '0.5.0', path: r3 });
    expect(resolveActiveRoot(image, data).dropPointer).toMatch(/erwarteten Stelle/);
    const r6 = makeRelease('0.6.0', { minImage: '0.6.0' });
    writePointer(data, { version: '0.6.0', path: r6 });
    expect(resolveActiveRoot(image, data).dropPointer).toMatch(/mindestens Image 0\.6\.0/);
    const outside = path.join(tmp(), '0.7.0');
    fs.mkdirSync(outside);
    writePointer(data, { version: '0.7.0', path: outside });
    expect(resolveActiveRoot(image, data).dropPointer).toMatch(/erwarteten Stelle/);
    // Aufräumen: drei neueste und die ausdrücklich behaltenen bleiben, Zwischenstände verschwinden
    makeRelease('0.1.5');
    makeRelease('0.1.6');
    fs.mkdirSync(path.join(releasesDir(data), '.staging-0.8.0-abcd'));
    const removed = cleanupReleases(data, [path.join(releasesDir(data), '0.1.5')]);
    expect(removed).toContain('.staging-0.8.0-abcd');
    expect(removed).toContain('0.1.6');
    expect(removed).not.toContain('0.1.5');
    expect(fs.existsSync(path.join(releasesDir(data), '0.6.0'))).toBe(true);
  });

  it('Update-Quelle: nur HTTPS-API-Adressen', async () => {
    const { normalizeApiUrl } = await import('../src/updates/github.js');
    expect(normalizeApiUrl('https://api.github.com/')).toBe('https://api.github.com');
    expect(normalizeApiUrl('https://ghe.example.org/api/v3')).toBe('https://ghe.example.org/api/v3');
    expect(() => normalizeApiUrl('http://api.github.com')).toThrow(/https/);
    expect(() => normalizeApiUrl('https://user:pw@api.github.com')).toThrow(/Zugangsdaten/);
    expect(() => normalizeApiUrl('ftp://x')).toThrow();
    // In Tests ist http://127.0.0.1 für den GitHub-Stellvertreter erlaubt, sonst nie
    expect(normalizeApiUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
  });
});

describe('Upload-Links: Gültigkeit und Zustand (Medien wie LiFeOS)', () => {
  it('berechnet Dauer, Termin und Verlängerung mit Höchstdauer', async () => {
    const { computeExpiry, extendExpiry, linkState } = await import('../src/media/links.js');
    const now = Date.parse('2026-11-15T10:00:00Z');
    const opts = { defaultDays: 7, maxDays: 30 };
    expect(computeExpiry({ hours: 6 }, opts, now).toISOString()).toBe('2026-11-15T16:00:00.000Z');
    expect(computeExpiry({}, opts, now).toISOString()).toBe('2026-11-22T10:00:00.000Z');
    expect(computeExpiry({ days: 90 }, opts, now).toISOString()).toBe('2026-12-15T10:00:00.000Z');
    expect(computeExpiry({ expiresAt: '2026-11-16T08:30:00Z' }, opts, now).toISOString()).toBe('2026-11-16T08:30:00.000Z');
    expect(() => computeExpiry({ expiresAt: '2026-11-15T10:03:00Z' }, opts, now)).toThrow(/5 Minuten/);
    expect(() => computeExpiry({ expiresAt: '2027-01-01T00:00:00Z' }, opts, now)).toThrow(/höchstens 30 Tage/);
    expect(() => computeExpiry({ expiresAt: 'morgen' }, opts, now)).toThrow(/Datum und Uhrzeit/);
    // Verlängern ab bisherigem Ablauf, bei abgelaufenem Link ab jetzt, nie über die Höchstdauer
    expect(extendExpiry('2026-11-16T10:00:00Z', 24, 30, now).toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(extendExpiry('2026-11-01T10:00:00Z', 24, 30, now).toISOString()).toBe('2026-11-16T10:00:00.000Z');
    expect(extendExpiry('2026-12-14T10:00:00Z', 72, 30, now).toISOString()).toBe('2026-12-15T10:00:00.000Z');
    expect(linkState({ expires_at: '2026-11-16T00:00:00Z' }, now)).toBe('active');
    expect(linkState({ expires_at: '2026-11-16T00:00:00Z', paused_at: 'x' }, now)).toBe('paused');
    expect(linkState({ expires_at: '2026-11-14T00:00:00Z', paused_at: 'x' }, now)).toBe('expired');
    expect(linkState({ expires_at: '2026-11-16T00:00:00Z', revoked_at: 'x' }, now)).toBe('revoked');
  });
});

describe('Geräte-Cookie als Grundlage für gemerkte Sitzungen und Geräte', () => {
  it('liefert die Gerätekennung, behält sie beim Erneuern und bindet den Hash an das Konto', async () => {
    const { deviceHash, issueDeviceCookie, knownDevice } = await import('../src/auth/lockout.js');
    const set: Record<string, { value: string; opts: any }> = {};
    const reply = { setCookie: (name: string, value: string, opts: any) => (set[name] = { value, opts }) } as any;
    const userA = '11111111-1111-4111-8111-111111111111';
    const userB = '22222222-2222-4222-8222-222222222222';
    const nonce = issueDeviceCookie({ cookies: {} } as any, reply, userA);
    const [name] = Object.keys(set);
    expect(set[name].opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/' });
    const req = { cookies: { [name]: set[name].value } } as any;
    expect(knownDevice(req, userA)).toBe(nonce);
    expect(knownDevice(req, userB)).toBeNull();
    // Erneuern behält die Kennung (gemerkte Sitzungen bleiben gültig)
    expect(issueDeviceCookie(req, reply, userA)).toBe(nonce);
    // Veränderte Signatur zählt nicht
    expect(knownDevice({ cookies: { [name]: set[name].value.slice(0, -1) + (set[name].value.endsWith('A') ? 'B' : 'A') } } as any, userA)).toBeNull();
    // Gespeichert wird nur ein Hash, je Konto verschieden
    expect(deviceHash(userA, nonce)).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceHash(userA, nonce)).not.toBe(deviceHash(userB, nonce));
    expect(deviceHash(userA, nonce)).not.toContain(nonce);
  });
});

describe('Ordner, Schlagworte und CSV (Medien wie LiFeOS)', () => {
  it('Ordnerpfad, Unterordner, Kreisschutz, Tiefe und ZIP-Verzeichnis', async () => {
    const { folderPath, descendants, wouldCycle, depthAfterMove, zipDir, cleanFolderName } = await import('../src/media/folders.js');
    const f = [
      { id: 'a', parent_id: null, name: 'Einsatz' },
      { id: 'b', parent_id: 'a', name: 'Drohne' },
      { id: 'c', parent_id: 'b', name: 'Nacht:Flug' },
      { id: 'd', parent_id: null, name: 'Presse' },
    ];
    expect(folderPath(f, 'c').map((x) => x.name)).toEqual(['Einsatz', 'Drohne', 'Nacht:Flug']);
    expect(descendants(f, 'a').sort()).toEqual(['b', 'c']);
    expect(wouldCycle(f, 'a', 'c')).toBe(true);
    expect(wouldCycle(f, 'a', 'a')).toBe(true);
    expect(wouldCycle(f, 'b', 'd')).toBe(false);
    expect(wouldCycle(f, 'b', null)).toBe(false);
    expect(depthAfterMove(f, 'a', 'd')).toBe(4);
    expect(zipDir(f, 'c')).toBe('Einsatz/Drohne/Nacht_Flug/');
    expect(zipDir(f, null)).toBe('');
    // Zyklische Altdaten brechen sicher ab
    expect(folderPath([{ id: 'x', parent_id: 'y', name: 'X' }, { id: 'y', parent_id: 'x', name: 'Y' }], 'x').length).toBe(2);
    expect(cleanFolderName('  a/b\\c  ')).toBe('a b c');
    expect(() => cleanFolderName('..')).toThrow();
    expect(() => cleanFolderName('   ')).toThrow();
  });
  it('Schlagworte normalisieren und CSV-Zellen gegen Formel-Injektion absichern', async () => {
    const { cleanTag } = await import('../src/routes/media-organize.js');
    const { csvCell } = await import('../src/media/exports.js');
    expect(cleanTag('  Drehleiter   Nacht ')).toBe('drehleiter nacht');
    expect(cleanTag(' , ')).toBeNull();
    expect(cleanTag('x'.repeat(60))).toHaveLength(40);
    expect(csvCell('=SUMME(A1)')).toBe("'=SUMME(A1)");
    expect(csvCell('+49 123')).toBe("'+49 123");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('sagt "hallo"')).toBe('"sagt ""hallo"""');
    expect(csvCell(['a', 'b'])).toBe('"a, b"');
    expect(csvCell(null)).toBe('');
  });
});

describe('Benachrichtigungen der Medien', () => {
  it('„läuft bald ab“: höchstens 24 h vorher, bei kurzen Links ein Viertel der Gültigkeit, mindestens 1 h', async () => {
    const { expiringThresholdMs } = await import('../src/lib/media-notify.js');
    const t0 = '2026-11-15T00:00:00Z';
    expect(expiringThresholdMs(t0, '2026-11-22T00:00:00Z')).toBe(24 * 3600_000);
    expect(expiringThresholdMs(t0, '2026-11-15T08:00:00Z')).toBe(2 * 3600_000);
    expect(expiringThresholdMs(t0, '2026-11-15T02:00:00Z')).toBe(3600_000);
  });
});

describe('Erweiterte Link-Optionen und Dateitypen', () => {
  it('Felder, Angaben der Hochladenden, Grenzen und Typen', async () => {
    const { cleanFields, cleanUploader, linkIsFull, DEFAULT_FIELDS } = await import('../src/media/link-options.js');
    const { effectiveTypes, acceptAttr, cleanTypeList, typeLabels } = await import('../src/media/types.js');
    expect(cleanFields(null)).toEqual(DEFAULT_FIELDS);
    expect(cleanFields({ name: 'required', email: 'x', bogus: 'required' })).toMatchObject({ name: 'required', email: 'off', note: 'optional' });
    const f = cleanFields({ name: 'required', email: 'optional', place: 'off' });
    expect(cleanUploader(f, { name: ' Erika ', email: '', place: 'Markt' }, '')).toEqual({ name: 'Erika' });
    expect(() => cleanUploader(f, { name: '' }, '')).toThrow(/Name/);
    expect(() => cleanUploader(f, { name: 'A', email: 'kein-mail' }, '')).toThrow(/E-Mail/);
    expect(cleanUploader(cleanFields({}), { name: 'X' }, 'Hinweis')).toBeNull();
    expect(() => cleanUploader(cleanFields({ note: 'required' }), {}, ' ')).toThrow(/Hinweis/);
    expect(linkIsFull({ max_uploads: 2, max_total_bytes: 0 }, { uploads: 2, bytes: 0 })).toBe(true);
    expect(linkIsFull({ max_uploads: 0, max_total_bytes: 100 }, { uploads: 50, bytes: 99 })).toBe(false);
    expect(linkIsFull({ max_uploads: 0, max_total_bytes: 0 }, { uploads: 1e6, bytes: 1e12 })).toBe(false);
    expect(cleanTypeList(['png', 'exe', 'png'])).toEqual(['png']);
    expect(effectiveTypes(['jpeg', 'png'], ['png', 'mp4'])).toEqual(['png']);
    expect(effectiveTypes(['jpeg', 'png'], null)).toEqual(['jpeg', 'png']);
    expect(acceptAttr(['heic', 'mov'])).toBe('image/heic,image/heif,video/quicktime');
    expect(typeLabels(['jpeg', 'mov'])).toBe('JPEG, MOV');
  });
});

describe('Video-Dekodierprüfung (Medien wie LiFeOS)', () => {
  it('kurze Videos Bild für Bild, lange Anfang plus Schlüsselbilder; Audio-Parser-Meldungen sperren nicht', async () => {
    const { decodePlan, decodeErrors } = await import('../src/media/process.js');
    expect(decodePlan(30, 60)).toEqual([[]]);
    expect(decodePlan(600, 60)).toEqual([['-read_intervals', '%+60'], ['-skip_frame', 'nokey']]);
    const streams = [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'opus' }];
    expect(decodeErrors('[opus @ 0x1] Error parsing Opus packet header\n', streams)).toEqual([]);
    expect(decodeErrors('[h264 @ 0x2] Invalid NAL unit size\n\n', streams)).toEqual(['[h264 @ 0x2] Invalid NAL unit size']);
  });
});

describe('Gestaltung der Upload-Seite', () => {
  it('prüft Bausteine streng und ersetzt Platzhalter nur als Text', async () => {
    const { cleanDesign, renderText, resolveDesign } = await import('../src/media/design.js');
    const img = '0b6d2c1e-9a7f-4b8e-8f00-0123456789ab';
    const d = cleanDesign({ accent: 'gruen', blocks: [{ type: 'heading', text: '  Hallo\n{thema}  ' }, { type: 'banner', image: img }, { type: 'upload', extra: 'x' }] });
    expect(d).toEqual({ accent: 'gruen', header: true, blocks: [{ type: 'heading', text: 'Hallo {thema}', size: 'l' }, { type: 'banner', image: img, alt: '', height: 'm' }, { type: 'upload' }] });
    expect(() => cleanDesign({ blocks: [] })).toThrow(/Upload-Bereich/);
    expect(() => cleanDesign({ blocks: [{ type: 'text', text: 'x' }] })).toThrow(/genau einmal/);
    expect(() => cleanDesign({ blocks: [{ type: 'upload' }, { type: 'logo' }] })).toThrow(/Bild/);
    expect(() => cleanDesign({ blocks: [{ type: 'upload' }, { type: 'heading', size: 'xl' }] })).toThrow(/Auswahl/);
    expect(() => cleanDesign({ blocks: [{ type: 'upload' }, { type: 'text', text: 'x'.repeat(2001) }] })).toThrow(/zu lang/);
    expect(() => cleanDesign({ blocks: Array.from({ length: 31 }, () => ({ type: 'divider' })) })).toThrow(/30/);
    expect(() => cleanDesign({ accent: 'pink', blocks: [{ type: 'upload' }] })).toThrow(/Akzentfarbe/);
    expect(renderText('{thema} – {datum}', 'Fest', '2026-07-04')).toBe('Fest – 04.07.2026');
    expect(renderText('{datum}', 'Fest', null)).toBe('');
    expect(resolveDesign(d, '<b>Fest</b>', null).blocks[0].text).toBe('Hallo <b>Fest</b>');
  });
});

describe('Empfangsprotokoll: Schwärzen und Begründungen', () => {
  it('FE2-Meldung: nur Allowlist-Werte bleiben, Personen, Freitext, Koordinaten und Adressen nie', async () => {
    const { redactIncidentPayload } = await import('../src/connections/receipts.js');
    const payload = {
      einsatz: { id: 'E-1', stichwort: 'F-WALD-2', ort: 'Musterstadt', ortsteil: 'Nord', alarmzeit: '2026-11-14T10:00', einheiten: ['HLF 1', { name: 'TLF 2', address: 'RIC-77' }], status: 'offen', strasse: 'Hauptstraße', hausnummer: '12', lat: 50.12345, lng: 8.6789, sachverhalt: 'Person eingeklemmt' },
      meldung: { alarmtext: 'VERTRAULICH Person Max Mustermann Tel 0123 456789', anrufer: { name: 'Erika Musterfrau', telefon: '0171 2345678', ort: 'Nachbarstadt' } },
      melder: 'Erika Musterfrau',
      zusatz: { kontakt: 'max@example.org' },
    };
    const r = redactIncidentPayload(payload, { keepPaths: ['einsatz.id', 'einsatz.stichwort'] }) as any;
    const s = JSON.stringify(r);
    for (const secret of ['Hauptstraße', 'Mustermann', 'Musterfrau', '0123 456789', '0171', 'max@example.org', 'eingeklemmt', '50.12345', '8.6789', 'Nachbarstadt']) expect(s).not.toContain(secret);
    expect(r.einsatz).toMatchObject({ id: 'E-1', stichwort: 'F-WALD-2', ort: 'Musterstadt', ortsteil: 'Nord', alarmzeit: '2026-11-14T10:00', status: 'offen', lat: '‹entfernt: Koordinate›' });
    expect(r.einsatz.einheiten).toEqual(['HLF 1', { name: 'TLF 2', address: 'RIC-77' }]);
    expect(r.einsatz.strasse).toBe('‹ausgeblendet: Text, 11 Zeichen›');
    expect(r.einsatz.hausnummer).toMatch(/^‹ausgeblendet/);
    expect(r.meldung.anrufer.ort).toMatch(/^‹ausgeblendet/);
    // Struktur bleibt sichtbar (für die Feldzuordnung)
    expect(Object.keys(r.meldung)).toEqual(['alarmtext', 'anrufer']);
  });
  it('Feuersoftware-Einsatz: Adresse nur Ort/Ortsteil, ohne Einsatznummer, Sachverhalt, meldende Person', async () => {
    const { redactIncidentPayload } = await import('../src/connections/receipts.js');
    const { normalizeKeys } = await import('../src/connections/feuersoftware.js');
    const op = normalizeKeys({ id: 'FS-1', start: '2026-11-15T10:00:00Z', keyword: 'B3 Wohnungsbrand', category: 'Brand', facts: 'Person bewusstlos', ric: 'Musterwehr Vollalarm', number: '4711-2026', reporter: { name: 'Erika Musterfrau', phoneNumber: '0123 456789' }, address: { street: 'Hauptstraße', houseNumber: '12', city: 'Musterstadt', district: 'Nord', cityWithDistrict: 'Musterstadt - Nord', streetWithHouseNumber: 'Hauptstraße 12', lat: 50.1, lng: 8.6, zipCode: '12345' }, properties: [{ key: 'Patient', value: 'Max Mustermann' }] });
    const r = redactIncidentPayload(op) as any;
    const s = JSON.stringify(r);
    for (const secret of ['Hauptstraße', '4711-2026', 'bewusstlos', 'Musterfrau', 'Mustermann', '0123 456789', '12345', '50.1', '8.6']) expect(s).not.toContain(secret);
    expect(r).toMatchObject({ Id: 'FS-1', Keyword: 'B3 Wohnungsbrand', Category: 'Brand', Ric: 'Musterwehr Vollalarm', Address: { City: 'Musterstadt', District: 'Nord', CityWithDistrict: 'Musterstadt - Nord', Lat: '‹entfernt: Koordinate›' } });
  });
  it('erlaubte Texte werden auf Telefon, E-Mail und Straße mit Hausnummer geprüft', async () => {
    const { scrubText } = await import('../src/connections/receipts.js');
    expect(scrubText('Musterstadt, Hauptstraße 12a')).toBe('Musterstadt, ‹Adresse›');
    expect(scrubText('Rückruf 0171 2345678')).toBe('Rückruf ‹Telefon›');
    expect(scrubText('an a.b@example.org')).toBe('an ‹E-Mail›');
    expect(scrubText('2026-11-14T10:00:00Z')).toBe('2026-11-14T10:00:00Z');
    expect(scrubText('B3 Wohnungsbrand')).toBe('B3 Wohnungsbrand');
  });
  it('Rohdaten: gleiche Inhalte gleiche Prüfsumme, zu große werden gekürzt', async () => {
    const { packRaw, RAW_MAX_BYTES } = await import('../src/connections/receipts.js');
    expect(packRaw({ a: 1 }).hash).toBe(packRaw({ a: 1 }).hash);
    const big = packRaw({ text: 'ä'.repeat(RAW_MAX_BYTES) });
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.body)).toBeLessThanOrEqual(RAW_MAX_BYTES);
    expect(big.bytes).toBeGreaterThan(RAW_MAX_BYTES);
  });
  it('Gebietsfilter, RIC- und Stichwortfilter nennen den Grund', async () => {
    const { areaMatch } = await import('../src/connections/warnfeed.js');
    const w = { geocodes: ['064340000000'], areas: ['Kreis Nachbarland'] };
    expect(areaMatch(w, {})).toMatchObject({ ok: true, reason: expect.stringContaining('Kein Gebietsfilter') });
    expect(areaMatch(w, { codes: ['064360008008'], names: ['Musterstadt'] })).toEqual({ ok: false, reason: 'Gebiet passt nicht: Geocodes der Meldung 064340000000 – eingestellt 064360008008; Orte der Meldung Kreis Nachbarland – eingestellt Musterstadt.' });
    expect(areaMatch({ geocodes: ['060000000000'], areas: [] }, { codes: ['064360008008'] }).reason).toContain('größere Gebiet 060000000000');
    expect(areaMatch({ geocodes: [], areas: ['Musterstadt-Nord'] }, { names: ['Musterstadt'] }).reason).toBe('Gebiet passt: Ortsname „Musterstadt“ in „Musterstadt-Nord“.');
    const { matchReason } = await import('../src/connections/feuersoftware.js');
    expect(matchReason({ Ric: 'Nachbarwehr', Keyword: 'TH 1' }, { rics: ['Musterwehr'], keywords: ['B3'] }).reason).toBe('RIC nicht in der Liste: „Nachbarwehr“ – eingestellt „Musterwehr“; Stichwort nicht in der Liste: „TH 1“ enthält keins von „B3“.');
    expect(matchReason({ Keyword: 'TH 1' }, { keywords: ['B3'] }).reason).toBe('Stichwort nicht in der Liste: „TH 1“ enthält keins von „B3“.');
  });
  it('Ergebnis einer Einsatzmeldung als Entscheidung', async () => {
    const { incidentDecision } = await import('../src/connections/fe2.js');
    expect(incidentDecision({ outcome: 'created', postId: 'p' }, true).decision).toBe('accepted');
    expect(incidentDecision({ outcome: 'created', postId: null }, false).reason).toContain('ohne Beitragsentwurf');
    expect(incidentDecision({ outcome: 'updated', sequence: 2, draft: 'kept' }, true)).toMatchObject({ decision: 'updated', reason: expect.stringContaining('Meldung 2') });
    expect(incidentDecision({ outcome: 'duplicate' }, true).decision).toBe('known');
    expect(incidentDecision({ outcome: 'suppressed' }, true).decision).toBe('suppressed');
    expect(incidentDecision({ outcome: 'ignored' }, true)).toMatchObject({ decision: 'error', reason: expect.stringContaining('Einsatz-ID') });
  });
});
