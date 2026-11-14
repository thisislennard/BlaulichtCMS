import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPointer, readVersionAt, resolveActiveRoot, writePointer } from './updates/releases.js';
import { writeActivation } from './updates/installer.js';

/**
 * Supervisor (PID 1 im Container, über tini). Startet API und Worker aus der aktiven
 * Programmversion, startet abgestürzte Prozesse neu und schaltet nach einem Update um.
 * Startet die neue Version nicht innerhalb von 2 Minuten, wird automatisch auf die vorige
 * Version zurückgeschaltet (Rollback).
 */
const IMAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.resolve(process.env.LIFELINK_DATA_DIR ?? path.join(IMAGE_ROOT, 'data'));
const READY_TIMEOUT_MS = 120_000;

type Role = 'api' | 'worker';
const children = new Map<Role, ChildProcess>();
let activeRoot = '';
let activeVersion = '';
let shuttingDown = false;
let switching = false;
const crashes: Record<Role, number[]> = { api: [], worker: [] };

function say(msg: string) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', source: 'supervisor', message: msg }));
}

function spawnRole(role: Role, root: string): ChildProcess {
  const child = fork(path.join(root, 'server', 'dist', `${role}.js`), [], {
    cwd: root,
    env: { ...process.env, LIFELINK_ROLE: role, LIFELINK_DATA_DIR: DATA_DIR, LIFELINK_IMAGE_VERSION: readVersionAt(IMAGE_ROOT) ?? '' },
    stdio: 'inherit',
  });
  child.on('message', (m: any) => onMessage(role, m));
  child.on('exit', (code, signal) => {
    if (children.get(role) !== child) return;
    children.delete(role);
    if (shuttingDown || switching) return;
    say(`${role} beendet (Code ${code ?? signal}) – Neustart`);
    const now = Date.now();
    crashes[role] = [...crashes[role].filter((t) => now - t < 300_000), now];
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, crashes[role].length - 1));
    setTimeout(() => !shuttingDown && !switching && children.set(role, spawnRole(role, activeRoot)), delay);
  });
  return child;
}

function stopAll(timeoutMs = 25_000): Promise<void> {
  const list = [...children.values()];
  children.clear();
  return Promise.all(
    list.map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null) return resolve();
          const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
          c.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
          c.kill('SIGTERM');
        }),
    ),
  ).then(() => undefined);
}

function startAll(root: string) {
  activeRoot = root;
  activeVersion = readVersionAt(root) ?? '?';
  children.set('api', spawnRole('api', root));
  children.set('worker', spawnRole('worker', root));
}

/** Wartet darauf, dass die API der neuen Version „ready“ meldet. */
function waitReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const api = children.get('api');
    if (!api) return resolve(false);
    const timer = setTimeout(() => done(false), READY_TIMEOUT_MS);
    const onMsg = (m: any) => m?.type === 'ready' && done(true);
    const onExit = () => done(false);
    function done(ok: boolean) {
      clearTimeout(timer);
      api!.off('message', onMsg);
      api!.off('exit', onExit);
      resolve(ok);
    }
    api.on('message', onMsg);
    api.once('exit', onExit);
  });
}

async function activate(version: string, newRoot: string) {
  if (switching) return;
  switching = true;
  const from = activeVersion;
  const previous = { version: activeVersion, path: activeRoot };
  say(`Schalte auf Version ${version} um (${newRoot})`);
  await stopAll();
  writePointer(DATA_DIR, { version, path: newRoot, previous });
  startAll(newRoot);
  const ok = await waitReady();
  if (ok) {
    writeActivation(DATA_DIR, { status: 'activated', version, from });
    children.get('api')?.send({ type: 'activation-written' });
    say(`Version ${version} läuft.`);
    switching = false;
    return;
  }
  say(`Version ${version} ist nicht gestartet – Rollback auf ${previous.version}`);
  await stopAll(10_000);
  const prevPointer = readPointer(DATA_DIR)?.previous ?? null;
  // Zurück auf die vorige Version (Image oder älteres Update)
  writePointer(DATA_DIR, prevPointer && prevPointer.path !== IMAGE_ROOT ? { version: prevPointer.version, path: prevPointer.path, previous: null } : null);
  writeActivation(DATA_DIR, { status: 'rolled_back', version, from, message: `Version ${version} ist beim Start abgebrochen oder hat sich nicht innerhalb von ${READY_TIMEOUT_MS / 1000} s gemeldet. Es läuft wieder ${previous.version}. Details im Container-Protokoll (docker compose logs lifelink).` });
  startAll(previous.path);
  switching = false;
}

function onMessage(role: Role, m: any) {
  if (role === 'api' && m?.type === 'activate-release' && typeof m.version === 'string' && typeof m.path === 'string') {
    // Nur Ordner unterhalb von <data>/releases akzeptieren
    const rel = path.relative(path.join(DATA_DIR, 'releases'), m.path);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return say('Umschaltung abgelehnt: unerwarteter Pfad.');
    setTimeout(() => activate(m.version, m.path).catch((e) => say(`Umschaltung fehlgeschlagen: ${e.message}`)), 1_500);
  }
}

const start = resolveActiveRoot(IMAGE_ROOT, DATA_DIR);
say(`LifeLink ${start.version} (${start.source === 'update' ? 'installiertes Update' : 'Image'})`);
startAll(start.root);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    shuttingDown = true;
    await stopAll();
    process.exit(0);
  });
}
