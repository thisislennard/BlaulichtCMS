import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { config } from '../config.js';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { exportPath } from '../media/exports.js';
import { mediaPaths, removeMediaFiles } from '../media/storage.js';
import { audit, SYSTEM_ACTOR, type Actor } from './audit.js';
import { conflict, notFound } from './errors.js';
import { log } from './log.js';
import { getSettings, type Settings } from './settings.js';

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

/** Gelöschte und abgewiesene Dateien, deren Datensatz die Frist überschritten hat. */
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
  const dead: RetentionCategory = { key: 'media_records', label: 'Gelöschte und abgewiesene Dateien (Dateiname, Hinweis, Prüfsumme)', days: mDays, count: 0 };
  if (mDays > 0) {
    if (opts.dryRun) {
      dead.count = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE ${DEAD_MEDIA_WHERE}`, [mDays]))!.n;
    } else {
      const rows = await many<{ id: string }>(`DELETE FROM media WHERE id IN (SELECT id FROM media WHERE ${DEAD_MEDIA_WHERE} LIMIT 5000) RETURNING id`, [mDays]);
      for (const r of rows) removeMediaFiles(r.id);
      dead.count = rows.length;
    }
  }
  report.categories.push(dead);

  /* Weitere personenbezogene Daten (#116) */
  report.categories.push(
    await simpleCategory(opts.dryRun, {
      key: 'fe2_events',
      label: 'Einsatzmeldungen aus FE2 (Stichwort, Ort, Zeit, Einheiten)',
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
  const ids = await many<{ id: string }>(`DELETE FROM warnings WHERE COALESCE(root_id, id) = ANY($1::uuid[]) RETURNING id`, [roots], db);
  for (const r of ids) fs.rmSync(path.join(config.dataDir, 'warnings', r.id), { recursive: true, force: true });
  return ids.map((r) => r.id);
}
