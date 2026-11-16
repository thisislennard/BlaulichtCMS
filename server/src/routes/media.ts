import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAnyAuth, requireAuth } from '../auth/context.js';
import { audit, type Actor } from '../lib/audit.js';
import { checkDownloadRate } from '../lib/security-alerts.js';
import { aad, decrypt, encrypt, randomToken, sha256Hex } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { getSettings, privacyIncomplete, privacyInfo } from '../lib/settings.js';
import { publicBase } from '../lib/urls.js';
import { enqueue } from '../jobs/queue.js';

import { sendFileResponse } from './files.js';
import { exportPath } from '../media/exports.js';
import { publicFileName } from '../media/names.js';
import { privacyInput, renderPublic } from '../media/privacy.js';
import { purgeCollection } from '../lib/retention.js';
import { computeExpiry, extendExpiry, LINK_UNAVAILABLE, linkState } from '../media/links.js';
import { descendants } from '../media/folders.js';
import { trashCollection, trashMedia } from './media-trash.js';
import { noticeQuota } from '../lib/media-notify.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { auditThrottled } from '../lib/audit.js';
import { cleanFields, cleanUploader, DEFAULT_FIELDS, linkIsFull, type UploaderInput } from '../media/link-options.js';
import { assertLinkRoom, assertUnlocked, linkClosedFull, linkUsage, setUnlockCookie } from '../media/public-link.js';
import { acceptAttr, cleanTypeList, effectiveTypes, typeLabels } from '../media/types.js';
import { logPublicEvent, type PublicSecurityEvent } from '../lib/public-security.js';
import { resolveDesign } from '../media/design.js';
import { effectiveDesign } from './media-design.js';
import { assertFolder, loadFolders } from './media-organize.js';
import { freeBytes, mediaPaths, moveFile, SizeLimitError, streamToTemp } from '../media/storage.js';

const linkAad = aad.uploadLink;

/** Vorgangsnummer eines Upload-Vorgangs (#141): zwei Vierergruppen ohne verwechselbare Zeichen, z. B. „K7M2-Q9XD“. */
export const UPLOAD_REF_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export async function uploadLinkUrl(req: FastifyRequest | undefined, tokenEnc: string | null, linkId: string): Promise<string | null> {
  if (!tokenEnc) return null;
  return `${await publicBase(req)}/u/${decrypt(tokenEnc, linkAad(linkId))}`;
}

/** Adresse aus dem Klartext-Token (nur direkt nach Anlegen bzw. „Neu erzeugen“ bekannt). */
export async function freshLinkUrl(req: FastifyRequest | undefined, token: string) {
  return `${await publicBase(req)}/u/${token}`;
}

export async function linkPayload(req: FastifyRequest, l: any) {
  const base = linkState(l);
  // „Schließen bei Grenze“: Kontingent (Uploads oder Gesamtgröße) erreicht → Zustand „voll“
  const state = base === 'active' && l.close_when_full && linkIsFull(l, { uploads: Number(l.uploads ?? 0), bytes: Number(l.bytes ?? 0) }) ? 'full' : base;
  // Frisch angelegter oder neu erzeugter Link: Klartext-Token liegt nur in diesem Aufruf vor (auch bei „nur einmal anzeigen“)
  const url = l._token ? await freshLinkUrl(req, l._token) : state === 'active' || state === 'paused' ? await uploadLinkUrl(req, l.token_enc, l.id) : null;
  return {
    id: l.id,
    label: l.label,
    state,
    url,
    // Link nur einmal angezeigt (media.link_show_once): später nicht mehr abrufbar, „Neu erzeugen“ liefert einen neuen
    url_hidden: !l.token_enc && !l._token,
    shown_once: !!l._token && !l.token_enc,
    expires_at: l.expires_at,
    revoked_at: l.revoked_at,
    paused_at: l.paused_at ?? null,
    welcome_text: l.welcome_text ?? '',
    folder_id: l.folder_id ?? null,
    regenerated_at: l.regenerated_at ?? null,
    max_files: l.max_files,
    max_file_bytes: Number(l.max_file_bytes),
    upload_count: l.upload_count,
    last_used_at: l.last_used_at,
    created_at: l.created_at,
    created_by_name: l.created_by_name ?? null,
    bytes: l.bytes != null ? Number(l.bytes) : null,
    uploads: l.uploads != null ? Number(l.uploads) : null,
    // Erweiterte Optionen (Paket 6)
    max_uploads: Number(l.max_uploads ?? 0),
    max_files_per_upload: Number(l.max_files_per_upload ?? 0),
    max_total_bytes: Number(l.max_total_bytes ?? 0),
    close_when_full: !!l.close_when_full,
    allowed_types: l.allowed_types ?? null,
    fields: cleanFields(l.fields),
    consent_required: !!l.consent_required,
    consent_text: l.consent_text ?? '',
    has_password: !!l.password_hash,
  };
}

const ORIGINALS_FORBIDDEN = 'Originale (mit möglichen Standortdaten) dürfen nur Personen mit dem Recht „Originale herunterladen“ laden. Die öffentliche Fassung ist ohne Standort.';

/** Einen Sammeldownload sehen/laden darf, wer ihn angelegt hat, sowie wer „Originale herunterladen“ hat (#94). */
function mayAccessExport(req: FastifyRequest, ex: { created_by: string | null }) {
  if (req.auth!.permissions.has('media.download_original')) return true;
  return !!ex.created_by && ex.created_by === req.auth!.user?.id;
}

export function mediaPayload(m: any) {
  return {
    id: m.id,
    collection_id: m.collection_id,
    original_name: m.original_name,
    mime: m.mime,
    kind: m.kind,
    size_bytes: Number(m.size_bytes),
    width: m.width,
    height: m.height,
    status: m.status,
    reject_reason: m.reject_reason,
    reject_step: m.reject_step ?? null,
    has_preview: m.has_preview,
    has_public: m.has_public,
    had_location: m.had_location,
    location_stripped: !!m.location_stripped_at,
    sensitive_flags: m.sensitive_flags ?? [],
    redactions: m.redactions ?? [],
    crop: m.crop ?? null,
    strip_audio: !!m.strip_audio,
    public_rev: m.public_rev ?? 0,
    selection: m.selection,
    selection_version: m.selection_version ?? 0,
    sort_order: m.sort_order,
    display_name: m.display_name ?? '',
    description: m.description ?? '',
    internal_note: m.internal_note ?? '',
    duplicate_of: m.duplicate_of ?? null,
    folder_id: m.folder_id ?? null,
    tags: m.tags ?? [],
    uploader_note: m.uploader_note,
    uploaded_by_name: m.uploaded_by_name ?? null,
    // Link kann nach Ablauf der Löschfrist gelöscht sein (#116): ohne Konto hochgeladen = über einen Link
    via_link: !!m.upload_link_id || !m.uploaded_by,
    upload_ref: m.upload_ref ?? null,
    created_at: m.created_at,
  };
}

/** Legt eine Sammlung an (optional mit Beitrag verknüpft) – gemeinsam für API und „Fotos und Videos sammeln“. */
export async function createCollection(actor: Actor, userId: string | null, input: { title: string; purpose?: string; note?: string; postId?: string | null; eventDate?: string | null }, db: any = pool) {
  const s = await getSettings();
  const c = await one<any>(
    `INSERT INTO collections (title, purpose, note, post_id, max_files, max_bytes, created_by, event_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.title, input.purpose ?? '', input.note ?? '', input.postId ?? null, s['media.collection_max_files'], Math.round(s['media.collection_max_gb'] * 1024 ** 3), userId, input.eventDate ?? null],
    db,
  );
  await audit(actor, 'collection.created', { type: 'collection', id: c.id, label: c.title }, input.postId ? { beitrag: input.postId } : {}, 'ok', db);
  return c;
}

export interface LinkInput {
  days?: number;
  hours?: number;
  expiresAt?: string;
  label?: string;
  maxFiles?: number;
  welcomeText?: string;
  folderId?: string | null;
  maxUploads?: number;
  maxFilesPerUpload?: number;
  maxFileMb?: number;
  maxTotalMb?: number;
  closeWhenFull?: boolean;
  allowedTypes?: string[] | null;
  fields?: Record<string, string>;
  consentRequired?: boolean;
  consentText?: string;
  password?: string;
  removePassword?: boolean;
}

/** Erweiterte Link-Optionen prüfen und als Spaltenwerte liefern (nur gesetzte Felder). */
async function linkOptionColumns(input: LinkInput, s: Awaited<ReturnType<typeof getSettings>>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (input.maxUploads !== undefined) out.max_uploads = input.maxUploads;
  if (input.maxFilesPerUpload !== undefined) out.max_files_per_upload = input.maxFilesPerUpload;
  if (input.maxFileMb !== undefined) out.max_file_bytes = Math.min(input.maxFileMb, s['media.max_file_mb']) * 1024 * 1024;
  if (input.maxTotalMb !== undefined) out.max_total_bytes = input.maxTotalMb * 1024 * 1024;
  if (input.closeWhenFull !== undefined) out.close_when_full = input.closeWhenFull;
  if (input.allowedTypes !== undefined) {
    if (input.allowedTypes === null) out.allowed_types = null;
    else {
      const types = effectiveTypes(s['media.allowed_types'], cleanTypeList(input.allowedTypes));
      if (!types.length) throw badRequest('Bitte mindestens einen erlaubten Dateityp wählen.');
      out.allowed_types = types;
    }
  }
  if (input.fields !== undefined) out.fields = JSON.stringify(cleanFields(input.fields));
  if (input.consentRequired !== undefined) out.consent_required = input.consentRequired;
  if (input.consentText !== undefined) out.consent_text = input.consentText.trim().slice(0, 2000);
  if ((input.consentRequired ?? false) && input.consentText !== undefined && !input.consentText.trim()) throw badRequest('Für die Bestätigung bitte einen Text eingeben.');
  if (input.removePassword) {
    out.password_hash = null;
    out.password_set_at = null;
  } else if (input.password) {
    if (input.password.length < 10) throw badRequest('Das Passwort muss mindestens 10 Zeichen lang sein.');
    out.password_hash = await hashPassword(input.password);
    out.password_set_at = new Date();
  }
  return out;
}

async function applyLinkOptions(id: string, cols: Record<string, unknown>, db: any = pool) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  await db.query(`UPDATE upload_links SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => cols[k])]);
}

