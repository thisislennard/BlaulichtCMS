import crypto from 'node:crypto';
import { one, pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { getSettings } from '../lib/settings.js';
import { revisionHash } from '../routes/posts.js';
import type { Connection } from './common.js';

/**
 * FE2-Eingang für interne Einsatzentwürfe.
 *
 * Das tatsächliche Format hängt von der FE2-Konfiguration (HTTP-Ausgang) ab. BlaulichtCMS liest deshalb nur Felder über eine
 * konfigurierbare Zuordnung (Pfad je Feld) und übernimmt ausschließlich die Felder der Allowlist. Alles andere –
 * insbesondere Alarmtext, Meldender, Patienten- oder Personendaten – wird verworfen und nie gespeichert oder protokolliert.
 * Es entstehen nur interne Entwürfe; die Einsatzalarmierung läuft unabhängig von BlaulichtCMS.
 */

/** Felder, die überhaupt in einen redaktionellen Entwurf gelangen dürfen. */
export const FE2_ALLOWED_FIELDS = {
  keyword: 'Stichwort',
  keyword_text: 'Stichwort (Klartext)',
  category: 'Einsatzart',
  municipality: 'Gemeinde/Ort',
  district: 'Ortsteil',
  started_at: 'Alarmzeit',
  units: 'Eingesetzte Einheiten',
  status: 'Status (offen/beendet)',
} as const;
export type Fe2Field = keyof typeof FE2_ALLOWED_FIELDS;

/**
 * Standard-Zuordnung (Annahme für ein typisches JSON aus dem FE2-HTTP-Ausgang). Muss beim Einrichten mit einer
 * anonymisierten Testmeldung der echten Instanz geprüft und ggf. angepasst werden.
 */
export const FE2_DEFAULT_MAPPING: Record<'event_id' | Fe2Field, string> = {
  event_id: 'einsatz.id',
  keyword: 'einsatz.stichwort',
  keyword_text: 'einsatz.stichwort_text',
  category: 'einsatz.einsatzart',
  municipality: 'einsatz.ort',
  district: 'einsatz.ortsteil',
  started_at: 'einsatz.alarmzeit',
  units: 'einsatz.einheiten',
  status: 'einsatz.status',
};

function pick(obj: any, path: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

function clean(v: unknown, max = 200): string | null {
  if (v == null) return null;
  // Einheiten kommen je nach FE2-Konfiguration als Liste von Namen oder von Objekten ({ name, address, … })
  if (Array.isArray(v)) return v.map((x) => clean(x && typeof x === 'object' ? ((x as any).name ?? (x as any).bezeichnung ?? (x as any).address) : x, 60)).filter(Boolean).join(', ').slice(0, max) || null;
  if (typeof v === 'object') return null; // sonstige verschachtelte Objekte werden nicht übernommen
  const s = String(v).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Alarmzeit einheitlich als ISO-Zeitpunkt (Unix-Sekunden/-Millisekunden, ISO, „14.11.2026 18:35“); sonst unverändert. */
export function normalizeTime(v: string, timeZone = 'Europe/Berlin'): string {
  const s = v.trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (de) {
    // Ohne Zeitzonenangabe gilt die Ortszeit der Instanz (FE2 läuft lokal); Versatz für genau diesen Zeitpunkt ermitteln
    const [, d, m, y, hh, mm, ss] = de;
    const asIfUtc = Date.UTC(+y, +m - 1, +d, +hh, +mm, +(ss ?? 0));
    const offset = tzOffsetMinutes(asIfUtc, timeZone);
    return new Date(asIfUtc - offset * 60000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return s;
}

function tzOffsetMinutes(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** Alarmzeit im Entwurf lesbar in der Zeitzone der Instanz; Werte, die kein ISO-Zeitpunkt sind, bleiben unverändert. */
export function showTime(v: string, timeZone = 'Europe/Berlin'): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) return v;
  return new Intl.DateTimeFormat('de-DE', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
}

export interface Fe2Parsed {
  eventId: string | null;
  fields: Partial<Record<Fe2Field, string>>;
  closed: boolean;
  ignoredKeys: number;
}

/** Nur zugeordnete Felder der Allowlist übernehmen. */
export function parseFe2(payload: unknown, mapping: Record<string, string>, timeZone = 'Europe/Berlin'): Fe2Parsed {
  const map = { ...FE2_DEFAULT_MAPPING, ...(mapping ?? {}) };
  const eventId = clean(pick(payload, map.event_id), 100);
  const fields: Partial<Record<Fe2Field, string>> = {};
  for (const f of Object.keys(FE2_ALLOWED_FIELDS) as Fe2Field[]) {
    const v = clean(pick(payload, map[f]));
    if (v) fields[f] = f === 'started_at' ? normalizeTime(v, timeZone) : v;
  }
  const total = countLeaves(payload);
  const closed = /^(beendet|abgeschlossen|closed|ended|finished)$/i.test(fields.status ?? '');
  return { eventId, fields, closed, ignoredKeys: Math.max(0, total - Object.keys(fields).length - (eventId ? 1 : 0)) };
}

function countLeaves(v: any, depth = 0): number {
  if (depth > 6 || v == null) return 0;
  if (typeof v !== 'object') return 1;
  if (Array.isArray(v)) return 1; // eine Liste ist ein Feld
  return Object.values(v).reduce<number>((n, x) => n + countLeaves(x, depth + 1), 0);
}


/** Herkunft einer Einsatzmeldung. Beide Quellen erzeugen dieselbe Art Entwurf über handleIncident(). */
export type IncidentSource = 'fe2' | 'feuersoftware';
export const SOURCE_LABEL: Record<IncidentSource, string> = { fe2: 'FE2', feuersoftware: 'Feuersoftware Connect' };

export function draftTitle(f: Partial<Record<Fe2Field, string>>): string {
  const what = f.keyword_text || f.keyword || f.category || 'Einsatz';
  const where = [f.municipality, f.district].filter(Boolean).join(' – ');
  return `${what}${where ? ` in ${where}` : ''}`.slice(0, 200);
}

export function draftBody(f: Partial<Record<Fe2Field, string>>, source: IncidentSource = 'fe2', timeZone = 'Europe/Berlin'): string {
  // Bewusst neutral und knapp: Grundlage für die Redaktion, keine Veröffentlichung. Nie Straße, Hausnummer oder
  // Angaben zu meldenden Personen – die Allowlist kennt solche Felder nicht.
  const lines = [`[Automatischer Entwurf aus ${SOURCE_LABEL[source]} – bitte redaktionell prüfen und ergänzen.]`, ''];
  if (f.keyword) lines.push(`Stichwort: ${f.keyword}${f.keyword_text ? ` (${f.keyword_text})` : ''}`);
  if (f.category && !(f.keyword ?? '').toLowerCase().includes(f.category.toLowerCase())) lines.push(`Einsatzart: ${f.category}`);
  if (f.municipality) lines.push(`Ort: ${f.municipality}${f.district ? `, ${f.district}` : ''}`);
  if (f.started_at) lines.push(`Alarmzeit: ${showTime(f.started_at, timeZone)}`);
  if (f.units) lines.push(`Einheiten: ${f.units}`);
  return lines.join('\n');
}

export interface Fe2Result {
  outcome: 'created' | 'updated' | 'duplicate' | 'test' | 'ignored' | 'suppressed';
  fe2EventId?: string;
  postId?: string | null;
  sequence?: number;
}

async function instanceTimeZone(): Promise<string> {
  return (await getSettings())['general.timezone'] || 'Europe/Berlin';
}

/** Prüfsumme der Einsatz-ID je Verbindung – für Protokolle und die Liste übernommener Einsätze (keine Inhalte). */
export function incidentRef(connectionId: string, eventId: string): string {
  return crypto.createHash('sha256').update(`${connectionId}:${eventId}`).digest('hex');
}

/**
 * FE2-Ereignis verarbeiten. Vor der Aktivierung (oder mit Testkennung) nur die Vorschau speichern, sonst wie jede
 * Einsatzmeldung über handleIncident().
 */
export async function handleFe2Event(c: Connection, payload: unknown, opts: { test?: boolean } = {}): Promise<Fe2Result> {
  const tz = await instanceTimeZone();
  const parsed = parseFe2(payload, c.config.mapping ?? {}, tz);
  if (!parsed.eventId) return { outcome: 'ignored' };
  if (opts.test || c.status !== 'active') {
    const ref = incidentRef(c.id, parsed.eventId).slice(0, 10);
    // Vor der Aktivierung: nur Vorschau speichern, nichts anlegen
    await pool.query(`UPDATE connections SET preview = $2, last_event_at = now(), updated_at = now() WHERE id = $1`, [
      c.id,
      JSON.stringify({ receivedAt: new Date().toISOString(), fields: parsed.fields, title: draftTitle(parsed.fields), body: draftBody(parsed.fields, 'fe2', tz), ignoredKeys: parsed.ignoredKeys, closed: parsed.closed }),
    ]);
    log('info', 'fe2', `Testmeldung empfangen (Ref ${ref}, ${Object.keys(parsed.fields).length} Felder übernommen, ${parsed.ignoredKeys} verworfen)`);
    return { outcome: 'test' };
  }
  return handleIncident(c, 'fe2', { eventId: parsed.eventId, fields: parsed.fields, closed: parsed.closed });
}

/**
 * Einsatzmeldung verarbeiten (FE2-Eingang und Feuersoftware-Abruf). Stabil über (Verbindung, Einsatz-ID):
 * Wiederholungen derselben Meldung sind Duplikate, geänderte Meldungen sind Folgeereignisse. Ein Entwurf wird nur
 * einmal angelegt; spätere Ereignisse aktualisieren ihn nur, solange ihn noch niemand bearbeitet hat – sonst wird die
 * Redaktion benachrichtigt. Ein einmal übernommener und später gelöschter Einsatz (Datenschutz-Anfrage, Löschfrist)
 * wird nicht neu angelegt (connection_seen_events).
 */
export async function handleIncident(c: Connection, source: IncidentSource, input: { eventId: string; fields: Partial<Record<Fe2Field, string>>; closed: boolean }): Promise<Fe2Result> {
  const { eventId, fields, closed } = input;
  const label = SOURCE_LABEL[source];
  const tz = await instanceTimeZone();
  const hash = crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  const key = `${c.id}:${eventId}`;
  const seenHash = incidentRef(c.id, eventId);
  // Protokolle nur mit gekürzter Prüfsumme der Einsatz-ID – keine Inhalte
  const ref = seenHash.slice(0, 10);

  return tx(async (db) => {
    const existing = await one<any>(`SELECT * FROM fe2_events WHERE event_key = $1 FOR UPDATE`, [key], db);
    await db.query(`UPDATE connections SET last_event_at = now() WHERE id = $1`, [c.id]);
    if (existing && existing.payload_hash === hash) return { outcome: 'duplicate' as const, fe2EventId: existing.id, postId: existing.post_id, sequence: existing.sequence };
    const actor = { id: null, name: `${label} („${c.name}“)`, type: 'system' as const };
    if (!existing) {
      // Schon einmal übernommen und inzwischen gelöscht → nicht erneut anlegen
      const seen = await db.query(`INSERT INTO connection_seen_events (connection_id, ref_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.id, seenHash]);
      if (!seen.rowCount) {
        log('info', source, `Einsatz wurde früher übernommen und inzwischen gelöscht – nicht erneut angelegt (Ref ${ref})`);
        return { outcome: 'suppressed' as const };
      }
      const title = draftTitle(fields);
      const ev = await one<any>(
        `INSERT INTO fe2_events (event_key, keyword, title, fields, connection_id, payload_hash, status, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [key, fields.keyword ?? null, title, JSON.stringify(fields), c.id, hash, closed ? 'closed' : 'open', source],
        db,
      );
      let postId: string | null = null;
      if (c.config.createDrafts !== false) {
        const p = await one<any>(`INSERT INTO posts (kind, title) VALUES ('incident', $1) RETURNING id`, [title], db);
        const rev = { title, body: draftBody(fields, source, tz), excerpt: '', media_ids: [] as string[], cover_id: null, site_id: null };
        await db.query(`INSERT INTO post_revisions (post_id, number, title, body, excerpt, content_hash, change_note) VALUES ($1,1,$2,$3,'',$4,$5)`, [p.id, title, rev.body, revisionHash(rev), `Automatisch aus ${label}`]);
        await db.query(`UPDATE fe2_events SET post_id = $2 WHERE id = $1`, [ev.id, p.id]);
        postId = p.id;
        await audit(actor, `${source}.draft_created`, { type: 'post', id: p.id, label: title }, { ref }, 'ok', db);
      }
      await notify({ kind: 'info', title: `Neuer Einsatzentwurf aus ${label}: ${title}`.slice(0, 200), link: postId ? `/beitraege/${postId}` : '/verbindungen', permission: 'post.edit' });
      log('info', source, `Einsatz angelegt (Ref ${ref})`);
      return { outcome: 'created' as const, fe2EventId: ev.id, postId, sequence: 1 };
    }
    // Folgeereignis
    const seq = existing.sequence + 1;
    await db.query(
      `UPDATE fe2_events SET fields = $2, keyword = COALESCE($3, keyword), title = $4, payload_hash = $5, sequence = $6, status = $7, updated_at = now() WHERE id = $1`,
      [existing.id, JSON.stringify(fields), fields.keyword ?? null, draftTitle(fields), hash, seq, closed ? 'closed' : existing.status],
    );
    if (existing.post_id) {
      const post = await one<any>(`SELECT p.current_revision, r.created_by, r.submitted_at FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision WHERE p.id = $1 FOR UPDATE OF p`, [existing.post_id], db);
      if (post && post.current_revision === 1 && !post.created_by && !post.submitted_at) {
        // Noch unbearbeiteter automatischer Entwurf → mit den neuen Feldern ersetzen (neue Fassung)
        const title = draftTitle(fields);
        const rev = { title, body: draftBody(fields, source, tz), excerpt: '', media_ids: [] as string[], cover_id: null, site_id: null };
        await db.query(`UPDATE post_revisions SET title = $2, body = $3, content_hash = $4, change_note = $5 WHERE post_id = $1 AND number = 1`, [existing.post_id, title, rev.body, revisionHash(rev), `Automatisch aus ${label} (Meldung ${seq})`]);
        await db.query(`UPDATE posts SET title = $2, updated_at = now() WHERE id = $1`, [existing.post_id, title]);
      } else {
        await notify({ kind: 'info', title: `${label}-Aktualisierung zu „${existing.title}“${closed ? ' – Einsatz beendet' : ''}`.slice(0, 200), body: 'Der Entwurf wurde bereits bearbeitet und bleibt unverändert.', link: `/beitraege/${existing.post_id}`, permission: 'post.edit' });
      }
    }
    log('info', source, `Folgeereignis ${seq} (Ref ${ref})${closed ? ', beendet' : ''}`);
    return { outcome: 'updated' as const, fe2EventId: existing.id, postId: existing.post_id, sequence: seq };
  });
}
