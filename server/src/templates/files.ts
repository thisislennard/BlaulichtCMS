import fs from 'node:fs';
import path from 'node:path';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { config } from '../config.js';

/*
 * Designvorlagen (#208): erlaubte Dateiformate, Prüfung des Inhalts und sichere Behandlung von SVG.
 *
 * Grundsatz wie bei den Medien: Entscheidend ist der Dateiinhalt, nicht der Name. Die Endung legt das erwartete Format
 * fest, der Inhalt muss dazu passen (Signatur am Dateianfang) – sonst wird die Datei abgelehnt. Alles wird nur als
 * Download (attachment, nosniff) ausgeliefert; ZIP-basierte Formate werden nie entpackt. SVG wird beim Hochladen
 * bereinigt (nur bekannte Elemente/Attribute, keine Skripte, keine Ereignis-Attribute, keine externen Verweise).
 */

export interface FormatDef {
  key: string;
  label: string;
  exts: string[];
  mime: string;
  /** Rasterbild/SVG, aus dem sharp ein Vorschaubild erzeugen kann */
  previewable?: boolean;
  check: (head: Buffer) => boolean;
}

const starts = (head: Buffer, ...sig: number[]) => sig.every((b, i) => head[i] === b);
const ascii = (head: Buffer, s: string, at = 0) => head.subarray(at, at + s.length).toString('latin1') === s;

