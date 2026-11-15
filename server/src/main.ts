import crypto from 'node:crypto';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { supervisorPidFile } from './ops/datadir.js';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './updates/core.js';
import { readPending, releaseDirProblem, releasesDir, resolveActiveRoot, writeActivation, writePending, writePointer, type PendingActivation } from './updates/releases.js';

/**
 * Supervisor (PID 1 im Container, über tini).
 *
 * Reihenfolge beim Start:  PostgreSQL → API → Worker
 * Reihenfolge beim Stopp:  Worker → API → PostgreSQL (geordneter, schneller Shutdown)
 *
 * PostgreSQL läuft nur, wenn BLAULICHTCMS_EMBEDDED_DB=true (im Image gesetzt). Es hört ausschließlich auf
 * einem Unix-Socket im Container (listen_addresses = ''), der Datenbestand liegt unter /data/postgres.
 * Abgestürzte Prozesse werden mit wachsender Wartezeit neu gestartet.
 *
 * In-App-Updates (updates/installer.ts): API und Worker laufen aus dem aktiven Release unter /data/releases/<version>,
 * wenn es gültig und NEUER als der Code des Images ist – sonst aus dem Image (veralteter Zeiger wird entfernt). Auf den
 * Umschaltauftrag der API hin: API/Worker stoppen, Migrationen der neuen Version, neue Version starten, auf Bereitschaft
 * warten; bei jedem Fehler Rückweg (Sicherung zurückspielen, falls Migrationen liefen, Zeiger zurück, alte Version
 * starten). Der Supervisor selbst kommt immer aus dem Image.
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.resolve(process.env.BLAULICHTCMS_DATA_DIR ?? path.join(APP_ROOT, 'data'));
const EMBEDDED = ['1', 'true', 'yes'].includes(String(process.env.BLAULICHTCMS_EMBEDDED_DB ?? '').toLowerCase());
const PG_DATA = path.join(DATA_DIR, 'postgres');
const PG_SOCKET_DIR = process.env.BLAULICHTCMS_PG_SOCKET_DIR ?? '/tmp/blaulichtcms-pg';
const PG_BIN = process.env.BLAULICHTCMS_PG_BIN ?? findPgBin();
const PG_DB = 'blaulichtcms';
/** Bootstrap-Superuser des Clusters: nur Supervisor, Migrationsschritt und Wartung (#102). */
const PG_USER = 'blaulichtcms';
/** Laufzeitrolle für API und Worker (ohne Superuser, nur DML, wird beim Migrationsschritt eingerichtet). */
const PG_APP_USER = 'blaulichtcms_app';
const pgUrl = (user: string) => `postgresql://${user}@localhost/${PG_DB}?host=${encodeURIComponent(PG_SOCKET_DIR)}`;

/** Code, aus dem API, Worker und Migrationen laufen (Image oder aktives Release). */
let activeRoot = APP_ROOT;
let activeVersion = '?';
/** Umschaltung auf ein Release läuft – kein automatischer Neustart abgestürzter Prozesse. */
let switching = false;
const READY_TIMEOUT_MS = Number(process.env.BLAULICHTCMS_ACTIVATION_TIMEOUT_MS ?? 180_000) || 180_000;

type Role = 'api' | 'worker';
const children = new Map<Role, ChildProcess>();
let postgres: ChildProcess | null = null;
let shuttingDown = false;
/** API und Worker angehalten (Wartung, z. B. Schlüsselwechsel per SIGUSR1/SIGUSR2) – kein automatischer Neustart. */
let paused = false;
const crashes: Record<string, number[]> = { api: [], worker: [], postgres: [] };

function say(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, source: 'supervisor', message: msg }));
}

function findPgBin(): string {
  const base = '/usr/lib/postgresql';
  try {
    const versions = fs.readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return path.join(base, versions[0], 'bin');
  } catch {
    /* nicht installiert */
  }
  return '';
}

function backoff(name: string): number {
  const now = Date.now();
  crashes[name] = [...crashes[name].filter((t) => now - t < 300_000), now];
  return Math.min(30_000, 1_000 * 2 ** Math.min(5, crashes[name].length - 1));
}

