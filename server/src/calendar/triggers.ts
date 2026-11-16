import crypto from 'node:crypto';
import { one, pool } from '../db/pool.js';
import { log } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import { activeTriggers, start, type Trigger } from '../automations/events.js';
import type { Data } from '../automations/logic.js';
import { occurrences, type Occ } from './store.js';

/**
 * Workflow-Eingang „Kalendereintrag“ (#203). Der Worker (Leader) prüft alle 30 Sekunden, welche Termine – eigene und
 * eingelesene, Serien aufgelöst – gerade beginnen, enden oder in X Minuten/Stunden/Tagen beginnen.
 *
 * Genau einmal: Jeder Auslösezeitpunkt eines Termins hat einen festen Schlüssel (Termin bzw. Serie + ursprünglicher
 * Beginn des Einzeltermins + Art + Auslösezeitpunkt) in `automation_runs.event_key` – auch nach einem Neustart startet
 * derselbe Zeitpunkt nie ein zweites Mal. Wird ein Termin verschoben, gilt der neue Zeitpunkt (einmal); der alte ist
 * entweder schon ausgelöst oder entfällt. Verpasste Zeitpunkte werden höchstens 10 Minuten nachgeholt (wie Zeitpläne),
 * Zeitpunkte vor der Aktivierung des Workflows nie.
 */

export const CATCH_UP_MS = 10 * 60_000;

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export function offsetMs(cfg: { timing?: string; beforeValue?: number; beforeUnit?: keyof typeof UNIT_MS }): number {
  return cfg.timing === 'before' ? (Number(cfg.beforeValue) || 0) * (UNIT_MS[cfg.beforeUnit ?? 'minutes'] ?? 60_000) : 0;
}

/** Zeitpunkt, zu dem ein Termin für diesen Eingang auslöst. */
export function triggerTime(o: { start: number; end: number }, cfg: { timing?: string; beforeValue?: number; beforeUnit?: keyof typeof UNIT_MS }): number {
  return cfg.timing === 'end' ? o.end : o.start - offsetMs(cfg);
}

/** Erfüllt der Termin die Filter des Eingangs? */
export function matchesFilters(o: Occ, cfg: any): boolean {
  const r = o.row;
  if (cfg.categoryIds?.length && !(r.category_id && cfg.categoryIds.includes(r.category_id))) return false;
  if (cfg.sources?.length) {
    const ok = r.source === 'own' ? cfg.sources.includes('own') : !!r.source_id && cfg.sources.includes(r.source_id);
    if (!ok) return false;
  }
  if (cfg.tags?.length) {
    const have = new Set((r.tags ?? []).map((t) => t.toLocaleLowerCase('de')));
    if (!cfg.tags.some((t: string) => have.has(t.toLocaleLowerCase('de')))) return false;
  }
  const text = String(cfg.textContains ?? '').trim().toLocaleLowerCase('de');
  if (text && !`${r.title}\n${r.description}`.toLocaleLowerCase('de').includes(text)) return false;
  return true;
}

/** Kennung eines Einzeltermins, die Verschieben und Neueinlesen übersteht. */
export function instanceIdentity(o: Occ): string {
  const r = o.row;
  const inst = o.instance != null ? new Date(o.instance).toISOString() : '';
  if (r.source === 'ical') return `ical:${r.source_id}:${r.uid ?? r.id}:${inst}`;
  return `own:${r.series_id ?? r.id}:${inst}`;
}

export function calendarPayload(o: Occ, timing: string): Data {
  const r = o.row;
  const end = new Date(o.end).toISOString();
  return {
    titel: r.title,
    beschreibung: String(r.description ?? '').slice(0, 1000),
    beginn: new Date(o.start).toISOString(),
    ende: end,
    ganztaegig: r.all_day ? 'ja' : 'nein',
    ort: r.location ?? '',
    kategorie: r.cat_name ?? '',
    schlagwoerter: (r.tags ?? []).join(', '),
    quelle: r.source === 'ical' ? (r.source_name ?? 'iCal') : 'Eigene Termine',
    zeitpunkt: timing === 'end' ? 'ende' : timing === 'before' ? 'vorher' : 'beginn',
    gueltig_bis: end,
    termin_link: '/kalender',
  };
}

const short = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

/**
 * Fällige Kalender-Auslöser starten. `now` nur für Tests. Liefert die Zahl der gestarteten Läufe.
 */
export async function calendarTriggerTick(now = Date.now()): Promise<number> {
  const s = await getSettings();
  if (!s['automations.enabled']) return 0;
  const triggers = await activeTriggers('calendar');
  if (!triggers.length) return 0;
  // Je Zeitversatz und Art einmal abfragen
  const groups = new Map<string, Trigger[]>();
  for (const t of triggers) {
    const k = `${t.input.config.timing ?? 'start'}|${offsetMs(t.input.config)}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  let started = 0;
  for (const [k, list] of groups) {
    const [timing, off] = [k.split('|')[0], Number(k.split('|')[1])];
    // Termine, deren Auslösezeitpunkt im Fenster (now - 10 min, now] liegt
    const from = new Date(now - CATCH_UP_MS + off);
    const to = new Date(now + off + 1);
    let occ: Occ[];
    try {
      occ = await occurrences(from, to);
    } catch (e) {
      log('warn', 'automation', `Kalender-Auslöser: ${(e as Error).message}`);
      continue;
    }
    for (const o of occ) {
      const at = triggerTime(o, list[0].input.config);
      if (at > now || at <= now - CATCH_UP_MS) continue;
      for (const t of list) {
        if (at < +t.activatedAt) continue;
        if (!matchesFilters(o, t.input.config)) continue;
        const key = `cal:${short(instanceIdentity(o))}:${timing}:${new Date(at).toISOString()}`;
        if (await one(`SELECT 1 FROM automation_runs WHERE automation_id = $1 AND event_key = $2 AND mode = 'live'`, [t.automationId, `${t.nodeId}|${key}`])) continue;
        const id = await start(t, key, calendarPayload(o, timing), pool).catch((e) => {
          log('warn', 'automation', `Kalender-Auslöser für „${t.automationName}“: ${(e as Error).message}`);
          return null;
        });
        if (id) started++;
      }
    }
  }
  return started;
}
