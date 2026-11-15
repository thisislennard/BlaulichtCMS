import crypto from 'node:crypto';
import fs from 'node:fs';
import AdmZip from 'adm-zip';

/**
 * Prüfungen für In-App-Updates ohne Datenbank und ohne Konfiguration: Versionen, Inhalt des Update-ZIPs, Manifest
 * (Anforderungen an das Docker-Image) und Laufzeit-Abhängigkeiten aus der package-lock.json.
 *
 * Bewusst nur mit node:* und adm-zip und ohne relative Importe: scripts/build-release.mjs lädt diese Datei direkt
 * (Typ-Entfernung von Node), damit Erzeugung und Prüfung des Pakets dieselben Regeln verwenden.
 */
export class UpdateError extends Error {}

/* ---------------------------------------- Versionen ---------------------------------------- */

const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Nur vollständige Versionen „X.Y.Z“ (optional mit „v“) – keine Vorabversionen. */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** > 0, wenn a neuer ist als b. Ungültige Angaben gelten als älteste Version. */
export function compareVersions(a: unknown, b: unknown): number {
  const x = parseVersion(a) ?? [-1, -1, -1];
  const y = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/* ---------------------------------------- ZIP-Inhalt --------------------------------------- */

export const ZIP_LIMITS = {
  /** Größe des heruntergeladenen ZIPs. */
  maxZipBytes: 250 * 1024 ** 2,
  maxFiles: 20_000,
  /** Summe der entpackten Größen. */
  maxUnpackedBytes: 800 * 1024 ** 2,
  maxEntryBytes: 200 * 1024 ** 2,
};

/** Ohne diese Dateien ist ein Paket kein vollständiges BlaulichtCMS-Release. */
export const REQUIRED_FILES = [
  'VERSION',
  'manifest.json',
  'package.json',
  'package-lock.json',
  'server/package.json',
  'server/update-signing-key.pub',
  'server/dist/api.js',
  'server/dist/worker.js',
  'server/dist/cli.js',
  'server/dist/main.js',
  'server/migrations/001_grundstand.sql',
  'web/package.json',
  'web/dist/index.html',
  'wordpress-plugin/blaulichtcms-bridge/blaulichtcms-bridge.php',
];

/** Erlaubte Orte im Paket (alles andere wird abgewiesen). */
const ALLOWED = [
  /^(VERSION|manifest\.json|package\.json|package-lock\.json|release-notes\.md|LICENSE)$/,
  /^server\/(package\.json|update-signing-key\.pub)$/,
  /^server\/dist\/.+/,
  /^server\/migrations\/[0-9]{3}_[a-z0-9_]+\.sql$/,
  /^web\/package\.json$/,
  /^web\/dist\/.+/,
  /^wordpress-plugin\/blaulichtcms-bridge\/.+/,
];

export interface ZipEntryInfo {
  name: string;
  size: number;
  isDirectory: boolean;
  /** Unix-Dateimodus aus den externen Attributen (0, wenn unbekannt). */
  mode: number;
}

/** Grund, warum ein Pfad nicht ins Paket darf – oder null. Gilt für das Erzeugen (Build) und das Prüfen (Installation). */
export function forbiddenPath(name: string): string | null {
  if (!name || name.length > 300) return 'Pfad leer oder zu lang';
  if (name.includes('\\')) return 'Rückwärtsschrägstrich im Pfad';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Steuerzeichen im Pfad';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absoluter Pfad';
  const segs = name.replace(/\/$/, '').split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) return 'Pfad mit „..“, „.“ oder leerem Abschnitt';
  if (segs.some((s) => s === 'node_modules' || s === '.git')) return 'node_modules oder .git im Paket';
  const base = segs[segs.length - 1].toLowerCase();
  if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') return 'Umgebungsdatei (.env) im Paket';
  if (base === '.npmrc' || base.startsWith('id_rsa') || base.startsWith('id_ed25519') || /\.(pem|key|p12|pfx|llbk)$/.test(base)) return 'Schlüssel- oder Zugangsdatei im Paket';
  if (segs[0] === 'data' || base === 'master.key') return 'Daten im Paket';
  return null;
}

