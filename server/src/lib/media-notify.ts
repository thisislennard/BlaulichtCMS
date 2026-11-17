import { many, one, pool } from '../db/pool.js';
import { permissionsFor } from '../auth/permissions.js';
import { ensureRolesFresh } from '../auth/roles.js';
import { log } from './log.js';
import { getSettings } from './settings.js';
import { freeBytes } from '../media/storage.js';
import { emitUpload } from '../automations/events.js';
import { scheduleDelivery } from './notify.js';

/*
 * Benachrichtigungen der Medien wie in LiFeOS (Paket 5), über die vorhandenen In-App-Benachrichtigungen:
 *   media_new      neue Dateien über einen Upload-Link eingegangen und geprüft (gebündelt je Sammlung und Link)
 *   media_link     Upload-Link läuft bald ab bzw. Kontingent von Link oder Sammlung erreicht
 *   media_storage  Speicherplatz unter der Warnschwelle
 * Empfänger: bei neuen Dateien und ablaufenden Links bevorzugt, wer den Link angelegt hat (sofern noch mit „Medien
 * verwalten“), sonst alle mit dem Recht. Jede Person kann die Arten unter „Mein Konto“ stummschalten.
 * Fehler beim Benachrichtigen blockieren nie die auslösende Aktion.
 */
export type MediaNoticeCategory = 'media_new' | 'media_link' | 'media_storage';
export const MEDIA_NOTICE_CATEGORIES: MediaNoticeCategory[] = ['media_new', 'media_link', 'media_storage'];

/** Bündelungsfenster: gleiche Art und Sammlung/Link innerhalb einer Stunde = ein Eintrag mit Zähler. */
const BUNDLE_MS = 60 * 60_000;

/** Schwelle „läuft bald ab“: höchstens 24 Stunden vorher, bei kurzen Links ein Viertel der Gültigkeit (mind. 1 h). */
export function expiringThresholdMs(createdAt: string | Date, expiresAt: string | Date): number {
  const total = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
  return Math.max(3600_000, Math.min(24 * 3600_000, Math.floor(total / 4)));
}

async function ownerIfEligible(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await one<{ roles: string[]; status: string }>(`SELECT roles, status FROM users WHERE id = $1`, [userId]);
  if (!u || u.status !== 'active') return null;
  await ensureRolesFresh();
  return permissionsFor(u.roles ?? []).has('media.review') ? userId : null;
}

/**
 * Benachrichtigung anlegen oder mit einer gleichen der letzten Stunde bündeln (Zähler steigt, Eintrag wird für alle
 * wieder ungelesen). `title(n)` bekommt die Anzahl.
 */
export async function mediaNotice(n: {
  category: MediaNoticeCategory;
  groupKey: string;
  kind: 'info' | 'warning' | 'error' | 'success';
  title: (count: number) => string;
  body?: string;
  link?: string;
  permission: string;
  userId?: string | null;
  bundleMs?: number;
}) {
  try {
    if (!(await getSettings())['media.notices']) return;
    const existing = await one<{ id: number; count: number }>(
      `SELECT id, count FROM notifications WHERE group_key = $1 AND COALESCE(updated_at, created_at) > now() - make_interval(secs => $2) ORDER BY id DESC LIMIT 1`,
      [n.groupKey, (n.bundleMs ?? BUNDLE_MS) / 1000],
    );
    if (existing) {
      const count = existing.count + 1;
      await pool.query(`UPDATE notifications SET count = $2, title = $3, body = $4, updated_at = now() WHERE id = $1`, [existing.id, count, n.title(count).slice(0, 200), (n.body ?? '').slice(0, 1000)]);
      await pool.query(`DELETE FROM notification_reads WHERE notification_id = $1`, [existing.id]);
      return;
    }
    // Push/E-Mail (#191) nur für den ersten Eintrag eines Bündels – Folgedateien erhöhen nur den Zähler in der Glocke
    const created = await one<{ id: number }>(
      `INSERT INTO notifications (kind, title, body, link, permission, user_id, category, group_key, count, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,now()) RETURNING id`,
      [n.kind, n.title(1).slice(0, 200), (n.body ?? '').slice(0, 1000), n.link ?? null, n.userId ? null : n.permission, n.userId ?? null, n.category, n.groupKey],
    );
    if (created) await scheduleDelivery(created.id);
  } catch (e) {
    log('warn', 'notify', `Medien-Benachrichtigung fehlgeschlagen: ${(e as Error).message}`);
  }
}

