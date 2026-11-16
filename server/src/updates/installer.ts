import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { APP_ROOT, config } from '../config.js';
import { many, one, pool } from '../db/pool.js';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { securityAlert } from '../lib/security-alerts.js';
import { getSettings } from '../lib/settings.js';
import { runBackup } from '../ops/backup.js';
import { setMaintenance, updatePreflight } from '../ops/update.js';
import { checkZipEntries, compareRuntimeDependencies, compareVersions, compatibilityProblem, IMAGE_UPDATE_HINT, parseManifest, sha256File, UpdateError, zipEntryInfos, type ImageInfo } from './core.js';
import { downloadRelease, fetchLatestRelease } from './github.js';
import { cleanupReleases, readActivation, readPointer, releasesDir, writeActivation, writePending, type PendingActivation } from './releases.js';
import { verifyDigestSignature } from './signing.js';

/**
 * Installation eines signierten Releases aus GitHub (Ablauf in docs/architektur.md, „In-App-Updates“):
 *
 *  1. Release holen, ZIP/.sha256/.sig laden, Prüfsumme und Ed25519-Signatur gegen den Schlüssel der LAUFENDEN Version
 *  2. Paket prüfen (Pfade, Pflichtdateien, Version neuer als die laufende, Manifest passt zum Image)
 *  3. Wartungsmodus an, Update-Vorabprüfung muss bestehen, Datenbanksicherung (wird vermerkt)
 *  4. nach <data>/releases/.staging-* entpacken, node_modules vom laufenden Code übernehmen (nur bei gleichen
 *     Laufzeit-Abhängigkeiten – im Image gibt es kein npm), Rauchtest `cli.js self-check --release`
 *  5. Ordner nach <data>/releases/<version> verschieben, Umschaltauftrag an den Supervisor
 *
 * Der Supervisor stoppt API und Worker, migriert mit der neuen Version, startet sie und rollt bei jedem Fehler zurück
 * (Zeiger zurück, Sicherung zurückspielen, falls Migrationen liefen). Bis Schritt 5 bleibt der laufende Code unberührt.
 */
export type InstallPhase = 'idle' | 'download' | 'verify' | 'preflight' | 'backup' | 'extract' | 'dependencies' | 'selfcheck' | 'activating' | 'failed';

export interface InstallState {
  phase: InstallPhase;
  version: string | null;
  from: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  detail: string | null;
}

const PHASE_TEXT: Record<InstallPhase, string> = {
  idle: 'Keine Installation',
  download: 'Release wird geladen',
  verify: 'Prüfsumme, Signatur und Paket werden geprüft',
  preflight: 'Wartungsmodus und Vorabprüfung',
  backup: 'Datenbanksicherung',
  extract: 'Paket wird entpackt',
  dependencies: 'Abhängigkeiten werden übernommen',
  selfcheck: 'Rauchtest der neuen Version',
  activating: 'Neustart mit der neuen Version',
  failed: 'Installation abgebrochen',
};

let state: InstallState = { phase: 'idle', version: null, from: config.version, startedAt: null, finishedAt: null, error: null, detail: null };
let running: Promise<void> | null = null;

export function installState(): InstallState & { phaseText: string; busy: boolean } {
  return { ...state, phaseText: PHASE_TEXT[state.phase], busy: !!running };
}

/* -------------------------------- Umgebung (überschreibbar nur in Tests) -------------------------------- */

const testMode = () => process.env.NODE_ENV === 'test';

/** Laufender Code (Quelle für node_modules und package-lock.json). In Tests per BLAULICHTCMS_TEST_UPDATE_RUNTIME_ROOT. */
export function runtimeRoot(): string {
  return testMode() && process.env.BLAULICHTCMS_TEST_UPDATE_RUNTIME_ROOT ? process.env.BLAULICHTCMS_TEST_UPDATE_RUNTIME_ROOT : APP_ROOT;
}

