import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import { configureFonts, pangoFont, type FontDef } from './fonts.js';
import type { Layout, LayoutElement, TextElement } from './layout.js';

/*
 * Bild aus einer befüllbaren Vorlage erzeugen (#209) – serverseitig mit sharp/libvips, ohne weitere Abhängigkeit.
 *
 * Text: Pango (über sharp `text`) bricht nach Wörtern um und misst die Höhe. Die Schriftgröße wird so lange verkleinert
 * (binäre Suche zwischen Größe und Mindestgröße), bis der Text in das Feld passt und höchstens „max. Zeilen“ braucht;
 * reicht auch die Mindestgröße nicht, wird nach ganzen Wörtern mit „…“ gekürzt. libvips beschneidet das Textbild auf
 * die Tinte; die Zeilenzahl ergibt sich deshalb aus dem gemessenen Zeilenabstand je Schrift und Größe.
 */

configureFonts();

export interface ImageInput {
  /** Datei (öffentliche Fassung eines Mediums oder Vorlagen-Bild) */
  file: string;
  /** Bildausschnitt bei „füllen“: Fokus 0…1 und Zoom 1…4 */
  focusX?: number;
  focusY?: number;
  zoom?: number;
}

export interface RenderInput {
  layout: Layout;
  /** Text je Textfeld (fehlt → Vorgabe des Feldes) */
  values: Record<string, string>;
  /** Bild je Bild-Platzhalter */
  images: Record<string, ImageInput | undefined>;
  /** Dateien der Vorlage (Hintergrund, Logos) */
  assets: Record<string, string>;
  fonts: Map<string, FontDef>;
  fallbackFont: FontDef;
  /** Bild-Platzhalter ohne Bild als graue Fläche mit Rahmen zeigen (Editor, Vorschau) */
  placeholders?: boolean;
}

export interface TextFit {
  /** gekürzt, weil der Text auch in der Mindestgröße nicht passte */
  truncated: boolean;
  size: number;
  lines: number;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  texts: Record<string, TextFit>;
}

