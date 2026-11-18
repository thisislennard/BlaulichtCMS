import { fitText, graphemes, utf16Length } from './text.js';

/**
 * Texte für soziale Netzwerke (#188, #189, #215, #232, #262): Zählregeln, Höchstlängen und der Text, der tatsächlich
 * gesendet wird. **Gemeinsamer Code für Server und Oberfläche:** Die Oberfläche importiert diese Datei direkt
 * (`web/src/lib/social.ts`) für Zeichenzähler und die Vorschau je Netzwerk im Beitrag – deshalb hier nur reines
 * TypeScript ohne Node-Abhängigkeiten (kein `Buffer`, keine Datenbank). Verbindungs- und Datenbankteile stehen in
 * `connections/channels.ts`.
 */

export type SocialChannel = 'facebook' | 'instagram' | 'threads' | 'x' | 'whatsapp' | 'mastodon' | 'bluesky';
export const SOCIAL_KINDS: SocialChannel[] = ['facebook', 'instagram', 'threads', 'x', 'whatsapp', 'mastodon', 'bluesky'];
export const isSocialKind = (k: string): k is SocialChannel => (SOCIAL_KINDS as string[]).includes(k);
/** Kurze Namen der Netzwerke (Oberfläche, Prüfliste) */
export const SOCIAL_LABEL: Record<SocialChannel, string> = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', x: 'X', whatsapp: 'WhatsApp-Kanal', mastodon: 'Mastodon', bluesky: 'Bluesky' };

/** Kanäle mit Story-Format über die Schnittstelle. */
export const STORY_KINDS: SocialChannel[] = ['facebook', 'instagram'];
export type SocialFormat = 'feed' | 'story';
export type FormatChoice = 'feed' | 'story' | 'both';
export const FORMAT_LABEL: Record<FormatChoice, string> = { feed: 'Beitrag', story: 'Story', both: 'Beitrag und Story' };

/* ------------------------------------------------------------------ Zeichen zählen */

const PICTO = /\p{Extended_Pictographic}/u;
export const URL_RE = /https?:\/\/[^\s]+/gi;
const utf8 = new TextEncoder();
/** Länge in UTF-8-Bytes. */
export const utf8Length = (s: string) => utf8.encode(s).length;

/**
 * Länge nach den Zählregeln von X (twitter-text v3, Näherung): Zeichen aus den Bereichen U+0000–U+10FF,
 * U+2000–U+200D, U+2010–U+201F und U+2032–U+2037 zählen 1, alle anderen 2, ein Emoji zählt 2, jede Adresse 23.
 */
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
export const X_MAX = 280;

/** Länge für Threads: 500 Zeichen, Emojis zählen mit ihrer Länge in UTF-8-Bytes (laut Threads-Doku). */
export function threadsLength(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += PICTO.test(g) ? utf8Length(g) : [...g].length;
  return n;
}
export const THREADS_MAX = 500;

/**
 * Länge für Mastodon: Grapheme, jede Adresse zählt als 23 Zeichen (`characters_reserved_per_url`, Standard der
 * Instanzen). Die Höchstlänge legt die Instanz fest (`configuration.statuses.max_characters`, Standard 500).
 */
export function mastodonLength(text: string, perUrl = 23): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += perUrl;
    return '';
  });
  return n + graphemes(rest).length;
}
export const MASTODON_MAX = 500;

/** Länge für Bluesky: höchstens 300 Grapheme und 3000 Bytes (Lexikon app.bsky.feed.post). Adressen zählen voll. */
export const BLUESKY_MAX = 300;
export const BLUESKY_MAX_BYTES = 3000;
export function blueskyLength(text: string): number {
  // Über 3000 Bytes ist der Text in jedem Fall zu lang – als „über der Grenze“ melden
  return utf8Length(text) > BLUESKY_MAX_BYTES ? Math.max(BLUESKY_MAX + 1, graphemes(text).length) : graphemes(text).length;
}

/** Höchstlängen in UTF-16-Einheiten: Instagram-Bildunterschrift, Facebook-Beitrag, WhatsApp-Kanal (Teilen von Hand). */
export const INSTAGRAM_MAX = 2200;
export const FACEBOOK_MAX = 60_000;
export const WHATSAPP_MAX = 60_000;

/* ------------------------------------------------------------------ Texte je Netzwerk */

export interface RevText {
  title: string;
  body: string;
  excerpt?: string | null;
  variants?: Record<string, { body?: string; cw?: string } | undefined> | null;
}

/** Grenzen, die von der Verbindung abhängen (Mastodon: Höchstlänge der Instanz abzüglich Inhaltswarnung). */
export interface TextLimits {
  max?: number;
}

