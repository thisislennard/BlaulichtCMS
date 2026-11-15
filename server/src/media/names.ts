/**
 * Neutrale Dateinamen für öffentliche Fassungen (#137): Der Originalname des Uploads kann Namen, Datum oder Ort
 * enthalten („Unfall_Mueller_Hauptstr.jpg“) und gehört nicht in Dateien, die nach außen gehen (soziale Kanäle,
 * Presse, ZIP der öffentlichen Fassung). Der Originalname bleibt nur beim Download des Originals erhalten.
 */

/** Kurzform eines Textes für Dateinamen: Kleinbuchstaben, Umlaute umschrieben, sonst nur a–z, 0–9 und „-“. */
export function fileSlug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '');
}

/**
 * Dateiname einer öffentlichen Fassung.
 * - mit `prefix` (z. B. Beitragstitel) und `index`: „<prefix-slug>-<n>.<ext>“
 * - nur mit `index`: „<nnn>-<id8>.<ext>“ (Reihenfolge bleibt sichtbar)
 * - sonst: „<medien-id>.<ext>“
 */
export function publicFileName(id: string, ext: string, opts: { prefix?: string; index?: number } = {}): string {
  const slug = opts.prefix ? fileSlug(opts.prefix) : '';
  if (slug && opts.index !== undefined) return `${slug}-${opts.index}.${ext}`;
  if (opts.index !== undefined) return `${String(opts.index).padStart(3, '0')}-${id.slice(0, 8)}.${ext}`;
  return `${id}.${ext}`;
}
