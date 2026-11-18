import crypto from 'node:crypto';
import { many, pool, type Queryable } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/log.js';
import { refreshApprovalNotice } from '../approvals/notices.js';
import { enqueueBannerJob } from '../routes/banners.js';

/*
 * „Banner folgt dem Vorgang“ (#274). Ein Vorgang ist ein reales Ereignis über mehrere Meldungen hinweg:
 *
 *  - amtliche Warnung: Wurzel der CAP-Kette (Erstmeldung; Aktualisierungen und Entwarnung verweisen per `references`
 *    auf frühere Meldungen derselben Kette),
 *  - Einsatz aus FE2/Feuersoftware Connect: Verbindung + Einsatz-ID.
 *
 * Gespeichert und in den Lauf gegeben wird nur eine Prüfsumme (`w:…` bzw. `e:…`), keine Inhalte. Die Banner-Aktion
 * (engine.ts) aktualisiert damit ihr früheres Banner statt ein neues anzulegen; das Ende des Vorgangs beendet alle
 * folgenden Banner beim Eingang des Ereignisses – unabhängig davon, ob ein Workflow die Entwarnung noch verarbeitet.
 */

const short = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

/** Vorgang-Schlüssel einer amtlichen Warnung aus der Wurzel ihrer CAP-Kette. */
export const warningKey = (root: string) => `w:${short(`cap:${root}`)}`;
/** Vorgang-Schlüssel eines Einsatzes (je Verbindung und Einsatz-ID). */
export const incidentKey = (connectionId: string, eventId: string) => `e:${short(`inc:${connectionId}:${eventId}`)}`;
/** Art des Vorgangs aus dem Schlüssel. */
export const keyKind = (key: string | null | undefined): 'warnung' | 'einsatz' | null => (key?.startsWith('w:') ? 'warnung' : key?.startsWith('e:') ? 'einsatz' : null);

export type FollowEnd = 'entwarnung' | 'einsatz_beendet';
export const END_LABEL: Record<FollowEnd, string> = { entwarnung: 'Entwarnung', einsatz_beendet: 'Einsatz beendet' };

/** Gespeicherte Meldung einer Kette (nur was die Wurzelsuche braucht). */
export interface ChainRow {
  identifier: string;
  references_ids: string[] | null;
  chain_root: string | null;
}

/**
 * Wurzeln der CAP-Kette für eine Meldung mit diesen Verweisen. Läuft rückwärts über die Verweise: Eine bekannte Meldung
 * liefert ihre gespeicherte Wurzel (oder sich selbst, wenn sie keine Verweise hat), eine unbekannte gilt selbst als
 * Wurzel. Ohne Verweise ist die Meldung ihre eigene Wurzel. Reihenfolge: in der Reihenfolge der Verweise, ohne Doppel.
 * `load` liefert die gespeicherten Meldungen zu den Kennungen (für Einheitentests ohne Datenbank austauschbar).
 */
export async function chainRoots(identifier: string, refs: string[], load: (ids: string[]) => Promise<ChainRow[]>): Promise<string[]> {
  if (!refs.length) return [identifier];
  const roots: string[] = [];
  const seen = new Set<string>([identifier]);
  let frontier = refs.filter(Boolean);
  for (let depth = 0; frontier.length && depth < 25; depth++) {
    const todo = frontier.filter((id) => !seen.has(id));
    todo.forEach((id) => seen.add(id));
    if (!todo.length) break;
    const rows = new Map((await load(todo)).map((r) => [r.identifier, r]));
    const next: string[] = [];
    for (const id of todo) {
      const r = rows.get(id);
      if (!r) roots.push(id);
      else if (r.chain_root) roots.push(r.chain_root);
      else if (!(r.references_ids ?? []).length) roots.push(id);
      else next.push(...(r.references_ids ?? []));
    }
    frontier = next;
  }
  const out = [...new Set(roots)];
  return out.length ? out : [identifier];
}

/** Wurzeln aus der Datenbank (Meldungen aller Warnfeed-Verbindungen – die Kette ist eine Eigenschaft der Meldungen). */
export function chainRootsDb(identifier: string, refs: string[], db: Queryable = pool): Promise<string[]> {
  return chainRoots(identifier, refs, (ids) => many<ChainRow>(`SELECT DISTINCT ON (identifier) identifier, references_ids, chain_root FROM official_warnings WHERE identifier = ANY($1) ORDER BY identifier, chain_root NULLS LAST`, [ids], db));
}

/** Ist der Vorgang schon beendet (Entwarnung/Einsatzende eingegangen)? Dann legt die Banner-Aktion nichts mehr an. */
export async function endedKey(key: string, db: Queryable = pool): Promise<FollowEnd | null> {
  const r = await many<{ reason: FollowEnd }>(`SELECT reason FROM banner_follow_ends WHERE source_key = $1`, [key], db);
  return r[0]?.reason ?? null;
}

/**
 * Ende eines Vorgangs: alle noch aktiven Banner, die ihm folgen, enden jetzt (Auftrag zum Entfernen an die Website,
 * wenn schon veröffentlicht; sonst werden offene Aufträge verworfen) und der Vorgang wird als beendet gemerkt.
 * Läuft in der Transaktion des Aufrufers (`db`). Rückgabe: Anzahl beendeter Banner. Die Freigabe-Benachrichtigung
 * gleicht `afterFollowEnd` nach dem Abschluss der Transaktion ab.
 */
export async function endFollowedBanners(keys: string[], reason: FollowEnd, db: Queryable): Promise<number> {
  const list = [...new Set(keys.filter(Boolean))];
  if (!list.length) return 0;
  await db.query(`DELETE FROM banner_follow_ends WHERE ended_at < now() - interval '30 days'`);
  for (const k of list) await db.query(`INSERT INTO banner_follow_ends (source_key, reason) VALUES ($1,$2) ON CONFLICT (source_key) DO NOTHING`, [k, reason]);
  const rows = await many<any>(
    `UPDATE banners b SET ended_at = now(), ended_reason = $2
      WHERE b.source_key = ANY($1) AND b.follows AND b.ended_at IS NULL
      RETURNING b.*, (SELECT name FROM automations a WHERE a.id = b.automation_id) AS automation_name`,
    [list, reason],
    db,
  );
  for (const b of rows) {
    const published = await many(`SELECT 1 FROM banner_jobs WHERE banner_id = $1 AND action = 'upsert' AND status IN ('sent','done') LIMIT 1`, [b.id], db);
    if (published.length) await enqueueBannerJob(db, b, 'delete', null);
    else await db.query(`UPDATE banner_jobs SET status = 'canceled' WHERE banner_id = $1 AND status = 'queued'`, [b.id]);
    const actor = { id: null, name: b.automation_name ? `Workflow „${b.automation_name}“` : 'Workflow', type: 'system' as const };
    await audit(actor, 'banner.follow_ended', { type: 'banner', id: b.id, label: b.title }, { grund: END_LABEL[reason], fassung: b.revision }, 'ok', db);
  }
  if (rows.length) log('info', 'automation', `${rows.length} Banner mit dem Vorgang beendet (${END_LABEL[reason]})`);
  return rows.length;
}

/** Nach dem Ende (außerhalb der Transaktion): Freigabe-Benachrichtigung und Liste abgleichen. */
export async function afterFollowEnd(ended: number, reason: FollowEnd) {
  if (ended) await refreshApprovalNotice('banner', { note: `${END_LABEL[reason]} – Banner beendet` });
}
