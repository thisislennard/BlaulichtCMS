import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { config } from '../config.js';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { exportPath, invalidateExportsFor } from '../media/exports.js';
import { mediaPaths, removeMediaFiles } from '../media/storage.js';
import { audit, SYSTEM_ACTOR, type Actor } from './audit.js';
import { conflict, notFound } from './errors.js';
import { log } from './log.js';
import { getSettings, type Settings } from './settings.js';
import { purgeOrphanRaws } from '../connections/receipts.js';
import { pressRequestRetention } from '../press/retention.js';

/*
 * Löschfristen (#97, Art. 5 Abs. 1 lit. e, Art. 17, Art. 25 Abs. 2 DSGVO).
 *
 * Abgeschlossene Sammlungen: archiviert oder ohne aktiven Upload-Link und seit `privacy.collection_retention_days`
 * ohne Aktivität (Anlage, Upload, Sichtung, Link angelegt/benutzt/abgelaufen/widerrufen, Archivierung). Gelöscht
 * werden Originale, Vorschauen, öffentliche Fassungen, Sammeldownloads, Upload-Sitzungen und die Datensätze.
 * Dateien, die in der aktuellen Fassung eines nicht archivierten Beitrags stecken, bleiben stehen (die Sammlung dann
 * mit ihnen) – sie werden gelöscht, sobald der Beitrag archiviert ist bzw. die Datei aus der Fassung genommen wurde.
 *
 * Gelöschte und abgewiesene Dateien: Datensatz (Dateiname, Hinweis, Prüfsumme) nach `privacy.deleted_media_days`
 * endgültig löschen – die Dateien selbst sind schon beim Löschen bzw. Abweisen entfernt.
 *
 * 0 = nie löschen. Jeder Lauf mit Löschungen erzeugt einen Audit-Eintrag `retention.run`, jede gelöschte Sammlung
 * zusätzlich `collection.deleted`.
 */

export interface RetentionCategory {
  key: string;
  label: string;
  /** Frist in Tagen; 0 = nie */
  days: number;
  /** Anzahl betroffener Datensätze (bei Sammlungen: Sammlungen) */
  count: number;
  /** Zusatz, z. B. Anzahl Dateien */
  detail?: string;
  /** Hinweis, der auch ohne fällige Datensätze erscheint (z. B. angekündigte Löschungen) */
  note?: string;
}

export interface RetentionCollection {
  id: string;
  title: string;
  last_activity: string;
  archived: boolean;
  /** Dateien, die gelöscht würden */
  media: number;
  /** Dateien, die bleiben, weil sie in einem Beitrag verwendet werden */
  kept: number;
  used_in: string[];
}

export interface RetentionReport {
  dry_run: boolean;
  at: string;
  categories: RetentionCategory[];
  collections: RetentionCollection[];
}

/** Höchstens so viele Sammlungen je Lauf – der Rest folgt beim nächsten Lauf (stündlich). */
const MAX_COLLECTIONS_PER_RUN = 100;

const days = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Dateien der Sammlungen, die in der aktuellen Fassung eines nicht archivierten Beitrags verwendet werden
 * (als Datei oder Titelbild) – mit den Beitragstiteln.
 */
export async function usedMedia(collectionIds: string[], db: Queryable = pool): Promise<Map<string, string[]>> {
  const rows = await many<{ id: string; title: string }>(
    `SELECT DISTINCT m.id, p.title FROM media m
       JOIN post_revisions r ON (r.media_ids @> ARRAY[m.id] OR r.cover_id = m.id)
       JOIN posts p ON p.id = r.post_id AND r.number = p.current_revision AND p.archived_at IS NULL
      WHERE m.collection_id = ANY($1::uuid[])`,
    [collectionIds],
    db,
  );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.title]);
  return out;
}

