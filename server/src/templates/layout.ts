import { z } from 'zod';
import { DEFAULT_FONT } from './fonts.js';

/*
 * Layout einer befüllbaren Bildvorlage (#209): feste Größe, Hintergrund (Farbe und/oder Bild) und Elemente in
 * Zeichenreihenfolge – Textfelder, Bild-Platzhalter, Logo (festes Bild) und Flächen. Koordinaten in Pixeln des
 * erzeugten Bildes; jedes Element liegt vollständig innerhalb der Fläche.
 */

export const FORMAT_PRESETS = [
  { key: 'square', label: 'Quadrat 1080 × 1080 (Feed)', width: 1080, height: 1080 },
  { key: 'portrait', label: 'Hochformat 1080 × 1350 (Feed)', width: 1080, height: 1350 },
  { key: 'story', label: 'Story 1080 × 1920', width: 1080, height: 1920 },
  { key: 'link', label: 'Querformat 1200 × 630 (Link-Vorschau)', width: 1200, height: 630 },
  { key: 'banner', label: 'Banner 1920 × 1080', width: 1920, height: 1080 },
] as const;

export const MAX_ELEMENTS = 30;
export const MIN_EDGE = 200;
export const MAX_EDGE = 4000;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe im Format #RRGGBB');
const elementId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Kennung: Kleinbuchstaben, Ziffern und _');
const box = { x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(4), h: z.number().int().min(4) };
const label = z.string().trim().min(1).max(60);

export const textElement = z.object({
  id: elementId,
  type: z.literal('text'),
  label,
  ...box,
  font: z.string().max(60).default(DEFAULT_FONT),
  size: z.number().int().min(8).max(400).default(72),
  minSize: z.number().int().min(6).max(400).default(24),
  color: hex.default('#ffffff'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  valign: z.enum(['top', 'middle', 'bottom']).default('top'),
  maxLines: z.number().int().min(1).max(20).default(3),
  lineHeight: z.number().min(0.8).max(2).default(1),
  uppercase: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(500).default(120),
  default: z.string().max(500).default(''),
  hint: z.string().max(200).default(''),
});

export const imageElement = z.object({
  id: elementId,
  type: z.literal('image'),
  label,
  ...box,
  fit: z.enum(['cover', 'contain']).default('cover'),
  radius: z.number().int().min(0).max(2000).default(0),
  required: z.boolean().default(false),
});

export const logoElement = z.object({
  id: elementId,
  type: z.literal('logo'),
  label,
  ...box,
  assetId: z.uuid().nullable().default(null),
});

export const shapeElement = z.object({
  id: elementId,
  type: z.literal('shape'),
  label,
  ...box,
  color: hex.default('#000000'),
  opacity: z.number().min(0).max(1).default(0.6),
  radius: z.number().int().min(0).max(2000).default(0),
});

export const layoutSchema = z
  .object({
    width: z.number().int().min(MIN_EDGE).max(MAX_EDGE),
    height: z.number().int().min(MIN_EDGE).max(MAX_EDGE),
    background: z.object({ color: hex.default('#b91c1c'), assetId: z.uuid().nullable().default(null) }).default({ color: '#b91c1c', assetId: null }),
    elements: z.array(z.discriminatedUnion('type', [textElement, imageElement, logoElement, shapeElement])).max(MAX_ELEMENTS, `höchstens ${MAX_ELEMENTS} Elemente`).default([]),
  })
  .superRefine((l, ctx) => {
    const ids = new Set<string>();
    l.elements.forEach((e, i) => {
      if (ids.has(e.id)) ctx.addIssue({ code: 'custom', path: ['elements', i, 'id'], message: `Die Kennung „${e.id}“ kommt doppelt vor.` });
      ids.add(e.id);
      if (e.x + e.w > l.width || e.y + e.h > l.height) ctx.addIssue({ code: 'custom', path: ['elements', i], message: `„${e.label}“ ragt über den Rand des Bildes.` });
      if (e.type === 'text' && e.minSize > e.size) ctx.addIssue({ code: 'custom', path: ['elements', i, 'minSize'], message: `„${e.label}“: Die Mindestgröße ist größer als die Schriftgröße.` });
    });
  });

export type Layout = z.infer<typeof layoutSchema>;
export type LayoutElement = Layout['elements'][number];
export type TextElement = z.infer<typeof textElement>;
export type ImageElement = z.infer<typeof imageElement>;

/** Startlayout für eine neue Bildvorlage im gewählten Format. */
export function starterLayout(width: number, height: number): Layout {
  const m = Math.round(Math.min(width, height) * 0.06);
  const e = Math.min(width, height);
  const photoH = Math.round(height * 0.55);
  return layoutSchema.parse({
    width,
    height,
    background: { color: '#b91c1c', assetId: null },
    elements: [
      { id: 'foto', type: 'image', label: 'Foto', x: 0, y: 0, w: width, h: photoH, fit: 'cover' },
      { id: 'titel', type: 'text', label: 'Titel', x: m, y: photoH + m, w: width - 2 * m, h: Math.round(height * 0.25), size: Math.round(e * 0.09), minSize: Math.round(e * 0.04), maxLines: 3, color: '#ffffff', uppercase: true, default: 'Überschrift', maxLength: 120 },
      { id: 'text', type: 'text', label: 'Text', x: m, y: Math.round(height * 0.8) + m, w: width - 2 * m, h: Math.max(20, Math.round(height * 0.2) - 2 * m), font: 'barlow-regular', size: Math.round(e * 0.04), minSize: 14, maxLines: 2, color: '#ffffff', default: 'Datum · Ort', maxLength: 160 },
    ],
  });
}

/** Elemente, die beim Ausfüllen Werte brauchen (Textfelder, Bild-Platzhalter). */
export const fillableElements = (l: Layout) => l.elements.filter((e) => e.type === 'text' || e.type === 'image');