export const FORMATS: FormatDef[] = [
  { key: 'png', label: 'PNG', exts: ['png'], mime: 'image/png', previewable: true, check: (h) => starts(h, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { key: 'jpeg', label: 'JPEG', exts: ['jpg', 'jpeg'], mime: 'image/jpeg', previewable: true, check: (h) => starts(h, 0xff, 0xd8, 0xff) },
  { key: 'webp', label: 'WebP', exts: ['webp'], mime: 'image/webp', previewable: true, check: (h) => ascii(h, 'RIFF') && ascii(h, 'WEBP', 8) },
  { key: 'gif', label: 'GIF', exts: ['gif'], mime: 'image/gif', previewable: true, check: (h) => ascii(h, 'GIF87a') || ascii(h, 'GIF89a') },
  { key: 'tiff', label: 'TIFF', exts: ['tif', 'tiff'], mime: 'image/tiff', previewable: true, check: (h) => starts(h, 0x49, 0x49, 0x2a, 0x00) || starts(h, 0x4d, 0x4d, 0x00, 0x2a) },
  { key: 'svg', label: 'SVG', exts: ['svg'], mime: 'image/svg+xml', previewable: true, check: (h) => looksLikeSvg(h) },
  { key: 'pdf', label: 'PDF', exts: ['pdf', 'ai'], mime: 'application/pdf', check: (h) => ascii(h, '%PDF-') },
  { key: 'eps', label: 'EPS/PostScript', exts: ['eps', 'ps'], mime: 'application/postscript', check: (h) => ascii(h, '%!PS') || starts(h, 0xc5, 0xd0, 0xd3, 0xc6) },
  { key: 'psd', label: 'Photoshop', exts: ['psd', 'psb'], mime: 'application/octet-stream', check: (h) => ascii(h, '8BPS') },
  { key: 'indd', label: 'InDesign', exts: ['indd', 'indt'], mime: 'application/octet-stream', check: (h) => starts(h, 0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5) },
  { key: 'affinity', label: 'Affinity', exts: ['afdesign', 'afphoto', 'afpub'], mime: 'application/octet-stream', check: (h) => starts(h, 0x00, 0xff, 0x4b, 0x41) },
  { key: 'xcf', label: 'GIMP', exts: ['xcf'], mime: 'application/octet-stream', check: (h) => ascii(h, 'gimp xcf') },
  {
    key: 'zip',
    label: 'ZIP/Office/offene Datei',
    exts: ['zip', 'idml', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'odg', 'sketch', 'xd', 'canva'],
    mime: 'application/zip',
    check: (h) => starts(h, 0x50, 0x4b, 0x03, 0x04) || starts(h, 0x50, 0x4b, 0x05, 0x06),
  },
  { key: 'font', label: 'Schrift', exts: ['ttf', 'otf', 'woff', 'woff2'], mime: 'application/octet-stream', check: (h) => starts(h, 0x00, 0x01, 0x00, 0x00) || ascii(h, 'OTTO') || ascii(h, 'true') || ascii(h, 'wOFF') || ascii(h, 'wOF2') },
  { key: 'text', label: 'Text', exts: ['txt', 'md'], mime: 'text/plain; charset=utf-8', check: (h) => !h.includes(0) },
];

export const ALLOWED_EXTS = FORMATS.flatMap((f) => f.exts);
/** Höchstgröße je Datei (Bytes) und je SVG (wird im Speicher bereinigt). */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_SVG_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_VERSION = 20;

export const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();

/** Format zur Endung – und nur, wenn der Inhalt dazu passt. */
export function detectFormat(name: string, head: Buffer): { format?: FormatDef; error?: string } {
  const ext = extOf(name);
  const f = FORMATS.find((x) => x.exts.includes(ext));
  if (!f) return { error: `Dateien mit der Endung „.${ext || '?'}“ sind nicht erlaubt. Erlaubt: ${ALLOWED_EXTS.map((e) => `.${e}`).join(', ')}.` };
  if (!f.check(head)) return { error: `Der Inhalt von „${name}“ passt nicht zur Endung .${ext} (${f.label}).` };
  return { format: f };
}

function looksLikeSvg(head: Buffer): boolean {
  const s = head.toString('utf8').replace(/^﻿/, '').trimStart();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s);
}

/** Dateiname für den Download: ohne Pfad und Steuerzeichen, höchstens 150 Zeichen. */
export function cleanFileName(name: string): string {
  const base = path.basename(String(name).replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (base || 'datei').slice(-150);
}

/* ------------------------------------------------------------------ Ablage */

export const templatePaths = {
  root: () => path.join(config.mediaDir, 'templates'),
  file: (id: string) => path.join(config.mediaDir, 'templates', 'files', id.slice(0, 2), id),
  preview: (templateId: string) => path.join(config.mediaDir, 'templates', 'previews', `${templateId}.webp`),
};

export function ensureDir(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

/* ------------------------------------------------------------------ SVG bereinigen */

const SVG_ELEMENTS = new Set(
  [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath',
    'image', 'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'style', 'switch', 'a', 'view',
    'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
    'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
    'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  ].map((x) => x.toLowerCase()),
);

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** CSS aus style-Attributen und <style>: keine Importe, keine Ausdrücke, Verweise nur innerhalb der Datei. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/-moz-binding[^;]*;?/gi, '')
    .replace(/behavio(u)?r\s*:[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, target: string) => (target.trim().startsWith('#') ? m : 'none'));
}

export class SvgRejected extends Error {}

/**
 * SVG bereinigen: DOCTYPE/Entitäten und Verarbeitungsanweisungen werden abgelehnt (XXE, Stylesheets), unbekannte
 * Elemente samt Inhalt entfernt (script, foreignObject, iframe, Editor-Daten …), Ereignis-Attribute entfernt, Verweise
 * (href, xlink:href) nur innerhalb der Datei oder als eingebettetes Rasterbild erlaubt. Liefert die bereinigte Datei.
 */
export function sanitizeSvg(input: string): string {
  const text = input.replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new SvgRejected('SVG-Dateien mit DOCTYPE oder Entitäten sind nicht erlaubt.');
  const pis = text.match(/<\?[\s\S]*?\?>/g) ?? [];
  if (pis.some((p) => !/^<\?xml\s/i.test(p)) || pis.length > 1) throw new SvgRejected('SVG-Dateien mit Verarbeitungsanweisungen (z. B. Stylesheets) sind nicht erlaubt.');
  const opts = { preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true, processEntities: false, cdataPropName: '#cdata', commentPropName: '#comment', ignoreDeclaration: true, ignorePiTags: true, parseTagValue: false, trimValues: false, maxNestedTags: 200 } as const;
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (valid !== true) throw new SvgRejected(`Die SVG-Datei ist kein gültiges XML (Zeile ${valid.err.line}: ${valid.err.msg.slice(0, 120)}).`);
  let tree: any[];
  try {
    tree = new XMLParser(opts as any).parse(text);
  } catch (e) {
    throw new SvgRejected(`Die SVG-Datei ist kein gültiges XML (${(e as Error).message.slice(0, 120)}).`);
  }
  const root = tree.filter((n) => !('#comment' in n) && !('#text' in n && !String(n['#text']).trim()));
  if (root.length !== 1 || localName(Object.keys(root[0]).find((k) => k !== ':@') ?? '') !== 'svg') throw new SvgRejected('Die Datei enthält kein SVG-Wurzelelement.');
  const clean = cleanNodes(root, 0);
  return new XMLBuilder({ ...opts, suppressEmptyNode: true, format: false } as any).build(clean);
}

function localName(tag: string): string {
  const i = tag.indexOf(':');
  return (i >= 0 ? tag.slice(i + 1) : tag).toLowerCase();
}

function cleanNodes(nodes: any[], depth: number): any[] {
  if (depth > 200) throw new SvgRejected('Die SVG-Datei ist zu tief verschachtelt.');
  const out: any[] = [];
  for (const n of nodes) {
    if ('#comment' in n) continue;
    if ('#text' in n) {
      out.push(n);
      continue;
    }
    if ('#cdata' in n) {
      out.push(n);
      continue;
    }
    const tag = Object.keys(n).find((k) => k !== ':@');
    if (!tag) continue;
    // Elemente mit Namensraum-Präfix (sodipodi:, inkscape:, svg:…) sind Editor-Daten oder unbekannt → weg
    if (tag.includes(':') || !SVG_ELEMENTS.has(tag.toLowerCase())) continue;
    const lname = tag.toLowerCase();
    let children = cleanNodes(n[tag] ?? [], depth + 1);
    if (lname === 'style') children = children.map((c) => ('#text' in c ? { '#text': cleanCss(String(c['#text'])) } : '#cdata' in c ? { '#cdata': (c['#cdata'] as any[]).map((t) => ({ '#text': cleanCss(String(t['#text'] ?? '')) })) } : c));
    const attrs = cleanAttrs(lname, n[':@'] ?? {});
    out.push({ [tag]: children, ...(Object.keys(attrs).length ? { ':@': attrs } : {}) });
  }
  return out;
}

function cleanAttrs(tag: string, attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(attrs)) {
    const name = k.replace(/^@_/, '');
    const lname = name.toLowerCase();
    const value = String(raw ?? '');
    if (lname.startsWith('on')) continue;
    // Namensraum-Deklarationen bleiben; Editor-Attribute (sodipodi:, inkscape:) entfallen
    if (lname.includes(':') && !lname.startsWith('xmlns') && !lname.startsWith('xlink:') && !lname.startsWith('xml:')) continue;
    if (/javascript:|vbscript:|data:text\/html/i.test(value.replace(/[\s\u0000-\u001f]/g, ''))) continue;
    if (lname === 'href' || lname === 'xlink:href') {
      const v = value.trim();
      if (v.startsWith('#')) out[k] = v;
      else if (tag === 'image' && SAFE_DATA_IMAGE.test(v)) out[k] = v;
      continue;
    }
    if (lname === 'style') {
      out[k] = cleanCss(value);
      continue;
    }
    // Präsentationsattribute mit url(...) (fill, clip-path, mask, filter …): nur interne Verweise
    out[k] = /url\(/i.test(value) ? cleanCss(value) : value;
  }
  return out;
}
