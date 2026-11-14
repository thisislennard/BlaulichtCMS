import { config } from '../config.js';
import { one } from '../db/pool.js';
import { schemaCompatibility } from '../db/migrate.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { freeBytes } from '../media/storage.js';

/**
 * Update-Vorabprüfung (Ablauf: Sichern → Wechseln → Prüfen → Wiederherstellen).
 * Bereit ist LifeLink erst, wenn der Wartungsmodus aktiv ist, keine Aufträge mehr laufen, kein Versand und keine
 * Veröffentlichung in der Schwebe ist und genug Speicher für die Sicherung frei ist.
 */
export async function updatePreflight() {
  const s = await getSettings(true);
  const checks: { id: string; label: string; ok: boolean; detail: string; blocking: boolean }[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string, blocking = true) => checks.push({ id, label, ok, detail, blocking });

  const m = s['system.maintenance'];
  add('maintenance', 'Wartungsmodus aktiv (schreibende Vorgänge angehalten)', !!m, m ? `seit ${new Date(m.since).toLocaleString('de-DE', { timeZone: s['general.timezone'] })} (${m.byName}): ${m.reason}` : 'nicht aktiv');

  const running = (await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`))!.n;
  add('jobs', 'Keine laufenden Hintergrundaufträge', running === 0, running ? `${running} laufen noch` : 'keine');

  const pubs = (await one<any>(`SELECT count(*)::int AS n FROM publications WHERE status = 'sent'`))!.n;
  add('publications', 'Keine Website-Veröffentlichung in Übertragung', pubs === 0, pubs ? `${pubs} abgeholt, Rückmeldung ausstehend` : 'keine');

  const social = (await one<any>(`SELECT count(*)::int AS n FROM social_publications WHERE status = 'publishing'`))!.n;
  add('social', 'Keine Veröffentlichung auf sozialen Kanälen in Arbeit', social === 0, social ? `${social} in Arbeit` : 'keine');

  const sends = (await one<any>(`SELECT count(*)::int AS n FROM warning_sends WHERE status IN ('queued','sending')`))!.n;
  add('warnings', 'Kein Warnversand in Arbeit', sends === 0, sends ? `${sends} in Arbeit` : 'keine');

  const unknown = (await one<any>(`SELECT (SELECT count(*) FROM publications WHERE status = 'unknown') + (SELECT count(*) FROM social_publications WHERE status = 'unknown') + (SELECT count(*) FROM warning_sends WHERE status = 'unknown' AND resolution IS NULL) AS n`))!.n;
  add('unknown', 'Keine ungeklärten Ergebnisse', Number(unknown) === 0, Number(unknown) ? `${unknown} ungeklärt – vor dem Update prüfen` : 'keine', false);

  const db = Number((await one<any>(`SELECT pg_database_size(current_database()) AS b`))!.b);
  const media = Number((await one<any>(`SELECT COALESCE(sum(size_bytes),0) AS b FROM media WHERE deleted_at IS NULL`))!.b);
  const need = Math.round((db + media * 2) * 1.2) + 512 * 1024 ** 2; // Original + öffentliche Fassung, Reserve
  const free = freeBytes();
  add('storage', 'Genug freier Speicher im Volume', free === null || free > need, free === null ? 'unbekannt' : `${(free / 1024 ** 3).toFixed(1)} GB frei, Datenbestand ca. ${((db + media * 2) / 1024 ** 3).toFixed(1)} GB (Sicherung außerhalb des Volumes empfohlen)`);

  const last = await one<any>(`SELECT finished_at FROM backups WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1`);
  const age = last ? (Date.now() - new Date(last.finished_at).getTime()) / 3600_000 : null;
  add('backup', 'Aktuelle Datenbanksicherung (unter 26 Stunden)', age !== null && age < 26, last ? `letzte vor ${age!.toFixed(1)} h` : 'keine vorhanden', false);

  const compat = await schemaCompatibility();
  add('schema', 'Schema passt zum laufenden Programm', !compat.pending.length && !compat.unknown.length, `${compat.applied.length} Migrationen angewendet${compat.pending.length ? `, ${compat.pending.length} ausstehend` : ''}${compat.unknown.length ? `, ${compat.unknown.length} unbekannt` : ''}`);

  const pg = (await one<any>(`SHOW server_version`))!.server_version;
  return {
    ready: checks.filter((c) => c.blocking).every((c) => c.ok),
    version: config.version,
    postgres: pg,
    migrations: compat.applied.length,
    checks,
  };
}

export async function setMaintenance(enabled: boolean, byName: string, reason: string, userId: string | null) {
  await setSettings({ 'system.maintenance': enabled ? { since: new Date().toISOString(), byName, reason } : null }, userId);
}
