import fs from 'node:fs';
import net from 'node:net';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import { z } from 'zod';
import { many, one, pool, tx, type Queryable } from '../db/pool.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ipHash, EVENT_LABELS } from '../lib/public-security.js';
import { TEXT_AREAS } from '../lib/privacy-coverage.js';
import { deleteWarningTrees, usedMedia } from '../lib/retention.js';
import { mediaPaths, removeMediaFiles } from '../media/storage.js';
import { invalidateExportsFor, removeExportFiles } from '../media/exports.js';
import { PRESS_CHANNEL_LABEL, PRESS_STATUS_LABEL } from '../press/common.js';
import { UPLOAD_REF_RE } from './media.js';
import { LEGAL_BASIS_LABEL, type LegalBasis } from '../press/contacts.js';

/*
 * Auskunft und Löschung je Person (#141, #245, Art. 15, 16, 17, 12 Abs. 3 DSGVO) – Verwaltung → Datenschutzanfragen.
 *
 * Recht „Datenschutzanfragen bearbeiten“ (privacy.manage): eigenes Recht, weil die Suche quer über alle Bereiche geht
 * (mehr als „System verwalten“ oder „Audit lesen“ einzeln zeigen). Standardmäßig nur in der Rolle Administration.
 *
 * Gesucht wird nach Name, E-Mail, Telefonnummer, Text, Dateiname, Vorgangsnummer des Uploads oder IP-Adresse. Welche
 * Tabelle wie abgedeckt ist (oder warum sie ausgenommen ist), steht in lib/privacy-coverage.ts; test/privacy.test.ts
 * prüft das gegen das Schema. Jede Suche, jeder Export und jede Löschung steht im Audit.
 *
 * Löschbar bzw. pseudonymisierbar je Treffer: Dateien (nicht, solange ein laufender Beitrag sie verwendet), unterbrochene
 * Uploads, Warnvorgänge (ganzer Vorgang), FE2-Meldungen, Presseanfragen (samt Mails und Anhängen), Einträge im
 * Empfangsprotokoll des Presse-Postfachs, Kontakte des Presseverteilers, Adressen in Versandprotokollen, eigene
 * Kalendertermine, Benachrichtigungen. Konten über Benutzer, Beiträge,
 * Einsatzliste, Vorlagen usw. in ihren Bereichen. Audit-Einträge bleiben bis zum Ablauf von retention.audit_days
 * unverändert (Nachweispflicht, Art. 5 Abs. 2 und Art. 17 Abs. 3 lit. b/e DSGVO; die Hash-Kette verbietet Änderungen) –
 * IP-Adressen ohne Konto werden nach privacy.upload_ip_retention_days entfernt.
 */

