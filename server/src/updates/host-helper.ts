import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { securityAlert } from '../lib/security-alerts.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { compareVersions, parseVersion, UpdateError } from './core.js';
import { plural } from '../lib/text.js';

/**
 * Image-Updates aus der App über den Host-Helfer (#226, scripts/host-update-helper.sh). Der Container bekommt dafür
 * keinerlei zusätzliche Rechte: Ausgetauscht wird nur über Dateien im Datenvolume, Ordner `<data>/host-update/`:
 *
 *   helper.json   legt der Helfer bei der Einrichtung an (install.sh) – „Helfer vorhanden“
 *   request.json  schreibt die App: nur Version, Zeitpunkt, Kennungen (eine Zeile, festes Schema, keine Befehle)
 *   status.json   schreibt der Helfer: Phase, Schritt, Ergebnis, Protokollauszug
 *
 * Der Helfer prüft die Anfrage selbst noch einmal streng (Schema, Alter, Rate-Limit, neuestes signiertes Release,
 * nie Downgrade); die Version aus der Anfrage ist für ihn nur eine Erwartung. Alles, was hier gelesen wird, kommt aus
 * einem Ordner, in den auch der Host schreibt – deshalb Größengrenzen und Schemaprüfung auch beim Lesen.
 */

export const HOST_DIR = 'host-update';
/** Zwischen zwei Anfragen aus der App (der Helfer erzwingt dasselbe Intervall noch einmal selbst). */
export const HOST_REQUEST_INTERVAL_MS = 10 * 60_000;
/** So lange darf eine Anfrage liegen, bis die App „Helfer reagiert nicht“ anzeigt (der Helfer startet sofort). */
export const HOST_PICKUP_MS = 2 * 60_000;
/** Meldet ein laufender Helfer sich so lange nicht (er schreibt alle 30 s), gilt der Lauf als hängend. */
export const HOST_SILENT_MS = 10 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

export type HostState = 'running' | 'success' | 'failed' | 'rolled_back' | 'aborted' | 'rejected';
export type HostPhase = 'verify' | 'prepare' | 'build' | 'backup' | 'switch' | 'check' | 'rollback' | 'finish' | 'done';
const STATES: HostState[] = ['running', 'success', 'failed', 'rolled_back', 'aborted', 'rejected'];
const PHASES: HostPhase[] = ['verify', 'prepare', 'build', 'backup', 'switch', 'check', 'rollback', 'finish', 'done'];

export interface HostHelperInfo {
  helperVersion: number;
  installedAt: string | null;
}
export interface HostRequest {
  v: 1;
  id: string;
  version: string;
  requestedAt: string;
  userId: string;
}
export interface HostStatus {
  requestId: string | null;
  userId: string | null;
  state: HostState;
  phase: HostPhase;
  step: string;
  targetVersion: string | null;
  fromVersion: string | null;
  image: string;
  backupFile: string;
  message: string;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  logTail: string;
}

export const hostDir = (dataDir = config.dataDir) => path.join(dataDir, HOST_DIR);

/** Liest eine kleine reguläre Datei (keine symbolischen Links, keine Geräte), höchstens maxBytes. Sonst null. */
function readSmall(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : '');
const iso = (v: unknown): string | null => (typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const ver = (v: unknown): string | null => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);

export function parseHelperInfo(text: string | null): HostHelperInfo | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || j.v !== 1 || !Number.isInteger(j.helperVersion) || j.helperVersion < 1) return null;
    return { helperVersion: j.helperVersion, installedAt: iso(j.installedAt) };
  } catch {
    return null;
  }
}

/** Statusdatei des Helfers prüfen und normalisieren; alles Unbekannte verwerfen. Ungültig → null. */
export function parseHostStatus(text: string | null): HostStatus | null {
  if (!text) return null;
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || j.v !== 1 || !STATES.includes(j.state) || !PHASES.includes(j.phase)) return null;
  return {
    requestId: typeof j.requestId === 'string' && UUID_RE.test(j.requestId) ? j.requestId : null,
    userId: typeof j.userId === 'string' && UUID_RE.test(j.userId) ? j.userId : null,
    state: j.state,
    phase: j.phase,
    step: str(j.step, 300),
    targetVersion: ver(j.targetVersion),
    fromVersion: ver(j.fromVersion),
    image: str(j.image, 200),
    backupFile: str(j.backupFile, 200),
    message: str(j.message, 1000),
    startedAt: iso(j.startedAt),
    updatedAt: iso(j.updatedAt),
    finishedAt: iso(j.finishedAt),
    // Auszug vom Ende her begrenzen (die letzten Zeilen sind die wichtigen)
    logTail: str(typeof j.logTail === 'string' ? j.logTail.slice(-12_000) : '', 12_000),
  };
}

