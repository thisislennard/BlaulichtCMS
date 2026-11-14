import crypto from 'node:crypto';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Supervisor (PID 1 im Container, über tini).
 *
 * Reihenfolge beim Start:  PostgreSQL → API → Worker
 * Reihenfolge beim Stopp:  Worker → API → PostgreSQL (geordneter, schneller Shutdown)
 *
 * PostgreSQL läuft nur, wenn LIFELINK_EMBEDDED_DB=true (im Image gesetzt). Es hört ausschließlich auf
 * einem Unix-Socket im Container (listen_addresses = ''), der Datenbestand liegt unter /data/postgres.
 * Abgestürzte Prozesse werden mit wachsender Wartezeit neu gestartet.
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.resolve(process.env.LIFELINK_DATA_DIR ?? path.join(APP_ROOT, 'data'));
const EMBEDDED = ['1', 'true', 'yes'].includes(String(process.env.LIFELINK_EMBEDDED_DB ?? '').toLowerCase());
const PG_DATA = path.join(DATA_DIR, 'postgres');
const PG_SOCKET_DIR = process.env.LIFELINK_PG_SOCKET_DIR ?? '/tmp/lifelink-pg';
const PG_BIN = process.env.LIFELINK_PG_BIN ?? findPgBin();
const PG_DB = 'lifelink';
const PG_USER = 'lifelink';

type Role = 'api' | 'worker';
const children = new Map<Role, ChildProcess>();
let postgres: ChildProcess | null = null;
let shuttingDown = false;
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
  if (process.env.LIFELINK_MASTER_KEY?.trim()) return;
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
  // Nur Unix-Socket (Verzeichnis 0700, gehört dem LifeLink-Benutzer), keine TCP-Verbindungen
  fs.writeFileSync(path.join(PG_DATA, 'pg_hba.conf'), `# LifeLink: nur lokaler Socket im Container\nlocal all all trust\n`, { mode: 0o600 });
  fs.appendFileSync(
    path.join(PG_DATA, 'postgresql.conf'),
    `\n# LifeLink\nlisten_addresses = ''\nunix_socket_permissions = 0700\nmax_connections = 60\nshared_buffers = 128MB\nlogging_collector = off\nlog_min_messages = warning\n`,
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

function startPostgres(): Promise<void> {
  fs.mkdirSync(PG_SOCKET_DIR, { recursive: true, mode: 0o700 });
  // Übrig gebliebene PID-Datei nach hartem Abbruch (Container gekillt) entfernen, wenn kein Prozess mehr läuft
  const pid = path.join(PG_DATA, 'postmaster.pid');
  if (fs.existsSync(pid)) {
    const n = Number(fs.readFileSync(pid, 'utf8').split('\n')[0]);
    let alive = false;
    try {
      if (n) process.kill(n, 0), (alive = true);
    } catch {
      alive = false;
    }
    if (!alive) fs.rmSync(pid, { force: true });
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
  const env: NodeJS.ProcessEnv = { ...process.env, LIFELINK_ROLE: role, LIFELINK_DATA_DIR: DATA_DIR };
  if (EMBEDDED) env.DATABASE_URL = `postgresql://${PG_USER}@localhost/${PG_DB}?host=${encodeURIComponent(PG_SOCKET_DIR)}`;
  return env;
}

function spawnRole(role: Role): ChildProcess {
  const child = fork(path.join(APP_ROOT, 'server', 'dist', `${role}.js`), [], { cwd: APP_ROOT, env: childEnv(role), stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (children.get(role) !== child) return;
    children.delete(role);
    if (shuttingDown) return;
    const delay = backoff(role);
    say(`${role} beendet (${code ?? signal}) – Neustart in ${Math.round(delay / 1000)} s`, 'warn');
    setTimeout(() => {
      if (!shuttingDown && !children.has(role) && (!EMBEDDED || postgres)) children.set(role, spawnRole(role));
    }, delay);
  });
  return child;
}

/* ------------------------------------ Schema-Migration ------------------------------- */

/**
 * Eigener Schritt vor dem Start der API: Startprüfung (Datenstand nicht neuer als das Programm) und fehlende
 * Migrationen. Schlägt das fehl, startet LifeLink nicht – PostgreSQL läuft weiter (für Sicherung/Wiederherstellung),
 * und auf dem Webport erscheint eine klare Meldung statt einer halb funktionierenden Anwendung.
 */
function runMigrations(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = fork(path.join(APP_ROOT, 'server', 'dist', 'cli.js'), ['migrate'], { cwd: APP_ROOT, env: childEnv('api'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('exit', (code) => resolve({ ok: code === 0, output: output.trim().slice(-2000) }));
  });
}

let blockedServer: http.Server | null = null;
function serveBlocked(reason: string) {
  const port = Number(process.env.PORT ?? 7310);
  const body = { ok: false, blocked: true, error: reason, hint: 'Siehe docs/betrieb.md, Abschnitt „Rückweg nach fehlgeschlagenem Update“.' };
  blockedServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/healthz') || req.url?.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    res.end(`<!doctype html><meta charset="utf-8"><title>LifeLink startet nicht</title><body style="font-family:system-ui;max-width:720px;margin:48px auto;padding:0 16px;line-height:1.5"><h1>LifeLink startet nicht</h1><p>${esc(reason)}</p><p>Die Daten sind unverändert. Rückweg: vorheriges Image starten <strong>und</strong> die Sicherung von vor dem Update wiederherstellen (docs/betrieb.md).</p></body>`);
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

async function startApp() {
  const api = spawnRole('api');
  children.set('api', api);
  const ok = await waitReady(api);
  if (!ok) say('API hat sich nicht bereit gemeldet – Worker wird trotzdem gestartet.', 'warn');
  if (!shuttingDown) children.set('worker', spawnRole('worker'));
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
    await startApp();
  } catch (e) {
    say(`Neustart fehlgeschlagen: ${(e as Error).message}`, 'error');
    restarting = false;
    return void setTimeout(restartEverything, 5_000);
  }
  restarting = false;
}

async function main() {
  const version = (() => {
    try {
      return fs.readFileSync(path.join(APP_ROOT, 'VERSION'), 'utf8').trim();
    } catch {
      return '?';
    }
  })();
  say(`LifeLink ${version} startet (Daten: ${DATA_DIR}, interne Datenbank: ${EMBEDDED ? 'ja' : 'nein'})`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureMasterKey();
  if (EMBEDDED) {
    if (!PG_BIN) throw new Error('PostgreSQL-Programme wurden nicht gefunden (LIFELINK_PG_BIN setzen).');
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
  await startApp();
}

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
