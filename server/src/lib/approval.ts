import { one, pool, type Queryable } from '../db/pool.js';
import { AppError } from './errors.js';

/**
 * SQL-Bedingung: Die Freigabe `<alias>.approval_id` gilt noch – nicht widerrufen und für die **aktuelle** Fassung
 * des Beitrags mit derselben Prüfsumme (E5). Wird überall geprüft, wo ein Auftrag später ausgeführt oder erneut
 * angestoßen wird, nicht nur beim Anlegen.
 */
export const approvalStillValid = (alias: string) => `EXISTS (
  SELECT 1 FROM approvals a
    JOIN posts p ON p.id = a.post_id
    JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
   WHERE a.id = ${alias}.approval_id AND a.decision = 'approved' AND a.revoked_at IS NULL
     AND a.revision_id = r.id AND a.content_hash = r.content_hash
     AND ${allMediaPresent('r')})`;

/**
 * SQL-Bedingung: Alle Dateien und das Titelbild der Fassung `<alias>` gibt es noch (nicht gelöscht). Die Prüfsumme der
 * Freigabe deckt nur die IDs ab; hart gelöschte Dateien (Löschfrist für Sammlungen archivierter Beiträge,
 * Datenschutzanfrage) würden sonst stillschweigend fehlen (#167). Eine solche Fassung wird nicht mehr ausgeliefert.
 */
export const allMediaPresent = (alias: string) => `NOT EXISTS (
  SELECT 1 FROM unnest(array_remove(COALESCE(${alias}.media_ids, '{}'::uuid[]) || ${alias}.cover_id, NULL)) AS mid(id)
   WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = mid.id AND m.deleted_at IS NULL))`;

/** Anzahl der inzwischen gelöschten Dateien (inkl. Titelbild) einer Fassung. */
export async function missingMediaCount(rev: { media_ids?: string[] | null; cover_id?: string | null }, db: Queryable = pool): Promise<number> {
  const ids = [...new Set([...(rev.media_ids ?? []), ...(rev.cover_id ? [rev.cover_id] : [])])];
  if (!ids.length) return 0;
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM unnest($1::uuid[]) AS mid(id) WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = mid.id AND m.deleted_at IS NULL)`, [ids], db);
  return r!.n;
}

/** Freigeben/Veröffentlichen nur mit vollständigen Dateien (#167) – sonst klare Meldung statt stiller Lücke. */
export async function assertMediaPresent(rev: { media_ids?: string[] | null; cover_id?: string | null }, db: Queryable = pool) {
  const n = await missingMediaCount(rev, db);
  if (n > 0) {
    throw new AppError(
      409,
      'media_missing',
      `${n === 1 ? 'Eine Datei' : `${n} Dateien`} dieser Fassung ${n === 1 ? 'wurde' : 'wurden'} inzwischen gelöscht (z. B. durch eine Löschfrist oder eine Datenschutzanfrage). ` +
        'Bitte eine neue Fassung ohne diese Dateien speichern und erneut freigeben lassen.',
    );
  }
}
