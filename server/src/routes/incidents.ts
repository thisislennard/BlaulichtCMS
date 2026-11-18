import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { assertPrivacyChecked, privacyAudit, privacyFindings } from '../lib/approval.js';
import {
  LIMITS,
  assertLocation,
  coarseLocation,
  createEntry,
  enqueueIncidentJob,
  entryHash,
  entryState,
  fieldsFromEvent,
  importRef,
  incidentLink,
  isOnWebsite,
  liveSite,
  loadConfig,
  openSuggestions,
  parseIncidentCsv,
  withKeywordMeaning,
  type EntryFields,
} from '../incidents/list.js';

/**
 * Einsatzliste (#213): Einträge anlegen (von Hand, aus Einsatzmeldungen, per Workflow oder CSV-Import), bearbeiten,
 * zur Freigabe einreichen, genau diese Fassung freigeben, an die Website übergeben und zurückziehen.
 * Darstellung, Filter, Statistik und Detailseiten liegen in der BlaulichtCMS Bridge (WordPress).
 */

const MIN_BRIDGE = '0.9.0';

const input = z.object({
  siteId: z.uuid().nullable().default(null),
  alarmAt: z.iso.datetime({ offset: true }),
  number: z.number().int().min(1).max(99999).nullable().default(null),
  keyword: z.string().trim().max(LIMITS.keyword).default(''),
  keywordLabel: z.string().trim().max(LIMITS.keywordLabel).default(''),
  category: z.string().trim().max(LIMITS.category).default(''),
  title: z.string().trim().min(2, 'Bitte eine Einsatzmeldung angeben.').max(LIMITS.title),
  location: z.string().trim().max(200).default(''),
  report: z.string().max(LIMITS.report).default(''),
  vehicles: z.string().trim().max(LIMITS.vehicles).default(''),
  units: z.string().trim().max(LIMITS.units).default(''),
  linkUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || /^https?:\/\/\S+$/i.test(v), 'Nur http(s)-Adressen.')
    .nullable()
    .default(null),
  featured: z.boolean().default(false),
  falseAlarm: z.boolean().default(false),
  mediaIds: z.array(z.uuid()).max(LIMITS.media).default([]),
});

const idParam = z.object({ id: z.uuid() });

function entryPayload(e: any) {
  const job = e.job_status ? { status: e.job_status, action: e.job_action, revision: e.job_revision } : null;
  return {
    id: e.id,
    site_id: e.site_id,
    site_name: e.site_name ?? null,
    revision: e.revision,
    content_hash: e.content_hash,
    alarm_at: e.alarm_at,
    number: e.number,
    keyword: e.keyword,
    keyword_label: e.keyword_label,
    category: e.category,
    title: e.title,
    location: e.location,
    report: e.report,
    vehicles: e.vehicles,
    units: e.units,
    link_url: e.link_url,
    featured: e.featured,
    false_alarm: e.false_alarm,
    media_ids: e.media_ids ?? [],
    source: e.source,
    created_at: e.created_at,
    created_by_name: e.created_by_name ?? null,
    updated_at: e.updated_at,
    submitted_at: e.submitted_at,
    approved_at: e.approved_hash === e.content_hash ? e.approved_at : null,
    approved_by_name: e.approved_hash === e.content_hash ? (e.approved_by_name ?? null) : null,
    rejected_note: e.rejected_note,
    withdrawn_at: e.withdrawn_at,
    state: entryState(e, job),
    /**
     * Datenschutz-Prüfung (#241): markierte Bilder bzw. Bilder mit offenen Gesichtsvorschlägen. `approve_check`: Freigabe
     * nur mit Bestätigung; `publish_check`: Befunde, die bei der Freigabe noch nicht bestätigt wurden.
     */
    privacy: {
      flagged: e.pv_flagged ?? 0,
      faces: e.pv_faces ?? 0,
      flags: e.pv_flags ?? [],
      approve_check: (e.pv_flagged ?? 0) + (e.pv_faces ?? 0) > 0,
      publish_check: (e.pv_unconfirmed ?? 0) > 0,
    },
    job: job ? { ...job, error: e.job_error ?? null, remote_url: e.job_remote_url ?? null, result_at: e.job_result_at ?? null, site_id: e.job_site_id } : null,
  };
}