/* ------------------------------------ Geheimnisse ------------------------------------ */

/** Erzeugt beim ersten Start einen eigenen Master-Schlüssel, falls keiner per Umgebung gesetzt ist. */
function ensureMasterKey() {
  if (process.env.BLAULICHTCMS_MASTER_KEY?.trim()) return;
  const dir = path.join(DATA_DIR, 'secrets');
  const file = path.join(dir, 'master.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    say(`Neuer Master-Schlüssel erzeugt (${file}). Er gehört zu jeder Sicherung – getrennt aufbewahren.`, 'warn');
  }
}

/* ------------------------------------ PostgreSQL ------------------------------------- */

function pgVersionOfBinaries(): string {
  const r = spawnSync(path.join(PG_BIN, 'postgres'), ['--version'], { encoding: 'utf8' });
  return /(\d+)\.\d+/.exec(r.stdout ?? '')?.[1] ?? '';
}

function initDatabaseCluster() {
  const version = path.join(PG_DATA, 'PG_VERSION');
  if (fs.existsSync(version)) {
    const dataMajor = fs.readFileSync(version, 'utf8').trim();
    const binMajor = pgVersionOfBinaries();
    if (binMajor && dataMajor !== binMajor) {
      throw new Error(
        `Der Datenbestand stammt von PostgreSQL ${dataMajor}, das Image enthält PostgreSQL ${binMajor}. ` +
          `Ein Hauptversionswechsel braucht eine geplante Migration (siehe docs/betrieb.md, Abschnitt „PostgreSQL-Hauptversion“). ` +
          `Bitte das vorherige Image weiterverwenden.`,
      );
    }
    return false;
  }
  say('Erster Start: Datenbank wird angelegt …');
  fs.mkdirSync(PG_DATA, { recursive: true, mode: 0o700 });
  const r = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', PG_DATA, '-U', PG_USER, '--auth-local=trust', '--auth-host=reject', '-E', 'UTF8', '--locale=C.UTF-8'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`initdb fehlgeschlagen: ${r.stderr || r.stdout}`);
  // Nur Unix-Socket (Verzeichnis 0700, gehört dem BlaulichtCMS-Benutzer), keine TCP-Verbindungen
  fs.writeFileSync(path.join(PG_DATA, 'pg_hba.conf'), `# BlaulichtCMS: nur lokaler Socket im Container\nlocal all all trust\n`, { mode: 0o600 });
  fs.appendFileSync(
    path.join(PG_DATA, 'postgresql.conf'),
    `\n# BlaulichtCMS\nlisten_addresses = ''\nunix_socket_permissions = 0700\nmax_connections = 60\nshared_buffers = 128MB\nlogging_collector = off\nlog_min_messages = warning\n`,
  );
  return true;
}

function waitForSocket(timeoutMs: number): Promise<boolean> {
  const sock = path.join(PG_SOCKET_DIR, '.s.PGSQL.5432');
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const c = net.connect(sock);
      c.once('connect', () => {
        c.destroy();
        const r = spawnSync(path.join(PG_BIN, 'pg_isready'), ['-h', PG_SOCKET_DIR, '-U', PG_USER, '-d', 'postgres'], { encoding: 'utf8' });
        if (r.status === 0) return resolve(true);
        retry();
      });
      c.once('error', () => retry());
    };
    const retry = () => (Date.now() > until ? resolve(false) : setTimeout(attempt, 300));
    attempt();
  });
}

/**
 * Verwaiste postgres-Prozesse (Postmaster tot, Backends laufen) beenden: SIGQUIT, nach 5 s SIGKILL. Nur Linux (/proc).
 * Betroffen sind ausschließlich Prozesse, deren Arbeitsverzeichnis unser Datenverzeichnis ist (so arbeitet jedes
 * PostgreSQL-Backend) – andere PostgreSQL-Instanzen auf demselben Rechner bleiben unberührt.
 */