export type HitKind =
  | 'user'
  | 'media'
  | 'upload_session'
  | 'warning'
  | 'responsibility'
  | 'fe2_event'
  | 'post'
  | 'session'
  | 'audit'
  | 'press_request'
  | 'press_mailbox_log'
  | 'press_contact'
  | 'press_recipient'
  | 'calendar_event'
  | 'incident_entry'
  | 'notification'
  | 'security_event'
  | 'text';
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
const short = (v: unknown, n = 300) => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)} …` : s || undefined;
};

/** Spalte als Suchausdruck: `x[]` = Textliste, `x{}` = JSON als Text. */
function matchExpr(alias: string, col: string) {
  if (col.endsWith('[]')) return `array_to_string(${alias}.${col.slice(0, -2)}, ' ') ILIKE $1`;
  if (col.endsWith('{}')) return `${alias}.${col.slice(0, -2)}::text ILIKE $1`;
  return `${alias}.${col} ILIKE $1`;
}

/** Sucht personenbezogene Daten zu einem Suchbegriff in allen Bereichen. */
export async function privacySearch(term: string): Promise<PrivacyHit[]> {
  const q = term.trim();
  const like = likePattern(q);
  const ip = net.isIP(q) ? q : null;
  const ref = UPLOAD_REF_RE.test(q.toUpperCase()) ? q.toUpperCase() : null;
  const hits: PrivacyHit[] = [];

  // Konten samt allem, was am Konto hängt (Sitzungen, gemerkte Geräte, Push-Geräte, Kalender-Abo, Einladung)
  for (const u of await many<any>(
    `SELECT u.id, u.name, u.email, u.status, u.roles, u.created_at, u.last_login_at, u.last_active_at,
            (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions,
            (SELECT count(*)::int FROM trusted_devices t WHERE t.user_id = u.id AND t.revoked_at IS NULL AND t.expires_at > now()) AS trusted,
            (SELECT coalesce(array_agg(p.label ORDER BY p.created_at), '{}') FROM push_subscriptions p WHERE p.user_id = u.id) AS push,
            (SELECT f.created_at FROM calendar_feeds f WHERE f.user_id = u.id) AS feed_created, (SELECT f.last_used_at FROM calendar_feeds f WHERE f.user_id = u.id) AS feed_used,
            (SELECT max(i.expires_at) FROM invitations i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS invite_until
       FROM users u WHERE u.name ILIKE $1 OR u.email ILIKE $1 ORDER BY u.name LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({
      kind: 'user',
      id: u.id,
      title: `${u.name} <${u.email}>`,
      at: iso(u.created_at),
      fields: {
        name: u.name,
        email: u.email,
        status: u.status,
        rollen: u.roles,
        letzte_anmeldung: iso(u.last_login_at),
        zuletzt_aktiv: iso(u.last_active_at),
        aktive_sitzungen: u.sessions,
        gemerkte_geraete: u.trusted,
        push_geraete: u.push,
        kalender_abo: u.feed_created ? `eingerichtet ${iso(u.feed_created)}, zuletzt abgerufen ${iso(u.feed_used) ?? 'nie'}` : undefined,
        offene_einladung_bis: iso(u.invite_until) ?? undefined,
      },
      actions: [],
      note: 'Konto unter Benutzer bearbeiten oder löschen (Sitzungen, Geräte, Push-Abos und Kalender-Abo werden mitgelöscht). Name und E-Mail bleiben danach im Audit bis zu dessen Frist.',
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

  const sendMatch = `(array_to_string(x.recipients, ' ') ILIKE $1 OR array_to_string(x.intended_recipients, ' ') ILIKE $1 OR x.ack_note ILIKE $1 OR x.smtp_response ILIKE $1 OR x.subject ILIKE $1
                      OR EXISTS (SELECT 1 FROM warning_sends_body b WHERE b.send_id = x.id AND b.body ILIKE $1))`;
  for (const w of await many<any>(
    `SELECT w.id, w.case_no, w.kind, w.created_at, COALESCE(w.root_id, w.id) AS root,
            EXISTS (SELECT 1 FROM warning_revisions r WHERE r.warning_id = w.id AND (r.data::text ILIKE $1 OR r.level_decision::text ILIKE $1)) AS in_revision,
            EXISTS (SELECT 1 FROM warning_sends x WHERE x.warning_id = w.id AND ${sendMatch}) AS in_send,
            EXISTS (SELECT 1 FROM warning_approvals a WHERE a.warning_id = w.id AND a.note ILIKE $1) AS in_approval
       FROM warnings w
      WHERE EXISTS (SELECT 1 FROM warning_revisions r WHERE r.warning_id = w.id AND (r.data::text ILIKE $1 OR r.level_decision::text ILIKE $1))
         OR EXISTS (SELECT 1 FROM warning_sends x WHERE x.warning_id = w.id AND ${sendMatch})
         OR EXISTS (SELECT 1 FROM warning_approvals a WHERE a.warning_id = w.id AND a.note ILIKE $1)
      ORDER BY w.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    const where = [w.in_revision && 'Fassung (z. B. Rückrufkontakt, Warnstufe)', w.in_send && 'Versand (Empfänger, Mailtext, Rückmeldung)', w.in_approval && 'Freigabe-Notiz'].filter(Boolean);
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

  // Presseanfragen (#204, #245): Kontaktdaten, Anfragetext, Verlauf, Mails (Absender, Empfänger, CC, Betreff, Text) und Anhänge
  const mailMatch = `(m.from_address ILIKE $1 OR m.from_name ILIKE $1 OR array_to_string(m.to_addresses, ' ') ILIKE $1 OR array_to_string(m.cc_addresses, ' ') ILIKE $1
                      OR m.subject ILIKE $1 OR m.text_body ILIKE $1 OR m.skipped_attachments::text ILIKE $1 OR m.decision_note ILIKE $1)`;
  for (const r of await many<any>(
    `SELECT r.id, r.case_no, r.status, r.channel, r.topic, r.outlet, r.contact_name, r.contact_email, r.contact_phone, r.body, r.created_at,
            (r.contact_name ILIKE $1 OR r.contact_email ILIKE $1 OR r.contact_phone ILIKE $1 OR r.outlet ILIKE $1) AS in_contact,
            (r.body ILIKE $1 OR r.topic ILIKE $1) AS in_text,
            EXISTS (SELECT 1 FROM press_request_events e WHERE e.request_id = r.id AND e.text ILIKE $1) AS in_events,
            EXISTS (SELECT 1 FROM press_messages m WHERE m.request_id = r.id AND ${mailMatch}) AS in_mail,
            EXISTS (SELECT 1 FROM press_attachments a JOIN press_messages m ON m.id = a.message_id WHERE m.request_id = r.id AND a.filename ILIKE $1) AS in_attachment,
            (SELECT count(*)::int FROM press_messages m WHERE m.request_id = r.id) AS mails,
            (SELECT count(*)::int FROM press_attachments a JOIN press_messages m ON m.id = a.message_id WHERE m.request_id = r.id) AS attachments
       FROM press_requests r
      WHERE r.contact_name ILIKE $1 OR r.contact_email ILIKE $1 OR r.contact_phone ILIKE $1 OR r.outlet ILIKE $1 OR r.body ILIKE $1 OR r.topic ILIKE $1
         OR EXISTS (SELECT 1 FROM press_request_events e WHERE e.request_id = r.id AND e.text ILIKE $1)
         OR EXISTS (SELECT 1 FROM press_messages m WHERE m.request_id = r.id AND ${mailMatch})
         OR EXISTS (SELECT 1 FROM press_attachments a JOIN press_messages m ON m.id = a.message_id WHERE m.request_id = r.id AND a.filename ILIKE $1)
      ORDER BY r.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    const where = [r.in_contact && 'Kontaktdaten', r.in_text && 'Thema/Anfragetext', r.in_events && 'Verlauf/Notizen', r.in_mail && 'Mails (Absender, Empfänger, CC, Betreff, Text)', r.in_attachment && 'Name eines Anhangs'].filter(Boolean);
    hits.push({
      kind: 'press_request',
      id: r.id,
      title: `Presseanfrage ${r.case_no}`,
      at: iso(r.created_at),
      fields: {
        thema: r.topic,
        stand: PRESS_STATUS_LABEL[r.status as keyof typeof PRESS_STATUS_LABEL] ?? r.status,
        eingangsweg: PRESS_CHANNEL_LABEL[r.channel as keyof typeof PRESS_CHANNEL_LABEL] ?? r.channel,
        medium: r.outlet,
        name: r.contact_name,
        email: r.contact_email,
        telefon: r.contact_phone,
        anfragetext: short(r.body),
        mails: r.mails,
        anhaenge: r.attachments,
        fundstellen: where,
      },
      actions: ['delete'],
      note: 'Löschen entfernt die Anfrage samt Verlauf, Mails und Anhängen. Die Auskunft (ZIP) enthält Anfrage, Verlauf, Mails und Anhänge vollständig – vor der Herausgabe Daten Dritter prüfen.',
      link: `/presse/${r.id}`,
    });
  }

  // Empfangsprotokoll des Presse-Postfachs (#245): Absender und Betreff abgerufener Mails, kurze Frist
  for (const l of await many<any>(
    `SELECT l.id, l.at, l.outcome, l.subject, l.from_address, l.detail, l.request_id, r.case_no FROM press_mailbox_log l LEFT JOIN press_requests r ON r.id = l.request_id
      WHERE l.subject ILIKE $1 OR l.from_address ILIKE $1 OR l.detail ILIKE $1 ORDER BY l.at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({
      kind: 'press_mailbox_log',
      id: String(l.id),
      title: `Presse-Postfach: ${l.subject || '(ohne Betreff)'}`,
      at: iso(l.at),
      fields: { absender: l.from_address, betreff: l.subject, ergebnis: l.outcome, hinweis: l.detail || undefined, presseanfrage: l.case_no ?? undefined },
      actions: ['delete'],
      note: 'Eintrag im Empfangsprotokoll des Presse-Postfachs (Löschfrist privacy.receipt_days).',
      link: l.request_id ? `/presse/${l.request_id}` : '/presse/einstellungen',
    });
  }

  // Presseverteiler (#207): Kontakt samt Listen und Pressemitteilungen an diese Adresse
  for (const c of await many<any>(
    `SELECT c.id, c.name, c.outlet, c.email, c.phone, c.note, c.origin, c.consent, c.legal_basis, to_char(c.consent_at, 'YYYY-MM-DD') AS consent_at, c.unsubscribed_at, c.created_at,
            (SELECT coalesce(array_agg(l.name ORDER BY l.name), '{}') FROM press_list_members lm JOIN press_lists l ON l.id = lm.list_id WHERE lm.contact_id = c.id) AS lists,
            (SELECT count(*)::int FROM press_release_recipients x WHERE lower(x.email) = lower(c.email) OR x.contact_id = c.id) AS mailings
       FROM press_contacts c WHERE c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR c.note ILIKE $1 OR c.outlet ILIKE $1 ORDER BY c.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({
      kind: 'press_contact',
      id: c.id,
      title: `Presseverteiler: ${c.name || c.email}`,
      at: iso(c.created_at),
      fields: { name: c.name, medium: c.outlet, email: c.email, telefon: c.phone, notiz: c.note || undefined, herkunft: c.origin, rechtsgrundlage: c.legal_basis ? LEGAL_BASIS_LABEL[c.legal_basis as LegalBasis] : undefined, einwilligung_am: c.consent_at ?? undefined, nachweis: c.consent || undefined, listen: c.lists, abgemeldet: iso(c.unsubscribed_at), pressemitteilungen: c.mailings },
      actions: ['delete'],
      note: 'Löschen entfernt den Kontakt und pseudonymisiert seine Adresse in den Versandprotokollen.',
      link: '/presse/verteiler',
    });
  }

  // Versandprotokolle der Pressemitteilungen (#245): direkt nach Adresse und Name – auch gelöschte oder geänderte Kontakte
  for (const x of await many<any>(
    `SELECT g.*, EXISTS (SELECT 1 FROM press_contacts c WHERE lower(c.email) = g.address) AS has_contact FROM (
       SELECT lower(x.email) AS address, (array_agg(x.id::text ORDER BY x.id))[1] AS id, max(x.name) AS name, count(*)::int AS n, max(x.sent_at) AS last_at,
              (array_agg(r.subject || ' (' || coalesce(to_char(x.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), x.status) || ')' ORDER BY r.created_at DESC))[1:50] AS releases
         FROM press_release_recipients x JOIN press_releases r ON r.id = x.release_id
        WHERE (x.email ILIKE $1 OR x.name ILIKE $1) AND x.email NOT LIKE 'gelöscht:%'
        GROUP BY lower(x.email)) g
      ORDER BY g.last_at DESC NULLS LAST LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({
      kind: 'press_recipient',
      id: x.id,
      title: `Versandprotokoll: ${x.address}`,
      at: iso(x.last_at),
      fields: { email: x.address, name: x.name || undefined, pressemitteilungen: x.n, betreffe: x.releases, kontakt_im_verteiler: x.has_contact },
      actions: ['pseudonymize'],
      note: `Pseudonymisieren ersetzt Adresse und Name in allen Versandprotokollen (Zähler und Stand bleiben).${x.has_contact ? ' Der Kontakt im Presseverteiler bleibt – dort gesondert löschen.' : ''}`,
      link: '/presse/mitteilungen',
    });
  }

  // Kalender (#245): eigene und aus iCal-Quellen eingelesene Termine
  for (const e of await many<any>(
    `SELECT e.id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day, e.source, e.rrule IS NOT NULL AS series, e.series_id IS NOT NULL AS override, array_to_string(e.tags, ', ') AS tags, s.name AS source_name
       FROM calendar_events e LEFT JOIN calendar_sources s ON s.id = e.source_id
      WHERE e.title ILIKE $1 OR e.description ILIKE $1 OR e.location ILIKE $1 OR array_to_string(e.tags, ' ') ILIKE $1
      ORDER BY e.starts_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    const own = e.source === 'own';
    hits.push({
      kind: 'calendar_event',
      id: e.id,
      title: `Termin „${e.title}“`,
      at: iso(e.starts_at),
      fields: {
        titel: e.title,
        beginn: iso(e.starts_at),
        ende: iso(e.ends_at),
        ort: e.location || undefined,
        beschreibung: short(e.description),
        schlagwoerter: e.tags || undefined,
        art: own ? (e.series ? 'eigene Serie' : e.override ? 'geänderter Termin einer Serie' : 'eigener Termin') : `eingelesen aus „${e.source_name ?? 'iCal-Quelle'}“`,
      },
      actions: own ? ['delete'] : [],
      note: own
        ? `Löschen entfernt ${e.series ? 'die ganze Serie samt geänderter Termine' : e.override ? 'diesen Termin der Serie' : 'den Termin'}. Alternativ im Kalender bearbeiten.`
        : 'Eingelesener Termin: in der Quelle ändern oder löschen – BlaulichtCMS übernimmt das beim nächsten Abruf. Entfernen der Quelle löscht alle ihre Termine.',
      link: '/kalender',
    });
  }

  // Einsatzliste (#245): Einträge und Aufträge an die Website. Abgeschlossene Aufträge tragen seit #242 nur noch Kennung,
  // Fassung und Bild-IDs (Trigger, Migration 191) – eine Kopie des Textes steht nur in Aufträgen, die noch unterwegs sind.
  const jobMatch = `(j.payload::text ILIKE $1 OR j.error ILIKE $1)`;
  for (const e of await many<any>(
    `SELECT e.id, e.title, e.alarm_at, e.location, e.withdrawn_at, e.revision, e.approved_hash = e.content_hash AS approved,
            (e.title ILIKE $1 OR e.location ILIKE $1 OR e.report ILIKE $1 OR e.keyword_label ILIKE $1 OR e.vehicles ILIKE $1 OR e.units ILIKE $1 OR e.rejected_note ILIKE $1) AS in_entry,
            EXISTS (SELECT 1 FROM incident_jobs j WHERE j.entry_id = e.id AND ${jobMatch}) AS in_jobs
       FROM incident_entries e
      WHERE e.title ILIKE $1 OR e.location ILIKE $1 OR e.report ILIKE $1 OR e.keyword_label ILIKE $1 OR e.vehicles ILIKE $1 OR e.units ILIKE $1 OR e.rejected_note ILIKE $1
         OR EXISTS (SELECT 1 FROM incident_jobs j WHERE j.entry_id = e.id AND ${jobMatch})
      ORDER BY e.alarm_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    const where = [e.in_entry && `aktuelle Fassung ${e.revision}`, e.in_jobs && 'Auftrag an die Website (Kopie einer Fassung bzw. Fehlermeldung)'].filter(Boolean);
    hits.push({
      kind: 'incident_entry',
      id: e.id,
      title: `Einsatzliste: ${e.title}`,
      at: iso(e.alarm_at),
      fields: { titel: e.title, ort: e.location || undefined, stand: e.withdrawn_at ? 'zurückgezogen' : e.approved ? 'freigegeben' : 'Entwurf', fundstellen: where },
      actions: [],
      note: [
        'Den Eintrag in der Einsatzliste bearbeiten (neue Fassung, erneute Freigabe) bzw. von der Website zurückziehen und löschen – das Löschen entfernt auch seine Aufträge.',
        e.in_jobs && !e.in_entry && 'Die Kopie im Auftrag wird beim Abschluss des Auftrags automatisch auf Kennung und Bilder gekürzt.',
      ]
        .filter(Boolean)
        .join(' '),
      link: '/einsatzliste',
    });
  }

  // Beiträge: alle Fassungen (auch frühere), Änderungsnotizen, Alternativtexte, Freigabe-Notizen
  const revMatch = `(r.title ILIKE $1 OR r.body ILIKE $1 OR r.excerpt ILIKE $1 OR r.variants::text ILIKE $1 OR r.change_note ILIKE $1 OR r.media_alt::text ILIKE $1)`;
  for (const p of await many<any>(
    `SELECT p.id, p.title, p.updated_at,
            EXISTS (SELECT 1 FROM post_revisions r WHERE r.post_id = p.id AND r.number = p.current_revision AND ${revMatch}) AS in_current,
            EXISTS (SELECT 1 FROM post_revisions r WHERE r.post_id = p.id AND r.number <> p.current_revision AND ${revMatch}) AS in_old,
            EXISTS (SELECT 1 FROM approvals a WHERE a.post_id = p.id AND a.note ILIKE $1) AS in_approval
       FROM posts p
      WHERE EXISTS (SELECT 1 FROM post_revisions r WHERE r.post_id = p.id AND ${revMatch}) OR EXISTS (SELECT 1 FROM approvals a WHERE a.post_id = p.id AND a.note ILIKE $1)
      ORDER BY p.updated_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    const where = [p.in_current && 'aktuelle Fassung', p.in_old && 'frühere Fassung', p.in_approval && 'Notiz zur Freigabe'].filter(Boolean);
    hits.push({ kind: 'post', id: p.id, title: `Beitrag „${p.title}“`, at: iso(p.updated_at), fields: { titel: p.title, fundstellen: where }, actions: [], note: 'Im Beitrag bearbeiten (neue Fassung) bzw. zurückziehen. Ältere Fassungen bleiben im Verlauf.', link: `/beitraege/${p.id}` });
  }

  // Benachrichtigungen der Glocke (Titel/Text enthalten z. B. Betreff einer Presse-Mail oder Stichwort und Ort)
  for (const n of await many<any>(
    `SELECT n.id, n.created_at, n.title, n.body, n.link, u.name AS user_name FROM notifications n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.title ILIKE $1 OR n.body ILIKE $1 ORDER BY n.created_at DESC LIMIT ${LIMIT}`,
    [like],
  )) {
    hits.push({
      kind: 'notification',
      id: String(n.id),
      title: `Benachrichtigung: ${n.title}`,
      at: iso(n.created_at),
      fields: { titel: n.title, text: short(n.body), an: n.user_name ?? 'alle mit dem passenden Recht' },
      actions: ['delete'],
      note: 'Benachrichtigungen werden nach 60 Tagen gelöscht. Bereits zugestellte Push-Mitteilungen und E-Mails sind nicht erreichbar.',
    });
  }

  // Weitere Texte der Redaktion (Vorlagen, Sammlungen, Banner, Textbausteine …) – nur Auskunft, Bearbeiten an Ort und Stelle
  for (const a of TEXT_AREAS) {
    for (const r of await many<any>(`SELECT t.ctid::text AS ctid, (${a.titleSql}) AS title, (${a.linkSql}) AS link FROM ${a.table} t WHERE ${a.columns.map((c) => matchExpr('t', c)).join(' OR ')} LIMIT 50`, [like])) {
      hits.push({ kind: 'text', id: `${a.table}:${r.ctid}`, title: `${a.area}: ${r.title || '(ohne Titel)'}`, at: null, fields: { bereich: a.area }, actions: [], note: a.note, link: r.link ?? undefined });
    }
  }

  if (ip) {
    for (const s of await many<any>(`SELECT s.id, s.created_at, s.last_seen_at, s.user_agent, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.ip = $1 ORDER BY s.created_at DESC LIMIT ${LIMIT}`, [ip])) {
      hits.push({ kind: 'session', id: s.id, title: `Sitzung von ${s.name}`, at: iso(s.created_at), fields: { zuletzt: iso(s.last_seen_at), browser: s.user_agent }, actions: [], note: 'Sitzungen werden 7 Tage nach ihrem Ende gelöscht.' });
    }
    // Sicherheitsereignisse der Upload-Seiten speichern die IP nur als gekürzten HMAC – derselbe HMAC findet sie
    for (const ev of await many<any>(`SELECT id, at, event, detail FROM public_security_events WHERE ip_hash = $1 ORDER BY at DESC LIMIT ${LIMIT}`, [ipHash(ip)])) {
      hits.push({
        kind: 'security_event',
        id: String(ev.id),
        title: `Upload-Seite: ${EVENT_LABELS[ev.event as keyof typeof EVENT_LABELS] ?? ev.event}`,
        at: iso(ev.at),
        fields: { ereignis: EVENT_LABELS[ev.event as keyof typeof EVENT_LABELS] ?? ev.event, hinweis: ev.detail || undefined },
        actions: [],
        note: 'Sicherheitsereignis mit gekürztem HMAC der IP-Adresse; wird nach media.security_log_days gelöscht.',
      });
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

/** Adresse in Versandprotokollen der Pressemitteilungen ersetzen – über die Adresse und (falls bekannt) den Kontakt. */
export async function pseudonymizeRecipients(db: Queryable, email: string, contactId: string | null = null) {
  const r = await db.query(
    `UPDATE press_release_recipients SET email = 'gelöscht:' || left(id::text, 8), name = '', error = CASE WHEN error IS NULL THEN NULL ELSE '(entfernt)' END
      WHERE email NOT LIKE 'gelöscht:%' AND (lower(email) = lower($1) OR ($2::uuid IS NOT NULL AND contact_id = $2::uuid))`,
    [email, contactId],
  );
  return r.rowCount ?? 0;
}

const safeName = (s: string) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'datei';

function lazyBuffer(load: () => Promise<Buffer>) {
  return (cb: (err: Error | null, stream: Readable) => void) => {
    load().then(
      (buf) => cb(null, Readable.from([buf])),
      () => cb(null, Readable.from([Buffer.alloc(0)])),
    );
  };
}

/** Presseanfrage vollständig ins ZIP: Anfrage mit Verlauf (JSON), Mails als Text, Anhänge als Dateien (Art. 15 Abs. 3). */
async function addPressRequest(zip: yazl.ZipFile, id: string): Promise<number> {
  const r = await one<any>(`SELECT id, case_no, status, channel, outlet, contact_name, contact_email, contact_phone, topic, body, due_at, created_at, answered_at, done_at FROM press_requests WHERE id = $1`, [id]);
  if (!r) return 0;
  const dir = `presse/${safeName(r.case_no)}`;
  const events = await many<any>(`SELECT at, actor_name, kind, text FROM press_request_events WHERE request_id = $1 ORDER BY at, id`, [id]);
  const mails = await many<any>(
    `SELECT id, direction, status, from_address, from_name, to_addresses, cc_addresses, subject, text_body, received_at, sent_at, created_at, skipped_attachments FROM press_messages WHERE request_id = $1 ORDER BY created_at, id`,
    [id],
  );
  const atts = await many<any>(
    `SELECT a.id, a.message_id, a.filename, a.content_type, a.size FROM press_attachments a JOIN press_messages m ON m.id = a.message_id WHERE m.request_id = $1 ORDER BY m.created_at, a.created_at`,
    [id],
  );
  const doc = {
    vorgang: r.case_no,
    stand: PRESS_STATUS_LABEL[r.status as keyof typeof PRESS_STATUS_LABEL] ?? r.status,
    eingangsweg: PRESS_CHANNEL_LABEL[r.channel as keyof typeof PRESS_CHANNEL_LABEL] ?? r.channel,
    medium: r.outlet,
    name: r.contact_name,
    email: r.contact_email,
    telefon: r.contact_phone,
    thema: r.topic,
    anfragetext: r.body,
    frist: iso(r.due_at),
    erfasst: iso(r.created_at),
    beantwortet: iso(r.answered_at),
    erledigt: iso(r.done_at),
    verlauf: events.map((e) => ({ zeit: iso(e.at), wer: e.actor_name || undefined, art: e.kind, text: e.text })),
    mails: mails.map((m, i) => ({
      datei: `mails/${String(i + 1).padStart(2, '0')}-${m.direction === 'in' ? 'eingang' : 'ausgang'}.txt`,
      richtung: m.direction === 'in' ? 'eingegangen' : 'ausgehend',
      stand: m.status,
      von: m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address,
      an: m.to_addresses,
      cc: m.cc_addresses,
      betreff: m.subject,
      zeit: iso(m.received_at ?? m.sent_at ?? m.created_at),
      anhaenge: atts.filter((a) => a.message_id === m.id).map((a) => a.filename),
      nicht_uebernommene_anhaenge: m.skipped_attachments,
    })),
  };
  zip.addBuffer(Buffer.from(JSON.stringify(doc, null, 2), 'utf8'), `${dir}/anfrage.json`);
  mails.forEach((m, i) => {
    const head = [
      `Richtung: ${m.direction === 'in' ? 'eingegangen' : 'ausgehend'}`,
      `Von: ${m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address}`,
      `An: ${(m.to_addresses ?? []).join(', ')}`,
      m.cc_addresses?.length ? `Cc: ${m.cc_addresses.join(', ')}` : '',
      `Betreff: ${m.subject}`,
      `Zeit: ${iso(m.received_at ?? m.sent_at ?? m.created_at)}`,
    ].filter(Boolean);
    zip.addBuffer(Buffer.from(`${head.join('\n')}\n\n${m.text_body ?? ''}`, 'utf8'), `${dir}/${doc.mails[i].datei}`);
  });
  atts.forEach((a, i) => {
    zip.addReadStreamLazy(
      `${dir}/anhaenge/${String(i + 1).padStart(2, '0')}-${safeName(a.filename)}`,
      { compress: false },
      lazyBuffer(async () => (await one<{ data: Buffer }>(`SELECT data FROM press_attachments WHERE id = $1`, [a.id]))?.data ?? Buffer.alloc(0)),
    );
  });
  return 1 + mails.length + atts.length;
}

const searchQuery = z.object({ q: z.string().trim().min(3, 'Bitte mindestens 3 Zeichen eingeben.').max(200) });

const ACTION_KINDS = ['media', 'upload_session', 'warning', 'fe2_event', 'press_request', 'press_contact', 'press_mailbox_log', 'press_recipient', 'calendar_event', 'notification'] as const;
/** Kinds mit fortlaufender Nummer statt UUID als Kennung */
const NUMERIC_KINDS = new Set(['press_mailbox_log', 'notification']);

export async function privacyRoutes(app: FastifyInstance) {
  const perm = requireAuth('privacy.manage');

  app.get('/privacy/search', { preHandler: perm, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { q } = searchQuery.parse(req.query);
    const hits = await privacySearch(q);
    // Nachweis, wer wann wonach gesucht hat (Art. 5 Abs. 2 DSGVO)
    await audit(req.auth!.actor, 'privacy.search', { type: 'privacy', label: 'Datenschutzanfrage' }, { suchbegriff: q, treffer: hits.length });
    return { q, hits };
  });

  /*
   * Auskunft als ZIP (Art. 15 Abs. 3): auskunft.json mit allen Treffern, die hochgeladenen Dateien (Originale) der Person
   * und je Presseanfrage Anfrage, Verlauf, Mails und Anhänge.
   */
  app.get('/privacy/export', { preHandler: perm, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { q } = searchQuery.parse(req.query);
    const hits = await privacySearch(q);
    const mediaIds = hits.filter((h) => h.kind === 'media').map((h) => h.id);
    const media = mediaIds.length ? await many<any>(`SELECT id, original_name FROM media WHERE id = ANY($1::uuid[]) AND status = 'ready' AND deleted_at IS NULL`, [mediaIds]) : [];
    const zip = new yazl.ZipFile();
    const doc = {
      erstellt: new Date().toISOString(),
      suchbegriff: q,
      hinweis:
        'Zusammenstellung der in BlaulichtCMS gespeicherten Daten zum Suchbegriff (Art. 15 DSGVO). Zweck, Empfänger und Speicherdauer stehen in der Datenschutzerklärung. Vor der Herausgabe prüfen, ob Daten anderer Personen enthalten sind (Art. 15 Abs. 4 DSGVO).',
      treffer: hits,
    };
    zip.addBuffer(Buffer.from(JSON.stringify(doc, null, 2), 'utf8'), 'auskunft.json');
    let files = 0;
    for (const m of media) {
      const file = mediaPaths.original(m.id);
      if (!fs.existsSync(file)) continue;
      zip.addFile(file, `dateien/${m.id.slice(0, 8)}-${safeName(m.original_name)}`, { compress: false });
      files++;
    }
    let press = 0;
    for (const h of hits.filter((x) => x.kind === 'press_request')) {
      const n = await addPressRequest(zip, h.id);
      if (n) press++;
      files += Math.max(0, n - 1);
    }
    zip.end();
    await audit(req.auth!.actor, 'privacy.export', { type: 'privacy', label: 'Datenschutzauskunft' }, { suchbegriff: q, treffer: hits.length, dateien: files, presseanfragen: press || undefined });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="auskunft-${new Date().toISOString().slice(0, 10)}.zip"`);
    return reply.send(zip.outputStream);
  });

  /* Löschen bzw. Pseudonymisieren je Treffer */
  app.post('/privacy/action', { preHandler: perm, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ kind: z.enum(ACTION_KINDS), id: z.string().min(1).max(64), action: z.enum(['delete', 'pseudonymize']) }).parse(req.body);
    if (NUMERIC_KINDS.has(b.kind) ? !/^\d{1,18}$/.test(b.id) : !z.uuid().safeParse(b.id).success) throw badRequest('Ungültige Kennung.');
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
    if (b.kind === 'press_recipient') {
      if (b.action !== 'pseudonymize') throw badRequest('Für diesen Treffer ist nur Pseudonymisieren möglich.');
      const x = await one<{ email: string }>(`SELECT email FROM press_release_recipients WHERE id = $1`, [b.id]);
      if (!x) throw notFound();
      const n = await tx(async (db) => {
        const count = await pseudonymizeRecipients(db, x.email);
        await audit(actor, 'privacy.pseudonymized', { type: 'press_recipient', id: b.id, label: 'Versandprotokoll Pressemitteilungen' }, { ...details, eintraege: count }, 'ok', db);
        return count;
      });
      return { ok: true, pseudonymized: n };
    }
    if (b.action !== 'delete') throw badRequest('Für diesen Treffer ist nur Löschen möglich.');
    let label = 'Eintrag';
    if (b.kind === 'upload_session') {
      const r = await pool.query(`DELETE FROM upload_sessions WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
      fs.rmSync(mediaPaths.uploadPart(b.id), { force: true });
      label = 'Upload';
    } else if (b.kind === 'warning') {
      const w = await one<any>(`SELECT COALESCE(root_id, id) AS root, case_no FROM warnings WHERE id = $1`, [b.id]);
      if (!w) throw notFound('Vorgang nicht gefunden.');
      const ids = await deleteWarningTrees([w.root]);
      await audit(actor, 'privacy.deleted', { type: 'warning', id: w.root, label: w.case_no }, { ...details, vorgaenge: ids.length });
      return { ok: true, deleted: ids.length };
    } else if (b.kind === 'press_contact') {
      // Erst die Versandprotokolle (über Adresse und Kontakt-ID – auch frühere Adressen), dann der Kontakt
      const n = await tx(async (db) => {
        const c = await one<{ email: string }>(`SELECT email FROM press_contacts WHERE id = $1 FOR UPDATE`, [b.id], db);
        if (!c) throw notFound();
        const count = await pseudonymizeRecipients(db, c.email, b.id);
        await db.query(`DELETE FROM press_contacts WHERE id = $1`, [b.id]);
        return count;
      });
      await audit(actor, 'privacy.deleted', { type: b.kind, id: b.id, label: 'Pressekontakt' }, { ...details, versandprotokolle: n || undefined });
      return { ok: true };
    } else if (b.kind === 'press_request') {
      const r = await pool.query(`DELETE FROM press_requests WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
      label = 'Presseanfrage';
    } else if (b.kind === 'press_mailbox_log') {
      const r = await pool.query(`DELETE FROM press_mailbox_log WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
      label = 'Empfangsprotokoll Presse-Postfach';
    } else if (b.kind === 'notification') {
      const r = await pool.query(`DELETE FROM notifications WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
      label = 'Benachrichtigung';
    } else if (b.kind === 'calendar_event') {
      await tx(async (db) => {
        const e = await one<any>(`SELECT id, source, series_id, recurrence_id FROM calendar_events WHERE id = $1 FOR UPDATE`, [b.id], db);
        if (!e) throw notFound('Termin nicht gefunden.');
        if (e.source !== 'own') throw conflict('Eingelesene Termine bitte in der Quelle ändern oder löschen.');
        // Geänderter Termin einer Serie: wie „diesen Termin löschen“ – sonst erschiene er aus der Serie wieder
        if (e.series_id) await db.query(`UPDATE calendar_events SET exdates = array_append(exdates, $2), updated_at = now() WHERE id = $1 AND NOT ($2 = ANY(exdates))`, [e.series_id, e.recurrence_id]);
        await db.query(`DELETE FROM calendar_events WHERE id = $1`, [b.id]);
      });
      label = 'Kalendertermin';
    } else if (b.kind === 'fe2_event') {
      const r = await pool.query(`DELETE FROM fe2_events WHERE id = $1`, [b.id]);
      if (!r.rowCount) throw notFound();
      label = 'Einsatzmeldung';
    } else {
      throw badRequest('Für diesen Treffer ist kein Löschen vorgesehen.');
    }
    await audit(actor, 'privacy.deleted', { type: b.kind, id: b.id, label }, details);
    return { ok: true };
  });
}
