import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { many, one, pool } from '../db/pool.js';
import { classifyStatus, httpRequest, normalizeFingerprint, peekCertificate, transferAllowanceMs, type HttpRequest, type PeerCertificate } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { readSecret } from '../lib/secrets.js';
import { backupDir, verifyBackup } from './backup.js';

/**
 * Sicherung außer Haus (#212) – nach dem Vorbild von LiFeOS (helpers/backup.py: SMB-Freigabe, Aufbewahrung,
 * Wiederherstellung), aber über **WebDAV** statt SMB: WebDAV ist reines HTTPS und braucht im Container kein
 * zusätzliches Werkzeug (smbclient hieße: neues Image). Synology, QNAP, Nextcloud und viele andere NAS bieten
 * WebDAV an.
 *
 * Ablauf nach jeder erfolgreichen Datenbanksicherung (Auftrag `backup.offsite` im Worker):
 *  1. Datei unter `<name>.part` hochladen (gestreamt, PUT),
 *  2. zurücklesen und die SHA-256-Prüfsumme mit der lokalen vergleichen,
 *  3. erst dann auf den endgültigen Namen umbenennen (MOVE) – halbe Dateien tragen nie den Sicherungsnamen,
 *  4. Aufbewahrung auf dem Ziel (täglich/wöchentlich/monatlich) anwenden; gelöscht werden nur Dateien mit dem
 *     Namensmuster von BlaulichtCMS, nie andere Dateien im Ordner.
 *
 * Die Dateien bleiben mit dem Sicherungsschlüssel (aus dem Master-Schlüssel) verschlüsselt (BCBK1, AES-256-GCM) –
 * das NAS sieht nur Chiffrat. Zugangsdaten liegen verschlüsselt in `secrets` und verlassen den Server nie über die API.
 *
 * Netz: Das Ziel liegt meist im eigenen Netz. Der SSRF-Schutz (lib/http.ts) bleibt aktiv; freigegeben wird genau der
 * eingetragene Host (allowPrivateHosts + allowedHosts), keine Weiterleitungen. Selbst signierte Zertifikate werden
 * über einen fest hinterlegten Fingerabdruck angenommen, nie durch Abschalten der Prüfung.
 */

export const OFFSITE_SECRET_OWNER = '00000000-0000-0000-0000-0000000b0212';
/** Namensmuster der Sicherungen (ops/backup.ts) – nur solche Dateien werden auf dem Ziel gelistet oder gelöscht. */
export const BACKUP_NAME = /^blaulichtcms-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-[0-9a-f]{6}\.bcbk$/;
/** Namensmuster der Volume-Sicherungen vom Docker-Host (scripts/backup-volume.sh), Unterordner `volume/` auf dem Ziel. */
export const VOLUME_NAME = /^blaulichtcms-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz\.enc$/;

export interface OffsiteRow {
  enabled: boolean;
  kind: 'webdav';
  url: string;
  username: string;
  secret_id: string | null;
  tls_fingerprint: string;
  keep_daily: number;
  keep_weekly: number;
  keep_monthly: number;
  drill_interval: 'off' | 'weekly' | 'monthly';
  tested_at: Date | null;
  last_ok_at: Date | null;
  last_ok_file: string | null;
  last_error: string | null;
  last_error_at: Date | null;
  updated_at: Date;
}

export async function offsiteConfig(): Promise<OffsiteRow> {
  const row = await one<OffsiteRow>('SELECT * FROM backup_offsite WHERE id = 1');
  if (row) return row;
  await pool.query('INSERT INTO backup_offsite (id) VALUES (1) ON CONFLICT DO NOTHING');
  return (await one<OffsiteRow>('SELECT * FROM backup_offsite WHERE id = 1'))!;
}

/**
 * Zieladresse prüfen und vereinheitlichen: https (in Tests auch http auf 127.0.0.1), ohne Zugangsdaten, Abfrage oder
 * Anker, Pfad endet auf „/“. Liefert die Adresse oder wirft eine verständliche Meldung.
 */
export function normalizeDavUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new StepError('config', 'Bitte eine vollständige Adresse angeben, z. B. https://nas.local:5006/sicherung/blaulichtcms/.');
  }
  const testHttp = !!process.env.VITEST && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !testHttp) throw new StepError('config', 'Nur verschlüsselte Adressen (https://) sind erlaubt – sonst gingen Benutzername und Passwort offen durchs Netz.');
  if (u.username || u.password) throw new StepError('config', 'Benutzername und Passwort bitte in den eigenen Feldern eintragen, nicht in der Adresse.');
  if (u.search || u.hash) throw new StepError('config', 'Die Adresse darf keine Abfrage (?…) und keinen Anker (#…) enthalten.');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

