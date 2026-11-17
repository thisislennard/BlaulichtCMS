import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, SETTING_RANGES } from '../src/lib/settings.js';
import { describe, expect, it } from 'vitest';
import { MASK, maskValue, preview } from '../src/lib/mask.js';
import { isPrivateAddress, hostMatches, httpRequest } from '../src/lib/http.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { totpAt, verifyTotp, base32Encode } from '../src/auth/totp.js';
import { permissionsFor } from '../src/auth/permissions.js';
import * as P from '../src/auth/permissions.js';
import { revisionHash } from '../src/routes/posts.js';
import { normalizePublicUrl } from '../src/lib/urls.js';
import { fileSlug, publicFileName } from '../src/media/names.js';
import { availableWidgets, DEFAULT_LAYOUT, layoutIssues, migrateLegacyDesktop, normalizeLayout, resolveLayout, WIDGET_DEFS, widgetPermission } from '../src/lib/dashboard-layout.js';
import { PERMISSIONS } from '../src/auth/permissions.js';

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
    expect(p.has('publish.website')).toBe(true);
    // Sammelbezeichnungen des alten Stands gelten weiter, wenn alle Teile vorhanden sind
    expect(p.has('post.publish')).toBe(true);
    expect(p.has('post.approve')).toBe(false);
    expect(p.has('approval.post')).toBe(false);
    expect(p.has('user.manage')).toBe(false);
    expect(permissionsFor(['gibt_es_nicht']).size).toBe(0);
  });
  it('trennt Warnentwurf, Warnfreigabe und Versand', () => {
    expect(permissionsFor(['warning_author']).has('warning.approve')).toBe(false);
    expect(permissionsFor(['warning_approver']).has('warning.send')).toBe(false);
    expect(permissionsFor(['warning_sender']).has('warning.draft')).toBe(false);
  });
});

