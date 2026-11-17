/**
 * Fremdtext bereinigen (#237, #249): Steuerzeichen außer Tab, Zeilenvorschub und Wagenrücklauf entfallen. NUL (U+0000)
 * lehnt PostgreSQL in `text`-Spalten und in `jsonb` grundsätzlich ab – ein einziges solches Zeichen in einer fremden
 * Quelle (RSS, Warnquelle, Kalender) ließe sonst das Speichern scheitern. Die übrigen Steuerzeichen haben in Titeln und
 * Texten ebenfalls nichts verloren.
 */
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, '');
}

/** Wie `stripControlChars`, rekursiv für alle Zeichenketten (auch Schlüssel) in einfachen Objekten und Listen. */
export function stripControlCharsDeep<T>(v: T): T {
  if (typeof v === 'string') return stripControlChars(v) as T;
  if (Array.isArray(v)) return v.map((x) => stripControlCharsDeep(x)) as T;
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [stripControlChars(k), stripControlCharsDeep(x)])) as T;
    }
  }
  return v;
}

/**
 * Text kürzen, ohne Zeichen zu zerteilen (#232): Gekürzt wird an Graphem-Grenzen (Emoji samt Hautton oder Verbindung
 * wie 🧑‍🚒, Flaggen, Buchstaben mit kombinierenden Zeichen) – nie mitten in einem Surrogatpaar, das beim Senden als
 * „�“ ankäme oder von der Schnittstelle abgelehnt würde.
 */

const segmenter = new Intl.Segmenter('de', { granularity: 'grapheme' });

export const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

/** Länge in UTF-16-Einheiten (wie `String.length`, Zählweise vieler Schnittstellen). */
export const utf16Length = (s: string) => s.length;

/** Kürzt auf `max` (mit „…“), ohne Zeichen zu zerteilen; `suffix` (z. B. Link) bleibt immer vollständig erhalten. */
export function fitText(text: string, max: number, measure: (s: string) => number, suffix = ''): string {
  const t = text.trim();
  if (measure(t + suffix) <= max) return t + suffix;
  const g = graphemes(t);
  let lo = 0;
  let hi = g.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(g.slice(0, mid).join('').trimEnd() + '…' + suffix) <= max) lo = mid;
    else hi = mid - 1;
  }
  return (lo ? g.slice(0, lo).join('').trimEnd() + '…' : '') + suffix;
}
