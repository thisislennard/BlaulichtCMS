import crypto from 'node:crypto';
import type pg from 'pg';
import { many, one, pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import type { InputKind } from './catalog.js';
import { createRun, expireApprovals, type Snapshot } from './engine.js';
import type { InputRef } from './graph.js';
import { lastDueSlot, type Data, type ScheduleConfig } from './logic.js';
import { lookupKeyword } from '../keywords/store.js';

/*
 * Ereignisse aus den vorhandenen Quellen → Läufe aktiver Automationen. Die Quellen rufen nur eine kleine Funktion auf
 * (emitIncident, emitOfficialWarning, emitRssItem, emitUpload); Fehler hier dürfen den Empfang nie stören. Innerhalb
 * einer Transaktion der Quelle läuft das Anlegen unter einem Savepoint – so entsteht der Lauf genau dann, wenn auch die
 * Meldung gespeichert wird.
 */

export interface Trigger {
  automationId: string;
  automationName: string;
  version: number;
  activatedAt: Date;
  directAllowed: boolean;
  snapshot: Snapshot;
  nodeId: string;
  input: InputRef;
}

/** Eingangs-Knoten aller aktiven Automationen für eine Art von Eingang (Momentaufnahme der aktiven Version). */
export async function activeTriggers(kind: InputKind, db: pg.PoolClient | pg.Pool = pool): Promise<Trigger[]> {
  const rows = await many<any>(
    `SELECT a.id, a.name, a.direct_publish, v.version, v.graph, v.direct_publish AS v_direct, v.activated_at
       FROM automations a JOIN automation_versions v ON v.automation_id = a.id AND v.version = a.active_version
      WHERE a.status = 'active' AND a.deleted_at IS NULL`,
    [],
    db,
  );
  const out: Trigger[] = [];
  for (const r of rows) {
    const snap = r.graph as Snapshot;
    for (const n of snap.nodes ?? []) {
      if (n.type !== 'input') continue;
      const input = snap.refs?.inputs?.[n.data?.inputId];
      if (input?.kind === kind) out.push({ automationId: r.id, automationName: r.name, version: r.version, activatedAt: new Date(r.activated_at), directAllowed: !!r.v_direct && !!r.direct_publish, snapshot: snap, nodeId: n.id, input });
    }
  }
  return out;
}

export async function start(t: Trigger, eventKey: string, payload: Data, db: pg.PoolClient | pg.Pool, opts: { trigger?: 'event' | 'schedule'; runAt?: Date } = {}) {
  return createRun(
    { automationId: t.automationId, version: t.version, mode: 'live', trigger: opts.trigger ?? 'event', inputNode: t.nodeId, eventKey: `${t.nodeId}|${eventKey}`.slice(0, 300), snapshot: t.snapshot, directAllowed: t.directAllowed, payload, runAt: opts.runAt },
    db,
  );
}

/** Ausführen, ohne dass ein Fehler die Quelle stört (Savepoint in einer laufenden Transaktion). */
async function safely(what: string, db: pg.PoolClient | undefined, fn: (db: pg.PoolClient | pg.Pool) => Promise<void>) {
  try {
    if (!(await getSettings())['automations.enabled']) return;
    if (!db) return await fn(pool);
    await db.query('SAVEPOINT automation_emit');
    try {
      await fn(db);
      await db.query('RELEASE SAVEPOINT automation_emit');
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT automation_emit');
      throw e;
    }
  } catch (e) {
    log('warn', 'automation', `Ereignis ${what} nicht verarbeitet: ${(e as Error).message}`);
  }
}

const short = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

/* ------------------------------------------------------------------ Einsätze (FE2, Feuersoftware) */

export async function emitIncident(
  c: { id: string; name: string },
  source: 'fe2' | 'feuersoftware',
  ev: { eventId: string; sequence: number; phase: 'neu' | 'aktualisierung' | 'beendet'; fields: Record<string, string | undefined>; postId?: string | null },
  db?: pg.PoolClient,
) {
  await safely(source, db, async (q) => {
    const triggers = (await activeTriggers(source, q)).filter((t) => t.input.config.connectionId === c.id && (t.input.config.phases ?? ['neu']).includes(ev.phase));
    if (!triggers.length) return;
    const f = ev.fields;
    // Kategorie aus der aktiven Stichwortliste (#195); unbekannte Stichworte bleiben ohne Kategorie
    const kw = await lookupKeyword(f.keyword, q).catch(() => null);
    const payload: Data = {
      vorgang: ev.phase,
      stichwort: f.keyword ?? '',
      stichwort_text: f.keyword_text ?? '',
      stichwort_kategorie: kw?.category ?? '',
      einsatzart: f.category ?? '',
      ort: f.municipality ?? '',
      ortsteil: f.district ?? '',
      alarmzeit: f.started_at ?? '',
      einheiten: f.units ?? '',
      status: f.status ?? '',
      quelle: source === 'fe2' ? 'FE2' : 'Feuersoftware Connect',
      verbindung: c.name,
      entwurf_link: ev.postId ? `/beitraege/${ev.postId}` : '',
    };
    // Einsatz-ID nur als Prüfsumme im Schlüssel (keine Inhalte)
    for (const t of triggers) await start(t, `inc:${short(`${c.id}:${ev.eventId}`)}:${ev.sequence}`, payload, q);
  });
}

/* ------------------------------------------------------------------ Amtliche Warnungen */

const LEVEL: Record<string, string> = { Minor: '1', Moderate: '2', Severe: '3', Extreme: '4' };

export async function emitOfficialWarning(c: { id: string; name: string }, w: any, inArea: boolean, source: string) {
  await safely('warnfeed', undefined, async (q) => {
    const phase = w.msg_type === 'Cancel' ? 'entwarnung' : w.msg_type === 'Update' || (w.references_ids ?? []).length ? 'aktualisierung' : 'neu';
    const triggers = (await activeTriggers('warnfeed', q)).filter((t) => t.input.config.connectionId === c.id && (t.input.config.phases ?? ['neu']).includes(phase) && (inArea || t.input.config.onlyInArea === false));
    if (!triggers.length) return;
    const payload: Data = {
      vorgang: phase,
      ereignis: w.event ?? '',
      ueberschrift: w.headline ?? '',
      beschreibung: String(w.description ?? '').slice(0, 1000),
      verhalten: String(w.instruction ?? '').slice(0, 1000),
      stufe: LEVEL[w.severity] ?? '',
      schwere: w.severity || 'Unknown',
      dringlichkeit: w.urgency ?? '',
      gebiete: (w.areas ?? []).slice(0, 10).join(', '),
      gueltig_bis: w.expires_at ? new Date(w.expires_at).toISOString() : '',
      quelle: source,
      link: w.web_url && /^https:\/\//.test(w.web_url) ? w.web_url : '',
      im_gebiet: inArea ? 'ja' : 'nein',
    };
    for (const t of triggers) await start(t, `warn:${short(`${c.id}:${w.identifier}`)}`, payload, q);
  });
}

/* ------------------------------------------------------------------ RSS */

export async function emitRssItem(feedId: string, item: { key: string; title: string; link: string | null; summary: string; published: Date | null }) {
  await safely('rss', undefined, async (q) => {
    const triggers = (await activeTriggers('rss', q)).filter((t) => !t.input.config.feedId || t.input.config.feedId === feedId);
    if (!triggers.length) return;
    const feed = await one<{ title: string }>(`SELECT title FROM rss_feeds WHERE id = $1`, [feedId], q);
    const payload: Data = {
      titel: item.title,
      link: item.link && /^https?:\/\//i.test(item.link) ? item.link : '',
      zusammenfassung: item.summary,
      veroeffentlicht: item.published ? item.published.toISOString() : '',
      quelle: feed?.title ?? '',
    };
    for (const t of triggers) await start(t, `rss:${feedId}:${item.key.slice(0, 32)}`, payload, q);
  });
}

/* ------------------------------------------------------------------ Uploads */

/**
 * Neue geprüfte Datei über einen Upload-Link. Gebündelt je Sammlung und Zeitfenster des Eingangs: Der Lauf startet am
 * Ende des Fensters und zählt dann die neuen Dateien. Keine Angaben der Hochladenden.
 */
export async function emitUpload(m: { collectionId: string; linkLabel: string | null; collectionTitle: string }) {
  await safely('upload', undefined, async (q) => {
    const triggers = (await activeTriggers('upload', q)).filter((t) => !t.input.config.collectionId || t.input.config.collectionId === m.collectionId);
    for (const t of triggers) {
      const win = Math.max(5, Number(t.input.config.windowMinutes) || 30) * 60_000;
      const bucket = Math.floor(Date.now() / win);
      const since = new Date(bucket * win);
      const payload: Data = { sammlung: m.collectionTitle, sammlung_link: `/medien/${m.collectionId}`, link_bezeichnung: m.linkLabel ?? '', anzahl: '1', _collection_id: m.collectionId, _since: since.toISOString() };
      await start(t, `up:${m.collectionId}:${bucket}`, payload, q, { runAt: new Date((bucket + 1) * win) });
    }
  });
}

/* ------------------------------------------------------------------ Presseanfragen (#204) */

/** Neue Presseanfrage (von Hand oder aus dem Presse-Postfach) – nur Felder ohne Kontaktdaten der anfragenden Person. */
export async function emitPressRequest(r: { id: string; channel: string; payload: Data }, db?: pg.PoolClient) {
  await safely('press', db, async (q) => {
    const triggers = (await activeTriggers('press', q)).filter((t) => !(t.input.config.channels ?? []).length || (t.input.config.channels as string[]).includes(r.channel));
    for (const t of triggers) await start(t, `press:${r.id}`, r.payload, q);
  });
}

/* ------------------------------------------------------------------ Zeitpläne */

/** Kennzahlen für Zeitplan-Läufe (z. B. tägliche Übersicht der offenen Freigaben). */
async function scheduleData(slot: Date): Promise<Data> {
  const posts = await many<{ title: string }>(
    `SELECT r.title FROM posts p JOIN post_revisions r ON r.post_id = p.id AND r.number = p.current_revision
      WHERE p.archived_at IS NULL AND r.submitted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id = r.id AND a.revoked_at IS NULL AND (a.decision = 'approved' OR a.decided_at >= r.submitted_at))
      ORDER BY r.submitted_at LIMIT 50`,
  );
  const n = async (sql: string) => (await one<{ n: number }>(sql))?.n ?? 0;
  return {
    zeitpunkt: slot.toISOString(),
    offene_beitraege: String(posts.length),
    offene_beitraege_liste: posts.slice(0, 20).map((p) => `– ${p.title}`).join('\n'),
    offene_banner: String(await n(`SELECT count(*)::int AS n FROM banners WHERE ended_at IS NULL AND submitted_at IS NOT NULL AND (approved_hash IS NULL OR approved_hash <> content_hash) AND ends_at > now()`)),
    offene_warnentwuerfe: String(
      await n(`SELECT count(*)::int AS n FROM warnings w JOIN warning_revisions r ON r.warning_id = w.id AND r.number = w.current_revision
                WHERE w.archived_at IS NULL AND r.submitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM warning_approvals a WHERE a.revision_id = r.id AND a.decided_at >= r.submitted_at)`),
    ),
    offene_automationsfreigaben: String(await n(`SELECT count(*)::int AS n FROM automation_approvals WHERE status = 'pending'`)),
  };
}

/**
 * Worker (Leader, alle 30 s): fällige Zeitpläne starten, abgelaufene Freigaben schließen. Ein Termin startet höchstens
 * einmal (event_key) und nur, wenn er höchstens 10 Minuten zurückliegt und nach der Aktivierung liegt – nach einem
 * längeren Ausfall werden verpasste Termine nicht nachgeholt.
 */
export async function automationTick(now = Date.now()): Promise<{ started: number; expired: number }> {
  const s = await getSettings();
  let started = 0;
  if (s['automations.enabled']) {
    const tz = s['general.timezone'] || 'Europe/Berlin';
    for (const t of await activeTriggers('schedule')) {
      const slot = lastDueSlot(t.input.config as ScheduleConfig, now, tz);
      if (!slot || now - slot.getTime() > 10 * 60_000 || slot < t.activatedAt) continue;
      const exists = await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND event_key = $2 AND mode = 'live'`, [t.automationId, `${t.nodeId}|sch:${slot.toISOString()}`]);
      if (exists) continue;
      const id = await start(t, `sch:${slot.toISOString()}`, await scheduleData(slot), pool, { trigger: 'schedule' });
      if (id) started++;
    }
  }
  const expired = await expireApprovals();
  return { started, expired };
}
