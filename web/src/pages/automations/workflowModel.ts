/*
 * Geführte Ansicht „Wenn → Nur wenn → Dann“: Umwandlung zwischen gespeichertem Ablauf (Knoten + Kanten) und einem
 * einfachen Modell. Reine Funktionen ohne React – getestet in server/test/workflow-guided.test.ts.
 *
 * Darstellbar ist ein Ablauf genau dann, wenn er nur aus Eingängen, höchstens einer Bedingung (ohne Untergruppen) und
 * Ausgängen besteht und die Kanten genau dem Muster entsprechen: ohne Bedingung jeder Eingang → jeder Ausgang, mit
 * Bedingung jeder Eingang → Bedingung und Bedingung („trifft zu“) → jeder Ausgang. Alles andere bleibt dem
 * erweiterten Editor vorbehalten – die geführte Ansicht ändert solche Abläufe nie.
 */

export interface GuidedNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: any;
}
export interface GuidedEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle?: string | null;
}
export interface GuidedGraph {
  nodes: GuidedNode[];
  edges: GuidedEdge[];
}

export interface GuidedRule {
  field: string;
  op: string;
  value?: string;
}

export interface GuidedModel {
  /** Auslöser: Knoten-ID und Daten (inputId, label, want …) */
  inputs: { id: string; data: Record<string, any> }[];
  /** Bedingung (null = keine). Weitere Angaben der Bedingung (z. B. label) bleiben in `extra` erhalten. */
  condition: null | { id: string; combinator: 'and' | 'or'; rules: GuidedRule[]; extra: Record<string, any> };
  /** Aktionen: Knoten-ID und Daten (outputId, direct, label, want …) */
  outputs: { id: string; data: Record<string, any> }[];
}

export type FromGraph = { ok: true; model: GuidedModel } | { ok: false; reasons: string[] };

const STEP_LABEL: Record<string, string> = { switch: 'Verzweigung', template: 'Felder setzen', delay: 'Warten', dedup: 'Einmal je Vorgang', approval: 'Freigabe anfordern', merge: 'Zusammenführen', image: 'Bild aus Vorlage erzeugen' };

const key = (source: string, handle: string, target: string) => `${source}|${handle}|${target}`;

/** Kanten, die das Modell verlangt (ohne IDs). */
function expectedEdges(m: GuidedModel): { source: string; sourceHandle: string; target: string }[] {
  const out: { source: string; sourceHandle: string; target: string }[] = [];
  if (m.condition) {
    for (const i of m.inputs) out.push({ source: i.id, sourceHandle: 'out', target: m.condition.id });
    for (const o of m.outputs) out.push({ source: m.condition.id, sourceHandle: 'true', target: o.id });
  } else {
    for (const i of m.inputs) for (const o of m.outputs) out.push({ source: i.id, sourceHandle: 'out', target: o.id });
  }
  return out;
}

const byPos = (a: GuidedNode, b: GuidedNode) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id);

