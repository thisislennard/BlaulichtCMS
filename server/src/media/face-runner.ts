import sharp from 'sharp';
import type * as Ort from 'onnxruntime-node';

/**
 * Gesichtssuche (#214) mit YuNet (OpenCV Zoo, MIT) über onnxruntime-node – läuft in einem eigenen Kindprozess
 * (media/faces.ts startet ihn): onnxruntime rechnet synchron, ein Absturz oder eine Zeitüberschreitung trifft so nur
 * diesen Prozess, nie den Worker. Bewusst ohne Importe aus dem übrigen Server, damit die Datei auch direkt als .ts läuft
 * (Tests, Entwicklung).
 *
 * Ergebnis sind nur Rechtecke mit Konfidenz (normiert 0..1, bezogen auf das richtig gedrehte Bild). Landmarken und
 * Merkmale werden verworfen; es gibt keine Wiedererkennung.
 *
 * Vor- und Nachbereitung wie cv::FaceDetectorYN (OpenCV, face_detect.cpp):
 * - Eingabe [1,3,H,W] float32, Farbreihenfolge BGR, Werte 0..255 ohne Normierung; H und W rechts/unten mit 0 auf ein
 *   Vielfaches von 32 aufgefüllt.
 * - Ausgaben je Schrittweite s ∈ {8,16,32}: cls_s, obj_s [1,N,1], bbox_s [1,N,4], kps_s [1,N,10] mit N = H/s · W/s.
 *   Konfidenz = √(cls · obj) (beide auf 0..1 begrenzt); Mitte = ((Spalte, Zeile) + bbox[0..1]) · s,
 *   Breite/Höhe = exp(bbox[2..3]) · s.
 * - Non-Maximum-Suppression mit IoU 0,3.
 *
 * YuNet findet Gesichter von etwa 10 bis 300 Bildpunkten. Deshalb mehrere Maßstäbe: die längere Kante höchstens
 * `maxSide` (kleine Gesichter in Gruppen), dazu 640 und 320 Bildpunkte für sehr große Gesichter (Nahaufnahmen). In den
 * groben Maßstäben zählen nur Treffer ab 12 % der längeren Kante – kleinere findet der feine Maßstab zuverlässiger, und
 * dort entstehen sonst Fehltreffer.
 */

export const STRIDES = [8, 16, 32] as const;
export const NMS_IOU = 0.3;
export const DEFAULT_MAX_SIDE = 1920;
export const COARSE_SCALES = [640, 320];
export const COARSE_MIN_SHARE = 0.12;

/** Treffer in Bildpunkten des jeweiligen Maßstabs bzw. normiert (0..1). */
export interface FaceHit {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/** RGB/RGBA (HWC, 8 bit) → BGR-Tensor (CHW, float32), rechts und unten auf ein Vielfaches von 32 aufgefüllt. */
export function inputTensor(rgb: Uint8Array, width: number, height: number, channels: number): { data: Float32Array; pw: number; ph: number } {
  const pw = Math.ceil(width / 32) * 32;
  const ph = Math.ceil(height / 32) * 32;
  const plane = pw * ph;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    let s = y * width * channels;
    let d = y * pw;
    for (let x = 0; x < width; x++, s += channels, d++) {
      data[d] = rgb[s + 2];
      data[plane + d] = rgb[s + 1];
      data[2 * plane + d] = rgb[s];
    }
  }
  return { data, pw, ph };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ausgaben des Modells (aufgefülltes Format pw × ph) in Rechtecke ab `threshold` übersetzen (Bildpunkte). */
export function decodeYunet(out: Record<string, { data: ArrayLike<number> }>, pw: number, ph: number, threshold: number): FaceHit[] {
  const hits: FaceHit[] = [];
  for (const s of STRIDES) {
    const cols = pw / s;
    const rows = ph / s;
    const cls = out[`cls_${s}`]?.data;
    const obj = out[`obj_${s}`]?.data;
    const box = out[`bbox_${s}`]?.data;
    if (!cls || !obj || !box) throw new Error(`Modellausgabe für Schrittweite ${s} fehlt.`);
    if (cls.length !== rows * cols || obj.length !== rows * cols || box.length !== rows * cols * 4) throw new Error(`Modellausgabe für Schrittweite ${s} hat eine unerwartete Größe.`);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (!(score >= threshold)) continue;
        const cx = (c + box[i * 4]) * s;
        const cy = (r + box[i * 4 + 1]) * s;
        const w = Math.exp(box[i * 4 + 2]) * s;
        const h = Math.exp(box[i * 4 + 3]) * s;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
        hits.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
      }
    }
  }
  return hits;
}

function intersection(a: FaceHit, b: FaceHit): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function iou(a: FaceHit, b: FaceHit): number {
  const i = intersection(a, b);
  return i > 0 ? i / (a.w * a.h + b.w * b.h - i) : 0;
}

/**
 * Non-Maximum-Suppression: absteigend nach Konfidenz; ein Treffer entfällt, wenn er ein behaltenes Rechteck mit IoU über
 * `iouThreshold` überlappt. Danach entfallen Rechtecke, die zu über 70 % in einem größeren liegen (z. B. ein Teil eines
 * großen Gesichts aus einem anderen Maßstab) – zum Unkenntlichmachen deckt das größere mehr ab.
 */
