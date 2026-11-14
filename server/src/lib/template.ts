/**
 * Sichere, begrenzte Ausdruckssprache: nur Feldzugriff, Filter mit festen
 * Argumenten und deklarative Vergleiche. Kein eval, keine Funktionsaufrufe, keine Schleifen.
 *
 *   {{ webhook.body.titel | upper | truncate:80 }}
 *   {{ alamos.einsatz.ort | default:"unbekannt" }}
 */

export type Escape = 'none' | 'html' | 'json' | 'url';

const MAX_TEMPLATE_LENGTH = 20_000;
const MAX_OUTPUT_LENGTH = 100_000;
const MAX_EXPRESSIONS = 200;

export class TemplateError extends Error {}

type Arg = string | number | { path: (string | number)[] };
interface FilterCall {
  name: string;
  args: Arg[];
}
interface Expr {
  path: (string | number)[];
  filters: FilterCall[];
}

export interface FilterDoc {
  name: string;
  args: string;
  description: string;
  example: string;
}

export const FILTER_DOCS: FilterDoc[] = [
  { name: 'upper', args: '', description: 'Großbuchstaben', example: '{{ x | upper }}' },
  { name: 'lower', args: '', description: 'Kleinbuchstaben', example: '{{ x | lower }}' },
  { name: 'trim', args: '', description: 'Leerzeichen am Anfang/Ende entfernen', example: '{{ x | trim }}' },
  { name: 'default', args: '"Wert" oder Variable', description: 'Ersatzwert, wenn das Feld fehlt oder leer ist (auch ein anderes Feld)', example: '{{ x | default:"unbekannt" }} · {{ alamos.ortsteil | default:alamos.stadt }}' },
  { name: 'truncate', args: 'Länge', description: 'Text auf eine Länge kürzen (mit …)', example: '{{ x | truncate:80 }}' },
  { name: 'replace', args: '"alt","neu"', description: 'Text ersetzen (kein Regex)', example: '{{ x | replace:"-"," " }}' },
  { name: 'date', args: '"Format"', description: 'Datum formatieren (dd, MM, yyyy, HH, mm, ss), Zeitzone der Instanz', example: '{{ x | date:"dd.MM.yyyy HH:mm" }}' },
  { name: 'add_minutes', args: 'Minuten', description: 'Minuten zu einem Datum addieren (ISO-Ausgabe)', example: '{{ run.started_at | add_minutes:60 }}' },
  { name: 'number', args: '', description: 'Als Zahl', example: '{{ x | number }}' },
  { name: 'length', args: '', description: 'Länge eines Textes oder einer Liste', example: '{{ x | length }}' },
  { name: 'first', args: '', description: 'Erstes Element einer Liste', example: '{{ x | first }}' },
  { name: 'last', args: '', description: 'Letztes Element einer Liste', example: '{{ x | last }}' },
  { name: 'join', args: '"Trenner"', description: 'Liste zu Text verbinden', example: '{{ x | join:", " }}' },
  { name: 'split', args: '"Trenner"', description: 'Text in Liste aufteilen', example: '{{ x | split:"," }}' },
  { name: 'json', args: '', description: 'Als JSON-Text ausgeben', example: '{{ x | json }}' },
  { name: 'urlencode', args: '', description: 'Für URLs kodieren', example: '{{ x | urlencode }}' },
  { name: 'strip_html', args: '', description: 'HTML-Tags entfernen', example: '{{ x | strip_html }}' },
];

/* ------------------------------------------------------------------------------------ */

