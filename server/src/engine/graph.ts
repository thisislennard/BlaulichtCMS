import { isIdempotent, nodeType, outputsOf } from '../nodes/registry.js';
import { referencedPaths } from '../lib/template.js';
import type { Field, Graph, GraphNode } from './types.js';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  field?: string;
}

const KEY_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const RESERVED = new Set(['trigger', 'run', 'now', 'env']);

export function fieldVisible(f: Field, config: Record<string, any>): boolean {
  if (!f.showIf) return true;
  const v = config?.[f.showIf.key];
  const eq = f.showIf.equals;
  if (Array.isArray(eq)) return eq.includes(v);
  if (Array.isArray(v)) return v.includes(eq);
  return v === eq;
}

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

export function triggerNode(g: Graph): GraphNode | undefined {
  return g.nodes.find((n) => nodeType(n.type)?.category === 'trigger');
}

/** Topologische Reihenfolge; null bei Zyklus. */
export function topoOrder(g: Graph): GraphNode[] | null {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = g.nodes.filter((n) => indeg.get(n.id) === 0);
  const out: GraphNode[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    for (const e of g.edges.filter((x) => x.source === n.id)) {
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0 && byId.get(e.target)) queue.push(byId.get(e.target)!);
    }
  }
  return out.length === g.nodes.length ? out : null;
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

function templateStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.includes('{{')) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => templateStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => templateStrings(v, out));
  return out;
}

export function validateGraph(g: Graph, ctx: { connections: Map<string, { connector: string; name: string; status: string }> }): Issue[] {
  const issues: Issue[] = [];
  if (!Array.isArray(g?.nodes) || !Array.isArray(g?.edges)) return [{ severity: 'error', message: 'Ungültiges Workflow-Format.' }];
  if (g.nodes.length > 200) issues.push({ severity: 'error', message: 'Höchstens 200 Bausteine pro Workflow.' });

  const triggers = g.nodes.filter((n) => nodeType(n.type)?.category === 'trigger');
  if (triggers.length === 0) issues.push({ severity: 'error', message: 'Der Workflow braucht genau einen Trigger.' });
  if (triggers.length > 1) for (const t of triggers.slice(1)) issues.push({ severity: 'error', nodeId: t.id, message: 'Nur ein Trigger pro Workflow erlaubt.' });
  if (g.nodes.length < 2) issues.push({ severity: 'error', message: 'Nach dem Trigger muss mindestens ein Baustein folgen.' });

  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) issues.push({ severity: 'error', nodeId: n.id, message: 'Doppelte Baustein-ID.' });
    ids.add(n.id);
    if (!KEY_RE.test(n.key ?? '') || RESERVED.has(n.key)) issues.push({ severity: 'error', nodeId: n.id, field: 'key', message: `Variablenname „${n.key}“ ist ungültig (a–z, 0–9, _ ; nicht trigger/run).` });
    else if (keys.has(n.key)) issues.push({ severity: 'error', nodeId: n.id, field: 'key', message: `Variablenname „${n.key}“ wird doppelt verwendet.` });
    keys.set(n.key, n.id);
  }

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) {
      issues.push({ severity: 'error', message: 'Eine Verbindungslinie zeigt auf einen gelöschten Baustein.' });
      continue;
    }
    const st = nodeType(s.type);
    if (st && e.sourcePort !== 'error' && !outputsOf(st, s.config).some((p) => p.id === e.sourcePort)) {
      issues.push({ severity: 'error', nodeId: s.id, message: `Ausgang „${e.sourcePort}“ von „${s.name}“ existiert nicht mehr.` });
    }
    if (e.sourcePort === 'error' && s.settings?.onError !== 'continue') {
      issues.push({ severity: 'error', nodeId: s.id, message: `„${s.name}“ hat einen Fehler-Ausgang verbunden, aber „Bei Fehler fortsetzen“ ist aus.` });
    }
    if (nodeType(t.type)?.category === 'trigger') issues.push({ severity: 'error', nodeId: t.id, message: 'In einen Trigger darf keine Linie führen.' });
    if (e.source === e.target) issues.push({ severity: 'error', nodeId: s.id, message: 'Ein Baustein darf nicht mit sich selbst verbunden sein.' });
  }
  if (!topoOrder(g)) issues.push({ severity: 'error', message: 'Der Workflow enthält eine Schleife. Schleifen sind nicht erlaubt.' });

  const trig = triggers[0];
  const reachable = new Set<string>();
  if (trig) {
    const stack = [trig.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const e of g.edges) if (e.source === cur) stack.push(e.target);
    }
  }

  for (const n of g.nodes) {
    const t = nodeType(n.type);
    if (!t) {
      issues.push({ severity: 'error', nodeId: n.id, message: `Unbekannter Bausteintyp „${n.type}“.` });
      continue;
    }
    if (trig && !reachable.has(n.id) && !n.disabled) issues.push({ severity: 'error', nodeId: n.id, message: `„${n.name}“ ist nicht mit dem Trigger verbunden.` });
    for (const f of t.fields) {
      if (f.required && fieldVisible(f, n.config) && isEmpty(n.config?.[f.key])) {
        issues.push({ severity: 'error', nodeId: n.id, field: f.key, message: `${n.name}: „${f.label}“ fehlt.` });
      }
    }
    for (const m of t.validate?.(n.config ?? {}, n) ?? []) issues.push({ severity: 'error', nodeId: n.id, message: `${n.name}: ${m}` });
    if (t.connector && !t.connectionOptional && !n.connectionId) issues.push({ severity: 'error', nodeId: n.id, field: 'connection', message: `${n.name}: Verbindung auswählen.` });
    if (n.connectionId) {
      const c = ctx.connections.get(n.connectionId);
      if (!c) issues.push({ severity: 'error', nodeId: n.id, field: 'connection', message: `${n.name}: gewählte Verbindung existiert nicht mehr.` });
      else if (c.connector !== t.connector) issues.push({ severity: 'error', nodeId: n.id, field: 'connection', message: `${n.name}: Verbindung passt nicht zum Baustein.` });
      else if (c.status === 'disabled') issues.push({ severity: 'error', nodeId: n.id, field: 'connection', message: `${n.name}: Verbindung „${c.name}“ ist deaktiviert.` });
      else if (c.status === 'error') issues.push({ severity: 'warning', nodeId: n.id, field: 'connection', message: `${n.name}: Verbindung „${c.name}“ meldet einen Fehler.` });
    }
    // Variablen dürfen nur auf vorherige Bausteine verweisen
    const anc = ancestors(g, n.id);
    const allowed = new Set(['trigger', 'run', 'now', ...[...anc].map((id) => byId.get(id)?.key).filter(Boolean)]);
    if (t.category !== 'trigger') {
      for (const tpl of templateStrings(n.config)) {
        for (const p of referencedPaths(tpl)) {
          if (!allowed.has(p[0])) {
            issues.push({ severity: 'error', nodeId: n.id, message: `${n.name}: Variable „${p.join('.')}“ verweist auf keinen vorherigen Baustein.` });
          }
        }
      }
    }
    const s = n.settings ?? {};
    if (s.timeoutSec != null && (s.timeoutSec < 1 || s.timeoutSec > 300)) issues.push({ severity: 'error', nodeId: n.id, message: `${n.name}: Zeitlimit muss zwischen 1 und 300 Sekunden liegen.` });
    if (s.retries != null && (s.retries < 0 || s.retries > 10)) issues.push({ severity: 'error', nodeId: n.id, message: `${n.name}: höchstens 10 Wiederholungen.` });
  }
  return dedupe(issues);
}