/** Anfrage-Zeile, wie sie der Helfer erwartet (dessen Regex: genau diese Schlüssel in genau dieser Reihenfolge). */
export function hostRequestLine(r: HostRequest): string {
  if (!UUID_RE.test(r.id) || !VERSION_RE.test(r.version) || !ISO_RE.test(r.requestedAt) || (r.userId !== '' && !UUID_RE.test(r.userId))) throw new UpdateError('Ungültige Anfrage.');
  return `${JSON.stringify({ v: 1, id: r.id, version: r.version, requestedAt: r.requestedAt, userId: r.userId })}\n`;
}

export function parseHostRequest(text: string | null): HostRequest | null {
  if (!text || text.length > 1024) return null;
  try {
    const j = JSON.parse(text);
    const line = hostRequestLine({ v: 1, id: j.id, version: j.version, requestedAt: j.requestedAt, userId: j.userId ?? '' });
    return line.trim() === text.trim() ? { v: 1, id: j.id, version: j.version, requestedAt: j.requestedAt, userId: j.userId } : null;
  } catch {
    return null;
  }
}

export interface HostHelperView {
  installed: boolean;
  helperVersion: number | null;
  installedAt: string | null;
  request: (HostRequest & { stale: boolean }) | null;
  status: (HostStatus & { silent: boolean }) | null;
  /** Läuft gerade etwas (Anfrage liegt oder Helfer meldet „running“)? */
  busy: boolean;
  /** Frühester Zeitpunkt für die nächste Anfrage (Rate-Limit), sonst null. */
  nextRequestAt: string | null;
}

export async function hostHelperView(now = Date.now(), dataDir = config.dataDir): Promise<HostHelperView> {
  const dir = hostDir(dataDir);
  const info = parseHelperInfo(readSmall(path.join(dir, 'helper.json'), 4096));
  const req = parseHostRequest(readSmall(path.join(dir, 'request.json'), 1024));
  const st = parseHostStatus(readSmall(path.join(dir, 'status.json'), 64 * 1024));
  const request = req ? { ...req, stale: now - Date.parse(req.requestedAt) > HOST_PICKUP_MS } : null;
  const status = st ? { ...st, silent: st.state === 'running' && (!st.updatedAt || now - Date.parse(st.updatedAt) > HOST_SILENT_MS) } : null;
  const last = (await getSettings(true))['updates.host_requested_at'];
  const next = last ? Date.parse(last) + HOST_REQUEST_INTERVAL_MS : 0;
  return {
    installed: !!info,
    helperVersion: info?.helperVersion ?? null,
    installedAt: info?.installedAt ?? null,
    request,
    status,
    busy: (!!request && !request.stale) || (status?.state === 'running' && !status.silent),
    nextRequestAt: next > now ? new Date(next).toISOString() : null,
  };
}

