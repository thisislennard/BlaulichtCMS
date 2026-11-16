import crypto from 'node:crypto';
import { z } from 'zod';
import { FIELD_KEY, INPUT_KINDS, LIMITS, NODE_TYPES, OPERATORS, OUTPUT_KINDS, SYSTEM_FIELDS, hasInputPort, outputPorts, type FieldDef, type InputKind, type NodeType, type OutputKind } from './catalog.js';
import { conditionFields, isGroup, placeholders, type Group } from './logic.js';

/*
 * Ablauf (Graph) einer Automation: Knoten mit Ports und Kanten. Prüfung ohne Datenbank (unit-testbar): Aufbau, Kreise,
 * Pflicht-Ports, Grenzen und ob jeder Platzhalter bzw. jedes Bedingungsfeld an dieser Stelle vorhanden ist.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'ungültige Kennung');
const fieldKey = z.string().regex(FIELD_KEY, 'Feldnamen: Kleinbuchstaben, Ziffern und _, beginnend mit einem Buchstaben');
const tpl = (max: number) => z.string().max(max).default('');
const label = z.string().trim().max(80).optional();

const rule = z.object({ field: fieldKey, op: z.enum(Object.keys(OPERATORS) as [keyof typeof OPERATORS, ...(keyof typeof OPERATORS)[]]), value: z.string().max(500).optional() });
const innerGroup = z.object({ combinator: z.enum(['and', 'or']), rules: z.array(rule).max(LIMITS.maxConditionRules) });
const group = z.object({ combinator: z.enum(['and', 'or']), rules: z.array(z.union([rule, innerGroup])).max(LIMITS.maxConditionRules) });

export const NODE_DATA: Record<NodeType, z.ZodType<any>> = {
  input: z.object({ inputId: z.uuid(), label }),
  output: z.object({ outputId: z.uuid(), direct: z.boolean().optional(), label }),
  condition: group.extend({ label }),
  switch: z.object({ field: fieldKey, cases: z.array(z.object({ id, value: z.string().max(200) })).min(1).max(LIMITS.maxCases), label }),
  template: z.object({ fields: z.array(z.object({ key: fieldKey, template: tpl(LIMITS.maxTemplateLength) })).min(1).max(20), label }),
  delay: z.object({ minutes: z.number().int().min(1).max(LIMITS.maxDelayMinutes), label }),
  dedup: z.object({ fields: z.array(fieldKey).min(1).max(5), windowMinutes: z.number().int().min(1).max(LIMITS.maxDedupMinutes), label }),
  approval: z.object({ title: tpl(200), summary: tpl(1000), timeoutHours: z.number().int().min(1).max(LIMITS.maxApprovalHours), label }),
  merge: z.object({ label }),
};

export const graphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id,
        type: z.enum(Object.keys(NODE_TYPES) as [NodeType, ...NodeType[]]),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
        data: z.record(z.string(), z.any()).default({}),
      }),
    )
    .max(LIMITS.maxNodes, `höchstens ${LIMITS.maxNodes} Knoten`),
  edges: z
    .array(z.object({ id, source: id, sourceHandle: z.string().max(60).nullable().default('out'), target: id, targetHandle: z.string().max(20).nullable().optional() }))
    .max(LIMITS.maxEdges, `höchstens ${LIMITS.maxEdges} Verbindungen`),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphNode = Graph['nodes'][number];
export type GraphEdge = Graph['edges'][number];

/** Prüfsumme des Ablaufs ohne Positionen – Verschieben auf der Fläche verlangt keinen neuen Test. */
export function graphHash(g: Graph): string {
  const nodes = [...g.nodes].map((n) => [n.id, n.type, n.data]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const edges = [...g.edges].map((e) => [e.source, e.sourceHandle ?? 'out', e.target]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify(stable({ nodes, edges }))).digest('hex');
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as any)[k])]));
  return v;
}

/* ------------------------------------------------------------------ Ein- und Ausgänge */

export interface InputRef {
  id: string;
  name: string;
  kind: InputKind;
  config: Record<string, any>;
  archived?: boolean;
}
export interface OutputRef {
  id: string;
  name: string;
  kind: OutputKind;
  config: Record<string, any>;
  archived?: boolean;
}