/** Ablauf → Modell, oder die Gründe, warum die geführte Ansicht ihn nicht darstellen kann. */
export function graphToGuided(g: GuidedGraph): FromGraph {
  const reasons: string[] = [];
  const other = g.nodes.filter((n) => n.type !== 'input' && n.type !== 'output' && n.type !== 'condition');
  const conds = g.nodes.filter((n) => n.type === 'condition');
  if (other.length) reasons.push(`Enthält Schritte, die nur der erweiterte Editor zeigt: ${[...new Set(other.map((n) => STEP_LABEL[n.type] ?? n.type))].join(', ')}.`);
  if (conds.length > 1) reasons.push('Mehrere Bedingungen hintereinander oder nebeneinander.');
  const c = conds[0];
  const rules = (c?.data?.rules ?? []) as any[];
  if (c && rules.some((r) => Array.isArray(r?.rules))) reasons.push('Die Bedingung enthält Untergruppen.');
  if (reasons.length) return { ok: false, reasons };
  const model: GuidedModel = {
    inputs: g.nodes.filter((n) => n.type === 'input').sort(byPos).map((n) => ({ id: n.id, data: { ...(n.data ?? {}) } })),
    condition: c ? { id: c.id, combinator: c.data?.combinator === 'or' ? 'or' : 'and', rules: rules.map((r) => ({ ...r })), extra: Object.fromEntries(Object.entries(c.data ?? {}).filter(([k]) => k !== 'combinator' && k !== 'rules')) } : null,
    outputs: g.nodes.filter((n) => n.type === 'output').sort(byPos).map((n) => ({ id: n.id, data: { ...(n.data ?? {}) } })),
  };
  const want = new Set(expectedEdges(model).map((e) => key(e.source, e.sourceHandle, e.target)));
  const have = new Set(g.edges.map((e) => key(e.source, e.sourceHandle ?? 'out', e.target)));
  if (have.size !== g.edges.length) return { ok: false, reasons: ['Doppelte Verbindungen.'] };
  const same = want.size === have.size && [...want].every((k) => have.has(k));
  if (!same) {
    const falseUsed = c && g.edges.some((e) => e.source === c.id && e.sourceHandle === 'false');
    return { ok: false, reasons: [falseUsed ? 'Der Weg „trifft nicht zu“ der Bedingung ist belegt.' : 'Die Verbindungen weichen vom einfachen Muster „Wenn → Nur wenn → Dann“ ab (z. B. nur einzelne Aktionen nach der Bedingung).'] };
  }
  return { ok: true, model };
}

/**
 * Modell → Ablauf. Vorhandene Knoten behalten Position und unbekannte Angaben; Kanten, die es schon gab, behalten
 * ihre ID. Neue Knoten werden spaltenweise angeordnet (Auslöser links, Bedingung Mitte, Aktionen rechts).
 */
export function guidedToGraph(m: GuidedModel, prev: GuidedGraph = { nodes: [], edges: [] }, newId: (prefix: string) => string = defaultId): GuidedGraph {
  const old = new Map(prev.nodes.map((n) => [n.id, n]));
  // Spalten aus dem bisherigen Ablauf: neue Knoten kommen unter die vorhandenen ihrer Spalte, nie übereinander
  const keep = (ids: string[]) => ids.map((id) => old.get(id)).filter((n): n is GuidedNode => !!n);
  const oldIns = keep(m.inputs.map((x) => x.id));
  const inX = oldIns.length ? Math.max(...oldIns.map((n) => n.position.x)) : 0;
  const condOld = m.condition ? old.get(m.condition.id) : undefined;
  const condX = condOld?.position.x ?? inX + 320;
  const outMinX = (m.condition ? condX : inX) + 320;
  const place = (ids: string[], x: number, shift: boolean) => {
    let y = Math.max(-170, ...keep(ids).map((n) => n.position.y));
    return new Map(
      ids.map((id) => {
        const o = old.get(id);
        if (o) return [id, shift && o.position.x < outMinX ? { x: outMinX, y: o.position.y } : o.position];
        y += 170;
        return [id, { x, y }];
      }),
    );
  };
  const inPos = place(m.inputs.map((x) => x.id), inX, false);
  // Neue Bedingung zwischen Auslöser und Aktionen: Aktionen rücken nach rechts, statt unter der Bedingung zu liegen
  const outPos = place(m.outputs.map((x) => x.id), outMinX, !!m.condition && !condOld);
  const nodes: GuidedNode[] = [
    ...m.inputs.map((x) => ({ id: x.id, type: 'input', position: inPos.get(x.id)!, data: x.data })),
    ...(m.condition ? [{ id: m.condition.id, type: 'condition', position: condOld?.position ?? { x: condX, y: 0 }, data: { ...m.condition.extra, combinator: m.condition.combinator, rules: m.condition.rules } }] : []),
    ...m.outputs.map((x) => ({ id: x.id, type: 'output', position: outPos.get(x.id)!, data: x.data })),
  ];
  const oldEdges = new Map(prev.edges.map((e) => [key(e.source, e.sourceHandle ?? 'out', e.target), e]));
  const edges: GuidedEdge[] = expectedEdges(m).map((e) => {
    const o = oldEdges.get(key(e.source, e.sourceHandle, e.target));
    return o ? { ...o, sourceHandle: o.sourceHandle ?? 'out' } : { id: newId('e'), ...e, targetHandle: 'in' };
  });
  return { nodes, edges };
}