export interface DavTarget {
  url: string;
  username: string;
  password: string;
  fingerprint: string;
}

export async function targetFromConfig(c: OffsiteRow): Promise<DavTarget> {
  if (!c.url) throw new StepError('config', 'Kein Ziel eingetragen.');
  const password = (await readSecret(c.secret_id)) ?? '';
  return { url: c.url, username: c.username, password, fingerprint: c.tls_fingerprint };
}

const fileUrl = (t: DavTarget, name: string) => new URL(encodeURIComponent(name), t.url).toString();

function davRequest(t: DavTarget, method: string, url: string, extra: Partial<HttpRequest> = {}) {
  const host = new URL(t.url).hostname;
  const headers: Record<string, string> = { ...(extra.headers ?? {}) };
  if (t.username || t.password) headers.authorization = `Basic ${Buffer.from(`${t.username}:${t.password}`, 'utf8').toString('base64')}`;
  return httpRequest({
    timeoutMs: 60_000,
    maxResponseBytes: 4_000_000,
    ...extra,
    method,
    url,
    headers,
    followRedirects: false,
    allowPrivateHosts: [host],
    allowedHosts: [host],
    tlsFingerprint256: t.fingerprint || undefined,
  });
}

function davError(res: { status: number; text(): string; headers: Record<string, string>; body: Buffer; url: string; durationMs: number; json(): unknown }, what: string): StepError {
  if (res.status >= 300 && res.status < 400) return new StepError('config', `${what}: Das Ziel leitet weiter (${res.status}). Bitte die genaue WebDAV-Adresse eintragen (Weiterleitungen werden nicht verfolgt).`);
  if (res.status === 404) return new StepError('config', `${what}: Ordner oder Datei auf dem Ziel nicht gefunden (404).`);
  if (res.status === 405) return new StepError('config', `${what}: Das Ziel erlaubt diese WebDAV-Aktion nicht (405). Ist WebDAV am NAS eingeschaltet und die Adresse richtig?`);
  if (res.status === 507) return new StepError('config', `${what}: Auf dem Ziel ist kein Platz mehr (507).`);
  return classifyStatus(res as any, 'Das Sicherungsziel') ?? new StepError('transient', `${what}: unerwartete Antwort ${res.status}.`);
}

export interface RemoteFile {
  name: string;
  size: number | null;
  modified: string | null;
}

