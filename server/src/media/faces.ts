import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_ROOT } from '../config.js';
import { one, pool, tx, type Queryable } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { log } from '../lib/log.js';
import { getSettings } from '../lib/settings.js';
import type { DetectResult, FaceHit } from './face-runner.js';
import { imagePixelLimit } from './process.js';
import { mediaPaths } from './storage.js';

/**
 * Gesichtsvorschläge (#214): Nach der Prüfung eines Bildes sucht der Worker (Auftrag „media.faces“) mit YuNet nach
 * Gesichtern und legt sie als **Vorschläge** am Medium ab (`media.face_proposals`). Ein Mensch übernimmt oder verwirft
 * sie im Datenschutz-Dialog; erst übernommene Vorschläge werden zu unkenntlich gemachten Bereichen (`redactions`) und
 * damit Teil der öffentlichen Fassung. Die Suche ändert nie selbst die öffentliche Fassung.
 *
 * Datenschutz: gespeichert werden nur Rechtecke und Konfidenz – keine Landmarken, keine Merkmale, keine Identität. Die
 * Vorschläge liegen in der Medienzeile und verschwinden mit ihr.
 */

export const FACE_MODEL_FILE = 'face_detection_yunet_2026may.onnx';
/** Kennung des Modells, die an jedem Medium mitgeschrieben wird. */
export const FACE_MODEL_ID = 'yunet-2026may';
export const MAX_PROPOSALS = 200;
/** Rand um das erkannte Gesicht (Anteil der Breite/Höhe je Seite): YuNet rahmt eng von Stirn bis Kinn. */
export const FACE_MARGIN = 0.15;
const TIMEOUT_MS = 120_000;
const IDLE_MS = 60_000;

export type ProposalStatus = 'open' | 'accepted' | 'rejected';
export interface FaceProposal {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  status: ProposalStatus;
}

export class FaceDetectionUnavailable extends Error {}

/** Modelldatei: im Build server/dist/assets/models, in der Entwicklung server/assets/models. */
export function faceModelPath(): string {
  const dirs = [path.join(APP_ROOT, 'server', 'dist', 'assets', 'models'), path.join(APP_ROOT, 'server', 'assets', 'models')];
  for (const d of dirs) if (fs.existsSync(path.join(d, FACE_MODEL_FILE))) return path.join(d, FACE_MODEL_FILE);
  return path.join(dirs[1], FACE_MODEL_FILE);
}

/** Erkanntes Gesicht um den Rand erweitern, auf das Bild begrenzen und auf 4 Nachkommastellen runden. */
export function expandFace(f: { x: number; y: number; w: number; h: number }, margin = FACE_MARGIN) {
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  const x = r4(Math.max(0, f.x - f.w * margin));
  const y = r4(Math.max(0, f.y - f.h * margin));
  const w = r4(Math.min(1 - x, f.x + f.w * (1 + margin) - x));
  const h = r4(Math.min(1 - y, f.y + f.h * (1 + margin) - y));
  return { x, y, w: Math.max(0.0001, w), h: Math.max(0.0001, h) };
}

/** Anteil von `a`, der in `b` liegt. */
function covered(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (a.w * a.h) : 0;
}

/**
 * Neues Suchergebnis mit dem Bestand zusammenführen: Entschiedene Vorschläge (übernommen/verworfen) bleiben, offene
 * werden ersetzt. Ein neuer Treffer entfällt, wenn er schon größtenteils (über 50 %) von einem entschiedenen Vorschlag
 * oder einem unkenntlich gemachten Bereich abgedeckt ist – sonst käme ein verworfener Vorschlag bei jeder Suche wieder.
 */
