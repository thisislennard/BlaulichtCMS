import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import AdmZip from 'adm-zip';
import { APP_ROOT, config } from '../config.js';
import { pool } from '../db/pool.js';
import { compareVersions, readPointer, releasesDir, versionTuple, writeJsonAtomic } from './releases.js';
import { sha256File, verifyUpdateSignature } from './signing.js';

/**
 * Installiert ein signiertes Update-Paket in einen eigenen Release-Ordner. Der laufende Code wird
 * nicht angefasst; erst der Supervisor schaltet um und rollt automatisch zurück, wenn die neue
 * Version nicht startet. Daten, .env und Container-Konfiguration bleiben unberührt.
 */
const MAX_FILES = 30_000;
const MAX_UNPACKED = 600 * 1024 * 1024;
const REQUIRED = ['VERSION', 'manifest.json', 'package.json', 'package-lock.json', 'server/package.json', 'server/dist/api.js', 'server/dist/worker.js', 'server/dist/main.js', 'server/update-signing-key.pub', 'web/dist/index.html'];

export class UpdateError extends Error {}

let busy = false;

export function updateBusy() {
  return busy;
}

export interface InstallResult {
  version: string;
  notes: string;
  sha256: string;
  path: string;
  npm: 'kopiert' | 'installiert';
  activation: 'supervisor' | 'manuell';
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, shell: process.platform === 'win32' && cmd === 'npm' }, (err, stdout, stderr) => {
      if (err) reject(new UpdateError(`${cmd} ${args.join(' ')} fehlgeschlagen: ${(stderr || err.message).slice(-1500)}`));
      else resolve(stdout + stderr);
    });
  });
}

function checkEntries(zip: AdmZip) {
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES) throw new UpdateError('Das Paket enthält zu viele Dateien.');
  let total = 0;
  const names = new Set<string>();
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((s) => s === '..')) throw new UpdateError(`Unzulässiger Pfad im Paket: ${name}`);
    const mode = (e.header.attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new UpdateError(`Symbolische Links sind im Paket nicht erlaubt: ${name}`);
    if (/(^|\/)(\.env|node_modules)(\/|$)/.test(name) && !name.endsWith('.env.example')) throw new UpdateError(`Unzulässige Datei im Paket: ${name}`);
    total += e.header.size;
    if (total > MAX_UNPACKED) throw new UpdateError('Das Paket ist entpackt zu groß.');
    names.add(name.replace(/\/$/, ''));
  }
  for (const r of REQUIRED) if (!names.has(r)) throw new UpdateError(`Im Paket fehlt ${r}.`);
}

function lockfileHash(root: string) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
}

