import crypto from 'node:crypto';
import { one, type Queryable, pool } from '../db/pool.js';
import { fitText, graphemes, utf16Length } from '../lib/text.js';
import type { Connection, ConnectionKind } from './common.js';

export { fitText };

/**
 * Soziale Kanäle (#188, #189, #215): Facebook, Instagram, Threads, X, WhatsApp-Kanal, Mastodon und Bluesky. Gemeinsame
 * Regeln für Texte je Kanal, Formate (Beitrag/Story) und „Teilen von Hand“.
 */
export type SocialChannel = 'facebook' | 'instagram' | 'threads' | 'x' | 'whatsapp' | 'mastodon' | 'bluesky';
export const SOCIAL_KINDS: SocialChannel[] = ['facebook', 'instagram', 'threads', 'x', 'whatsapp', 'mastodon', 'bluesky'];
/** Für SQL-Abfragen: `kind IN (…)` aller sozialen Kanäle. */
export const SOCIAL_KINDS_SQL = `(${SOCIAL_KINDS.map((k) => `'${k}'`).join(',')})`;
export const isSocialKind = (k: string): k is SocialChannel => (SOCIAL_KINDS as string[]).includes(k);

/** Kanäle mit Story-Format über die Schnittstelle. */
export const STORY_KINDS: SocialChannel[] = ['facebook', 'instagram'];
export type SocialFormat = 'feed' | 'story';
export type FormatChoice = 'feed' | 'story' | 'both';

/** Ohne Schnittstelle: WhatsApp-Kanal immer, X im Modus „Teilen von Hand“ (Standard). */
export function isManualChannel(c: Pick<Connection, 'kind' | 'config'>): boolean {
  return c.kind === 'whatsapp' || (c.kind === 'x' && c.config?.mode !== 'api');
}

/** Formate eines Kanals laut Fassung (nur Facebook/Instagram kennen Storys). */
export function formatsFor(kind: ConnectionKind, choice: FormatChoice | undefined | null): SocialFormat[] {
  if (!STORY_KINDS.includes(kind as SocialChannel)) return ['feed'];
  if (choice === 'story') return ['story'];
  if (choice === 'both') return ['feed', 'story'];
  return ['feed'];
}

/* ------------------------------------------------------------------ Zeichen zählen */

const PICTO = /\p{Extended_Pictographic}/u;
export const URL_RE = /https?:\/\/[^\s]+/gi;

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
  for (const g of graphemes(text)) n += PICTO.test(g) ? Buffer.byteLength(g, 'utf8') : [...g].length;
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
export function blueskyLength(text: string): number {
  // Über 3000 Bytes ist der Text in jedem Fall zu lang – als „über der Grenze“ melden
  return Buffer.byteLength(text, 'utf8') > 3000 ? Math.max(BLUESKY_MAX + 1, graphemes(text).length) : graphemes(text).length;
}

/** Höchstlängen in UTF-16-Einheiten: Instagram-Bildunterschrift, Facebook-Beitrag, WhatsApp-Kanal (Teilen von Hand). */
export const INSTAGRAM_MAX = 2200;
export const FACEBOOK_MAX = 60_000;
export const WHATSAPP_MAX = 60_000;

/* ------------------------------------------------------------------ Texte je Kanal */

interface RevText {
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
export function limitsFor(c: Pick<Connection, 'kind' | 'capabilities'> | null | undefined): TextLimits {
  if (c?.kind === 'mastodon') {
    const m = Number(c.capabilities?.max_characters);
    return { max: Number.isFinite(m) && m >= 100 ? m : MASTODON_MAX };
  }
  return {};
}

/** Inhaltswarnung für Mastodon (optional, Teil der Fassung). */
export function contentWarning(rev: RevText): string {
  return (rev.variants?.mastodon?.cw ?? '').trim().slice(0, 500);
}

const baseText = (rev: RevText) => [rev.title, rev.excerpt?.trim() || rev.body].filter(Boolean).join('\n\n').trim();
const withLink = (text: string, link: string | null | undefined) => (link && !text.includes(link) ? `\n\n${link}` : '');

/**
 * Text, der an einen Kanal geht: eigener Kanaltext, sonst Titel und Kurzfassung bzw. Text. Threads, X und
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

/** Ist der Text für Threads bzw. X zu lang (wird gekürzt)? */
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

/**
 * Kennung eines Textes zur Wiedererkennung; bei X, Mastodon und Bluesky ohne Adressen und mit vereinheitlichten
 * Leerräumen (X kürzt Adressen auf t.co, Mastodon liefert den Text als HTML zurück).
 */
export function markerFor(text: string, kind?: string) {
  const t = kind === 'x' || kind === 'mastodon' || kind === 'bluesky' ? text.replace(URL_RE, '').replace(/\s+/g, ' ') : text;
  return crypto.createHash('sha256').update(t.trim()).digest('hex');
}

/** Öffentliche Adresse des Beitrags auf der Website (letzte erfolgreiche Veröffentlichung), sonst null. */
export async function postLink(postId: string, db: Queryable = pool): Promise<string | null> {
  const r = await one<{ remote_url: string | null }>(
    `SELECT remote_url FROM publications WHERE post_id = $1 AND action = 'publish' AND status = 'published' AND remote_url LIKE 'https://%' ORDER BY result_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [postId],
    db,
  );
  return r?.remote_url ?? null;
}

/** Vorbereitetes Teilen von Hand: Text plus Adresse zum Öffnen. */
export function shareTarget(c: Pick<Connection, 'kind' | 'config'>, text: string): { openUrl: string; openLabel: string } {
  if (c.kind === 'x') return { openUrl: `https://x.com/intent/post?text=${encodeURIComponent(text)}`, openLabel: 'In X öffnen (Text ist eingetragen)' };
  const ch = String(c.config?.channelUrl ?? '');
  return /^https:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/?$/.test(ch) ? { openUrl: ch, openLabel: 'WhatsApp-Kanal öffnen' } : { openUrl: 'https://web.whatsapp.com/', openLabel: 'WhatsApp Web öffnen' };
}
