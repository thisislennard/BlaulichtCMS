import crypto from 'node:crypto';
import { many, one, tx } from '../db/pool.js';
import { randomToken } from './crypto.js';
import { lockSecretOwner, readSecret, storeSecret } from './secrets.js';
import { forwardAudit } from './audit-forward.js';

/**
 * Hash-Kette des Audit-Protokolls (#112, Migration 019).
 *
 * Neue Einträge werden ohne Sperre geschrieben und vom Worker etwa jede Minute in Reihenfolge versiegelt:
 * chain_seq fortlaufend, prev_hash = hash des Vorgängers, hash = HMAC-SHA-256(Schlüssel, prev_hash + Inhalt). Der
 * Inhalt ist audit_canonical() aus der Datenbank (alle Felder außer der IP, die nach Frist entfernt wird). Der
 * Schlüssel ist ein zufälliges Geheimnis, verschlüsselt mit dem Master-Schlüssel (überlebt eine Schlüsselrotation,
 * weil sie alle Geheimnisse neu verschlüsselt). Wer nur Zugriff auf die Datenbank hat, kann geänderte Einträge
 * deshalb nicht neu versiegeln.
 *
 * Grenzen: Löschen der jüngsten, noch nicht weitergeleiteten Einträge erkennt die Kette allein nicht – dafür gehen
 * Einträge und Siegel-Kontrollpunkte optional an eine zentrale Protokollierung (audit-forward.ts).
 */

const KEY_OWNER = '00000000-0000-0000-0000-0000000a0d17';
const SEAL_LOCK = 7_310_112;
const GENESIS = 'genesis';
let cachedKey: Buffer | null = null;

async function chainKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  // Deterministisch die älteste gültige Version (#171) und Anlegen unter derselben Sperre wie storeSecret: so
  // entsteht auch bei gleichzeitigem Start von API und Worker genau ein Schlüssel, und alle Prozesse nutzen ihn.
  const id = await tx(async (db) => {
    await lockSecretOwner('setting', KEY_OWNER, db);
    const row = await one<{ id: string }>(`SELECT id FROM secrets WHERE owner_type = 'setting' AND owner_id = $1 AND revoked_at IS NULL ORDER BY version ASC LIMIT 1`, [KEY_OWNER], db);
    if (row) return row.id;
    return (await storeSecret('setting', KEY_OWNER, randomToken(32), null, db)).id;
  });
  const raw = await readSecret(id);
  if (!raw) throw new Error('Schlüssel der Audit-Kette nicht lesbar');
  cachedKey = Buffer.from(raw, 'utf8');
  return cachedKey;
}

export function chainHash(key: Buffer, prev: string, canonical: string): string {
  return crypto.createHmac('sha256', key).update(prev).update('\n').update(canonical).digest('hex');
}

/** Unversiegelte Einträge in Reihenfolge versiegeln. Gibt die Zahl der neu versiegelten Einträge zurück. */
export async function sealAudit(batch = 1000): Promise<number> {
  const key = await chainKey();
  let total = 0;
  const head = { chain_seq: 0, hash: '' };
  for (;;) {
    const n = await tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1)', [SEAL_LOCK]);
      const last = await one<{ chain_seq: string; hash: string }>(`SELECT chain_seq, hash FROM audit_events WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1`, [], db);
      const rows = await many<{ id: string; c: string }>(`SELECT a.id, audit_canonical(a) AS c FROM audit_events a WHERE a.chain_seq IS NULL ORDER BY a.id LIMIT $1`, [batch], db);
      if (!rows.length) return 0;
      let seq = last ? Number(last.chain_seq) : 0;
      let prev = last?.hash ?? GENESIS;
      const ids: string[] = [];
      const seqs: number[] = [];
      const prevs: string[] = [];
      const hashes: string[] = [];
      for (const r of rows) {
        seq++;
        const h = chainHash(key, prev, r.c);
        ids.push(r.id);
        seqs.push(seq);
        prevs.push(prev);
        hashes.push(h);
        prev = h;
      }
      await db.query(
        `UPDATE audit_events a SET chain_seq = u.seq, prev_hash = u.prev, hash = u.hash
           FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[]) AS u(id, seq, prev, hash) WHERE a.id = u.id`,
        [ids, seqs, prevs, hashes],
      );
      head.chain_seq = seq;
      head.hash = prev;
      return rows.length;
    });
    total += n;
    if (n < batch) break;
  }
  // Kontrollpunkt an die zentrale Protokollierung: so fällt dort auch ein abgeschnittenes Ende auf
  if (total) forwardAudit({ type: 'audit_seal', sealed: total, chain_seq: head.chain_seq, hash: head.hash });
  return total;
}