/** Felder eines Eingangs (Art + eigene Felder des manuellen Starts) samt Systemfeldern. */
export function inputFields(input: Pick<InputRef, 'kind' | 'config'>): FieldDef[] {
  const own = input.kind === 'manual' ? ((input.config.fields ?? []) as { key: string; label: string }[]).map((f) => ({ key: f.key, label: f.label, type: 'text' as const, example: '' })) : [];
  return [...SYSTEM_FIELDS, ...INPUT_KINDS[input.kind].fields, ...own];
}

/** Alle Vorlagentexte eines Ausgangs (für die Platzhalterprüfung). */
export function outputTemplates(o: Pick<OutputRef, 'kind' | 'config'>): string[] {
  const c = o.config ?? {};
  switch (o.kind) {
    case 'banner':
      return [c.title, c.text, c.linkUrl, c.linkText];
    case 'post':
      return [c.title, c.body, c.excerpt, c.variants?.wordpress?.title, c.variants?.wordpress?.body, c.variants?.facebook?.body, c.variants?.instagram?.body, c.variants?.threads?.body, c.variants?.x?.body, c.variants?.whatsapp?.body, c.variants?.mastodon?.body, c.variants?.mastodon?.cw, c.variants?.bluesky?.body];
    case 'mail':
      return [c.subject, c.body];
    case 'notify':
      return [c.title, c.body, c.link];
    case 'warning_draft':
      return Object.values(c.data ?? {}) as string[];
    default:
      return [];
  }
}

/** Felder, die ein Ausgang braucht (alle Platzhalter seiner Vorlagen). */
export function outputNeeds(o: Pick<OutputRef, 'kind' | 'config'>): string[] {
  return [...new Set(outputTemplates(o).flatMap((t) => placeholders(t)))];
}

/* ------------------------------------------------------------------ Offene Plätze */

/**
 * Offener Platz aus einer Vorlage: `data.want.kinds` nennt die passenden Arten (z. B. FE2 oder Feuersoftware), damit
 * die Oberfläche nur passende Ein-/Ausgänge anbietet und einen neuen vorbelegt anlegen kann.
 */
export function slotKinds(n: { type: string; data?: any }): string[] {
  const k = n.data?.want?.kinds;
  if (!Array.isArray(k)) return [];
  const known = n.type === 'input' ? INPUT_KINDS : OUTPUT_KINDS;
  return k.filter((x: unknown): x is string => typeof x === 'string' && x in known);
}

/** Felder eines offenen Eingangs-Platzes: gemeinsame Felder der gewünschten Arten, ohne Angabe die aller Arten. */
export function slotFields(n: { type: string; data?: any }): FieldDef[] {
  const kinds = slotKinds(n) as InputKind[];
  const lists = (kinds.length ? kinds : (Object.keys(INPUT_KINDS) as InputKind[])).map((k) => INPUT_KINDS[k].fields);
  const pick = kinds.length ? lists[0].filter((f) => lists.every((l) => l.some((x) => x.key === f.key))) : [...new Map(lists.flat().map((f) => [f.key, f])).values()];
  return [...SYSTEM_FIELDS, ...pick];
}

/* ------------------------------------------------------------------ Prüfung */

export interface Problem {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

export interface Validation {
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
  /** Verfügbare Felder je Knoten (Eingang des Knotens) */
  fields: Record<string, string[]>;
  /** Knoten in Ausführungsreihenfolge (leer bei Kreisen) */
  order: string[];
  /** Ausgänge mit „direkt“ */
  directNodes: string[];
  /** Offene Plätze: Ein- und Ausgangs-Knoten ohne gewählten Eingang bzw. Ausgang (Vorlage, Import) */
  open: string[];
}

/** Topologische Reihenfolge (Kahn); null bei Kreisen. Stabil nach Position (oben links zuerst). */
export function topoOrder(g: Pick<Graph, 'nodes' | 'edges'>): string[] | null {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.target) && indeg.has(e.source)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const pos = new Map(g.nodes.map((n) => [n.id, n.position ?? { x: 0, y: 0 }]));
  const byPos = (a: string, b: string) => pos.get(a)!.y - pos.get(b)!.y || pos.get(a)!.x - pos.get(b)!.x || a.localeCompare(b);
  const ready = [...indeg].filter(([, d]) => d === 0).map(([n]) => n).sort(byPos);
  const out: string[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    out.push(n);
    for (const e of g.edges.filter((x) => x.source === n)) {
      if (!indeg.has(e.target)) continue;
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) {
        ready.push(e.target);
        ready.sort(byPos);
      }
    }
  }
  return out.length === g.nodes.length ? out : null;
}