/** Abgeschlossene Sammlungen, deren letzte Aktivität länger als `d` Tage zurückliegt. */
async function dueCollections(d: number, db: Queryable = pool) {
  return many<{ id: string; title: string; last_activity: string; archived: boolean }>(
    `WITH act AS (
       SELECT c.id, c.title, c.archived_at IS NOT NULL AS archived,
              GREATEST(c.created_at, c.archived_at,
                (SELECT max(GREATEST(m.created_at, m.selection_at, m.processed_at, m.deleted_at)) FROM media m WHERE m.collection_id = c.id),
                (SELECT max(GREATEST(l.created_at, l.last_used_at, l.revoked_at, LEAST(l.expires_at, now()))) FROM upload_links l WHERE l.collection_id = c.id),
                (SELECT max(e.created_at) FROM exports e WHERE e.collection_id = c.id)) AS last_activity,
              EXISTS (SELECT 1 FROM upload_links l WHERE l.collection_id = c.id AND l.revoked_at IS NULL AND l.expires_at > now()) AS active_link
         FROM collections c)
     SELECT a.id, a.title, a.last_activity, a.archived FROM act a
      WHERE (a.archived OR NOT a.active_link) AND a.last_activity < now() - make_interval(days => $1)
        -- Sammlungen, in denen nur noch verwendete Dateien liegen, überspringen (sonst blockieren sie das Limit)
        AND (NOT EXISTS (SELECT 1 FROM media m WHERE m.collection_id = a.id)
             OR EXISTS (SELECT 1 FROM media m WHERE m.collection_id = a.id AND NOT EXISTS (
                  SELECT 1 FROM post_revisions r JOIN posts p ON p.id = r.post_id AND r.number = p.current_revision AND p.archived_at IS NULL
                   WHERE r.media_ids @> ARRAY[m.id] OR r.cover_id = m.id)))
      ORDER BY a.last_activity LIMIT $2`,
    [d, MAX_COLLECTIONS_PER_RUN],
    db,
  );
}

export interface PurgeResult {
  title: string;
  /** Sammlung selbst gelöscht (sonst nur nicht verwendete Dateien) */
  collectionDeleted: boolean;
  media: number;
  kept: number;
  exports: number;
}

/**
 * Löscht eine Sammlung endgültig samt Dateien, Sammeldownloads und Upload-Sitzungen.
 * - `manual`: verwendete Dateien blockieren die Löschung (409 mit den Beitragstiteln).
 * - `retention`: verwendete Dateien bleiben (mit der Sammlung), alles andere wird gelöscht.
 */
