import crypto from 'node:crypto';
import { one, type Queryable, pool } from '../db/pool.js';
import type { Connection, ConnectionKind } from './common.js';

/**
 * Soziale Kanäle (#188, #189): Facebook, Instagram, Threads, X und WhatsApp-Kanal. Gemeinsame Regeln für Texte je
 * Kanal, Formate (Beitrag/Story) und „Teilen von Hand“.
 */
export type SocialChannel = 'facebook' | 'instagram' | 'threads' | 'x' | 'whatsapp';
export const SOCIAL_KINDS: SocialChannel[] = ['facebook', 'instagram', 'threads', 'x', 'whatsapp'];
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

const segmenter = new Intl.Segmenter('de', { granularity: 'grapheme' });
const graphemes = (s: string) => Array.from(segmenter.segment(s), (x) => x.segment);
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

/** Kürzt auf `max` (mit „…“), ohne Zeichen zu zerteilen; `suffix` (z. B. Link) bleibt immer vollständig erhalten. */
export function fitText(text: string, max: number, measure: (s: string) => number, suffix = ''): string {
  const t = text.trim();
  if (measure(t + suffix) <= max) return t + suffix;
  const g = graphemes(t);
  let lo = 0;
  let hi = g.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(g.slice(0, mid).join('').trimEnd() + '…' + suffix) <= max) lo = mid;
    else hi = mid - 1;
  }
  return (lo ? g.slice(0, lo).join('').trimEnd() + '…' : '') + suffix;
}

/* ------------------------------------------------------------------ Texte je Kanal */

interface RevText {
  title: string;
  body: string;
  excerpt?: string | null;
  variants?: Record<string, { body?: string } | undefined> | null;
}

const baseText = (rev: RevText) => [rev.title, rev.excerpt?.trim() || rev.body].filter(Boolean).join('\n\n').trim();
const withLink = (text: string, link: string | null | undefined) => (link && !text.includes(link) ? `\n\n${link}` : '');

/**
 * Text, der an einen Kanal geht: eigener Kanaltext, sonst Titel und Kurzfassung bzw. Text. Threads, X und
 * WhatsApp-Kanal bekommen den Link zur Website angehängt, wenn der Beitrag dort schon veröffentlicht ist.
 */
export function socialText(rev: RevText, channel: SocialChannel, link?: string | null): string {
  const own = (rev.variants ?? {})[channel]?.body?.trim();
  switch (channel) {
    case 'instagram':
      return (own || baseText(rev)).slice(0, 2200);
    case 'facebook':
      return (own || baseText(rev)).slice(0, 60_000);
    case 'threads':
      return fitText(own || baseText(rev), THREADS_MAX, threadsLength, withLink(own || baseText(rev), link));
    case 'x':
      return fitText(own || baseText(rev), X_MAX, xLength, withLink(own || baseText(rev), link));
    case 'whatsapp': {
      // WhatsApp-Formatierung: *fett* für den Titel
      const t = own || [rev.title ? `*${rev.title.replace(/\*/g, '')}*` : '', rev.excerpt?.trim() || rev.body].filter(Boolean).join('\n\n').trim();
      return (t + withLink(t, link)).slice(0, 60_000);
    }
  }
}

/** Ist der Text für Threads bzw. X zu lang (wird gekürzt)? */
export function socialTextTooLong(rev: RevText, channel: SocialChannel, link?: string | null): boolean {
  const own = (rev.variants ?? {})[channel]?.body?.trim();
  const t = own || baseText(rev);
  if (channel === 'x') return xLength(t + withLink(t, link)) > X_MAX;
  if (channel === 'threads') return threadsLength(t + withLink(t, link)) > THREADS_MAX;
  if (channel === 'instagram') return t.length > 2200;
  return false;
}

/** Kennung eines Textes zur Wiedererkennung; bei X ohne Adressen (X kürzt sie auf t.co). */
export function markerFor(text: string, kind?: string) {
  const t = kind === 'x' ? text.replace(URL_RE, '').replace(/\s+/g, ' ') : text;
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