const SELECT = `
  SELECT e.*, s.name AS site_name, cu.name AS created_by_name, au.name AS approved_by_name,
         j.status AS job_status, j.action AS job_action, j.revision AS job_revision, j.error AS job_error, j.remote_url AS job_remote_url,
         j.result_at AS job_result_at, j.site_id AS job_site_id, pv.pv_flagged, pv.pv_faces, pv.pv_unconfirmed,
         ARRAY(SELECT DISTINCT f FROM media fm, unnest(fm.sensitive_flags) f WHERE fm.id = ANY(e.media_ids) AND fm.deleted_at IS NULL ORDER BY f) AS pv_flags
    FROM incident_entries e
    LEFT JOIN wp_sites s ON s.id = e.site_id
    LEFT JOIN users cu ON cu.id = e.created_by
    LEFT JOIN users au ON au.id = e.approved_by
    LEFT JOIN LATERAL (SELECT * FROM incident_jobs WHERE entry_id = e.id AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1) j ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE x.flagged)::int AS pv_flagged, count(*) FILTER (WHERE x.faces)::int AS pv_faces,
             count(*) FILTER (WHERE (x.flagged OR x.faces) AND NOT (x.id = ANY(e.privacy_confirmed_ids)))::int AS pv_unconfirmed
        FROM (SELECT m.id, cardinality(m.sensitive_flags) > 0 AS flagged, jsonb_path_exists(m.face_proposals, '$[*] ? (@.status == "open")') AS faces
                FROM media m WHERE m.id = ANY(e.media_ids) AND m.deleted_at IS NULL) x) pv ON true`;

async function loadEntry(id: string, db: Queryable = pool) {
  const e = await one<any>(`${SELECT} WHERE e.id = $1`, [id], db);
  if (!e) throw notFound('Eintrag nicht gefunden.');
  return e;
}

/** Bilder prüfen: vorhanden, fertig verarbeitet, nicht gelöscht, Bild mit öffentlicher Fassung (ohne Standort). */
async function checkMedia(ids: string[], db: Queryable = pool) {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw badRequest('Jedes Bild nur einmal.');
  const ok = await many<{ id: string }>(`SELECT id FROM media WHERE id = ANY($1::uuid[]) AND status = 'ready' AND deleted_at IS NULL AND kind = 'image' AND has_public`, [ids], db);
  if (ok.length !== ids.length) throw badRequest('Mindestens ein Bild ist nicht verfügbar (gelöscht, noch in Prüfung oder kein Bild).');
}

async function checkSite(siteId: string | null, db: Queryable = pool) {
  if (!siteId) return;
  const s = await one<any>(`SELECT status FROM wp_sites WHERE id = $1`, [siteId], db);
  if (!s || s.status === 'revoked') throw badRequest('Die gewählte Website ist nicht verfügbar.');
}

async function fieldsFrom(v: z.infer<typeof input>, db: Queryable = pool): Promise<EntryFields> {
  const cfg = await loadConfig(db);
  const location = assertLocation(v.location, cfg.locations);
  const meaning = await withKeywordMeaning(v.keyword, v.keywordLabel, v.category, db);
  return {
    site_id: v.siteId,
    alarm_at: new Date(v.alarmAt),
    number: v.number,
    keyword: v.keyword,
    keyword_label: meaning.label.slice(0, LIMITS.keywordLabel),
    category: meaning.category.slice(0, LIMITS.category),
    title: v.title,
    location,
    report: v.report.replace(/\r\n/g, '\n').trim(),
    vehicles: v.vehicles,
    units: v.units,
    link_url: v.linkUrl || null,
    featured: v.featured,
    false_alarm: v.falseAlarm,
    media_ids: v.mediaIds,
  };
}

const uid = (req: FastifyRequest) => req.auth!.user?.id ?? null;

