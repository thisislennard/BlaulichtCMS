import fs from 'node:fs';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { deleteWarningTrees, usedMedia } from '../lib/retention.js';
import { mediaPaths, removeMediaFiles } from '../media/storage.js';
import { invalidateExportsFor, removeExportFiles } from '../media/exports.js';
import { UPLOAD_REF_RE } from './media.js';

/*
 * Auskunft und Löschung je Person (#141, Art. 15, 17, 12 Abs. 3 DSGVO) – Verwaltung → Datenschutzanfragen.
 *
 * Recht „Datenschutzanfragen bearbeiten“ (privacy.manage): eigenes Recht, weil die Suche quer über Uploads,
 * Warnvorgänge, Konten und das Audit geht (mehr als „System verwalten“ oder „Audit lesen“ einzeln zeigen). Standardmäßig
 * nur in der Rolle Administration.
 *
 * Gesucht wird nach Name, E-Mail, Telefonnummer, Text aus dem Uploader-Hinweis, Dateiname, Vorgangsnummer des Uploads
 * oder IP-Adresse. Jede Suche, jeder Export und jede Löschung steht im Audit.
 *
 * Löschbar bzw. pseudonymisierbar je Treffer: Dateien (nicht, solange ein laufender Beitrag sie verwendet), unterbrochene
 * Uploads, Warnvorgänge (ganzer Vorgang), FE2-Meldungen. Konten über Benutzer, Beiträge und Zuständigkeiten in ihren
 * Bereichen. Audit-Einträge bleiben bis zum Ablauf von retention.audit_days unverändert (Nachweispflicht, Art. 5
 * Abs. 2 und Art. 17 Abs. 3 lit. b/e DSGVO; die Hash-Kette verbietet Änderungen) – IP-Adressen ohne Konto werden nach
 * privacy.upload_ip_retention_days entfernt.
 */

export type HitKind = 'user' | 'media' | 'upload_session' | 'warning' | 'responsibility' | 'fe2_event' | 'post' | 'session' | 'audit' | 'press_request' | 'press_contact';
export type HitAction = 'delete' | 'pseudonymize';

export interface PrivacyHit {
  kind: HitKind;
  id: string;
  title: string;
  at: string | null;
  fields: Record<string, unknown>;
  actions: HitAction[];
  note?: string;
  link?: string;
}

const LIMIT = 200;