export async function purgeCollection(id: string, actor: Actor, mode: 'manual' | 'retention'): Promise<PurgeResult> {
  const files: { media: string[]; exports: string[]; parts: string[] } = { media: [], exports: [], parts: [] };
  const res = await tx(async (db: pg.PoolClient) => {
    const c = await one<{ id: string; title: string }>(`SELECT id, title FROM collections WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) throw notFound('Sammlung nicht gefunden.');
    const used = await usedMedia([id], db);
    if (mode === 'manual' && used.size) {
      const titles = [...new Set([...used.values()].flat())];
      throw conflict(
        `${used.size} Datei(en) werden in ${titles.length === 1 ? 'dem Beitrag' : 'den Beiträgen'} ${titles.map((t) => `„${t}“`).join(', ')} verwendet. ` +
          'Bitte die Dateien dort aus der Fassung nehmen oder den Beitrag archivieren (bei veröffentlichten Beiträgen vorher zurückziehen) und dann erneut löschen.',
        { beitraege: titles },
      );
    }
    const keep = [...used.keys()];
    const media = await many<{ id: string }>(`SELECT id FROM media WHERE collection_id = $1 AND NOT (id = ANY($2::uuid[]))`, [id, keep], db);
    const exports = await many<{ id: string }>(`SELECT id FROM exports WHERE collection_id = $1`, [id], db);
    const sessions = await many<{ id: string }>(`SELECT id FROM upload_sessions WHERE collection_id = $1`, [id], db);
    files.media = media.map((m) => m.id);
    files.exports = exports.map((e) => e.id);
    files.parts = sessions.map((s) => s.id);
    // Sammlungsübergreifende Exporte mit Dateien dieser Sammlung ebenfalls verwerfen
    files.exports.push(...(await invalidateExportsFor(files.media, db)).filter((e) => !files.exports.includes(e)));
    // Offene Aufträge zu diesen Dateien/Downloads verwerfen (laufende enden ohne Datensatz von selbst)
    await db.query(`DELETE FROM jobs WHERE status = 'queued' AND (payload->>'mediaId' = ANY($1::text[]) OR payload->>'exportId' = ANY($2::text[]))`, [files.media, files.exports]);
    const collectionDeleted = keep.length === 0;
    if (collectionDeleted) {
      // Kaskade: media, upload_links, upload_sessions, exports, legacy_links, media_tokens
      await db.query(`DELETE FROM collections WHERE id = $1`, [id]);
    } else {
      await db.query(`DELETE FROM upload_sessions WHERE collection_id = $1`, [id]);
      await db.query(`DELETE FROM exports WHERE collection_id = $1`, [id]);
      await db.query(`DELETE FROM media WHERE id = ANY($1::uuid[])`, [files.media]);
      // Abgelaufene bzw. widerrufene Links der abgeschlossenen Sammlung haben keinen Zweck mehr
      await db.query(`DELETE FROM upload_links WHERE collection_id = $1 AND (revoked_at IS NOT NULL OR expires_at <= now())`, [id]);
    }
    const result: PurgeResult = { title: c.title, collectionDeleted, media: files.media.length, kept: keep.length, exports: files.exports.length };
    await audit(
      actor,
      collectionDeleted ? 'collection.deleted' : 'collection.purged',
      { type: 'collection', id, label: c.title },
      { grund: mode === 'manual' ? 'manuell' : 'Löschfrist', dateien: result.media, behalten: result.kept, sammeldownloads: result.exports },
      'ok',
      db,
    );
    return result;
  });
  // Dateien erst nach erfolgreichem Commit entfernen
  for (const m of files.media) removeMediaFiles(m);
  for (const e of files.exports) {
    fs.rmSync(exportPath(e), { force: true });
    fs.rmSync(exportPath(e) + '.part', { force: true });
  }
  for (const p of files.parts) fs.rmSync(mediaPaths.uploadPart(p), { force: true });
  return res;
}

/** Dateien im Papierkorb und abgewiesene Dateien, deren Frist abgelaufen ist (Dateien und Datensatz werden entfernt). */
const DEAD_MEDIA_WHERE = `((deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $1))
   OR (deleted_at IS NULL AND status = 'rejected' AND COALESCE(processed_at, created_at) < now() - make_interval(days => $1)))`;

/**
 * Wendet alle Löschfristen an (bzw. zeigt im Probelauf, was gelöscht würde).
 * Wird stündlich vom Worker aufgerufen; Probelauf unter Einstellungen → Datenschutz.
 */
export async function runRetention(opts: { dryRun: boolean; actor?: Actor; settings?: Settings }): Promise<RetentionReport> {
  const s = opts.settings ?? (await getSettings(true));
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const report: RetentionReport = { dry_run: opts.dryRun, at: new Date().toISOString(), categories: [], collections: [] };

  /* Abgeschlossene Sammlungen */
  const cDays = days(s['privacy.collection_retention_days']);
  const cat: RetentionCategory = { key: 'collections', label: 'Abgeschlossene Sammlungen mit Dateien', days: cDays, count: 0 };
  if (cDays > 0) {
    const due = await dueCollections(cDays);
    const used = due.length ? await usedMedia(due.map((c) => c.id)) : new Map<string, string[]>();
    const counts = due.length
      ? await many<{ collection_id: string; id: string }>(`SELECT collection_id, id FROM media WHERE collection_id = ANY($1::uuid[])`, [due.map((c) => c.id)])
      : [];
    let fileCount = 0;
    for (const c of due) {
      const ids = counts.filter((m) => m.collection_id === c.id).map((m) => m.id);
      const kept = ids.filter((m) => used.has(m));
      const usedIn = [...new Set(kept.flatMap((m) => used.get(m) ?? []))];
      // Sammlung, in der nur noch verwendete Dateien liegen: nichts zu tun
      if (ids.length > 0 && kept.length === ids.length) continue;
      let media = ids.length - kept.length;
      if (!opts.dryRun) {
        try {
          const r = await purgeCollection(c.id, actor, 'retention');
          media = r.media;
        } catch (e) {
          log('warn', 'retention', `Sammlung ${c.id} nicht gelöscht: ${(e as Error).message}`);
          continue;
        }
      }
      fileCount += media;
      report.collections.push({ id: c.id, title: c.title, last_activity: new Date(c.last_activity).toISOString(), archived: c.archived, media, kept: kept.length, used_in: usedIn });
    }
    cat.count = report.collections.length;
    cat.detail = `${fileCount} Datei(en)`;
  }
  report.categories.push(cat);

  /* Gelöschte und abgewiesene Dateien (Datensätze) */
  const mDays = days(s['privacy.deleted_media_days']);
  const dead: RetentionCategory = { key: 'media_records', label: 'Papierkorb (Dateien samt Datensatz) und abgewiesene Dateien', days: mDays, count: 0 };
  // Ordner und Sammlungen im Papierkorb mit derselben Frist (Paket 4, wie press_trash_days in LiFeOS)
  const trash: RetentionCategory = { key: 'trash', label: 'Ordner und Sammlungen im Papierkorb', days: mDays, count: 0 };
  if (mDays > 0) {
    if (opts.dryRun) {
      dead.count = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE ${DEAD_MEDIA_WHERE}`, [mDays]))!.n;
      trash.count =
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM collection_folders WHERE deleted_at < now() - make_interval(days => $1)`, [mDays]))!.n +
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM collections WHERE deleted_at < now() - make_interval(days => $1)`, [mDays]))!.n;
    } else {
      const rows = await many<{ id: string }>(`DELETE FROM media WHERE id IN (SELECT id FROM media WHERE ${DEAD_MEDIA_WHERE} LIMIT 5000) RETURNING id`, [mDays]);
      for (const r of rows) removeMediaFiles(r.id);
      // Sammeldownloads mit diesen Dateien verwerfen
      for (const e of await invalidateExportsFor(rows.map((r) => r.id))) {
        fs.rmSync(exportPath(e), { force: true });
        fs.rmSync(exportPath(e) + '.part', { force: true });
      }
      dead.count = rows.length;
      trash.count += (await pool.query(`DELETE FROM collection_folders WHERE deleted_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM media m WHERE m.folder_id = collection_folders.id AND m.deleted_at IS NULL)`, [mDays])).rowCount ?? 0;
      for (const c of await many<{ id: string }>(`SELECT id FROM collections WHERE deleted_at < now() - make_interval(days => $1) LIMIT ${MAX_COLLECTIONS_PER_RUN}`, [mDays])) {
        try {
          await purgeCollection(c.id, actor, 'retention');
          trash.count++;
        } catch (e) {
          log('warn', 'retention', `Sammlung ${c.id} im Papierkorb nicht gelöscht: ${(e as Error).message}`);
        }
      }
    }
  }
  report.categories.push(dead, trash);

  /* Gesperrte Dateien (Prüfbefund, Datei noch in der Quarantäne) und Sicherheitsereignisse der Upload-Seiten (Paket 7) */
  const bDays = days(s['media.blocked_days']);
  const blocked: RetentionCategory = { key: 'blocked', label: 'Gesperrte Dateien (Prüfbefund) samt Datei', days: bDays, count: 0 };
  if (bDays > 0) {
    const where = `status = 'blocked' AND COALESCE(processed_at, created_at) < now() - make_interval(days => $1)`;
    if (opts.dryRun) blocked.count = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE ${where}`, [bDays]))!.n;
    else {
      const rows = await many<{ id: string }>(`DELETE FROM media WHERE id IN (SELECT id FROM media WHERE ${where} LIMIT 5000) RETURNING id`, [bDays]);
      for (const r of rows) removeMediaFiles(r.id);
      blocked.count = rows.length;
    }
  }
  report.categories.push(blocked);
  report.categories.push(
    await simpleCategory(opts.dryRun, {
      key: 'security_events',
      label: 'Sicherheitsereignisse der Upload-Seiten (gekürzter IP-Hash)',
      days: days(s['media.security_log_days']),
      table: 'public_security_events',
      where: `at < now() - make_interval(days => $1)`,
    }),
  );

  /* Angaben der Hochladenden (Name, E-Mail, Ort, Datum – je Link abfragbar): entfernen, Dateien bleiben (Paket 6) */
  const uMonths = Math.max(0, Math.floor(Number(s['privacy.uploader_months']) || 0));
  const up: RetentionCategory = { key: 'uploader', label: 'Angaben der Hochladenden (Name, E-Mail, Aufnahmeort, Aufnahmedatum)', days: uMonths * 30, count: 0 };
  if (uMonths > 0) {
    const where = `uploader IS NOT NULL AND created_at < now() - make_interval(months => $1)`;
    if (opts.dryRun) up.count = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE ${where}`, [uMonths]))!.n;
    else {
      up.count = (await pool.query(`UPDATE media SET uploader = NULL WHERE id IN (SELECT id FROM media WHERE ${where} LIMIT 10000)`, [uMonths])).rowCount ?? 0;
      await pool.query(`UPDATE upload_sessions SET uploader = NULL WHERE ${where}`, [uMonths]);
    }
  }
  report.categories.push(up);

  /* Weitere personenbezogene Daten (#116) */
  report.categories.push(
    await simpleCategory(opts.dryRun, {
      key: 'fe2_events',
      label: 'Einsatzmeldungen aus FE2 und Feuersoftware Connect (Stichwort, Ort, Zeit, Einheiten)',
      days: days(s['privacy.fe2_event_days']),
      table: 'fe2_events',
      where: `GREATEST(received_at, updated_at) < now() - make_interval(days => $1)`,
    }),
  );
  report.categories.push(await warningCases(opts.dryRun, days(s['privacy.warning_days'])));
  report.categories.push(
    await simpleCategory(opts.dryRun, {
      key: 'official_warnings',
      label: 'Amtliche Warnungen (nach Ablauf)',
      days: days(s['privacy.official_warning_days']),
      table: 'official_warnings',
      // Erst wenn abgelaufen UND seit der Frist nicht mehr in der Quelle (#180) – sonst legt der nächste Abruf eine noch
      // gelieferte Warnung neu an und benachrichtigt bzw. erzeugt ein Banner erneut
      where: `GREATEST(COALESCE(expires_at, effective_at, sent_at, received_at), COALESCE(last_seen_at, received_at)) < now() - make_interval(days => $1)`,
    }),
  );
  // Empfangsprotokoll der Verbindungen (Einträge samt Meldungen); danach Rohdaten ohne Bezug
  const receiptCat = await simpleCategory(opts.dryRun, {
    key: 'connection_receipts',
    label: 'Empfangsprotokoll der Verbindungen (Abrufe, Meldungen, Rohdaten – Einsatzdaten geschwärzt)',
    days: Math.max(1, days(s['privacy.receipt_days'])),
    table: 'connection_receipts',
    where: `created_at < now() - make_interval(days => $1)`,
  });
  if (!opts.dryRun) await purgeOrphanRaws();
  // Empfangsprotokoll des Presse-Postfachs (#205): gleiche Frist
  {
    const d = Math.max(1, days(s['privacy.receipt_days']));
    receiptCat.count += opts.dryRun
      ? (await one<{ n: number }>(`SELECT count(*)::int AS n FROM press_mailbox_log WHERE at < now() - make_interval(days => $1)`, [d]))!.n
      : ((await pool.query(`DELETE FROM press_mailbox_log WHERE at < now() - make_interval(days => $1)`, [d])).rowCount ?? 0);
  }
  report.categories.push(receiptCat);
  const linkCat = await simpleCategory(opts.dryRun, {
    key: 'upload_links',
    label: 'Abgelaufene und widerrufene Upload-Links (Token, Bezeichnung)',
    days: days(s['privacy.upload_link_days']),
    table: 'upload_links',
    where: `COALESCE(LEAST(revoked_at, expires_at), expires_at) < now() - make_interval(days => $1)`,
  });
  // Weiterleitungen alter Links aus dem Import (Prüfsumme des alten Tokens) mit derselben Frist
  if (linkCat.days > 0) {
    const q = opts.dryRun
      ? await one<{ n: number }>(`SELECT count(*)::int AS n FROM legacy_links WHERE expires_at < now() - make_interval(days => $1)`, [linkCat.days])
      : { n: (await pool.query(`DELETE FROM legacy_links WHERE expires_at < now() - make_interval(days => $1)`, [linkCat.days])).rowCount ?? 0 };
    linkCat.count += q!.n;
  }
  report.categories.push(linkCat);
  // Presseanfragen samt Kontaktdaten, Verlauf, Mails und Anhängen (#204): erledigte nach der Erledigung, nicht erledigte
  // nach der letzten Aktivität mit Ankündigung (#243, press/retention.ts)
  report.categories.push(...(await pressRequestRetention(opts.dryRun, s)));
  // Laufprotokolle der Automationen (Eingangsdaten, Schritte, Freigaben) – offene Läufe bleiben
  report.categories.push(
    await simpleCategory(opts.dryRun, {
      key: 'automation_runs',
      label: 'Laufprotokolle der Workflows (Eingangsdaten, Schritte, Freigaben)',
      days: days(s['privacy.automation_run_days']),
      table: 'automation_runs',
      where: `status NOT IN ('queued','running','waiting') AND COALESCE(finished_at, created_at) < now() - make_interval(days => $1)`,
    }),
  );
  if (!opts.dryRun) await pool.query(`DELETE FROM automation_dedup WHERE expires_at < now() - interval '1 day'`);
  report.categories.push(await incidentJobs(opts.dryRun));

  if (!opts.dryRun) {
    const total = report.categories.reduce((n, c) => n + c.count, 0);
    if (total > 0) {
      await audit(actor, 'retention.run', { type: 'retention', label: 'Löschfristen angewendet' }, Object.fromEntries(report.categories.filter((c) => c.count).map((c) => [c.key, c.count])));
      log('info', 'retention', `Löschfristen angewendet: ${report.categories.filter((c) => c.count).map((c) => `${c.key}=${c.count}`).join(', ')}`);
    }
  }
  return report;
}