/** Grenzen eines Kanals aus dem letzten Test der Verbindung. */
export function limitsFor(c: { kind: string; capabilities?: Record<string, any> | null } | null | undefined): TextLimits {
  if (c?.kind === 'mastodon') {
    const m = Number(c.capabilities?.max_characters);
    return { max: Number.isFinite(m) && m >= 100 ? m : MASTODON_MAX };
  }
  return {};
}

/** Höchstlänge eines Kanals, wie sie beim Senden gilt (Mastodon: Grenze der Instanz). */
export function channelMax(channel: SocialChannel, limits: TextLimits = {}): number {
  return { instagram: INSTAGRAM_MAX, facebook: FACEBOOK_MAX, threads: THREADS_MAX, x: X_MAX, whatsapp: WHATSAPP_MAX, mastodon: limits.max ?? MASTODON_MAX, bluesky: BLUESKY_MAX }[channel];
}

/** Zählweise eines Kanals (dieselbe, mit der beim Senden gekürzt wird). */
export function channelLength(channel: SocialChannel, text: string): number {
  switch (channel) {
    case 'threads':
      return threadsLength(text);
    case 'x':
      return xLength(text);
    case 'mastodon':
      return mastodonLength(text);
    case 'bluesky':
      return blueskyLength(text);
    default:
      return utf16Length(text);
  }
}

/** Inhaltswarnung für Mastodon (optional, Teil der Fassung). */
export function contentWarning(rev: RevText): string {
  return (rev.variants?.mastodon?.cw ?? '').trim().slice(0, 500);
}

const baseText = (rev: RevText) => [rev.title, rev.excerpt?.trim() || rev.body].filter(Boolean).join('\n\n').trim();
const withLink = (text: string, link: string | null | undefined) => (link && !text.includes(link) ? `\n\n${link}` : '');

/**
 * Text, der an ein Netzwerk geht: eigener Text je Netzwerk, sonst Titel und Kurzfassung bzw. Text. Threads, X und
 * WhatsApp-Kanal bekommen den Link zur Website angehängt, wenn der Beitrag dort schon veröffentlicht ist.
 */
export function socialText(rev: RevText, channel: SocialChannel, link?: string | null, limits: TextLimits = {}): string {
  const own = (rev.variants ?? {})[channel]?.body?.trim();
  switch (channel) {
    // Kürzen an Zeichengrenzen mit „…“ (#232) – `slice` zerteilte Emojis (halbes Surrogatpaar → „�“)
    case 'instagram':
      return fitText(own || baseText(rev), INSTAGRAM_MAX, utf16Length);
    case 'facebook':
      return fitText(own || baseText(rev), FACEBOOK_MAX, utf16Length);
    case 'threads':
      return fitText(own || baseText(rev), THREADS_MAX, threadsLength, withLink(own || baseText(rev), link));
    case 'x':
      return fitText(own || baseText(rev), X_MAX, xLength, withLink(own || baseText(rev), link));
    case 'whatsapp': {
      // WhatsApp-Formatierung: *fett* für den Titel
      const t = own || [rev.title ? `*${rev.title.replace(/\*/g, '')}*` : '', rev.excerpt?.trim() || rev.body].filter(Boolean).join('\n\n').trim();
      // Der angehängte Link bleibt vollständig erhalten; gekürzt wird der Text davor
      return fitText(t, WHATSAPP_MAX, utf16Length, withLink(t, link));
    }
    case 'mastodon': {
      // Die Inhaltswarnung zählt bei Mastodon zur Höchstlänge
      const max = Math.max(50, (limits.max ?? MASTODON_MAX) - mastodonLength(contentWarning(rev)));
      return fitText(own || baseText(rev), max, mastodonLength, withLink(own || baseText(rev), link));
    }
    case 'bluesky':
      return fitText(own || baseText(rev), BLUESKY_MAX, blueskyLength, withLink(own || baseText(rev), link));
  }
}

/** Ist der Text für ein Netzwerk zu lang (wird beim Senden gekürzt)? */
export function socialTextTooLong(rev: RevText, channel: SocialChannel, link?: string | null, limits: TextLimits = {}): boolean {
  const own = (rev.variants ?? {})[channel]?.body?.trim();
  const t = own || baseText(rev);
  if (channel === 'mastodon') return mastodonLength(t + withLink(t, link)) + mastodonLength(contentWarning(rev)) > (limits.max ?? MASTODON_MAX);
  if (channel === 'bluesky') return blueskyLength(t + withLink(t, link)) > BLUESKY_MAX;
  if (channel === 'x') return xLength(t + withLink(t, link)) > X_MAX;
  if (channel === 'threads') return threadsLength(t + withLink(t, link)) > THREADS_MAX;
  if (channel === 'instagram') return t.length > INSTAGRAM_MAX;
  return false;
}