function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Sucht personenbezogene Daten zu einem Suchbegriff in allen Bereichen. */
export async function privacySearch(term: string): Promise<PrivacyHit[]> {
  const q = term.trim();
  const like = likePattern(q);
  const ip = net.isIP(q) ? q : null;
  const ref = UPLOAD_REF_RE.test(q.toUpperCase()) ? q.toUpperCase() : null;
  const hits: PrivacyHit[] = [];

  for (const u of await many<any>(`SELECT id, name, email, status, roles, created_at, last_login_at FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT ${LIMIT}`, [like])) {
    hits.push({
      kind: 'user',
      id: u.id,
      title: `${u.name} <${u.email}>`,
      at: iso(u.created_at),
      fields: { name: u.name, email: u.email, status: u.status, rollen: u.roles, letzte_anmeldung: iso(u.last_login_at) },
      actions: [],
      note: 'Konto unter Benutzer bearbeiten oder löschen. Name und E-Mail bleiben danach im Audit bis zu dessen Frist.',
      link: '/benutzer',
    });
  }

  const media = await many<any>(
    `SELECT m.id, m.collection_id, c.title AS collection, m.original_name, m.uploader_note, m.upload_ref, m.status, m.kind, m.created_at, m.deleted_at,
            m.uploaded_by IS NULL AS anonymous, m.had_location, m.display_name, m.description, m.internal_note, m.alt_text, m.uploader, m.consent_at
       FROM media m JOIN collections c ON c.id = m.collection_id
      WHERE m.uploader_note ILIKE $1 OR m.original_name ILIKE $1 OR m.display_name ILIKE $1 OR m.description ILIKE $1 OR m.internal_note ILIKE $1 OR m.alt_text ILIKE $1
         OR m.uploader->>'name' ILIKE $1 OR m.uploader->>'email' ILIKE $1 OR m.uploader->>'place' ILIKE $1
         OR ($2::text IS NOT NULL AND m.upload_ref = $2)
      ORDER BY m.created_at DESC LIMIT ${LIMIT}`,
    [like, ref],
  );
  const used = media.length ? await usedMedia([...new Set(media.map((m) => m.collection_id))]) : new Map<string, string[]>();
  for (const m of media) {
    const usedIn = used.get(m.id) ?? [];
    hits.push({
      kind: 'media',
      id: m.id,
      title: `Datei in „${m.collection}“`,
      at: iso(m.created_at),
      fields: {
        dateiname: m.original_name,
        hinweis: m.uploader_note,
        anzeigename: m.display_name || undefined,
        beschreibung: m.description || undefined,
        interne_notiz: m.internal_note || undefined,
        alternativtext: m.alt_text || undefined,
        name: m.uploader?.name,
        email: m.uploader?.email,
        aufnahmeort: m.uploader?.place,
        aufnahmedatum: m.uploader?.date,
        bestaetigt_am: iso(m.consent_at),
        vorgangsnummer: m.upload_ref,
        sammlung: m.collection,
        status: m.deleted_at ? 'gelöscht (Datensatz bis zur Frist)' : m.status,
        ohne_konto: m.anonymous,
        standort_im_original: m.had_location,
        verwendet_in: usedIn,
      },
      actions: usedIn.length ? ['pseudonymize'] : ['delete', 'pseudonymize'],
      note: usedIn.length ? `Wird in ${usedIn.map((t) => `„${t}“`).join(', ')} verwendet – zum Löschen dort aus der Fassung nehmen bzw. den Beitrag zurückziehen und archivieren.` : undefined,
      link: `/medien/${m.collection_id}`,
    });
  }

  for (const s of await many<any>(
    `SELECT id, collection_id, file_name, note, upload_ref, created_at FROM upload_sessions
      WHERE note ILIKE $1 OR file_name ILIKE $1 OR uploader->>'name' ILIKE $1 OR uploader->>'email' ILIKE $1 OR ($2::text IS NOT NULL AND upload_ref = $2) ORDER BY created_at DESC LIMIT ${LIMIT}`,
    [like, ref],
  )) {
    hits.push({ kind: 'upload_session', id: s.id, title: 'Unterbrochener Upload', at: iso(s.created_at), fields: { dateiname: s.file_name, hinweis: s.note, vorgangsnummer: s.upload_ref }, actions: ['delete'] });
  }

  for (const w of await many<any>(
    `SELECT w.id, w.case_no, w.kind, w.created_at, COALESCE(w.root_id, w.id) AS root,
            EXISTS (SELECT 1 FROM warning_revisions r WHERE r.warning_id = w.id AND (r.data::text ILIKE $1 OR r.level_decision::text ILIKE $1)) AS in_revision,
            EXISTS (SELECT 1 FROM warning_sends x WHERE x.warning_id = w.id AND (array_to_string(x.recipients, ' ') ILIKE $1 OR array_to_string(x.intended_recipients, ' ') ILIKE $1 OR x.ack_note ILIKE $1 OR x.smtp_response ILIKE $1)) AS in_send,
            EXISTS (SELECT 1 FROM warning_approvals a WHERE a.warning_id = w.id AND a.note ILIKE $1) AS in_approval
       FROM warnings w
      WHERE EXISTS (SELECT 1 FROM warning_revisions r WHERE r.warning_id = w.id AND (r.data::text ILIKE $1 OR r.level_decision::text ILIKE $1))
         OR EXISTS (SELECT 1 FROM warning_sends x WHERE x.warning_id = w.id AND (array_to_string(x.recipients, ' ') ILIKE $1 OR array_to_string(x.intended_recipients, ' ') ILIKE $1 OR x.ack_note ILIKE $1 OR x.smtp_response ILIKE $1))
         OR EXISTS (SELECT 1 FROM warning_approvals a WHERE a.warning_id = w.id AND a.note ILIKE $1)
      ORDER BY w.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    const where = [w.in_revision && 'Fassung (z. B. Rückrufkontakt, Warnstufe)', w.in_send && 'Versand (Empfänger, Rückmeldung)', w.in_approval && 'Freigabe-Notiz'].filter(Boolean);
    hits.push({
      kind: 'warning',
      id: w.id,
      title: `Warnvorgang ${w.case_no}`,
      at: iso(w.created_at),
      fields: { vorgang: w.case_no, art: w.kind, fundstellen: where },
      actions: ['delete'],
      note: 'Löschen entfernt den ganzen Vorgang samt Aktualisierungen, Entwarnung, PDF und Versandnachweisen.',
      link: `/warnungen/${w.id}`,
    });
  }

  for (const r of await many<any>(`SELECT id, name, area, recipients, created_at FROM responsibilities WHERE name ILIKE $1 OR area ILIKE $1 OR array_to_string(recipients, ' ') ILIKE $1 LIMIT ${LIMIT}`, [like])) {
    hits.push({ kind: 'responsibility', id: r.id, title: `Zuständigkeit „${r.name}“`, at: iso(r.created_at), fields: { name: r.name, gebiet: r.area, empfaenger: r.recipients }, actions: [], note: 'Unter Warnentwurf → Pflege ändern.', link: '/warnungen/pflege' });
  }

  for (const e of await many<any>(`SELECT id, event_key, keyword, title, fields, received_at, source FROM fe2_events WHERE title ILIKE $1 OR fields::text ILIKE $1 ORDER BY received_at DESC LIMIT ${LIMIT}`, [like])) {
    hits.push({ kind: 'fe2_event', id: e.id, title: `${e.source === 'feuersoftware' ? 'Feuersoftware-Einsatz' : 'FE2-Meldung'} ${e.keyword ?? ''}`.trim(), at: iso(e.received_at), fields: { einsatz: e.event_key, titel: e.title, felder: e.fields }, actions: ['delete'] });
  }

  // Presseanfragen (#204): Kontaktdaten, Anfragetext, Verlauf und Mails
  for (const r of await many<any>(
    `SELECT r.id, r.case_no, r.topic, r.outlet, r.contact_name, r.contact_email, r.contact_phone, r.created_at FROM press_requests r
      WHERE r.contact_name ILIKE $1 OR r.contact_email ILIKE $1 OR r.contact_phone ILIKE $1 OR r.body ILIKE $1 OR r.topic ILIKE $1
         OR EXISTS (SELECT 1 FROM press_request_events e WHERE e.request_id = r.id AND e.text ILIKE $1)
      ORDER BY r.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({ kind: 'press_request', id: r.id, title: `Presseanfrage ${r.case_no}`, at: iso(r.created_at), fields: { thema: r.topic, medium: r.outlet, name: r.contact_name, email: r.contact_email, telefon: r.contact_phone }, actions: ['delete'], note: 'Löschen entfernt die Anfrage samt Verlauf, Mails und Anhängen.', link: `/presse/${r.id}` });
  }

  // Presseverteiler (#207): Kontakt samt Listen-Zuordnung; Versandprotokolle nennen die Adresse ebenfalls
  for (const c of await many<any>(
    `SELECT c.id, c.name, c.outlet, c.email, c.phone, c.origin, c.consent, c.unsubscribed_at, c.created_at,
            (SELECT count(*)::int FROM press_release_recipients x WHERE lower(x.email) = lower(c.email)) AS mailings
       FROM press_contacts c WHERE c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR c.note ILIKE $1 ORDER BY c.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({ kind: 'press_contact', id: c.id, title: `Presseverteiler: ${c.name || c.email}`, at: iso(c.created_at), fields: { name: c.name, medium: c.outlet, email: c.email, telefon: c.phone, herkunft: c.origin, einwilligung: c.consent, abgemeldet: iso(c.unsubscribed_at), pressemitteilungen: c.mailings }, actions: ['delete'], note: 'Löschen entfernt den Kontakt und seine Adresse aus den Versandprotokollen.', link: '/presse/verteiler' });
  }

  for (const p of await many<any>(
    `SELECT p.id, p.title, p.updated_at FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
      WHERE r.title ILIKE $1 OR r.body ILIKE $1 OR r.excerpt ILIKE $1 OR r.variants::text ILIKE $1 ORDER BY p.updated_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({ kind: 'post', id: p.id, title: `Beitrag „${p.title}“`, at: iso(p.updated_at), fields: { titel: p.title }, actions: [], note: 'Im Beitrag bearbeiten (neue Fassung) bzw. zurückziehen. Ältere Fassungen bleiben im Verlauf.', link: `/beitraege/${p.id}` });
  }

  if (ip) {
    for (const s of await many<any>(`SELECT s.id, s.created_at, s.last_seen_at, s.user_agent, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.ip = $1 ORDER BY s.created_at DESC LIMIT ${LIMIT}`, [ip])) {
      hits.push({ kind: 'session', id: s.id, title: `Sitzung von ${s.name}`, at: iso(s.created_at), fields: { zuletzt: iso(s.last_seen_at), browser: s.user_agent }, actions: [], note: 'Sitzungen werden 7 Tage nach ihrem Ende gelöscht.' });
    }
  }

  for (const a of await many<any>(
    `SELECT id, at, actor_name, action, object_type, object_label, result, ip FROM audit_events
      WHERE actor_name ILIKE $1 OR object_label ILIKE $1 OR details::text ILIKE $1 OR ($2::text IS NOT NULL AND ip = $2)
      ORDER BY id DESC LIMIT ${LIMIT}`,
    [like, ip],
  )) {
    hits.push({
      kind: 'audit',
      id: String(a.id),
      title: `Audit: ${a.action}`,
      at: iso(a.at),
      fields: { wer: a.actor_name, aktion: a.action, objekt: a.object_label, ergebnis: a.result, ip: a.ip },
      actions: [],
      note: 'Audit-Einträge sind unveränderlich und werden nach der Audit-Frist gelöscht (Nachweispflicht).',
    });
  }
  return hits;
}

const searchQuery = z.object({ q: z.string().trim().min(3, 'Bitte mindestens 3 Zeichen eingeben.').max(200) });

export async function privacyRoutes(app: FastifyInstance) {
  const perm = requireAuth('privacy.manage');

  app.get('/privacy/search', { preHandler: perm, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { q } = searchQuery.parse(req.query);
    const hits = await privacySearch(q);
    // Nachweis, wer wann wonach gesucht hat (Art. 5 Abs. 2 DSGVO)
    await audit(req.auth!.actor, 'privacy.search', { type: 'privacy', label: 'Datenschutzanfrage' }, { suchbegriff: q, treffer: hits.length });
    return { q, hits };
  });

  /* Auskunft als ZIP: auskunft.json mit allen Treffern und die hochgeladenen Dateien (Originale) der Person */
  app.get('/privacy/export', { preHandler: perm, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { q } = searchQuery.parse(req.query);
    const hits = await privacySearch(q);
    const mediaIds = hits.filter((h) => h.kind === 'media').map((h) => h.id);
    const media = mediaIds.length ? await many<any>(`SELECT id, original_name FROM media WHERE id = ANY($1::uuid[]) AND status = 'ready' AND deleted_at IS NULL`, [mediaIds]) : [];
    const zip = new yazl.ZipFile();
    const doc = {
      erstellt: new Date().toISOString(),
      suchbegriff: q,
      hinweis: 'Zusammenstellung der in BlaulichtCMS gespeicherten Daten zum Suchbegriff (Art. 15 DSGVO). Zweck, Empfänger und Speicherdauer stehen in der Datenschutzerklärung.',
      treffer: hits,
    };
    zip.addBuffer(Buffer.from(JSON.stringify(doc, null, 2), 'utf8'), 'auskunft.json');
    let files = 0;
    for (const m of media) {
      const file = mediaPaths.original(m.id);
      if (!fs.existsSync(file)) continue;
      zip.addFile(file, `dateien/${m.id.slice(0, 8)}-${String(m.original_name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}`, { compress: false });
      files++;
    }
    zip.end();
    await audit(req.auth!.actor, 'privacy.export', { type: 'privacy', label: 'Datenschutzauskunft' }, { suchbegriff: q, treffer: hits.length, dateien: files });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="auskunft-${new Date().toISOString().slice(0, 10)}.zip"`);
    return reply.send(zip.outputStream);
  });

  /* Löschen bzw. Pseudonymisieren je Treffer */
  app.post('/privacy/action', { preHandler: perm, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ kind: z.enum(['media', 'upload_session', 'warning', 'fe2_event', 'press_request', 'press_contact']), id: z.uuid(), action: z.enum(['delete', 'pseudonymize']) }).parse(req.body);
    const actor = req.auth!.actor;
    const details = { grund: 'Betroffenenanfrage', art: b.kind };
    if (b.kind === 'media') {
      const m = await one<any>(`SELECT id, collection_id, original_name FROM media WHERE id = $1`, [b.id]);
      if (!m) throw notFound('Datei nicht gefunden.');
      if (b.action === 'pseudonymize') {
        const ext = /\.([A-Za-z0-9]{1,5})$/.exec(m.original_name)?.[1]?.toLowerCase();
        await pool.query(`UPDATE media SET uploader_note = '', display_name = '', description = '', internal_note = '', alt_text = '', uploader = NULL, original_name = $2 WHERE id = $1`, [b.id, `datei-${b.id.slice(0, 8)}${ext ? `.${ext}` : ''}`]);
        await pool.query(`UPDATE upload_sessions SET note = '', uploader = NULL, file_name = $2 WHERE media_id = $1`, [b.id, `datei-${b.id.slice(0, 8)}`]);
        await audit(actor, 'privacy.pseudonymized', { type: 'media', id: b.id, label: 'Datei' }, { ...details, felder: ['Dateiname', 'Hinweis', 'Anzeigename', 'Beschreibung', 'interne Notiz', 'Angaben der Hochladenden'] });
        return { ok: true };
      }
      const usedIn = (await usedMedia([m.collection_id])).get(b.id);
      if (usedIn?.length) throw conflict(`Die Datei wird in ${usedIn.map((t) => `„${t}“`).join(', ')} verwendet. Bitte dort aus der Fassung nehmen bzw. den Beitrag zurückziehen und archivieren.`);
      const exportIds = await tx(async (db) => {
        await db.query(`DELETE FROM jobs WHERE status = 'queued' AND payload->>'mediaId' = $1`, [b.id]);
        await db.query(`DELETE FROM media WHERE id = $1`, [b.id]);
        // Sammeldownloads mit dieser Datei verwerfen – auch ein gerade laufender verwirft sein ZIP am Ende (#163)
        const ex = await invalidateExportsFor([b.id], db);
        await audit(actor, 'privacy.deleted', { type: 'media', id: b.id, label: 'Datei' }, { ...details, sammeldownloads: ex.length || undefined }, 'ok', db);
        return ex;
      });
      removeMediaFiles(b.id);
      for (const e of exportIds) removeExportFiles(e);
      return { ok: true };
    }
    if (b.action !== 'delete') throw badRequest('Für diesen Treffer ist nur Löschen möglich.');
    if (b.kind === 'upload_session') {
      const r = await pool.query(`DELETE FROM upload_sessions WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
      fs.rmSync(mediaPaths.uploadPart(b.id), { force: true });
    } else if (b.kind === 'warning') {
      const w = await one<any>(`SELECT COALESCE(root_id, id) AS root, case_no FROM warnings WHERE id = $1`, [b.id]);
      if (!w) throw notFound('Vorgang nicht gefunden.');
      const ids = await deleteWarningTrees([w.root]);
      await audit(actor, 'privacy.deleted', { type: 'warning', id: w.root, label: w.case_no }, { ...details, vorgaenge: ids.length });
      return { ok: true, deleted: ids.length };
    } else if (b.kind === 'press_contact') {
      const c = await one<any>(`DELETE FROM press_contacts WHERE id = $1 RETURNING email`, [b.id]);
      if (!c) throw notFound();
      await pool.query(`UPDATE press_release_recipients SET email = 'gelöscht:' || left(id::text, 8), name = '' WHERE lower(email) = lower($1)`, [c.email]);
    } else if (b.kind === 'press_request') {
      const r = await pool.query(`DELETE FROM press_requests WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
    } else {
      const r = await pool.query(`DELETE FROM fe2_events WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
    }
    await audit(actor, 'privacy.deleted', { type: b.kind, id: b.id, label: b.kind === 'fe2_event' ? 'Einsatzmeldung' : b.kind === 'press_request' ? 'Presseanfrage' : b.kind === 'press_contact' ? 'Pressekontakt' : 'Upload' }, details);
    return { ok: true };
  });
}