/** Löschfrist für eine Tabelle ohne Abhängigkeiten, die Dateien betreffen (Fremdschlüssel per Kaskade/SET NULL). */
/** Abgeschlossene Bridge-Aufträge der Einsatzliste: nach dieser Frist gelöscht (#242). */
export const INCIDENT_JOB_DAYS = 30;

/**
 * SQL-Bedingung (Alias `j`, Frist `$1`): abgeschlossene Aufträge der Einsatzliste, die nichts mehr tragen. Aufträge
 * gelöschter Einträge sofort; sonst nach der Frist, außer dem jeweils letzten übergebenen bzw. erledigten Auftrag je
 * Eintrag und Website (zeigt, was dort steht – fürs Zurückziehen) und dem letzten nicht abgebrochenen je Eintrag (Zustand).
 */
export const STALE_INCIDENT_JOBS = `j.status IN ('done','failed','canceled') AND (j.entry_id IS NULL OR (
    COALESCE(j.result_at, j.created_at) < now() - make_interval(days => $1)
    AND NOT (j.status = 'done' AND NOT EXISTS (SELECT 1 FROM incident_jobs k WHERE k.entry_id = j.entry_id AND k.site_id = j.site_id AND k.status IN ('sent','done') AND k.created_at > j.created_at))
    AND NOT (j.status <> 'canceled' AND NOT EXISTS (SELECT 1 FROM incident_jobs k WHERE k.entry_id = j.entry_id AND k.status <> 'canceled' AND k.created_at > j.created_at))))`;