function versionAtLeast(v: string | null | undefined, min: string) {
  const p = (s: string) => s.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  if (!v) return false;
  const a = p(v);
  const b = p(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Freigabe einer Fassung (gemeinsam für einzeln und mehrere). Markierte Bilder bzw. Bilder mit offenen
 * Gesichtsvorschlägen verlangen wie bei Beiträgen die ausdrücklich bestätigte Datenschutz-Prüfung (#241); die
 * Sammelfreigabe bestätigt nie und überspringt solche Einträge.
 */
async function approveOne(req: FastifyRequest, id: string, contentHash: string, fourEyes: boolean, privacyChecked = false) {
  const e = await one<any>('SELECT * FROM incident_entries WHERE id = $1', [id]);
  if (!e) throw notFound('Eintrag nicht gefunden.');
  if (e.content_hash !== contentHash) throw conflict('Der Eintrag wurde inzwischen geändert. Bitte die aktuelle Fassung prüfen.');
  if (!e.submitted_at) throw new AppError(409, 'not_submitted', 'Noch nicht zur Freigabe eingereicht.');
  const me = uid(req);
  if (fourEyes && me && [e.created_by, e.updated_by, e.submitted_by].includes(me)) {
    throw forbidden('Vier-Augen-Prinzip: Wer den Eintrag angelegt, geändert oder eingereicht hat, kann ihn nicht selbst freigeben.');
  }
  const privacy = await privacyFindings(e.media_ids);
  assertPrivacyChecked(privacy, privacyChecked, 'Der Eintrag');
  const upd = await pool.query(
    `UPDATE incident_entries SET approved_hash = $3, approved_by = $2, approved_at = now(), rejected_note = NULL, privacy_confirmed_ids = $4 WHERE id = $1 AND content_hash = $3 AND submitted_at IS NOT NULL`,
    [id, me, contentHash, privacy.ids],
  );
  if (!upd.rowCount) throw conflict('Der Eintrag wurde inzwischen geändert oder nicht mehr zur Freigabe vorgelegt.');
  await audit(req.auth!.actor, 'incident.approved', { type: 'incident', id, label: e.title }, { fassung: e.revision, ...privacyAudit(privacy) });
}

/**
 * Veröffentlichen (gemeinsam für einzeln und mehrere). Befunde der Datenschutz-Prüfung, die bei der Freigabe nicht
 * bestätigt wurden (später markiert, neue Gesichtsvorschläge, Freigabe vor #241), verlangen die Bestätigung hier.
 */
async function publishOne(req: FastifyRequest, id: string, contentHash: string, privacyChecked = false) {
  return tx(async (db) => {
    const e = await one<any>('SELECT * FROM incident_entries WHERE id = $1 FOR UPDATE', [id], db);
    if (!e) throw notFound('Eintrag nicht gefunden.');
    if (e.content_hash !== contentHash || e.approved_hash !== e.content_hash) throw conflict('Diese Fassung ist nicht freigegeben.');
    if (!e.site_id) throw badRequest('Bitte zuerst eine Website wählen.');
    const site = await one<any>('SELECT status FROM wp_sites WHERE id = $1', [e.site_id], db);
    if (site?.status !== 'active') throw conflict(site?.status === 'pending' ? 'Die Website ist noch nicht gekoppelt – erst koppeln, dann veröffentlichen.' : 'Die Website ist nicht verfügbar.');
    if (e.media_ids?.length) {
      const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE id = ANY($1::uuid[]) AND status = 'ready' AND deleted_at IS NULL AND has_public`, [e.media_ids], db);
      if (n!.n !== e.media_ids.length) throw conflict('Mindestens ein Bild wurde inzwischen gelöscht. Bitte den Eintrag anpassen und erneut freigeben lassen.');
    }
    const privacy = await privacyFindings(e.media_ids, db);
    const confirmed = new Set<string>(e.privacy_confirmed_ids ?? []);
    const unconfirmed = privacy.ids.filter((m) => !confirmed.has(m));
    if (unconfirmed.length && !privacyChecked) {
      const single = unconfirmed.length === 1;
      throw new AppError(
        400,
        'privacy_check_required',
        `${single ? 'Ein Bild' : `${unconfirmed.length} Bilder`} dieses Eintrags ${single ? 'ist' : 'sind'} markiert oder ${single ? 'hat' : 'haben'} offene Gesichtsvorschläge, ohne dass das bei der Freigabe geprüft wurde. Bitte die Datenschutz-Prüfung bestätigen.`,
      );
    }
    const open = await one<any>(`SELECT * FROM incident_jobs WHERE entry_id = $1 AND site_id = $2 AND revision = $3 AND action = 'upsert' AND status IN ('queued','sent','done') ORDER BY created_at DESC LIMIT 1`, [id, e.site_id, e.revision], db);
    const last = await one<any>(`SELECT action FROM incident_jobs WHERE entry_id = $1 AND site_id = $2 AND status IN ('queued','sent','done') ORDER BY created_at DESC LIMIT 1`, [id, e.site_id], db);
    if (open && last?.action === 'upsert') return { job: open, duplicate: true };
    // Website gewechselt: von der bisherigen Website entfernen
    const prev = await liveSite(id, db);
    if (prev && prev !== e.site_id) await enqueueIncidentJob(db, e, prev, 'delete', uid(req));
    const j = await enqueueIncidentJob(db, e, e.site_id, 'upsert', uid(req));
    await db.query(`UPDATE incident_entries SET withdrawn_at = NULL, privacy_confirmed_ids = CASE WHEN $2 THEN $3::uuid[] ELSE privacy_confirmed_ids END WHERE id = $1`, [id, unconfirmed.length > 0, privacy.ids]);
    await audit(req.auth!.actor, 'incident.published', { type: 'incident', id, label: e.title }, { fassung: e.revision, ...(unconfirmed.length ? privacyAudit(privacy) : {}) }, 'ok', db);
    return { job: j, duplicate: false };
  });
}

export async function incidentRoutes(app: FastifyInstance) {
  app.get('/incidents', { preHandler: requireAuth('incident.view') }, async (req) => {
    const q = z.object({ year: z.union([z.literal('alle'), z.coerce.number().int().min(1900).max(2100)]).optional() }).parse(req.query);
    const tz = (await getSettings())['general.timezone'] || 'Europe/Berlin';
    const years = await many<{ year: number; n: number }>(
      `SELECT extract(year FROM alarm_at AT TIME ZONE $1)::int AS year, count(*)::int AS n FROM incident_entries GROUP BY 1 ORDER BY 1 DESC`,
      [tz],
    );
    const year = q.year ?? years[0]?.year ?? new Date().getFullYear();
    const rows = await many<any>(
      `${SELECT} WHERE ($1::int IS NULL OR extract(year FROM e.alarm_at AT TIME ZONE $2)::int = $1) ORDER BY e.alarm_at DESC LIMIT 3000`,
      [year === 'alle' ? null : year, tz],
    );
    return { year, years, entries: rows.map(entryPayload) };
  });

  app.get('/incidents/config', { preHandler: requireAuth('incident.view') }, async () => {
    const cfg = await loadConfig();
    const sites = await many<any>(`SELECT id, name, status, plugin_version FROM wp_sites WHERE status <> 'revoked' ORDER BY name`);
    return { ...cfg, min_bridge: MIN_BRIDGE, sites: sites.map((s) => ({ ...s, supports_list: versionAtLeast(s.plugin_version, MIN_BRIDGE) })) };
  });

  app.put('/incidents/config', { preHandler: requireAuth('incident.settings') }, async (req) => {
    const b = z
      .object({
        locations: z.array(z.string().trim().min(1).max(LIMITS.location)).max(300).default([]),
        defaultSiteId: z.uuid().nullable().default(null),
      })
      .parse(req.body);
    // Doppelte (ohne Groß-/Kleinschreibung) entfallen; die erste Schreibweise bleibt
    const seen = new Set<string>();
    const locations = b.locations.map((l) => l.replace(/\s+/g, ' ')).filter((l) => !seen.has(l.toLowerCase()) && !!seen.add(l.toLowerCase()));
    const bad = locations.filter((l) => /\d/.test(l));
    if (bad.length) throw badRequest(`Ortsangaben ohne Hausnummern oder Postleitzahlen: ${bad.slice(0, 5).join(', ')}`);
    await checkSite(b.defaultSiteId);
    await pool.query(`UPDATE incident_list_config SET locations = $1, default_site_id = $2, updated_at = now(), updated_by = $3 WHERE id`, [locations, b.defaultSiteId, uid(req)]);
    await audit(req.auth!.actor, 'incident.config', { type: 'incident', label: 'Einsatzliste' }, { ortsangaben: locations.length, standard_website: b.defaultSiteId });
    return { ok: true, locations };
  });

  app.get('/incidents/suggestions', { preHandler: requireAuth('incident.edit') }, async () => {
    const cfg = await loadConfig();
    const rows = await openSuggestions(60);
    return rows.map((ev) => {
      const f = fieldsFromEvent(ev);
      const loc = coarseLocation(f.location, cfg.locations);
      return { id: ev.id, source: ev.source, status: ev.status, received_at: ev.received_at, alarm_at: f.alarmAt, keyword: f.keyword, keyword_label: f.keywordLabel, title: f.title, location: loc.value, location_removed: loc.removed, units: f.units };
    });
  });

  app.post('/incidents/suggestions/:id', { preHandler: requireAuth('incident.edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const ev = await one<any>(`SELECT * FROM fe2_events WHERE id = $1`, [id]);
    if (!ev) throw notFound('Einsatzmeldung nicht gefunden (evtl. durch die Löschfrist entfernt).');
    const f = fieldsFromEvent(ev);
    const res = await tx((db) => createEntry(db, { ...f, source: 'alarm', sourceRef: `event:${id}`, fe2EventId: id }, req.auth!.actor, uid(req)));
    if (!res) throw conflict('Diese Einsatzmeldung wurde bereits in die Einsatzliste übernommen.');
    return { id: res.entry.id, location_removed: res.locationRemoved };
  });

  app.post('/incidents/import', { preHandler: requireAuth('incident.edit'), bodyLimit: 6 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = z
      .object({
        csv: z.string().min(1).max(5 * 1024 * 1024),
        dryRun: z.boolean().default(true),
        includeReports: z.boolean().default(false),
        siteId: z.uuid().nullable().default(null),
        submit: z.boolean().default(false),
      })
      .parse(req.body);
    const s = await getSettings();
    const tz = s['general.timezone'] || 'Europe/Berlin';
    const parsed = parseIncidentCsv(b.csv, tz);
    const cfg = await loadConfig();
    await checkSite(b.siteId);
    const refs = parsed.rows.map((r) => importRef(r));
    const known = new Set((await many<{ source_ref: string }>(`SELECT source_ref FROM incident_entries WHERE source_ref = ANY($1::text[])`, [refs])).map((r) => r.source_ref));
    const preview = parsed.rows.slice(0, 50).map((r, i) => {
      const loc = coarseLocation(r.location, cfg.locations);
      return { line: r.line, alarm_at: r.alarmAt, number: r.number, keyword: r.keyword, title: r.title, location: loc.value, location_removed: loc.removed, vehicles: r.vehicles, units: r.units, featured: r.featured, false_alarm: r.falseAlarm, duplicate: known.has(refs[i]) };
    });
    const removed = parsed.rows.filter((r) => coarseLocation(r.location, cfg.locations).removed).length;
    const summary = { total: parsed.rows.length, duplicates: refs.filter((r) => known.has(r)).length, location_removed: removed, columns: parsed.columns, errors: parsed.errors.slice(0, 50), preview };
    if (b.dryRun || !parsed.rows.length) return { ...summary, created: 0 };
    const created = await tx(async (db) => {
      let n = 0;
      for (const r of parsed.rows) {
        const res = await createEntry(
          db,
          {
            siteId: b.siteId,
            alarmAt: r.alarmAt,
            number: r.number,
            keyword: r.keyword,
            title: r.title,
            location: r.location,
            vehicles: r.vehicles,
            units: r.units,
            report: b.includeReports ? r.report : '',
            featured: r.featured,
            falseAlarm: r.falseAlarm,
            source: 'import',
            sourceRef: importRef(r),
            submit: b.submit,
          },
          req.auth!.actor,
          uid(req),
          cfg,
        );
        if (res) n++;
      }
      await audit(req.auth!.actor, 'incident.imported', { type: 'incident', label: 'CSV-Import' }, { zeilen: parsed.rows.length, angelegt: n, ort_entfernt: removed, berichte: b.includeReports, eingereicht: b.submit }, 'ok', db);
      return n;
    });
    if (b.submit && created) await notify({ kind: 'info', title: `Einsatzliste: ${created} importierte Einträge zur Freigabe`, link: '/einsatzliste', permission: 'approval.incident' });
    return { ...summary, created };
  });

  app.get('/incidents/:id', { preHandler: requireAuth('incident.view') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await loadEntry(id);
    const media = e.media_ids?.length ? await many<any>(`SELECT id, original_name, kind, has_preview, status, deleted_at FROM media WHERE id = ANY($1::uuid[])`, [e.media_ids]) : [];
    const jobs = await many<any>(
      `SELECT j.id, j.action, j.status, j.revision, j.error, j.remote_url, j.created_at, j.result_at, s.name AS site_name FROM incident_jobs j JOIN wp_sites s ON s.id = j.site_id WHERE j.entry_id = $1 ORDER BY j.created_at DESC LIMIT 20`,
      [id],
    );
    return { ...entryPayload(e), media, jobs };
  });

  app.post('/incidents', { preHandler: requireAuth('incident.edit') }, async (req) => {
    const v = input.parse(req.body);
    await checkSite(v.siteId);
    await checkMedia(v.mediaIds);
    const f = await fieldsFrom(v);
    const cfg = await loadConfig();
    const site = f.site_id ?? cfg.default_site_id;
    const fields = { ...f, site_id: site };
    const e = await one<any>(
      `INSERT INTO incident_entries (site_id, content_hash, alarm_at, number, keyword, keyword_label, category, title, location, report, vehicles, units, link_url, featured, false_alarm, media_ids, source, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual',$17,$17) RETURNING *`,
      [site, entryHash(fields), fields.alarm_at, fields.number, fields.keyword, fields.keyword_label, fields.category, fields.title, fields.location, fields.report, fields.vehicles, fields.units, fields.link_url, fields.featured, fields.false_alarm, fields.media_ids, uid(req)],
    );
    await audit(req.auth!.actor, 'incident.created', { type: 'incident', id: e.id, label: e.title }, { herkunft: 'manual' });
    return entryPayload(await loadEntry(e.id));
  });

  app.put('/incidents/:id', { preHandler: requireAuth('incident.edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const v = input.parse(req.body);
    await checkSite(v.siteId);
    await checkMedia(v.mediaIds);
    const f = await fieldsFrom(v);
    const res = await tx(async (db) => {
      const e = await one<any>('SELECT * FROM incident_entries WHERE id = $1 FOR UPDATE', [id], db);
      if (!e) throw notFound('Eintrag nicht gefunden.');
      const hash = entryHash(f);
      if (hash === e.content_hash) return false;
      await db.query(
        `UPDATE incident_entries SET site_id = $2, content_hash = $3, alarm_at = $4, number = $5, keyword = $6, keyword_label = $7, category = $8, title = $9, location = $10, report = $11,
                vehicles = $12, units = $13, link_url = $14, featured = $15, false_alarm = $16, media_ids = $17, revision = revision + 1, submitted_at = NULL, submitted_by = NULL,
                updated_at = now(), updated_by = $18 WHERE id = $1`,
        [id, f.site_id, hash, f.alarm_at, f.number, f.keyword, f.keyword_label, f.category, f.title, f.location, f.report, f.vehicles, f.units, f.link_url, f.featured, f.false_alarm, f.media_ids, uid(req)],
      );
      await audit(req.auth!.actor, 'incident.revised', { type: 'incident', id, label: f.title }, { fassung: e.revision + 1, freigabe_entfaellt: e.approved_hash === e.content_hash }, 'ok', db);
      return true;
    });
    return { changed: res, ...entryPayload(await loadEntry(id)) };
  });

  app.delete('/incidents/:id', { preHandler: requireAuth('incident.edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    await tx(async (db) => {
      const e = await one<any>('SELECT * FROM incident_entries WHERE id = $1 FOR UPDATE', [id], db);
      if (!e) throw notFound('Eintrag nicht gefunden.');
      if (await isOnWebsite(id, db)) throw conflict('Der Eintrag steht auf der Website (oder ist dorthin unterwegs). Bitte zuerst zurückziehen.');
      const pending = await one(`SELECT 1 FROM incident_jobs WHERE entry_id = $1 AND status = 'sent'`, [id], db);
      if (pending) throw conflict('Die Website verarbeitet gerade einen Auftrag zu diesem Eintrag. Bitte kurz warten.');
      // Aufträge an die Website mit löschen (#242): Sie enthielten Momentaufnahmen des Eintrags und geben sonst Bilder frei.
      // Nichts ist unterwegs (siehe oben); noch nicht abgeholte Aufträge entfallen damit ebenfalls.
      const jobs = await db.query(`DELETE FROM incident_jobs WHERE entry_id = $1`, [id]);
      await db.query(`DELETE FROM incident_entries WHERE id = $1`, [id]);
      await audit(req.auth!.actor, 'incident.deleted', { type: 'incident', id, label: e.title }, { auftraege_geloescht: jobs.rowCount ?? 0 }, 'ok', db);
    });
    return { ok: true };
  });

  app.post('/incidents/:id/submit', { preHandler: requireAuth('incident.edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const e = await one<any>(`UPDATE incident_entries SET submitted_at = now(), submitted_by = $2, rejected_note = NULL WHERE id = $1 RETURNING *`, [id, uid(req)]);
    if (!e) throw notFound('Eintrag nicht gefunden.');
    await audit(req.auth!.actor, 'incident.submitted', { type: 'incident', id, label: e.title }, { fassung: e.revision });
    // Link hebt den Eintrag in der Liste hervor (#258)
    await notify({ kind: 'info', title: `Einsatzliste: Freigabe erbeten – ${e.title}`.slice(0, 200), body: `Fassung ${e.revision}`, link: incidentLink(id), permission: 'approval.incident' });
    return { ok: true };
  });

  app.post('/incidents/bulk/submit', { preHandler: requireAuth('incident.edit') }, async (req) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(5000) }).parse(req.body);
    const rows = await many<any>(`UPDATE incident_entries SET submitted_at = now(), submitted_by = $2, rejected_note = NULL WHERE id = ANY($1::uuid[]) AND submitted_at IS NULL RETURNING id`, [ids, uid(req)]);
    if (rows.length) {
      await audit(req.auth!.actor, 'incident.submitted', { type: 'incident', label: `${rows.length} Einträge` }, { anzahl: rows.length });
      await notify({ kind: 'info', title: `Einsatzliste: ${rows.length} Einträge zur Freigabe`, link: '/einsatzliste', permission: 'approval.incident' });
    }
    return { done: rows.length, skipped: ids.length - rows.length };
  });

  app.post('/incidents/:id/approve', { preHandler: requireAuth('approval.incident') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { contentHash, privacyChecked } = z.object({ contentHash: z.string().length(64), privacyChecked: z.boolean().default(false) }).parse(req.body);
    await approveOne(req, id, contentHash, !!(await getSettings())['editorial.four_eyes'], privacyChecked);
    return { ok: true };
  });

  app.post('/incidents/:id/reject', { preHandler: requireAuth('approval.incident') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(2, 'Bitte kurz begründen.').max(500) }).parse(req.body);
    const e = await one<any>(`UPDATE incident_entries SET submitted_at = NULL, rejected_note = $2 WHERE id = $1 AND submitted_at IS NOT NULL RETURNING *`, [id, note]);
    if (!e) throw conflict('Der Eintrag liegt nicht (mehr) zur Freigabe vor.');
    await audit(req.auth!.actor, 'incident.rejected', { type: 'incident', id, label: e.title }, { fassung: e.revision });
    const to = e.submitted_by ?? e.updated_by ?? e.created_by;
    if (to) await notify({ kind: 'warning', title: `Einsatzliste: zurückgewiesen – ${e.title}`.slice(0, 200), body: note, link: incidentLink(id), userId: to, category: 'decision' });
    return { ok: true };
  });

  app.post('/incidents/bulk/approve', { preHandler: requireAuth('approval.incident') }, async (req) => {
    const { items } = z.object({ items: z.array(z.object({ id: z.uuid(), contentHash: z.string().length(64) })).min(1).max(5000) }).parse(req.body);
    const fourEyes = !!(await getSettings())['editorial.four_eyes'];
    let done = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const it of items) {
      try {
        await approveOne(req, it.id, it.contentHash, fourEyes);
        done++;
      } catch (e: any) {
        skipped.push({ id: it.id, reason: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return { done, skipped };
  });

  app.post('/incidents/:id/publish', { preHandler: requireAuth('incident.publish') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { contentHash, privacyChecked } = z.object({ contentHash: z.string().length(64), privacyChecked: z.boolean().default(false) }).parse(req.body);
    const r = await publishOne(req, id, contentHash, privacyChecked);
    return { id: r.job.id, status: r.job.status, duplicate: r.duplicate };
  });

  app.post('/incidents/bulk/publish', { preHandler: requireAuth('incident.publish') }, async (req) => {
    const { items } = z.object({ items: z.array(z.object({ id: z.uuid(), contentHash: z.string().length(64) })).min(1).max(5000) }).parse(req.body);
    let done = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const it of items) {
      try {
        await publishOne(req, it.id, it.contentHash);
        done++;
      } catch (e: any) {
        skipped.push({ id: it.id, reason: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return { done, skipped };
  });

  /** Von der Website zurückziehen – braucht keine Freigabe; Entfernen ist immer erlaubt. */
  app.post('/incidents/:id/withdraw', { preHandler: requireAuth('incident.publish') }, async (req) => {
    const { id } = idParam.parse(req.params);
    await tx(async (db) => {
      const e = await one<any>('SELECT * FROM incident_entries WHERE id = $1 FOR UPDATE', [id], db);
      if (!e) throw notFound('Eintrag nicht gefunden.');
      const last = await one<any>(`SELECT * FROM incident_jobs WHERE entry_id = $1 AND status IN ('queued','sent','done') ORDER BY created_at DESC LIMIT 1`, [id], db);
      if (!last || last.action !== 'upsert') throw conflict('Der Eintrag steht nicht auf der Website.');
      if (last.status === 'queued') {
        // Noch nicht abgeholt: Auftrag abbrechen; stand eine frühere Fassung schon dort, trotzdem entfernen
        await db.query(`UPDATE incident_jobs SET status = 'canceled', result_at = now() WHERE id = $1`, [last.id]);
        const before = await one<any>(`SELECT action FROM incident_jobs WHERE entry_id = $1 AND site_id = $2 AND status IN ('sent','done') ORDER BY created_at DESC LIMIT 1`, [id, last.site_id], db);
        if (before?.action === 'upsert') await enqueueIncidentJob(db, e, last.site_id, 'delete', uid(req));
      } else {
        await enqueueIncidentJob(db, e, last.site_id, 'delete', uid(req));
      }
      await db.query(`UPDATE incident_entries SET withdrawn_at = now() WHERE id = $1`, [id]);
      await audit(req.auth!.actor, 'incident.withdrawn', { type: 'incident', id, label: e.title }, {}, 'ok', db);
    });
    return { ok: true };
  });
}

/** Für die Bridge: Website kann Einsatzlisten-Aufträge verarbeiten (ab Bridge 0.9.0). */
export const incidentBridgeMin = MIN_BRIDGE;
export const bridgeSupportsIncidents = (v: string | null | undefined) => versionAtLeast(v, MIN_BRIDGE);