export async function createUploadLink(actor: Actor, userId: string | null, collectionId: string, input: LinkInput, db: any = pool) {
  const s = await getSettings();
  const token = randomToken(18);
  const id = crypto.randomUUID();
  const expires = computeExpiry(input, { defaultDays: s['media.link_default_days'], maxDays: s['media.link_max_days'] });
  // „Link nur einmal anzeigen“: nur die Prüfsumme speichern, Link/QR-Code gibt es genau in dieser Antwort
  const tokenEnc = s['media.link_show_once'] ? null : encrypt(token, linkAad(id));
  const l = await one<any>(
    `INSERT INTO upload_links (id, collection_id, token_hash, token_enc, label, expires_at, max_file_bytes, max_files, welcome_text, folder_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, collectionId, sha256Hex(token), tokenEnc, input.label ?? '', expires, s['media.max_file_mb'] * 1024 * 1024, Math.min(1000, input.maxFiles ?? s['media.link_max_files']), (input.welcomeText ?? '').trim().slice(0, 2000), await assertFolder(collectionId, input.folderId, db), userId],
    db,
  );
  // Neue Links schließen bei erreichter Grenze (wie LiFeOS); bestehende Links behalten ihr Verhalten
  const opts = await linkOptionColumns({ closeWhenFull: true, ...input }, s);
  await applyLinkOptions(l.id, opts, db);
  await audit(actor, 'upload_link.created', { type: 'upload_link', id: l.id, label: input.label || collectionId }, { sammlung: collectionId, gueltig_bis: expires.toISOString(), nur_einmal: !tokenEnc, optionen: Object.keys(opts).map((k) => (k === 'password_hash' ? 'passwort' : k)).filter((k) => k !== 'password_set_at') }, 'ok', db);
  return { ...(await one<any>(`SELECT * FROM upload_links WHERE id = $1`, [l.id], db)), _token: token };
}

/** Eingaben für die erweiterten Optionen eines Links (Anlegen und Bearbeiten). */
const linkOptionsSchema = {
  maxUploads: z.number().int().min(0).max(100000).optional(),
  maxFilesPerUpload: z.number().int().min(0).max(1000).optional(),
  maxFileMb: z.number().int().min(1).max(102400).optional(),
  maxTotalMb: z.number().int().min(0).max(1048576).optional(),
  closeWhenFull: z.boolean().optional(),
  allowedTypes: z.array(z.string().max(20)).max(20).nullable().optional(),
  fields: z.record(z.string(), z.enum(['off', 'optional', 'required'])).optional(),
  consentRequired: z.boolean().optional(),
  consentText: z.string().max(2000).optional(),
  password: z.string().max(200).optional(),
  removePassword: z.boolean().optional(),
};

/** Eingaben für Gültigkeit und Begrüßungstext eines Links (Anlegen). */
const linkInputSchema = z.object({
  days: z.number().int().min(1).max(3650).optional(),
  hours: z.number().int().min(1).max(87600).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  label: z.string().trim().max(80).default(''),
  maxFiles: z.number().int().min(1).max(1000).optional(),
  welcomeText: z.string().max(2000).default(''),
  folderId: z.uuid().nullable().optional(),
  ...linkOptionsSchema,
});

/** Nimmt genau eine Datei entgegen (Multipart), legt sie in Quarantäne und plant die Prüfung ein. */
async function receiveFile(req: FastifyRequest, opts: UploadContext) {
  const limit = await uploadAllowance(opts);

  const part = await req.file({ limits: { fileSize: limit, files: 1, fields: 12, fieldSize: 2000 } });
  if (!part) throw badRequest('Keine Datei empfangen.');
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(part.fields ?? {})) if (v && (v as any).type === 'field') fields[k] = String((v as any).value ?? '');
  const clientKey = fields.clientKey && /^[A-Za-z0-9_-]{8,80}$/.test(fields.clientKey) ? fields.clientKey : null;

  if (clientKey) {
    const existing = await one<any>(`SELECT * FROM media WHERE collection_id = $1 AND client_key = $2 AND deleted_at IS NULL`, [opts.collection.id, clientKey]);
    if (existing) {
      part.file.resume();
      return { media: mediaPayload(existing), duplicate: true };
    }
  }
  let stored;
  try {
    stored = await streamToTemp(part.file, limit);
  } catch (e) {
    if (e instanceof SizeLimitError) throw new AppError(413, 'file_too_large', limit < opts.maxFileBytes ? 'Die Datei passt nicht mehr in den verbleibenden Speicher der Sammlung.' : e.message);
    throw e;
  }
  if (stored.size === 0) {
    fs.rmSync(stored.tmpPath, { force: true });
    throw badRequest('Die Datei ist leer.');
  }
  const name = (part.filename || 'datei').replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 200);
  let extra: { uploader: Record<string, string> | null; consentAt: Date | null; note: string } = { uploader: null, consentAt: null, note: fields.note ?? '' };
  if (opts.link) {
    try {
      extra = publicUploaderFrom(opts.link, { uploader: { name: fields.name, email: fields.email, place: fields.place, date: fields.date }, consent: fields.consent === 'true' || fields.consent === '1', note: fields.note ?? '' });
    } catch (e) {
      fs.rmSync(stored.tmpPath, { force: true });
      throw e;
    }
  }
  return finalizeUpload({ ...opts, stored, name, declaredType: String(part.mimetype ?? ''), note: extra.note, uploader: extra.uploader, consentAt: extra.consentAt, uploadRef: UPLOAD_REF_RE.test(fields.ref ?? '') ? fields.ref : null, clientKey, folderId: opts.folderId ?? null });
}

/**
 * Angaben der Hochladenden für einen öffentlichen Link prüfen (abgefragte Felder, Pflichtfelder, Bestätigung).
 * Abgeschaltete Felder werden verworfen – auch der Hinweis, wenn der Link ihn nicht abfragt.
 */
export function publicUploaderFrom(link: any, input: { uploader?: UploaderInput; consent?: boolean; note?: string }) {
  const fields = cleanFields(link.fields);
  const note = fields.note === 'off' ? '' : String(input.note ?? '').slice(0, 500);
  const uploader = cleanUploader(fields, input.uploader, note);
  if (link.consent_required && !input.consent) throw badRequest('Bitte die Bestätigung ankreuzen.');
  return { uploader, consentAt: link.consent_required ? new Date() : null, note };
}

export interface UploadContext {
  collection: { id: string; max_files: number; max_bytes: number | string };
  linkId: string | null;
  userId: string | null;
  maxFileBytes: number;
  actor: Actor;
  /** Zielordner (Upload-Link mit Zielordner bzw. interner Upload in einen Ordner) */
  folderId?: string | null;
  /** Öffentlicher Link (Grenzen, abgefragte Angaben) */
  link?: any;
}

/**
 * Prüft Speicher, Dateianzahl und Umfang einer Sammlung; liefert die maximal erlaubte Dateigröße.
 * Verbindlich nur unter der Sammlungssperre (`db` in einer Transaktion mit `SELECT … FOR UPDATE` auf collections);
 * ohne Sperre ist es eine Vorprüfung, die finalizeUpload unter Sperre wiederholt (#151).
 */
export async function uploadAllowance(opts: UploadContext, db: any = pool): Promise<number> {
  const s = await getSettings();
  const free = freeBytes();
  if (free !== null && free < s['media.min_free_gb'] * 1024 ** 3) throw new AppError(507, 'storage_full', 'Der Speicher von BlaulichtCMS ist fast voll. Uploads sind vorübergehend gesperrt.');
  // Offene Upload-Sitzungen zählen mit (angemeldete Größe) – sonst ließe sich das Kontingent über viele parallele
  // Sitzungen umgehen und /data (samt eingebetteter Datenbank) volllaufen (#57)
  const usage = await one<{ n: number; bytes: number }>(
    `SELECT (SELECT count(*) FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected')
          + (SELECT count(*) FROM upload_sessions WHERE collection_id = $1 AND media_id IS NULL AND expires_at > now()) AS n,
            (SELECT COALESCE(sum(size_bytes),0) FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected')
          + (SELECT COALESCE(sum(size_bytes),0) FROM upload_sessions WHERE collection_id = $1 AND media_id IS NULL AND expires_at > now()) AS bytes`,
    [opts.collection.id],
    db,
  );
  usage!.n = Number(usage!.n);
  if (usage!.n >= opts.collection.max_files) throw new AppError(409, 'collection_full', 'Die Sammlung hat die maximale Anzahl an Dateien erreicht.');
  const remaining = Number(opts.collection.max_bytes) - Number(usage!.bytes);
  if (remaining <= 0) throw new AppError(409, 'collection_full', 'Der Speicherplatz dieser Sammlung ist ausgeschöpft.');
  return Math.min(opts.maxFileBytes, remaining);
}

/** Übernimmt eine vollständig empfangene Datei: Medienzeile, Quarantäne, Prüfauftrag – idempotent über den Client-Schlüssel. */
export async function finalizeUpload(
  opts: UploadContext & {
    stored: { tmpPath: string; size: number; sha256: string };
    name: string;
    declaredType: string;
    note: string;
    /** Vorgangsnummer der Upload-Seite (#141) */
    uploadRef?: string | null;
    clientKey: string | null;
    /** Abgefragte Angaben der Hochladenden und Zeitpunkt der Bestätigung (Paket 6) */
    uploader?: Record<string, string> | null;
    consentAt?: Date | string | null;
    /** Eigene Upload-Sitzung: zählt beim Byte-Kontingent nicht doppelt (#151). */
    sessionId?: string;
    /** Teildatei bei einem Fehler nicht löschen (fortsetzbarer Upload entscheidet selbst, #152). */
    keepTmpOnError?: boolean;
  },
) {
  const { stored, name, clientKey } = opts;
  try {
    const row = await tx(async (db) => {
      // Zuerst die Sammlung sperren: sonst sperren parallele Abschlüsse sie über den Fremdschlüssel in
      // unterschiedlicher Reihenfolge → Deadlock
      const col = await one<any>(`SELECT max_files, max_bytes, archived_at, deleted_at FROM collections WHERE id = $1 FOR UPDATE`, [opts.collection.id], db);
      // Während eines langen Uploads gelöscht oder geschlossen (#178): verständliche Meldung statt Fremdschlüssel-Fehler
      if (!col || col.deleted_at) throw new AppError(410, 'collection_gone', 'Diese Sammlung wurde inzwischen gelöscht. Die Datei wurde nicht übernommen.');
      if (col.archived_at) throw new AppError(410, 'link_closed', 'Diese Sammlung ist inzwischen geschlossen. Die Datei wurde nicht übernommen.');
      const m = await one<any>(
        `INSERT INTO media (collection_id, upload_link_id, uploaded_by, uploader_note, client_key, original_name, declared_type, size_bytes, sha256, upload_ref, folder_id, uploader, consent_at, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 (SELECT id FROM collection_folders WHERE id = $11::uuid AND collection_id = $1 AND deleted_at IS NULL), $12, $13,
                 (SELECT COALESCE(max(sort_order),0)+1 FROM media WHERE collection_id = $1))
         ON CONFLICT (collection_id, client_key) WHERE client_key IS NOT NULL AND deleted_at IS NULL DO NOTHING
         RETURNING *`,
        [opts.collection.id, opts.linkId, opts.userId, opts.note.slice(0, 500), clientKey, name, opts.declaredType.slice(0, 100), stored.size, stored.sha256, opts.uploadRef ?? null, opts.folderId ?? null, opts.uploader ? JSON.stringify(opts.uploader) : null, opts.consentAt ?? null],
        db,
      );
      if (!m) return null;
      // Grenzen des Links (Uploads, Dateien je Upload, Gesamtgröße) unter Sperre – die neue Datei zählt schon mit
      if (opts.link) await assertLinkRoom(db, opts.link, { ref: opts.uploadRef ?? m.id, size: stored.size, excludeSession: opts.sessionId ?? null, alreadyCounted: true });
      // Grenzen unter Sperre erneut prüfen (parallele Abschlüsse)
      const cnt = await one<any>(`SELECT count(*)::int AS n FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected'`, [opts.collection.id], db);
      if (cnt!.n > col.max_files) throw new AppError(409, 'collection_full', 'Die Sammlung hat die maximale Anzahl an Dateien erreicht.');
      // Auch das Byte-Kontingent unter Sperre prüfen: Medien (inkl. dieser Datei) plus andere offene Sitzungen (#151)
      const used = await one<any>(
        `SELECT (SELECT COALESCE(sum(size_bytes),0) FROM media WHERE collection_id = $1 AND deleted_at IS NULL AND status <> 'rejected')
              + (SELECT COALESCE(sum(size_bytes),0) FROM upload_sessions WHERE collection_id = $1 AND media_id IS NULL AND expires_at > now() AND id IS DISTINCT FROM $2::uuid) AS bytes`,
        [opts.collection.id, opts.sessionId ?? null],
        db,
      );
      if (Number(used!.bytes) > Number(col.max_bytes)) throw new AppError(409, 'collection_full', 'Der Speicherplatz dieser Sammlung ist ausgeschöpft.');
      let linkFull = false;
      if (opts.linkId) {
        const ok = await db.query(`UPDATE upload_links SET upload_count = upload_count + 1, last_used_at = now() WHERE id = $1 AND upload_count < max_files RETURNING upload_count >= max_files AS full`, [opts.linkId]);
        if (!ok.rowCount) throw new AppError(409, 'link_full', 'Über diesen Link wurden bereits alle erlaubten Dateien hochgeladen.');
        linkFull = !!ok.rows[0].full;
      }
      moveFile(stored.tmpPath, mediaPaths.quarantine(m.id));
      await enqueue('media.process', { mediaId: m.id }, { dedupKey: `media.process:${m.id}` }, db);
      return Object.assign(m, { _linkFull: linkFull, _collectionFull: cnt!.n >= col.max_files || Number(used!.bytes) >= Number(col.max_bytes) });
    });
    if (!row) {
      fs.rmSync(stored.tmpPath, { force: true });
      const existing = await one<any>(`SELECT * FROM media WHERE collection_id = $1 AND client_key = $2 AND deleted_at IS NULL`, [opts.collection.id, clientKey]);
      return { media: mediaPayload(existing), duplicate: true };
    }
    await audit(opts.actor, 'media.uploaded', { type: 'media', id: row.id, label: name }, { sammlung: opts.collection.id, bytes: stored.size, link: opts.linkId });
    // Kontingent gerade erreicht: einmal benachrichtigen (Paket 5)
    if (row._linkFull && opts.linkId) await noticeQuota('link', opts.linkId);
    if (row._collectionFull) await noticeQuota('collection', opts.collection.id);
    return { media: mediaPayload(row), duplicate: false };
  } catch (e) {
    if (!opts.keepTmpOnError) fs.rmSync(stored.tmpPath, { force: true });
    throw e;
  }
}

