import fs from 'node:fs';
import path from 'node:path';

/**
 * Gemeinsame Ablage der installierten Programmversionen (vom Supervisor und vom Installer genutzt).
 *   <dataDir>/releases/<version>/      entpacktes Release inkl. node_modules
 *   <dataDir>/releases/current.json    { version, path, previous }
 *   <dataDir>/releases/activation.json Ergebnis der letzten Umschaltung (liest die API beim Start)
 */
export interface ReleasePointer {
  version: string;
  path: string;
  previous?: { version: string; path: string } | null;
}

export function releasesDir(dataDir: string) {
  return path.join(dataDir, 'releases');
}

export function readPointer(dataDir: string): ReleasePointer | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(releasesDir(dataDir), 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function writePointer(dataDir: string, p: ReleasePointer | null) {
  const file = path.join(releasesDir(dataDir), 'current.json');
  if (!p) fs.rmSync(file, { force: true });
  else writeJsonAtomic(file, p);
}

export function versionTuple(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(v ?? '').trim());
  return m ? m[1].split('.').map(Number) : null;
}

/** >0 wenn a neuer als b */
export function compareVersions(a: string, b: string): number {
  const x = versionTuple(a) ?? [0];
  const y = versionTuple(b) ?? [0];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function readVersionAt(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Welche Programmversion soll laufen? Die neuere von Image und installiertem Update. */
export function resolveActiveRoot(imageRoot: string, dataDir: string): { root: string; version: string; source: 'image' | 'update' } {
  const imageVersion = readVersionAt(imageRoot) ?? '0.0.0';
  const p = readPointer(dataDir);
  if (p && fs.existsSync(path.join(p.path, 'server', 'dist', 'api.js')) && compareVersions(p.version, imageVersion) > 0) {
    return { root: p.path, version: p.version, source: 'update' };
  }
  return { root: imageRoot, version: imageVersion, source: 'image' };
}
