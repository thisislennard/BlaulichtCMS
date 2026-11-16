/** Soziale Kanäle in der Oberfläche – Zählregeln wie auf dem Server (server/src/connections/channels.ts). */
export type SocialKind = 'facebook' | 'instagram' | 'threads' | 'x' | 'whatsapp';
export const SOCIAL_KINDS: SocialKind[] = ['facebook', 'instagram', 'threads', 'x', 'whatsapp'];
export const SOCIAL_LABEL: Record<SocialKind, string> = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', x: 'X', whatsapp: 'WhatsApp-Kanal' };
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