/**
 * Bridge-Aufträge der Einsatzliste (#242). Die Inhalte (Momentaufnahme des Eintrags) entfernt schon der Abschluss
 * eines Auftrags (Migration 191: nur Kennung, Fassung, Bild-IDs bleiben); hier verschwinden die Aufträge selbst.
 */
async function incidentJobs(dryRun: boolean): Promise<RetentionCategory> {
  const cat: RetentionCategory = { key: 'incident_jobs', label: 'Abgeschlossene Aufträge der Einsatzliste an die Website (ohne Inhalte; der jeweils letzte Stand bleibt)', days: INCIDENT_JOB_DAYS, count: 0 };
  if (dryRun) cat.count = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM incident_jobs j WHERE ${STALE_INCIDENT_JOBS}`, [INCIDENT_JOB_DAYS]))!.n;
  else cat.count = (await pool.query(`DELETE FROM incident_jobs WHERE id IN (SELECT j.id FROM incident_jobs j WHERE ${STALE_INCIDENT_JOBS} LIMIT 5000)`, [INCIDENT_JOB_DAYS])).rowCount ?? 0;
  return cat;
}

async function simpleCategory(dryRun: boolean, c: { key: string; label: string; days: number; table: string; where: string }): Promise<RetentionCategory> {
  const cat: RetentionCategory = { key: c.key, label: c.label, days: c.days, count: 0 };
  if (c.days <= 0) return cat;
  if (dryRun) cat.count = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${c.table} WHERE ${c.where}`, [c.days]))!.n;
  else cat.count = (await pool.query(`DELETE FROM ${c.table} WHERE id IN (SELECT id FROM ${c.table} WHERE ${c.where} LIMIT 5000)`, [c.days])).rowCount ?? 0;
  return cat;
}

