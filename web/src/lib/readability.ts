/**
 * Lesbarkeitshinweise für deutsche Texte (#217) – nur Hinweise, keine KI, keine Pflicht.
 *
 * - Flesch-Lesbarkeitsindex in der deutschen Anpassung nach Toni Amstad (1978):
 *   FRE = 180 − ASL − 58,5 × ASW (ASL = Wörter je Satz, ASW = Silben je Wort). 0 = sehr schwer, 100 = sehr leicht.
 * - Erste Wiener Sachtextformel (Bamberger/Vanecek 1984):
 *   WSTF = 0,1935 × MS + 0,1672 × SL + 0,1297 × IW − 0,0327 × ES − 0,875
 *   (MS = % Wörter mit drei und mehr Silben, SL = Wörter je Satz, IW = % Wörter mit mehr als sechs Buchstaben,
 *   ES = % einsilbige Wörter). Ergebnis etwa eine Schulstufe: 4 = sehr leicht, 15 = sehr schwer.
 * - Silben zählt eine einfache Näherung für das Deutsche (Vokalgruppen, Zwielaute und Doppelvokale als eine Silbe).
 *   Bei Fremdwörtern und Abkürzungen weicht sie ab – die Werte sind Anhaltspunkte, keine exakte Messung.
 *
 * Reine Funktionen ohne Abhängigkeiten (auch vom Server-Test geprüft: server/test/readability.test.ts).
 */

const VOWELS = 'aeiouyäöü';
/** Zwielaute und Doppelvokale, die als EINE Silbe zählen */
const ONE_SYLLABLE = new Set(['ai', 'au', 'äu', 'ei', 'eu', 'ey', 'ay', 'ie', 'aa', 'ee', 'oo', 'oi', 'ui']);

/** Silben eines Wortes (Näherung für das Deutsche), mindestens 1. */
export function syllables(word: string): number {
  const w = word
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-zäöüy]/g, '')
    // „qu“ und „ph“-ähnliche Verbindungen: das u nach q ist kein eigener Vokal
    .replace(/qu/g, 'qv');
  if (!w) return 0;
  let n = 0;
  let i = 0;
  while (i < w.length) {
    if (!VOWELS.includes(w[i])) {
      i++;
      continue;
    }
    // Vokalgruppe: Zwielaut/Doppelvokal als eine Silbe, sonst jeder Vokal eine (Situ-a-ti-on, Muse-um)
    let j = i;
    while (j < w.length && VOWELS.includes(w[j])) j++;
    let k = i;
    while (k < j) {
      if (k + 1 < j && ONE_SYLLABLE.has(w.slice(k, k + 2))) k += 2;
      else k += 1;
      n++;
    }
    i = j;
  }
  return Math.max(1, n);
}

