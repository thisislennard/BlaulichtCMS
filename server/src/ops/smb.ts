import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StepError, type ErrorClass } from '../lib/errors.js';

/**
 * SMB-Freigabe als Ziel der Sicherung außer Haus – über **smbclient** (Samba-Client im Image), wie LiFeOS
 * (helpers/backup.py, hose_sync.py). Für Windows-Server, DFS-Namensräume und NAS im eigenen Netz.
 *
 * - Kein Einhängen (der Container hat keine Capabilities): jeder Schritt ist ein eigener smbclient-Aufruf mit genau
 *   einem Befehl. smbclient arbeitet die Befehle in `-c` auch nach einem Fehler weiter ab – deshalb nie mehrere
 *   Befehle in einem Aufruf und der Ordner nur über `-D` (scheitert der Wechsel, bricht smbclient ab).
 * - Passwort nur über die Umgebungsvariable `PASSWD` des Kindprozesses, nie auf der Kommandozeile (`ps`).
 * - smbclient trennt `-c` an jedem „;“ – auch in Anführungszeichen. In Befehle kommen deshalb nur Dateinamen nach den
 *   Mustern der Sicherungen bzw. der Probedatei und lokale Pfade im Sicherungsordner, geprüft von `smbQuote()`.
 *   Server, Freigabe und Ordner werden beim Speichern und vor jedem Aufruf streng geprüft (`parseUnc()`).
 * - Eigene smb.conf unter /tmp (das Dateisystem des Containers ist schreibgeschützt): Namen nur über DNS/hosts
 *   (keine NetBIOS-Rundrufe), mindestens SMB 2.
 */

export interface SmbTarget {
  kind: 'smb';
  /** kanonischer UNC-Pfad \\server\freigabe\ordner – Anzeige, Vergleich, Hinweise auf frühere Ziele */
  url: string;
  server: string;
  share: string;
  /** Ordner unterhalb der Freigabe (einzelne Namen) */
  dir: string[];
  domain: string;
  username: string;
  password: string;
}