type Sender = (msg: { type: 'activate-release'; version: string }) => boolean;
let testSender: Sender | null = null;
/** Nur Tests: Umschaltauftrag abfangen statt an den Supervisor zu senden. */
export function setActivationSenderForTests(fn: Sender | null) {
  if (!testMode()) throw new Error('Nur in Tests.');
  testSender = fn;
}

/** Läuft die API unter dem Supervisor (Container)? Nur dann gibt es jemanden, der umschaltet. */
export function supervised(): boolean {
  if (testSender) return true;
  return process.env.BLAULICHTCMS_SUPERVISED === '1' && process.env.BLAULICHTCMS_ROLE === 'api' && typeof process.send === 'function';
}

function sendActivation(version: string): boolean {
  if (testSender) return testSender({ type: 'activate-release', version });
  return supervised() ? process.send!({ type: 'activate-release', version }) : false;
}

export async function imageInfo(): Promise<ImageInfo & { root: string }> {
  let postgresMajor: number | null = null;
  try {
    postgresMajor = Math.floor(Number((await one<{ v: string }>(`SELECT current_setting('server_version_num') AS v`))!.v) / 10000) || null;
  } catch {
    postgresMajor = null;
  }
  let ffmpeg: boolean | null = null;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 10_000, stdio: 'ignore' });
    ffmpeg = r.error ? false : r.status === 0;
  } catch {
    ffmpeg = false;
  }
  return {
    version: process.env.BLAULICHTCMS_IMAGE_VERSION || config.version,
    root: process.env.BLAULICHTCMS_IMAGE_ROOT || APP_ROOT,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    postgresMajor,
    ffmpeg,
  };
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) reject(new UpdateError(`${path.basename(args[0] ?? cmd)} ${args.slice(1).join(' ')} fehlgeschlagen: ${String(stderr || stdout || err.message).trim().slice(-800)}`));
      else resolve(String(stdout));
    });
  });
}