export function publicFileFor(m: any): { path: string; type: string; ext: string } | null {
  if (!m.has_public) return null;
  if (m.kind === 'image') return { path: mediaPaths.publicFile(m.id, 'jpg'), type: 'image/jpeg', ext: 'jpg' };
  const ext = m.mime === 'video/webm' ? 'webm' : 'mp4';
  return { path: mediaPaths.publicFile(m.id, ext), type: ext === 'webm' ? 'video/webm' : 'video/mp4', ext };
}



/** Kontext für Uploads über einen öffentlichen Link: gültig, freigeschaltet (Passwort), nicht voll („schließen bei Grenze“). */
export async function publicUploadContext(req: FastifyRequest, token: string): Promise<UploadContext & { link: any }> {
  const l = await loadPublicLink(token, req.ip);
  assertUnlocked(req, l);
  if (await linkClosedFull(l)) {
    await logPublicEvent('link_unavailable_hit', { linkId: l.id, ip: req.ip, detail: 'Kontingent erreicht' });
    throw new AppError(410, 'link_unavailable', LINK_UNAVAILABLE);
  }
  const s = await getSettings();
  return {
    link: l,
    collection: { id: l.c_id, max_files: l.c_max_files, max_bytes: l.c_max_bytes },
    linkId: l.id,
    userId: null,
    maxFileBytes: Math.min(Number(l.max_file_bytes), s['media.max_file_mb'] * 1024 * 1024),
    actor: { id: null, name: `Upload-Link ${l.label || l.id.slice(0, 8)}`, type: 'system', ip: req.ip } as Actor,
    folderId: l.folder_id ?? null,
  };
}

/** Sicherheitsereignis der öffentlichen Seiten (lib/public-security.ts). */
async function publicSecurityEvent(req: FastifyRequest, event: PublicSecurityEvent, opts: { linkId?: string; detail?: string }) {
  await logPublicEvent(event, { linkId: opts.linkId, ip: req.ip, detail: opts.detail });
}