/** Neue geprüfte Datei über einen Upload-Link (vom Worker nach der Prüfung aufgerufen). */
export async function noticeNewMedia(mediaId: string) {
  const m = await one<any>(
    `SELECT m.collection_id, m.upload_link_id, c.title, c.created_by AS c_owner, l.label, l.created_by AS l_owner FROM media m JOIN collections c ON c.id = m.collection_id
       LEFT JOIN upload_links l ON l.id = m.upload_link_id WHERE m.id = $1 AND m.upload_link_id IS NOT NULL`,
    [mediaId],
  );
  if (!m) return;
  await emitUpload({ collectionId: m.collection_id, collectionTitle: m.title, linkLabel: m.label });
  const owner = (await ownerIfEligible(m.l_owner)) ?? (await ownerIfEligible(m.c_owner));
  await mediaNotice({
    category: 'media_new',
    groupKey: `media:new:${m.collection_id}:${m.upload_link_id}:${owner ?? 'alle'}`,
    kind: 'info',
    title: (c) => (c === 1 ? `Neue Datei in „${m.title}“` : `${c} neue Dateien in „${m.title}“`),
    body: `Über den Upload-Link${m.label ? ` „${m.label}“` : ''} eingegangen und geprüft – bereit zur Sichtung.`,
    link: `/medien/${m.collection_id}`,
    permission: 'media.review',
    userId: owner,
  });
}

/** Kontingent erreicht (Link oder Sammlung) – je Link bzw. Sammlung einmal, bis wieder Platz ist. */
export async function noticeQuota(kind: 'link' | 'collection', id: string) {
  const row =
    kind === 'link'
      ? await one<any>(`UPDATE upload_links l SET quota_notified_at = now() FROM collections c WHERE l.id = $1 AND c.id = l.collection_id AND l.quota_notified_at IS NULL RETURNING l.label, c.title, c.id AS cid, l.created_by`, [id])
      : await one<any>(`UPDATE collections SET quota_notified_at = now() WHERE id = $1 AND quota_notified_at IS NULL RETURNING title, id AS cid, created_by`, [id]);
  if (!row) return;
  await mediaNotice({
    category: 'media_link',
    groupKey: `media:quota:${kind}:${id}`,
    kind: 'warning',
    title: () => (kind === 'link' ? `Upload-Link voll: „${row.title}“` : `Sammlung voll: „${row.title}“`),
    body: kind === 'link' ? `Über den Link${row.label ? ` „${row.label}“` : ''} sind alle erlaubten Dateien eingegangen. Weitere Uploads werden abgewiesen.` : 'Die Sammlung hat ihr Kontingent an Dateien oder Speicher erreicht. Weitere Uploads werden abgewiesen.',
    link: `/medien/${row.cid}`,
    permission: 'media.review',
    userId: await ownerIfEligible(row.created_by),
  });
}

/** Worker: Links, die bald ablaufen (einmal je Link; Verlängern setzt das zurück). */
export async function checkExpiringLinks() {
  const links = await many<any>(
    `SELECT l.id, l.label, l.created_at, l.expires_at, l.created_by, c.id AS cid, c.title FROM upload_links l JOIN collections c ON c.id = l.collection_id
      WHERE l.revoked_at IS NULL AND l.paused_at IS NULL AND l.expires_at > now() AND l.expiring_notified_at IS NULL AND c.archived_at IS NULL AND c.deleted_at IS NULL
        AND l.expires_at < now() + interval '24 hours' LIMIT 200`,
  );
  for (const l of links) {
    if (new Date(l.expires_at).getTime() - Date.now() > expiringThresholdMs(l.created_at, l.expires_at)) continue;
    const r = await pool.query(`UPDATE upload_links SET expiring_notified_at = now() WHERE id = $1 AND expiring_notified_at IS NULL`, [l.id]);
    if (!r.rowCount) continue;
    await mediaNotice({
      category: 'media_link',
      groupKey: `media:expiring:${l.id}`,
      kind: 'warning',
      title: () => `Upload-Link läuft bald ab: „${l.title}“`,
      body: `Der Link${l.label ? ` „${l.label}“` : ''} gilt nur noch bis ${new Date(l.expires_at).toLocaleString('de-DE', { timeZone: (await getSettings())['general.timezone'] })}. Bei Bedarf in der Sammlung verlängern.`,
      link: `/medien/${l.cid}`,
      permission: 'media.review',
      userId: await ownerIfEligible(l.created_by),
    });
  }
}

/** Worker: Speicher unter der Warnschwelle (höchstens alle 12 Stunden). */
export async function checkStorage() {
  const warnGb = Number((await getSettings())['media.storage_warn_gb']) || 0;
  if (!warnGb) return;
  const free = freeBytes();
  if (free === null || free >= warnGb * 1024 ** 3) return;
  await mediaNotice({
    category: 'media_storage',
    groupKey: 'media:storage',
    kind: 'warning',
    title: () => 'Speicherplatz für Medien wird knapp',
    body: `Frei sind noch ${(free / 1024 ** 3).toFixed(1).replace('.', ',')} GB (Warnschwelle ${warnGb} GB). Unter „Medien → Verwaltung“ steht, was wie viel Platz belegt; Papierkorb leeren oder alte Sammlungen löschen schafft Platz.`,
    link: '/medienverwaltung',
    permission: 'media.admin',
    bundleMs: 12 * 3600_000,
  });
}
