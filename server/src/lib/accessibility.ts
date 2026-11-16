import { many, pool, type Queryable } from '../db/pool.js';
import { getSettings } from './settings.js';

/**
 * Barrierefreiheit (#217): Alternativtexte je Bild.
 *
 * Der Alternativtext einer Datei steht in der Medienverwaltung (`media.alt_text`, wiederverwendbar) und – als Teil der
 * Fassung – in `post_revisions.media_alt` ({ mediaId: Text }). Maßgeblich ist der Text der Fassung; fehlt er (ältere
 * Fassungen), gilt der Text aus der Medienverwaltung.
 *
 * Alternativtexte unterstützen: Website (WordPress), Facebook, Instagram (Bildbeiträge), Threads, X (über die X-API),
 * Mastodon und Bluesky. Nicht: Storys, WhatsApp-Kanal und X beim Teilen von Hand (dort hängt die Person die Bilder an).
 */
export const ALT_MAX = 1000;

/** Unterstützt dieser Kanal (Art und Format) Alternativtexte? */
export function kindSupportsAlt(kind: string, config: Record<string, any> | null | undefined, format: 'feed' | 'story' | 'both' | string = 'feed'): boolean {
  if (format === 'story') return false;
  if (kind === 'x') return config?.mode === 'api';
  return ['facebook', 'instagram', 'threads', 'mastodon', 'bluesky'].includes(kind);
}

/** Alternativtexte einer Fassung bereinigen: nur Dateien der Fassung, getrimmt, ohne leere Einträge, geordnet. */
export function cleanMediaAlt(alt: Record<string, unknown> | null | undefined, mediaIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of [...mediaIds].sort()) {
    const v = typeof alt?.[id] === 'string' ? (alt[id] as string).replace(/\s+/g, ' ').trim().slice(0, ALT_MAX) : '';
    if (v) out[id] = v;
  }
  return out;
}

/** Wirksamer Alternativtext: aus der Fassung, sonst aus der Medienverwaltung. */
export function effectiveAlt(rev: { media_alt?: Record<string, string> | null }, m: { id: string; alt_text?: string | null }): string {
  return String(rev.media_alt?.[m.id] ?? '').trim() || String(m.alt_text ?? '').trim();
}

export interface AltCheck {
  /** Gibt es ein Ziel, das Alternativtexte unterstützt (Website oder passender sozialer Kanal)? */
  applies: boolean;
  /** Bilder der Fassung ohne Alternativtext */
  missing: string[];
  /** Einstellung „Alternativtext ist Pflicht“: Freigabe blockiert statt Warnung */
  required: boolean;
}

/** Prüfung für die Freigabe: Bilder ohne Alternativtext, wenn ein Ziel Alternativtexte unterstützt. */
export async function altCheck(rev: { media_ids?: string[] | null; media_alt?: Record<string, string> | null; site_id?: string | null; social_targets?: string[] | null; social_formats?: Record<string, string> | null }, db: Queryable = pool): Promise<AltCheck> {
  const s = await getSettings();
  const required = !!s['editorial.alt_text_required'];
  const ids = rev.media_ids ?? [];
  if (!ids.length) return { applies: false, missing: [], required };
  let applies = !!rev.site_id;
  if (!applies && rev.social_targets?.length) {
    const conns = await many<{ id: string; kind: string; config: any }>(`SELECT id, kind, config FROM connections WHERE id = ANY($1)`, [rev.social_targets], db);
    applies = conns.some((c) => kindSupportsAlt(c.kind, c.config, rev.social_formats?.[c.id] ?? 'feed'));
  }
  if (!applies) return { applies, missing: [], required };
  const media = await many<{ id: string; kind: string; alt_text: string }>(`SELECT id, kind, alt_text FROM media WHERE id = ANY($1) AND deleted_at IS NULL`, [ids], db);
  const missing = ids.filter((id) => {
    const m = media.find((x) => x.id === id);
    return m && m.kind === 'image' && !effectiveAlt(rev, m);
  });
  return { applies, missing, required };
}