/** Antwort auf PROPFIND (Multistatus) lesen – ohne XML-Bibliothek, Präfixe der Namensräume beliebig. */
export function parseMultistatus(xml: string, baseUrl: string): RemoteFile[] {
  const out: RemoteFile[] = [];
  const tag = (name: string) => new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${name}>`, 'i');
  const blocks = xml.split(/<(?:[A-Za-z][\w.-]*:)?response\b[^>]*>/i).slice(1);
  const basePath = new URL(baseUrl).pathname;
  for (const b of blocks) {
    const href = b.match(tag('href'))?.[1]?.trim();
    if (!href) continue;
    let p: string;
    try {
      p = decodeURIComponent(new URL(href.replace(/&amp;/g, '&'), baseUrl).pathname);
    } catch {
      continue;
    }
    if (p.replace(/\/+$/, '') === decodeURIComponent(basePath).replace(/\/+$/, '')) continue;
    const name = path.posix.basename(p.replace(/\/+$/, ''));
    const len = b.match(tag('getcontentlength'))?.[1]?.trim();
    const mod = b.match(tag('getlastmodified'))?.[1]?.trim();
    out.push({ name, size: len && /^\d+$/.test(len) ? Number(len) : null, modified: mod ? new Date(mod).toISOString() : null });
  }
  return out;
}

/** Sicherungen auf dem Ziel (nur Dateien mit dem Namensmuster), neueste zuerst. */
export async function listRemote(t: DavTarget, pattern: RegExp = BACKUP_NAME): Promise<RemoteFile[]> {
  const res = await davRequest(t, 'PROPFIND', t.url, {
    headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
  });
  if (res.status !== 207) throw davError(res, 'Ordner auf dem Ziel lesen');
  return parseMultistatus(res.text(), t.url)
    .filter((f) => pattern.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Grundlaufzeit großer Übertragungen; httpRequest bzw. fetchFile rechnen je nach Größe einen Zuschlag dazu. */
const TRANSFER_BASE_MS = 600_000;

/** Datei hochladen (gestreamt). */
async function putFile(t: DavTarget, local: string, name: string) {
  // Gesamtfrist: 10 Minuten plus Zuschlag nach Dateigröße (httpRequest, rund 1 Mbit/s Mindestdurchsatz)
  const res = await davRequest(t, 'PUT', fileUrl(t, name), { bodyFile: local, headers: { 'content-type': 'application/octet-stream' }, timeoutMs: TRANSFER_BASE_MS });
  if (res.status !== 201 && res.status !== 204 && res.status !== 200) throw davError(res, 'Hochladen');
}

/** Freier Platz im Sicherungsordner abzüglich einer Reserve (für Downloads ohne bekannte Größe); null = unbekannt. */
async function downloadBudget(): Promise<number | null> {
  try {
    const st = await fs.promises.statfs(backupDir());
    return Math.max(0, st.bavail * st.bsize - 512 * 1024 ** 2);
  } catch {
    return null;
  }
}

/**
 * Datei vom Ziel lesen und dabei die SHA-256-Prüfsumme bilden; optional in eine lokale Datei schreiben. Begrenzt
 * (#240): Ist die Größe bekannt (lokale Datei, PROPFIND), darf genau so viel kommen; sonst höchstens der freie Platz
 * im Sicherungsordner abzüglich Reserve – ein fehlerhaftes Ziel kann den Datenträger so nicht füllen.
 */
async function fetchFile(t: DavTarget, name: string, opts: { dest?: string; expectedSize?: number | null } = {}): Promise<{ sha256: string; size: number }> {
  const { dest } = opts;
  const expected = opts.expectedSize != null && Number.isSafeInteger(opts.expectedSize) && opts.expectedSize >= 0 ? opts.expectedSize : null;
  const budget = dest ? await downloadBudget() : null;
  if (dest && expected !== null && budget !== null && expected > budget) {
    throw new StepError('config', `Zu wenig freier Speicher für ${name} (${Math.round(expected / 1024 ** 2)} MB, frei etwa ${Math.round(budget / 1024 ** 2)} MB).`);
  }
  const maxBytes = expected ?? budget ?? 8 * 1024 ** 3;
  const timeoutMs = expected !== null ? TRANSFER_BASE_MS + transferAllowanceMs(expected) : 3_600_000;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const fd = dest ? fs.openSync(dest, 'w', 0o600) : null;
  const sink = new Writable({
    write(chunk: Buffer, _e, cb) {
      hash.update(chunk);
      size += chunk.length;
      if (fd === null) return cb();
      fs.write(fd, chunk, 0, chunk.length, null, (err) => cb(err));
    },
  });
  try {
    const res = await davRequest(t, 'GET', fileUrl(t, name), { sink, timeoutMs, maxResponseBytes: Math.max(1, maxBytes) });
    if (res.status < 200 || res.status >= 300) throw davError(res, 'Zurücklesen');
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  // Zu wenig Daten fallen beim Vergleich der Prüfsumme bzw. beim Entschlüsseln auf (Aufrufer)
  return { sha256: hash.digest('hex'), size };
}

/** Größe einer Datei laut Ordnerliste des Ziels; wirft, wenn sie dort nicht liegt. */
async function remoteSize(t: DavTarget, name: string): Promise<number | null> {
  const f = (await listRemote(t)).find((x) => x.name === name);
  if (!f) throw new StepError('config', `${name} liegt nicht (mehr) auf dem Ziel.`);
  return f.size;
}

async function moveFile(t: DavTarget, from: string, to: string) {
  const res = await davRequest(t, 'MOVE', fileUrl(t, from), { headers: { destination: fileUrl(t, to), overwrite: 'T' } });
  if (res.status !== 201 && res.status !== 204) throw davError(res, 'Umbenennen');
}

async function deleteFile(t: DavTarget, name: string) {
  const res = await davRequest(t, 'DELETE', fileUrl(t, name));
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw davError(res, 'Löschen');
}

/** Zeitpunkt (UTC) aus dem Dateinamen. */
export function stampOf(name: string): Date | null {
  const m = name.match(BACKUP_NAME) ?? name.match(VOLUME_NAME);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${week}`;
}