/** Entpackt Datei für Datei mit erneuter Pfadprüfung (kein extractAllTo: Ziele und Größen selbst kontrollieren). */
function extract(zip: AdmZip, files: string[], target: string) {
  const root = fs.realpathSync(target);
  const want = new Set(files);
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !want.has(e.entryName)) continue;
    const dest = path.resolve(root, e.entryName);
    if (!dest.startsWith(root + path.sep)) throw new UpdateError(`Pfadprüfung beim Entpacken fehlgeschlagen: ${e.entryName}`);
    const data = e.getData();
    if (data.length !== Number(e.header.size)) throw new UpdateError(`Größe im Paket stimmt nicht: ${e.entryName}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data, { mode: 0o644, flag: 'wx' });
  }
}

async function waitForPreflight(timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const p = await updatePreflight();
    if (p.ready) return p;
    if (Date.now() > until) {
      const open = p.checks.filter((c) => c.blocking && !c.ok).map((c) => `${c.label} (${c.detail})`);
      throw new UpdateError(`Update-Vorabprüfung nicht bestanden: ${open.join('; ')}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function recordFailure(version: string | null, message: string, actor: Actor, sha256: string | null) {
  await pool
    .query(`INSERT INTO update_history (from_version, to_version, status, message, sha256, actor_id, actor_name) VALUES ($1,$2,'failed',$3,$4,$5,$6)`, [
      config.version,
      version ?? '?',
      message.slice(0, 2000),
      sha256,
      actor.type === 'user' ? actor.id : null,
      actor.name,
    ])
    .catch((e) => log('error', 'updates', `Update-Protokoll nicht geschrieben: ${e.message}`));
}

/**
 * Startet die Installation des neuesten Releases im Hintergrund. Prüft vorab synchron: Supervisor vorhanden, keine
 * andere Installation, Release neuer als die laufende Version. Liefert die Zielversion.
 */
export async function startInstall(actor: Actor, opts: { userId: string | null; expectVersion?: string }): Promise<{ version: string }> {
  if (running) throw new UpdateError('Es läuft bereits eine Installation.');
  if (!supervised()) throw new UpdateError('Die Umschaltung braucht den Supervisor des Containers. Im Entwicklungsbetrieb ohne Container sind In-App-Updates nicht möglich.');
  const latest = await fetchLatestRelease();
  if (!latest) throw new UpdateError('Im Repository gibt es noch kein Release.');
  if (opts.expectVersion && opts.expectVersion !== latest.version) throw new UpdateError(`Das neueste Release ist inzwischen ${latest.version}. Bitte die Seite neu laden und erneut prüfen.`);
  if (compareVersions(latest.version, config.version) <= 0) {
    throw new UpdateError(`Version ${latest.version} ist nicht neuer als die laufende Version ${config.version}. Ein Downgrade oder eine erneute Installation derselben Version ist nicht möglich.`);
  }
  state = { phase: 'download', version: latest.version, from: config.version, startedAt: new Date().toISOString(), finishedAt: null, error: null, detail: null };
  running = (async () => {
    const dataDir = config.dataDir;
    const work = path.join(releasesDir(dataDir), `.download-${crypto.randomBytes(4).toString('hex')}`);
    let staging: string | null = null;
    let sha256: string | null = null;
    let maintenanceSet = false;
    try {
      // Reste abgebrochener Läufe entfernen (nur Zwischenstände, keine Releases), dann eigener Arbeitsordner
      cleanupReleases(dataDir, [], Number.MAX_SAFE_INTEGER);
      fs.mkdirSync(work, { recursive: true, mode: 0o700 });

      // 1. Laden, Prüfsumme, Signatur (gegen den Schlüssel der laufenden Version)
      const zipFile = path.join(work, 'update.zip');
      const dl = await downloadRelease(latest, zipFile);
      state.phase = 'verify';
      sha256 = sha256File(zipFile);
      if (sha256 !== dl.sha256) throw new UpdateError(`SHA-256-Prüfsumme stimmt nicht (erwartet ${dl.sha256.slice(0, 12)}…, berechnet ${sha256.slice(0, 12)}…).`);
      verifyDigestSignature(sha256, dl.signature);

      // 2. Paketinhalt, Version, Manifest, Image
      const zip = new AdmZip(zipFile);
      const files = checkZipEntries(zipEntryInfos(zip));
      const version = zip.readAsText('VERSION').trim();
      if (version !== latest.version) throw new UpdateError(`Das Paket enthält Version ${version}, das Release heißt ${latest.tag}.`);
      if (compareVersions(version, config.version) <= 0) throw new UpdateError(`Version ${version} ist nicht neuer als die laufende Version ${config.version}.`);
      const manifest = parseManifest(zip.readAsText('manifest.json'));
      if (manifest.version !== version) throw new UpdateError('manifest.json und VERSION nennen verschiedene Versionen.');
      const incompatible = compatibilityProblem(manifest, await imageInfo());
      if (incompatible) throw new UpdateError(incompatible);
      let newLock: any;
      let curLock: any;
      try {
        newLock = JSON.parse(zip.readAsText('package-lock.json'));
        curLock = JSON.parse(fs.readFileSync(path.join(runtimeRoot(), 'package-lock.json'), 'utf8'));
      } catch {
        throw new UpdateError('package-lock.json (Paket oder laufendes Programm) ist nicht lesbar.');
      }
      const deps = compareRuntimeDependencies(curLock, newLock);
      if (!deps.same) {
        throw new UpdateError(
          `Image-Update nötig: Version ${version} braucht geänderte Laufzeit-Abhängigkeiten (${deps.diff.slice(0, 8).join(', ')}${deps.diff.length > 8 ? ', …' : ''}). Das Image enthält kein npm; die Abhängigkeiten kommen mit dem Image. ${IMAGE_UPDATE_HINT}`,
        );
      }

      // 3. Wartungsmodus, Vorabprüfung, Sicherung
      state.phase = 'preflight';
      const s = await getSettings(true);
      if (!s['system.maintenance']) {
        await setMaintenance(true, actor.name, `Update auf Version ${version}`, opts.userId);
        maintenanceSet = true;
        await audit(actor, 'system.maintenance_on', { type: 'system', label: 'Wartungsmodus' }, { grund: `Update auf Version ${version}` });
      }
      await waitForPreflight(testMode() ? 0 : 180_000);
      state.phase = 'backup';
      const backup = await runBackup('manual', opts.userId);
      await audit(actor, 'backup.created', { type: 'backup', id: backup.id, label: backup.fileName }, { anlass: `Update auf Version ${version}` });

      // 4. Entpacken, Abhängigkeiten, Rauchtest
      state.phase = 'extract';
      staging = path.join(releasesDir(dataDir), `.staging-${version}-${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(staging, { recursive: true, mode: 0o755 });
      extract(zip, files, staging);
      state.phase = 'dependencies';
      const modules = path.join(runtimeRoot(), 'node_modules');
      if (!fs.existsSync(modules)) throw new UpdateError(`Im laufenden Programm fehlt node_modules (${modules}).`);
      fs.cpSync(modules, path.join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      state.phase = 'selfcheck';
      const env: NodeJS.ProcessEnv = { ...process.env, BLAULICHTCMS_ROLE: 'cli', BLAULICHTCMS_CLI_DELEGATED: '1', BLAULICHTCMS_DATA_DIR: dataDir };
      const out = await run(process.execPath, [path.join(staging, 'server', 'dist', 'cli.js'), 'self-check', '--release'], staging, 120_000, env);
      if (!out.includes(`ok ${version}`)) throw new UpdateError(`Rauchtest der neuen Version ohne Erfolgsmeldung: ${out.trim().slice(-500)}`);

      // 5. Release ablegen und Umschaltung beauftragen
      const target = path.join(releasesDir(dataDir), version);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      staging = null;
      cleanupReleases(dataDir, [target, readPointer(dataDir)?.path ?? '', APP_ROOT]);
      const pending: PendingActivation = {
        version,
        from: config.version,
        sha256,
        backupFile: backup.fileName,
        backupId: backup.id,
        actorId: actor.type === 'user' ? actor.id : null,
        actorName: actor.name,
        notes: latest.notes.slice(0, 20_000),
        maintenanceSetByUpdate: maintenanceSet,
        requestedAt: new Date().toISOString(),
      };
      writePending(dataDir, pending);
      writeActivation(dataDir, null);
      await audit(actor, 'update.activation_requested', { type: 'update', label: version }, { von: config.version, sha256, signatur: 'gültig', sicherung: backup.fileName, release: latest.tag });
      state.phase = 'activating';
      state.detail = 'Der Dienst startet mit der neuen Version neu. Bei einem Fehler wird automatisch zurückgeschaltet.';
      log('warn', 'updates', `Umschaltung auf Version ${version} beauftragt (von ${config.version}).`);
      if (!sendActivation(version)) throw new UpdateError('Der Supervisor hat den Umschaltauftrag nicht angenommen.');
    } catch (e) {
      const msg = (e as Error).message;
      state.phase = 'failed';
      state.error = msg;
      state.finishedAt = new Date().toISOString();
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      writePending(dataDir, null);
      if (maintenanceSet) {
        await setMaintenance(false, actor.name, '', opts.userId).catch(() => {});
        await audit(actor, 'system.maintenance_off', { type: 'system', label: 'Wartungsmodus' }, { grund: 'Update abgebrochen' }).catch(() => {});
      }
      await audit(actor, 'update.install', { type: 'update', label: state.version }, { von: config.version, fehler: msg.slice(0, 500), sha256 }, 'failed').catch(() => {});
      await recordFailure(state.version, msg, actor, sha256);
      log('error', 'updates', `Installation von Version ${state.version} abgebrochen: ${msg}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      running = null;
    }
  })();
  return { version: latest.version };
}

/** Nur Tests: auf das Ende der Hintergrundinstallation warten. */
export async function waitForInstall() {
  await running;
}

/**
 * Ergebnis einer Umschaltung (vom Supervisor in activation.json geschrieben) ins Update-Protokoll übernehmen: beim
 * Start der API und auf Zuruf des Supervisors. Beendet den Wartungsmodus, wenn das Update ihn eingeschaltet hat,
 * benachrichtigt die Administration und räumt alte Releases auf.
 */
export async function recordActivationResult(): Promise<{ status: string; version: string } | null> {
  const dataDir = config.dataDir;
  const a = readActivation(dataDir);
  if (!a) return null;
  writeActivation(dataDir, null);
  writePending(dataDir, null);
  const ok = a.status === 'activated';
  const actor: Actor = { ...SYSTEM_ACTOR, name: 'Supervisor' };
  try {
    await pool.query(
      `INSERT INTO update_history (at, from_version, to_version, status, message, sha256, backup_file, notes, actor_id, actor_name, restored)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT id FROM users WHERE id = $9),$10,$11)`,
      [a.at ?? new Date().toISOString(), String(a.from ?? '?'), String(a.version), ok ? 'activated' : 'rolled_back', String(a.message ?? '').slice(0, 4000), a.sha256 ?? null, a.backupFile ?? null, String(a.notes ?? '').slice(0, 20_000), a.actorId ?? null, a.actorName ?? null, !!a.restored],
    );
    await audit(actor, ok ? 'update.activated' : 'update.rolled_back', { type: 'update', label: String(a.version) }, { von: a.from, sicherung: a.backupFile ?? null, zurueckgespielt: !!a.restored, meldung: String(a.message ?? '').slice(0, 500) }, ok ? 'ok' : 'failed');
    if (a.maintenanceSetByUpdate && (await getSettings(true))['system.maintenance']) {
      await setMaintenance(false, 'Supervisor', '', null);
      await audit(actor, 'system.maintenance_off', { type: 'system', label: 'Wartungsmodus' }, { grund: ok ? 'Update abgeschlossen' : 'Update zurückgerollt' });
    }
    if (ok) {
      await notify({ kind: 'success', title: `Update auf Version ${a.version} abgeschlossen`, body: `Vorher: ${a.from}. ${a.message ?? ''}`.trim(), link: '/einstellungen#updates', permission: 'update.install' });
    } else {
      await securityAlert('update_rolled_back', { kind: 'error', title: `Update auf Version ${a.version} zurückgerollt`, body: `${a.message ?? ''} Es läuft wieder ${a.from}.`.slice(0, 900), link: '/einstellungen#updates' });
    }
    log(ok ? 'info' : 'error', 'updates', ok ? `Update auf Version ${a.version} aktiviert.` : `Update auf Version ${a.version} zurückgerollt: ${a.message}`);
  } catch (e) {
    log('error', 'updates', `Ergebnis der Umschaltung nicht übernommen: ${(e as Error).message}`);
  }
  try {
    cleanupReleases(dataDir, [readPointer(dataDir)?.path ?? '', APP_ROOT]);
  } catch {
    /* Aufräumen ist nicht kritisch */
  }
  return { status: a.status, version: a.version };
}

export async function updateHistory(limit = 30) {
  return many<any>(
    `SELECT h.id, h.at, h.from_version, h.to_version, h.status, h.message, h.sha256, h.backup_file, h.restored, coalesce(u.name, h.actor_name) AS actor_name
       FROM update_history h LEFT JOIN users u ON u.id = h.actor_id ORDER BY h.id DESC LIMIT $1`,
    [limit],
  );
}
