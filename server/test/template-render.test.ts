import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { bundledFonts, pangoFont, readFontInfo } from '../src/templates/fonts.js';
import { layoutSchema, starterLayout, FORMAT_PRESETS } from '../src/templates/layout.js';
import { fitText, renderTemplate } from '../src/templates/render.js';
import { detectFormat, sanitizeSvg, SvgRejected } from '../src/templates/files.js';

/* Befüllbare Bildvorlagen (#209): Schriften, Textumbruch/Verkleinerung, Rendern – ohne Datenbank, mit echtem sharp. */

const fonts = new Map(bundledFonts().map((f) => [f.key, f]));
const condensed = fonts.get('barlow-condensed-bold')!;
const regular = fonts.get('barlow-regular')!;
const base = { font: condensed, color: '#ffffff', align: 'left' as const, lineHeight: 1, w: 900 };

/** Anteil der Pixel mit (fast) dieser Farbe in einem Bereich */
async function share(png: Buffer, area: { left: number; top: number; width: number; height: number }, rgb: [number, number, number], tol = 40) {
  const { data, info } = await sharp(png).extract(area).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) if (Math.abs(data[i] - rgb[0]) <= tol && Math.abs(data[i + 1] - rgb[1]) <= tol && Math.abs(data[i + 2] - rgb[2]) <= tol) n++;
  return n / (info.width * info.height);
}

describe('Schriften', () => {
  it('mitgelieferte Schriften liegen als Dateien vor; Namen und Stil werden aus der Datei gelesen', () => {
    expect(fonts.size).toBeGreaterThanOrEqual(6);
    for (const f of fonts.values()) {
      expect(fs.existsSync(f.file), f.file).toBe(true);
      const info = readFontInfo(fs.readFileSync(f.file));
      expect(info.family, f.key).toBe(f.family);
      expect(info.weight, f.key).toBe(f.weight);
      expect(info.format).toBe('ttf');
    }
    // Lizenztexte liegen bei
    expect(fs.readdirSync(path.dirname(condensed.file)).filter((x) => x.startsWith('OFL-')).length).toBeGreaterThanOrEqual(2);
  });

  it('keine Schrift: abgelehnt; Pango-Beschreibung trennt die Familie mit Komma ab', () => {
    expect(() => readFontInfo(Buffer.from('MZ kein Font'))).toThrow(/TrueType/);
    expect(() => readFontInfo(Buffer.from('wOFF0000000000000000'))).toThrow();
    expect(pangoFont(condensed, 64)).toBe('Barlow Condensed, Bold 64px');
    expect(pangoFont(regular, 20.4)).toBe('Barlow, 20px');
  });
});

describe('Textumbruch und automatische Verkleinerung', () => {
  it('kurzer Text bleibt in Ausgangsgröße und einzeilig', async () => {
    const r = await fitText('Übung', { ...base, size: 96, minSize: 40, maxLines: 3, h: 300 });
    expect(r).toMatchObject({ size: 96, lines: 1, truncated: false });
    expect(r.image!.width).toBeLessThan(900);
  });

  it('langer Text wird umbrochen und verkleinert, bis er in Höhe und Zeilenzahl passt', async () => {
    const text = 'Übung der Freiwilligen Feuerwehr am Samstag mit vielen Einsatzkräften aus dem ganzen Landkreis';
    const two = await fitText(text, { ...base, size: 96, minSize: 30, maxLines: 2, h: 400 });
    expect(two.truncated).toBe(false);
    expect(two.lines).toBe(2);
    expect(two.size).toBeLessThan(96);
    expect(two.image!.width).toBeLessThanOrEqual(900);
    // Mehr Zeilen erlaubt → größere Schrift
    const four = await fitText(text, { ...base, size: 96, minSize: 30, maxLines: 4, h: 400 });
    expect(four.size).toBeGreaterThan(two.size);
    expect(four.lines).toBeGreaterThan(2);
    expect(four.image!.height).toBeLessThanOrEqual(400);
    // Größere Schrift würde nicht mehr passen (größte passende Größe gefunden)
    const bigger = await fitText(text, { ...base, size: two.size + 2, minSize: two.size + 2, maxLines: 2, h: 400 });
    expect(bigger.truncated).toBe(true);
  });

  it('Zeilenumbrüche des Textes zählen; zu viel Text wird in der Mindestgröße nach Wörtern mit „…“ gekürzt', async () => {
    const lines = await fitText('Eins\nZwei\nDrei', { ...base, size: 60, minSize: 20, maxLines: 3, h: 600 });
    expect(lines).toMatchObject({ lines: 3, truncated: false, size: 60 });
    const tooMany = await fitText('Eins\nZwei\nDrei\nVier', { ...base, size: 60, minSize: 60, maxLines: 3, h: 600 });
    expect(tooMany.truncated).toBe(true);
    expect(tooMany.lines).toBeLessThanOrEqual(3);
    const long = await fitText('Wort '.repeat(200), { ...base, size: 40, minSize: 30, maxLines: 2, h: 200 });
    expect(long.truncated).toBe(true);
    expect(long.size).toBe(30);
    expect(long.lines).toBe(2);
  });

  it('leerer Text erzeugt nichts; Sonderzeichen werden nicht als Markup ausgewertet', async () => {
    expect((await fitText('   ', { ...base, size: 40, minSize: 20, maxLines: 2, h: 200 })).image).toBeNull();
    const r = await fitText('<b>A & B</b> <span foreground="red">x</span>', { ...base, size: 40, minSize: 20, maxLines: 3, h: 400 });
    expect(r.image).not.toBeNull();
    expect(r.truncated).toBe(false);
  });
});