/** Grenzen/Speicher bei öffentlichen Uploads als Sicherheitsereignis festhalten (ohne die Antwort zu ändern). */
export async function withPublicEvents<T>(req: FastifyRequest, linkId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && ['link_full', 'collection_full', 'upload_full'].includes(e.code)) await publicSecurityEvent(req, 'quota_reached', { linkId, detail: e.code });
    if (e instanceof AppError && e.code === 'storage_full') await publicSecurityEvent(req, 'storage_low', { linkId });
    throw e;
  }
}

/** Rate-Limit öffentlicher Routen: Überschreitungen mit bekanntem Link als Sicherheitsereignis (je Fenster einmal). */
export function publicRateLimit(max: number) {
  return {
    max,
    timeWindow: '1 minute',
    onExceeded: (req: FastifyRequest) => {
      const token = String((req.params as any)?.token ?? '');
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(token)) return;
      void one<any>(`SELECT id FROM upload_links WHERE token_hash = $1`, [sha256Hex(token)])
        .then((l) => (l ? logPublicEvent('rate_limited', { linkId: l.id, ip: req.ip, detail: `${req.method} ${req.routeOptions?.url ?? ''}` }) : undefined))
        .catch(() => {});
    },
  };
}

export async function loadPublicLink(token: string, ip?: string) {
  const l = await one<any>(
    `SELECT l.*, c.title AS c_title, c.purpose AS c_purpose, c.note AS c_note, c.event_date AS c_event_date, COALESCE(c.archived_at, c.deleted_at) AS c_archived, c.id AS c_id, c.max_files AS c_max_files, c.max_bytes AS c_max_bytes
       FROM upload_links l JOIN collections c ON c.id = l.collection_id WHERE l.token_hash = $1`,
    [sha256Hex(token)],
  );
  // Einheitliche Meldung (wie LiFeOS): verrät nicht, ob es den Link gibt und warum er nicht (mehr) geht
  if (!l) throw new AppError(404, 'link_unavailable', LINK_UNAVAILABLE);
  if (l.revoked_at || new Date(l.expires_at).getTime() <= Date.now() || l.paused_at || l.c_archived) {
    // Grund nur intern im Sicherheitsprotokoll; nach außen dieselbe Meldung
    const why = l.revoked_at ? 'widerrufen' : new Date(l.expires_at).getTime() <= Date.now() ? 'abgelaufen' : l.paused_at ? 'pausiert' : 'Sammlung geschlossen';
    await logPublicEvent('link_unavailable_hit', { linkId: l.id, ip, detail: why });
    throw new AppError(410, 'link_unavailable', LINK_UNAVAILABLE);
  }
  return l;
}

