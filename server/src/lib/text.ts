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
