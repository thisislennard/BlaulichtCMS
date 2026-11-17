/** Soziale Netzwerke in der Oberfläche – Zählregeln wie auf dem Server (server/src/connections/channels.ts). */
export type SocialKind = 'facebook' | 'instagram' | 'threads' | 'x' | 'whatsapp' | 'mastodon' | 'bluesky';
export const SOCIAL_KINDS: SocialKind[] = ['facebook', 'instagram', 'threads', 'x', 'whatsapp', 'mastodon', 'bluesky'];
export const SOCIAL_LABEL: Record<SocialKind, string> = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', x: 'X', whatsapp: 'WhatsApp-Kanal', mastodon: 'Mastodon', bluesky: 'Bluesky' };
export const STORY_KINDS: SocialKind[] = ['facebook', 'instagram'];
export const FORMAT_LABEL: Record<string, string> = { feed: 'Beitrag', story: 'Story', both: 'Beitrag und Story' };

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('de', { granularity: 'grapheme' }) : null;
const graphemes = (s: string) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));
const PICTO = /\p{Extended_Pictographic}/u;
const URL_RE = /https?:\/\/[^\s]+/gi;

/** Länge nach den Zählregeln von X (Näherung): Adressen 23, Emojis und die meisten Nicht-Latein-Zeichen 2. */
export function xLength(text: string): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const g of graphemes(rest)) {
    if (PICTO.test(g)) {
      n += 2;
      continue;
    }
    for (const ch of g) {
      const cp = ch.codePointAt(0)!;
      n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
    }
  }
  return n;
}

/** Länge für Threads: Emojis zählen mit ihrer Länge in UTF-8-Bytes. */
export function threadsLength(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += PICTO.test(g) ? new TextEncoder().encode(g).length : [...g].length;
  return n;
}

/** Länge für Mastodon: Grapheme, jede Adresse zählt 23 Zeichen (Höchstlänge legt die Instanz fest, meist 500). */
export function mastodonLength(text: string): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  return n + graphemes(rest).length;
}

/**
 * Länge für Bluesky: höchstens 300 Grapheme und 3000 Bytes (UTF-8); Adressen zählen voll. Über 3000 Bytes gilt der
 * Text wie auf dem Server als zu lang (#232) – sonst zeigte der Zähler „passt“, obwohl beim Senden gekürzt wird.
 */
export const BLUESKY_MAX = 300;
export const BLUESKY_MAX_BYTES = 3000;
export function blueskyLength(text: string): number {
  const n = graphemes(text).length;
  return new TextEncoder().encode(text).length > BLUESKY_MAX_BYTES ? Math.max(BLUESKY_MAX + 1, n) : n;
}
