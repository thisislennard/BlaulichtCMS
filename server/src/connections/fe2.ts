import crypto from 'node:crypto';
import { one, pool, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { revisionHash } from '../routes/posts.js';
import type { Connection } from './common.js';

/**
 * FE2-Eingang für interne Einsatzentwürfe.
 *
 * Das tatsächliche Format hängt von der FE2-Konfiguration (HTTP-Ausgang) ab. LifeLink liest deshalb nur Felder über eine
 * konfigurierbare Zuordnung (Pfad je Feld) und übernimmt ausschließlich die Felder der Allowlist. Alles andere –
 * insbesondere Alarmtext, Meldender, Patienten- oder Personendaten – wird verworfen und nie gespeichert oder protokolliert.
 * Es entstehen nur interne Entwürfe; die Einsatzalarmierung läuft unabhängig von LifeLink.
 */

/** Felder, die überhaupt in einen redaktionellen Entwurf gelangen dürfen. */
export const FE2_ALLOWED_FIELDS = {
  keyword: 'Stichwort',
  keyword_text: 'Stichwort (Klartext)',
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
  if (Array.isArray(v)) return v.map((x) => clean(x, 60)).filter(Boolean).join(', ').slice(0, max) || null;
  if (typeof v === 'object') return null; // verschachtelte Objekte werden nicht übernommen
  const s = String(v).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export interface Fe2Parsed {
  eventId: string | null;
  fields: Partial<Record<Fe2Field, string>>;
  closed: boolean;
  ignoredKeys: number;
}

/** Nur zugeordnete Felder der Allowlist übernehmen. */
export function parseFe2(payload: unknown, mapping: Record<string, string>): Fe2Parsed {
  const map = { ...FE2_DEFAULT_MAPPING, ...(mapping ?? {}) };
  const eventId = clean(pick(payload, map.event_id), 100);
  const fields: Partial<Record<Fe2Field, string>> = {};
  for (const f of Object.keys(FE2_ALLOWED_FIELDS) as Fe2Field[]) {
    const v = clean(pick(payload, map[f]));
    if (v) fields[f] = v;
  }
  const total = countLeaves(payload);
  const closed = /^(beendet|abgeschlossen|closed|ended|finished)$/i.test(fields.status ?? '');
  return { eventId, fields, closed, ignoredKeys: Math.max(0, total - Object.keys(fields).length - (eventId ? 1 : 0)) };
}

function countLeaves(v: any, depth = 0): number {
  if (depth > 6 || v == null) return 0;
  if (typeof v !== 'object') return 1;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countLeaves(x, depth + 1), 0);
  return Object.values(v).reduce<number>((n, x) => n + countLeaves(x, depth + 1), 0);
}

export function draftTitle(f: Partial<Record<Fe2Field, string>>): string {
  const what = f.keyword_text || f.keyword || 'Einsatz';
  const where = [f.municipality, f.district].filter(Boolean).join(' – ');
  return `${what}${where ? ` in ${where}` : ''}`.slice(0, 200);
}

function draftBody(f: Partial<Record<Fe2Field, string>>): string {
  // Bewusst neutral und knapp: Grundlage für die Redaktion, keine Veröffentlichung
  const lines = ['[Automatischer Entwurf aus FE2 – bitte redaktionell prüfen und ergänzen.]', ''];
  if (f.keyword) lines.push(`Stichwort: ${f.keyword}${f.keyword_text ? ` (${f.keyword_text})` : ''}`);
  if (f.municipality) lines.push(`Ort: ${f.municipality}${f.district ? `, ${f.district}` : ''}`);
  if (f.started_at) lines.push(`Alarmzeit: ${f.started_at}`);
  if (f.units) lines.push(`Einheiten: ${f.units}`);
  return lines.join('\n');
}

export interface Fe2Result {
  outcome: 'created' | 'updated' | 'duplicate' | 'test' | 'ignored';
  fe2EventId?: string;
  postId?: string | null;
  sequence?: number;
}

/**
 * Ereignis verarbeiten. Stabil über (Verbindung, Einsatz-ID): Wiederholungen derselben Meldung sind Duplikate,
 * geänderte Meldungen sind Folgeereignisse. Ein Entwurf wird nur einmal angelegt; spätere Ereignisse aktualisieren ihn
 * nur, solange ihn noch niemand bearbeitet hat – sonst wird die Redaktion benachrichtigt.
 */
export async function handleFe2Event(c: Connection, payload: unknown, opts: { test?: boolean } = {}): Promise<Fe2Result> {
  const parsed = parseFe2(payload, c.config.mapping ?? {});
  if (!parsed.eventId) return { outcome: 'ignored' };
  const hash = crypto.createHash('sha256').update(JSON.stringify(parsed.fields)).digest('hex');
  const key = `${c.id}:${parsed.eventId}`;
  // Protokolle nur mit gekürzter Prüfsumme der Einsatz-ID – keine Inhalte
  const ref = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);

  if (opts.test || c.status !== 'active') {
    // Vor der Aktivierung: nur Vorschau speichern, nichts anlegen
    await pool.query(`UPDATE connections SET preview = $2, last_event_at = now(), updated_at = now() WHERE id = $1`, [
      c.id,
      JSON.stringify({ receivedAt: new Date().toISOString(), fields: parsed.fields, title: draftTitle(parsed.fields), body: draftBody(parsed.fields), ignoredKeys: parsed.ignoredKeys, closed: parsed.closed }),
    ]);
    log('info', 'fe2', `Testmeldung empfangen (Ref ${ref}, ${Object.keys(parsed.fields).length} Felder übernommen, ${parsed.ignoredKeys} verworfen)`);
    return { outcome: 'test' };
  }

  return tx(async (db) => {
    const existing = await one<any>(`SELECT * FROM fe2_events WHERE event_key = $1 FOR UPDATE`, [key], db);
    await db.query(`UPDATE connections SET last_event_at = now() WHERE id = $1`, [c.id]);
    if (existing && existing.payload_hash === hash) return { outcome: 'duplicate' as const, fe2EventId: existing.id, postId: existing.post_id, sequence: existing.sequence };
    const actor = { id: null, name: `FE2 („${c.name}“)`, type: 'system' as const };
    if (!existing) {
      const ev = await one<any>(
        `INSERT INTO fe2_events (event_key, keyword, title, fields, connection_id, payload_hash, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [key, parsed.fields.keyword ?? null, draftTitle(parsed.fields), JSON.stringify(parsed.fields), c.id, hash, parsed.closed ? 'closed' : 'open'],
        db,
      );
      let postId: string | null = null;
      if (c.config.createDrafts !== false) {
        const title = draftTitle(parsed.fields);
        const p = await one<any>(`INSERT INTO posts (kind, title) VALUES ('incident', $1) RETURNING id`, [title], db);
        const rev = { title, body: draftBody(parsed.fields), excerpt: '', media_ids: [] as string[], cover_id: null, site_id: null };
        await db.query(`INSERT INTO post_revisions (post_id, number, title, body, excerpt, content_hash, change_note) VALUES ($1,1,$2,$3,'',$4,'Automatisch aus FE2')`, [p.id, title, rev.body, revisionHash(rev)]);
        await db.query(`UPDATE fe2_events SET post_id = $2 WHERE id = $1`, [ev.id, p.id]);
        postId = p.id;
        await audit(actor, 'fe2.draft_created', { type: 'post', id: p.id, label: title }, { ref }, 'ok', db);
      }
      await notify({ kind: 'info', title: `Neuer Einsatzentwurf aus FE2: ${draftTitle(parsed.fields)}`.slice(0, 200), link: postId ? `/beitraege/${postId}` : '/verbindungen', permission: 'post.edit' });
      log('info', 'fe2', `Einsatz angelegt (Ref ${ref})`);
      return { outcome: 'created' as const, fe2EventId: ev.id, postId, sequence: 1 };
    }
    // Folgeereignis
    const seq = existing.sequence + 1;
    await db.query(
      `UPDATE fe2_events SET fields = $2, keyword = COALESCE($3, keyword), title = $4, payload_hash = $5, sequence = $6, status = $7, updated_at = now() WHERE id = $1`,
      [existing.id, JSON.stringify(parsed.fields), parsed.fields.keyword ?? null, draftTitle(parsed.fields), hash, seq, parsed.closed ? 'closed' : existing.status],
    );
    if (existing.post_id) {
      const post = await one<any>(`SELECT p.current_revision, r.created_by, r.submitted_at FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision WHERE p.id = $1 FOR UPDATE OF p`, [existing.post_id], db);
      if (post && post.current_revision === 1 && !post.created_by && !post.submitted_at) {
        // Noch unbearbeiteter automatischer Entwurf → mit den neuen Feldern ersetzen (neue Fassung)
        const title = draftTitle(parsed.fields);
        const rev = { title, body: draftBody(parsed.fields), excerpt: '', media_ids: [] as string[], cover_id: null, site_id: null };
        await db.query(`UPDATE post_revisions SET title = $2, body = $3, content_hash = $4, change_note = $5 WHERE post_id = $1 AND number = 1`, [existing.post_id, title, rev.body, revisionHash(rev), `Automatisch aus FE2 (Meldung ${seq})`]);
        await db.query(`UPDATE posts SET title = $2, updated_at = now() WHERE id = $1`, [existing.post_id, title]);
      } else {
        await notify({ kind: 'info', title: `FE2-Aktualisierung zu „${existing.title}“${parsed.closed ? ' – Einsatz beendet' : ''}`.slice(0, 200), body: 'Der Entwurf wurde bereits bearbeitet und bleibt unverändert.', link: `/beitraege/${existing.post_id}`, permission: 'post.edit' });
      }
    }
    log('info', 'fe2', `Folgeereignis ${seq} (Ref ${ref})${parsed.closed ? ', beendet' : ''}`);
    return { outcome: 'updated' as const, fe2EventId: existing.id, postId: existing.post_id, sequence: seq };
  });
}