/**
 * Aufbewahrung nach dem Großvater-Vater-Sohn-Prinzip: je Tag, ISO-Woche und Monat die jeweils neueste Sicherung, für
 * die letzten `daily` Tage, `weekly` Wochen und `monthly` Monate (gezählt werden Tage/Wochen/Monate mit Sicherung).
 * Die neueste Sicherung bleibt immer, ebenso die eben übertragene (`always`). Liefert die zu löschenden Namen; fremde Dateinamen werden nie gewählt.
 */
export function retentionPlan(names: string[], keep: { daily: number; weekly: number; monthly: number }, always: string[] = []): { keep: string[]; remove: string[] } {
  const files = names
    .map((n) => ({ n, at: stampOf(n) }))
    .filter((f): f is { n: string; at: Date } => !!f.at)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.n.localeCompare(a.n));
  const kept = new Set<string>();
  const pick = (count: number, key: (d: Date) => string) => {
    const seen = new Set<string>();
    for (const f of files) {
      const k = key(f.at);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      kept.add(f.n);
    }
  };
  pick(Math.max(1, keep.daily), (d) => d.toISOString().slice(0, 10));
  pick(keep.weekly, isoWeek);
  pick(keep.monthly, (d) => d.toISOString().slice(0, 7));
  if (files[0]) kept.add(files[0].n);
  for (const n of always) kept.add(n);
  return { keep: files.filter((f) => kept.has(f.n)).map((f) => f.n), remove: files.filter((f) => !kept.has(f.n)).map((f) => f.n) };
}

export interface TestResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string }[];
  certificate?: PeerCertificate | null;
  files?: number;
  error?: string;
  hint?: string;
}

/**
 * Verbindungstest vor dem Einschalten: Zertifikat, Anmeldung und Ordner (fehlt der letzte Ordner, wird er angelegt),
 * Probedatei schreiben, zurücklesen und vergleichen, löschen. Schreibt nichts außer der kurzlebigen Probedatei.
 */
