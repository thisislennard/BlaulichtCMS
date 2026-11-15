/**
 * Übersetzungen: je Bereich eine Datei unter i18n/<sprache>/<bereich>.json (z. B. de/nav.json).
 * Schlüssel: "<bereich>.<pfad>", z. B. t('nav.dashboard'). Deutsch ist Standard und Rückfall.
 * Platzhalter: t('runs.count', { n: 3 }) mit "{n} Läufe".
 */
type Dict = Record<string, any>;

const modules = import.meta.glob('./*/*.json', { eager: true }) as Record<string, { default: Dict }>;
const dicts: Record<string, Dict> = {};
for (const [file, mod] of Object.entries(modules)) {
  const m = /\.\/(\w+)\/([\w-]+)\.json$/.exec(file);
  if (!m) continue;
  (dicts[m[1]] ??= {})[m[2]] = mod.default;
}

let lang: string = 'de';
export function setLanguage(l: string) {
  lang = dicts[l] ? l : 'de';
  document.documentElement.lang = lang;
}

function lookup(d: Dict | undefined, key: string): unknown {
  if (!d) return undefined;
  return key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), d);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = lookup(dicts[lang], key) ?? lookup(dicts.de, key);
  if (typeof s !== 'string') {
    if (import.meta.env.DEV) console.warn(`[i18n] fehlender Schlüssel: ${key}`);
    return key;
  }
  if (vars) for (const [k, v] of Object.entries(vars)) s = (s as string).split(`{${k}}`).join(String(v));
  return s as string;
}