/** Wörter eines Textes (ohne Adressen, Zahlen und Satzzeichen). */
export function words(text: string): string[] {
  return (
    text
      .replace(/https?:\/\/\S+/gi, ' ')
      .match(/[\p{L}][\p{L}\p{M}'’-]*/gu)
      ?.map((w) => w.replace(/^[-'’]+|[-'’]+$/g, ''))
      .filter((w) => w.length > 0) ?? []
  );
}

/** Abkürzungen mit Punkt, an denen kein Satz endet. */
const ABBR_WITH_DOT = ['z. B.', 'z.B.', 'u. a.', 'u.a.', 'd. h.', 'd.h.', 'bzw.', 'ggf.', 'ca.', 'usw.', 'inkl.', 'evtl.', 'sog.', 'vgl.', 'Nr.', 'Str.', 'Dr.', 'bspw.', 'zzgl.', 'gem.', 'max.', 'min.', 'Std.', 'Min.', 'Abs.', 'S.'];

/** Sätze eines Textes (Punkt, Ausrufe- und Fragezeichen, Absätze; Abkürzungen und Ordnungszahlen beenden keinen Satz). */
export function sentences(text: string): string[] {
  let t = text.replace(/https?:\/\/\S+/gi, 'Adresse');
  for (const a of ABBR_WITH_DOT) t = t.split(a).join(a.replace(/\./g, '․'));
  t = t.replace(/(\d)\.(?=\s*\p{L})/gu, '$1․'); // „3. Oktober“
  return t
    .split(/(?<=[.!?…])\s+|\n\s*\n|\n(?=\s*[-•*]\s)/u)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

export interface ReadabilityScores {
  words: number;
  sentences: number;
  /** Wörter je Satz */
  wordsPerSentence: number;
  /** Silben je Wort */
  syllablesPerWord: number;
  /** Flesch-Amstad, 0–100 (begrenzt) */
  flesch: number;
  /** Erste Wiener Sachtextformel, etwa 4–15 */
  wiener: number;
}

export function scores(text: string): ReadabilityScores | null {
  const ws = words(text);
  const ss = sentences(text);
  if (ws.length < 1 || ss.length < 1) return null;
  const syl = ws.map(syllables);
  const asl = ws.length / ss.length;
  const asw = syl.reduce((a, b) => a + b, 0) / ws.length;
  const pct = (n: number) => (100 * n) / ws.length;
  const ms = pct(syl.filter((s) => s >= 3).length);
  const iw = pct(ws.filter((w) => w.length > 6).length);
  const es = pct(syl.filter((s) => s === 1).length);
  const flesch = 180 - asl - 58.5 * asw;
  const wiener = 0.1935 * ms + 0.1672 * asl + 0.1297 * iw - 0.0327 * es - 0.875;
  return {
    words: ws.length,
    sentences: ss.length,
    wordsPerSentence: Math.round(asl * 10) / 10,
    syllablesPerWord: Math.round(asw * 100) / 100,
    flesch: Math.round(Math.max(0, Math.min(100, flesch))),
    wiener: Math.round(wiener * 10) / 10,
  };
}

/** Einstufung des Flesch-Amstad-Werts (übliche Stufen nach Flesch). */
export function fleschLabel(v: number): string {
  if (v >= 90) return 'sehr leicht';
  if (v >= 80) return 'leicht';
  if (v >= 70) return 'eher leicht';
  if (v >= 60) return 'mittel';
  if (v >= 50) return 'eher schwer';
  if (v >= 30) return 'schwer';
  return 'sehr schwer';
}

export type HintKind = 'long_sentence' | 'long_word' | 'abbreviation' | 'jargon' | 'structure' | 'link_text' | 'emoji' | 'hashtag' | 'caps';
export interface Hint {
  kind: HintKind;
  text: string;
  /** Fundstellen (gekürzt), höchstens einige */
  examples?: string[];
}

export const LONG_SENTENCE = 20;
export const LONG_WORD = 20;

/** Fachbegriffe der Gefahrenabwehr, die Lesende oft nicht kennen (Auswahl, nur Hinweis). */
const JARGON = ['Atemschutzgeräteträger', 'Brandmeldeanlage', 'Brandsicherheitswache', 'Nachlöscharbeiten', 'Riegelstellung', 'Menschenrettung', 'Hilfeleistungslöschgruppenfahrzeug', 'Tanklöschfahrzeug', 'Drehleiter mit Korb', 'Wasserförderung', 'Gefahrstoffzug', 'Abschnittsleitung', 'Einsatzleitwagen', 'Rettungstransportwagen', 'Notarzteinsatzfahrzeug', 'Wärmebildkamera', 'Lagemeldung', 'Bereitstellungsraum', 'Brandnachschau', 'Personenauskunftsstelle'];

/** Abkürzungen in Großbuchstaben, die geläufig sind und keinen Hinweis brauchen. */
const KNOWN_CAPS = new Set(['EU', 'USA', 'OK', 'TV', 'PKW', 'LKW', 'ICE', 'CO', 'PS', 'WC', 'DRK', 'THW', 'ADAC', 'GmbH', 'B', 'A', 'L', 'K']);

const EMOJI = /\p{Extended_Pictographic}/gu;

const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const uniq = (l: string[]) => [...new Set(l)];

/**
 * Hinweise zum Text: lange Sätze und Wörter, Abkürzungen und Fachbegriffe, fehlende Gliederung, Linktexte wie
 * „hier“, viele Emojis und Hashtags ohne Großbuchstaben (Screenreader lesen sie sonst als ein Wort).
 */
export function hints(text: string): Hint[] {
  const out: Hint[] = [];
  const t = text.trim();
  if (!t) return out;
  const ss = sentences(t);
  const long = ss.filter((s) => words(s).length > LONG_SENTENCE);
  if (long.length) out.push({ kind: 'long_sentence', text: `${long.length === 1 ? 'Ein Satz hat' : `${long.length} Sätze haben`} mehr als ${LONG_SENTENCE} Wörter. Kürzere Sätze (eine Aussage je Satz) sind leichter zu verstehen.`, examples: long.slice(0, 3).map((s) => cut(s)) });
  const ws = words(t);
  const longWords = uniq(ws.filter((w) => w.length >= LONG_WORD));
  if (longWords.length) out.push({ kind: 'long_word', text: `Sehr lange Wörter (ab ${LONG_WORD} Buchstaben) lassen sich mit Bindestrich trennen oder umschreiben, z. B. „Brandmelde-Anlage“.`, examples: longWords.slice(0, 5) });
  const caps = uniq((t.replace(/https?:\/\/\S+/gi, ' ').match(/(?<![\p{L}\p{N}])[A-ZÄÖÜ]{2,6}(?![\p{L}\p{N}])/gu) ?? []).filter((w) => !KNOWN_CAPS.has(w)));
  const dotted = ABBR_WITH_DOT.filter((a) => t.includes(a)).map((a) => a.replace(/\s/g, ''));
  const abbr = uniq([...caps, ...dotted]);
  if (abbr.length) out.push({ kind: 'abbreviation', text: 'Abkürzungen beim ersten Vorkommen ausschreiben oder erklären, z. B. „Hilfeleistungs-Löschgruppenfahrzeug (HLF)“. Screenreader lesen sie sonst Buchstabe für Buchstabe oder als Wort vor.', examples: abbr.slice(0, 8) });
  const jargon = JARGON.filter((j) => t.toLowerCase().includes(j.toLowerCase()));
  if (jargon.length) out.push({ kind: 'jargon', text: 'Fachbegriffe kurz erklären oder durch Alltagswörter ersetzen.', examples: jargon.slice(0, 5) });
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (ws.length > 300 && (paras.length < 3 || paras.some((p) => words(p).length > 150))) out.push({ kind: 'structure', text: 'Langer Text mit wenig Gliederung: in kurze Absätze teilen (Leerzeile) und das Wichtigste an den Anfang stellen. Die Website übernimmt den Text als Absätze – Zwischenüberschriften gibt es dort nicht, umso wichtiger sind kurze Absätze.' });
  const linkWords = t.match(/\b(hier|hier klicken|klicken sie hier|mehr dazu|weiterlesen|link)\b\s*[:→>-]?\s*(?=https?:\/\/)/gi) ?? [];
  const hereLinks = t.match(/\b(klicken sie hier|hier klicken|siehe hier|mehr hier|infos hier)\b/gi) ?? [];
  if (linkWords.length || hereLinks.length) out.push({ kind: 'link_text', text: 'Linktexte wie „hier“ sagen ohne Zusammenhang nichts aus – Screenreader lesen Links oft als Liste vor. Besser das Ziel nennen, z. B. „Hinweise zum Rauchmelder: https://…“.', examples: uniq([...linkWords, ...hereLinks].map((s) => s.trim())).slice(0, 3) });
  const emojis = t.match(EMOJI) ?? [];
  if (emojis.length > 3 || /\p{Extended_Pictographic}{3,}/u.test(t.replace(/\s/g, ''))) out.push({ kind: 'emoji', text: `${emojis.length} Emojis: Screenreader lesen jedes Emoji mit Namen vor („Feuerwehrauto“). Sparsam und am Ende eines Satzes verwenden, nicht statt Wörtern.` });
  const tags = uniq((t.match(/#[\p{L}\p{N}_]{2,}/gu) ?? []).filter((h) => h.length > 9 && h.slice(1) === h.slice(1).toLowerCase() && /\p{L}/u.test(h)));
  if (tags.length) out.push({ kind: 'hashtag', text: 'Hashtags aus mehreren Wörtern mit großen Anfangsbuchstaben schreiben (CamelCase), dann lesen Screenreader sie richtig: #FeuerwehrMusterstadt statt #feuerwehrmusterstadt.', examples: tags.slice(0, 5) });
  const shout = uniq(ws.filter((w) => w.length > 6 && w === w.toUpperCase() && /\p{Lu}/u.test(w)));
  if (shout.length) out.push({ kind: 'caps', text: 'Ganze Wörter in Großbuchstaben sind schwer zu lesen und werden teils buchstabiert. Zur Betonung lieber einen kurzen Satz davor stellen.', examples: shout.slice(0, 5) });
  return out;
}
