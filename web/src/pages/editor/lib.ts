/* Reine Hilfsfunktionen des Workflow-Editors (ohne React). */
import type { Catalog, Graph, GraphEdge, GraphNode, NodeTypeInfo, PortDef } from '../../api/types';
import { t } from '../../i18n';

export const NODE_W = 200;
export const NODE_H = 100;
export const KEY_RE = /^[a-z_][a-z0-9_]{0,40}$/;
export const RESERVED_KEYS = new Set(['trigger', 'run', 'now', 'env']);

export const T = (k: string, v?: Record<string, string | number>) => t(`editor.${k}`, v);

export function typeOf(catalog: Catalog | undefined | null, type: string): NodeTypeInfo | undefined {
  return catalog?.nodes.find((n) => n.type === type);
}

/** Ausgänge eines Bausteins – dynamische (Switch-Fälle) werden hier wie im Server berechnet. */
export function portsOf(info: NodeTypeInfo | undefined, node: GraphNode): PortDef[] {
  let ports: PortDef[];
  if (!info) ports = [{ id: 'out', label: T('port.out') }];
  else if (info.outputs) ports = info.outputs;
  else if (info.type === 'logic.switch') {
    const cases = (Array.isArray(node.config?.cases) ? node.config.cases : []) as { id: string; label: string }[];
    ports = [...cases.map((c) => ({ id: `case:${c.id}`, label: c.label || c.id })), { id: 'default', label: T('port.default') }];
  } else ports = [{ id: 'out', label: T('port.out') }];
  if (node.settings?.onError === 'continue') ports = [...ports, { id: 'error', label: T('port.error') }];
  return ports;
}

