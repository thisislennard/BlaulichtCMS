/**
 * Kennzeichen von Hand unkenntlich machen (#223): Ein Klick auf das Kennzeichen setzt einen Bereich im Seitenverhältnis
 * eines Kfz-Kennzeichens (EU-Schild 520 × 110 mm ≈ 4,7 : 1, mit etwas Rand 4 : 1), mittig auf den Klickpunkt.
 * Koordinaten sind Anteile von Breite und Höhe des Bildes (0–1), wie bei allen Bereichen der öffentlichen Fassung.
 */
export type PlateSize = 's' | 'm' | 'l';

/** Breite des Bereichs als Anteil der Bildbreite */
export const PLATE_WIDTH: Record<PlateSize, number> = { s: 0.08, m: 0.14, l: 0.24 };
export const PLATE_SIZE_LABELS: Record<PlateSize, string> = { s: 'Klein (weit entfernt)', m: 'Mittel', l: 'Groß (nah)' };
const RATIO = 4;

/**
 * @param at Klickpunkt (Anteile 0–1)
 * @param aspect Seitenverhältnis des angezeigten Bildes (Breite / Höhe)
 */
export function plateBox(at: { x: number; y: number }, aspect: number, size: PlateSize): { x: number; y: number; w: number; h: number } {
  const w = Math.min(1, PLATE_WIDTH[size]);
  const h = Math.min(1, (w * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1.5)) / RATIO);
  // Am Bildrand nach innen schieben, statt den Bereich zu beschneiden
  const x = Math.min(Math.max(at.x - w / 2, 0), 1 - w);
  const y = Math.min(Math.max(at.y - h / 2, 0), 1 - h);
  return { x, y, w, h };
}