export function mergeProposals(existing: FaceProposal[], found: FaceHit[], redactions: { x: number; y: number; w: number; h: number }[], newId = () => crypto.randomBytes(4).toString('hex')): FaceProposal[] {
  const decided = (existing ?? []).filter((p) => p.status === 'accepted' || p.status === 'rejected');
  const taken = [...decided, ...(redactions ?? [])];
  const fresh: FaceProposal[] = [];
  for (const f of [...found].sort((a, b) => b.score - a.score)) {
    const box = expandFace(f);
    if (taken.some((t) => covered(box, t) > 0.5)) continue;
    fresh.push({ id: newId(), ...box, score: Math.round(f.score * 100) / 100, status: 'open' });
  }
  return [...decided, ...fresh].slice(0, MAX_PROPOSALS);
}

export const openProposals = (list: FaceProposal[] | null | undefined) => (list ?? []).filter((p) => p.status === 'open').length;

/* ------------------------------ Kindprozess steuern ------------------------------ */

interface Pending {
  resolve: (r: DetectResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Ein laufender Kindprozess mit seinen offenen Anfragen. */
interface Proc {
  child: ChildProcess;
  pending: Map<number, Pending>;
  stderr: string;
}

type DetectOpts = { threshold: number; limitInputPixels: number; maxSide?: number; timeoutMs?: number };

/**
 * Ein Kindprozess je Worker, Aufträge nacheinander (höchstens ein Rechenkern, begrenzter Speicher). Er erbt die
 * niedrige CPU-Priorität des Workers und wird nach einer Minute ohne Auftrag beendet (gibt den Speicher frei).
 * Zeitüberschreitung oder Absturz beenden nur den Kindprozess; der nächste Auftrag startet einen neuen.
 */
class FaceRunner {
  private proc: Proc | null = null;
  private seq = 0;
  private idle: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  detect(file: string, opts: DetectOpts): Promise<DetectResult> {
    const run = this.chain.then(() => this.send(file, opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  stop() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const p = this.proc;
    this.proc = null;
    p?.child.kill();
  }

  private start(): Proc {
    const here = fileURLToPath(import.meta.url);
    const script = path.join(path.dirname(here), `face-runner${path.extname(here)}`);
    // Nur unverfängliche Umgebungsvariablen: der Kindprozess braucht weder Master-Schlüssel noch Datenbankzugang
    const env: NodeJS.ProcessEnv = { BLAULICHTCMS_FACE_RUNNER: '1' };
    for (const k of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'windir', 'NODE_ENV', 'LANG', 'LC_ALL']) if (process.env[k] !== undefined) env[k] = process.env[k];
    const child = fork(script, [], {
      env,
      // Keine Lader-/Debug-Argumente des Elternprozesses (.ts läuft in der Entwicklung über Node selbst)
      execArgv: ['--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const proc: Proc = { child, pending: new Map(), stderr: '' };
    child.stderr?.on('data', (d) => (proc.stderr = (proc.stderr + d.toString()).slice(-2000)));
    child.on('message', (msg: any) => {
      const p = proc.pending.get(msg?.id);
      if (!p) return;
      proc.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve({ faces: msg.faces, width: msg.width, height: msg.height, ms: msg.ms });
      else p.reject(msg.unavailable ? new FaceDetectionUnavailable(msg.error) : new Error(msg.error));
    });
    child.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null;
      const why = proc.stderr.trim().split(/\r?\n/).pop()?.slice(0, 200);
      for (const p of proc.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`Erkennungsprozess beendet (${signal ?? `Code ${code}`})${why ? `: ${why}` : ''}.`));
      }
      proc.pending.clear();
    });
    child.on('error', (e) => log('warn', 'media', `Gesichtssuche: Prozess-Fehler ${e.message}`));
    return proc;
  }

  private send(file: string, opts: DetectOpts): Promise<DetectResult> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (!this.proc || !this.proc.child.connected) this.proc = this.start();
    const proc = this.proc;
    const id = ++this.seq;
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    return new Promise<DetectResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.pending.delete(id);
        // abkoppeln, damit der nächste Auftrag sofort einen neuen Prozess bekommt
        if (this.proc === proc) this.proc = null;
        proc.child.kill('SIGKILL');
        reject(new Error(`Zeitüberschreitung der Gesichtssuche (${Math.max(1, Math.round(timeoutMs / 1000))} s).`));
      }, timeoutMs);
      proc.pending.set(id, { resolve, reject, timer });
      proc.child.send({ id, model: faceModelPath(), file, threshold: opts.threshold, limitInputPixels: opts.limitInputPixels, maxSide: opts.maxSide });
    }).finally(() => {
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
      this.idle.unref();
    });
  }
}