/**
 * Prüft die Einträge eines Update-ZIPs: keine absoluten Pfade, kein „..“, keine symbolischen Links, keine
 * Zugangsdateien, nur erlaubte Orte, Mengen- und Größengrenzen, keine doppelten Namen, alle Pflichtdateien vorhanden.
 * Liefert die Dateinamen (ohne Ordner).
 */
export function checkZipEntries(entries: ZipEntryInfo[]): string[] {
  if (entries.length > ZIP_LIMITS.maxFiles) throw new UpdateError(`Das Paket enthält zu viele Einträge (mehr als ${ZIP_LIMITS.maxFiles}).`);
  let total = 0;
  const seen = new Set<string>();
  const files: string[] = [];
  for (const e of entries) {
    const name = e.name;
    const bad = forbiddenPath(name);
    if (bad) throw new UpdateError(`Unzulässiger Eintrag im Paket (${bad}): ${name.slice(0, 200)}`);
    const type = e.mode & 0o170000;
    if (type === 0o120000) throw new UpdateError(`Symbolische Links sind im Paket nicht erlaubt: ${name}`);
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new UpdateError(`Sonderdatei im Paket: ${name}`);
    const key = name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) throw new UpdateError(`Doppelter Eintrag im Paket: ${name}`);
    seen.add(key);
    if (e.isDirectory) continue;
    if (!ALLOWED.some((re) => re.test(name))) throw new UpdateError(`Datei an unerwartetem Ort im Paket: ${name}`);
    if (e.size < 0 || e.size > ZIP_LIMITS.maxEntryBytes) throw new UpdateError(`Datei im Paket zu groß: ${name}`);
    total += e.size;
    if (total > ZIP_LIMITS.maxUnpackedBytes) throw new UpdateError('Das Paket ist entpackt zu groß.');
    files.push(name);
  }
  const have = new Set(files);
  const missing = REQUIRED_FILES.filter((r) => !have.has(r));
  if (missing.length) throw new UpdateError(`Im Paket fehlen Pflichtdateien: ${missing.join(', ')}`);
  return files;
}

export function zipEntryInfos(zip: AdmZip): ZipEntryInfo[] {
  return zip.getEntries().map((e) => ({
    name: e.entryName,
    size: Number(e.header.size),
    isDirectory: e.isDirectory,
    mode: (e.header.attr >>> 16) & 0o177777,
  }));
}

/* ---------------------------------------- Manifest ----------------------------------------- */

export interface UpdateManifest {
  name: 'blaulichtcms';
  version: string;
  /** Mindestens nötige Image-Version (Dockerfile, Supervisor, Basis-Images, native Abhängigkeiten). */
  minImageVersion: string;
  requires: { nodeMajor?: number; postgresMajor?: number; ffmpeg?: boolean };
  lockfileSha256?: string;
  commit?: string;
  builtAt?: string;
  migrations?: string[];
}

export function parseManifest(text: string): UpdateManifest {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    throw new UpdateError('manifest.json ist kein gültiges JSON.');
  }
  if (!m || typeof m !== 'object' || m.name !== 'blaulichtcms') throw new UpdateError('manifest.json gehört nicht zu BlaulichtCMS.');
  if (!parseVersion(m.version)) throw new UpdateError('manifest.json: ungültige Version.');
  if (!parseVersion(m.minImageVersion)) throw new UpdateError('manifest.json: ungültige Mindestversion des Images (minImageVersion).');
  const r = m.requires && typeof m.requires === 'object' ? m.requires : {};
  const int = (x: unknown) => (x === undefined ? undefined : Number.isInteger(x) && (x as number) > 0 ? (x as number) : NaN);
  const requires = { nodeMajor: int(r.nodeMajor), postgresMajor: int(r.postgresMajor), ffmpeg: r.ffmpeg === undefined ? undefined : r.ffmpeg === true };
  if (Number.isNaN(requires.nodeMajor) || Number.isNaN(requires.postgresMajor)) throw new UpdateError('manifest.json: ungültige Anforderungen (requires).');
  return { ...m, requires };
}

