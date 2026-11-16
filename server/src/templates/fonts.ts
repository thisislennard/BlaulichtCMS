import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, config } from '../config.js';

/*
 * Schriften für befüllbare Bildvorlagen (#209).
 *
 * Gerendert wird mit sharp/libvips (Pango + fontconfig). Damit Textumbruch und Verkleinerung überall gleich gemessen
 * werden – auch im Container ohne Systemschriften –, bringt BlaulichtCMS freie Schriften als Dateien mit
 * (server/assets/fonts, beim Build nach server/dist/assets/fonts kopiert; SIL Open Font License). Jede Schrift wird
 * beim Rendern über `fontfile` direkt bei fontconfig angemeldet; zusätzlich zeigt eine eigene fonts.conf
 * (FONTCONFIG_FILE) auf die mitgelieferten und hochgeladenen Schriften. Eigene Schriften (TTF/OTF) lädt die
 * Verwaltung mit Lizenzhinweis hoch.
 */

export interface FontDef {
  /** Schlüssel in Layouts: mitgeliefert z. B. „barlow-bold“, eigene „custom:<uuid>“ */
  key: string;
  label: string;
  family: string;
  weight: number;
  italic: boolean;
  file: string;
  bundled: boolean;
  license: string;
}

const BUNDLED: { key: string; label: string; family: string; weight: number; italic: boolean; fileName: string; licenseFile: string }[] = [
  { key: 'barlow-regular', label: 'Barlow', family: 'Barlow', weight: 400, italic: false, fileName: 'Barlow-Regular.ttf', licenseFile: 'OFL-Barlow.txt' },
  { key: 'barlow-bold', label: 'Barlow Fett', family: 'Barlow', weight: 700, italic: false, fileName: 'Barlow-Bold.ttf', licenseFile: 'OFL-Barlow.txt' },
  { key: 'barlow-condensed-regular', label: 'Barlow Condensed', family: 'Barlow Condensed', weight: 400, italic: false, fileName: 'BarlowCondensed-Regular.ttf', licenseFile: 'OFL-Barlow.txt' },
  { key: 'barlow-condensed-bold', label: 'Barlow Condensed Fett', family: 'Barlow Condensed', weight: 700, italic: false, fileName: 'BarlowCondensed-Bold.ttf', licenseFile: 'OFL-Barlow.txt' },
  { key: 'atkinson-regular', label: 'Atkinson Hyperlegible', family: 'Atkinson Hyperlegible', weight: 400, italic: false, fileName: 'AtkinsonHyperlegible-Regular.ttf', licenseFile: 'OFL-AtkinsonHyperlegible.txt' },
  { key: 'atkinson-bold', label: 'Atkinson Hyperlegible Fett', family: 'Atkinson Hyperlegible', weight: 700, italic: false, fileName: 'AtkinsonHyperlegible-Bold.ttf', licenseFile: 'OFL-AtkinsonHyperlegible.txt' },
];

export const DEFAULT_FONT = 'barlow-condensed-bold';
export const FONT_LICENSE_NOTE = 'SIL Open Font License 1.1 – frei nutzbar, auch kommerziell; mitgeliefert mit BlaulichtCMS.';

/** Ordner der mitgelieferten Schriften: im Build server/dist/assets/fonts, in der Entwicklung server/assets/fonts. */
export function bundledFontDir(): string {
  for (const d of [path.join(APP_ROOT, 'server', 'dist', 'assets', 'fonts'), path.join(APP_ROOT, 'server', 'assets', 'fonts')]) {
    if (fs.existsSync(path.join(d, BUNDLED[0].fileName))) return d;
  }
  return path.join(APP_ROOT, 'server', 'assets', 'fonts');
}

export const customFontDir = () => path.join(config.mediaDir, 'templates', 'fonts');
export const customFontPath = (id: string, ext: string) => path.join(customFontDir(), `${id}.${ext}`);

export function bundledFonts(): FontDef[] {
  const dir = bundledFontDir();
  return BUNDLED.map(({ fileName, licenseFile, ...f }) => ({ ...f, file: path.join(dir, fileName), bundled: true, license: FONT_LICENSE_NOTE }));
}

export const bundledFont = (key: string) => bundledFonts().find((f) => f.key === key);

let configured = false;

/**
 * Eigene fontconfig-Konfiguration (einmal je Prozess, vor dem ersten Rendern): mitgelieferte und hochgeladene Schriften,
 * Cache im Datenverzeichnis, Systemschriften nur, falls vorhanden. Eine vom Betrieb gesetzte FONTCONFIG_FILE bleibt.
 */
