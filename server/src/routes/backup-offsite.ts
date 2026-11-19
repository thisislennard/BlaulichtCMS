import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, tx } from '../db/pool.js';
import { assertRecentAuth, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { StepError } from '../lib/errors.js';
import { normalizeFingerprint } from '../lib/http.js';
import { readSecret, revokeSecret, storeSecret } from '../lib/secrets.js';
import { DrillRunningError, recentDrills, scheduleDrill } from '../ops/drill.js';
import {
  addLeftover,
  DOCUMENTED_RETENTION_DAYS,
  fetchRemoteBackup,
  KEEP_LIMITS,
  listRemote,
  listRemoteVolumes,
  normalizeDavUrl,
  OFFSITE_SECRET_OWNER,
  offsiteConfig,
  purgeTarget,
  removeLeftover,
  retentionDays,
  retentionLabel,
  scheduleUpload,
  targetFromConfig,
  targetHost,
  testTarget,
  type OffsiteRow,
  type OffsiteTarget,
} from '../ops/offsite.js';
import { checkSmbAccount, parseUnc } from '../ops/smb.js';
import { plural } from '../lib/text.js';

/**
 * Sicherung außer Haus und Probe-Wiederherstellung (#212) – Einstellungen → Sicherung.
 * Alles unter dem Recht „Sicherungen erstellen“ (backup.manage); das Ziel ändern verlangt zusätzlich eine frische
 * Passwortbestätigung, weil dorthin der gesamte (verschlüsselte) Datenbestand geht.
 */

const view = (c: OffsiteRow) => ({
  enabled: c.enabled,
  kind: c.kind,
  url: c.url,
  domain: c.domain ?? '',
  username: c.username,
  password_set: !!c.secret_id,
  tls_fingerprint: c.tls_fingerprint,
  keep_daily: c.keep_daily,
  keep_weekly: c.keep_weekly,
  keep_monthly: c.keep_monthly,
  drill_interval: c.drill_interval,
  tested_at: c.tested_at,
  last_ok_at: c.last_ok_at,
  last_ok_file: c.last_ok_file,
  last_error: c.last_error,
  last_error_at: c.last_error_at,
  leftovers: c.leftovers ?? [],
});

const targetInput = z.object({
  /** SMB-Freigabe (UNC-Pfad, smbclient) oder WebDAV (https) */
  kind: z.enum(['webdav', 'smb']).default('webdav'),
  url: z.string().trim().max(500),
  /** nur SMB: Domäne des Kontos */
  domain: z.string().trim().max(100).default(''),
  username: z.string().trim().max(200).default(''),
  /** leer/fehlend = gespeichertes Passwort behalten */
  password: z.string().max(500).optional(),
  fingerprint: z.string().trim().max(200).default(''),
});

const configInput = targetInput.extend({
  enabled: z.boolean(),
  keepDaily: z.number().int().min(KEEP_LIMITS.daily[0]).max(KEEP_LIMITS.daily[1]),
  keepWeekly: z.number().int().min(KEEP_LIMITS.weekly[0]).max(KEEP_LIMITS.weekly[1]),
  keepMonthly: z.number().int().min(KEEP_LIMITS.monthly[0]).max(KEEP_LIMITS.monthly[1]),
  drillInterval: z.enum(['off', 'weekly', 'monthly']),
  /** Aufbewahrung über der dokumentierten Frist bewusst bestätigt (#246) */
  acknowledgeRetention: z.boolean().optional(),
  /** Ausschalten bzw. anderes Ziel: Sicherungen auf dem bisherigen Ziel löschen oder (Standard) behalten (#246) */
  oldTarget: z.enum(['keep', 'delete']).optional(),
});

function cleanFingerprint(v: string): string {
  if (!v) return '';
  const f = normalizeFingerprint(v);
  if (f.length !== 95) throw badRequest('Der Fingerabdruck muss ein SHA-256-Wert sein (64 Hex-Zeichen, z. B. AB:CD:…).');
  return f;
}

/**
 * Ziel aus der Eingabe bilden. Das gespeicherte Passwort wird nur für dieselbe Art, denselben Host und dasselbe Konto
 * weiterverwendet – sonst könnte jemand mit „Sicherungen erstellen“ es an einen eigenen Server schicken lassen, ohne
 * es zu kennen.
 */
async function targetFrom(b: z.infer<typeof targetInput>, c: OffsiteRow): Promise<OffsiteTarget> {
  let base: { kind: 'smb'; url: string; server: string; share: string; dir: string[] } | { kind: 'webdav'; url: string };
  try {
    if (b.kind === 'smb') {
      base = { kind: 'smb', ...parseUnc(b.url) };
      checkSmbAccount(b.domain, b.username);
    } else base = { kind: 'webdav', url: normalizeDavUrl(b.url) };
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const domain = b.kind === 'smb' ? b.domain : '';
  let password = b.password ?? '';
  if (!password) {
    const sameTarget = !!c.url && c.kind === b.kind && targetHost(c.kind, c.url).toLowerCase() === targetHost(b.kind, base.url).toLowerCase() && c.username === b.username && (c.domain ?? '') === domain;
    if (c.secret_id && !sameTarget) throw badRequest('Für ein anderes Ziel oder einen anderen Benutzer bitte das Passwort neu eingeben.');
    password = (await readSecret(c.secret_id)) ?? '';
  }
  if (base.kind === 'smb') return { ...base, domain, username: b.username, password };
  return { ...base, username: b.username, password, fingerprint: cleanFingerprint(b.fingerprint) };
}

const domainOf = (t: OffsiteTarget) => (t.kind === 'smb' ? t.domain : '');
const fingerprintOf = (t: OffsiteTarget) => (t.kind === 'webdav' ? t.fingerprint : '');

/** Änderung am Ziel (Art, Adresse, Konto, Passwort, Zertifikat) oder Einschalten: frische Passwortbestätigung nötig. */
function targetChanged(b: z.infer<typeof configInput>, t: OffsiteTarget, c: OffsiteRow) {
  return (
    (b.enabled && !c.enabled) ||
    t.kind !== c.kind ||
    t.url !== c.url ||
    t.username !== c.username ||
    domainOf(t) !== (c.domain ?? '') ||
    !!b.password ||
    fingerprintOf(t) !== c.tls_fingerprint
  );
}

/** Noch kein Ziel eingetragen (nur Aufbewahrung bzw. Probe speichern). */
function emptyTarget(b: z.infer<typeof configInput>): OffsiteTarget {
  return b.kind === 'smb'
    ? { kind: 'smb', url: '', server: '', share: '', dir: [], domain: b.domain, username: b.username, password: '' }
    : { kind: 'webdav', url: '', username: b.username, password: '', fingerprint: cleanFingerprint(b.fingerprint) };
}

const stepMessage = (e: unknown) => (e instanceof StepError ? { message: e.message, hint: e.hint } : { message: (e as Error).message });

export async function backupOffsiteRoutes(app: FastifyInstance) {
  app.get('/backups/offsite', { preHandler: requireAuth('backup.manage') }, async () => {
    const c = await offsiteConfig();
    const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM backups WHERE offsite_status = 'pending'`);
    return { config: view(c), pending: pending?.n ?? 0 };
  });

  app.post('/backups/offsite/test', { preHandler: requireAuth('backup.manage'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = targetInput.parse(req.body);
    const c = await offsiteConfig();
    const t = await targetFrom(b, c);
    const r = await testTarget(t);
    await audit(req.auth!.actor, 'backup.offsite_tested', { type: 'backup', label: targetHost(t.kind, t.url) }, { art: t.kind === 'smb' ? 'SMB' : 'WebDAV', ergebnis: r.ok ? 'ok' : r.error ?? 'fehler' }, r.ok ? 'ok' : 'failed');
    return r;
  });

  app.put('/backups/offsite', { preHandler: requireAuth('backup.manage') }, async (req) => {
    const b = configInput.parse(req.body);
    const c = await offsiteConfig();
    if (!b.url && b.enabled) throw badRequest('Bitte zuerst die Adresse des Ziels eintragen.');
    const t = b.url ? await targetFrom(b, c) : emptyTarget(b);
    if (targetChanged(b, t, c)) assertRecentAuth(req);
    // Aufbewahrung über der dokumentierten Frist (#246): nur mit ausdrücklicher Bestätigung (Art. 5 Abs. 1 lit. e DSGVO)
    const keep = { daily: b.keepDaily, weekly: b.keepWeekly, monthly: b.keepMonthly };
    const keepChanged = keep.daily !== c.keep_daily || keep.weekly !== c.keep_weekly || keep.monthly !== c.keep_monthly;
    const days = retentionDays(keep);
    if (keepChanged && days > DOCUMENTED_RETENTION_DAYS && !b.acknowledgeRetention) {
      throw new AppError(400, 'offsite_retention_confirm', `Mit dieser Aufbewahrung bleiben gelöschte Daten bis zu ${retentionLabel(days)} auf dem Ziel – länger als die in den Datenschutzhinweisen genannten rund 4 Monate. Bitte bestätigen und die Frist im Verzeichnis der Verarbeitungstätigkeiten anpassen.`, { days });
    }
    // Einschalten bzw. geändertes Ziel nur nach bestandenem Verbindungstest mit genau diesen Angaben
    let tested = false;
    if (b.enabled && t.url && targetChanged(b, t, c)) {
      const r = await testTarget(t);
      if (!r.ok) throw new AppError(400, 'offsite_test_failed', `Verbindungstest fehlgeschlagen: ${r.error ?? 'unbekannter Fehler'}`, { test: r });
      tested = true;
    }
    // Ausschalten oder anderes Ziel (#246): Sicherungen auf dem bisherigen Ziel löschen (vor dem Speichern, mit den
    // bisherigen Zugangsdaten) oder als „frühere Sicherungen“ vormerken – sonst lägen sie unbegrenzt dort
    const leaving = !!c.url && (t.kind !== c.kind || t.url !== c.url || (c.enabled && !b.enabled));
    let purged: number | null = null;
    if (leaving && b.oldTarget === 'delete') {
      assertRecentAuth(req);
      try {
        const r = await purgeTarget(await targetFromConfig(c));
        if (r.failed.length) throw new Error(`${plural(r.failed.length, 'Datei', 'Dateien')} ließen sich nicht löschen`);
        purged = r.removed;
      } catch (e) {
        await audit(req.auth!.actor, 'backup.offsite_purged', { type: 'backup', label: targetHost(c.kind, c.url) }, { fehler: stepMessage(e).message.slice(0, 300) }, 'failed');
        throw new AppError(502, 'offsite_cleanup_failed', `Sicherungen auf dem bisherigen Ziel ließen sich nicht löschen: ${stepMessage(e).message} – nichts gespeichert. Zum Speichern „Behalten“ wählen und die Dateien später entfernen.`);
      }
    }
    await tx(async (db) => {
      let secretId = c.secret_id;
      if (b.password) {
        const sec = await storeSecret('setting', OFFSITE_SECRET_OWNER, b.password, req.auth!.user?.id ?? null, db);
        if (c.secret_id) await revokeSecret(c.secret_id, db);
        secretId = sec.id;
      }
      await db.query(
        `UPDATE backup_offsite SET enabled = $1, url = $2, username = $3, secret_id = $4, tls_fingerprint = $5, keep_daily = $6, keep_weekly = $7,
                keep_monthly = $8, drill_interval = $9, tested_at = CASE WHEN $10 THEN now() ELSE tested_at END,
                last_error = CASE WHEN $11 THEN NULL ELSE last_error END,
                last_ok_at = CASE WHEN $11 THEN NULL ELSE last_ok_at END, last_ok_file = CASE WHEN $11 THEN NULL ELSE last_ok_file END,
                updated_at = now(), updated_by = $12, kind = $13, domain = $14 WHERE id = 1`,
        [b.enabled && !!t.url, t.url, t.username, secretId, fingerprintOf(t), b.keepDaily, b.keepWeekly, b.keepMonthly, b.drillInterval, tested, t.url !== c.url || t.kind !== c.kind, req.auth!.user?.id ?? null, t.kind, domainOf(t)],
      );
    });
    if (leaving) {
      if (purged !== null) await removeLeftover(c.url);
      else if (c.last_ok_at) await addLeftover(c.url);
    }
    // Wieder auf ein früheres Ziel umgestellt: dort greift die Aufbewahrung wieder
    if (b.enabled && t.url) await removeLeftover(t.url);
    const changes: Record<string, unknown> = {};
    if (b.enabled !== c.enabled) changes.eingeschaltet = b.enabled;
    if (t.kind !== c.kind) changes.art = t.kind === 'smb' ? 'SMB-Freigabe' : 'WebDAV';
    if (t.url !== c.url) changes.ziel = { vorher: c.url || null, nachher: t.url || null };
    if (domainOf(t) !== (c.domain ?? '')) changes.domaene = domainOf(t) || null;
    if (t.username !== c.username) changes.benutzer = t.username;
    if (b.password) changes.passwort = 'neu gesetzt';
    if (fingerprintOf(t) !== c.tls_fingerprint) changes.zertifikat = fingerprintOf(t) ? `Fingerabdruck ${fingerprintOf(t).slice(0, 23)}…` : 'normale Prüfung';
    if (keepChanged) changes.aufbewahrung = `${b.keepDaily}/${b.keepWeekly}/${b.keepMonthly} (bis ${retentionLabel(days)}${days > DOCUMENTED_RETENTION_DAYS ? ', über der dokumentierten Frist bestätigt' : ''})`;
    if (leaving) changes.bisheriges_ziel = purged !== null ? `${purged} Sicherung(en) gelöscht` : c.last_ok_at ? 'Sicherungen behalten (Hinweis im Systemstatus)' : 'nichts übertragen';
    if (b.drillInterval !== c.drill_interval) changes.probe = b.drillInterval;
    await audit(req.auth!.actor, 'backup.offsite_changed', { type: 'backup', label: 'Sicherung außer Haus' }, changes);
    return { ok: true, config: view(await offsiteConfig()) };
  });

  /**
   * Sicherungen auf dem eingetragenen, ausgeschalteten Ziel löschen (#246) – z. B. nach „Ausschalten, Sicherungen
   * behalten“. Löscht nur Dateien mit dem Namensmuster von BlaulichtCMS; verlangt eine frische Passwortbestätigung.
   */
  app.post('/backups/offsite/purge', { preHandler: requireAuth('backup.manage'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const c = await offsiteConfig();
    if (!c.url) throw badRequest('Kein Ziel eingetragen.');
    if (c.enabled) throw badRequest('Die Sicherung außer Haus ist eingeschaltet – erst ausschalten, dann die Sicherungen auf dem Ziel löschen.');
    assertRecentAuth(req);
    const host = targetHost(c.kind, c.url);
    try {
      const r = await purgeTarget(await targetFromConfig(c));
      if (!r.failed.length) await removeLeftover(c.url);
      await audit(req.auth!.actor, 'backup.offsite_purged', { type: 'backup', label: host }, { geloescht: r.removed, fehlgeschlagen: r.failed.length }, r.failed.length ? 'failed' : 'ok');
      return { removed: r.removed, failed: r.failed.length, config: view(await offsiteConfig()) };
    } catch (e) {
      const m = stepMessage(e);
      await audit(req.auth!.actor, 'backup.offsite_purged', { type: 'backup', label: host }, { fehler: m.message.slice(0, 300) }, 'failed');
      throw new AppError(502, 'offsite_unreachable', m.message, m.hint ? { hint: m.hint } : undefined);
    }
  });

  /** Hinweis auf ein früheres Ziel entfernen – die Dateien dort wurden anders entfernt (z. B. am NAS von Hand). */
  app.post('/backups/offsite/leftovers/dismiss', { preHandler: requireAuth('backup.manage') }, async (req) => {
    const { url } = z.object({ url: z.string().max(500) }).parse(req.body);
    if (!(await removeLeftover(url))) throw notFound('Kein solcher Hinweis.');
    await audit(req.auth!.actor, 'backup.offsite_leftover_dismissed', { type: 'backup', label: url.slice(0, 200) });
    return { ok: true, config: view(await offsiteConfig()) };
  });

  app.get('/backups/offsite/files', { preHandler: requireAuth('backup.manage'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => {
    const c = await offsiteConfig();
    if (!c.url) return { files: [], volumes: [] };
    try {
      const t = await targetFromConfig(c);
      return { files: await listRemote(t), volumes: await listRemoteVolumes(t) };
    } catch (e) {
      const m = stepMessage(e);
      throw new AppError(502, 'offsite_unreachable', m.message, m.hint ? { hint: m.hint } : undefined);
    }
  });

  /** Sicherung vom Ziel auf diesen Server holen (Notfall-Wiederherstellung, Schritt 1). */
  app.post('/backups/offsite/fetch', { preHandler: requireAuth('backup.manage'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { name } = z.object({ name: z.string().max(200) }).parse(req.body);
    try {
      const r = await fetchRemoteBackup(name, req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'backup.offsite_fetched', { type: 'backup', id: r.id, label: name });
      return r;
    } catch (e) {
      await audit(req.auth!.actor, 'backup.offsite_fetched', { type: 'backup', label: name }, { fehler: (e as Error).message.slice(0, 300) }, 'failed');
      if (e instanceof StepError && e.errorClass === 'conflict') throw conflict(e.message);
      throw badRequest(stepMessage(e).message);
    }
  });

  /** Übertragung einer Sicherung erneut anstoßen (z. B. nach einem behobenen Fehler am NAS). */
  app.post('/backups/:id/offsite', { preHandler: requireAuth('backup.manage') }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = await one<{ file_name: string }>(`SELECT file_name FROM backups WHERE id = $1 AND status = 'ok'`, [id]);
    if (!b) throw notFound('Sicherung nicht gefunden.');
    if (!(await scheduleUpload(id))) throw badRequest('Die Sicherung außer Haus ist nicht eingeschaltet.');
    await audit(req.auth!.actor, 'backup.offsite_requested', { type: 'backup', id, label: b.file_name });
    return { ok: true };
  });

  app.get('/backups/drills', { preHandler: requireAuth('backup.manage') }, async () => recentDrills(20));

  app.post('/backups/drills', { preHandler: requireAuth('backup.manage'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req: FastifyRequest) => {
    const b = z.object({ source: z.enum(['local', 'offsite']).optional(), fileName: z.string().max(200).optional() }).parse(req.body ?? {});
    try {
      const r = await scheduleDrill('manual', req.auth!.user?.id ?? null, b);
      await audit(req.auth!.actor, 'backup.drill_started', { type: 'backup', id: r.id, label: r.fileName }, { quelle: r.source === 'offsite' ? 'außer Haus' : 'lokal' });
      return r;
    } catch (e) {
      if (e instanceof DrillRunningError) throw conflict(e.message);
      throw badRequest((e as Error).message);
    }
  });
}

/** Kurzstatus für Systemstatus und Dashboard. */
export async function backupHealth() {
  const c = await offsiteConfig();
  const drill = await one<any>(`SELECT id, source, file_name, trigger, status, created_at, finished_at, error, result->'durationMs' AS duration_ms FROM restore_drills ORDER BY created_at DESC LIMIT 1`);
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM backups WHERE offsite_status = 'pending'`);
  return {
    offsite: { enabled: c.enabled, last_ok_at: c.last_ok_at, last_ok_file: c.last_ok_file, last_error: c.last_error, last_error_at: c.last_error_at, pending: pending?.n ?? 0, leftovers: c.leftovers ?? [] },
    drill,
    drill_interval: c.drill_interval,
  };
}