function defaultId(prefix: string) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

/** Offener Platz: Ein-/Ausgangs-Knoten ohne gewählten Eingang bzw. Ausgang. */
export function isOpenSlot(n: { type: string; data?: any }): boolean {
  return (n.type === 'input' && !n.data?.inputId) || (n.type === 'output' && !n.data?.outputId);
}

/** Gewünschte Arten eines offenen Platzes (aus einer Vorlage). */
export function wantKinds(data: any): string[] {
  return Array.isArray(data?.want?.kinds) ? data.want.kinds.filter((k: unknown) => typeof k === 'string') : [];
}

export interface ChecklistInput {
  graph: GuidedGraph;
  validation: { ok: boolean; errors: { nodeId?: string; message: string }[]; open?: string[] };
  dirty: boolean;
  tested: boolean;
  directMarked: number;
  directAllowed: boolean;
  canPublish: boolean;
  enabled: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  state: 'ok' | 'todo' | 'info';
  hint?: string;
}

/** Was vor dem Aktivieren noch fehlt – aus der Prüfung des Servers und dem Zustand des Entwurfs. */
export function activationChecklist(x: ChecklistInput): ChecklistItem[] {
  const ins = x.graph.nodes.filter((n) => n.type === 'input');
  const outs = x.graph.nodes.filter((n) => n.type === 'output');
  const openIn = ins.filter(isOpenSlot).length;
  const openOut = outs.filter(isOpenSlot).length;
  const slotErrors = new Set(x.graph.nodes.filter(isOpenSlot).map((n) => n.id));
  const otherErrors = x.validation.errors.filter((e) => !e.nodeId || !slotErrors.has(e.nodeId)).length;
  const items: ChecklistItem[] = [
    { id: 'input', label: 'Auslöser gewählt', state: ins.length && !openIn ? 'ok' : 'todo', hint: !ins.length ? 'Noch kein Auslöser.' : openIn ? `${openIn} Auslöser noch offen.` : undefined },
    { id: 'output', label: 'Aktion gewählt', state: outs.length && !openOut ? 'ok' : 'todo', hint: !outs.length ? 'Noch keine Aktion.' : openOut ? `${openOut} ${openOut === 1 ? 'Aktion' : 'Aktionen'} noch offen.` : undefined },
    { id: 'valid', label: 'Ablauf ohne Fehler', state: x.validation.ok ? 'ok' : 'todo', hint: !x.validation.ok && otherErrors ? `${otherErrors} weitere${otherErrors === 1 ? 'r' : ''} Fehler (siehe Prüfung).` : undefined },
    { id: 'saved', label: 'Gespeichert', state: x.dirty ? 'todo' : 'ok' },
    { id: 'tested', label: 'Erfolgreich getestet', state: x.tested && !x.dirty ? 'ok' : 'todo', hint: x.tested && !x.dirty ? undefined : 'Testlauf mit Beispieldaten – nichts wird angelegt oder gesendet.' },
  ];
  if (x.directMarked) {
    const ok = x.canPublish && x.directAllowed;
    items.push({ id: 'direct', label: 'Direktversand erlaubt', state: ok ? 'ok' : 'todo', hint: !x.canPublish ? 'Nur mit dem Recht „Workflows direkt veröffentlichen lassen“ (Administration).' : !x.directAllowed ? 'Im Menü „Direktversand erlauben …“ (mit Passwortbestätigung).' : undefined });
  } else {
    items.push({ id: 'direct', label: 'Ergebnisse gehen zur Freigabe', state: 'info', hint: 'Kein Direktversand: Banner und Beiträge veröffentlicht erst ein Mensch.' });
  }
  if (!x.enabled) items.push({ id: 'enabled', label: 'Workflows global eingeschaltet', state: 'todo', hint: 'Einstellungen → Redaktion → „Workflows ausführen“.' });
  return items;
}