const MAX_PIXELS = 40_000_000;

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Textbild für eine Größe (auf die Tinte beschnitten). */
async function textImage(text: string, font: FontDef, size: number, color: string, lineHeight: number, width: number, align: TextElement['align']) {
  const markup = `<span foreground="${color}" line_height="${lineHeight}">${escapeMarkup(text)}</span>`;
  const { data, info } = await sharp({
    text: { text: markup, font: pangoFont(font, size), fontfile: font.file, width, rgba: true, wrap: 'word-char', align: align === 'center' ? 'centre' : align },
    limitInputPixels: MAX_PIXELS,
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const pitchCache = new Map<string, { pitch: number; minInk: number }>();

/** Zeilenabstand (px) und kleinste Tintenhöhe einer Zeile für Schrift, Größe und Zeilenhöhe – gemessen, nicht geschätzt. */
async function lineMetrics(font: FontDef, size: number, lineHeight: number) {
  const key = `${font.file}|${size}|${lineHeight}`;
  const hit = pitchCache.get(key);
  if (hit) return hit;
  const one = await textImage('H', font, size, '#000000', lineHeight, 10_000, 'left');
  const two = await textImage('H\nH', font, size, '#000000', lineHeight, 10_000, 'left');
  const dot = await textImage('.', font, size, '#000000', lineHeight, 10_000, 'left');
  const m = { pitch: Math.max(1, two.height - one.height), minInk: dot.height };
  if (pitchCache.size > 2000) pitchCache.clear();
  pitchCache.set(key, m);
  return m;
}

/** Zeilenzahl aus der Höhe des (beschnittenen) Textbildes. */
async function countLines(height: number, font: FontDef, size: number, lineHeight: number) {
  const m = await lineMetrics(font, size, lineHeight);
  // Höhe = (Zeilen − 1) × Zeilenabstand + Tintenhöhe einer Zeile (zwischen „.“ und voller Zeile)
  return Math.max(1, Math.floor((height - m.minInk) / m.pitch + 1e-6) + 1);
}

export interface FitOptions {
  font: FontDef;
  size: number;
  minSize: number;
  color: string;
  align: TextElement['align'];
  lineHeight: number;
  maxLines: number;
  w: number;
  h: number;
}

/** Text in ein Feld einpassen: größte Schriftgröße, bei der Höhe und Zeilenzahl passen; sonst kürzen. */
export async function fitText(raw: string, o: FitOptions): Promise<{ image: { data: Buffer; width: number; height: number } | null } & TextFit> {
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!text) return { image: null, truncated: false, size: o.size, lines: 0 };
  const fits = async (t: string, size: number) => {
    const img = await textImage(t, o.font, size, o.color, o.lineHeight, o.w, o.align);
    if (img.height > o.h || img.width > o.w) return null;
    const lines = await countLines(img.height, o.font, size, o.lineHeight);
    return lines <= o.maxLines ? { img, lines } : null;
  };
  // Größte passende Größe (binäre Suche); die Ausgangsgröße zuerst, weil sie meistens passt
  const first = await fits(text, o.size);
  if (first) return { image: first.img, truncated: false, size: o.size, lines: first.lines };
  let lo = o.minSize;
  let hi = o.size - 1;
  let best: { img: Awaited<ReturnType<typeof textImage>>; lines: number; size: number } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await fits(text, mid);
    if (r) {
      best = { ...r, size: mid };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best) return { image: best.img, truncated: false, size: best.size, lines: best.lines };
  // Auch in der Mindestgröße zu lang: nach ganzen Wörtern kürzen (binäre Suche über die Wortzahl)
  const words = text.split(/(\s+)/).filter((x) => x.length);
  let a = 0;
  let b = words.length - 1;
  let cut: { img: Awaited<ReturnType<typeof textImage>>; lines: number } | null = null;
  while (a <= b) {
    const mid = Math.floor((a + b) / 2);
    const candidate = `${words.slice(0, mid + 1).join('').trimEnd()}…`;
    const r = await fits(candidate, o.minSize);
    if (r) {
      cut = r;
      a = mid + 1;
    } else b = mid - 1;
  }
  if (cut) return { image: cut.img, truncated: true, size: o.minSize, lines: cut.lines };
  // Nicht einmal das erste Wort passt: zeichenweise
  const chars = [...text];
  for (let n = chars.length - 1; n > 0; n = Math.floor(n * 0.7)) {
    const r = await fits(`${chars.slice(0, n).join('')}…`, o.minSize);
    if (r) return { image: r.img, truncated: true, size: o.minSize, lines: r.lines };
  }
  return { image: null, truncated: true, size: o.minSize, lines: 0 };
}

const svgRect = (w: number, h: number, fill: string, opacity: number, radius: number) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${fill}" fill-opacity="${opacity}"/></svg>`);

const roundMask = (w: number, h: number, r: number) => svgRect(w, h, '#ffffff', 1, Math.min(r, Math.floor(Math.min(w, h) / 2)));

/** Bild in ein Feld setzen: füllen (mit Fokus und Zoom zugeschnitten) oder einpassen (mit Transparenz). */
async function placeImage(input: ImageInput, w: number, h: number, fit: 'cover' | 'contain', radius: number): Promise<Buffer> {
  const src = sharp(input.file, { limitInputPixels: MAX_PIXELS, failOn: 'error', density: 144 }).rotate();
  let out: Sharp;
  if (fit === 'contain') {
    out = sharp(await src.resize({ width: w, height: h, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
  } else {
    const meta = await sharp(await src.toBuffer()).metadata();
    const iw = meta.width ?? w;
    const ih = meta.height ?? h;
    const zoom = Math.min(4, Math.max(1, input.zoom ?? 1));
    const scale = Math.max(w / iw, h / ih) * zoom;
    const sw = Math.max(w, Math.round(iw * scale));
    const sh = Math.max(h, Math.round(ih * scale));
    const fx = Math.min(1, Math.max(0, input.focusX ?? 0.5));
    const fy = Math.min(1, Math.max(0, input.focusY ?? 0.5));
    const left = Math.round((sw - w) * fx);
    const top = Math.round((sh - h) * fy);
    out = sharp(await sharp(input.file, { limitInputPixels: MAX_PIXELS, failOn: 'error', density: 144 }).rotate().resize({ width: sw, height: sh, fit: 'fill' }).extract({ left, top, width: w, height: h }).png().toBuffer());
  }
  if (radius > 0) out = out.composite([{ input: roundMask(w, h, radius), blend: 'dest-in' }]);
  return out.png().toBuffer();
}

/** Platzhalter für ein fehlendes Bild (Editor/Vorschau): graue Fläche mit Rahmen. */
const placeholderImage = (w: number, h: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#9ca3af"/><rect x="2" y="2" width="${Math.max(1, w - 4)}" height="${Math.max(1, h - 4)}" fill="none" stroke="#e5e7eb" stroke-width="4" stroke-dasharray="16 10"/><path d="M${w / 2 - 40} ${h / 2 + 24} l28 -36 l20 22 l14 -14 l18 28 z" fill="#e5e7eb"/><circle cx="${w / 2 + 20}" cy="${h / 2 - 22}" r="9" fill="#e5e7eb"/></svg>`,
  );

export function textValue(el: TextElement, values: Record<string, string>): string {
  const v = values[el.id] ?? el.default;
  const t = String(v ?? '').slice(0, el.maxLength);
  return el.uppercase ? t.toLocaleUpperCase('de-DE') : t;
}

/** Bild in voller Größe erzeugen (PNG). */
export async function renderTemplate(input: RenderInput): Promise<RenderResult> {
  const { layout } = input;
  const layers: OverlayOptions[] = [];
  const texts: Record<string, TextFit> = {};
  const bg = layout.background.assetId ? input.assets[layout.background.assetId] : null;
  if (bg) layers.push({ input: await placeImage({ file: bg }, layout.width, layout.height, 'cover', 0), left: 0, top: 0 });
  for (const el of layout.elements as LayoutElement[]) {
    if (el.type === 'shape') {
      layers.push({ input: svgRect(el.w, el.h, el.color, el.opacity, el.radius), left: el.x, top: el.y });
    } else if (el.type === 'logo') {
      const file = el.assetId ? input.assets[el.assetId] : null;
      if (file) layers.push({ input: await placeImage({ file }, el.w, el.h, 'contain', 0), left: el.x, top: el.y });
      else if (input.placeholders) layers.push({ input: placeholderImage(el.w, el.h), left: el.x, top: el.y });
    } else if (el.type === 'image') {
      const img = input.images[el.id];
      if (img) layers.push({ input: await placeImage(img, el.w, el.h, el.fit, el.radius), left: el.x, top: el.y });
      else if (input.placeholders) layers.push({ input: await sharp(placeholderImage(el.w, el.h)).composite(el.radius ? [{ input: roundMask(el.w, el.h, el.radius), blend: 'dest-in' }] : []).png().toBuffer(), left: el.x, top: el.y });
    } else if (el.type === 'text') {
      const font = input.fonts.get(el.font) ?? input.fallbackFont;
      const fit = await fitText(textValue(el, input.values), { font, size: el.size, minSize: Math.min(el.minSize, el.size), color: el.color, align: el.align, lineHeight: el.lineHeight, maxLines: el.maxLines, w: el.w, h: el.h });
      texts[el.id] = { truncated: fit.truncated, size: fit.size, lines: fit.lines };
      if (!fit.image) continue;
      const left = el.x + (el.align === 'center' ? Math.round((el.w - fit.image.width) / 2) : el.align === 'right' ? el.w - fit.image.width : 0);
      const top = el.y + (el.valign === 'middle' ? Math.round((el.h - fit.image.height) / 2) : el.valign === 'bottom' ? el.h - fit.image.height : 0);
      layers.push({ input: fit.image.data, left, top });
    }
  }
  const png = await sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: layout.background.color } })
    .composite(layers)
    .flatten({ background: layout.background.color })
    .png({ compressionLevel: 8 })
    .toBuffer();
  return { png, width: layout.width, height: layout.height, texts };
}

/** Verkleinerte Vorschau (JPEG) eines erzeugten Bildes. */
export async function previewJpeg(png: Buffer, maxEdge = 900): Promise<Buffer> {
  return sharp(png).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}