export async function installUpdate(zipFile: string, opts: { sha256Expected?: string | null; signature: Buffer | string | null; source: 'github' | 'upload'; actorId: string | null }): Promise<InstallResult> {
  if (busy) throw new UpdateError('Es läuft bereits eine Installation.');
  busy = true;
  let staging: string | null = null;
  try {
    const actual = sha256File(zipFile);
    if (opts.sha256Expected && opts.sha256Expected.trim().toLowerCase() !== actual) {
      throw new UpdateError(`SHA-256-Prüfsumme stimmt nicht überein (erwartet ${opts.sha256Expected.slice(0, 12)}…, berechnet ${actual.slice(0, 12)}…).`);
    }
    // Signatur gegen den Schlüssel der LAUFENDEN Version – ein Paket kann sich nicht selbst beglaubigen
    verifyUpdateSignature(zipFile, opts.signature);

    const zip = new AdmZip(zipFile);
    checkEntries(zip);
    const version = zip.readAsText('VERSION').trim();
    if (!versionTuple(version)) throw new UpdateError(`Ungültige Versionsangabe „${version}“.`);
    if (compareVersions(version, config.version) <= 0) throw new UpdateError(`Version ${version} ist nicht neuer als die installierte Version ${config.version}. Ein Downgrade ist nicht möglich.`);
    const manifest = JSON.parse(zip.readAsText('manifest.json') || '{}');
    const imageVersion = process.env.LIFELINK_IMAGE_VERSION ?? config.version;
    if (manifest.minImageVersion && compareVersions(manifest.minImageVersion, imageVersion) > 0) {
      throw new UpdateError(
        `Dieses Update braucht ein neueres Docker-Image (mindestens ${manifest.minImageVersion}, vorhanden ${imageVersion}). Auf dem Server im LifeLink-Ordner „git pull“ und „docker compose up -d --build“ ausführen.`,
      );
    }
    const notes = zip.readAsText('release_notes.txt') ?? '';

    const dir = releasesDir(config.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    staging = path.join(dir, `.staging-${version}-${crypto.randomBytes(4).toString('hex')}`);
    zip.extractAllTo(staging, true, false);
    // Nach dem Entpacken nochmals prüfen, dass nichts außerhalb gelandet ist
    const realStaging = fs.realpathSync(staging);
    for (const e of zip.getEntries()) {
      const p = path.resolve(staging, e.entryName);
      if (!p.startsWith(realStaging + path.sep) && p !== realStaging) throw new UpdateError('Pfadprüfung nach dem Entpacken fehlgeschlagen.');
    }

    // Abhängigkeiten: gleiche package-lock → vorhandene Module übernehmen, sonst npm ci (braucht Internet)
    let npm: InstallResult['npm'] = 'installiert';
    const same = lockfileHash(APP_ROOT) && lockfileHash(APP_ROOT) === lockfileHash(staging) && fs.existsSync(path.join(APP_ROOT, 'node_modules'));
    if (same) {
      fs.cpSync(path.join(APP_ROOT, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      npm = 'kopiert';
    } else {
      await run('npm', ['ci', '--omit=dev', '--workspace', 'server', '--no-audit', '--no-fund'], staging, 10 * 60_000);
    }
    // Rauchtest: neue Version lädt ihre Module und findet ihren Schlüssel
    await run(process.execPath, [path.join(staging, 'server', 'dist', 'cli.js'), 'self-check'], staging, 60_000);

    const target = path.join(dir, version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    staging = null;
    cleanupOldReleases(dir, [target, readPointer(config.dataDir)?.path ?? '', APP_ROOT]);

    await pool.query(
      `INSERT INTO update_history (from_version, to_version, source, sha256, status, message, notes, actor_id) VALUES ($1,$2,$3,$4,'installed',$5,$6,$7)`,
      [config.version, version, opts.source, actual, npm === 'kopiert' ? 'Abhängigkeiten unverändert übernommen' : 'Abhängigkeiten neu installiert', notes.slice(0, 20_000), opts.actorId],
    );
    let activation: InstallResult['activation'] = 'manuell';
    if (typeof process.send === 'function') {
      process.send({ type: 'activate-release', version, path: target });
      activation = 'supervisor';
    }
    return { version, notes, sha256: actual, path: target, npm, activation };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    busy = false;
  }
}

function cleanupOldReleases(dir: string, keep: string[]) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && versionTuple(d.name))
    .map((d) => path.join(dir, d.name))
    .sort((a, b) => compareVersions(path.basename(b), path.basename(a)));
  // die drei neuesten plus alles in Benutzung behalten
  for (const p of entries.slice(3)) if (!keep.includes(p)) fs.rmSync(p, { recursive: true, force: true });
  for (const d of fs.readdirSync(dir)) if (d.startsWith('.staging-')) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
}

/** Ergebnis einer Umschaltung (vom Supervisor geschrieben) beim API-Start ins Protokoll übernehmen. */
export async function recordActivationResult(): Promise<{ status: string; version: string; message?: string } | null> {
  const file = path.join(releasesDir(config.dataDir), 'activation.json');
  if (!fs.existsSync(file)) return null;
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    await pool.query(`INSERT INTO update_history (from_version, to_version, source, status, message) VALUES ($1,$2,'github',$3,$4)`, [a.from ?? '', a.version, a.status === 'activated' ? 'activated' : 'rolled_back', a.message ?? '']);
    fs.rmSync(file, { force: true });
    return a;
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
}

export function writeActivation(dataDir: string, data: Record<string, unknown>) {
  writeJsonAtomic(path.join(releasesDir(dataDir), 'activation.json'), { ...data, at: new Date().toISOString() });
}