function parseExpr(src: string): Expr {
  let i = 0;
  const s = src;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const ident = () => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(s.slice(i));
    if (!m) throw new TemplateError(`Erwarteter Name an Position ${i + 1} in „${src.trim()}“.`);
    i += m[0].length;
    return m[0];
  };
  const literal = (allowPath = false): Arg => {
    skipWs();
    const q = s[i];
    if (allowPath && /[A-Za-z_$]/.test(q ?? '')) {
      // Variable als Argument, z. B. default:alamos.stadt
      const p: (string | number)[] = [ident()];
      while (s[i] === '.') {
        i++;
        p.push(ident());
      }
      return { path: p };
    }
    if (q === '"' || q === "'") {
      let out = '';
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) {
          i++;
          out += s[i] === 'n' ? '\n' : s[i];
        } else out += s[i];
        i++;
      }
      if (s[i] !== q) throw new TemplateError('Nicht geschlossene Zeichenkette.');
      i++;
      return out;
    }
    const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new TemplateError(`Erwartet: Zahl oder "Text" in „${src.trim()}“.`);
    i += m[0].length;
    return Number(m[0]);
  };

  skipWs();
  const path: (string | number)[] = [ident()];
  for (;;) {
    if (s[i] === '.') {
      i++;
      path.push(ident());
    } else if (s[i] === '[') {
      i++;
      const key = literal();
      skipWs();
      if (s[i] !== ']') throw new TemplateError('Fehlendes ] im Ausdruck.');
      i++;
      path.push(key as string | number);
    } else break;
  }
  const filters: FilterCall[] = [];
  skipWs();
  while (s[i] === '|') {
    i++;
    skipWs();
    const name = ident();
    const args: Arg[] = [];
    skipWs();
    if (s[i] === ':') {
      i++;
      args.push(literal(true));
      skipWs();
      while (s[i] === ',') {
        i++;
        args.push(literal(true));
        skipWs();
      }
    }
    if (!FILTER_DOCS.some((f) => f.name === name)) throw new TemplateError(`Unbekannter Filter „${name}“.`);
    filters.push({ name, args });
    skipWs();
  }
  skipWs();
  if (i < s.length) throw new TemplateError(`Unerwartetes Zeichen „${s[i]}“ in „${src.trim()}“.`);
  return { path, filters };
}

type Part = { text: string } | { expr: Expr; raw: string };

const cache = new Map<string, Part[]>();

