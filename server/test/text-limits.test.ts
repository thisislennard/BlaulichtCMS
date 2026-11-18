import { describe, expect, it } from 'vitest';
import { fitText, utf16Length } from '../src/lib/text.js';
import { blueskyLength, socialText, socialTextTooLong } from '../src/connections/channels.js';
import { renderTemplate } from '../src/automations/logic.js';
import { blueskyLength as webBlueskyLength } from '../../web/src/lib/social.js';
import * as webSocial from '../../web/src/lib/social.js';
import * as shared from '../src/lib/social-text.js';
import fs from 'node:fs';
import path from 'node:path';

/* Kanaltexte und Workflow-Vorlagen kürzen an Zeichengrenzen (#232). Ohne Datenbank. */

/** Einzelnes Surrogat (halbes Emoji)? */
const brokenSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('Kanaltexte und Vorlagen kürzen an Zeichengrenzen (#232)', () => {
  const rev = (channel: string, body: string) => ({ title: 'T', body: 'B', variants: { [channel]: { body } } });

  it('Instagram: Emoji an Position 2200 wird nicht halbiert, Ende mit „…“', () => {
    const t = socialText(rev('instagram', `${'a'.repeat(2199)}🚒 mehr`), 'instagram');
    expect(t.length).toBeLessThanOrEqual(2200);
    expect(brokenSurrogate(t)).toBe(false);
    expect(t.endsWith('…')).toBe(true);
    expect(socialTextTooLong(rev('instagram', `${'a'.repeat(2199)}🚒`), 'instagram')).toBe(true);
    expect(socialText(rev('instagram', 'kurz 🚒'), 'instagram')).toBe('kurz 🚒');
  });

  it('Facebook und WhatsApp: gekürzt an Zeichengrenzen, der Link bleibt vollständig', () => {
    const long = `${'b'.repeat(59_999)}🧑‍🚒 Rest`;
    const fb = socialText(rev('facebook', long), 'facebook');
    expect(fb.length).toBeLessThanOrEqual(60_000);
    expect(brokenSurrogate(fb)).toBe(false);
    const link = 'https://example.org/beitrag/123';
    const wa = socialText(rev('whatsapp', long), 'whatsapp', link);
    expect(wa.length).toBeLessThanOrEqual(60_000);
    expect(wa.endsWith(`…\n\n${link}`)).toBe(true);
    expect(brokenSurrogate(wa)).toBe(false);
  });

  it('Workflow-Vorlagen: maxLength mitten in einem Emoji', () => {
    const r = renderTemplate(`${'a'.repeat(9)}{{x}}`, { x: '🚒🚒' }, { maxLength: 10 });
    expect(r.text.length).toBeLessThanOrEqual(10);
    expect(brokenSurrogate(r.text)).toBe(false);
    expect(r.text).toBe(`${'a'.repeat(9)}…`);
    // unter der Grenze unverändert (auch Leerraum am Rand)
    expect(renderTemplate(' {{x}} ', { x: '🚒' }, { maxLength: 10 }).text).toBe(' 🚒 ');
    expect(fitText('abc', 2, utf16Length)).toBe('a…');
  });

  it('Bluesky: Zähler der Oberfläche beachtet wie der Server die 3000-Byte-Grenze', () => {
    const family = '👨‍👩‍👧‍👦'.repeat(150); // 150 Grapheme, 3750 Bytes
    expect(blueskyLength(family)).toBeGreaterThan(300);
    expect(webBlueskyLength(family)).toBe(blueskyLength(family));
    const plain = 'Wort '.repeat(50);
    expect(webBlueskyLength(plain)).toBe(blueskyLength(plain));
    expect(webBlueskyLength(plain)).toBe(250);
  });

  it('Oberfläche und Server nutzen denselben Code für Zählregeln und gesendeten Text (#262)', () => {
    // Vorschau je Netzwerk und Zeichenzähler im Beitrag: dieselben Funktionen, keine Nachbildung
    for (const k of ['socialText', 'socialTextTooLong', 'channelLength', 'channelMax', 'limitsFor', 'xLength', 'threadsLength', 'mastodonLength', 'blueskyLength'] as const) expect((webSocial as any)[k], k).toBe((shared as any)[k]);
    expect(socialText).toBe(shared.socialText);
    // Die gemeinsame Datei muss im Browser laufen: keine Node- oder Datenbank-Abhängigkeiten
    const src = fs.readFileSync(path.join(__dirname, '../src/lib/social-text.ts'), 'utf8');
    expect(src).not.toMatch(/from 'node:|Buffer\.|from '\.\.\/db|from 'pg'/);
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./text.js']);
    expect(fs.readFileSync(path.join(__dirname, '../src/lib/text.ts'), 'utf8')).not.toMatch(/^import /m);
    // Gekürzt wird im Browser wie auf dem Server
    const rev = { title: 'Titel', body: 'Wort '.repeat(100), variants: {} };
    expect(webSocial.socialText(rev, 'x', 'https://example.org/b')).toBe(socialText(rev, 'x', 'https://example.org/b'));
    expect(webSocial.channelLength('x', webSocial.socialText(rev, 'x'))).toBeLessThanOrEqual(280);
  });
});