export function configureFonts() {
  if (configured) return;
  configured = true;
  if (process.env.FONTCONFIG_FILE) return;
  try {
    const dir = path.join(config.dataDir, 'fonts');
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(customFontDir(), { recursive: true, mode: 0o700 });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const conf = `<?xml version="1.0"?>
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${esc(bundledFontDir())}</dir>
  <dir>${esc(customFontDir())}</dir>
  <cachedir>${esc(path.join(dir, 'cache'))}</cachedir>
</fontconfig>
`;
    const file = path.join(dir, 'fonts.conf');
    fs.writeFileSync(file, conf, { mode: 0o600 });
    process.env.FONTCONFIG_FILE = file;
  } catch {
    /* ohne eigene Konfiguration: Schriften werden trotzdem per fontfile angemeldet */
  }
}

/* ------------------------------------------------------------------ Schriftdatei lesen (TTF/OTF) */

export interface FontInfo {
  family: string;
  subfamily: string;
  fullName: string;
  weight: number;
  italic: boolean;
  format: 'ttf' | 'otf';
}

export class FontRejected extends Error {}

/**
 * Namen und Stil aus einer TrueType-/OpenType-Datei lesen (Tabellen „name“ und „OS/2“). Nur einzelne Schriften
 * (keine Sammlungen, kein WOFF) – sonst FontRejected.
 */
export function readFontInfo(buf: Buffer): FontInfo {
  if (buf.length < 12) throw new FontRejected('Die Datei ist keine Schrift.');
  const tag = buf.readUInt32BE(0);
  const isTtf = tag === 0x00010000 || tag === 0x74727565; // 'true'
  const isOtf = tag === 0x4f54544f; // 'OTTO'
  if (!isTtf && !isOtf) throw new FontRejected('Erlaubt sind TrueType- (.ttf) und OpenType-Schriften (.otf).');
  const numTables = buf.readUInt16BE(4);
  if (numTables > 200 || 12 + numTables * 16 > buf.length) throw new FontRejected('Die Schriftdatei ist beschädigt.');
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const t = buf.toString('latin1', at, at + 4);
    const offset = buf.readUInt32BE(at + 8);
    const length = buf.readUInt32BE(at + 12);
    if (offset + length > buf.length) throw new FontRejected('Die Schriftdatei ist beschädigt.');
    tables.set(t, { offset, length });
  }
  const name = tables.get('name');
  if (!name) throw new FontRejected('Die Schrift enthält keine Namen.');
  const names = new Map<number, string>();
  const count = buf.readUInt16BE(name.offset + 2);
  const strings = name.offset + buf.readUInt16BE(name.offset + 4);
  for (let i = 0; i < count; i++) {
    const at = name.offset + 6 + i * 12;
    if (at + 12 > name.offset + name.length) break;
    const platform = buf.readUInt16BE(at);
    const encoding = buf.readUInt16BE(at + 2);
    const lang = buf.readUInt16BE(at + 4);
    const id = buf.readUInt16BE(at + 6);
    const len = buf.readUInt16BE(at + 8);
    const off = strings + buf.readUInt16BE(at + 10);
    if (off + len > buf.length || ![1, 2, 4, 16, 17].includes(id)) continue;
    let s: string | null = null;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      const b = Buffer.from(buf.subarray(off, off + len));
      b.swap16();
      s = b.toString('utf16le');
      // englische Namen bevorzugen
      if (names.has(id) && lang !== 0x0409) continue;
    } else if (platform === 1 && encoding === 0 && !names.has(id)) s = buf.toString('latin1', off, off + len);
    if (s) names.set(id, s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100));
  }
  const family = names.get(16) || names.get(1) || '';
  if (!family) throw new FontRejected('Der Name der Schrift konnte nicht gelesen werden.');
  let weight = 400;
  let italic = false;
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 64) {
    weight = buf.readUInt16BE(os2.offset + 4) || 400;
    italic = (buf.readUInt16BE(os2.offset + 62) & 1) === 1;
  }
  const subfamily = names.get(17) || names.get(2) || '';
  if (!os2 && /bold/i.test(subfamily)) weight = 700;
  if (!os2 && /italic|oblique/i.test(subfamily)) italic = true;
  return { family, subfamily, fullName: names.get(4) || `${family} ${subfamily}`.trim(), weight: Math.min(1000, Math.max(1, weight)), italic, format: isOtf ? 'otf' : 'ttf' };
}

/** Pango-Schriftbeschreibung: „Familie, Stil Größe“ (Komma beendet die Familienliste, z. B. bei „… Condensed“). */
export function pangoFont(f: Pick<FontDef, 'family' | 'weight' | 'italic'>, sizePx: number): string {
  const w = f.weight;
  const weight = w >= 850 ? 'Heavy' : w >= 750 ? 'Ultra-Bold' : w >= 650 ? 'Bold' : w >= 550 ? 'Semi-Bold' : w >= 450 ? 'Medium' : w >= 350 ? '' : w >= 250 ? 'Light' : w >= 150 ? 'Ultra-Light' : 'Thin';
  return `${f.family.replace(/[,\\]/g, ' ')}, ${[weight, f.italic ? 'Italic' : ''].filter(Boolean).join(' ')} ${Math.max(1, Math.round(sizePx))}px`.replace(/\s+/g, ' ');
}