export function parseTemplate(tpl: string): Part[] {
  const hit = cache.get(tpl);
  if (hit) return hit;
  if (tpl.length > MAX_TEMPLATE_LENGTH) throw new TemplateError('Vorlage ist zu lang.');
  const parts: Part[] = [];
  let pos = 0;
  let count = 0;
  while (pos < tpl.length) {
    const start = tpl.indexOf('{{', pos);
    if (start < 0) {
      parts.push({ text: tpl.slice(pos) });
      break;
    }
    if (start > pos) parts.push({ text: tpl.slice(pos, start) });
    const end = tpl.indexOf('}}', start + 2);
    if (end < 0) throw new TemplateError('Nicht geschlossener Ausdruck: „}}“ fehlt.');
    const raw = tpl.slice(start + 2, end);
    if (++count > MAX_EXPRESSIONS) throw new TemplateError('Zu viele Ausdrücke in einer Vorlage.');
    parts.push({ expr: parseExpr(raw), raw: raw.trim() });
    pos = end + 2;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(tpl, parts);
  return parts;
}

/** Liefert alle Variablenpfade einer Vorlage (für Validierung und Datenflussvorschau). */
export function referencedPaths(tpl: string): string[][] {
  try {
    return parseTemplate(tpl)
      .filter((p): p is { expr: Expr; raw: string } => 'expr' in p)
      .flatMap((p) => [p.expr.path.map(String), ...p.expr.filters.flatMap((f) => f.args.filter((x): x is { path: (string | number)[] } => typeof x === 'object').map((x) => x.path.map(String)))]);
  } catch {
    return [];
  }
}

export function lookup(ctx: unknown, path: (string | number)[]): unknown {
  let cur: any = ctx;
  for (const key of path) {
    if (cur == null) return undefined;
    if (typeof key === 'string' && (key === '__proto__' || key === 'constructor' || key === 'prototype')) return undefined;
    if (Array.isArray(cur) && typeof key === 'number') cur = cur[key < 0 ? cur.length + key : key];
    else if (typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key as any];
    else return undefined;
  }
  return cur;
}

function toText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

let timeZone = 'Europe/Berlin';
export function setTemplateTimeZone(tz: string) {
  timeZone = tz;
}

function formatDate(value: unknown, fmt: string): string {
  const d = value instanceof Date ? value : new Date(toText(value));
  if (Number.isNaN(d.getTime())) return toText(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('de-DE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (tok) =>
    tok === 'yyyy' ? parts.year : tok === 'MM' ? parts.month : tok === 'dd' ? parts.day : tok === 'HH' ? parts.hour : tok === 'mm' ? parts.minute : parts.second,
  );
}

function applyFilter(v: unknown, f: FilterCall, ctx: unknown): unknown {
  const a = f.args.map((x) => (typeof x === 'object' ? (lookup(ctx, x.path) as any) : x)) as any[];
  switch (f.name) {
    case 'upper':
      return toText(v).toUpperCase();
    case 'lower':
      return toText(v).toLowerCase();
    case 'trim':
      return toText(v).trim();
    case 'default':
      return v == null || v === '' || (Array.isArray(v) && v.length === 0) ? (a[0] ?? '') : v;
    case 'truncate': {
      const n = Math.max(1, Number(a[0] ?? 100));
      const t = toText(v);
      return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t;
    }
    case 'replace':
      return toText(v).split(String(a[0] ?? '')).join(String(a[1] ?? ''));
    case 'date':
      return formatDate(v, String(a[0] ?? 'dd.MM.yyyy HH:mm'));
    case 'add_minutes': {
      const d = new Date(toText(v));
      if (Number.isNaN(d.getTime())) return v;
      return new Date(d.getTime() + Number(a[0] ?? 0) * 60_000).toISOString();
    }
    case 'number': {
      const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
      return Number.isFinite(n) ? n : null;
    }
    case 'length':
      return Array.isArray(v) ? v.length : toText(v).length;
    case 'first':
      return Array.isArray(v) ? v[0] : v;
    case 'last':
      return Array.isArray(v) ? v[v.length - 1] : v;
    case 'join':
      return Array.isArray(v) ? v.map(toText).join(String(a[0] ?? ', ')) : toText(v);
    case 'split':
      return toText(v)
        .split(String(a[0] ?? ','))
        .map((s) => s.trim())
        .filter(Boolean);
    case 'json':
      return JSON.stringify(v ?? null);
    case 'urlencode':
      return encodeURIComponent(toText(v));
    case 'strip_html':
      return toText(v)
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ');
    default:
      throw new TemplateError(`Unbekannter Filter „${f.name}“.`);
  }
}

function escapeText(t: string, esc: Escape): string {
  switch (esc) {
    case 'html':
      return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    case 'json':
      return JSON.stringify(t).slice(1, -1);
    case 'url':
      return encodeURIComponent(t);
    default:
      return t;
  }
}

export function evaluate(expr: Expr, ctx: unknown): unknown {
  let v = lookup(ctx, expr.path);
  for (const f of expr.filters) v = applyFilter(v, f, ctx);
  return v;
}

/** Text-Ausgabe mit kontextgerechtem Escaping der eingesetzten Werte. */
export function render(tpl: string | null | undefined, ctx: unknown, esc: Escape = 'none'): string {
  if (!tpl) return '';
  let out = '';
  for (const p of parseTemplate(tpl)) {
    out += 'text' in p ? p.text : escapeText(toText(evaluate(p.expr, ctx)), esc);
    if (out.length > MAX_OUTPUT_LENGTH) throw new TemplateError('Ergebnis der Vorlage ist zu lang.');
  }
  return out;
}

/** Besteht die Vorlage nur aus einem Ausdruck, wird der typisierte Wert (Liste, Zahl …) geliefert. */
export function renderValue(tpl: string | null | undefined, ctx: unknown): unknown {
  if (!tpl) return '';
  const parts = parseTemplate(tpl);
  if (parts.length === 1 && 'expr' in parts[0]) return evaluate(parts[0].expr, ctx);
  return render(tpl, ctx);
}

/** Prüft die Syntax; gibt eine verständliche Fehlermeldung oder null zurück. */
export function checkTemplate(tpl: string): string | null {
  try {
    parseTemplate(tpl);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/* ---------------------------------- Bedingungen ------------------------------------- */

export type Operator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'empty'
  | 'not_empty'
  | 'in'
  | 'not_in'
  | 'is_true'
  | 'is_false';

export const OPERATORS: { id: Operator; label: string; unary?: boolean }[] = [
  { id: 'eq', label: 'ist gleich' },
  { id: 'neq', label: 'ist ungleich' },
  { id: 'contains', label: 'enthält' },
  { id: 'not_contains', label: 'enthält nicht' },
  { id: 'starts_with', label: 'beginnt mit' },
  { id: 'ends_with', label: 'endet mit' },
  { id: 'gt', label: 'größer als' },
  { id: 'gte', label: 'größer oder gleich' },
  { id: 'lt', label: 'kleiner als' },
  { id: 'lte', label: 'kleiner oder gleich' },
  { id: 'in', label: 'ist einer von (Komma-Liste)' },
  { id: 'not_in', label: 'ist keiner von (Komma-Liste)' },
  { id: 'empty', label: 'ist leer', unary: true },
  { id: 'not_empty', label: 'ist nicht leer', unary: true },
  { id: 'is_true', label: 'ist wahr', unary: true },
  { id: 'is_false', label: 'ist falsch', unary: true },
];

export interface Condition {
  left: string;
  op: Operator;
  right?: string;
  caseSensitive?: boolean;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(toText(v).replace(',', '.'));
}

export function testCondition(c: Condition, ctx: unknown): boolean {
  const lv = renderValue(c.left, ctx);
  const rv = c.right != null ? renderValue(c.right, ctx) : '';
  const cs = c.caseSensitive === true;
  const norm = (x: unknown) => (cs ? toText(x).trim() : toText(x).trim().toLowerCase());
  const l = norm(lv);
  const r = norm(rv);
  switch (c.op) {
    case 'eq':
      return l === r;
    case 'neq':
      return l !== r;
    case 'contains':
      return Array.isArray(lv) ? lv.some((x) => norm(x) === r) : l.includes(r);
    case 'not_contains':
      return Array.isArray(lv) ? !lv.some((x) => norm(x) === r) : !l.includes(r);
    case 'starts_with':
      return l.startsWith(r);
    case 'ends_with':
      return l.endsWith(r);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      let a = num(lv);
      let b = num(rv);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        // Datumsvergleich, wenn beide Seiten Daten sind
        a = Date.parse(toText(lv));
        b = Date.parse(toText(rv));
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
      }
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
    }
    case 'in':
    case 'not_in': {
      const list = r.split(',').map((x) => x.trim());
      const hit = list.includes(l);
      return c.op === 'in' ? hit : !hit;
    }
    case 'empty':
      return lv == null || l === '' || (Array.isArray(lv) && lv.length === 0);
    case 'not_empty':
      return !(lv == null || l === '' || (Array.isArray(lv) && lv.length === 0));
    case 'is_true':
      return ['true', '1', 'ja', 'yes', 'wahr'].includes(l);
    case 'is_false':
      return !['true', '1', 'ja', 'yes', 'wahr'].includes(l);
    default:
      return false;
  }
}

export function testConditions(conditions: Condition[], combinator: 'all' | 'any', ctx: unknown): boolean {
  if (!conditions.length) return true;
  return combinator === 'any' ? conditions.some((c) => testCondition(c, ctx)) : conditions.every((c) => testCondition(c, ctx));
}