const runner = new FaceRunner();

/** Gesichter in einer Bilddatei suchen (normierte Rechtecke ohne Rand, absteigend nach Konfidenz). */
export function detectFaces(file: string, opts: DetectOpts): Promise<DetectResult> {
  return runner.detect(file, opts);
}

export function stopFaceRunner() {
  runner.stop();
}

/* ------------------------------------ Aufträge ----------------------------------- */

/** Suche einplanen (höchstens ein offener Auftrag je Datei) und den Stand am Medium vermerken. */
export async function enqueueFaceDetection(mediaId: string, db: Queryable = pool): Promise<void> {
  await enqueue('media.faces', { mediaId }, { dedupKey: `media.faces:${mediaId}`, maxAttempts: 1 }, db);
  await db.query(`UPDATE media SET face_status = 'queued', face_error = NULL WHERE id = $1`, [mediaId]);
}

/** Nur Bilder mit öffentlicher Fassung (nicht HEIC, keine Videos). */
export const faceDetectable = (m: { kind?: string | null; has_public?: boolean | null }) => m.kind === 'image' && !!m.has_public;

/**
 * Auftrag „media.faces“: Bild durchsuchen und Vorschläge speichern. Fehler werden am Medium vermerkt (Erneut suchen im
 * Dialog), nicht wiederholt – die Suche ist eine Hilfe, die Prüfung durch einen Menschen bleibt Pflicht.
 */
export async function runFaceDetection(mediaId: string): Promise<'done' | 'skipped' | 'failed' | 'unavailable'> {
  const m = await one<any>(`SELECT id, kind, has_public FROM media WHERE id = $1 AND status = 'ready' AND deleted_at IS NULL`, [mediaId]);
  if (!m || !faceDetectable(m)) {
    await pool.query(`UPDATE media SET face_status = NULL WHERE id = $1 AND face_status = 'queued'`, [mediaId]);
    return 'skipped';
  }
  const file = mediaPaths.original(mediaId);
  const fail = async (status: 'failed' | 'unavailable', message: string) => {
    await pool.query(`UPDATE media SET face_status = $2, face_error = $3, face_checked_at = now() WHERE id = $1`, [mediaId, status, message.slice(0, 300)]);
    log(status === 'unavailable' ? 'warn' : 'info', 'media', `Gesichtssuche ${status === 'unavailable' ? 'nicht verfügbar' : 'fehlgeschlagen'}: ${message}`, { media: mediaId });
    return status;
  };
  if (!fs.existsSync(file)) return fail('failed', 'Original fehlt.');
  const s = await getSettings();
  let r: DetectResult;
  try {
    r = await detectFaces(file, { threshold: Number(s['media.face_threshold']) / 100, limitInputPixels: await imagePixelLimit() });
  } catch (e) {
    return fail(e instanceof FaceDetectionUnavailable ? 'unavailable' : 'failed', (e as Error).message);
  }
  const saved = await tx(async (db) => {
    const now = await one<any>(`SELECT redactions, face_proposals FROM media WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [mediaId], db);
    if (!now) return null;
    const merged = mergeProposals(now.face_proposals ?? [], r.faces, now.redactions ?? []);
    await db.query(`UPDATE media SET face_proposals = $2, face_status = 'done', face_checked_at = now(), face_model = $3, face_error = NULL WHERE id = $1`, [mediaId, JSON.stringify(merged), FACE_MODEL_ID]);
    return merged;
  });
  if (!saved) return 'skipped';
  log('info', 'media', `Gesichtssuche: ${r.faces.length} Treffer, ${openProposals(saved)} offene Vorschläge (${r.ms} ms).`, { media: mediaId });
  return 'done';
}
