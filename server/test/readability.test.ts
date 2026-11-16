import { describe, expect, it } from 'vitest';
import { fleschLabel, hints, scores, sentences, syllables, words } from '../../web/src/lib/readability.js';
import { cleanMediaAlt, effectiveAlt, kindSupportsAlt } from '../src/lib/accessibility.js';

describe('Lesbarkeit für Deutsch (#217)', () => {
  it('Silben: Vokalgruppen, Zwielaute und Doppelvokale als eine Silbe', () => {
    const cases: [string, number][] = [
      ['Haus', 1],
      ['Feuerwehr', 3],
      ['Bäume', 2],
      ['Situation', 5],
      ['Brandmeldeanlage', 6],
      ['Qualität', 3],
      ['Dienstag', 2],
      ['Boot', 1],
      ['Einsatz', 2],
      ['Rauchmelder', 3],
      ['Straße', 2],
      ['Übung', 2],
      ['THW', 1],
    ];
    for (const [w, n] of cases) expect(syllables(w), w).toBe(n);
  });

  it('Wörter und Sätze: Adressen, Zahlen und Abkürzungen beenden keinen Satz', () => {
    expect(words('Am 3. Oktober, ca. 14 Uhr: https://example.org/x Brand!')).toEqual(['Am', 'Oktober', 'ca', 'Uhr', 'Brand']);
    expect(sentences('Wir kommen z. B. am 3. Oktober. Bitte Rauchmelder prüfen! Fragen?')).toHaveLength(3);
    expect(sentences('Absatz eins ohne Punkt\n\nAbsatz zwei')).toHaveLength(2);
  });

  it('Flesch-Amstad und Wiener Sachtextformel nach den veröffentlichten Formeln', () => {
    const s = scores('Das Haus brennt. Die Feuerwehr kommt.')!;
    // 6 Wörter, 2 Sätze, 8 Silben: FRE = 180 − 3 − 58,5 × 8/6 = 99
    expect(s).toMatchObject({ words: 6, sentences: 2, wordsPerSentence: 3, flesch: 99 });
    // WSTF = 0,1935·16,67 + 0,1672·3 + 0,1297·16,67 − 0,0327·83,33 − 0,875 ≈ 2,3
    expect(s.wiener).toBeCloseTo(2.3, 1);
    const hard = scores('Die Inbetriebnahme der Brandmeldeanlage erfolgte nach Abstimmung mit der zuständigen Genehmigungsbehörde unter Berücksichtigung sämtlicher brandschutztechnischer Anforderungen der Versammlungsstättenverordnung.')!;
    expect(hard.flesch).toBeLessThan(30);
    expect(hard.wiener).toBeGreaterThan(14);
    expect(fleschLabel(hard.flesch)).toBe('sehr schwer');
    expect(fleschLabel(99)).toBe('sehr leicht');
    expect(scores('')).toBeNull();
  });

  it('Hinweise: lange Sätze und Wörter, Abkürzungen, Linktexte, Emojis, Hashtags, Gliederung', () => {
    const long = 'Die Feuerwehr war heute mit vielen Kräften und mehreren Fahrzeugen sehr lange an der Einsatzstelle in der Altstadt vor Ort und hat dort viel geholfen.';
    const kinds = (t: string) => hints(t).map((h) => h.kind);
    expect(kinds(long)).toContain('long_sentence');
    expect(kinds('Die Atemschutzgeräteträger waren da.')).toEqual(expect.arrayContaining(['long_word', 'jargon']));
    const abbr = hints('Das HLF und die DLK fuhren z. B. zur BMA. Das THW half.').find((h) => h.kind === 'abbreviation')!;
    expect(abbr.examples).toEqual(expect.arrayContaining(['HLF', 'DLK', 'BMA', 'z.B.']));
    expect(abbr.examples).not.toContain('THW');
    expect(kinds('Mehr Infos hier: https://example.org/rauchmelder')).toContain('link_text');
    expect(kinds('Hinweise zum Rauchmelder: https://example.org/rauchmelder')).not.toContain('link_text');
    expect(kinds('Danke 🚒🚒🚒🚒')).toContain('emoji');
    expect(hints('Bis bald #feuerwehrmusterstadt #FeuerwehrNord').find((h) => h.kind === 'hashtag')!.examples).toEqual(['#feuerwehrmusterstadt']);
    expect(kinds('ACHTUNG Unwetter')).toContain('caps');
    expect(kinds(Array.from({ length: 320 }, () => 'Wort').join(' ') + '.')).toContain('structure');
    expect(hints('Das Haus brennt. Die Feuerwehr kommt.')).toEqual([]);
  });
});

describe('Alternativtexte (#217)', () => {
  it('nur Dateien der Fassung, getrimmt, leere fallen weg; Fassung vor Medienverwaltung', () => {
    expect(cleanMediaAlt({ a: '  Löschfahrzeug  vor dem Gerätehaus ', b: '   ', c: 'fremd' }, ['b', 'a'])).toEqual({ a: 'Löschfahrzeug vor dem Gerätehaus' });
    expect(effectiveAlt({ media_alt: { a: 'Aus der Fassung' } }, { id: 'a', alt_text: 'Aus der Mediathek' })).toBe('Aus der Fassung');
    expect(effectiveAlt({ media_alt: {} }, { id: 'a', alt_text: 'Aus der Mediathek' })).toBe('Aus der Mediathek');
    expect(kindSupportsAlt('instagram', {}, 'story')).toBe(false);
    expect(kindSupportsAlt('x', {})).toBe(false);
    expect(kindSupportsAlt('x', { mode: 'api' })).toBe(true);
    expect(kindSupportsAlt('whatsapp', {})).toBe(false);
    expect(kindSupportsAlt('bluesky', {})).toBe(true);
  });
});