const SERVER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const SHARE_RE = /^[\p{L}\p{N}_$.-][\p{L}\p{N}_ $.-]{0,79}$/u;
const SEGMENT_RE = /^[\p{L}\p{N}_ .()+,&@#=~$-]{1,120}$/u;
const DOMAIN_RE = /^[\p{L}\p{N}._-]{1,100}$/u;
const USER_RE = /^[\p{L}\p{N}._@ $\\-]{1,100}$/u;

const configError = (message: string, hint?: string) => new StepError('config', message, { hint });

/**
 * UNC-Pfad prüfen und vereinheitlichen: `\\server\freigabe\ordner`, auch mit „/“ oder als `smb://server/freigabe/…`.
 * Liefert Server, Freigabe, Ordner und die kanonische Schreibweise oder wirft eine verständliche Meldung.
 */
export function parseUnc(raw: string): { url: string; server: string; share: string; dir: string[] } {
  let s = String(raw ?? '').trim();
  const smbUrl = /^smb:\/\//i.test(s);
  if (smbUrl) s = s.slice(6);
  s = s.replace(/\//g, '\\');
  if (!smbUrl && !s.startsWith('\\\\')) throw configError('Bitte den Pfad als UNC-Pfad angeben, z. B. \\\\server\\freigabe\\sicherung\\blaulichtcms.');
  const parts = s.replace(/^\\+/, '').split('\\').filter((p) => p !== '');
  const [server = '', share = '', ...dir] = parts;
  if (!server || !share) throw configError('Im Pfad fehlen Server oder Freigabe – Beispiel: \\\\server\\freigabe\\sicherung\\blaulichtcms.');
  if (!SERVER_RE.test(server)) throw configError(`Der Servername „${server}“ ist ungültig – erlaubt sind ein Name (z. B. nas.example.org) oder eine IPv4-Adresse.`);
  if (!SHARE_RE.test(share)) throw configError(`Der Freigabename „${share}“ enthält unzulässige Zeichen.`);
  if (dir.length > 20) throw configError('Der Pfad ist zu tief verschachtelt (höchstens 20 Ordner).');
  for (const d of dir) {
    if (d === '.' || d === '..' || !SEGMENT_RE.test(d) || /[ .]$/.test(d)) throw configError(`Der Ordnername „${d}“ enthält unzulässige Zeichen.`);
  }
  return { url: `\\\\${server}\\${share}${dir.map((d) => `\\${d}`).join('')}`, server, share, dir };
}

/** Domäne und Benutzername prüfen (kein „%“ – smbclient trennt daran das Passwort ab). */
export function checkSmbAccount(domain: string, username: string) {
  if (domain && !DOMAIN_RE.test(domain)) throw configError('Die Domäne enthält unzulässige Zeichen (erlaubt: Buchstaben, Ziffern, Punkt, Bindestrich).');
  if (username && !USER_RE.test(username)) throw configError('Der Benutzername enthält unzulässige Zeichen.');
  if (domain && username.includes('\\')) throw configError('Die Domäne bitte entweder im eigenen Feld oder im Benutzernamen (DOMÄNE\\name) angeben, nicht in beiden.');
}

/** Wert für ein smbclient-Skript in Anführungszeichen setzen; lehnt alles ab, was das Skript aufbrechen könnte. */
export function smbQuote(value: string): string {
  if (!value || /[;"'`\r\n\t\0]/.test(value)) throw new StepError('internal', `Unzulässige Zeichen für smbclient: ${JSON.stringify(value)}`);
  return `"${value}"`;
}

const SMB_DIR = () => path.join(os.tmpdir(), 'blaulichtcms-smb');

/** smb.conf für die Aufrufe (einmal je Prozess angelegt, wieder angelegt, falls /tmp geleert wurde). */
function smbConf(): string {
  const base = SMB_DIR();
  const conf = path.join(base, 'smb.conf');
  if (fs.existsSync(conf)) return conf;
  for (const d of ['cache', 'lock', 'state', 'private', 'ncalrpc']) fs.mkdirSync(path.join(base, d), { recursive: true, mode: 0o700 });
  const text = [
    '[global]',
    `  cache directory = ${base}/cache`,
    `  lock directory = ${base}/lock`,
    `  state directory = ${base}/state`,
    `  private dir = ${base}/private`,
    `  ncalrpc dir = ${base}/ncalrpc`,
    '  client min protocol = SMB2_02',
    '  name resolve order = host',
    '  unix charset = UTF-8',
    '',
  ].join('\n');
  const tmp = `${conf}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, conf);
  return conf;
}

/** Programm: smbclient – in Tests ein Stellvertreter (Node-Skript), der dieselbe Schnittstelle spielt. */
function command(): { file: string; pre: string[] } {
  const fake = process.env.VITEST ? process.env.BLAULICHTCMS_SMBCLIENT_FAKE : undefined;
  return fake ? { file: process.execPath, pre: [fake] } : { file: 'smbclient', pre: [] };
}

export interface SmbRun {
  code: number;
  out: string;
  /** erster NT_STATUS-Code der Ausgabe (z. B. NT_STATUS_LOGON_FAILURE) */
  status: string | null;
}

/** Einen smbclient-Befehl ausführen; `dir` = Ordner unterhalb der Freigabe (Standard: der Zielordner). */
export function runSmb(t: SmbTarget, script: string, opts: { dir?: string[]; timeoutMs?: number } = {}): Promise<SmbRun> {
  // Sicherheitsnetz vor jedem Aufruf – auch für gespeicherte Werte
  parseUnc(t.url);
  checkSmbAccount(t.domain, t.username);
  const dir = opts.dir ?? t.dir;
  const args = [`//${t.server}/${t.share}`, '-s', smbConf(), '-t', '120'];
  if (t.username) args.push('-U', t.domain ? `${t.domain}\\${t.username}` : t.username);
  else args.push('-N');
  if (dir.length) args.push('-D', dir.join('\\'));
  args.push('-c', script);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    HOME: SMB_DIR(),
    KRB5CCNAME: `FILE:${path.join(SMB_DIR(), 'krb5cc')}`,
    ...(t.username ? { PASSWD: t.password } : {}),
    ...(process.env.VITEST ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FAKE_SMB_'))) : {}),
  };
  const { file, pre } = command();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    let out = '';
    let timedOut = false;
    const child = spawn(file, [...pre, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const take = (d: Buffer) => {
      if (out.length < 200_000) out += d.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') reject(new StepError('config', 'smbclient fehlt auf diesem Server. SMB-Ziele brauchen ein aktuelles BlaulichtCMS-Image.', { hint: 'Am Docker-Host einmal „sudo bash install.sh“ ausführen (neues Image) oder ein WebDAV-Ziel verwenden.' }));
      else reject(new StepError('transient', `smbclient ließ sich nicht starten: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new StepError('transient', 'Die SMB-Freigabe hat nicht rechtzeitig geantwortet (Zeitüberschreitung).', { technical: out.slice(-500) }));
      resolve({ code: code ?? 1, out, status: out.match(/NT_STATUS_[A-Z0-9_]+/)?.[0] ?? null });
    });
  });
}

const STATUS: Record<string, [ErrorClass, string]> = {
  NT_STATUS_LOGON_FAILURE: ['auth', 'Anmeldung abgelehnt – Benutzername, Passwort und Domäne prüfen.'],
  NT_STATUS_WRONG_PASSWORD: ['auth', 'Anmeldung abgelehnt – Benutzername, Passwort und Domäne prüfen.'],
  NT_STATUS_NO_SUCH_USER: ['auth', 'Anmeldung abgelehnt – Benutzername, Passwort und Domäne prüfen.'],
  NT_STATUS_ACCOUNT_LOCKED_OUT: ['auth', 'Das Konto ist gesperrt.'],
  NT_STATUS_ACCOUNT_DISABLED: ['auth', 'Das Konto ist deaktiviert.'],
  NT_STATUS_PASSWORD_EXPIRED: ['auth', 'Das Passwort des Kontos ist abgelaufen.'],
  NT_STATUS_PASSWORD_MUST_CHANGE: ['auth', 'Das Passwort des Kontos muss geändert werden.'],
  NT_STATUS_ACCESS_DENIED: ['permission', 'Keine Berechtigung – das Konto braucht Lese- und Schreibrecht auf diesen Ordner.'],
  NT_STATUS_BAD_NETWORK_NAME: ['config', 'Diese Freigabe gibt es auf dem Server nicht – Namen der Freigabe prüfen.'],
  NT_STATUS_OBJECT_NAME_NOT_FOUND: ['config', 'Ordner oder Datei auf der Freigabe nicht gefunden.'],
  NT_STATUS_OBJECT_PATH_NOT_FOUND: ['config', 'Ordner auf der Freigabe nicht gefunden.'],
  NT_STATUS_DISK_FULL: ['config', 'Auf dem Ziel ist kein Platz mehr.'],
  NT_STATUS_QUOTA_EXCEEDED: ['config', 'Das Kontingent des Kontos auf dem Ziel ist erschöpft.'],
  NT_STATUS_SHARING_VIOLATION: ['transient', 'Die Datei auf dem Ziel ist gerade in Benutzung.'],
  NT_STATUS_HOST_UNREACHABLE: ['transient', 'Der Server ist nicht erreichbar (Adresse, Netz und Port 445 prüfen).'],
  NT_STATUS_NETWORK_UNREACHABLE: ['transient', 'Der Server ist nicht erreichbar (Adresse, Netz und Port 445 prüfen).'],
  NT_STATUS_CONNECTION_REFUSED: ['transient', 'Der Server nimmt keine Verbindung an (Port 445, Firewall prüfen).'],
  NT_STATUS_IO_TIMEOUT: ['transient', 'Der Server antwortet nicht (Adresse, Netz und Port 445 prüfen).'],
  NT_STATUS_CONNECTION_RESET: ['transient', 'Die Verbindung zum Server wurde unterbrochen.'],
  NT_STATUS_CONNECTION_DISCONNECTED: ['transient', 'Die Verbindung zum Server wurde unterbrochen.'],
  NT_STATUS_UNSUCCESSFUL: ['transient', 'Verbindung zum Server fehlgeschlagen – Servernamen bzw. Adresse prüfen.'],
  NT_STATUS_NOT_SUPPORTED: ['config', 'Der Server unterstützt die Anfrage nicht (mindestens SMB 2 nötig).'],
  NT_STATUS_INVALID_NETWORK_RESPONSE: ['config', 'Ungültige Antwort des Servers – mindestens SMB 2 nötig.'],
};

/** Ordner fehlt (beim Wechsel mit -D) – der Test legt dann den letzten Ordner an. */
export const MISSING_DIR = new Set(['NT_STATUS_OBJECT_NAME_NOT_FOUND', 'NT_STATUS_OBJECT_PATH_NOT_FOUND']);

/** Fehler eines Aufrufs als verständliche Meldung. */
export function smbError(r: SmbRun, what: string): StepError {
  const known = r.status ? STATUS[r.status] : undefined;
  const technical = r.out.trim().split('\n').slice(-6).join('\n').slice(-500);
  if (known) return new StepError(known[0], `${what}: ${known[1]}`, { technical });
  return new StepError('transient', `${what}: smbclient meldet ${r.status ?? `Fehler (Exit ${r.code})`}.`, { technical });
}

export interface SmbFile {
  name: string;
  size: number | null;
  modified: string | null;
  directory: boolean;
}

/** Zeilen von `ls` lesen: „  name   A   1234  Wed Nov 19 22:30:01 2026“ (Namen ohne Leerzeichen genügen hier). */
export function parseSmbLs(out: string): SmbFile[] {
  const files: SmbFile[] = [];
  const re = /^\s+(\S+)\s+([A-Z]*)\s+(\d+)\s+(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s*$/;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m || m[1] === '.' || m[1] === '..') continue;
    const d = new Date(`${m[5]} ${m[6]} ${m[8]} ${m[7]}`);
    files.push({ name: m[1], size: Number(m[3]), modified: Number.isNaN(d.getTime()) ? null : d.toISOString(), directory: m[2].includes('D') });
  }
  return files;
}

const fail = async (p: Promise<SmbRun>, what: string, ok: (r: SmbRun) => boolean = (r) => r.code === 0) => {
  const r = await p;
  if (!ok(r)) throw smbError(r, what);
  return r;
};

/** Dateien im Ordner nach Muster (nur Dateien; fehlt jede Datei, ist die Liste leer). */
export async function smbList(t: SmbTarget, pattern: RegExp): Promise<SmbFile[]> {
  const r = await runSmb(t, 'ls "blaulichtcms-*"');
  if (r.code !== 0 && r.status === 'NT_STATUS_NO_SUCH_FILE') return [];
  if (r.code !== 0) throw smbError(r, 'Ordner auf dem Ziel lesen');
  return parseSmbLs(r.out).filter((f) => !f.directory && pattern.test(f.name));
}

/**
 * Ordner öffnen: 'ok', 'missing' (Anmeldung und Freigabe gingen, der Ordner fehlt) oder Fehler. Prüft zusätzlich
 * mit `pwd`, dass smbclient wirklich im Zielordner steht und nicht in der Wurzel der Freigabe.
 */
export async function smbOpenDir(t: SmbTarget): Promise<'ok' | 'missing'> {
  const r = await runSmb(t, 'pwd');
  if (r.code !== 0 && r.status && MISSING_DIR.has(r.status)) return 'missing';
  if (r.code !== 0) throw smbError(r, 'Anmelden und Ordner öffnen');
  const cur = r.out.match(/Current directory is (.*)$/m)?.[1]?.trim() ?? '';
  if (t.dir.length && /^\\\\[^\\]+\\[^\\]+\\?$/.test(cur)) throw new StepError('internal', 'smbclient steht nicht im Zielordner – Abbruch, um nichts in der Wurzel der Freigabe abzulegen.', { technical: cur });
  return 'ok';
}

export async function smbMkdir(t: SmbTarget, parent: string[], name: string) {
  await fail(runSmb(t, `mkdir ${smbQuote(name)}`, { dir: parent }), 'Ordner anlegen', (r) => r.code === 0 || r.status === 'NT_STATUS_OBJECT_NAME_COLLISION');
}

export async function smbPut(t: SmbTarget, local: string, name: string, timeoutMs: number) {
  await fail(runSmb(t, `put ${smbQuote(local)} ${smbQuote(name)}`, { timeoutMs }), 'Hochladen');
}

export async function smbGet(t: SmbTarget, name: string, local: string, timeoutMs: number) {
  await fail(runSmb(t, `get ${smbQuote(name)} ${smbQuote(local)}`, { timeoutMs }), 'Zurücklesen');
}

export async function smbDelete(t: SmbTarget, name: string) {
  await fail(runSmb(t, `del ${smbQuote(name)}`), 'Löschen', (r) => r.code === 0 || r.status === 'NT_STATUS_NO_SUCH_FILE' || r.status === 'NT_STATUS_OBJECT_NAME_NOT_FOUND');
}

/** Umbenennen; liegt unter dem Zielnamen schon eine Datei (abgebrochener früherer Versuch), wird sie ersetzt. */
export async function smbRename(t: SmbTarget, from: string, to: string) {
  const r = await runSmb(t, `rename ${smbQuote(from)} ${smbQuote(to)}`);
  if (r.code === 0) return;
  if (r.status !== 'NT_STATUS_OBJECT_NAME_COLLISION') throw smbError(r, 'Umbenennen');
  await smbDelete(t, to);
  await fail(runSmb(t, `rename ${smbQuote(from)} ${smbQuote(to)}`), 'Umbenennen');
}

/** Unterordner als eigenes Ziel (z. B. `volume`). */
export const smbSub = (t: SmbTarget, name: string): SmbTarget => ({ ...t, dir: [...t.dir, name], url: `${t.url}\\${name}` });