const nodeName = (n: GraphNode, ctx: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }) => {
  if (n.data?.label) return `„${n.data.label}“`;
  if (n.type === 'input') return `Eingang „${ctx.inputs.get(n.data?.inputId)?.name ?? '?'}“`;
  if (n.type === 'output') return `Ausgang „${ctx.outputs.get(n.data?.outputId)?.name ?? '?'}“`;
  return `„${NODE_TYPES[n.type as NodeType]?.label ?? n.type}“`;
};

/**
 * Ablauf prüfen. Fehler verhindern Test und Aktivierung; Hinweise nicht. Speichern geht immer (Entwurf).
 */
export function validateGraph(g: Graph, ctx: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }): Validation {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const fields: Record<string, string[]> = {};
  const directNodes: string[] = [];
  const open: string[] = [];
  const byId = new Map<string, GraphNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) errors.push({ nodeId: n.id, message: 'Doppelte Knoten-Kennung.' });
    byId.set(n.id, n);
  }
  // Daten je Knotentyp
  for (const n of g.nodes) {
    // Offener Platz (aus einer Vorlage oder einem Import): verständliche Meldung statt „Einstellungen unvollständig“
    if ((n.type === 'input' && !n.data?.inputId) || (n.type === 'output' && !n.data?.outputId)) {
      open.push(n.id);
      errors.push({ nodeId: n.id, message: n.type === 'input' ? `${n.data?.label ? `„${n.data.label}“: ` : ''}Auslöser (Eingang) noch nicht gewählt.` : `${n.data?.label ? `„${n.data.label}“: ` : ''}Aktion (Ausgang) noch nicht gewählt.` });
      continue;
    }
    const r = NODE_DATA[n.type as NodeType]?.safeParse(n.data);
    if (!r?.success) {
      const first = r?.error.issues[0];
      errors.push({ nodeId: n.id, message: `${nodeName(n, ctx)}: Einstellungen unvollständig${first ? ` (${first.path.join('.') || 'Angaben'}: ${first.message})` : ''}.` });
      continue;
    }
    if (n.type === 'input') {
      const inp = ctx.inputs.get(n.data.inputId);
      if (!inp) errors.push({ nodeId: n.id, message: 'Der gewählte Eingang existiert nicht mehr.' });
      else if (inp.archived) errors.push({ nodeId: n.id, message: `Eingang „${inp.name}“ wurde gelöscht.` });
    }
    if (n.type === 'output') {
      const out = ctx.outputs.get(n.data.outputId);
      if (!out) errors.push({ nodeId: n.id, message: 'Der gewählte Ausgang existiert nicht mehr.' });
      else if (out.archived) errors.push({ nodeId: n.id, message: `Ausgang „${out.name}“ wurde gelöscht.` });
      else if (n.data.direct) {
        if (!OUTPUT_KINDS[out.kind].directCapable) errors.push({ nodeId: n.id, message: `${nodeName(n, ctx)}: „${OUTPUT_KINDS[out.kind].label}“ kennt keinen Direktversand.` });
        else directNodes.push(n.id);
      }
    }
    if (n.type === 'condition') {
      const depthOk = (n.data.rules as any[]).every((r) => !isGroup(r) || (r.rules as any[]).every((x) => !isGroup(x)));
      if (!depthOk) errors.push({ nodeId: n.id, message: 'Bedingungen: höchstens eine Ebene Untergruppen.' });
    }
  }
  if (!g.nodes.some((n) => n.type === 'input')) errors.push({ message: 'Der Workflow braucht mindestens einen Auslöser (Eingang).' });
  if (!g.nodes.some((n) => n.type === 'output')) errors.push({ message: 'Der Workflow braucht mindestens eine Aktion (Ausgang).' });

  // Kanten
  const seen = new Set<string>();
  for (const e of g.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) {
      errors.push({ edgeId: e.id, message: 'Verbindung zu einem nicht vorhandenen Knoten.' });
      continue;
    }
    if (e.source === e.target) errors.push({ edgeId: e.id, nodeId: e.source, message: 'Ein Knoten kann nicht mit sich selbst verbunden werden.' });
    if (!outputPorts(s).some((p) => p.id === (e.sourceHandle ?? 'out'))) errors.push({ edgeId: e.id, nodeId: s.id, message: `${nodeName(s, ctx)}: unbekannter Ausgang „${e.sourceHandle}“.` });
    if (!hasInputPort(t.type)) errors.push({ edgeId: e.id, nodeId: t.id, message: `${nodeName(t, ctx)}: Eingänge haben keinen Eingangsanschluss.` });
    const k = `${e.source}|${e.sourceHandle}|${e.target}`;
    if (seen.has(k)) warnings.push({ edgeId: e.id, message: 'Doppelte Verbindung.' });
    seen.add(k);
  }
  const order = topoOrder(g);
  if (!order) errors.push({ message: 'Der Workflow enthält einen Kreis. Verbindungen dürfen nicht zu einem früheren Knoten zurückführen.' });

  // Pflicht-Anschlüsse
  for (const n of g.nodes) {
    const incoming = g.edges.filter((e) => e.target === n.id);
    const outgoing = g.edges.filter((e) => e.source === n.id);
    if (n.type !== 'input' && !incoming.length) errors.push({ nodeId: n.id, message: `${nodeName(n, ctx)} ist nicht angeschlossen (kein eingehender Weg).` });
    if (n.type === 'input' && !outgoing.length) errors.push({ nodeId: n.id, message: `${nodeName(n, ctx)} führt nirgendwohin.` });
    if (n.type !== 'input' && n.type !== 'output' && !outgoing.length) errors.push({ nodeId: n.id, message: `${nodeName(n, ctx)} hat keinen ausgehenden Weg.` });
    if (n.type === 'condition' && outgoing.length && !outgoing.some((e) => e.sourceHandle === 'true')) warnings.push({ nodeId: n.id, message: `${nodeName(n, ctx)}: „trifft zu“ ist nicht angeschlossen.` });
    if (n.type === 'approval' && outgoing.length && !outgoing.some((e) => e.sourceHandle === 'approved')) warnings.push({ nodeId: n.id, message: `${nodeName(n, ctx)}: „freigegeben“ ist nicht angeschlossen.` });
  }

  // Verfügbare Felder (Schnittmenge über alle eingehenden Wege) und Platzhalter
  if (order) {
    const out = new Map<string, Set<string>>();
    for (const nid of order) {
      const n = byId.get(nid)!;
      let avail: Set<string>;
      if (n.type === 'input') {
        const inp = ctx.inputs.get(n.data?.inputId);
        avail = new Set(inp ? inputFields(inp).map((f) => f.key) : slotFields(n).map((f) => f.key));
      } else {
        const sets = g.edges.filter((e) => e.target === nid && out.has(e.source)).map((e) => out.get(e.source)!);
        avail = sets.length ? new Set([...sets[0]].filter((k) => sets.every((s) => s.has(k)))) : new Set();
      }
      fields[nid] = [...avail].sort();
      const missing = (keys: string[], what: string) => {
        const m = keys.filter((k) => !avail.has(k));
        if (m.length) errors.push({ nodeId: nid, message: `${nodeName(n, ctx)}: ${what} ${m.map((k) => `„${k}“`).join(', ')} ${m.length === 1 ? 'steht' : 'stehen'} hier nicht zur Verfügung.` });
      };
      const produced = new Set(avail);
      if (NODE_DATA[n.type as NodeType]?.safeParse(n.data).success) {
        switch (n.type) {
          case 'condition':
            missing(conditionFields(n.data as Group), 'Feld');
            break;
          case 'switch':
            missing([n.data.field], 'Feld');
            break;
          case 'template':
            for (const f of n.data.fields as { key: string; template: string }[]) {
              missing(placeholders(f.template), 'Platzhalter');
              produced.add(f.key);
            }
            break;
          case 'dedup':
            missing(n.data.fields, 'Feld');
            break;
          case 'approval':
            missing([...placeholders(n.data.title), ...placeholders(n.data.summary)], 'Platzhalter');
            break;
          case 'output': {
            const o = ctx.outputs.get(n.data.outputId);
            if (o) {
              missing(outputNeeds(o), 'Platzhalter');
              for (const f of OUTPUT_KINDS[o.kind].produces) produced.add(f.key);
            }
            break;
          }
        }
      } else if (n.type === 'output' && !n.data?.outputId) {
        for (const k of slotKinds(n)) for (const f of OUTPUT_KINDS[k as OutputKind]?.produces ?? []) produced.add(f.key);
      }
      out.set(nid, produced);
    }
    // Nicht erreichbare Knoten (nur über Knoten ohne Eingang erreichbar ist ausgeschlossen, weil jeder Knoten einen Eingang braucht)
  }
  return { ok: errors.length === 0, errors, warnings, fields, order: order ?? [], directNodes, open };
}