/**
 * Warnvorgänge (#116): ein Vorgang samt Aktualisierungen und Entwarnung (gemeinsame Wurzel) wird gelöscht, wenn sein
 * letzter Bearbeitungsschritt (Fassung, Freigabe, Versand, Eingangsbestätigung, Klärung) länger als `d` Tage zurückliegt –
 * mit Fassungen (Rückrufkontakt), Freigaben samt PDF-Dateien und Versandnachweisen (Empfänger, SMTP-Antworten).
 */
async function warningCases(dryRun: boolean, d: number): Promise<RetentionCategory> {
  const cat: RetentionCategory = { key: 'warnings', label: 'Warnvorgänge mit Fassungen, PDF und Versandnachweisen', days: d, count: 0 };
  if (d <= 0) return cat;
  const roots = await many<{ root: string; n: number }>(
    `SELECT COALESCE(w.root_id, w.id) AS root, count(*)::int AS n FROM warnings w GROUP BY 1
      HAVING max(GREATEST(w.created_at, w.updated_at,
               (SELECT max(GREATEST(a.decided_at)) FROM warning_approvals a WHERE a.warning_id = w.id),
               (SELECT max(GREATEST(x.created_at, x.sent_at, x.acknowledged_at, x.resolved_at)) FROM warning_sends x WHERE x.warning_id = w.id),
               (SELECT max(r.created_at) FROM warning_revisions r WHERE r.warning_id = w.id)))
             < now() - make_interval(days => $1)
      LIMIT 500`,
    [d],
  );
  cat.count = roots.length;
  cat.detail = `${roots.reduce((n, r) => n + r.n, 0)} Vorgang/Vorgänge inkl. Aktualisierungen`;
  if (dryRun || !roots.length) return cat;
  await deleteWarningTrees(roots.map((r) => r.root));
  return cat;
}