export interface AuditProblem {
  id: string;
  seq: number;
  kind: 'changed' | 'link' | 'gap';
  text: string;
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  unsealed: number;
  first: { id: string; seq: number; at: string } | null;
  last: { id: string; seq: number; at: string; hash: string } | null;
  problems: AuditProblem[];
  verifiedAt: string;
}

/**
 * Kette prüfen: Inhalt gegen Hash, Verweis auf den Vorgänger, Lücken in chain_seq. Lücken am alten Ende sind
 * normal (Aufbewahrung, retentionDays); eine Lücke zwischen jüngeren Einträgen heißt: mittendrin gelöscht.
 */
export async function verifyAudit(retentionDays: number): Promise<AuditVerification> {
  const key = await chainKey();
  const problems: AuditProblem[] = [];
  const add = (p: AuditProblem) => problems.length < 50 && problems.push(p);
  const retentionEdge = Date.now() - (retentionDays - 1) * 86_400_000;
  let after = 0;
  let checked = 0;
  let first: AuditVerification['first'] = null;
  let prev: { seq: number; hash: string; at: Date } | null = null;
  for (;;) {
    const rows = await many<{ id: string; chain_seq: string; prev_hash: string; hash: string; at: Date; c: string }>(
      `SELECT a.id, a.chain_seq, a.prev_hash, a.hash, a.at, audit_canonical(a) AS c FROM audit_events a
        WHERE a.chain_seq > $1 ORDER BY a.chain_seq LIMIT 2000`,
      [after],
    );
    if (!rows.length) break;
    for (const r of rows) {
      const seq = Number(r.chain_seq);
      if (!first) first = { id: String(r.id), seq, at: new Date(r.at).toISOString() };
      if (prev) {
        if (seq !== prev.seq + 1 && prev.at.getTime() >= retentionEdge) {
          add({ id: String(r.id), seq, kind: 'gap', text: `Einträge ${prev.seq + 1}–${seq - 1} der Kette fehlen (gelöscht).` });
        }
        if (seq === prev.seq + 1 && r.prev_hash !== prev.hash) add({ id: String(r.id), seq, kind: 'link', text: 'Verweis auf den Vorgänger stimmt nicht.' });
      }
      if (chainHash(key, r.prev_hash, r.c) !== r.hash) add({ id: String(r.id), seq, kind: 'changed', text: 'Inhalt wurde nach dem Versiegeln verändert.' });
      prev = { seq, hash: r.hash, at: new Date(r.at) };
      checked++;
    }
    after = Number(rows[rows.length - 1].chain_seq);
  }
  const unsealed = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE chain_seq IS NULL`))!.n;
  const lastRow = prev ? await one<any>(`SELECT id, chain_seq, at, hash FROM audit_events WHERE chain_seq = $1`, [prev.seq]) : null;
  return {
    ok: problems.length === 0,
    checked,
    unsealed,
    first,
    last: lastRow ? { id: String(lastRow.id), seq: Number(lastRow.chain_seq), at: new Date(lastRow.at).toISOString(), hash: lastRow.hash } : null,
    problems,
    verifiedAt: new Date().toISOString(),
  };
}

/** Nur für Tests. */
export function resetChainKeyCache() {
  cachedKey = null;
}