describe('Rendern', () => {
  it('Startlayouts aller Formate sind gültig; Elemente außerhalb der Fläche werden abgelehnt', () => {
    for (const f of FORMAT_PRESETS) expect(layoutSchema.safeParse(starterLayout(f.width, f.height)).success, f.key).toBe(true);
    const bad = layoutSchema.safeParse({ width: 500, height: 500, elements: [{ id: 'a', type: 'shape', label: 'Fläche', x: 400, y: 0, w: 200, h: 50 }] });
    expect(bad.success).toBe(false);
    const dup = layoutSchema.safeParse({ width: 500, height: 500, elements: [{ id: 'a', type: 'shape', label: 'A', x: 0, y: 0, w: 20, h: 20 }, { id: 'a', type: 'shape', label: 'B', x: 0, y: 0, w: 20, h: 20 }] });
    expect(dup.success).toBe(false);
  });

  it('Hintergrund, Fläche, Text und Bild landen an der richtigen Stelle; Bildausschnitt folgt dem Fokus', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-render-'));
    // Foto: linke Hälfte blau, rechte Hälfte grün
    const photo = path.join(tmp, 'foto.png');
    await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
      .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 3, background: '#00ff00' } }).png().toBuffer(), left: 200, top: 0 }])
      .png()
      .toFile(photo);
    const layout = layoutSchema.parse({
      width: 600,
      height: 400,
      background: { color: '#ff0000' },
      elements: [
        { id: 'foto', type: 'image', label: 'Foto', x: 0, y: 0, w: 200, h: 200, fit: 'cover' },
        { id: 'band', type: 'shape', label: 'Band', x: 0, y: 300, w: 600, h: 100, color: '#000000', opacity: 1 },
        { id: 'titel', type: 'text', label: 'Titel', x: 20, y: 310, w: 560, h: 80, size: 60, minSize: 20, color: '#ffffff', maxLines: 1, valign: 'middle', default: 'Vorgabe' },
      ],
    });
    const left = await renderTemplate({ layout, values: { titel: 'Großübung' }, images: { foto: { file: photo, focusX: 0 } }, assets: {}, fonts, fallbackFont: condensed });
    expect(left.width).toBe(600);
    const meta = await sharp(left.png).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([600, 400, 'png']);
    expect(await share(left.png, { left: 400, top: 0, width: 200, height: 200 }, [255, 0, 0])).toBeGreaterThan(0.99); // Hintergrund
    expect(await share(left.png, { left: 0, top: 0, width: 200, height: 200 }, [0, 0, 255])).toBeGreaterThan(0.95); // Fokus links → blau
    expect(await share(left.png, { left: 0, top: 300, width: 600, height: 100 }, [255, 255, 255])).toBeGreaterThan(0.05); // Text im Band
    expect(await share(left.png, { left: 0, top: 200, width: 600, height: 100 }, [255, 255, 255])).toBe(0); // nichts außerhalb des Feldes
    const right = await renderTemplate({ layout, values: {}, images: { foto: { file: photo, focusX: 1 } }, assets: {}, fonts, fallbackFont: condensed });
    expect(await share(right.png, { left: 0, top: 0, width: 200, height: 200 }, [0, 255, 0])).toBeGreaterThan(0.95); // Fokus rechts → grün
    expect(right.texts.titel).toMatchObject({ truncated: false, lines: 1 });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Bild-Platzhalter ohne Bild: im Editor als Platzhalter, beim Erzeugen leer', async () => {
    const layout = layoutSchema.parse({ width: 300, height: 300, background: { color: '#ffffff' }, elements: [{ id: 'foto', type: 'image', label: 'Foto', x: 0, y: 0, w: 300, h: 300 }] });
    const withPh = await renderTemplate({ layout, values: {}, images: {}, assets: {}, fonts, fallbackFont: condensed, placeholders: true });
    const without = await renderTemplate({ layout, values: {}, images: {}, assets: {}, fonts, fallbackFont: condensed });
    expect(await share(withPh.png, { left: 100, top: 20, width: 100, height: 60 }, [0x9c, 0xa3, 0xaf], 10)).toBeGreaterThan(0.9);
    expect(await share(without.png, { left: 0, top: 0, width: 300, height: 300 }, [255, 255, 255], 2)).toBe(1);
  });
});

describe('Dateien der Bibliothek', () => {
  it('Inhaltsprüfung je Endung; SVG-Bereinigung entfernt Gefährliches und behält Darstellbares', () => {
    expect(detectFormat('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).format?.key).toBe('png');
    expect(detectFormat('a.png', Buffer.from('GIF89a')).error).toMatch(/passt nicht/);
    expect(detectFormat('a.ai', Buffer.from('%PDF-1.5')).format?.key).toBe('pdf');
    expect(detectFormat('a.svg', Buffer.from('﻿<?xml version="1.0"?>\n<!-- x --><svg xmlns="http://www.w3.org/2000/svg"/>')).format?.key).toBe('svg');
    expect(detectFormat('a.html', Buffer.from('<html>')).error).toMatch(/nicht erlaubt/);
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://x.example/a.css); .a{fill:url(#g)}</style><g onclick="x()"><rect class="a" width="1" height="1"/></g><iframe src="https://x.example"/></svg>');
    expect(out).toContain('<rect');
    expect(out).toContain('url(#g)');
    for (const bad of ['@import', 'onclick', 'iframe', 'x.example']) expect(out).not.toContain(bad);
    expect(() => sanitizeSvg('<?xml-stylesheet href="a.xsl"?><svg/>')).toThrow(SvgRejected);
    expect(() => sanitizeSvg('<svg><unclosed></svg>')).toThrow(SvgRejected);
  });
});