export async function mediaRoutes(app: FastifyInstance) {
  /* ------------------------------ Sammlungen (angemeldet) ------------------------------ */

  app.get('/collections', { preHandler: requireAuth('media.view') }, async (req) => {
    const q = z
      .object({
        archived: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default(false),
        postId: z.uuid().optional(),
        // Übersicht mit Suche, Statusfilter und Seiten (wie die Themenliste in LiFeOS)
        paged: z.enum(['1', 'true']).optional(),
        q: z.string().trim().max(100).optional(),
        status: z.enum(['active', 'archived', 'all']).optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        perPage: z.coerce.number().int().min(6).max(96).default(24),
      })
      .parse(req.query);
    const status = q.status ?? (q.archived ? 'all' : 'active');
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const where = `c.deleted_at IS NULL AND ($1 = 'all' OR ($1 = 'active') = (c.archived_at IS NULL)) AND ($2::uuid IS NULL OR c.post_id = $2)
                   AND ($3::text IS NULL OR c.title ILIKE $3 OR c.purpose ILIKE $3 OR c.note ILIKE $3)`;
    const params = [status, q.postId ?? null, like];
    const rows = await many<any>(
      // Zähler in einem Durchlauf je Sammlung (Index media_collection_state_idx) statt vier Unterabfragen, Titelbild
      // über media_cover_pick_idx; erst die Seite auswählen, dann zählen (#192: 200 Sammlungen 57 ms → 4 ms)
      `SELECT c.*, p.title AS post_title, mc.media_count, mc.quarantine_count, mc.selected_count, mc.pending_count,
              (SELECT count(*)::int FROM upload_links l WHERE l.collection_id = c.id AND l.revoked_at IS NULL AND l.expires_at > now()) AS active_links,
              COALESCE(
                (SELECT m.id FROM media m WHERE m.id = c.cover_media_id AND m.deleted_at IS NULL AND m.status = 'ready' AND m.has_preview),
                (SELECT m.id FROM media m WHERE m.collection_id = c.id AND m.deleted_at IS NULL AND m.status = 'ready' AND m.has_preview ORDER BY (m.selection = 'selected') DESC, m.sort_order LIMIT 1)) AS cover_id
         FROM (SELECT c.* FROM collections c WHERE ${where}
                ORDER BY COALESCE(c.event_date::timestamptz, c.created_at) DESC, c.created_at DESC LIMIT $4 OFFSET $5) c
         LEFT JOIN posts p ON p.id = c.post_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE m.status = 'ready')::int AS media_count,
                  count(*) FILTER (WHERE m.status = 'quarantine')::int AS quarantine_count,
                  count(*) FILTER (WHERE m.status = 'ready' AND m.selection = 'selected')::int AS selected_count,
                  count(*) FILTER (WHERE m.status = 'ready' AND m.selection = 'pending')::int AS pending_count
             FROM media m WHERE m.collection_id = c.id AND m.deleted_at IS NULL) mc ON true
        ORDER BY COALESCE(c.event_date::timestamptz, c.created_at) DESC, c.created_at DESC`,
      [...params, q.paged ? q.perPage : 200, q.paged ? (q.page - 1) * q.perPage : 0],
    );
    if (!q.paged) return rows;
    const total = (await one<any>(`SELECT count(*)::int AS n FROM collections c WHERE ${where}`, params))!.n;
    return { items: rows, total, page: q.page, pages: Math.max(1, Math.ceil(total / q.perPage)) };
  });

  app.post('/collections', { preHandler: requireAuth('media.collections') }, async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(2).max(120),
        purpose: z.string().trim().max(300).default(''),
        note: z.string().trim().max(1000).default(''),
        postId: z.uuid().nullable().optional(),
        eventDate: z.iso.date().nullable().optional(),
        createLink: z.boolean().default(true),
        linkDays: z.number().int().min(1).max(3650).optional(),
        linkHours: z.number().int().min(1).max(87600).optional(),
        linkExpiresAt: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(req.body);
    if (body.createLink && !req.auth!.permissions.has('media.links')) throw forbidden('Zum Erstellen des Upload-Links fehlt das Recht „Upload-Links verwalten“.');
    if (body.postId && !(await one('SELECT 1 FROM posts WHERE id = $1', [body.postId]))) throw notFound('Beitrag nicht gefunden.');
    const userId = req.auth!.user?.id ?? null;
    const { c, l } = await tx(async (db) => {
      const c = await createCollection(req.auth!.actor, userId, { title: body.title, purpose: body.purpose, note: body.note, postId: body.postId, eventDate: body.eventDate }, db);
      const l = body.createLink ? await createUploadLink(req.auth!.actor, userId, c.id, { days: body.linkDays, hours: body.linkHours, expiresAt: body.linkExpiresAt }, db) : null;
      return { c, l };
    });
    return { collection: c, link: l ? await linkPayload(req, l) : null };
  });

  app.get('/collections/:id', { preHandler: requireAuth('media.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await one<any>(`SELECT c.*, p.title AS post_title, u.name AS created_by_name FROM collections c LEFT JOIN posts p ON p.id = c.post_id LEFT JOIN users u ON u.id = c.created_by WHERE c.id = $1`, [id]);
    // Sammlung im Papierkorb: nur für „Medien verwalten“ sichtbar (zum Wiederherstellen)
    if (!c || (c.deleted_at && !req.auth!.permissions.has('media.trash'))) throw notFound('Sammlung nicht gefunden.');
    const media = await many<any>(
      `SELECT m.*, u.name AS uploaded_by_name,
              (SELECT array_agg(t.name ORDER BY lower(t.name)) FROM media_tag_links l JOIN media_tags t ON t.id = l.tag_id WHERE l.media_id = m.id) AS tags
         FROM media m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.collection_id = $1 AND m.deleted_at IS NULL ORDER BY m.sort_order, m.created_at`,
      [id],
    );
    const folders = await many<any>(
      `SELECT f.id, f.parent_id, f.name, f.sort_order, f.archived_at FROM collection_folders f WHERE f.collection_id = $1 AND f.deleted_at IS NULL ORDER BY f.sort_order, lower(f.name)`,
      [id],
    );
    const links = req.auth!.permissions.has('media.links')
      ? await many<any>(
          `SELECT l.*, u.name AS created_by_name,
                  (SELECT COALESCE(sum(m.size_bytes),0) FROM media m WHERE m.upload_link_id = l.id AND m.status <> 'rejected') AS bytes,
                  (SELECT count(DISTINCT COALESCE(m.upload_ref, m.id::text))::int FROM media m WHERE m.upload_link_id = l.id AND m.status <> 'rejected') AS uploads
             FROM upload_links l LEFT JOIN users u ON u.id = l.created_by WHERE l.collection_id = $1 ORDER BY l.created_at DESC`,
          [id],
        )
      : [];
    return {
      collection: { ...c, max_bytes: Number(c.max_bytes) },
      media: media.map(mediaPayload),
      folders,
      // Mit Grenzen: genauer Verbrauch inklusive offener Upload-Sitzungen (wie die öffentliche Seite)
      links: await Promise.all(links.map(async (l) => linkPayload(req, Number(l.max_uploads) || Number(l.max_total_bytes) ? { ...l, ...(await linkUsage(l.id)) } : l))),
      accept: acceptAttr(effectiveTypes((await getSettings())['media.allowed_types'], null)),
    };
  });

  app.patch('/collections/:id', { preHandler: requireAuth('media.collections') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(2).max(120).optional(),
        purpose: z.string().trim().max(300).optional(),
        note: z.string().trim().max(1000).optional(),
        postId: z.uuid().nullable().optional(),
        archived: z.boolean().optional(),
        eventDate: z.iso.date().nullable().optional(),
        coverMediaId: z.uuid().nullable().optional(),
      })
      .parse(req.body);
    if (body.postId && !(await one('SELECT 1 FROM posts WHERE id = $1', [body.postId]))) throw notFound('Beitrag nicht gefunden.');
    if (body.coverMediaId && !(await one(`SELECT 1 FROM media WHERE id = $1 AND collection_id = $2 AND status = 'ready' AND deleted_at IS NULL`, [body.coverMediaId, id]))) throw badRequest('Als Titelbild eignet sich nur eine geprüfte Datei dieser Sammlung.');
    const c = await one<any>(
      `UPDATE collections SET title = COALESCE($2, title), purpose = COALESCE($3, purpose), note = COALESCE($4, note),
              post_id = CASE WHEN $5 THEN $6::uuid ELSE post_id END,
              archived_at = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN COALESCE(archived_at, now()) ELSE NULL END,
              event_date = CASE WHEN $8 THEN $9::date ELSE event_date END,
              cover_media_id = CASE WHEN $10 THEN $11::uuid ELSE cover_media_id END
        WHERE id = $1 RETURNING *`,
      [id, body.title ?? null, body.purpose ?? null, body.note ?? null, body.postId !== undefined, body.postId ?? null, body.archived ?? null, body.eventDate !== undefined, body.eventDate ?? null, body.coverMediaId !== undefined, body.coverMediaId ?? null],
    );
    if (!c) throw notFound('Sammlung nicht gefunden.');
    await audit(req.auth!.actor, body.postId !== undefined ? 'collection.assigned' : 'collection.updated', { type: 'collection', id, label: c.title }, { felder: Object.keys(body) });
    return c;
  });

  /*
   * Sammlung endgültig löschen (#97): Originale, Vorschauen, öffentliche Fassungen, Sammeldownloads, Upload-Links und
   * -Sitzungen. Dateien in der aktuellen Fassung eines nicht archivierten Beitrags blockieren (409 mit Beitragstiteln).
   */
  app.delete('/collections/:id', { preHandler: requireAuth('media.trash') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { permanent } = z.object({ permanent: z.enum(['1', 'true']).optional() }).parse(req.query ?? {});
    // Standard: Papierkorb. Sofort endgültig (ohne Papierkorb) nur mit „Medien administrieren“
    if (!permanent) {
      const r = await trashCollection(id, req.auth!.actor, req.auth!.user?.id ?? null);
      return { ok: true, media: r.media, trash: true };
    }
    if (!req.auth!.permissions.has('media.admin')) throw forbidden('Endgültig löschen darf nur, wer „Medien administrieren“ hat. Die Sammlung lässt sich in den Papierkorb verschieben.');
    const r = await purgeCollection(id, req.auth!.actor, 'manual');
    return { ok: true, media: r.media, exports: r.exports };
  });

  app.post('/collections/:id/links', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = linkInputSchema.parse(req.body ?? {});
    const c = await one<any>('SELECT id, archived_at FROM collections WHERE id = $1', [id]);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    if (c.archived_at) throw badRequest('Die Sammlung ist archiviert.');
    const l = await createUploadLink(req.auth!.actor, req.auth!.user?.id ?? null, id, body);
    return linkPayload(req, l);
  });

  /** Link laden, der noch geändert werden darf (nicht widerrufen). */
  const changeableLink = async (id: string) => {
    const l = await one<any>(`SELECT * FROM upload_links WHERE id = $1`, [id]);
    if (!l) throw notFound('Link nicht gefunden.');
    if (l.revoked_at) throw badRequest('Der Link ist widerrufen und lässt sich nicht mehr ändern.');
    return l;
  };

  app.post('/upload-links/:id/revoke', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const l = await one<any>(`UPDATE upload_links SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $2) WHERE id = $1 RETURNING *`, [id, req.auth!.user?.id ?? null]);
    if (!l) throw notFound('Link nicht gefunden.');
    await audit(req.auth!.actor, 'upload_link.revoked', { type: 'upload_link', id, label: l.label || l.collection_id });
    return linkPayload(req, l);
  });

  /* Pausieren: niemand kann hochladen; nach „Fortsetzen“ gilt der Link (auch gedruckt) wieder */
  app.post('/upload-links/:id/pause', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await changeableLink(id);
    const l = await one<any>(`UPDATE upload_links SET paused_at = COALESCE(paused_at, now()), paused_by = COALESCE(paused_by, $2) WHERE id = $1 RETURNING *`, [id, req.auth!.user?.id ?? null]);
    await audit(req.auth!.actor, 'upload_link.paused', { type: 'upload_link', id, label: l.label || l.collection_id });
    return linkPayload(req, l);
  });

  app.post('/upload-links/:id/resume', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const cur = await changeableLink(id);
    if (new Date(cur.expires_at).getTime() <= Date.now()) throw badRequest('Der Link ist abgelaufen – bitte zuerst verlängern.');
    const l = await one<any>(`UPDATE upload_links SET paused_at = NULL, paused_by = NULL WHERE id = $1 RETURNING *`, [id]);
    await audit(req.auth!.actor, 'upload_link.resumed', { type: 'upload_link', id, label: l.label || l.collection_id });
    return linkPayload(req, l);
  });

  /* Verlängern um eine Dauer (ab dem bisherigen Ablauf, bei abgelaufenem Link ab jetzt) */
  app.post('/upload-links/:id/extend', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { hours } = z.object({ hours: z.number().int().min(1).max(87600) }).parse(req.body ?? {});
    const cur = await changeableLink(id);
    const s = await getSettings();
    const expires = extendExpiry(cur.expires_at, hours, s['media.link_max_days']);
    const l = await one<any>(`UPDATE upload_links SET expires_at = $2, expiring_notified_at = NULL WHERE id = $1 RETURNING *`, [id, expires]);
    await audit(req.auth!.actor, 'upload_link.extended', { type: 'upload_link', id, label: l.label || l.collection_id }, { stunden: hours, gueltig_bis: expires.toISOString() });
    return linkPayload(req, l);
  });

  /* Bezeichnung, Begrüßungstext und Ablauftermin („Bis Termin“, auch früher) ändern */
  app.patch('/upload-links/:id', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ label: z.string().trim().max(80).optional(), welcomeText: z.string().max(2000).optional(), expiresAt: z.iso.datetime({ offset: true }).optional(), folderId: z.uuid().nullable().optional(), ...linkOptionsSchema })
      .parse(req.body ?? {});
    const cur = await changeableLink(id);
    const s = await getSettings();
    const optCols = await linkOptionColumns(body, s);
    await applyLinkOptions(id, { ...optCols, ...(optCols.max_uploads !== undefined || optCols.max_total_bytes !== undefined ? { quota_notified_at: null } : {}) });
    const expires = body.expiresAt ? computeExpiry({ expiresAt: body.expiresAt }, { defaultDays: s['media.link_default_days'], maxDays: s['media.link_max_days'] }) : null;
    const folder = body.folderId !== undefined ? await assertFolder(cur.collection_id, body.folderId) : null;
    const l = await one<any>(
      `UPDATE upload_links SET label = COALESCE($2, label), welcome_text = COALESCE($3, welcome_text), expires_at = COALESCE($4, expires_at),
              expiring_notified_at = CASE WHEN $4::timestamptz IS NULL THEN expiring_notified_at END,
              folder_id = CASE WHEN $5 THEN $6::uuid ELSE folder_id END
        WHERE id = $1 RETURNING *`,
      [id, body.label ?? null, body.welcomeText !== undefined ? body.welcomeText.trim() : null, expires, body.folderId !== undefined, folder],
    );
    await audit(req.auth!.actor, 'upload_link.updated', { type: 'upload_link', id, label: l.label || l.collection_id }, { felder: Object.keys(body).map((k) => (k === 'password' ? 'passwort' : k)), ...(expires ? { gueltig_bis: expires.toISOString() } : {}) });
    return linkPayload(req, { ...l, ...(await linkUsage(id)) });
  });

  /* Angaben aller Uploads dieses Links löschen (Name, E-Mail, Ort, Datum, Hinweis) – Dateien bleiben */
  app.post('/upload-links/:id/clear-uploader', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const l = await one<any>(`SELECT id, label, collection_id FROM upload_links WHERE id = $1`, [id]);
    if (!l) throw notFound('Link nicht gefunden.');
    const r = await pool.query(`UPDATE media SET uploader = NULL, uploader_note = '' WHERE upload_link_id = $1 AND (uploader IS NOT NULL OR uploader_note <> '')`, [id]);
    await pool.query(`UPDATE upload_sessions SET uploader = NULL, note = '' WHERE upload_link_id = $1`, [id]);
    await audit(req.auth!.actor, 'upload_link.uploader_cleared', { type: 'upload_link', id, label: l.label || l.collection_id }, { dateien: r.rowCount });
    return { ok: true, media: r.rowCount };
  });

  /* Neu erzeugen: neuer Token mit denselben Einstellungen – alter Link, QR-Code und Aushang sind sofort ungültig */
  app.post('/upload-links/:id/regenerate', { preHandler: requireAuth('media.links') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await changeableLink(id);
    const s = await getSettings();
    const token = randomToken(18);
    const l = await one<any>(`UPDATE upload_links SET token_hash = $2, token_enc = $3, regenerated_at = now() WHERE id = $1 RETURNING *`, [
      id,
      sha256Hex(token),
      s['media.link_show_once'] ? null : encrypt(token, linkAad(id)),
    ]);
    // Weiterleitungen alter Import-Links würden sonst auf den neuen Token zeigen
    await pool.query(`DELETE FROM legacy_links WHERE link_id = $1`, [id]);
    await audit(req.auth!.actor, 'upload_link.regenerated', { type: 'upload_link', id, label: l.label || l.collection_id });
    return linkPayload(req, { ...l, _token: token });
  });

  /* Upload durch angemeldete Personen (Redaktion, Medienverwaltung) */
  app.post('/collections/:id/media', { preHandler: requireAuth('media.upload'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const c = await one<any>('SELECT * FROM collections WHERE id = $1', [id]);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    if (c.archived_at) throw badRequest('Die Sammlung ist archiviert.');
    const s = await getSettings();
    const { folderId } = z.object({ folderId: z.uuid().optional() }).parse(req.query ?? {});
    return receiveFile(req, { collection: c, linkId: null, userId: req.auth!.user?.id ?? null, maxFileBytes: s['media.max_file_mb'] * 1024 * 1024, actor: req.auth!.actor, folderId: await assertFolder(id, folderId) });
  });

  /*
   * Sichtung: auswählen / überspringen / zurückstellen / zurücksetzen – mehrere Dateien auf einmal.
   * Mit `versions` (Sichtungsdialog) gilt die Entscheidung nur, wenn niemand die Datei inzwischen anders gesichtet
   * hat (409 statt „letzter gewinnt“, wie die Versionsprüfung in LiFeOS).
   */
  app.post('/media/selection', { preHandler: requireAuth('media.review') }, async (req) => {
    const body = z
      .object({ ids: z.array(z.uuid()).min(1).max(500), selection: z.enum(['pending', 'selected', 'skipped', 'on_hold']), versions: z.record(z.string(), z.number().int().min(0)).optional() })
      .parse(req.body);
    const versions = body.versions ?? null;
    const rows = await many<any>(
      `UPDATE media SET selection = $2, selection_by = $3, selection_at = now(), selection_version = selection_version + 1
        WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL AND ($4::jsonb IS NULL OR NOT ($4::jsonb ? id::text) OR selection_version = ($4::jsonb ->> id::text)::int)
        RETURNING id, selection_version`,
      [body.ids, body.selection, req.auth!.user?.id ?? null, versions ? JSON.stringify(versions) : null],
    );
    if (versions && rows.length < body.ids.length) {
      const stale = await many<any>(`SELECT m.id, m.selection, u.name FROM media m LEFT JOIN users u ON u.id = m.selection_by WHERE m.id = ANY($1) AND NOT (m.id = ANY($2::uuid[]))`, [body.ids, rows.map((r) => r.id)]);
      if (stale.length) {
        const who = stale[0].name ? ` von ${stale[0].name}` : '';
        throw conflict(`Diese Datei wurde inzwischen${who} anders gesichtet. Bitte die Ansicht neu laden.`, { media: stale.map((x) => ({ id: x.id, selection: x.selection })) });
      }
    }
    await audit(req.auth!.actor, 'media.selection', { type: 'media', label: `${rows.length} Datei(en)` }, { auswahl: body.selection, ids: body.ids.slice(0, 50) });
    return { updated: rows.length, versions: Object.fromEntries(rows.map((r) => [r.id, r.selection_version])) };
  });

  /* Anzeigename, Beschreibung und interne Notiz (nur intern; der öffentliche Dateiname bleibt neutral) */
  app.patch('/media/:id', { preHandler: requireAuth('media.organize') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ displayName: z.string().trim().max(200).optional(), description: z.string().trim().max(2000).optional(), internalNote: z.string().trim().max(2000).optional() })
      .parse(req.body ?? {});
    const m = await one<any>(
      `UPDATE media SET display_name = COALESCE($2, display_name), description = COALESCE($3, description), internal_note = COALESCE($4, internal_note)
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, body.displayName ?? null, body.description ?? null, body.internalNote ?? null],
    );
    if (!m) throw notFound('Datei nicht gefunden.');
    await audit(req.auth!.actor, 'media.updated', { type: 'media', id, label: m.original_name }, { felder: Object.keys(body) });
    return mediaPayload(m);
  });

  /* Details je Datei: Prüfsumme, Duplikate, Upload-Angaben, Beiträge, die die Datei verwenden */
  app.get('/media/:id/details', { preHandler: requireAuth('media.view') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const m = await one<any>(
      `SELECT m.*, u.name AS uploaded_by_name, c.title AS collection_title, l.label AS link_label, s.name AS selection_by_name
         FROM media m JOIN collections c ON c.id = m.collection_id LEFT JOIN users u ON u.id = m.uploaded_by
         LEFT JOIN upload_links l ON l.id = m.upload_link_id LEFT JOIN users s ON s.id = m.selection_by
        WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [id],
    );
    if (!m) throw notFound('Datei nicht gefunden.');
    const duplicates = await many<any>(
      `SELECT m.id, m.collection_id, c.title AS collection_title, m.original_name, m.display_name, m.created_at FROM media m JOIN collections c ON c.id = m.collection_id
        WHERE m.sha256 = $1 AND m.id <> $2 AND m.deleted_at IS NULL AND m.status <> 'rejected' ORDER BY m.created_at LIMIT 20`,
      [m.sha256, id],
    );
    const posts = await many<any>(
      `SELECT DISTINCT p.id, p.title, (r.number = p.current_revision) AS current FROM post_revisions r JOIN posts p ON p.id = r.post_id
        WHERE (r.media_ids @> ARRAY[$1::uuid] OR r.cover_id = $1) ORDER BY current DESC, p.title LIMIT 20`,
      [id],
    );
    return {
      media: mediaPayload(m),
      // Angaben der Hochladenden (personenbezogen) nur mit „Medien verwalten“
      uploader: req.auth!.permissions.has('media.review') ? (m.uploader ?? null) : null,
      consent_at: req.auth!.permissions.has('media.review') ? (m.consent_at ?? null) : null,
      sha256: m.sha256,
      collection_title: m.collection_title,
      link_label: m.link_label ?? null,
      selection_by_name: m.selection_by_name ?? null,
      selection_at: m.selection_at ?? null,
      processed_at: m.processed_at ?? null,
      duplicates,
      posts,
    };
  });

  /* Sammelaktionen für markierte Dateien (Mehrfachauswahl wie in LiFeOS) */
  app.post('/media/bulk', { preHandler: requireAnyAuth('media.review', 'media.trash'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({ ids: z.array(z.uuid()).min(1).max(1000), action: z.enum(['selection', 'delete']), selection: z.enum(['pending', 'selected', 'skipped', 'on_hold']).optional() })
      .parse(req.body);
    if (!req.auth!.permissions.has(body.action === 'delete' ? 'media.trash' : 'media.review')) throw forbidden();
    if (body.action === 'selection') {
      if (!body.selection) throw badRequest('Bitte einen Sichtungsstand wählen.');
      const r = await pool.query(
        `UPDATE media SET selection = $2, selection_by = $3, selection_at = now(), selection_version = selection_version + 1 WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL`,
        [body.ids, body.selection, req.auth!.user?.id ?? null],
      );
      await audit(req.auth!.actor, 'media.selection', { type: 'media', label: `${r.rowCount} Datei(en)` }, { auswahl: body.selection, sammelaktion: true, ids: body.ids.slice(0, 50) });
      return { updated: r.rowCount };
    }
    const r = await trashMedia(body.ids, req.auth!.actor, req.auth!.user?.id ?? null);
    return { updated: r.deleted };
  });

  app.post('/collections/:id/order', { preHandler: requireAuth('media.organize') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(2000) }).parse(req.body);
    // Eine Anweisung statt einer je Datei (#192: bis zu 2 000 Einzel-UPDATEs unter Sperre)
    await pool.query(
      `UPDATE media m SET sort_order = o.pos FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos) WHERE m.id = o.id AND m.collection_id = $1`,
      [id, ids],
    );
    return { ok: true };
  });

  /** ZIP-Auftrag anlegen (gemeinsam für Sammlung, Ordner und sammlungsübergreifende Auswahl). */
  async function requestExport(req: FastifyRequest, opts: { collectionId: string | null; label: string; ids: string[]; variant: 'public' | 'original'; withFolders: boolean; withCsv: boolean; audit: Record<string, unknown> }) {
    // Höchstgröße und Aufbewahrung des ZIP einstellbar (wie press_export_max_gb / press_export_hours)
    const s = await getSettings();
    const total = Number((await one<any>(`SELECT COALESCE(sum(size_bytes),0) AS b FROM media WHERE id = ANY($1)`, [opts.ids]))!.b);
    if (total > s['media.export_max_gb'] * 1024 ** 3) throw badRequest(`Das ZIP würde größer als ${s['media.export_max_gb']} GB. Bitte weniger Dateien auswählen.`);
    const ex = await one<any>(
      `INSERT INTO exports (collection_id, media_ids, variant, created_by, with_folders, with_csv, label, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(hours => $8)) RETURNING *`,
      [opts.collectionId, opts.ids, opts.variant, req.auth!.user?.id ?? null, opts.withFolders, opts.withCsv, opts.label.slice(0, 120), s['media.export_hours']],
    );
    await enqueue('export.zip', { exportId: ex.id }, { dedupKey: `export:${ex.id}` });
    await audit(req.auth!.actor, 'media.export_requested', { type: opts.collectionId ? 'collection' : 'media', id: opts.collectionId, label: opts.label }, { dateien: opts.ids.length, fassung: opts.variant, ordner: opts.withFolders, metadaten: opts.withCsv, ...opts.audit });
    await checkDownloadRate(req.auth!.actor);
    return { id: ex.id, status: ex.status, files: opts.ids.length };
  }
  const exportOptions = { variant: z.enum(['public', 'original']).default('public'), withFolders: z.boolean().default(true), withCsv: z.boolean().default(false) };

  /* Sammeldownload als ZIP (im Hintergrund, läuft nach Ablauf der Frist ab): ausgewählte, alle, markierte oder ein Ordner */
  app.post('/collections/:id/exports', { preHandler: requireAuth('media.export') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ selection: z.enum(['selected', 'all', 'ids', 'folder']).default('selected'), ids: z.array(z.uuid()).max(2000).optional(), folderId: z.uuid().nullable().optional(), ...exportOptions })
      .parse(req.body ?? {});
    // Originale enthalten mögliche Standort- und Gerätedaten: wie beim Einzeldownload nur mit „Medien verwalten“ (#94)
    if (body.variant === 'original' && !req.auth!.permissions.has('media.download_original')) throw forbidden(ORIGINALS_FORBIDDEN);
    const c = await one<any>('SELECT id, title FROM collections WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    // Ordner samt Unterordnern (NULL = oberste Ebene ohne Ordner)
    let folderIds: string[] | null = null;
    if (body.selection === 'folder') {
      if (body.folderId) {
        await assertFolder(id, body.folderId);
        const folders = (await loadFolders(id)).filter((f) => !f.deleted_at);
        folderIds = [body.folderId, ...descendants(folders, body.folderId)];
      }
    }
    const rows = await many<any>(
      `SELECT id FROM media WHERE collection_id = $1 AND status = 'ready' AND deleted_at IS NULL AND ($2::boolean OR selection = 'selected') AND ($3::uuid[] IS NULL OR id = ANY($3))
          AND (NOT $4::boolean OR ($5::uuid[] IS NULL AND folder_id IS NULL) OR folder_id = ANY($5))`,
      [id, body.selection !== 'selected', body.selection === 'ids' ? (body.ids ?? []) : null, body.selection === 'folder', folderIds],
    );
    if (!rows.length) throw badRequest(body.selection === 'selected' ? 'Es sind noch keine Dateien ausgewählt.' : body.selection === 'ids' ? 'Unter den markierten Dateien ist keine geprüfte.' : body.selection === 'folder' ? 'Der Ordner enthält keine geprüften Dateien.' : 'Die Sammlung enthält keine geprüften Dateien.');
    return requestExport(req, { collectionId: id, label: c.title, ids: rows.map((r) => r.id), variant: body.variant, withFolders: body.withFolders, withCsv: body.withCsv, audit: { auswahl: body.selection } });
  });

  /* Sammlungsübergreifender ZIP-Export: markierte Dateien aus der Mediensuche */
  app.post('/exports', { preHandler: requireAuth('media.export') }, async (req) => {
    const body = z.object({ ids: z.array(z.uuid()).min(1).max(2000), ...exportOptions }).parse(req.body ?? {});
    if (body.variant === 'original' && !req.auth!.permissions.has('media.download_original')) throw forbidden(ORIGINALS_FORBIDDEN);
    const rows = await many<any>(
      `SELECT m.id, m.collection_id FROM media m JOIN collections c ON c.id = m.collection_id WHERE m.id = ANY($1) AND m.status = 'ready' AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
      [body.ids],
    );
    if (!rows.length) throw badRequest('Unter den markierten Dateien ist keine geprüfte.');
    const cols = new Set(rows.map((r) => r.collection_id));
    return requestExport(req, { collectionId: cols.size === 1 ? [...cols][0] : null, label: 'Auswahl', ids: rows.map((r) => r.id), variant: body.variant, withFolders: body.withFolders, withCsv: body.withCsv, audit: { sammlungen: cols.size } });
  });

  app.get('/exports/:id', { preHandler: requireAuth('media.export') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const ex = await one<any>('SELECT id, status, file_count, size_bytes, error, created_at, finished_at, expires_at, variant, created_by FROM exports WHERE id = $1', [id]);
    if (!ex || !mayAccessExport(req, ex)) throw notFound();
    const { created_by: _c, ...rest } = ex;
    return { ...rest, size_bytes: ex.size_bytes ? Number(ex.size_bytes) : null };
  });

  app.get('/exports/:id/download', { preHandler: requireAuth('media.export') }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const ex = await one<any>(`SELECT e.*, COALESCE(c.title, NULLIF(e.label, ''), 'medien') AS title FROM exports e LEFT JOIN collections c ON c.id = e.collection_id WHERE e.id = $1`, [id]);
    if (!ex || !mayAccessExport(req, ex)) throw notFound('Der Download ist nicht (mehr) verfügbar.');
    // Rechte beim Download erneut prüfen – sie können sich seit dem Anlegen geändert haben (#94)
    if (ex.variant === 'original' && !req.auth!.permissions.has('media.download_original')) throw forbidden(ORIGINALS_FORBIDDEN);
    if (ex.status !== 'ready' || new Date(ex.expires_at) < new Date()) throw notFound('Der Download ist nicht (mehr) verfügbar.');
    await audit(req.auth!.actor, 'media.export_downloaded', { type: 'collection', id: ex.collection_id, label: ex.title }, { dateien: ex.file_count, fassung: ex.variant });
    const name = `${ex.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'medien'}-${ex.variant === 'public' ? 'oeffentlich' : 'originale'}.zip`;
    return sendFileResponse(reply, exportPath(id), 'application/zip', name);
  });

  /*
   * Datenschutz je Datei (#118): Markierungen (Personen erkennbar, Verletzte/Gesundheit, Kennzeichen, sensibel),
   * unkenntlich gemachte Bereiche und Zuschnitt (Bilder), ohne Ton (Videos). Erzeugt eine neue öffentliche Fassung;
   * das Original bleibt unverändert.
   */
  app.patch('/media/:id/privacy', { preHandler: requireAuth('media.redact'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = privacyInput.parse(req.body ?? {});
    const m = await one<any>(`SELECT * FROM media WHERE id = $1 AND deleted_at IS NULL AND status = 'ready'`, [id]);
    if (!m) throw notFound('Datei nicht gefunden oder noch nicht geprüft.');
    const imageChange =
      (body.redactions !== undefined && JSON.stringify(body.redactions) !== JSON.stringify(m.redactions ?? [])) ||
      (body.crop !== undefined && JSON.stringify(body.crop) !== JSON.stringify(m.crop ?? null));
    const audioChange = body.stripAudio !== undefined && body.stripAudio !== m.strip_audio;
    const changesPublic = imageChange || audioChange;
    if (changesPublic) {
      if (!m.has_public) throw badRequest('Für diese Datei gibt es keine öffentliche Fassung (z. B. HEIC).');
      if (imageChange && m.kind !== 'image') throw badRequest('Bereiche und Zuschnitt gibt es nur für Bilder. Videos lassen sich ohne Ton veröffentlichen.');
      if (audioChange && m.kind !== 'video') throw badRequest('„Ohne Ton“ gibt es nur für Videos.');
      // Eine freigegebene Fassung darf sich nicht nachträglich ändern: die Freigabe gilt für genau diese Dateien
      const approved = await one<any>(
        `SELECT p.title FROM post_revisions r JOIN posts p ON p.id = r.post_id AND r.number = p.current_revision
           JOIN LATERAL (SELECT decision, content_hash FROM approvals WHERE revision_id = r.id AND revoked_at IS NULL ORDER BY decided_at DESC LIMIT 1) a ON true
          WHERE r.media_ids @> ARRAY[$1::uuid] AND a.decision = 'approved' AND a.content_hash = r.content_hash LIMIT 1`,
        [id],
      );
      if (approved) throw conflict(`Die Datei gehört zur freigegebenen Fassung von „${approved.title}“. Bitte zuerst die Freigabe zurückziehen.`);
    }
    const u = await one<any>(
      `UPDATE media SET sensitive_flags = COALESCE($2::text[], sensitive_flags), redactions = COALESCE($3::jsonb, redactions),
              crop = CASE WHEN $4 THEN $5::jsonb ELSE crop END, strip_audio = COALESCE($6, strip_audio)
        WHERE id = $1 RETURNING *`,
      [id, body.flags ?? null, body.redactions !== undefined ? JSON.stringify(body.redactions) : null, body.crop !== undefined, body.crop ? JSON.stringify(body.crop) : null, body.stripAudio ?? null],
    );
    let rendering = false;
    if (changesPublic) {
      if (m.kind === 'image') await renderPublic(id);
      else {
        // Videos können lange dauern: im Hintergrund umverpacken. Läuft schon ein Auftrag, liest er die Einstellungen
        // am Ende erneut und rendert bei Änderung nach (#165). Für das kurze Fenster nach seiner Schlussprüfung wird
        // zusätzlich ein Nachlauf eingeplant (eigener Schlüssel, höchstens einer offen).
        const queued = await enqueue('media.render_public', { mediaId: id }, { dedupKey: `media.render_public:${id}` });
        if (queued === null) await enqueue('media.render_public', { mediaId: id }, { dedupKey: `media.render_public:${id}:nachlauf` });
        rendering = true;
      }
    }
    await audit(req.auth!.actor, 'media.privacy', { type: 'media', id, label: m.original_name }, {
      markierungen: u.sensitive_flags,
      bereiche: (u.redactions ?? []).length,
      zuschnitt: !!u.crop,
      ohne_ton: u.strip_audio,
      neue_fassung: changesPublic,
    });
    const fresh = await one<any>(`SELECT * FROM media WHERE id = $1`, [id]);
    return { media: mediaPayload(fresh), rendering };
  });

  app.delete('/media/:id', { preHandler: requireAuth('media.trash') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    // In den Papierkorb (wiederherstellbar bis zur Frist); endgültig löscht „Medien administrieren“ oder die Löschfrist
    const r = await trashMedia([id], req.auth!.actor, req.auth!.user?.id ?? null);
    if (!r.deleted) throw notFound();
    return { ok: true };
  });

  /* Dateien ausliefern – nur geprüfte Medien, nur mit Recht */
  app.get('/media/:id/:variant', { preHandler: requireAnyAuth('media.view', 'post.view') }, async (req, reply) => {
    const { id, variant } = z.object({ id: z.uuid(), variant: z.enum(['preview', 'original', 'public']) }).parse(req.params);
    const perms = req.auth!.permissions;
    // Ohne „Medien ansehen“ (nur „Beiträge ansehen“): Vorschau und öffentliche Fassung, und nur für Dateien, die in
    // einer Fassung eines Beitrags stecken (Bilder im Beitragseditor). Originale und der Papierkorb bleiben gesperrt.
    const viaPost = !perms.has('media.view');
    if (viaPost && variant === 'original') throw forbidden();
    // Vorschau einer Datei im Papierkorb nur mit „Medien verwalten“ (Übersicht des Papierkorbs)
    const trashPreview = !viaPost && variant === 'preview' && perms.has('media.trash');
    const m = await one<any>(`SELECT * FROM media WHERE id = $1 AND (deleted_at IS NULL OR $2) AND status = 'ready'`, [id, trashPreview]);
    if (!m) throw notFound('Datei nicht gefunden oder noch nicht geprüft.');
    if (viaPost) {
      const used = await one<{ x: number }>(`SELECT 1 AS x FROM post_revisions WHERE $1 = ANY(media_ids) OR cover_id = $1 LIMIT 1`, [id]);
      if (!used) throw forbidden();
    }
    if (variant === 'original' && !req.auth!.permissions.has('media.download_original')) throw forbidden(ORIGINALS_FORBIDDEN);
    if (variant === 'preview') {
      if (!m.has_preview) throw notFound('Keine Vorschau vorhanden.');
      return sendFileResponse(reply, mediaPaths.preview(id), 'image/webp', undefined, { immutable: true });
    }
    if (variant === 'public') {
      const pf = publicFileFor(m);
      if (!pf) throw notFound('Keine öffentliche Fassung vorhanden.');
      return sendFileResponse(reply, pf.path, pf.type, publicFileName(m.id, pf.ext), { immutable: true });
    }
    await audit(req.auth!.actor, 'media.downloaded', { type: 'media', id, label: m.original_name });
    await checkDownloadRate(req.auth!.actor);
    return sendFileResponse(reply, mediaPaths.original(id), m.mime ?? 'application/octet-stream', m.original_name);
  });

  /* ------------------------------ Öffentlicher Upload-Link ------------------------------ */

  const publicLimit = { config: { rateLimit: publicRateLimit(60) } };

  app.get('/public/upload/:token', publicLimit, async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const l = await loadPublicLink(token, req.ip);
    const s = await getSettings();
    const organization = s['general.organization'] || s['general.instance_name'];
    assertUnlocked(req, l, organization);
    if (await linkClosedFull(l)) throw new AppError(410, 'link_unavailable', LINK_UNAVAILABLE);
    const types = effectiveTypes(s['media.allowed_types'], l.allowed_types);
    const fields = cleanFields(l.fields);
    const usage = await linkUsage(l.id);
    // Gestaltung (Paket 10): eigene des Links oder Standard, Platzhalter {thema}/{datum} ersetzt; nur Text, nie HTML
    const design = resolveDesign(await effectiveDesign(l.design), l.c_title, l.c_event_date);
    return {
      design,
      fields,
      consent_required: !!l.consent_required,
      consent_text: l.consent_required ? l.consent_text : '',
      max_files_per_upload: Number(l.max_files_per_upload) || null,
      remaining_uploads: Number(l.max_uploads) ? Math.max(0, Number(l.max_uploads) - usage.uploads) : null,
      remaining_bytes: Number(l.max_total_bytes) ? Math.max(0, Number(l.max_total_bytes) - usage.bytes) : null,
      types: typeLabels(types),
      uploader_months: s['privacy.uploader_months'],
      collection: { title: l.c_title, purpose: l.c_purpose, note: l.c_note },
      // Begrüßungstext des Links hat Vorrang vor dem Hinweis der Sammlung
      welcome_text: (l.welcome_text || '').trim() || null,
      camera_buttons: !!s['media.camera_buttons'],
      done_text: String(s['media.done_text'] ?? '').trim() || null,
      organization: s['general.organization'] || s['general.instance_name'],
      expires_at: l.expires_at,
      max_file_bytes: Math.min(Number(l.max_file_bytes), s['media.max_file_mb'] * 1024 * 1024),
      remaining_files: Math.max(0, l.max_files - l.upload_count),
      accept: acceptAttr(types),
      // Informationspflichten (Art. 13 DSGVO, #96) – immer sichtbar auf der Upload-Seite
      privacy: privacyInfo(s),
      // Hinweis nur für angemeldete Verwaltung: Pflichtangaben fehlen noch
      setup_hint: privacyIncomplete(s) && !!req.auth && (req.auth.permissions.has('media.links') || req.auth.permissions.has('settings.privacy')),
    };
  });

  /* Passwortgeschützter Link: Passwort prüfen, kurzlebige Freigabe als Cookie nur für diesen Link */
  app.post('/public/upload/:token/unlock', { config: { rateLimit: publicRateLimit(10) } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body ?? {});
    const l = await loadPublicLink(token, req.ip);
    if (!l.password_hash) return { ok: true };
    if (!(await verifyPassword(l.password_hash, password))) {
      await auditThrottled(`link-pw:${l.id}:${req.ip}`, 10 * 60_000, { id: null, name: 'Upload-Seite', type: 'system', ip: req.ip }, 'upload_link.password_failed', { type: 'upload_link', id: l.id, label: l.label || l.collection_id }, {}, 'denied').catch(() => {});
      await publicSecurityEvent(req, 'password_failed', { linkId: l.id }).catch(() => {});
      throw new AppError(401, 'password_wrong', 'Das Passwort stimmt nicht.');
    }
    setUnlockCookie(reply, token, l);
    return { ok: true };
  });

  app.post('/public/upload/:token', { config: { rateLimit: publicRateLimit(120) } }, async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const ctx = await publicUploadContext(req, token);
    const res = await withPublicEvents(req, ctx.link.id, async () => {
      if (ctx.link.upload_count >= ctx.link.max_files) throw new AppError(409, 'link_full', 'Über diesen Link wurden bereits alle erlaubten Dateien hochgeladen.');
      return receiveFile(req, ctx);
    });
    // Öffentliche Antwort ohne interne Details
    return { ok: true, duplicate: res.duplicate, name: res.media.original_name, size: res.media.size_bytes };
  });
}