export function nms(hits: FaceHit[], iouThreshold = NMS_IOU): FaceHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const keep: FaceHit[] = [];
  for (const h of sorted) if (!keep.some((k) => iou(k, h) > iouThreshold)) keep.push(h);
  return keep.filter((h) => !keep.some((k) => k !== h && k.w * k.h > h.w * h.h && intersection(k, h) > 0.7 * h.w * h.h));
}

/** Maßstäbe (längere Kante in Bildpunkten): fein bis `maxSide`, dazu 640 und 320, sofern deutlich kleiner. */
export function detectionScales(longEdge: number, maxSide = DEFAULT_MAX_SIDE): number[] {
  const fine = Math.max(1, Math.min(longEdge, maxSide));
  return [fine, ...COARSE_SCALES.filter((c) => fine >= c * 1.5)];
}

export interface DetectOptions {
  /** Mindestkonfidenz 0..1 */
  threshold: number;
  /** Bildgrenze in Pixeln (Einstellung „Max. Bildauflösung“) */
  limitInputPixels: number;
  /** längere Kante des feinen Maßstabs */
  maxSide?: number;
}

export interface DetectResult {
  faces: FaceHit[];
  width: number;
  height: number;
  ms: number;
}

type OrtModule = typeof Ort;

/** Gesichter in einer Bilddatei suchen (EXIF-Drehung beachtet). Liefert normierte Rechtecke ohne Rand. */
export async function detectFile(ort: OrtModule, session: Ort.InferenceSession, file: string, opts: DetectOptions): Promise<DetectResult> {
  const t0 = performance.now();
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const fine = await sharp(file, { limitInputPixels: opts.limitInputPixels, failOn: 'error' })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const meta = await sharp(file, { limitInputPixels: opts.limitInputPixels }).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? fine.info.width;
  const height = (swap ? meta.width : meta.height) ?? fine.info.height;
  const scales = detectionScales(Math.max(fine.info.width, fine.info.height), maxSide);
  const all: FaceHit[] = [];
  for (const [k, scale] of scales.entries()) {
    const img =
      k === 0
        ? fine
        : await sharp(fine.data, { raw: { width: fine.info.width, height: fine.info.height, channels: fine.info.channels } })
            .resize({ width: scale, height: scale, fit: 'inside' })
            .raw({ depth: 'uchar' })
            .toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels } = img.info;
    const t = inputTensor(img.data, w, h, channels);
    const out = await session.run({ input: new ort.Tensor('float32', t.data, [1, 3, t.ph, t.pw]) });
    const min = k === 0 ? 0 : COARSE_MIN_SHARE * Math.max(w, h);
    for (const f of decodeYunet(out as any, t.pw, t.ph, opts.threshold)) {
      if (Math.max(f.w, f.h) < min) continue;
      // auf das Bild begrenzen (nicht auf den aufgefüllten Rand) und normieren
      const x0 = Math.max(0, f.x);
      const y0 = Math.max(0, f.y);
      const x1 = Math.min(w, f.x + f.w);
      const y1 = Math.min(h, f.y + f.h);
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      all.push({ x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h, score: f.score });
    }
  }
  return { faces: nms(all), width, height, ms: Math.round(performance.now() - t0) };
}

/** Sitzung mit einem Rechenkern und ohne Speicher-Arena (gibt Speicher nach jedem Lauf frei). */
export async function createSession(ort: OrtModule, modelPath: string): Promise<Ort.InferenceSession> {
  return ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
    logSeverityLevel: 3,
  });
}

/** onnxruntime-node laden; CommonJS-Modul, je nach Lader mit oder ohne `default`. */
export async function loadOrt(): Promise<OrtModule> {
  const mod: any = await import('onnxruntime-node');
  return (mod.InferenceSession ? mod : mod.default) as OrtModule;
}

/* ------------------------------- Kindprozess (IPC) ------------------------------- */

interface Request {
  id: number;
  model: string;
  file: string;
  threshold: number;
  limitInputPixels: number;
  maxSide?: number;
}

if (process.env.BLAULICHTCMS_FACE_RUNNER === '1' && typeof process.send === 'function') {
  sharp.concurrency(1);
  sharp.cache(false);
  let ort: OrtModule | null = null;
  let session: Ort.InferenceSession | null = null;
  let sessionModel = '';
  const reply = (msg: Record<string, unknown>) => process.send!(msg);
  process.on('message', async (req: Request) => {
    let stage = 'load';
    try {
      if (!ort) ort = await loadOrt();
      if (!session || sessionModel !== req.model) {
        session = await createSession(ort, req.model);
        sessionModel = req.model;
      }
      stage = 'detect';
      const r = await detectFile(ort, session, req.file, { threshold: req.threshold, limitInputPixels: req.limitInputPixels, maxSide: req.maxSide });
      reply({ id: req.id, ok: true, ...r });
    } catch (e) {
      reply({ id: req.id, ok: false, unavailable: stage === 'load', error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  });
  // Elternprozess weg (Worker beendet): sofort aufhören
  process.on('disconnect', () => process.exit(0));
}
