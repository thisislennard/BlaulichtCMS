import crypto from 'node:crypto';
import { one, type Queryable, pool } from '../db/pool.js';
import { fitText } from '../lib/text.js';
import { SOCIAL_KINDS, STORY_KINDS, URL_RE, type FormatChoice, type SocialChannel, type SocialFormat } from '../lib/social-text.js';
import type { Connection, ConnectionKind } from './common.js';

export { fitText };
// Zählregeln, Höchstlängen und Texte je Netzwerk: gemeinsamer Code mit der Oberfläche (lib/social-text.ts, #262)
export * from '../lib/social-text.js';

/**
 * Soziale Netzwerke (#188, #189, #215): Facebook, Instagram, Threads, X, WhatsApp-Kanal, Mastodon und Bluesky. Gemeinsame
 * Regeln für Formate (Beitrag/Story), Wiedererkennung und „Teilen von Hand“; die Texte je Netzwerk stehen in
 * lib/social-text.ts.
 */
/** Für SQL-Abfragen: `kind IN (…)` aller sozialen Kanäle. */
export const SOCIAL_KINDS_SQL = `(${SOCIAL_KINDS.map((k) => `'${k}'`).join(',')})`;

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