export interface ImageInfo {
  version: string;
  nodeMajor: number;
  postgresMajor: number | null;
  ffmpeg: boolean | null;
}

export const IMAGE_UPDATE_HINT = 'Auf dem Docker-Host ausführen: sudo bash /opt/apps/blaulichtcms/install.sh (bei unverändertem Programmstand mit --rebuild).';

/** Passt das laufende Image zu den Anforderungen des Pakets? Liefert die Begründung, wenn nicht. */
export function compatibilityProblem(m: UpdateManifest, image: ImageInfo): string | null {
  const why: string[] = [];
  if (compareVersions(m.minImageVersion, image.version) > 0) why.push(`Image-Version mindestens ${m.minImageVersion} (vorhanden ${image.version})`);
  if (m.requires.nodeMajor && image.nodeMajor < m.requires.nodeMajor) why.push(`Node.js ${m.requires.nodeMajor} (vorhanden ${image.nodeMajor})`);
  if (m.requires.postgresMajor && image.postgresMajor !== null && image.postgresMajor !== m.requires.postgresMajor) {
    why.push(`PostgreSQL ${m.requires.postgresMajor} (vorhanden ${image.postgresMajor})`);
  }
  if (m.requires.ffmpeg && image.ffmpeg === false) why.push('ffmpeg/ffprobe im Image');
  if (!why.length) return null;
  return `Dieses Update braucht ein neueres Docker-Image: ${why.join(', ')}. ${IMAGE_UPDATE_HINT}`;
}

/* ---------------------------------- Laufzeit-Abhängigkeiten -------------------------------- */

/**
 * Laufzeit-Abhängigkeiten eines Workspaces (Standard: server) laut package-lock.json, so wie `npm ci --omit=dev
 * --workspace server` sie installiert: Pfad im node_modules-Baum → Version und Integrität. Abhängigkeiten der
 * Weboberfläche und Entwicklungswerkzeuge zählen nicht – sie liegen nicht im Image.
 */
export function runtimeDependencies(lock: any, workspace = 'server'): Map<string, string> {
  const pk: Record<string, any> = lock?.packages ?? {};
  const out = new Map<string, string>();
  const root = pk[workspace];
  if (!root) throw new UpdateError(`package-lock.json enthält den Workspace „${workspace}“ nicht.`);
  const depsOf = (e: any) => ({ ...(e.peerDependencies ?? {}), ...(e.optionalDependencies ?? {}), ...(e.dependencies ?? {}) });
  const resolve = (from: string, name: string): string | null => {
    let base = from;
    for (;;) {
      const cand = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (pk[cand]) return cand;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i >= 0 ? base.slice(0, i) : '';
    }
  };
  const queue: [string, Record<string, string>][] = [[workspace, depsOf(root)]];
  while (queue.length) {
    const [from, deps] = queue.shift()!;
    for (const name of Object.keys(deps)) {
      const found = resolve(from, name);
      if (!found) continue; // optionale bzw. plattformfremde Abhängigkeit
      let p: string = found;
      let e = pk[p];
      if (e.link && typeof e.resolved === 'string' && pk[e.resolved]) {
        p = e.resolved;
        e = pk[p];
      }
      if (out.has(p)) continue;
      if (e.dev) continue;
      out.set(p, `${e.version ?? ''}#${e.integrity ?? e.resolved ?? ''}`);
      queue.push([p, depsOf(e)]);
    }
  }
  return out;
}

/** Vergleicht die Laufzeit-Abhängigkeiten zweier package-lock.json. */
export function compareRuntimeDependencies(lockA: any, lockB: any): { same: boolean; diff: string[] } {
  const a = runtimeDependencies(lockA);
  const b = runtimeDependencies(lockB);
  const diff: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) diff.push(k.replace(/^.*node_modules\//, ''));
  for (const k of b.keys()) if (!a.has(k)) diff.push(k.replace(/^.*node_modules\//, ''));
  return { same: diff.length === 0, diff: [...new Set(diff)].sort() };
}
