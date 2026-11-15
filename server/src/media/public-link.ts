import type { FastifyReply, FastifyRequest } from 'fastify';
import { one } from '../db/pool.js';
import { config } from '../config.js';
import { deriveKey, hmacHex, safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { linkIsFull, type LinkUsage } from './link-options.js';

/*
 * Schutz öffentlicher Upload-Links (Paket 6): optionales Passwort mit kurzlebiger Freigabe im Browser und Grenzen je
 * Link (Uploads = Vorgänge mit eigener Vorgangsnummer, Dateien je Upload, Gesamtgröße).
 */

/** Freigabe nach Passworteingabe: 12 Stunden, nur für den Pfad dieses Links, an das gesetzte Passwort gebunden. */
const UNLOCK_MS = 12 * 3600_000;
const cookieName = (linkId: string) => `bc_ul_${linkId.replace(/-/g, '').slice(0, 12)}`;

function unlockSig(linkId: string, setAt: string, exp: number) {
  return hmacHex(deriveKey('upload-link-unlock'), `${linkId}|${setAt}|${exp}`);
}

export function setUnlockCookie(reply: FastifyReply, token: string, link: { id: string; password_set_at: Date | string | null }) {
  const exp = Date.now() + UNLOCK_MS;
  const setAt = link.password_set_at ? new Date(link.password_set_at).toISOString() : '';
  reply.setCookie(cookieName(link.id), `${exp}.${unlockSig(link.id, setAt, exp)}`, {
    path: `/api/v1/public/upload/${token}`,
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: Math.floor(UNLOCK_MS / 1000),
  });
}

/** Passwortgeschützter Link ohne gültige Freigabe → 401 „password_required“. */
export function assertUnlocked(req: FastifyRequest, link: { id: string; password_hash: string | null; password_set_at: Date | string | null }, organization?: string) {
  if (!link.password_hash) return;
  const raw = (req.cookies ?? {})[cookieName(link.id)] ?? '';
  const [expStr, sig] = raw.split('.');
  const exp = Number(expStr);
  const setAt = link.password_set_at ? new Date(link.password_set_at).toISOString() : '';
  if (exp > Date.now() && sig && safeEqual(sig, unlockSig(link.id, setAt, exp))) return;
  throw new AppError(401, 'password_required', 'Dieser Upload-Link ist mit einem Passwort geschützt.', { organization: organization ?? null });
}

/** Verbrauch eines Links: Uploads (Vorgänge) und Bytes – übernommene Dateien plus offene Sitzungen. */
export async function linkUsage(linkId: string, db?: any, excludeSession?: string | null): Promise<LinkUsage & { files: number }> {
  const r = await one<any>(
    `SELECT (SELECT count(DISTINCT x.r) FROM (
               SELECT COALESCE(m.upload_ref, m.id::text) AS r FROM media m WHERE m.upload_link_id = $1 AND m.status <> 'rejected'
               UNION SELECT COALESCE(s.upload_ref, s.id::text) FROM upload_sessions s WHERE s.upload_link_id = $1 AND s.media_id IS NULL AND s.expires_at > now() AND s.id IS DISTINCT FROM $2::uuid) x)::int AS uploads,
            (SELECT COALESCE(sum(size_bytes),0) FROM media WHERE upload_link_id = $1 AND status <> 'rejected')
          + (SELECT COALESCE(sum(size_bytes),0) FROM upload_sessions WHERE upload_link_id = $1 AND media_id IS NULL AND expires_at > now() AND id IS DISTINCT FROM $2::uuid) AS bytes,
            (SELECT count(*)::int FROM media WHERE upload_link_id = $1 AND status <> 'rejected') AS files`,
    [linkId, excludeSession ?? null],
    db,
  );
  return { uploads: Number(r.uploads), bytes: Number(r.bytes), files: Number(r.files) };
}

/**
 * Grenzen eines Links für eine weitere Datei prüfen (Vorgangsnummer `ref`, Größe `size`). `alreadyCounted`: die Datei
 * steckt schon im Verbrauch (z. B. frisch eingefügte Medienzeile beim Abschluss).
 */
export async function assertLinkRoom(
  db: any,
  link: { id: string; max_uploads: number; max_files_per_upload: number; max_total_bytes: number | string },
  opts: { ref: string | null; size: number; excludeSession?: string | null; alreadyCounted?: boolean },
) {
  const maxUploads = Number(link.max_uploads) || 0;
  const perUpload = Number(link.max_files_per_upload) || 0;
  const maxBytes = Number(link.max_total_bytes) || 0;
  if (!maxUploads && !perUpload && !maxBytes) return;
  const usage = await linkUsage(link.id, db, opts.excludeSession);
  const add = opts.alreadyCounted ? 0 : opts.size;
  if (maxBytes && usage.bytes + add > maxBytes) throw new AppError(409, 'link_full', 'Über diesen Link ist die erlaubte Gesamtgröße erreicht.');
  if (opts.ref && (maxUploads || perUpload)) {
    const same = await one<any>(
      `SELECT (SELECT count(*) FROM media WHERE upload_link_id = $1 AND upload_ref = $2 AND status <> 'rejected')
            + (SELECT count(*) FROM upload_sessions WHERE upload_link_id = $1 AND upload_ref = $2 AND media_id IS NULL AND expires_at > now() AND id IS DISTINCT FROM $3::uuid) AS n`,
      [link.id, opts.ref, opts.excludeSession ?? null],
      db,
    );
    const inThisUpload = Number(same.n) - (opts.alreadyCounted ? 1 : 0);
    if (perUpload && inThisUpload + 1 > perUpload) throw new AppError(409, 'upload_full', `Je Upload sind höchstens ${perUpload} Dateien erlaubt. Für weitere Dateien die Seite neu laden.`);
    if (maxUploads && inThisUpload === 0 && usage.uploads - (opts.alreadyCounted ? 1 : 0) >= maxUploads) throw new AppError(409, 'link_full', 'Über diesen Link wurden bereits alle erlaubten Uploads durchgeführt.');
  }
}

/** Ist der Link wegen erreichter Grenze geschlossen („schließen bei Grenze“)? */
export async function linkClosedFull(link: { id: string; close_when_full: boolean; max_uploads: number; max_total_bytes: number | string }, db?: any) {
  if (!link.close_when_full || (!Number(link.max_uploads) && !Number(link.max_total_bytes))) return false;
  return linkIsFull(link, await linkUsage(link.id, db));
}