/** Atomar schreiben (eigene temporäre Datei, dann umbenennen) – der Helfer sieht nie eine halbe Anfrage. */
function writeAtomic(file: string, data: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, data, { mode: 0o644, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/**
 * Image-Update beim Host-Helfer anfragen. Prüft: Helfer vorhanden, nichts läuft, Rate-Limit, Version ist das zuletzt
 * geprüfte Release, neuer als die laufende Version und braucht ein neueres Image. Liefert die Anfrage.
 */
export async function requestHostUpdate(opts: { version: string; userId: string | null; latestVersion: string | null; imageUpdateNeeded: boolean; now?: number }): Promise<HostRequest> {
  const now = opts.now ?? Date.now();
  const view = await hostHelperView(now);
  if (!view.installed) throw new UpdateError('Der Update-Helfer ist am Host nicht eingerichtet. Einrichten: am Host sudo bash /opt/apps/blaulichtcms/install.sh ausführen und die Frage nach dem Update-Helfer bejahen.');
  if (view.busy) throw new UpdateError('Es läuft bereits ein Image-Update über den Update-Helfer.');
  if (view.nextRequestAt) throw new UpdateError(`Höchstens eine Anfrage je 10 Minuten – wieder möglich in ${plural(Math.max(1, Math.ceil((Date.parse(view.nextRequestAt) - now) / 60_000)), 'Minute', 'Minuten')}.`);
  if (!parseVersion(opts.version) || !VERSION_RE.test(opts.version)) throw new UpdateError('Ungültige Version.');
  if (!opts.latestVersion || opts.latestVersion !== opts.version) throw new UpdateError('Das neueste Release hat sich geändert. Bitte erneut prüfen.');
  if (compareVersions(opts.version, config.version) <= 0) throw new UpdateError(`Version ${opts.version} ist nicht neuer als die laufende Version ${config.version}. Ein Downgrade ist nicht möglich.`);
  if (!opts.imageUpdateNeeded) throw new UpdateError('Dieses Update braucht kein neues Image – bitte direkt in der App installieren.');
  const dir = hostDir();
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw new UpdateError(`${dir} ist kein Ordner.`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const req: HostRequest = { v: 1, id: crypto.randomUUID(), version: opts.version, requestedAt: new Date(now).toISOString(), userId: opts.userId ?? '' };
  const line = hostRequestLine(req);
  await setSettings({ 'updates.host_requested_at': req.requestedAt }, opts.userId);
  writeAtomic(path.join(dir, 'request.json'), line);
  return req;
}

/** Noch nicht angenommene Anfrage zurückziehen (z. B. Helfer reagiert nicht). */
export function cancelHostRequest(): { removed: boolean; request: HostRequest | null } {
  const file = path.join(hostDir(), 'request.json');
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { removed: false, request: null };
  const request = parseHostRequest(readSmall(file, 1024));
  fs.rmSync(file, { force: true });
  return { removed: true, request };
}

const HISTORY_STATUS: Record<Exclude<HostState, 'running'>, 'activated' | 'rolled_back' | 'failed'> = {
  success: 'activated',
  rolled_back: 'rolled_back',
  failed: 'failed',
  aborted: 'failed',
  rejected: 'failed',
};

/**
 * Abgeschlossenen Helfer-Lauf einmalig ins Update-Protokoll und Audit übernehmen und die Verwaltung benachrichtigen
 * (Worker, regelmäßig). Merkt sich die Kennung der Anfrage, damit nichts doppelt gemeldet wird.
 */
export async function recordHostResult(dataDir = config.dataDir): Promise<{ state: HostState; requestId: string } | null> {
  const st = parseHostStatus(readSmall(path.join(hostDir(dataDir), 'status.json'), 64 * 1024));
  if (!st || st.state === 'running' || !st.requestId) return null;
  if ((await getSettings(true))['updates.host_recorded_request'] === st.requestId) return null;
  // Zuerst merken (kein doppelter Eintrag, falls API und Worker gleichzeitig prüfen) – nur der Erste trägt ein
  const claimed = await one<{ key: string }>(
    `INSERT INTO settings (key, value, updated_at) VALUES ('updates.host_recorded_request', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value IS DISTINCT FROM EXCLUDED.value RETURNING key`,
    [JSON.stringify(st.requestId)],
  );
  await setSettings({});
  if (!claimed) return null;
  const status = HISTORY_STATUS[st.state];
  const to = st.targetVersion ?? '?';
  const from = st.fromVersion ?? config.version;
  const message = `Image-Update über den Update-Helfer: ${st.message || st.state}`.slice(0, 2000);
  const actor: Actor = { ...SYSTEM_ACTOR, name: 'Update-Helfer' };
  try {
    await pool.query(
      `INSERT INTO update_history (at, from_version, to_version, status, message, backup_file, restored, actor_id, actor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT id FROM users WHERE id = $8::uuid),$9)`,
      [st.finishedAt ?? new Date().toISOString(), from, to, status, message, st.backupFile || null, st.state === 'rolled_back', st.userId, 'Update-Helfer (Host)'],
    );
    await audit(actor, `update.host_${st.state}`, { type: 'update', label: to }, { von: from, ergebnis: st.state, meldung: st.message.slice(0, 500), anfrage: st.requestId, sicherung: st.backupFile || null }, st.state === 'success' ? 'ok' : 'failed');
    if (st.state === 'success') {
      await notify({ kind: 'success', title: `Image-Update auf Version ${to} abgeschlossen`, body: `Vorher: ${from}. ${st.message}`.trim().slice(0, 900), link: '/einstellungen#updates', permission: 'update.install' });
    } else if (st.state === 'rolled_back' || st.state === 'failed') {
      await securityAlert('update_rolled_back', {
        kind: 'error',
        title: st.state === 'rolled_back' ? `Image-Update auf Version ${to} zurückgenommen` : `Image-Update auf Version ${to} fehlgeschlagen`,
        body: st.message.slice(0, 900),
        link: '/einstellungen#updates',
      });
    } else {
      await notify({ kind: 'warning', title: st.state === 'rejected' ? 'Image-Update vom Update-Helfer abgelehnt' : `Image-Update auf Version ${to} abgebrochen`, body: st.message.slice(0, 900), link: '/einstellungen#updates', permission: 'update.install' });
    }
    log(st.state === 'success' ? 'info' : 'warn', 'updates', `Update-Helfer: ${st.state} (${from} → ${to}) ${st.message}`);
  } catch (e) {
    log('error', 'updates', `Ergebnis des Update-Helfers nicht übernommen: ${(e as Error).message}`);
  }
  return { state: st.state, requestId: st.requestId };
}
