/**
 * Maskierung und Kürzung von Laufdaten, bevor sie gespeichert oder angezeigt werden.
 * Geheimnisse erscheinen nie im Klartext: sensible Schlüssel werden
 * ersetzt, bekannte Geheimniswerte überall in Texten.
 */
export const MASK = '•••••••• maskiert';

const SENSITIVE_KEY = /(pass(wor)?d|passwd|secret|geheim|token|authorization|api[-_]?key|cookie|signature|credential|private[-_]?key|client[-_]?secret|session)/i;

const MAX_DEPTH = 8;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;
const MAX_KEYS = 100;
const MAX_TOTAL = 64_000;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function maskString(s: string, secrets: string[]): string {
  let out = s;
  for (const sec of secrets) {
    if (sec && sec.length >= 4 && out.includes(sec)) out = out.split(sec).join(MASK);
  }
  // Bearer-/Basic-Header in Fließtext
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`);
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + ` … (${s.length - MAX_STRING} Zeichen gekürzt)`;
  return out;
}

export function maskValue(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return maskString(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `(Binärdaten, ${value.length} Byte)`;
  if (depth >= MAX_DEPTH) return '(zu tief verschachtelt, gekürzt)';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => maskValue(v, secrets, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`… ${value.length - MAX_ARRAY} weitere Einträge`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, MAX_KEYS)) {
      out[k] = isSensitiveKey(k) && v != null && v !== '' ? MASK : maskValue(v, secrets, depth + 1);
    }
    if (entries.length > MAX_KEYS) out['…'] = `${entries.length - MAX_KEYS} weitere Felder`;
    return out;
  }
  return String(value);
}

/** Maskiert und begrenzt die Gesamtgröße einer Vorschau. */
export function preview(value: unknown, secrets: string[] = []): unknown {
  const masked = maskValue(value, secrets);
  const json = JSON.stringify(masked ?? null);
  if (json.length <= MAX_TOTAL) return masked;
  return { gekuerzt: true, hinweis: `Vorschau zu groß (${Math.round(json.length / 1024)} KB), gekürzt.`, anfang: json.slice(0, 4_000) };
}
