import { describe, expect, it } from 'vitest';
import { MASK, maskValue, preview } from '../src/lib/mask.js';
import { isPrivateAddress, hostMatches, httpRequest } from '../src/lib/http.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { totpAt, verifyTotp, base32Encode } from '../src/auth/totp.js';
import { permissionsFor, matrix } from '../src/auth/permissions.js';
import { revisionHash } from '../src/routes/posts.js';
import { normalizePublicUrl } from '../src/lib/urls.js';

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
    expect(normalizePublicUrl('https://lifelink.example.org/')).toBe('https://lifelink.example.org');
    expect(normalizePublicUrl('https://example.org/lifelink/')).toBe('https://example.org/lifelink');
    expect(() => normalizePublicUrl('ftp://example.org')).toThrow();
    expect(() => normalizePublicUrl('https://u:p@example.org')).toThrow();
    expect(() => normalizePublicUrl('kein link')).toThrow();
  });
});