async function stopOrphanBackends() {
  let dataDir: string;
  try {
    dataDir = fs.realpathSync(PG_DATA);
  } catch {
    return;
  }
  const list = () => {
    try {
      return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid).filter((d) => {
        try {
          return fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim() === 'postgres' && fs.readlinkSync(`/proc/${d}/cwd`) === dataDir;
        } catch {
          return false;
        }
      }).map(Number);
    } catch {
      return [];
    }
  };
  let pids = list();
  if (!pids.length) return;
  say(`${pids.length} verwaiste PostgreSQL-Prozesse gefunden – werden beendet.`, 'warn');
  for (const p of pids) try { process.kill(p, 'SIGQUIT'); } catch { /* schon weg */ }
  for (let i = 0; i < 50 && (pids = list()).length; i++) await new Promise((r) => setTimeout(r, 100));
  for (const p of pids) try { process.kill(p, 'SIGKILL'); } catch { /* schon weg */ }
}

async function startPostgres(): Promise<void> {
  fs.mkdirSync(PG_SOCKET_DIR, { recursive: true, mode: 0o700 });
  // postmaster.pid NIE löschen (#61): Ist der Postmaster weg, erkennt PostgreSQL die veraltete Datei selbst und prüft
  // über den darin vermerkten Shared-Memory-Schlüssel, ob noch verwaiste Backends am Datenverzeichnis hängen. Solche
  // Waisen (z. B. nach OOM-Abbruch des Postmasters) werden hier geordnet beendet, damit der Neustart gelingt.
  const pid = path.join(PG_DATA, 'postmaster.pid');
  if (fs.existsSync(pid)) {
    const n = Number(fs.readFileSync(pid, 'utf8').split(/\r?\n/)[0]);
    let alive = false;
    try {
      if (n) process.kill(n, 0), (alive = true);
    } catch {
      alive = false;
    }
    if (!alive) await stopOrphanBackends();
  }
  // Laufzeit-Tuning für typische SSD-Hosts; gilt auch für bestehende Datenbestände
  const tuning = ['-c', 'random_page_cost=1.1', '-c', 'effective_io_concurrency=100', '-c', 'effective_cache_size=512MB', '-c', 'work_mem=8MB', '-c', 'maintenance_work_mem=64MB', '-c', 'jit=off'];
  postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', PG_DATA, '-k', PG_SOCKET_DIR, ...tuning], { stdio: ['ignore', 'inherit', 'inherit'] });
  const child = postgres;
  child.on('exit', (code, signal) => {
    if (postgres !== child) return;
    postgres = null;
    if (shuttingDown) return;
    say(`PostgreSQL beendet (${code ?? signal}) – API und Worker werden angehalten und neu gestartet`, 'error');
    void restartEverything();
  });
  return waitForSocket(60_000).then((ok) => {
    if (!ok) throw new Error('PostgreSQL ist nicht innerhalb von 60 Sekunden bereit geworden.');
  });
}

function ensureDatabase() {
  const psql = (sql: string, db = 'postgres') => spawnSync(path.join(PG_BIN, 'psql'), ['-h', PG_SOCKET_DIR, '-U', PG_USER, '-d', db, '-tAc', sql], { encoding: 'utf8' });
  const exists = psql(`SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'`);
  if (exists.status !== 0) throw new Error(`Datenbankprüfung fehlgeschlagen: ${exists.stderr}`);
  if (exists.stdout.trim() !== '1') {
    const r = psql(`CREATE DATABASE ${PG_DB} OWNER ${PG_USER} ENCODING 'UTF8'`);
    if (r.status !== 0) throw new Error(`Datenbank konnte nicht angelegt werden: ${r.stderr}`);
    say(`Datenbank „${PG_DB}“ angelegt.`);
  }
}

function stopPostgres(timeoutMs = 30_000): Promise<void> {
  const p = postgres;
  postgres = null;
  if (!p || p.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => p.kill('SIGQUIT'), timeoutMs);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.kill('SIGINT'); // „fast shutdown“: offene Transaktionen werden sauber zurückgerollt
  });
}

/* ------------------------------------ API / Worker ----------------------------------- */