/** Variablenname aus dem Titel: „HTTP-Anfrage“ → http_anfrage, bei Bedarf _2, _3 … */
export function uniqueKey(title: string, taken: Set<string>): string {
  let base = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 34);
  if (!base) base = 'baustein';
  if (/^[0-9]/.test(base)) base = `n_${base}`.slice(0, 34);
  if (RESERVED_KEYS.has(base)) base = `${base}_node`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}_${i}`;
    if (!taken.has(k)) return k;
  }
}

export function newId(prefix = 'n'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function edgeId(source: string, port: string, target: string) {
  return `e_${source}_${port}_${target}`;
}

export function defaultConfig(info: NodeTypeInfo): Record<string, any> {
  const c: Record<string, any> = {};
  for (const f of info.fields) if (f.default !== undefined) c[f.key] = structuredClone(f.default);
  return c;
}

export function ancestors(g: Graph, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of g.edges) {
      if (e.target === cur && !seen.has(e.source)) {
        seen.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return seen;
}

/** Würde die neue Kante einen Kreis erzeugen? (Ziel erreicht schon die Quelle) */
export function createsCycle(g: Graph, source: string, target: string): boolean {
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of g.edges) if (e.source === cur) stack.push(e.target);
  }
  return false;
}

/** Einfaches Layering nach topologischer Ordnung (längster Pfad), kein Layout-Paket. */
export function autoLayout(g: Graph): Graph {
  const layer = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  const indeg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of g.edges.filter((x) => x.source === id)) {
      if (!layer.has(e.target)) continue;
      layer.set(e.target, Math.max(layer.get(e.target)!, layer.get(id)! + 1));
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  for (const n of g.nodes) if (!order.includes(n.id)) order.push(n.id);
  const byLayer = new Map<number, string[]>();
  for (const id of order) {
    const l = layer.get(id) ?? 0;
    byLayer.set(l, [...(byLayer.get(l) ?? []), id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const GAP_X = 280;
  const GAP_Y = 150;
  const maxCount = Math.max(1, ...[...byLayer.values()].map((l) => l.length));
  for (const [l, ids] of byLayer) {
    const offset = ((maxCount - ids.length) * GAP_Y) / 2;
    ids.forEach((id, i) => pos.set(id, { x: l * GAP_X, y: offset + i * GAP_Y }));
  }
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
}

/** Kurz-Zusammenfassung der Konfiguration für die Beschreibungszeile des Nodes. */
export function summarize(node: GraphNode, info: NodeTypeInfo | undefined, catalog: Catalog | undefined | null): string {
  if (!info) return node.type;
  const c = node.config ?? {};
  if (info.type === 'http.request' && c.url) return `${String(c.method ?? 'GET').toUpperCase()} ${c.url}`;
  for (const f of info.fields) {
    if (f.type === 'secret' || f.advanced) continue;
    const v = c[f.key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    switch (f.type) {
      case 'select': {
        const o = f.options?.find((x) => x.value === v);
        return o ? `${f.label}: ${o.label}` : String(v);
      }
      case 'switch':
        continue;
      case 'conditions': {
        const first = v[0];
        if (!first?.left) continue;
        const op = catalog?.operators.find((o) => o.id === first.op)?.label ?? first.op;
        const more = v.length > 1 ? ` (+${v.length - 1})` : '';
        return `${first.left} ${op} ${first.right ?? ''}`.trim() + more;
      }
      case 'mappings':
      case 'keyvalue':
        return v.map((r: any) => r.key).filter(Boolean).join(', ') || info.description;
      case 'cases':
        return v.map((r: any) => r.label).filter(Boolean).join(' · ');
      case 'multiselect':
      case 'list':
      case 'wpPages':
        return `${f.label}: ${(v as any[]).join(', ')}`;
      case 'json':
        continue;
      default:
        if (typeof v === 'object') continue;
        return String(v);
    }
  }
  return info.description;
}

export type ValueType = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'object' | 'null';

export function valueType(v: unknown): ValueType {
  if (v == null) return 'null';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'date';
  return 'text';
}

export function typeLabel(type: string, v?: unknown): string {
  if (type === 'list' && Array.isArray(v)) return T('types.listN', { n: v.length });
  return T(`types.${type}`);
}

export function shortValue(v: unknown, max = 60): string {
  let s: string;
  if (v === undefined) return '';
  if (v === null) s = 'null';
  else if (typeof v === 'string') s = v;
  else if (Array.isArray(v)) s = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Objekt flach als Pfade bis Tiefe 3 (Listen werden nicht aufgeklappt). */
export function flatten(value: unknown, prefix = '', depth = 0, out: { path: string; value: unknown }[] = []) {
  if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2 && Object.keys(v).length) {
        out.push({ path: p, value: v });
        flatten(v, p, depth + 1, out);
      } else out.push({ path: p, value: v });
    }
  } else if (prefix) out.push({ path: prefix, value });
  return out;
}

/** Daten-Label einer aktiven Kante: „3 Felder · titel, text, farbe“ */
export function dataLabel(v: unknown): string {
  if (v == null) return T('edge.noData');
  if (Array.isArray(v)) return T(v.length === 1 ? 'edge.item' : 'edge.items', { n: v.length });
  if (typeof v === 'object') {
    const keys = Object.keys(v as object);
    const shown = keys.slice(0, 3).join(', ') + (keys.length > 3 ? ', …' : '');
    return `${T(keys.length === 1 ? 'edge.field' : 'edge.fields', { n: keys.length })}${keys.length ? ` · ${shown}` : ''}`;
  }
  return T('edge.value');
}

export function cloneGraph(g: Graph): Graph {
  return structuredClone(g);
}

/** Variablen-Verweise nach Umbenennen eines Schlüssels nachziehen: {{ alt.x }} → {{ neu.x }} */
export function renameKeyRefs(g: Graph, oldKey: string, newKey: string): Graph {
  const re = new RegExp(`(\\{\\{\\s*)${oldKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s.|}])`, 'g');
  const fix = (v: any): any => {
    if (typeof v === 'string') return v.replace(re, `$1${newKey}`);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, config: fix(n.config) })) };
}

export function keyProblem(key: string, nodeId: string, g: Graph): string | null {
  if (!KEY_RE.test(key)) return T('panel.keyInvalid');
  if (RESERVED_KEYS.has(key)) return T('panel.keyReserved');
  if (g.nodes.some((n) => n.id !== nodeId && n.key === key)) return T('panel.keyTaken');
  return null;
}

export function sameEdge(a: GraphEdge, b: { source: string; sourcePort: string; target: string }) {
  return a.source === b.source && a.sourcePort === b.sourcePort && a.target === b.target;
}

export interface StepInfo {
  node_id: string;
  status: 'running' | 'success' | 'error' | 'skipped' | 'waiting' | 'simulated';
  status_text: string | null;
  duration_ms: number | null;
  output_port: string | null;
  output_preview: any;
  error: any;
}

export interface RunInfo {
  id: number;
  status: string;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  simulate: boolean;
  error_message: string | null;
  steps: (StepInfo & { id: number })[];
}

export function isRunFinished(status: string) {
  return !['queued', 'running'].includes(status);
}

/** Letzter Schritt je Baustein */
export function latestSteps(run: RunInfo | null | undefined): Map<string, StepInfo> {
  const m = new Map<string, StepInfo>();
  for (const s of [...(run?.steps ?? [])].sort((a, b) => a.id - b.id)) m.set(s.node_id, s);
  return m;
}
