import { many, one, pool, type Queryable } from '../db/pool.js';
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

/* ------------------------------------------------------------------ Datenschutz-Prüfung */

/**
 * Befunde der Datenschutz-Prüfung (#118, #214, #241) für eine Menge von Dateien: markierte Medien (erkennbare
 * Personen, Verletzte/Gesundheitsdaten, Kennzeichen, sensibel) und Bilder mit offenen Gesichtsvorschlägen. Gilt für
 * jeden Weg, auf dem Bilder veröffentlicht werden (Beiträge, Einsatzliste) – neue Wege nutzen dieselbe Prüfung.
 */
export interface PrivacyFindings {
  /** Anzahl Dateien mit mindestens einer Markierung */
  flagged: number;
  /** Anzahl Bilder mit offenen Gesichtsvorschlägen */
  faces: number;
  /** IDs aller Dateien mit Befund (sortiert) */
  ids: string[];
  /** Vorkommende Markierungen (ohne Doppelte) */
  flags: string[];
}

export async function privacyFindings(mediaIds: readonly string[] | null | undefined, db: Queryable = pool): Promise<PrivacyFindings> {
  const ids = [...new Set(mediaIds ?? [])];
  if (!ids.length) return { flagged: 0, faces: 0, ids: [], flags: [] };
  const rows = await many<{ id: string; flags: string[]; faces: boolean }>(
    `SELECT id, sensitive_flags AS flags, jsonb_path_exists(face_proposals, '$[*] ? (@.status == "open")') AS faces
       FROM media WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
    db,
  );
  const flagged = rows.filter((r) => (r.flags ?? []).length > 0);
  return {
    flagged: flagged.length,
    faces: rows.filter((r) => r.faces).length,
    ids: rows.filter((r) => (r.flags ?? []).length > 0 || r.faces).map((r) => r.id).sort(),
    flags: [...new Set(flagged.flatMap((r) => r.flags))],
  };
}

export const needsPrivacyCheck = (f: PrivacyFindings) => f.flagged > 0 || f.faces > 0;

/** Freigabe bzw. Veröffentlichung nur mit ausdrücklich bestätigter Datenschutz-Prüfung, wenn es Befunde gibt. */
export function assertPrivacyChecked(f: PrivacyFindings, checked: boolean, subject = 'Die Fassung') {
  if (!needsPrivacyCheck(f) || checked) return;
  throw new AppError(
    400,
    'privacy_check_required',
    f.flagged > 0
      ? `${subject} enthält markierte Medien (z. B. erkennbare Personen). Bitte die Datenschutz-Prüfung bestätigen.`
      : `${subject} enthält Bilder mit offenen Gesichtsvorschlägen. Bitte die Datenschutz-Prüfung bestätigen.`,
  );
}

/** Audit-Details einer bestätigten Datenschutz-Prüfung (leer ohne Befund). */
export function privacyAudit(f: PrivacyFindings): Record<string, unknown> {
  if (!needsPrivacyCheck(f)) return {};
  return { datenschutz_geprueft: true, markierte_medien: f.flagged, ...(f.faces > 0 ? { bilder_mit_offenen_gesichtsvorschlaegen: f.faces } : {}) };
}