export async function testTarget(t: DavTarget): Promise<TestResult> {
  const steps: TestResult['steps'] = [];
  let certificate: PeerCertificate | null = null;
  const u = new URL(t.url);
  try {
    if (u.protocol === 'https:') {
      certificate = await peekCertificate(t.url, { allowPrivateHosts: [u.hostname] });
      if (t.fingerprint) {
        const okPin = normalizeFingerprint(t.fingerprint) === certificate.fingerprint256;
        steps.push({ step: 'Zertifikat (hinterlegter Fingerabdruck)', ok: okPin, detail: okPin ? undefined : 'Fingerabdruck stimmt nicht' });
        if (!okPin) return { ok: false, steps, certificate, error: 'Das Zertifikat des Ziels passt nicht zum hinterlegten Fingerabdruck.', hint: 'Fingerabdruck unten mit dem am NAS angezeigten vergleichen und bei Übereinstimmung übernehmen.' };
      } else {
        steps.push({ step: 'Zertifikat', ok: certificate.trusted, detail: certificate.trusted ? undefined : certificate.error ?? undefined });
        if (!certificate.trusted) {
          return {
            ok: false,
            steps,
            certificate,
            error: 'Das Zertifikat des Ziels ist nicht vertrauenswürdig (z. B. selbst signiert).',
            hint: 'Entweder am NAS ein gültiges Zertifikat einrichten oder den unten angezeigten Fingerabdruck am NAS vergleichen und übernehmen.',
          };
        }
      }
    }
    let res = await davRequest(t, 'PROPFIND', t.url, { headers: { depth: '0' } });
    if (res.status === 404) {
      const mk = await davRequest(t, 'MKCOL', t.url);
      if (mk.status !== 201) throw davError(mk, 'Ordner anlegen');
      steps.push({ step: 'Ordner angelegt', ok: true });
      res = await davRequest(t, 'PROPFIND', t.url, { headers: { depth: '0' } });
    }
    if (res.status !== 207) throw davError(res, 'Anmelden und Ordner öffnen');
    steps.push({ step: 'Anmeldung und Ordner', ok: true });
    const probe = `.blaulichtcms-test-${crypto.randomBytes(4).toString('hex')}`;
    const tmp = path.join(backupDir(), `${probe}.tmp`);
    fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
    const data = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try {
      await putFile(t, tmp, probe);
      steps.push({ step: 'Probedatei schreiben', ok: true });
      const back = await fetchFile(t, probe, { expectedSize: data.length });
      const same = back.sha256 === crypto.createHash('sha256').update(data).digest('hex');
      steps.push({ step: 'Zurücklesen und Prüfsumme vergleichen', ok: same });
      await deleteFile(t, probe);
      steps.push({ step: 'Probedatei löschen', ok: true });
      if (!same) return { ok: false, steps, certificate, error: 'Die zurückgelesene Probedatei weicht ab.' };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const files = (await listRemote(t)).length;
    return { ok: true, steps, certificate, files };
  } catch (e) {
    const err = e instanceof StepError ? e : new StepError('transient', (e as Error).message);
    steps.push({ step: 'Abbruch', ok: false, detail: err.technical?.slice(0, 200) });
    return { ok: false, steps, certificate, error: err.message, hint: err.hint };
  }
}

/** Alles nach einer Übertragung: Aufbewahrung auf dem Ziel. Fehler beim Aufräumen sind nicht fatal. */
async function applyRetention(t: DavTarget, c: OffsiteRow, pattern: RegExp, justUploaded: string): Promise<number> {
  const names = (await listRemote(t, pattern)).map((f) => f.name);
  const plan = retentionPlan(names, { daily: c.keep_daily, weekly: c.keep_weekly, monthly: c.keep_monthly }, [justUploaded]);
  let removed = 0;
  for (const n of plan.remove) {
    try {
      await deleteFile(t, n);
      removed++;
    } catch (e) {
      log('warn', 'backup', `Sicherung außer Haus: ${n} ließ sich auf dem Ziel nicht löschen: ${(e as Error).message}`);
    }
  }
  return removed;
}

/**
 * Auftrag `backup.offsite`: eine lokale, geprüfte Sicherung auf das Ziel übertragen, Prüfsumme kontrollieren,
 * Aufbewahrung anwenden. Beim letzten Versuch wird der Fehler vermerkt und gemeldet.
 */
export async function uploadBackup(backupId: string, attempt: { final: boolean } = { final: true }) {
  const c = await offsiteConfig();
  if (!c.enabled || !c.url) {
    await pool.query(`UPDATE backups SET offsite_status = NULL WHERE id = $1 AND offsite_status = 'pending'`, [backupId]);
    return;
  }
  const b = await one<{ id: string; file_name: string; sha256: string | null; status: string }>('SELECT id, file_name, sha256, status FROM backups WHERE id = $1', [backupId]);
  if (!b || b.status !== 'ok') return;
  const local = path.join(backupDir(), path.basename(b.file_name));
  if (!fs.existsSync(local)) {
    await pool.query(`UPDATE backups SET offsite_status = 'failed', offsite_error = 'Lokale Datei nicht mehr vorhanden' WHERE id = $1`, [backupId]);
    return;
  }
  try {
    const t = await targetFromConfig(c);
    const sha = b.sha256 ?? crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    const part = `${b.file_name}.part`;
    await putFile(t, local, part);
    const back = await fetchFile(t, part, { expectedSize: fs.statSync(local).size });
    if (back.sha256 !== sha) {
      await deleteFile(t, part).catch(() => {});
      throw new StepError('transient', 'Prüfsumme der hochgeladenen Datei weicht ab – Übertragung wird wiederholt.');
    }
    await moveFile(t, part, b.file_name);
    await pool.query(`UPDATE backups SET offsite_status = 'ok', offsite_at = now(), offsite_error = NULL WHERE id = $1`, [backupId]);
    await pool.query(`UPDATE backup_offsite SET last_ok_at = now(), last_ok_file = $1, last_error = NULL, last_error_at = NULL WHERE id = 1`, [b.file_name]);
    const removed = await applyRetention(t, c, BACKUP_NAME, b.file_name);
    log('info', 'backup', `Sicherung außer Haus übertragen und geprüft: ${b.file_name}${removed ? ` (${removed} ältere auf dem Ziel entfernt)` : ''}`);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 1000);
    if (attempt.final) {
      await pool.query(`UPDATE backups SET offsite_status = 'failed', offsite_error = $2 WHERE id = $1`, [backupId, msg]);
      await pool.query(`UPDATE backup_offsite SET last_error = $1, last_error_at = now() WHERE id = 1`, [msg]);
      log('error', 'backup', `Sicherung außer Haus fehlgeschlagen: ${msg}`);
      await notify({ kind: 'error', title: 'Sicherung außer Haus fehlgeschlagen', body: msg.slice(0, 300), link: '/einstellungen#sicherung-ausser-haus', permission: 'backup.manage' });
    }
    throw e;
  }
}

