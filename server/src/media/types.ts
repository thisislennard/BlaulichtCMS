/**
 * Zugelassene Dateitypen (Schlüssel → erkannte MIME-Typen). Global einschränkbar über `media.allowed_types`, je Link
 * über `upload_links.allowed_types`. Geprüft wird immer der Dateiinhalt (file-type), nicht Dateiname oder Angabe.
 */
export interface TypeDef {
  key: string;
  label: string;
  kind: 'image' | 'video';
  mimes: string[];
  /** Endung der Originaldatei */
  ext: string;
}

export const TYPE_DEFS: TypeDef[] = [
  { key: 'jpeg', label: 'JPEG', kind: 'image', mimes: ['image/jpeg'], ext: 'jpg' },
  { key: 'png', label: 'PNG', kind: 'image', mimes: ['image/png'], ext: 'png' },
  { key: 'webp', label: 'WebP', kind: 'image', mimes: ['image/webp'], ext: 'webp' },
  { key: 'heic', label: 'HEIC/HEIF', kind: 'image', mimes: ['image/heic', 'image/heif'], ext: 'heic' },
  { key: 'avif', label: 'AVIF', kind: 'image', mimes: ['image/avif'], ext: 'avif' },
  { key: 'gif', label: 'GIF (nur unbewegt, außer „Animierte Bilder zulassen“)', kind: 'image', mimes: ['image/gif'], ext: 'gif' },
  { key: 'mp4', label: 'MP4', kind: 'video', mimes: ['video/mp4'], ext: 'mp4' },
  { key: 'mov', label: 'MOV (QuickTime)', kind: 'video', mimes: ['video/quicktime'], ext: 'mov' },
  { key: 'webm', label: 'WebM', kind: 'video', mimes: ['video/webm'], ext: 'webm' },
  { key: '3gp', label: '3GP', kind: 'video', mimes: ['video/3gpp', 'video/3gpp2'], ext: '3gp' },
];

export const TYPE_KEYS = TYPE_DEFS.map((t) => t.key);

export function typeByMime(mime: string): TypeDef | undefined {
  return TYPE_DEFS.find((t) => t.mimes.includes(mime));
}

/** Nur bekannte Schlüssel, ohne Doppelte; leer → alle bekannten. */
export function cleanTypeList(keys: unknown): string[] {
  const list = Array.isArray(keys) ? keys.map(String).filter((k) => TYPE_KEYS.includes(k)) : [];
  return [...new Set(list)];
}

/** Wirksame Typen: global erlaubt ∩ Link (falls gesetzt). */
export function effectiveTypes(global: unknown, link: unknown): string[] {
  const g = cleanTypeList(global);
  const base = g.length ? g : TYPE_KEYS;
  if (link == null) return base;
  const l = cleanTypeList(link);
  return base.filter((k) => l.includes(k));
}

/** accept-Attribut für das Dateifeld der Upload-Seite. */
export function acceptAttr(keys: string[]): string {
  return TYPE_DEFS.filter((t) => keys.includes(t.key)).flatMap((t) => t.mimes).join(',');
}

/** Lesbare Aufzählung für Meldungen: „JPEG, PNG, MP4“. */
export function typeLabels(keys: string[]): string {
  return TYPE_DEFS.filter((t) => keys.includes(t.key)).map((t) => t.label.replace(/ \(.*\)$/, '')).join(', ');
}