/** Löscht Warnvorgänge samt Aktualisierungen/Entwarnung (Wurzel-IDs), Fassungen, Freigaben, PDF und Versand. */
export async function deleteWarningTrees(roots: string[], db: Queryable = pool): Promise<string[]> {
  const ids = await many<{ id: string }>(`SELECT id FROM warnings WHERE COALESCE(root_id, id) = ANY($1::uuid[])`, [roots], db);
  const deleted = await deleteWarnings(ids.map((r) => r.id), db);
  removeWarningFiles(deleted);
  return deleted;
}

/**
 * Löscht die angegebenen Warnvorgänge mit Fassungen (Rückrufkontakt), Freigaben, Versandnachweisen (Empfänger,
 * SMTP-Antworten, Mailtext), offenen Versandaufträgen und Benachrichtigungen dazu. Die PDF-Dateien entfernt
 * removeWarningFiles() – bei einer Transaktion erst nach dem Commit aufrufen.
 */
export async function deleteWarnings(ids: string[], db: Queryable = pool): Promise<string[]> {
  if (!ids.length) return [];
  await db.query(
    `DELETE FROM jobs WHERE status = 'queued' AND kind = 'warning.send' AND payload->>'sendId' IN (SELECT id::text FROM warning_sends WHERE warning_id = ANY($1::uuid[]))`,
    [ids],
  );
  await db.query(`DELETE FROM notifications WHERE link = ANY($1::text[])`, [ids.map((id) => `/warnungen/${id}`)]);
  const rows = await many<{ id: string }>(`DELETE FROM warnings WHERE id = ANY($1::uuid[]) RETURNING id`, [ids], db);
  return rows.map((r) => r.id);
}

export function removeWarningFiles(ids: string[]) {
  for (const id of ids) fs.rmSync(path.join(config.dataDir, 'warnings', id), { recursive: true, force: true });
}