/** Nach einer erfolgreichen Sicherung die Übertragung einplanen (nur wenn ein Ziel eingeschaltet ist). */
export async function scheduleUpload(backupId: string) {
  const c = await offsiteConfig();
  if (!c.enabled) return false;
  const { enqueue } = await import('../jobs/queue.js');
  await pool.query(`UPDATE backups SET offsite_status = 'pending', offsite_error = NULL WHERE id = $1`, [backupId]);
  await enqueue('backup.offsite', { backupId }, { dedupKey: `backup.offsite:${backupId}`, maxAttempts: 4 });
  return true;
}

/**
 * Eine Sicherung vom Ziel auf diesen Server holen (Notfall, z. B. nach Verlust der lokalen Sicherungen): in den
 * Sicherungsordner laden, Wiederherstellbarkeit prüfen (entschlüsseln, Inhaltsverzeichnis) und in die Liste der
 * Sicherungen aufnehmen – von dort lässt sie sich herunterladen, als Probe einspielen oder zurückspielen.
 */
export async function fetchRemoteBackup(name: string, userId: string | null): Promise<{ id: string; fileName: string; size: number }> {
  if (!BACKUP_NAME.test(name)) throw new StepError('config', 'Unbekannter Dateiname.');
  const existing = await one<{ id: string }>(`SELECT id FROM backups WHERE file_name = $1 AND status = 'ok'`, [name]);
  if (existing && fs.existsSync(path.join(backupDir(), name))) throw new StepError('conflict', 'Diese Sicherung liegt bereits auf dem Server.');
  const c = await offsiteConfig();
  const t = await targetFromConfig(c);
  fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir(), name);
  const part = `${dest}.holen`;
  try {
    const got = await fetchFile(t, name, { dest: part, expectedSize: await remoteSize(t, name) });
    fs.renameSync(part, dest);
    await verifyBackup(dest);
    const row = existing
      ? await one<{ id: string }>(`UPDATE backups SET size_bytes = $2, sha256 = $3 WHERE id = $1 RETURNING id`, [existing.id, got.size, got.sha256])
      : await one<{ id: string }>(
          `INSERT INTO backups (file_name, status, trigger, created_by, finished_at, size_bytes, sha256, offsite_status, offsite_at) VALUES ($1,'ok','offsite',$2,now(),$3,$4,'ok',now()) RETURNING id`,
          [name, userId, got.size, got.sha256],
        );
    return { id: row!.id, fileName: name, size: got.size };
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (!existing) fs.rmSync(dest, { force: true });
    throw e;
  }
}

/** Unterordner für die Volume-Sicherungen; wird bei Bedarf angelegt. */
async function volumeTarget(t: DavTarget): Promise<DavTarget> {
  const v = { ...t, url: new URL('volume/', t.url).toString() };
  const res = await davRequest(v, 'PROPFIND', v.url, { headers: { depth: '0' } });
  if (res.status === 404) {
    const mk = await davRequest(v, 'MKCOL', v.url);
    if (mk.status !== 201) throw davError(mk, 'Ordner „volume“ anlegen');
  } else if (res.status !== 207) throw davError(res, 'Ordner „volume“ öffnen');
  return v;
}

/**
 * Volume-Sicherung vom Docker-Host (Medien, Datenbank, Schlüsselmaterial – mit dem Sicherungsschlüssel des Hosts
 * verschlüsselt) außer Haus ablegen: `backup-cron.sh` reicht die Datei per Standardeingabe an
 * `cli.js offsite-volume` durch; Zugangsdaten verlassen den Container dabei nicht. Gleiche Prüfung (Prüfsumme der
 * `.sha256`-Datei) und gleiche Aufbewahrung wie bei den Datenbanksicherungen, im Unterordner `volume/`.
 * Liefert null, wenn kein Ziel eingeschaltet ist.
 */
