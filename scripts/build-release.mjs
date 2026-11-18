#!/usr/bin/env node
/**
 * Baut das Paket für In-App-Updates aus einem fertigen Build (`npm ci && npm run build`):
 *
 *   node scripts/build-release.mjs [--tag vX.Y.Z] [--out <ordner>] [--notes <datei.md>] [--root <ordner>]
 *
 * Schreibt <out>/blaulichtcms-update-vX.Y.Z.zip, .zip.sha256 („<hash>  <name>“) und .zip.notes.md (Release-Text).
 * Signiert wird getrennt (scripts/update-signing.mjs sign, im Release-Workflow mit dem Secret).
 *
 * Inhalt: VERSION, manifest.json, package.json, package-lock.json, LICENSE, release-notes.md, server/package.json,
 * server/update-signing-key.pub, server/dist/**, server/migrations/*.sql, web/package.json, web/dist/**,
 * wordpress-plugin/blaulichtcms-bridge/**. Keine node_modules: die Laufzeit-Abhängigkeiten kommen aus dem Image.
 *
 * Bricht ab, wenn der Tag nicht v<VERSION> ist, Build-Dateien fehlen, verbotene Dateien (.env, Schlüssel, Daten)
 * enthalten wären, ein Text nach privatem Schlüssel aussieht oder sich Image-relevante Dateien bzw. die
 * Laufzeit-Abhängigkeiten des Servers (package-lock.json) seit dem letzten Tag geändert haben, ohne dass
 * MIN_IMAGE_VERSION auf die neue Version gesetzt wurde.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import AdmZip from 'adm-zip';
import { checkZipEntries, compareRuntimeDependencies, forbiddenPath, minImageNote, parseManifest, parseVersion, zipEntryInfos } from '../server/src/updates/core.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ROOT = path.resolve(arg('--root', REPO));
const die = (msg) => {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
};

const version = read('VERSION').trim();
if (!parseVersion(version) || version.startsWith('v')) die(`VERSION „${version}“ ist keine Version X.Y.Z.`);
const tag = arg('--tag');
if (tag && tag !== `v${version}`) die(`Tag ${tag} passt nicht zu VERSION ${version} (erwartet v${version}).`);
const minImageVersion = read('MIN_IMAGE_VERSION').trim();
if (!parseVersion(minImageVersion)) die(`MIN_IMAGE_VERSION „${minImageVersion}“ ist keine Version X.Y.Z.`);
for (const f of ['server/package.json', 'web/package.json']) {
  if (JSON.parse(read(f)).version !== version) die(`${f}: version passt nicht zu VERSION ${version}.`);
}

/* Image-relevante Änderungen seit dem letzten Tag verlangen eine neue Mindestversion des Images. Dazu gehören auch die
 * Skripte, die am Host aus dem Installationsordner laufen (#275): Sie kommen nur mit install.sh an – ein In-App-Update
 * ändert den Stand am Host nicht, eine Korrektur z. B. an restore-volume.sh bliebe dort sonst aus. */
const IMAGE_FILES = ['Dockerfile', '.dockerignore', 'compose.yaml', 'install.sh', 'scripts/update.sh', 'scripts/image-selftest.sh',
  'scripts/backup-volume.sh', 'scripts/restore-volume.sh', 'scripts/verify-backup.sh', 'scripts/backup-cron.sh', 'scripts/volume-crypt.mjs',
  'scripts/host-update-helper.sh', 'scripts/host-update-verify.mjs', 'server/src/main.ts', 'server/src/updates/releases.ts'];
const prevTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^');
if (prevTag) {
  const changed = (git('diff', '--name-only', prevTag, 'HEAD', '--', ...IMAGE_FILES) ?? '').split('\n').filter(Boolean);
  // Laufzeit-Abhängigkeiten des Servers kommen nur mit dem Image (kein npm im Container): ohne neue Mindestversion böte
  // die Oberfläche das Update an und bräche erst bei der Installation mit „Image-Update nötig“ ab
  const prevLock = git('show', `${prevTag}:package-lock.json`);
  const deps = prevLock ? compareRuntimeDependencies(JSON.parse(prevLock), JSON.parse(read('package-lock.json'))).diff : [];
  if (deps.length) changed.push(`Laufzeit-Abhängigkeiten des Servers (${deps.slice(0, 8).join(', ')}${deps.length > 8 ? ', …' : ''})`);
  if (changed.length && minImageVersion !== version) {
    die(`Seit ${prevTag} geändert: ${changed.join(', ')}. Das kommt nur mit einem neuen Image bzw. über install.sh am Host an – MIN_IMAGE_VERSION auf ${version} setzen.`);
  }
}