describe('Feine Rechte und Rollen (0.3.0)', () => {
  /**
   * Stand vor den feinen Rechten – bewusst hier ausgeschrieben, unabhängig vom Programm: die 20 groben Rechte der
   * Version 0.2.3 und die drei Rechte der Automationen (0.3.0, mit „Automationen ansehen“ für Redaktion und Freigabe).
   */
  const OLD_IDS = ['media.read', 'media.manage', 'media.admin', 'post.read', 'post.edit', 'post.approve', 'post.publish', 'channel.manage', 'warning.draft', 'warning.level', 'warning.approve', 'warning.rules', 'warning.send', 'connection.manage', 'automation.read', 'automation.manage', 'automation.publish', 'user.read', 'user.manage', 'audit.read', 'system.read', 'system.manage', 'privacy.manage'];
  const OLD_ROLES: Record<string, string[]> = {
    platform_admin: OLD_IDS,
    media_manager: ['media.read', 'media.manage', 'post.read'],
    editor: ['media.read', 'media.manage', 'post.read', 'post.edit', 'automation.read'],
    approver: ['media.read', 'post.read', 'post.approve', 'audit.read', 'automation.read'],
    publisher: ['media.read', 'post.read', 'post.publish'],
    warning_author: ['warning.draft'],
    warning_approver: ['warning.draft', 'warning.level', 'warning.approve'],
    warning_sender: ['warning.send'],
    viewer: ['media.read', 'post.read'],
  };
  const ids = P.PERMISSIONS.map((p) => p.id);

  it('Katalog: eindeutige Kennungen, bekannte Bereiche, Voraussetzungen vorhanden und ohne Kreis', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of P.PERMISSIONS) {
      expect(P.MODULES.some((m) => m.id === p.module), p.id).toBe(true);
      expect(p.label.length, p.id).toBeGreaterThan(3);
      expect(p.description.length, p.id).toBeGreaterThan(10);
      for (const r of p.requires ?? []) expect(ids, `${p.id} → ${r}`).toContain(r);
      // Ändern setzt Ansehen voraus: Voraussetzungen sind nie kritischer als das Recht selbst
      const closure = P.withRequirements([p.id]);
      expect(closure).toContain(p.id);
      for (const c of closure) if (c !== p.id) expect(P.withRequirements([c]), `${p.id} ↔ ${c}`).not.toContain(p.id);
    }
    for (const m of P.MODULES) expect(P.PERMISSIONS.some((p) => p.module === m.id), m.id).toBe(true);
    expect(P.withRequirements(['media.design'])).toEqual(['media.view', 'media.links', 'media.design']);
    expect(P.withRequirements(['unbekannt', 'post.edit'])).toEqual(['post.view', 'post.edit']);
  });

  it('Zuordnung alt → neu: jede alte Bezeichnung ist abgebildet, alle Teile existieren', () => {
    expect(Object.keys(P.LEGACY_PERMISSIONS).sort()).toEqual([...OLD_IDS].sort());
    for (const [old, parts] of Object.entries(P.LEGACY_PERMISSIONS)) {
      expect(parts.length, old).toBeGreaterThan(0);
      for (const p of parts) expect(ids, `${old} → ${p}`).toContain(p);
      // abgeschlossen: Voraussetzungen der Teile gehören zur selben alten Bezeichnung
      expect(P.withRequirements(parts).sort(), old).toEqual([...parts].sort());
    }
    // Neue Rechte ohne Vorgänger: nur für die Administration (alle Rechte), eigene Rollen oder als ausdrückliche Vorgabe
    // mitgelieferter Rollen (ROLE_DEFAULT_ADDITIONS)
    const mapped = new Set(Object.values(P.LEGACY_PERMISSIONS).flat());
    expect(ids.filter((p) => !mapped.has(p)).sort()).toEqual(['calendar.manage', 'calendar.sources', 'calendar.subscribe', 'calendar.view', 'connection.private_targets', 'insights.view', 'role.manage', 'settings.mail', 'templates.manage', 'templates.use', 'templates.view', 'warning.delete_sent']);
    for (const [role, extra] of Object.entries(P.ROLE_DEFAULT_ADDITIONS)) for (const p of extra) expect(mapped.has(p), `${role}: ${p}`).toBe(false);
  });

  it('bestehende Rollen behalten genau ihre bisherigen Rechte (alt gegen neu)', () => {
    P.resetActiveRoles();
    for (const [role, old] of Object.entries(OLD_ROLES)) {
      const fine = P.finePermissionsFor([role]);
      if (role === 'platform_admin') {
        expect([...fine].sort()).toEqual([...ids].sort());
      } else {
        // feine Rechte = Vereinigung der Zuordnungen der alten groben Rechte (plus ausdrücklich neue Vorgaben), nicht mehr und nicht weniger
        const expected = new Set([...old.flatMap((o) => P.LEGACY_PERMISSIONS[o]), ...P.withRequirements(P.ROLE_DEFAULT_ADDITIONS[role] ?? [])]);
        expect([...fine].sort(), role).toEqual([...expected].sort());
      }
      // und umgekehrt: als Sammelbezeichnung gelten genau die alten groben Rechte
      const eff = P.permissionsFor([role]);
      expect(OLD_IDS.filter((o) => eff.has(o)).sort(), role).toEqual([...old].sort());
    }
    // Kombinationen: Vereinigung der Einzelrollen
    for (const a of Object.keys(OLD_ROLES)) {
      for (const b of Object.keys(OLD_ROLES)) {
        if (a === 'platform_admin' || b === 'platform_admin') continue;
        const combo = P.finePermissionsFor([a, b]);
        const expected = new Set([...[...OLD_ROLES[a], ...OLD_ROLES[b]].flatMap((o) => P.LEGACY_PERMISSIONS[o]), ...P.withRequirements([...(P.ROLE_DEFAULT_ADDITIONS[a] ?? []), ...(P.ROLE_DEFAULT_ADDITIONS[b] ?? [])])]);
        expect([...combo].sort(), `${a}+${b}`).toEqual([...expected].sort());
      }
    }
  });

  it('Vorgaben der mitgelieferten Rollen (Momentaufnahme)', () => {
    P.resetActiveRoles();
    const snap = Object.fromEntries(P.SYSTEM_ROLES.filter((r) => r.id !== 'platform_admin').map((r) => [r.id, r.permissions.join(' ')]));
    expect(snap).toEqual({
      media_manager:
        'media.view media.export media.download_original media.collections media.upload media.links media.review media.organize media.redact media.trash media.design post.view source.view channel.view banner.view calendar.view calendar.subscribe incident.view official.view templates.view templates.use templates.manage',
      editor:
        'media.view media.export media.download_original media.collections media.upload media.links media.review media.organize media.redact media.trash media.design post.view post.create post.edit post.submit post.archive post.templates source.view source.items source.manage insights.view channel.view banner.view banner.edit calendar.view calendar.manage calendar.sources calendar.subscribe incident.view incident.edit official.view official.dismiss press.view press.manage press.reply press.snippets press.contacts connection.view automation.read templates.view templates.use templates.manage',
      approver: 'media.view media.export post.view source.view approval.post approval.banner approval.incident approval.automation insights.view channel.view banner.view calendar.view calendar.subscribe incident.view official.view press.view press.approve automation.read templates.view audit.view',
      publisher: 'media.view media.export post.view source.view publish.website publish.unpublish publish.social insights.view publish.social_remove channel.view banner.view banner.publish calendar.view calendar.subscribe incident.view incident.publish official.view press.view press.contacts press.release connection.view templates.view',
      warning_author: 'warning.view warning.draft warning.delete',
      warning_approver: 'warning.view warning.draft warning.delete warning.level warning.approve',
      warning_sender: 'warning.view warning.send',
      viewer: 'media.view media.export post.view source.view insights.view channel.view banner.view calendar.view calendar.subscribe incident.view official.view templates.view',
    });
    expect(P.SYSTEM_ROLES.find((r) => r.id === 'platform_admin')!.permissions).toEqual(ids);
  });

  it('Rollenstand: Administration hat immer alle Rechte, eigene Rollen samt Voraussetzungen', () => {
    P.setActiveRoles([
      { id: 'platform_admin', label: 'Administration', description: '', permissions: [], system: true, customized: false },
      { id: 'r_test', label: 'Test', description: '', permissions: ['media.redact', 'gibt.es.nicht'], system: false, customized: false },
    ]);
    expect(P.finePermissionsFor(['platform_admin']).size).toBe(ids.length);
    expect([...P.finePermissionsFor(['r_test'])]).toEqual(['media.view', 'media.redact']);
    // Teilmenge einer alten Bezeichnung zählt nicht als Sammelbezeichnung
    expect(P.permissionsFor(['r_test']).has('media.manage')).toBe(false);
    expect(P.permissionsFor(['r_test']).has('media.read')).toBe(false);
    expect(P.roleExists('editor')).toBe(false);
    // Ohne Eintrag der Administration (leere Tabelle) bleibt sie trotzdem vorhanden
    P.setActiveRoles([]);
    expect(P.finePermissionsFor(['platform_admin']).size).toBe(ids.length);
    P.resetActiveRoles();
    expect(P.roleExists('editor')).toBe(true);
  });

  it('Zwei-Faktor-Pflicht über Rechte: mitgelieferte Rollen wie bisher, eigene Rollen nach ihren Rechten', async () => {
    const { mustUse2fa } = await import('../src/auth/context.js');
    P.resetActiveRoles();
    const s = { ...DEFAULT_SETTINGS, 'security.require_2fa_all': false, 'security.require_2fa_admins': true, 'security.require_2fa_media': true } as any;
    const oldRule = (role: string) => role === 'platform_admin' || OLD_ROLES[role].includes('media.manage');
    for (const role of Object.keys(OLD_ROLES)) {
      expect(mustUse2fa([role], s), role).toBe(oldRule(role));
      expect(mustUse2fa([role], { ...s, 'security.require_2fa_media': false }), role).toBe(role === 'platform_admin');
      expect(P.hasAdminPermissions([role]), role).toBe(role === 'platform_admin');
    }
    P.setActiveRoles([
      { id: 'r_konten', label: 'Kontenpflege', description: '', permissions: ['user.invite'], system: false, customized: false },
      { id: 'r_original', label: 'Originale', description: '', permissions: ['media.download_original'], system: false, customized: false },
      { id: 'r_lesen', label: 'Lesen', description: '', permissions: ['post.view', 'approval.post'], system: false, customized: false },
    ]);
    expect(mustUse2fa(['r_konten'], s)).toBe(true);
    expect(mustUse2fa(['r_konten'], { ...s, 'security.require_2fa_admins': false })).toBe(false);
    expect(mustUse2fa(['r_original'], s)).toBe(true);
    expect(mustUse2fa(['r_original'], { ...s, 'security.require_2fa_media': false })).toBe(false);
    expect(mustUse2fa(['r_lesen'], s)).toBe(false);
    P.resetActiveRoles();
  });

  it('jede Einstellung hat ein vorhandenes Änderungsrecht', () => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) expect(ids, k).toContain(P.settingPermission(k));
    expect(P.settingPermission('security.require_2fa_all')).toBe('settings.security');
    expect(P.settingPermission('privacy.warning_days')).toBe('settings.privacy');
    expect(P.settingPermission('retention.audit_days')).toBe('settings.privacy');
    expect(P.settingPermission('media.max_file_mb')).toBe('settings.media');
    expect(P.settingPermission('editorial.four_eyes')).toBe('settings.editorial');
    expect(P.settingPermission('neu.unbekannt')).toBe('settings.security');
  });

  it('Migration 075 trägt genau die mitgelieferten Rollen ein (spätere Texte per UPDATE, z. B. 210)', () => {
    const dir = path.join(__dirname, '../migrations');
    const sql = fs.readFileSync(path.join(dir, '075_roles.sql'), 'utf8');
    const seeded = [...sql.matchAll(/^\s*\('([a-z_]+)',\s+'([^']+)',\s+'([^']+)', true\)/gm)].map((m) => ({ id: m[1], label: m[2], description: m[3] }));
    // Spätere Migrationen dürfen die Beschreibung einer Systemrolle ersetzen (UPDATE roles SET description = … WHERE id = …)
    for (const f of fs.readdirSync(dir).filter((x) => x > '075' && x.endsWith('.sql')).sort())
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/UPDATE roles SET description = '([^']+)' WHERE id = '([a-z_]+)'/g)) {
        const r = seeded.find((x) => x.id === m[2]);
        if (r) r.description = m[1];
      }
    expect(seeded).toEqual(P.SYSTEM_ROLES.map((r) => ({ id: r.id, label: r.label, description: r.description })));
  });

  it('Hilfe: Tabelle der Rechte in benutzer-rollen.md ist aktuell', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../web/src/pages/help/content/benutzer-rollen.md'), 'utf8');
    const start = doc.indexOf('<!-- rechte:start -->');
    const end = doc.indexOf('<!-- rechte:ende -->');
    expect(start, 'Markierung rechte:start fehlt').toBeGreaterThan(-1);
    expect(doc.slice(start + '<!-- rechte:start -->'.length, end).trim()).toBe(P.permissionTableMarkdown().trim());
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

  it('Mindest-Image vorab aus den Versionshinweisen (Satz von build-release)', async () => {
    const { minImageFromNotes, minImageNote } = await import('../src/updates/core.js');
    expect(minImageFromNotes(`## Neu\n\n---\n\nInstallation: Einstellungen → Updates (signiert). ${minImageNote('0.4.2')}\n`)).toBe('0.4.2');
    // Text eines bereits veröffentlichten Releases (v0.4.0)
    expect(minImageFromNotes('Installation: Einstellungen → Updates (signiert). Neue Image-Basis nötig ab Mindestversion 0.2.0.')).toBe('0.2.0');
    expect(minImageFromNotes('## Neu\n\n- ohne Hinweis')).toBeNull();
    expect(minImageFromNotes(null)).toBeNull();
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
    const { csvCell, csvUncell } = await import('../src/lib/csv.js');
    expect(cleanTag('  Drehleiter   Nacht ')).toBe('drehleiter nacht');
    expect(cleanTag(' , ')).toBeNull();
    expect(cleanTag('x'.repeat(60))).toHaveLength(40);
    expect(csvCell('=SUMME(A1)')).toBe("'=SUMME(A1)");
    expect(csvCell('+49 123')).toBe("'+49 123");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@cmd')).toBe("'@cmd");
    // Tab, Wagenrücklauf und Zeilenumbruch am Anfang (#236: der Presseverteiler kannte den Zeilenumbruch nicht)
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('\r=1+1')).toBe(`"'\r=1+1"`);
    expect(csvCell('\n=1+1')).toBe(`"'\n=1+1"`);
    // Formelzeichen in voller Breite
    expect(csvCell('＝1+1')).toBe("'＝1+1");
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('sagt "hallo"')).toBe('"sagt ""hallo"""');
    expect(csvCell(['a', 'b'])).toBe('"a, b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('F 2')).toBe('F 2');
    // Gegenstück beim Wiedereinlesen: nur das Schutz-Apostroph vor einem Formelzeichen fällt weg
    expect(csvUncell("'=SUMME(A1)")).toBe('=SUMME(A1)');
    expect(csvUncell("'+49 123")).toBe('+49 123');
    expect(csvUncell("'s Gärtchen")).toBe("'s Gärtchen");
    expect(csvUncell('normal')).toBe('normal');
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

describe('Dashboard-Layout (Kennzahlen, Spalten, Vorlagen)', () => {
  const ALL = new Set(PERMISSIONS.map((p) => p.id));
  const EDITOR = permissionsFor(['editor']);
  const ids = (l: { badges: string[]; columns: { widgets: string[] }[]; mobile: string[] }) => [...l.badges, ...l.columns.flatMap((c) => c.widgets), ...l.mobile];

  it('kennt jedes Widget genau einmal und nur mit registriertem Recht', () => {
    expect(new Set(WIDGET_DEFS.map((w) => w.id)).size).toBe(WIDGET_DEFS.length);
    for (const w of WIDGET_DEFS) expect(ALL.has(w.permission), w.id).toBe(true);
    expect(widgetPermission('badge_connection_errors')).toBe('connection.configure');
    expect(widgetPermission('gibt-es-nicht')).toBeNull();
    // Standardlayout: nur bekannte Widgets, Kennzahlen und Kacheln sauber getrennt, übersteht die eigene Prüfung
    expect(layoutIssues(DEFAULT_LAYOUT)).toEqual([]);
    expect(normalizeLayout(DEFAULT_LAYOUT, ALL)).toEqual(DEFAULT_LAYOUT);
    expect(availableWidgets(ALL)).toHaveLength(WIDGET_DEFS.length);
    expect(availableWidgets(ALL, 'badge').every((id) => id.startsWith('badge_'))).toBe(true);
  });

  it('zeigt nur Widgets, für die das Recht da ist', () => {
    expect(availableWidgets(EDITOR)).not.toContain('badge_connection_errors');
    expect(availableWidgets(EDITOR)).toContain('media');
    expect(availableWidgets(permissionsFor(['warning_author']))).toEqual([]);
    const onlyPosts = new Set(['post.view', 'banner.view', 'source.view', 'channel.view']);
    expect(availableWidgets(onlyPosts)).toEqual(['badge_approvals', 'badge_ready', 'badge_banners', 'approvals', 'ready', 'publications', 'sites', 'banners', 'rss']);
    const l = normalizeLayout(DEFAULT_LAYOUT, onlyPosts);
    for (const id of ids(l)) expect(onlyPosts.has(widgetPermission(id)!), id).toBe(true);
    expect(l.badges).toEqual(['badge_approvals', 'badge_ready', 'badge_banners']);
    expect(l.columns).toEqual([
      { weight: 5, widgets: ['publications', 'rss'] },
      { weight: 3, widgets: ['approvals', 'banners', 'sites'] },
    ]);
    expect(l.mobile).toEqual(['approvals', 'ready', 'publications', 'banners']);
    // Ohne jedes Recht bleibt ein leeres, gültiges Layout
    expect(normalizeLayout(DEFAULT_LAYOUT, new Set())).toEqual({ version: 2, badges: [], columns: [{ weight: 5, widgets: [] }, { weight: 3, widgets: [] }], mobile: [] });
  });

  it('überführt alte Layouts (Liste mit Größen) in Spalten', () => {
    // Bisheriges Standardlayout: breite Kachel links in einer breiten Spalte, der Rest verteilt sich in Lesereihenfolge
    const old = { desktop: [{ id: 'media', size: 'l' }, { id: 'approvals', size: 'm' }, { id: 'publications', size: 'm' }, { id: 'uploads', size: 'm' }, { id: 'banners', size: 'm' }, { id: 'rss', size: 'm' }, { id: 'sites', size: 'm' }], mobile: ['approvals', 'ready', 'uploads', 'publications', 'banners'] };
    const l = normalizeLayout(old, ALL);
    expect(l.version).toBe(2);
    expect(l.columns).toEqual([
      { weight: 5, widgets: ['media', 'uploads', 'rss'] },
      { weight: 3, widgets: ['approvals', 'publications', 'banners', 'sites'] },
    ]);
    expect(l.mobile).toEqual(old.mobile);
    // Alte Layouts kannten keine Kennzahlen: Standardreihe, nach Recht gefiltert
    expect(l.badges).toEqual(DEFAULT_LAYOUT.badges);
    expect(normalizeLayout(old, EDITOR).badges).not.toContain('badge_connection_errors');
    // Kein Widget geht verloren, keines kommt hinzu
    expect(l.columns.flatMap((c) => c.widgets).sort()).toEqual(old.desktop.map((w) => w.id).sort());
    // Nur breite Kacheln → eine Spalte; überwiegend kleine → drei Spalten; nur mittlere → zwei gleich breite
    expect(migrateLegacyDesktop([{ id: 'rss', size: 'l' }, { id: 'media', size: 'l' }])).toEqual([{ weight: 3, widgets: ['rss', 'media'] }]);
    expect(migrateLegacyDesktop([{ id: 'rss', size: 's' }, { id: 'sites', size: 's' }, { id: 'banners', size: 's' }, { id: 'ready', size: 'm' }])).toEqual([
      { weight: 3, widgets: ['rss', 'ready'] },
      { weight: 3, widgets: ['sites'] },
      { weight: 3, widgets: ['banners'] },
    ]);
    expect(migrateLegacyDesktop([{ id: 'rss', size: 'm' }, { id: 'approvals', size: 's' }])).toEqual([
      { weight: 3, widgets: ['rss'] },
      { weight: 3, widgets: ['approvals'] },
    ]);
    expect(migrateLegacyDesktop([])).toEqual([]);
    expect(migrateLegacyDesktop('kaputt')).toEqual([]);
    // Altes Layout mit unbekannter Größe, unbekanntem und doppeltem Widget
    expect(normalizeLayout({ desktop: [{ id: 'rss', size: 'xxl' }, { id: 'weg' }, { id: 'rss', size: 'm' }, null, 'x'], mobile: ['rss', 'rss', 'weg'] }, ALL)).toMatchObject({ columns: [{ weight: 3, widgets: ['rss'] }, { weight: 3, widgets: [] }], mobile: ['rss'] });
    // Ein bereits umgestelltes Layout bleibt unverändert (idempotent)
    expect(normalizeLayout(l, ALL)).toEqual(l);
  });

  it('räumt beliebige Eingaben auf: unbekannt, doppelt, falsche Art, zu viele Spalten, falsche Gewichte', () => {
    const l = normalizeLayout(
      {
        badges: ['badge_ready', 'rss', 'badge_ready', 'gibt-es-nicht', 7, 'badge_approvals'],
        columns: [
          { weight: 2, widgets: ['rss', 'badge_ready', 'rss'] },
          { weight: 9, widgets: ['media', 'rss'] },
          'kaputt',
          { weight: 5, widgets: [] },
          { weight: 3, widgets: ['sites'] },
          { weight: 2, widgets: ['banners', 'sites'] },
          { widgets: ['ready'] },
        ],
        mobile: ['rss', 'badge_ready', 'rss', 'ready', '__proto__'],
      },
      ALL,
    );
    expect(l).toEqual({
      version: 2,
      badges: ['badge_ready', 'badge_approvals'],
      // höchstens vier Spalten: Überzählige wandern in die letzte; jedes Widget höchstens einmal; 9 → normal
      columns: [
        { weight: 2, widgets: ['rss'] },
        { weight: 3, widgets: ['media'] },
        { weight: 5, widgets: [] },
        { weight: 3, widgets: ['sites', 'banners', 'ready'] },
      ],
      mobile: ['rss', 'ready'],
    });
    for (const junk of [null, undefined, 'x', 42, [], { columns: 'x' }, { columns: [] }, { badges: {}, columns: [{}], mobile: 1 }]) {
      const n = normalizeLayout(junk, ALL);
      expect(n.version).toBe(2);
      expect(n.columns.length).toBeGreaterThanOrEqual(1);
      expect(ids(n)).toEqual([]);
    }
    // Ohne Rechte-Angabe (Vorlage der Administration) bleiben alle bekannten Widgets erhalten
    expect(normalizeLayout(DEFAULT_LAYOUT, null)).toEqual(DEFAULT_LAYOUT);
  });

  it('prüft beim Speichern die Form streng', () => {
    const ok = { badges: ['badge_ready'], columns: [{ weight: 2, widgets: ['rss'] }, { weight: 5, widgets: [] }], mobile: [] };
    expect(layoutIssues(ok)).toEqual([]);
    expect(layoutIssues({ columns: [{ weight: 3, widgets: [] }] })).toEqual([]);
    // Unbekannte Widgets sind kein Formfehler – sie fallen beim Normalisieren still weg
    expect(layoutIssues({ ...ok, badges: ['gibt-es-nicht'] })).toEqual([]);
    const msg = (v: unknown) => layoutIssues(v).map((i) => `${i.path}: ${i.message}`).join(' | ');
    expect(msg(null)).toMatch(/Layout fehlt/);
    expect(msg({ badges: [] })).toMatch(/Spalten fehlen/);
    expect(msg({ ...ok, columns: [] })).toMatch(/Mindestens eine Spalte/);
    expect(msg({ ...ok, columns: Array.from({ length: 5 }, () => ({ weight: 3, widgets: [] })) })).toMatch(/Höchstens 4 Spalten/);
    for (const weight of [1, 4, '3', null, undefined]) expect(msg({ ...ok, columns: [{ weight, widgets: [] }] }), String(weight)).toMatch(/columns\.0\.weight/);
    expect(msg({ ...ok, columns: [{ weight: 3, widgets: ['rss'] }, { weight: 3, widgets: ['rss'] }] })).toMatch(/mehrfach/);
    expect(msg({ ...ok, columns: [{ weight: 3, widgets: ['rss', 'rss'] }] })).toMatch(/mehrfach/);
    expect(msg({ ...ok, badges: ['badge_ready', 'badge_ready'] })).toMatch(/layout\.badges: Einträge dürfen nur einmal/);
    expect(msg({ ...ok, mobile: ['rss', 'rss'] })).toMatch(/layout\.mobile/);
    expect(msg({ ...ok, badges: 'x' })).toMatch(/layout\.badges: Liste erwartet/);
    expect(msg({ ...ok, columns: [{ weight: 3, widgets: [1] }] })).toMatch(/Widget-Kennungen/);
    expect(msg({ ...ok, columns: ['x'] })).toMatch(/Spalte erwartet/);
    expect(msg({ ...ok, mobile: Array.from({ length: 41 }, (_, i) => `w${i}`) })).toMatch(/Zu viele/);
    // Altes Format wird weiter angenommen
    expect(layoutIssues({ desktop: [{ id: 'rss', size: 'l' }], mobile: ['rss'] })).toEqual([]);
    expect(msg({ desktop: [], mobile: 'x' })).toMatch(/layout\.mobile/);
  });

  it('wählt persönlich vor Rollenvorlage vor allgemeiner Vorlage vor Standard', () => {
    const one = (widgets: string[]) => ({ badges: [], columns: [{ weight: 3, widgets }], mobile: [] });
    const shared = { '*': one(['sites']), editor: one(['rss']), approver: one(['banners']) };
    const pick = (o: any) => {
      const r = resolveLayout({ roles: ['editor'], perms: EDITOR, ...o });
      return [r.source, r.layout.columns[0].widgets.join()];
    };
    expect(pick({ personal: one(['ready']), shared })).toEqual(['personal', 'ready']);
    expect(pick({ shared })).toEqual(['role', 'rss']);
    expect(pick({ shared, roles: ['viewer', 'approver'] })).toEqual(['role', 'banners']);
    expect(pick({ shared, roles: ['viewer'] })).toEqual(['shared', 'sites']);
    expect(pick({ shared: {} })).toEqual(['default', 'media,publications,rss']);
    expect(pick({ shared: null, personal: 'kaputt' })).toEqual(['default', 'media,publications,rss']);
    // Vorlage mit Widgets, für die das Recht fehlt: werden beim Ausliefern entfernt
    const tpl = { badges: ['badge_connection_errors', 'badge_ready'], columns: [{ weight: 5, widgets: ['media', 'rss'] }], mobile: ['media'] };
    const r = resolveLayout({ shared: { '*': tpl }, roles: ['warning_author'], perms: new Set(['post.view', 'banner.view', 'source.view', 'channel.view']) });
    expect(r.layout).toEqual({ version: 2, badges: ['badge_ready'], columns: [{ weight: 5, widgets: ['rss'] }], mobile: [] });
    // Altes gespeichertes Layout als persönliche Einstellung
    const legacy = resolveLayout({ personal: { desktop: [{ id: 'rss', size: 'l' }, { id: 'approvals', size: 's' }], mobile: ['approvals'] }, roles: ['editor'], perms: EDITOR });
    expect(legacy.source).toBe('personal');
    expect(legacy.layout.columns).toEqual([{ weight: 5, widgets: ['rss'] }, { weight: 3, widgets: ['approvals'] }]);
  });
});

describe('Einfache Rückmeldeseite (#194)', () => {
  it('maskiert Text und Link, ohne Skripte', async () => {
    const { simplePage } = await import('../src/lib/error-page.js');
    const html = simplePage('Seite <nicht> gefunden', '"Text" & <b>mehr</b>', { code: '404', link: { href: '/"onmouseover="x', label: 'Zur <Startseite>' } });
    expect(html).toContain('Seite &lt;nicht&gt; gefunden');
    expect(html).toContain('&quot;Text&quot; &amp; &lt;b&gt;mehr&lt;/b&gt;');
    expect(html).toContain('href="/&quot;onmouseover=&quot;x"');
    expect(html).not.toMatch(/<script|<style/);
  });
});

describe('Web Push und Benachrichtigungen (#191)', () => {
  const SUB = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  it('verschlüsselt exakt nach RFC 8291 (Abschnitt 5 und Anhang A)', async () => {
    const { encryptPayload } = await import('../src/lib/webpush.js');
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), SUB, {
      asPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    });
    // Kopf (86 Byte: Salz, Satzgröße 4096, Schlüssellänge, as_public) und Chiffrat aus Anhang A
    expect(out.subarray(0, 86).toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    expect(out.subarray(86).toString('base64url')).toBe('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
    // Gesamte Nachricht aus Abschnitt 5
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    // Ohne feste Werte: zufälliges Salz und Schlüssel, zwei Nachrichten nie gleich
    expect(encryptPayload(Buffer.from('x'), SUB).equals(encryptPayload(Buffer.from('x'), SUB))).toBe(false);
    expect(() => encryptPayload(Buffer.from('x'), { ...SUB, auth: 'kurz' })).toThrow();
  });

  it('VAPID-JWT (ES256) ist mit dem öffentlichen Schlüssel prüfbar', async () => {
    const crypto = await import('node:crypto');
    const { generateVapidKeys, vapidAuthorization } = await import('../src/lib/webpush.js');
    const k = generateVapidKeys();
    const now = Date.UTC(2026, 10, 16);
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', k, 'mailto:a@example.org', now);
    const [, t, key] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(key).toBe(k.publicKey);
    const [hd, cl, sig] = t.split('.');
    expect(JSON.parse(Buffer.from(cl, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:a@example.org' });
    const pub = Buffer.from(k.publicKey, 'base64url');
    const pk = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${hd}.${cl}`), { key: pk, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('Push-Adressen nur bei bekannten Push-Diensten', async () => {
    const { checkPushEndpoint } = await import('../src/lib/webpush.js');
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q', 'https://wns2-par02p.notify.windows.com/w/?token=x']) expect(checkPushEndpoint(ok), ok).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'https://evilfcm.googleapis.com.example.org/x', 'https://10.0.0.1/x', 'https://localhost/x', '', 42]) expect(checkPushEndpoint(bad), String(bad)).toBe(false);
  });

  it('Arten nur mit passendem Recht; Wahl der Person oder Vorgabe, beschränkt auf angebotene Kanäle', async () => {
    const { categoriesFor, categoryFor, chosenChannels, notifyCategory, NOTIFY_CATEGORIES } = await import('../src/lib/notify-categories.js');
    expect(categoriesFor(permissionsFor(['editor'])).map((c) => c.id)).not.toContain('approval');
    expect(categoriesFor(permissionsFor(['approver'])).map((c) => c.id)).toContain('approval');
    expect(categoriesFor(new Set()).map((c) => c.id).sort()).toEqual(['account', 'automation_message']);
    expect(categoryFor(undefined, 'approval.banner')).toBe('approval');
    expect(categoryFor('incident', 'post.edit')).toBe('incident');
    expect(categoryFor('unbekannt', null)).toBeNull();
    expect(chosenChannels(notifyCategory('security')!, { security: ['push', 'mail'] })).toEqual(['push']);
    expect(chosenChannels(notifyCategory('incident')!, {})).toEqual(['push']);
    expect(chosenChannels(notifyCategory('incident')!, { incident: [] })).toEqual([]);
    const ids = new Set(PERMISSIONS.map((p) => p.id));
    for (const c of NOTIFY_CATEGORIES) for (const p of c.permissions) expect(ids.has(p), `${c.id}: ${p}`).toBe(true);
  });

  it('Microsoft-365-Angaben werden formal geprüft', async () => {
    const { m365ConfigProblem } = await import('../src/lib/mail.js');
    const ok = { tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sender: 'x@example.org', clientSecret: 's' };
    expect(m365ConfigProblem(ok)).toBeNull();
    expect(m365ConfigProblem({ ...ok, tenantId: 'contoso.onmicrosoft.com' })).toBeNull();
    expect(m365ConfigProblem({ ...ok, tenantId: '../evil' })).toMatch(/Tenant/);
    expect(m365ConfigProblem({ ...ok, clientId: 'abc' })).toMatch(/Client-ID/);
    expect(m365ConfigProblem({ ...ok, sender: 'kein-postfach' })).toMatch(/Absender/);
    expect(m365ConfigProblem({ ...ok, clientSecret: '' })).toMatch(/Geheimnis/);
    expect(m365ConfigProblem({ ...ok, clientSecret: '' }, false)).toBeNull();
  });
});

describe('Zugangsdaten nie im Klartext (#190)', () => {
  it('erkennt Feldnamen von Zugangsdaten, aber keine Verweise und Zeitpunkte', async () => {
    const { isSecretKey } = await import('../src/lib/secret-audit.js');
    for (const k of ['apiKey', 'appSecret', 'pageToken', 'token', 'password', 'client_secret', 'privateKey', 'auth']) expect(isSecretKey(k), k).toBe(true);
    for (const k of ['password_secret_id', 'token_secret_id', 'secret_id', 'inboundTokenHash', 'tokenExpiresAt', 'keyInPath', 'vapid_public_key', 'oauthState', 'secret_set']) expect(isSecretKey(k), k).toBe(false);
  });
  it('Adressen mit Zugangsdaten werden erkannt', async () => {
    const { noUrlCredentials } = await import('../src/lib/urls.js');
    expect(noUrlCredentials('https://feed.example.org/rss')).toBe(true);
    expect(noUrlCredentials('')).toBe(true);
    expect(noUrlCredentials('https://nutzer:pw@feed.example.org/rss')).toBe(false);
    expect(noUrlCredentials('https://nutzer@feed.example.org/rss')).toBe(false);
  });
  it('das Systemprotokoll maskiert Zugangsdaten in Details und Text', async () => {
    const { log } = await import('../src/lib/log.js');
    const lines: string[] = [];
    const orig = console.warn;
    const quiet = process.env.LOG_QUIET;
    delete process.env.LOG_QUIET;
    console.warn = (l: string) => lines.push(l);
    try {
      log('warn', 'test', 'Fehler mit Bearer abcdefghijklmnopqrstuvwxyz', { clientSecret: 'geheim-wert', nested: { apiKey: 'k-123456' }, ok: 'sichtbar' });
    } finally {
      console.warn = orig;
      if (quiet !== undefined) process.env.LOG_QUIET = quiet;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('geheim-wert');
    expect(lines[0]).not.toContain('k-123456');
    expect(lines[0]).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(lines[0]).toContain('sichtbar');
  });
});

describe('Soziale Kanäle: OAuth 1.0a, Zeichenzählung, Texte (#188, #189)', async () => {
  const { oauth1Sign, oauth1Header, pct } = await import('../src/connections/x.js');
  const ch = await import('../src/connections/channels.js');
  it('OAuth-1.0a-Signatur stimmt mit dem bekannten Testvektor der X-Dokumentation überein', () => {
    // „Creating a signature“ (developer.x.com, früher developer.twitter.com): bekannte Eingaben und Ergebnis
    const creds = { consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' };
    const opts = { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 };
    const r = oauth1Sign('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', creds, { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' }, opts);
    expect(r.signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
    expect(r.base).toContain('POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key');
    const h = oauth1Header('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', creds, { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' }, opts);
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(h.startsWith('OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"')).toBe(true);
    expect(pct("a b!*'()")).toBe('a%20b%21%2A%27%28%29');
  });
  it('X: Adressen zählen 23, Emojis 2, Kürzen hält den Link vollständig', () => {
    expect(ch.xLength('Hallo')).toBe(5);
    expect(ch.xLength('Mehr: https://example.org/eine/sehr/lange/adresse/zum/beitrag')).toBe(6 + 23);
    expect(ch.xLength('🚒')).toBe(2);
    expect(ch.xLength('日本')).toBe(4);
    const long = 'Wort '.repeat(100);
    const t = ch.socialText({ title: 'Titel', body: long }, 'x', 'https://example.org/beitrag');
    expect(ch.xLength(t)).toBeLessThanOrEqual(280);
    expect(t.endsWith('\n\nhttps://example.org/beitrag')).toBe(true);
    expect(t).toContain('…');
    // Kurz bleibt unverändert; ein schon enthaltener Link wird nicht doppelt angehängt
    expect(ch.socialText({ title: 'T', body: 'Text https://example.org/beitrag', variants: { x: { body: 'Kurz https://example.org/beitrag' } } }, 'x', 'https://example.org/beitrag')).toBe('Kurz https://example.org/beitrag');
  });
  it('Threads: höchstens 500 Zeichen (Emojis nach UTF-8-Bytes), WhatsApp mit fettem Titel', () => {
    expect(ch.threadsLength('🚒a')).toBe(5);
    const t = ch.socialText({ title: 'T', body: 'x'.repeat(800) }, 'threads', null);
    expect(ch.threadsLength(t)).toBe(500);
    expect(ch.socialText({ title: 'Brand *Nord*', body: 'Text', excerpt: '' }, 'whatsapp', 'https://example.org/b')).toBe('*Brand Nord*\n\nText\n\nhttps://example.org/b');
    // Facebook und Instagram wie bisher
    expect(ch.socialText({ title: 'T', body: 'B', excerpt: 'K' }, 'facebook')).toBe('T\n\nK');
  });
  it('Formate, Teilen von Hand, Wiedererkennung', () => {
    expect(ch.formatsFor('instagram', 'both')).toEqual(['feed', 'story']);
    expect(ch.formatsFor('facebook', 'story')).toEqual(['story']);
    expect(ch.formatsFor('x', 'story')).toEqual(['feed']);
    expect(ch.isManualChannel({ kind: 'x', config: {} })).toBe(true);
    expect(ch.isManualChannel({ kind: 'x', config: { mode: 'api' } })).toBe(false);
    expect(ch.isManualChannel({ kind: 'whatsapp', config: {} })).toBe(true);
    expect(ch.markerFor('Text https://example.org/a', 'x')).toBe(ch.markerFor('Text https://t.co/xyz', 'x'));
    expect(ch.shareTarget({ kind: 'x', config: {} }, 'A & B').openUrl).toBe('https://x.com/intent/post?text=A%20%26%20B');
    expect(ch.shareTarget({ kind: 'whatsapp', config: { channelUrl: 'https://whatsapp.com/channel/0029Va' } }, 'x').openUrl).toBe('https://whatsapp.com/channel/0029Va');
    expect(ch.shareTarget({ kind: 'whatsapp', config: { channelUrl: 'javascript:alert(1)' } }, 'x').openUrl).toBe('https://web.whatsapp.com/');
  });
});

describe('Mastodon und Bluesky: Zählung, Facetten, Instanz (#215)', async () => {
  const ch = await import('../src/connections/channels.js');
  const md = await import('../src/connections/mastodon.js');
  const bs = await import('../src/connections/bluesky.js');
  it('Mastodon: Grapheme, Adressen zählen 23, Höchstlänge der Instanz abzüglich Inhaltswarnung', () => {
    expect(ch.mastodonLength('Hallo 🚒')).toBe(7);
    expect(ch.mastodonLength('Mehr: https://example.org/eine/sehr/lange/adresse')).toBe(6 + 23);
    const rev = { title: 'T', body: 'Wort '.repeat(200), variants: { mastodon: { cw: 'Hinweis: Rauch' } } };
    const t = ch.socialText(rev, 'mastodon', 'https://example.org/b', { max: 500 });
    expect(ch.mastodonLength(t) + ch.mastodonLength('Hinweis: Rauch')).toBeLessThanOrEqual(500);
    expect(t.endsWith('https://example.org/b')).toBe(true);
    expect(ch.socialTextTooLong(rev, 'mastodon', null, { max: 500 })).toBe(true);
    expect(ch.socialTextTooLong(rev, 'mastodon', null, { max: 5000 })).toBe(false);
    expect(ch.limitsFor({ kind: 'mastodon', capabilities: { max_characters: 1000 } })).toEqual({ max: 1000 });
    expect(ch.limitsFor({ kind: 'mastodon', capabilities: {} })).toEqual({ max: 500 });
    expect(ch.contentWarning({ title: 'T', body: '', variants: { mastodon: { cw: '  CW  ' } } })).toBe('CW');
  });
  it('Mastodon: Instanz nur als https-Adresse ohne Pfad; HTML-Text für die Wiedererkennung', () => {
    expect(md.normalizeInstance('social.bund.de')).toBe('https://social.bund.de');
    expect(md.normalizeInstance('https://social.bund.de/')).toBe('https://social.bund.de');
    expect(md.normalizeInstance('http://social.bund.de')).toBeNull();
    expect(md.normalizeInstance('https://social.bund.de/@feuerwehr')).toBeNull();
    expect(md.normalizeInstance('https://user:pw@social.bund.de')).toBeNull();
    const html = '<p>Brand &amp; Rauch</p><p>Mehr: <a href="https://example.org/b"><span class="invisible">https://</span><span>example.org/b</span></a><br>#Feuerwehr</p>';
    const plain = ['Brand & Rauch', '', 'Mehr: https://example.org/b', '#Feuerwehr'].join(String.fromCharCode(10));
    expect(md.mastodonHtmlToText(html)).toBe(plain);
    expect(ch.markerFor(md.mastodonHtmlToText(html), 'mastodon')).toBe(ch.markerFor(plain, 'mastodon'));
    expect(md.mastodonMedia([{ kind: 'image' }, { kind: 'video', id: 'v' }, { kind: 'image' }])).toEqual([{ kind: 'video', id: 'v' }]);
    expect(md.mastodonMedia(Array.from({ length: 6 }, () => ({ kind: 'image' })), 4)).toHaveLength(4);
  });
  it('Bluesky: 300 Grapheme, Facetten mit Byte-Positionen (UTF-8) für Links und Hashtags', () => {
    expect(ch.blueskyLength('Grüße 🚒')).toBe(7);
    expect(ch.blueskyLength('ä'.repeat(1600))).toBeGreaterThan(300);
    const t = ch.socialText({ title: 'T', body: 'Wort '.repeat(100) }, 'bluesky', 'https://example.org/b');
    expect(ch.blueskyLength(t)).toBeLessThanOrEqual(300);
    const text = 'Übung 🚒 heute: https://example.org/b. #Feuerwehr';
    const f = bs.blueskyFacets(text);
    const bytes = Buffer.from(text, 'utf8');
    expect(f).toHaveLength(2);
    expect(bytes.subarray(f[0].index.byteStart, f[0].index.byteEnd).toString()).toBe('https://example.org/b');
    expect(f[0].features[0]).toEqual({ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.org/b' });
    expect(bytes.subarray(f[1].index.byteStart, f[1].index.byteEnd).toString()).toBe('#Feuerwehr');
    expect(f[1].features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'Feuerwehr' });
    expect(bs.normalizeService('')).toBe('https://bsky.social');
    expect(bs.normalizeService('http://pds.example')).toBeNull();
  });
});

describe('Reichweite: Stufen und Kennzahlen (#218)', async () => {
  const ins = await import('../src/connections/insights.js');
  it('Stufen nach 1 h, 24 h, 7 Tagen; nur bekannte, nicht negative Zahlen; X nur ausdrücklich', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(ins.stageFor(new Date(now - 59 * 60_000), now)).toBe(0);
    expect(ins.stageFor(new Date(now - 61 * 60_000), now)).toBe(1);
    expect(ins.stageFor(new Date(now - 25 * 3600_000), now)).toBe(2);
    expect(ins.stageFor(new Date(now - 7 * 86_400_000), now)).toBe(3);
    expect(ins.cleanMetrics({ likes: 3.4, views: -1, follower_names: ['x'], replies: null, shares: 2 })).toEqual({ likes: 3, shares: 2 });
    expect(ins.interactions({ views: 1000, reach: 900, clicks: 5, likes: 3, replies: 1, reposts: 2, quotes: 1, shares: 4, saves: 1 })).toBe(12);
    expect(ins.insightsEnabled({ kind: 'x', config: { mode: 'api' } })).toBe(false);
    expect(ins.insightsEnabled({ kind: 'x', config: { mode: 'api', insights: true } })).toBe(true);
    expect(ins.insightsEnabled({ kind: 'x', config: { mode: 'manual', insights: true } })).toBe(false);
    expect(ins.insightsEnabled({ kind: 'mastodon', config: {} })).toBe(true);
    expect(ins.insightsEnabled({ kind: 'facebook', config: { insights: false } })).toBe(false);
    expect(ins.insightsEnabled({ kind: 'whatsapp', config: {} })).toBe(false);
  });
});

describe('Leistung (#192)', () => {
  it('Argon2 läuft asynchron und höchstens ARGON2_SLOTS-mal gleichzeitig (Threadpool bleibt frei)', async () => {
    const pw = await import('../src/auth/passwords.js');
    // Nur die asynchronen Funktionen: hashSync/verifySync würden die Ereignisschleife je Anmeldung blockieren
    const src = fs.readFileSync(new URL('../src/auth/passwords.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\b(hashSync|verifySync|hashRawSync)\b/);
    const stored = await pw.hashPassword('ein langes Testpasswort');
    pw.resetArgon2Peak();
    // Ereignisschleife reagiert, während 7 Prüfungen laufen
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => pw.verifyPassword(stored, i === 3 ? 'ein langes Testpasswort' : 'falsch')));
    clearInterval(timer);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[3]).toBe(true);
    expect(pw.argon2Stats().peak).toBeLessThanOrEqual(pw.ARGON2_SLOTS);
    expect(pw.argon2Stats()).toMatchObject({ active: 0, waiting: 0 });
    expect(ticks).toBeGreaterThan(0);
  });

  it('volle Warteschlange: Anmeldung antwortet sofort mit 503 statt zu blockieren', async () => {
    const pw = await import('../src/auth/passwords.js');
    const stored = await pw.hashPassword('ein langes Testpasswort');
    const n = pw.ARGON2_SLOTS + pw.ARGON2_MAX_WAITING + 3;
    const settled = await Promise.allSettled(Array.from({ length: n }, () => pw.verifyPassword(stored, 'falsch')));
    const rejected = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toMatchObject({ status: 503, code: 'busy' });
    expect(pw.argon2Stats()).toMatchObject({ active: 0, waiting: 0 });
  }, 60_000);

  it('erkennt X-Forwarded-For von einem nicht eingetragenen Proxy', async () => {
    const { observeProxy, proxyService, resetProxyObservation } = await import('../src/lib/proxy-check.js');
    resetProxyObservation();
    const req = (remote: string, ip: string, xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote }, ip }) as any;
    observeProxy(req('172.18.0.5', '172.18.0.5'));
    expect(proxyService().state).toBe('ok');
    // vertrauenswürdig: req.ip ist die Client-Adresse
    observeProxy(req('172.18.0.5', '203.0.113.7', '203.0.113.7'));
    expect(proxyService()).toMatchObject({ state: 'ok', detail: expect.stringContaining('vertrauenswürdigen') });
    // nicht eingetragen: Header ignoriert, alle erscheinen als Proxy-Adresse
    observeProxy(req('::ffff:172.18.0.5', '::ffff:172.18.0.5', '203.0.113.7'));
    const s = proxyService();
    expect(s.state).toBe('warning');
    expect(s.detail).toContain('TRUSTED_PROXIES=172.18.0.5');
    expect(proxyService(Date.now() + 25 * 3600_000).state).toBe('ok');
    resetProxyObservation();
  });
});

describe('Web-App-Manifest (#197)', () => {
  const pub = path.join(__dirname, '../../web/public');
  const m = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
  const pngSize = (file: string) => {
    const b = fs.readFileSync(path.join(pub, file));
    expect(b.subarray(1, 4).toString()).toBe('PNG');
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  };
  it('ist am Desktop und auf Mobilgeräten installierbar', () => {
    expect(m).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', name: 'BlaulichtCMS' });
    expect(m.icons.some((i: any) => i.sizes === '192x192' && i.purpose !== 'maskable')).toBe(true);
    expect(m.icons.some((i: any) => i.sizes === '512x512' && i.purpose !== 'maskable')).toBe(true);
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    for (const i of m.icons) expect(pngSize(i.src.slice(1))).toBe(i.sizes);
  });
  it('hat Screenshots für den ausführlichen Installationsdialog (breit und schmal) in passender Größe', () => {
    for (const f of ['wide', 'narrow']) expect(m.screenshots.some((s: any) => s.form_factor === f)).toBe(true);
    for (const s of m.screenshots) {
      const size = pngSize(s.src.slice(1));
      expect(size).toBe(s.sizes);
      const [w, h] = size.split('x').map(Number);
      expect(Math.min(w, h)).toBeGreaterThanOrEqual(320);
      expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
      expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(2.3);
      expect(s.form_factor === 'wide' ? w > h : h > w).toBe(true);
    }
  });
  it('Schnellzugriffe zeigen nur auf eigene Pfade', () => {
    for (const s of m.shortcuts) expect(s.url).toMatch(/^\/(?!\/)/);
  });
});

describe('Einsatzliste: Ort nur grob, CSV und Datum (#213)', () => {
  it('Ort: Allowlist mit Wortabgleich, ohne Liste keine Adressen', async () => {
    const { coarseLocation, looksLikeAddress } = await import('../src/incidents/list.js');
    expect(coarseLocation('Gartenstraße , Musterstadt', ['Musterstadt', 'Nord'])).toEqual({ value: 'Musterstadt', removed: false });
    expect(coarseLocation('nord', ['Musterstadt', 'Nord'])).toEqual({ value: 'Nord', removed: false });
    expect(coarseLocation('Alt Oberdorf', ['Oberdorf'])).toEqual({ value: 'Oberdorf', removed: false });
    expect(coarseLocation('Hauptstraße 5', ['Nord'])).toEqual({ value: '', removed: true });
    expect(coarseLocation('Gartenstraße, Musterstadt', [])).toEqual({ value: 'Musterstadt', removed: false });
    expect(coarseLocation('Im Brühl', [])).toEqual({ value: '', removed: true });
    expect(coarseLocation('Nord', [])).toEqual({ value: 'Nord', removed: false });
    for (const a of ['Hauptstr. 1', '65835 Musterstadt', 'Steinmühlenweg', 'An der Untermühle', 'Marktplatz']) expect(looksLikeAddress(a), a).toBe(true);
    for (const a of ['Musterstadt', 'Oberdorf', 'Nord']) expect(looksLikeAddress(a), a).toBe(false);
  });

  it('CSV: Trennzeichen, Anführungszeichen, Ortszeit', async () => {
    const { parseCsv, parseLocalDate, parseIncidentCsv } = await import('../src/incidents/list.js');
    expect(parseCsv('a;b\n"x;1";"y ""z"""\n')).toEqual([['a', 'b'], ['x;1', 'y "z"']]);
    expect(parseCsv('a,b\r\n1,"zwei\nZeilen"')).toEqual([['a', 'b'], ['1', 'zwei\nZeilen']]);
    expect(parseLocalDate('14.11.2026 14:30', '', 'Europe/Berlin')!.toISOString()).toBe('2026-11-14T13:30:00.000Z');
    expect(parseLocalDate('2026-07-01', '08:15', 'Europe/Berlin')!.toISOString()).toBe('2026-07-01T06:15:00.000Z');
    expect(parseLocalDate('31.13.2026', '', 'Europe/Berlin')).toBeNull();
    const r = parseIncidentCsv('Datum;Uhrzeit;Stichwort;Einsatzmeldung;Ort\n01.02.2026;07:05;F 1;Mülltonne;Nord', 'Europe/Berlin');
    expect(r.rows[0]).toMatchObject({ keyword: 'F 1', title: 'Mülltonne', location: 'Nord', number: null });
    expect(r.rows[0].alarmAt.toISOString()).toBe('2026-02-01T06:05:00.000Z');
  });

  it('CSV (#233): ungültige Tage rollen nicht in den Folgemonat, Zeilennummern zählen mehrzeilige Felder mit', async () => {
    const { parseCsvRecords, parseLocalDate, parseIncidentCsv } = await import('../src/incidents/list.js');
    for (const d of ['31.04.2026', '30.02.2028', '29.02.2026', '2026-04-31', '31.06.2026 10:00']) expect(parseLocalDate(d, '', 'Europe/Berlin'), d).toBeNull();
    expect(parseLocalDate('29.02.2028', '', 'Europe/Berlin')!.toISOString()).toBe('2028-02-28T23:00:00.000Z');
    expect(parseLocalDate('30.04.2026', '23:59', 'Europe/Berlin')!.toISOString()).toBe('2026-04-30T21:59:00.000Z');
    // Datensatz-Anfang je physischer Zeile: Umbruch im Feld (LF und CRLF) und Leerzeilen zählen mit
    expect(parseCsvRecords('a;b\r\n1;"zwei\r\nZeilen"\r\n\r\n3;x\n"vier\nfünf\nsechs";y\n7;z').map((r) => r.line)).toEqual([1, 2, 5, 6, 9]);
    const csv = ['Datum;Stichwort;Einsatzmeldung;Bericht', '01.04.2026;F 1;Brand;"Zeile eins', 'Zeile zwei"', '31.04.2026;F 2;Brand;x', '02.04.2026;;;"a', 'b', 'c"', '03.04.2026;H 1;Hilfe;'].join('\n');
    const r = parseIncidentCsv(csv, 'Europe/Berlin');
    expect(r.errors).toEqual(['Zeile 4: Datum „31.04.2026“ nicht lesbar oder ungültig – übersprungen.', 'Zeile 5: weder Einsatzart noch Einsatzmeldung – übersprungen.']);
    expect(r.rows.map((x) => x.line)).toEqual([2, 8]);
    expect(r.rows[0].report).toBe('Zeile eins\nZeile zwei');
  });
});

describe('Zeitangaben in der eingestellten Zeitzone (#224)', async () => {
  const f = await import('../../web/src/lib/format.js');
  it('ISO-Zeitpunkte im Verlaufstext werden lesbar – auch nach einem Wechsel der Zeitzone', () => {
    f.setTimeZone('Europe/Berlin');
    expect(f.fmtIsoInText('Frist: 2026-11-15T22:26:51.000Z → 2026-07-01T08:00:00.000Z')).toBe('Frist: 15.11.2026, 23:26 → 01.07.2026, 10:00');
    expect(f.fmtIsoInText('Frist: – → 2026-11-15T22:26:51Z')).toBe('Frist: – → 15.11.2026, 23:26');
    f.setTimeZone('America/New_York');
    expect(f.fmtIsoInText('Frist: 2026-11-15T22:26:51.000Z → –')).toBe('Frist: 15.11.2026, 17:26 → –');
    f.setTimeZone('Europe/Berlin');
    // Keine Zeitpunkte: unverändert (Datum ohne Uhrzeit, Uhrzeit ohne Zeitzone, Kennungen)
    for (const s of ['Status: neu → in Bearbeitung', 'Termin 2026-11-15', 'lokal 2026-11-15T10:00', 'id-2026-11-15T10:00:00Zx', '']) expect(f.fmtIsoInText(s)).toBe(s);
    expect(f.fmtIsoInText(null)).toBe('');
  });
  it('Eingabefelder rechnen in der Zeitzone der Instanz (z. B. Ablauf eines Upload-Links)', () => {
    f.setTimeZone('Europe/Berlin');
    expect(f.fromLocalInput('2026-11-20T18:00')).toBe('2026-11-20T17:00:00.000Z');
    expect(f.toLocalInput('2026-07-01T08:00:00.000Z')).toBe('2026-07-01T10:00');
    f.setTimeZone('Europe/London');
    expect(f.fromLocalInput('2026-11-20T18:00')).toBe('2026-11-20T18:00:00.000Z');
    f.setTimeZone('Europe/Berlin');
  });
});

describe('Kennzeichen von Hand anklicken (#223)', async () => {
  const { plateBox, PLATE_WIDTH } = await import('../../web/src/pages/media/plateBox.js');
  it('setzt einen Bereich in Kennzeichenform mittig auf den Klickpunkt', () => {
    // Querformat 3:2 → Höhe = Breite · 1,5 / 4 (in Bildanteilen)
    const b = plateBox({ x: 0.5, y: 0.5 }, 1.5, 'm');
    expect(b.w).toBeCloseTo(PLATE_WIDTH.m);
    expect(b.h).toBeCloseTo((PLATE_WIDTH.m * 1.5) / 4);
    expect(b.x + b.w / 2).toBeCloseTo(0.5);
    expect(b.y + b.h / 2).toBeCloseTo(0.5);
    // Im Pixelmaß bleibt das Verhältnis 4:1 – auch im Hochformat
    const t = plateBox({ x: 0.3, y: 0.7 }, 0.75, 'l');
    expect((t.w * 0.75) / t.h).toBeCloseTo(4);
  });
  it('bleibt am Bildrand vollständig im Bild (gültig für den Server)', () => {
    for (const at of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.99, y: 0.02 }]) {
      for (const size of ['s', 'm', 'l'] as const) {
        const b = plateBox(at, 1.5, size);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(1.0001);
        expect(b.y + b.h).toBeLessThanOrEqual(1.0001);
        expect(b.w).toBeGreaterThan(0);
      }
    }
    expect(plateBox({ x: 0.5, y: 0.5 }, NaN, 's').h).toBeGreaterThan(0);
  });
});
