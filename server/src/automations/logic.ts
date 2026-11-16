import crypto from 'node:crypto';
import type { Operator } from './catalog.js';

/*
 * Reine Datenlogik der Automationen: Platzhalter-Vorlagen und Bedingungen. Es gibt bewusst keine Ausdrücke, kein
 * eval/new Function und keine Schleifen – eine Vorlage ersetzt nur {{feld}} durch Text, eine Bedingung vergleicht ein
 * Feld mit einem festen Wert.
 */

export type Data = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;

/** Alle Platzhalter einer Vorlage (ohne Doppelte, in Reihenfolge). */
export function placeholders(tpl: string | null | undefined): string[] {
  if (!tpl) return [];
  return [...new Set([...String(tpl).matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Feldwert als Text: Listen mit Komma, ISO-Zeitpunkte lesbar in der Zeitzone der Instanz, Steuerzeichen entfernt. */
export function valueText(v: unknown, timeZone = 'Europe/Berlin'): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => valueText(x, timeZone)).filter(Boolean).join(', ');
  if (typeof v === 'object') return '';
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  let s = String(v);
  if (ISO.test(s) && !Number.isNaN(Date.parse(s))) {
    s = new Intl.DateTimeFormat('de-DE', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s));
  }
  // Steuerzeichen außer Zeilenumbruch und Tab entfernen
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * Vorlage füllen. Fehlende oder leere Felder werden zu leerem Text und in `missing` gemeldet (der Lauf protokolliert
 * das). `escape: 'html'` maskiert eingesetzte Werte für Ziele, die HTML darstellen; die Vorlage selbst bleibt, wie sie
 * eingegeben wurde. Ergebnis höchstens `maxLength` Zeichen.
 */
export function renderTemplate(tpl: string | null | undefined, data: Data, opts: { escape?: 'html' | 'none'; maxLength?: number; timeZone?: string } = {}): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = String(tpl ?? '').replace(PLACEHOLDER, (_m, key: string) => {
    const raw = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
    const v = valueText(raw, opts.timeZone);
    if (!v) missing.push(key);
    return opts.escape === 'html' ? escapeHtml(v) : v;
  });
  return { text: opts.maxLength ? text.slice(0, opts.maxLength) : text, missing: [...new Set(missing)] };
}

/* ------------------------------------------------------------------ Bedingungen */

export interface Rule {
  field: string;
  op: Operator;
  value?: string;
}
export interface Group {
  combinator: 'and' | 'or';
  rules: (Rule | Group)[];
}

export const isGroup = (r: Rule | Group): r is Group => Array.isArray((r as Group).rules);

const norm = (s: string) => s.trim().toLocaleLowerCase('de-DE');

/** Zahl aus Text („3“, „3,5“, „-2“); sonst null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function listOf(value: string | undefined): string[] {
  return String(value ?? '')
    .split(/[,;\n]/)
    .map((x) => norm(x))
    .filter(Boolean);
}

export function evaluateRule(rule: Rule, data: Data): boolean {
  const raw = data[rule.field];
  const text = norm(valueText(raw));
  const want = norm(String(rule.value ?? ''));
  switch (rule.op) {
    case 'exists':
      return text !== '';
    case 'not_exists':
      return text === '';
    case 'eq':
      return text === want;
    case 'neq':
      return text !== want;
    case 'contains':
      return want !== '' && text.includes(want);
    case 'not_contains':
      return want === '' || !text.includes(want);
    case 'starts_with':
      return want !== '' && text.startsWith(want);
    case 'in':
      return listOf(rule.value).includes(text);
    case 'gte':
    case 'lte': {
      const a = toNumber(raw);
      const b = toNumber(rule.value ?? '');
      if (a === null || b === null) return false;
      return rule.op === 'gte' ? a >= b : a <= b;
    }
    default:
      return false;
  }
}

/** Gruppe auswerten: „und“ = alle Regeln, „oder“ = mindestens eine. Eine leere Gruppe trifft zu. */
export function evaluateGroup(g: Group, data: Data): boolean {
  if (!g.rules.length) return true;
  const results = g.rules.map((r) => (isGroup(r) ? evaluateGroup(r, data) : evaluateRule(r, data)));
  return g.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** Felder, die eine Bedingung verwendet (für die Prüfung des Ablaufs). */
export function conditionFields(g: Group): string[] {
  return [...new Set(g.rules.flatMap((r) => (isGroup(r) ? conditionFields(r) : [r.field])))];
}

/* ------------------------------------------------------------------ Entprellen */

/** Schlüssel aus Feldwerten (Groß-/Kleinschreibung und Leerraum egal). */
export function dedupKey(automationId: string, nodeId: string, fields: string[], data: Data): string {
  const parts = fields.map((f) => norm(valueText(data[f])));
  return crypto.createHash('sha256').update(JSON.stringify([automationId, nodeId, parts])).digest('hex');
}

/* ------------------------------------------------------------------ Protokoll */

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * Daten fürs Laufprotokoll: E-Mail-Adressen gekürzt, Texte auf 500 Zeichen, höchstens 60 Felder. Die Eingänge
 * liefern ohnehin nur Felder ohne Personenbezug (FE2/Feuersoftware: Allowlist); Adressen aus E-Mail-Ausgängen
 * erscheinen nur gekürzt.
 */
export function redactForLog(d: unknown, depth = 0): unknown {
  if (d == null) return d;
  if (typeof d === 'string') return d.replace(EMAIL, '$1…@$2').slice(0, 500);
  if (typeof d === 'number' || typeof d === 'boolean') return d;
  if (depth > 3) return '…';
  if (Array.isArray(d)) return d.slice(0, 30).map((x) => redactForLog(x, depth + 1));
  if (typeof d === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d as Record<string, unknown>).slice(0, 60)) out[k] = /password|secret|token/i.test(k) ? '***' : redactForLog(v, depth + 1);
    return out;
  }
  return null;
}

/* ------------------------------------------------------------------ Zeitplan */

export interface ScheduleConfig {
  mode: 'daily' | 'interval';
  time?: string;
  weekdays?: number[];
  minutes?: number;
}

/** Ortszeit-Bestandteile eines Zeitpunkts in einer Zeitzone. */
function localParts(ms: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd };
}

/** UTC-Zeitpunkt für eine Ortszeit (Sommerzeit berücksichtigt). */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = localParts(guess, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return guess - (asUtc - guess);
}

/**
 * Letzter fälliger Termin eines Zeitplans bis `now` (oder null). Täglich: Uhrzeit in der Zeitzone der Instanz, optional
 * nur an Wochentagen (1 = Montag … 7 = Sonntag). Intervall: alle N Minuten ab Mitternacht UTC (mind. 15).
 */
export function lastDueSlot(cfg: ScheduleConfig, now: number, timeZone = 'Europe/Berlin'): Date | null {
  if (cfg.mode === 'interval') {
    const n = Math.max(15, Math.floor(Number(cfg.minutes) || 0));
    if (!n) return null;
    const step = n * 60_000;
    return new Date(Math.floor(now / step) * step);
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(cfg.time ?? '');
  if (!m) return null;
  const days = cfg.weekdays?.length ? cfg.weekdays : [1, 2, 3, 4, 5, 6, 7];
  for (let back = 0; back < 8; back++) {
    const p = localParts(now - back * 86_400_000, timeZone);
    const slot = zonedToUtc(p.y, p.m, p.d, +m[1], +m[2], timeZone);
    if (slot <= now && days.includes(localParts(slot, timeZone).wd)) return new Date(slot);
  }
  return null;
}