export async function uploadVolumeStream(name: string, size: number, sha256: string, input: NodeJS.ReadableStream): Promise<{ removed: number } | null> {
  if (!VOLUME_NAME.test(name)) throw new StepError('config', 'Unbekannter Dateiname einer Volume-Sicherung.');
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new StepError('config', 'Prüfsumme (SHA-256) fehlt oder ist ungültig.');
  if (!Number.isSafeInteger(size) || size <= 0) throw new StepError('config', 'Ungültige Dateigröße.');
  const c = await offsiteConfig();
  if (!c.enabled || !c.url) return null;
  try {
    const t = await volumeTarget(await targetFromConfig(c));
    const part = `${name}.part`;
    const hash = crypto.createHash('sha256');
    let seen = 0;
    // Prüfsumme beim Durchreichen bilden (Gegendruck bleibt erhalten, nichts geht verloren, bevor die Verbindung steht)
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        hash.update(chunk);
        seen += chunk.length;
        cb(null, chunk);
      },
    });
    input.on('error', (e: Error) => tap.destroy(e));
    input.pipe(tap);
    const res = await davRequest(t, 'PUT', fileUrl(t, part), {
      bodyStream: tap,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
      timeoutMs: TRANSFER_BASE_MS,
    });
    if (res.status !== 201 && res.status !== 204 && res.status !== 200) throw davError(res, 'Hochladen');
    if (seen !== size || hash.digest('hex') !== sha256.toLowerCase()) {
      await deleteFile(t, part).catch(() => {});
      throw new StepError('invalid_payload', 'Die übergebene Datei passt nicht zu Größe bzw. Prüfsumme der Sicherung.');
    }
    const back = await fetchFile(t, part, { expectedSize: size });
    if (back.sha256 !== sha256.toLowerCase()) {
      await deleteFile(t, part).catch(() => {});
      throw new StepError('transient', 'Prüfsumme der hochgeladenen Volume-Sicherung weicht ab.');
    }
    await moveFile(t, part, name);
    await pool.query(`UPDATE backup_offsite SET last_ok_at = now(), last_ok_file = COALESCE(last_ok_file, $1), last_error = NULL, last_error_at = NULL WHERE id = 1`, [name]);
    const removed = await applyRetention(t, c, VOLUME_NAME, name);
    log('info', 'backup', `Volume-Sicherung außer Haus übertragen und geprüft: ${name}${removed ? ` (${removed} ältere auf dem Ziel entfernt)` : ''}`);
    return { removed };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 1000);
    await pool.query(`UPDATE backup_offsite SET last_error = $1, last_error_at = now() WHERE id = 1`, [`Volume-Sicherung: ${msg}`]);
    log('error', 'backup', `Volume-Sicherung außer Haus fehlgeschlagen: ${msg}`);
    await notify({ kind: 'error', title: 'Volume-Sicherung außer Haus fehlgeschlagen', body: msg.slice(0, 300), link: '/einstellungen#sicherung-ausser-haus', permission: 'backup.manage' });
    throw e;
  }
}

/** Volume-Sicherungen auf dem Ziel (Unterordner `volume/`), neueste zuerst; leer, wenn der Ordner fehlt. */
export async function listRemoteVolumes(t: DavTarget): Promise<RemoteFile[]> {
  const v = { ...t, url: new URL('volume/', t.url).toString() };
  try {
    return await listRemote(v, VOLUME_NAME);
  } catch (e) {
    if (e instanceof StepError && /404/.test(e.message)) return [];
    throw e;
  }
}

/** Datei vom Ziel für eine Probe-Wiederherstellung in eine temporäre Datei laden. */
export async function downloadForDrill(name: string, dest: string): Promise<{ sha256: string; size: number }> {
  if (!BACKUP_NAME.test(name)) throw new StepError('config', 'Unbekannter Dateiname.');
  const t = await targetFromConfig(await offsiteConfig());
  return fetchFile(t, name, { dest, expectedSize: await remoteSize(t, name) });
}

/** Lokale Sicherungen, deren Übertragung noch aussteht oder fehlschlug (für den Status). */
export async function offsiteSummary() {
  const c = await offsiteConfig();
  const pending = await many<{ n: number }>(`SELECT count(*)::int AS n FROM backups WHERE offsite_status = 'pending'`);
  return { enabled: c.enabled, url: c.url, lastOkAt: c.last_ok_at, lastOkFile: c.last_ok_file, lastError: c.last_error, lastErrorAt: c.last_error_at, pending: pending[0]?.n ?? 0 };
}