function childEnv(role: Role): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BLAULICHTCMS_ROLE: role,
    BLAULICHTCMS_DATA_DIR: DATA_DIR,
    BLAULICHTCMS_SUPERVISED: '1',
    BLAULICHTCMS_IMAGE_ROOT: APP_ROOT,
    BLAULICHTCMS_IMAGE_VERSION: readVersion(APP_ROOT),
  };
  if (EMBEDDED) env.DATABASE_URL = pgUrl(PG_APP_USER);
  return env;
}

function readVersion(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    return '?';
  }
}

function spawnRole(role: Role): ChildProcess {
  const child = fork(path.join(activeRoot, 'server', 'dist', `${role}.js`), [], { cwd: activeRoot, env: childEnv(role), stdio: 'inherit' });
  if (role === 'api') child.on('message', (m: any) => onApiMessage(m));
  child.on('exit', (code, signal) => {
    if (children.get(role) !== child) return;
    children.delete(role);
    if (shuttingDown || paused || switching) return;
    const delay = backoff(role);
    say(`${role} beendet (${code ?? signal}) – Neustart in ${Math.round(delay / 1000)} s`, 'warn');
    setTimeout(() => {
      if (!shuttingDown && !paused && !switching && !children.has(role) && (!EMBEDDED || postgres)) children.set(role, spawnRole(role));
    }, delay);
  });
  return child;
}

/* ------------------------------------ Schema-Migration ------------------------------- */

/**
 * Eigener Schritt vor dem Start der API: Startprüfung (Datenstand nicht neuer als das Programm) und fehlende
 * Migrationen. Schlägt das fehl, startet BlaulichtCMS nicht – PostgreSQL läuft weiter (für Sicherung/Wiederherstellung),
 * und auf dem Webport erscheint eine klare Meldung statt einer halb funktionierenden Anwendung.
 */
function cliEnv(): NodeJS.ProcessEnv {
  // Als Superuser: richtet die Rollen ein, Migrationen laufen als Eigentümerrolle (db/roles.ts)
  return { ...childEnv('api'), BLAULICHTCMS_ROLE: 'migrate', BLAULICHTCMS_CLI_DELEGATED: '1', ...(EMBEDDED ? { DATABASE_ADMIN_URL: pgUrl(PG_USER) } : {}) };
}

/** Kommandozeile eines Programmstands ausführen (Ausgabe gesammelt). */
function runCli(root: string, args: string[], timeoutMs = 30 * 60_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = fork(path.join(root, 'server', 'dist', 'cli.js'), args, { cwd: root, env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (e) => (output += `\n${e.message}`));
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

/** Migrationen des Programmstands `root`; liefert auch, welche Migrationen dabei angewendet wurden. */
async function runMigrations(root = activeRoot): Promise<{ ok: boolean; output: string; applied: string[] }> {
  const r = await runCli(root, ['migrate']);
  const applied = [...r.output.matchAll(/Migration angewendet: (\S+)/g)].map((m) => m[1]);
  return { ok: r.ok, output: r.output.slice(-2000), applied };
}

let blockedServer: http.Server | null = null;
function serveBlocked(reason: string, hint = 'Die Daten sind unverändert. Rückweg: vorheriges Image starten und die Sicherung von vor dem Update wiederherstellen (docs/betrieb.md, Abschnitt „Rückweg nach fehlgeschlagenem Update“).') {
  const port = Number(process.env.PORT ?? 7310);
  const body = { ok: false, blocked: true, error: reason, hint };
  blockedServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/healthz') || req.url?.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    res.end(`<!doctype html><meta charset="utf-8"><title>BlaulichtCMS startet nicht</title><body style="font-family:system-ui;max-width:720px;margin:48px auto;padding:0 16px;line-height:1.5"><h1>BlaulichtCMS startet nicht</h1><p>${esc(reason)}</p><p>${esc(hint)}</p></body>`);
  });
  blockedServer.listen(port, '0.0.0.0');
}

/** API zuerst, dann Worker. */
function waitReady(child: ChildProcess, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    const onMsg = (m: any) => m?.type === 'ready' && done(true);
    const onExit = () => done(false);
    function done(ok: boolean) {
      clearTimeout(timer);
      child.off('message', onMsg);
      child.off('exit', onExit);
      resolve(ok);
    }
    child.on('message', onMsg);
    child.once('exit', onExit);
  });
}