/* Dateien sammeln */
const files = [];
function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) die(`${rel} fehlt – zuerst „npm run build“ ausführen.`);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) die(`Symbolischer Link im Paket: ${rel}`);
  if (st.isDirectory()) for (const e of fs.readdirSync(abs).sort()) walk(`${rel}/${e}`);
  else if (st.isFile()) files.push(rel);
}
for (const f of ['VERSION', 'package.json', 'package-lock.json', 'LICENSE', 'server/package.json', 'server/update-signing-key.pub', 'web/package.json']) walk(f);
walk('server/dist');
walk('web/dist');
walk('wordpress-plugin/blaulichtcms-bridge');
for (const f of fs.readdirSync(path.join(ROOT, 'server', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) files.push(`server/migrations/${f}`);
for (const f of ['server/dist/api.js', 'server/dist/worker.js', 'server/dist/cli.js', 'server/dist/main.js', 'web/dist/index.html']) if (!files.includes(f)) die(`${f} fehlt – zuerst „npm run build“ ausführen.`);
if (!/^[A-Za-z0-9+/]{43}=$/m.test(read('server/update-signing-key.pub'))) die('server/update-signing-key.pub enthält keinen öffentlichen Schlüssel.');

/* Verbotenes und Geheimnisse */
const SECRET_RE = [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, /BLAULICHTCMS_MASTER_KEY\s*=\s*[A-Za-z0-9+/]{40,}/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bgithub_pat_[A-Za-z0-9_]{60,}\b/];
for (const f of files) {
  const bad = forbiddenPath(f);
  if (bad) die(`${f}: ${bad}.`);
  if (/\.(map|test\.js)$/.test(f)) die(`${f}: Entwicklungsdatei im Paket.`);
  if (/\.(js|mjs|cjs|json|php|txt|md|html|css|sql|pub)$/.test(f)) {
    const text = read(f);
    const hit = SECRET_RE.find((re) => re.test(text));
    if (hit) die(`${f} sieht nach einem Geheimnis aus (${hit.source.slice(0, 30)}…).`);
  }
}

/* Versionshinweise und Manifest */
let notes = arg('--notes') ? fs.readFileSync(arg('--notes'), 'utf8').trim() : '';
// Handgeschriebene Versionshinweise im Repository haben Vorrang vor der Commit-Liste
const notesFile = path.join(ROOT, 'release-notes', `v${version}.md`);
if (!notes && fs.existsSync(notesFile)) notes = fs.readFileSync(notesFile, 'utf8').trim();
if (!notes) {
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const log = git('log', range, '--no-merges', '--format=- %s', '-n', '200');
  notes = `## BlaulichtCMS ${version}\n\n${log || '- Siehe Commit-Verlauf.'}`;
}
const lockText = read('package-lock.json');
const pgMajor = Number(/^FROM postgres:(\d+)/m.exec(read('Dockerfile'))?.[1]) || undefined;
const nodeMajor = Number(/(\d+)/.exec(JSON.parse(read('package.json')).engines?.node ?? '')?.[1]) || undefined;
const manifest = {
  name: 'blaulichtcms',
  version,
  minImageVersion,
  requires: { nodeMajor, postgresMajor: pgMajor, ffmpeg: true },
  lockfileSha256: crypto.createHash('sha256').update(lockText).digest('hex'),
  commit: git('rev-parse', 'HEAD') ?? undefined,
  builtAt: new Date().toISOString(),
  migrations: files.filter((f) => f.startsWith('server/migrations/')).map((f) => path.basename(f)),
};
parseManifest(JSON.stringify(manifest));

/* ZIP schreiben (feste Zeitstempel, sortiert) */
const outDir = path.resolve(arg('--out', path.join(REPO, 'release-out')));
fs.mkdirSync(outDir, { recursive: true });
const name = `blaulichtcms-update-v${version}.zip`;
const zipPath = path.join(outDir, name);
const mtime = new Date('2026-01-01T00:00:00Z');
const zip = new yazl.ZipFile();
const entries = [
  ...files.map((f) => ({ name: f, data: fs.readFileSync(path.join(ROOT, f)) })),
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
  { name: 'release-notes.md', data: Buffer.from(notes + '\n') },
].sort((a, b) => a.name.localeCompare(b.name));
for (const e of entries) zip.addBuffer(e.data, e.name, { mtime, mode: 0o100644, compress: !/\.(br|gz|png|jpg|webp|woff2?)$/.test(e.name) });
zip.end();
await new Promise((resolve, reject) => zip.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', resolve).on('error', reject));

/* Gegenprobe mit denselben Regeln wie bei der Installation */
checkZipEntries(zipEntryInfos(new AdmZip(zipPath)));
const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${digest}  ${name}\n`);
fs.writeFileSync(`${zipPath}.notes.md`, `${notes}\n\n---\n\nSHA-256 von \`${name}\`: \`${digest}\`\n\nInstallation: ${minImageVersion === version ? `neues Image nötig – mit eingerichtetem Update-Helfer unter Einstellungen → Updates & Wartung („Image-Update auf ${version} anstoßen“), sonst am Docker-Host \`sudo bash /opt/apps/blaulichtcms/install.sh\`` : 'Einstellungen → Updates & Wartung (signiert)'}. ${minImageNote(minImageVersion)}\n`);
console.log(`${name}: ${files.length + 2} Dateien, ${Math.round(fs.statSync(zipPath).size / 1024)} KB`);
console.log(`SHA-256 ${digest}`);
