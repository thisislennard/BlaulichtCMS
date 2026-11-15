import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, parseManifest, parseVersion } from './core.js';

/**
 * Ablage installierter Programmversionen im Datenvolume (gemeinsam für Supervisor, API und Kommandozeile):
 *
 *   <data>/releases/<version>/        entpacktes, geprüftes Release inkl. node_modules
 *   <data>/releases/current.json      Zeiger { version, path, previous } auf das aktive Release
 *   <data>/releases/pending.json      Umschaltauftrag der API (Version, Sicherung, Prüfsumme, Person)
 *   <data>/releases/activation.json   Ergebnis der letzten Umschaltung (übernimmt die API beim Start ins Protokoll)
 *   <data>/releases/.staging-*        Zwischenstände einer laufenden Installation (werden aufgeräumt)
 *
 * Ohne Zeiger läuft der Code des Images. Der Supervisor selbst kommt immer aus dem Image.
 */
export interface ReleasePointer {
  version: string;
  path: string;
  previous?: { version: string; path: string } | null;
}

export interface PendingActivation {
  version: string;
  from: string;
  sha256: string;
  backupFile: string | null;
  backupId: string | null;
  actorId: string | null;
  actorName: string;
  notes: string;
  maintenanceSetByUpdate: boolean;
  requestedAt: string;
}

export interface ActivationResult extends Partial<PendingActivation> {
  status: 'activated' | 'rolled_back';
  version: string;
  from: string;
  message: string;
  restored?: boolean;
  at: string;
}

export const releasesDir = (dataDir: string) => path.join(dataDir, 'releases');
const file = (dataDir: string, name: string) => path.join(releasesDir(dataDir), name);

export function writeJsonAtomic(target: string, data: unknown) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function readJson<T>(f: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

export const readPointer = (dataDir: string) => readJson<ReleasePointer>(file(dataDir, 'current.json'));
export function writePointer(dataDir: string, p: ReleasePointer | null) {
  if (p) writeJsonAtomic(file(dataDir, 'current.json'), p);
  else fs.rmSync(file(dataDir, 'current.json'), { force: true });
}

export const readPending = (dataDir: string) => readJson<PendingActivation>(file(dataDir, 'pending.json'));
export function writePending(dataDir: string, p: PendingActivation | null) {
  if (p) writeJsonAtomic(file(dataDir, 'pending.json'), p);
  else fs.rmSync(file(dataDir, 'pending.json'), { force: true });
}

export const readActivation = (dataDir: string) => readJson<ActivationResult>(file(dataDir, 'activation.json'));
export function writeActivation(dataDir: string, a: Omit<ActivationResult, 'at'> | null) {
  if (a) writeJsonAtomic(file(dataDir, 'activation.json'), { ...a, at: new Date().toISOString() });
  else fs.rmSync(file(dataDir, 'activation.json'), { force: true });
}

export function readVersionAt(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Dateien, die ein Release-Ordner zum Starten braucht. */
const START_FILES = ['VERSION', 'manifest.json', 'server/dist/api.js', 'server/dist/worker.js', 'server/dist/cli.js', 'server/migrations', 'web/dist/index.html', 'node_modules'];

/**
 * Prüft einen Release-Ordner: liegt direkt unter <data>/releases, heißt wie seine Version, VERSION passt, alle
 * Startdateien vorhanden, Mindest-Image erfüllt. Liefert die Begründung, wenn er nicht taugt – sonst null.
 */
export function releaseDirProblem(dir: string, dataDir: string, expectedVersion: string, imageVersion?: string): string | null {
  if (!parseVersion(expectedVersion)) return `ungültige Version „${String(expectedVersion).slice(0, 40)}“`;
  const base = releasesDir(dataDir);
  let real: string;
  let realBase: string;
  try {
    real = fs.realpathSync(dir);
    realBase = fs.realpathSync(base);
  } catch {
    return 'Release-Ordner fehlt';
  }
  if (path.dirname(real) !== realBase || path.basename(real) !== expectedVersion) return 'Release-Ordner liegt nicht an der erwarteten Stelle';
  for (const f of START_FILES) if (!fs.existsSync(path.join(real, f))) return `im Release fehlt ${f}`;
  if (readVersionAt(real) !== expectedVersion) return 'VERSION passt nicht zum Release-Ordner';
  if (imageVersion) {
    try {
      const m = parseManifest(fs.readFileSync(path.join(real, 'manifest.json'), 'utf8'));
      if (compareVersions(m.minImageVersion, imageVersion) > 0) return `das Release braucht mindestens Image ${m.minImageVersion} (vorhanden ${imageVersion})`;
    } catch (e) {
      return `manifest.json unbrauchbar (${(e as Error).message})`;
    }
  }
  return null;
}

export interface ActiveRoot {
  root: string;
  version: string;
  source: 'image' | 'update';
  /** Der Zeiger ist veraltet oder unbrauchbar und soll entfernt werden (mit Begründung). */
  dropPointer: string | null;
}

/**
 * Welche Programmversion läuft? Das installierte Update nur, wenn sein Ordner gültig ist und seine Version NEUER als
 * die des Images ist. Sonst (z. B. nach einem Image-Update am Host mit install.sh) der Code des Images; ein
 * vorhandener Zeiger wird dann als veraltet gemeldet.
 */
export function resolveActiveRoot(imageRoot: string, dataDir: string): ActiveRoot {
  const imageVersion = readVersionAt(imageRoot) ?? '0.0.0';
  const image: ActiveRoot = { root: imageRoot, version: imageVersion, source: 'image', dropPointer: null };
  const p = readPointer(dataDir);
  if (!p) return image;
  if (!p.version || !p.path) return { ...image, dropPointer: 'Zeiger unvollständig' };
  if (compareVersions(p.version, imageVersion) <= 0) return { ...image, dropPointer: `Image ${imageVersion} ist nicht älter als das installierte Update ${p.version}` };
  const problem = releaseDirProblem(p.path, dataDir, p.version, imageVersion);
  if (problem) return { ...image, dropPointer: `Update ${p.version} unbrauchbar: ${problem}` };
  return { root: fs.realpathSync(p.path), version: p.version, source: 'update', dropPointer: null };
}

/**
 * Aufräumen: die drei neuesten Release-Ordner und alle in `keep` behalten (aktives Release, Ziel), Zwischenstände
 * (.staging-*, .download-*) immer entfernen. Liefert die entfernten Ordner.
 */
export function cleanupReleases(dataDir: string, keep: string[], newest = 3): string[] {
  const dir = releasesDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const keepReal = new Set(
    keep.filter(Boolean).map((k) => {
      try {
        return fs.realpathSync(k);
      } catch {
        return path.resolve(k);
      }
    }),
  );
  const removed: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && (e.name.startsWith('.staging-') || e.name.startsWith('.download-'))) {
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
  }
  const versions = entries
    .filter((e) => e.isDirectory() && parseVersion(e.name) && !e.name.startsWith('v'))
    .map((e) => e.name)
    .sort((a, b) => compareVersions(b, a));
  for (const v of versions.slice(newest)) {
    const p = path.join(dir, v);
    if (keepReal.has(fs.realpathSync(p))) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(v);
  }
  return removed;
}