/** Startet API und Worker aus `activeRoot`; true, wenn sich beide rechtzeitig bereit gemeldet haben. */
async function startApp(timeoutMs = 120_000): Promise<boolean> {
  const api = spawnRole('api');
  children.set('api', api);
  const ok = await waitReady(api, timeoutMs);
  if (!ok) say('API hat sich nicht bereit gemeldet – Worker wird trotzdem gestartet.', 'warn');
  if (shuttingDown || paused) return false;
  const worker = spawnRole('worker');
  children.set('worker', worker);
  const wok = await waitReady(worker, timeoutMs);
  return ok && wok;
}

/* ------------------------------------ In-App-Update ---------------------------------- */

/** Datenbank und Schema der laufenden API über /healthz (lokal mit Details). */
async function healthyAfterStart(timeoutMs: number): Promise<string | null> {
  const port = Number(process.env.PORT ?? 7310);
  const until = Date.now() + timeoutMs;
  let last = 'keine Antwort';
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
      const h = (await r.json()) as any;
      if (h?.checks?.database?.ok && h?.checks?.schema?.ok && h?.checks?.worker?.ok) return null;
      last = Object.entries(h?.checks ?? {}).filter(([, v]: any) => !v.ok).map(([k, v]: any) => `${k}: ${v.detail ?? 'Fehler'}`).join(', ') || `Status ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last;
}

function lastLine(text: string, fallback: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? fallback;
}

function onApiMessage(m: any) {
  if (m?.type !== 'activate-release' || typeof m.version !== 'string') return;
  if (switching || shuttingDown || paused) return say('Umschaltauftrag abgelehnt: es läuft bereits eine Umschaltung oder Wartung.', 'warn');
  // Kurz warten, damit die API ihre Antwort an die Oberfläche noch ausliefert
  setTimeout(() => activate(m.version).catch((e) => say(`Umschaltung fehlgeschlagen: ${(e as Error).message}`, 'error')), 1_000);
}

/**
 * Umschaltung auf ein geprüftes Release. Jeder Fehler führt zum Rückweg: Sicherung zurückspielen (nur wenn
 * Migrationen der neuen Version angewendet wurden), Zeiger zurück, vorige Version migrieren und starten.
 */
async function activate(version: string) {
  const pending = readPending(DATA_DIR);
  const dir = path.join(releasesDir(DATA_DIR), version);
  const problem = !pending || pending.version !== version
    ? 'kein passender Umschaltauftrag'
    : compareVersions(version, activeVersion) <= 0
      ? `Version ${version} ist nicht neuer als ${activeVersion}`
      : releaseDirProblem(dir, DATA_DIR, version, readVersion(APP_ROOT));
  if (problem) {
    say(`Umschaltung auf ${version} abgelehnt: ${problem}`, 'error');
    writePending(DATA_DIR, null);
    writeActivation(DATA_DIR, { ...(pending ?? {}), status: 'rolled_back', version, from: activeVersion, message: `Umschaltung abgelehnt: ${problem}. Es läuft weiter ${activeVersion}.`, restored: false });
    children.get('api')?.send({ type: 'activation-result' });
    return;
  }
  switching = true;
  const prev = { root: activeRoot, version: activeVersion };
  say(`Umschaltung ${prev.version} → ${version}: API und Worker werden gestoppt.`, 'warn');
  await stopApp();
  const target = fs.realpathSync(dir);
  writePointer(DATA_DIR, { version, path: target, previous: prev.root === APP_ROOT ? null : { version: prev.version, path: prev.root } });
  activeRoot = target;
  activeVersion = version;
  const mig = await runMigrations(target);
  if (!mig.ok) {
    const reason = lastLine(mig.output, 'Schema-Migration fehlgeschlagen.');
    return rollback(prev, pending!, `Migration der Version ${version} fehlgeschlagen: ${reason}`, mig.applied.length > 0);
  }
  say(`Version ${version}: ${mig.applied.length ? `Migrationen ${mig.applied.join(', ')}` : 'keine neuen Migrationen'} – starte API und Worker.`);
  const ready = await startApp(READY_TIMEOUT_MS);
  const unhealthy = ready
    ? await healthyAfterStart(60_000)
    : !children.has('api')
      ? 'die API ist beim Start abgebrochen (Einzelheiten im Container-Protokoll)'
      : !children.has('worker')
        ? 'der Worker ist beim Start abgebrochen (Einzelheiten im Container-Protokoll)'
        : `API oder Worker haben sich nicht innerhalb von ${Math.round(READY_TIMEOUT_MS / 1000)} s bereit gemeldet`;
  if (unhealthy) return rollback(prev, pending!, `Version ${version} startet nicht: ${unhealthy}`, mig.applied.length > 0);
  writePending(DATA_DIR, null);
  writeActivation(DATA_DIR, { ...pending!, status: 'activated', version, from: prev.version, message: mig.applied.length ? `Migrationen: ${mig.applied.join(', ')}` : 'Keine neuen Migrationen.', restored: false });
  switching = false;
  children.get('api')?.send({ type: 'activation-result' });
  say(`Version ${version} läuft.`);
}

async function rollback(prev: { root: string; version: string }, pending: PendingActivation, reason: string, restore: boolean) {
  say(`${reason} – Rückweg auf ${prev.version}${restore ? ' mit Wiederherstellung der Sicherung' : ''}.`, 'error');
  await stopApp();
  let restored = false;
  let restoreError = '';
  if (restore) {
    if (!pending.backupFile) restoreError = 'keine Sicherung vermerkt';
    else {
      // Kommandozeile der VORIGEN Version: kennt deren Schema und Schlüssel
      const r = await runCli(prev.root, ['update-restore', path.join(DATA_DIR, 'backups', path.basename(pending.backupFile))]);
      restored = r.ok;
      if (!r.ok) restoreError = lastLine(r.output, 'Zurückspielen fehlgeschlagen');
    }
  }
  writePointer(DATA_DIR, prev.root === APP_ROOT ? null : { version: prev.version, path: prev.root, previous: null });
  activeRoot = prev.root;
  activeVersion = prev.version;
  writePending(DATA_DIR, null);
  const message = `${reason}. Es läuft wieder ${prev.version}.${restore ? (restored ? ` Datenbank aus der Sicherung ${pending.backupFile} zurückgespielt.` : ` ACHTUNG: Sicherung nicht zurückgespielt (${restoreError}).`) : ' Die Datenbank war unverändert.'}`;
  writeActivation(DATA_DIR, { ...pending, status: 'rolled_back', version: pending.version, from: prev.version, message, restored });
  const mig = await runMigrations(prev.root);
  switching = false;
  if (!mig.ok) {
    const why = lastLine(mig.output, 'Schema-Migration fehlgeschlagen.');
    say(`Rückweg: vorige Version startet nicht: ${why}`, 'error');
    serveBlocked(`Update auf ${pending.version} fehlgeschlagen und Rückweg unvollständig: ${why}`, 'Die Sicherung von vor dem Update liegt unter /data/backups. Vorgehen: docs/betrieb.md, Abschnitt „In-App-Update: Rückweg von Hand“.');
    return;
  }
  await startApp();
  say(`Rückweg abgeschlossen: ${prev.version} läuft.`, 'warn');
}

function stopRole(role: Role, timeoutMs: number): Promise<void> {
  const c = children.get(role);
  children.delete(role);
  if (!c || c.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

async function stopApp() {
  await stopRole('worker', 25_000);
  await stopRole('api', 10_000);
}

let restarting = false;
async function restartEverything() {
  if (restarting || shuttingDown) return;
  restarting = true;
  await stopApp();
  const delay = backoff('postgres');
  await new Promise((r) => setTimeout(r, delay));
  try {
    await startPostgres();
    if (!paused) await startApp();
  } catch (e) {
    say(`Neustart fehlgeschlagen: ${(e as Error).message}`, 'error');
    restarting = false;
    return void setTimeout(restartEverything, 5_000);
  }
  restarting = false;
}

function selectActiveRoot() {
  const a = resolveActiveRoot(APP_ROOT, DATA_DIR);
  if (a.dropPointer) {
    say(`Installiertes Update wird nicht verwendet: ${a.dropPointer}. Es läuft der Code des Images.`, 'warn');
    writePointer(DATA_DIR, null);
  }
  activeRoot = a.root;
  activeVersion = a.version;
  return a;
}

async function main() {
  const version = readVersion(APP_ROOT);
  say(`BlaulichtCMS ${version} startet (Daten: ${DATA_DIR}, interne Datenbank: ${EMBEDDED ? 'ja' : 'nein'})`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureMasterKey();
  const active = selectActiveRoot();
  if (active.source === 'update') say(`Programmstand: installiertes Update ${active.version} (${active.root}); Image ${version}.`);
  // Auftrag aus einem unterbrochenen Lauf (Container während der Umschaltung beendet) verwerfen
  const interrupted = readPending(DATA_DIR);
  if (interrupted) {
    // Container während einer Umschaltung beendet: Ergebnis vermerken (die API beendet dann auch den Wartungsmodus)
    const took = active.version === interrupted.version;
    say(`Unterbrochene Umschaltung auf ${interrupted.version} gefunden – es läuft ${active.version}.`, 'warn');
    writePending(DATA_DIR, null);
    writeActivation(DATA_DIR, {
      ...interrupted,
      status: took ? 'activated' : 'rolled_back',
      from: interrupted.from,
      message: took
        ? 'Die Umschaltung wurde durch einen Neustart des Containers unterbrochen; die neue Version wurde beim Start übernommen. Bitte Funktion prüfen.'
        : `Die Umschaltung wurde durch einen Neustart des Containers unterbrochen; es läuft ${active.version}.`,
      restored: false,
    });
  }
  if (EMBEDDED) {
    if (!PG_BIN) throw new Error('PostgreSQL-Programme wurden nicht gefunden (BLAULICHTCMS_PG_BIN setzen).');
    initDatabaseCluster();
    await startPostgres();
    ensureDatabase();
    say('PostgreSQL bereit (nur Unix-Socket im Container).');
  }
  const mig = await runMigrations();
  if (!mig.ok) {
    const reason = mig.output.split('\n').filter(Boolean).pop() ?? 'Schema-Migration fehlgeschlagen.';
    say(`Start gesperrt: ${reason}`, 'error');
    serveBlocked(reason);
    return;
  }
  if (mig.output) say(mig.output.split('\n').pop()!);
  try {
    fs.writeFileSync(supervisorPidFile(), String(process.pid), { mode: 0o600 });
  } catch {
    /* ohne PID-Datei kein Anhalten für den Schlüsselwechsel */
  }
  await startApp();
}

/**
 * Wartung ohne Neustart des Containers (#134): SIGUSR1 hält API und Worker an (PostgreSQL läuft weiter), SIGUSR2
 * startet sie wieder – dabei lesen sie Konfiguration und Master-Schlüssel neu. Genutzt von `cli.js rotate-master-key`.
 */
process.on('SIGUSR1', async () => {
  if (paused || shuttingDown || switching) return;
  paused = true;
  say('Wartung: API und Worker werden angehalten (PostgreSQL läuft weiter).', 'warn');
  await stopApp();
  say('API und Worker angehalten.');
});
process.on('SIGUSR2', async () => {
  if (!paused || shuttingDown) return;
  paused = false;
  say('Wartung beendet: API und Worker starten neu.');
  if (!EMBEDDED || postgres) await startApp();
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    say(`${sig} empfangen – geordneter Stopp: Worker → API → Datenbank`);
    blockedServer?.close();
    await stopApp();
    await stopPostgres();
    say('Gestoppt.');
    process.exit(0);
  });
}

main().catch(async (e) => {
  say(`Start fehlgeschlagen: ${(e as Error).message}`, 'error');
  shuttingDown = true;
  await stopApp();
  await stopPostgres();
  process.exit(1);
});
