import { many } from '../db/pool.js';
import { kindSupportsAlt } from '../lib/accessibility.js';
import { formatsFor, isManualChannel, limitsFor, postLink, socialText, socialTextTooLong, type SocialChannel, type SocialFormat } from './channels.js';
import { checkFormats, checkStoryFormats, mediaForRevision } from './meta.js';
import { checkThreadsFormats } from './threads.js';
import { checkXFormats } from './x.js';
import { checkMastodonFormats } from './mastodon.js';
import { checkBlueskyFormats } from './bluesky.js';

export interface SocialCheck {
  id: string;
  kind: SocialChannel;
  name: string;
  status: string;
  /** Verbindung inzwischen gelöscht */
  deleted: boolean;
  /** Text, der gesendet wird (gekürzt wie beim Senden) */
  text: string;
  formats: SocialFormat[];
  manual: boolean;
  link: string | null;
  /** Hinweise zu Formaten, Dateien und Länge (ohne Alternativtexte) */
  formatIssues: string[];
  /** Bilder ohne Alternativtext, wenn dieses Netzwerk Alternativtexte übernimmt (#217), sonst 0 */
  altMissing: number;
}

/** Hinweis zu fehlenden Alternativtexten bei einem Netzwerk (Formatprüfung, #217). */
export const altIssue = (n: number) => `${n === 1 ? 'Ein Bild hat' : `${n} Bilder haben`} keinen Alternativtext – Menschen mit Screenreader erfahren nicht, was zu sehen ist.`;

/**
 * Formatprüfung je gewähltem sozialen Netzwerk für eine Fassung: dieselben Regeln, mit denen beim Senden gekürzt und
 * geprüft wird. Grundlage für `GET /posts/:id/social-check` und die Prüfliste vor dem Einreichen (#262).
 */
export async function socialChecks(postId: string, rev: any): Promise<SocialCheck[]> {
  if (!rev.social_targets?.length) return [];
  const media = await mediaForRevision(rev);
  const targets = await many<any>(`SELECT id, kind, config, CASE WHEN deleted_at IS NOT NULL THEN 'Verbindung gelöscht' ELSE name END AS name, status, deleted_at IS NOT NULL AS deleted, capabilities FROM connections WHERE id = ANY($1)`, [rev.social_targets]);
  const link = await postLink(postId);
  return targets.map((t) => {
    const kind = t.kind as SocialChannel;
    const text = socialText(rev, kind, link, limitsFor(t));
    const formats = formatsFor(kind, (rev.social_formats ?? {})[t.id]);
    const tooLong = socialTextTooLong(rev, kind, link, limitsFor(t));
    const issues: string[] = [];
    if (formats.includes('feed')) {
      if (kind === 'facebook' || kind === 'instagram') issues.push(...checkFormats(kind, media, text));
      else if (kind === 'threads') issues.push(...checkThreadsFormats(media, tooLong));
      else if (kind === 'x') issues.push(...checkXFormats(t, media, tooLong));
      else if (kind === 'mastodon') issues.push(...checkMastodonFormats(t, media, tooLong));
      else if (kind === 'bluesky') issues.push(...checkBlueskyFormats(media, tooLong));
    }
    if (formats.includes('story')) issues.push(...checkStoryFormats(kind as 'facebook' | 'instagram', media));
    // Barrierefreiheit (#217): Bilder ohne Alternativtext bei Kanälen, die ihn übernehmen
    const noAlt = media.filter((m: any) => m.kind === 'image' && !m.alt).length;
    const altMissing = noAlt && formats.includes('feed') && kindSupportsAlt(kind, t.config) ? noAlt : 0;
    return { id: t.id, kind, name: t.name, status: t.status, deleted: !!t.deleted, text, formats, manual: isManualChannel(t), link, formatIssues: issues, altMissing };
  });
}