function dedupe(list: Issue[]): Issue[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = `${i.nodeId}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Vorschau vor dem Veröffentlichen: Trigger, genutzte Felder, Ziele, Wiederholverhalten. */
export function publishPreview(g: Graph, connections: Map<string, { connector: string; name: string; status: string }>) {
  const trig = triggerNode(g);
  const tt = trig ? nodeType(trig.type) : undefined;
  const fields = new Set<string>();
  for (const n of g.nodes) for (const tpl of templateStrings(n.config)) for (const p of referencedPaths(tpl)) fields.add(p.join('.'));
  const actions = g.nodes
    .filter((n) => nodeType(n.type)?.sideEffect)
    .map((n) => {
      const t = nodeType(n.type)!;
      const conn = n.connectionId ? connections.get(n.connectionId) : undefined;
      const targets: string[] = [];
      for (const k of t.targetFields ?? []) {
        const v = n.config?.[k];
        if (Array.isArray(v)) targets.push(...v.map(String));
        else if (v) targets.push(String(v));
      }
      const idem = isIdempotent(t, n.config);
      return {
        nodeId: n.id,
        name: n.name,
        type: t.title,
        connection: conn?.name ?? null,
        targets,
        idempotent: idem,
        retry: idem
          ? `Wird bei vorübergehenden Fehlern automatisch bis zu ${n.settings?.retries ?? 3}× wiederholt.`
          : 'Wird nicht automatisch wiederholt, wenn unklar ist, ob die Aktion schon ausgeführt wurde (Doppelwirkung möglich).',
      };
    });
  return {
    trigger: trig ? { name: trig.name, type: tt?.title ?? trig.type } : null,
    fieldsUsed: [...fields].sort(),
    actions,
    connectionsUsed: [...new Set(g.nodes.map((n) => n.connectionId).filter(Boolean) as string[])].map((id) => connections.get(id)?.name ?? 'unbekannt'),
  };
}

/** Änderungen gegenüber einer anderen Version (für „Änderungen gegenüber aktiver Version“). */
export function diffGraphs(from: Graph | null, to: Graph) {
  const a = new Map((from?.nodes ?? []).map((n) => [n.id, n]));
  const b = new Map(to.nodes.map((n) => [n.id, n]));
  const added = to.nodes.filter((n) => !a.has(n.id)).map((n) => n.name);
  const removed = (from?.nodes ?? []).filter((n) => !b.has(n.id)).map((n) => n.name);
  const changed = to.nodes
    .filter((n) => a.has(n.id))
    .filter((n) => {
      const o = a.get(n.id)!;
      return JSON.stringify([o.config, o.settings, o.connectionId, o.name, o.disabled]) !== JSON.stringify([n.config, n.settings, n.connectionId, n.name, n.disabled]);
    })
    .map((n) => n.name);
  const ek = (g: Graph | null) => new Set((g?.edges ?? []).map((e) => `${e.source}:${e.sourcePort}>${e.target}`));
  const ea = ek(from);
  const eb = ek(to);
  const edgesChanged = ea.size !== eb.size || [...eb].some((e) => !ea.has(e));
  return { added, removed, changed, edgesChanged, identical: !added.length && !removed.length && !changed.length && !edgesChanged };
}

export function emptyGraph(): Graph {
  return { nodes: [], edges: [] };
}
