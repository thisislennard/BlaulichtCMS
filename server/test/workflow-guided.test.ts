import { describe, expect, it } from 'vitest';
import { activationChecklist, graphToGuided, guidedToGraph, type GuidedGraph } from '../../web/src/pages/automations/workflowModel.js';
import { graphSchema, validateGraph, type InputRef, type OutputRef } from '../src/automations/graph.js';
import { summarizeGraph } from '../src/automations/summary.js';
import { TEMPLATES, templateGraph } from '../src/automations/templates.js';
import { INPUT_KINDS, OUTPUT_KINDS } from '../src/automations/catalog.js';
import { OUTPUT_CONFIG, INPUT_CONFIG } from '../src/automations/configs.js';

/* Workflows: geführte Ansicht (Umwandlung, Roundtrip, Checkliste), Vorlagen und Zusammenfassung – ohne Datenbank. */

const IN = '11111111-1111-4111-8111-111111111111';
const IN2 = '33333333-3333-4333-8333-333333333333';
const OUT = '22222222-2222-4222-8222-222222222222';
const OUT2 = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const inputs = new Map<string, InputRef>([
  [IN, { id: IN, name: 'FE2 Leitstelle', kind: 'fe2', config: { connectionId: IN, phases: ['neu'] } }],
  [IN2, { id: IN2, name: 'Unwetter', kind: 'warnfeed', config: { connectionId: IN2, phases: ['neu'], onlyInArea: true } }],
]);
const outputs = new Map<string, OutputRef>([
  [OUT, { id: OUT, name: 'Banner Einsatz', kind: 'banner', config: { siteIds: [SITE], title: 'Einsatz {{stichwort}}', tone: 'warning', submit: true } }],
  [OUT2, { id: OUT2, name: 'Entwurf', kind: 'post', config: { kind: 'incident', title: '{{stichwort_text}}', submit: false } }],
]);
const refs = { inputs, outputs };
const n = (id: string, type: string, data: any, x = 0, y = 0) => ({ id, type, position: { x, y }, data });
const e = (id: string, source: string, target: string, sourceHandle = 'out') => ({ id, source, sourceHandle, target, targetHandle: 'in' });
const norm = (g: GuidedGraph) => ({ nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...g.edges].map((x) => ({ ...x, targetHandle: x.targetHandle ?? 'in' })).sort((a, b) => a.id.localeCompare(b.id)) });
let seq = 0;
const ids = (p: string) => `${p}${++seq}`;

describe('Workflows: geführte Ansicht ↔ Ablauf', () => {
  const simple: GuidedGraph = {
    nodes: [n('in', 'input', { inputId: IN, label: 'Alarm' }, 0, 0), n('if', 'condition', { combinator: 'and', rules: [{ field: 'stichwort', op: 'starts_with', value: 'F 2' }], label: 'Nur F 2' }, 320, 0), n('o1', 'output', { outputId: OUT, direct: true }, 640, 0), n('o2', 'output', { outputId: OUT2 }, 640, 170)],
    edges: [e('a', 'in', 'if'), e('b', 'if', 'o1', 'true'), e('c', 'if', 'o2', 'true')],
  };

  it('Roundtrip: Ablauf → Modell → Ablauf ist unverändert (Positionen, IDs, Zusatzangaben)', () => {
    const r = graphToGuided(simple);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.inputs.map((x) => x.id)).toEqual(['in']);
    expect(r.model.condition?.rules).toHaveLength(1);
    expect(r.model.condition?.extra).toEqual({ label: 'Nur F 2' });
    expect(norm(guidedToGraph(r.model, simple, ids))).toEqual(norm(simple));
  });

  it('Roundtrip ohne Bedingung, leer und mit mehreren Auslösern', () => {
    const direct: GuidedGraph = { nodes: [n('i1', 'input', { inputId: IN }), n('i2', 'input', { inputId: IN2 }, 0, 170), n('o', 'output', { outputId: OUT }, 320, 0)], edges: [e('x', 'i1', 'o'), e('y', 'i2', 'o')] };
    for (const g of [direct, { nodes: [], edges: [] }, { nodes: [n('i', 'input', { want: { kinds: ['fe2'] } })], edges: [] }]) {
      const r = graphToGuided(g);
      expect(r.ok).toBe(true);
      if (r.ok) expect(norm(guidedToGraph(r.model, g, ids))).toEqual(norm(g));
    }
  });

  it('Modell → Ablauf → Modell: neue Bedingung und Aktion bekommen Kanten nach Muster; Ergebnis ist gültig', () => {
    const r = graphToGuided({ nodes: [n('in', 'input', { inputId: IN })], edges: [] });
    if (!r.ok) throw new Error('nicht darstellbar');
    const m = { ...r.model, condition: { id: 'c1', combinator: 'and' as const, rules: [{ field: 'stichwort', op: 'eq', value: 'B2' }], extra: {} }, outputs: [{ id: 'o1', data: { outputId: OUT } }] };
    const g = guidedToGraph(m, { nodes: [n('in', 'input', { inputId: IN })], edges: [] }, ids);
    expect(g.edges.map((x) => [x.source, x.sourceHandle, x.target])).toEqual([
      ['in', 'out', 'c1'],
      ['c1', 'true', 'o1'],
    ]);
    const back = graphToGuided(g);
    expect(back.ok && back.model).toEqual(m);
    expect(validateGraph(graphSchema.parse(g), refs).errors).toEqual([]);
    // Bedingung entfernen: Eingang führt wieder direkt zur Aktion
    const g2 = guidedToGraph({ ...m, condition: null }, g, ids);
    expect(g2.nodes.map((x) => x.id)).toEqual(['in', 'o1']);
    expect(g2.edges.map((x) => [x.source, x.target])).toEqual([['in', 'o1']]);
  });

  it('neue Knoten liegen nie übereinander: neue Bedingung schiebt die Aktionen nach rechts, neue Aktion kommt darunter', () => {
    const prev: GuidedGraph = { nodes: [n('in', 'input', { inputId: IN }, 0, 0), n('o', 'output', { outputId: OUT }, 320, 0)], edges: [e('a', 'in', 'o')] };
    const r = graphToGuided(prev);
    if (!r.ok) throw new Error('nicht darstellbar');
    const g = guidedToGraph({ ...r.model, condition: { id: 'c', combinator: 'and', rules: [], extra: {} }, outputs: [...r.model.outputs, { id: 'o2', data: {} }] }, prev, ids);
    const at = (id: string) => g.nodes.find((x) => x.id === id)!.position;
    expect(at('c')).toEqual({ x: 320, y: 0 });
    expect(at('o')).toEqual({ x: 640, y: 0 });
    expect(at('o2')).toEqual({ x: 640, y: 170 });
  });

  it('komplexe Abläufe sind nicht darstellbar (mit Grund) – Verzweigung, Warten, Untergruppen, „trifft nicht zu“, Teilverbindungen', () => {
    const cases: [GuidedGraph, RegExp][] = [
      [{ nodes: [...simple.nodes, n('w', 'delay', { minutes: 5 })], edges: simple.edges }, /Warten/],
      [{ nodes: [n('i', 'input', { inputId: IN }), n('s', 'switch', { field: 'vorgang', cases: [{ id: 'c', value: 'neu' }] })], edges: [e('a', 'i', 's')] }, /Verzweigung/],
      [{ nodes: [n('i', 'input', { inputId: IN }), n('c', 'condition', { combinator: 'and', rules: [{ combinator: 'or', rules: [] }] })], edges: [] }, /Untergruppen/],
      [{ nodes: simple.nodes, edges: [...simple.edges, e('d', 'if', 'o2', 'false')] }, /trifft nicht zu/],
      [{ nodes: simple.nodes, edges: simple.edges.slice(0, 2) }, /Muster/],
      [{ nodes: [...simple.nodes, n('if2', 'condition', { combinator: 'and', rules: [] })], edges: simple.edges }, /Mehrere Bedingungen/],
    ];
    for (const [g, why] of cases) {
      const r = graphToGuided(g);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(' ')).toMatch(why);
    }
  });

  it('Checkliste vor dem Aktivieren nennt offene Plätze, fehlenden Test und Direktversand', () => {
    const g: GuidedGraph = { nodes: [n('i', 'input', { want: { kinds: ['fe2'] } }), n('o', 'output', { outputId: OUT, direct: true })], edges: [e('a', 'i', 'o')] };
    const v = validateGraph(graphSchema.parse(g), refs);
    expect(v.open).toEqual(['i']);
    const items = activationChecklist({ graph: g, validation: v, dirty: false, tested: false, directMarked: 1, directAllowed: false, canPublish: false, enabled: false });
    const state = Object.fromEntries(items.map((x) => [x.id, x.state]));
    expect(state).toEqual({ input: 'todo', output: 'ok', valid: 'todo', saved: 'ok', tested: 'todo', direct: 'todo', enabled: 'todo' });
    expect(items.find((x) => x.id === 'direct')!.hint).toMatch(/Recht/);
    const ok = activationChecklist({ graph: simple, validation: { ok: true, errors: [] }, dirty: false, tested: true, directMarked: 0, directAllowed: false, canPublish: false, enabled: true });
    expect(ok.every((x) => x.state !== 'todo')).toBe(true);
  });
});

describe('Workflows: Vorlagen', () => {
  it('bestehen nur aus Arten, Feldern und Einstellungen des Katalogs', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of TEMPLATES) {
      for (const k of t.input?.kinds ?? []) expect(INPUT_KINDS[k], `${t.id}: ${k}`).toBeDefined();
      for (const r of t.rules ?? []) for (const k of t.input!.kinds) expect(INPUT_KINDS[k].fields.some((f) => f.key === r.field), `${t.id}: ${r.field} in ${k}`).toBe(true);
      for (const o of t.outputs) {
        expect(OUTPUT_KINDS[o.kind]).toBeDefined();
        // Startwerte sind gültige Einstellungen, sobald die Pflichtangaben (Website, Rolle …) ergänzt sind
        const extra = o.kind === 'banner' ? { siteIds: [SITE] } : o.kind === 'mail' ? { roles: ['editor'] } : {};
        const r = OUTPUT_CONFIG[o.kind].safeParse({ ...o.preset.config, ...extra });
        expect(r.success, `${t.id}: ${o.kind} ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
      }
      if (t.input?.preset) for (const k of t.input.kinds) expect(INPUT_CONFIG[k].safeParse({ ...t.input.preset.config, connectionId: IN }).success, `${t.id}: ${k}`).toBe(true);
    }
  });

  it('ohne passende Ein-/Ausgänge bleiben die Plätze offen; Platzhalter der Startwerte gibt es am Platz', () => {
    for (const t of TEMPLATES) {
      const { graph, open } = templateGraph(t, { inputs: new Map(), outputs: new Map() });
      expect(open).toBe((t.input ? 1 : 0) + t.outputs.length);
      const v = validateGraph(graph, { inputs: new Map(), outputs: new Map() });
      // Einzige Fehler: offene Plätze – Bedingungsfelder stehen an dieser Stelle zur Verfügung
      expect(v.errors.every((x) => x.nodeId && v.open.includes(x.nodeId)), `${t.id}: ${JSON.stringify(v.errors)}`).toBe(true);
      expect(v.open).toHaveLength(open);
      expect(graphToGuided(graph).ok).toBe(true);
    }
  });

  it('setzt den einzigen passenden Ein- bzw. Ausgang ein und ist dann sofort gültig', () => {
    const t = TEMPLATES.find((x) => x.id === 'alarm-banner')!;
    const { graph, open } = templateGraph(t, refs);
    expect(open).toBe(0);
    expect(validateGraph(graph, refs).errors).toEqual([]);
    // Zwei Beitragsausgänge → offen
    const two = new Map(outputs);
    two.set('66666666-6666-4666-8666-666666666666', { id: '66666666-6666-4666-8666-666666666666', name: 'Zweiter', kind: 'post', config: {} });
    expect(templateGraph(TEMPLATES.find((x) => x.id === 'alarm-fire-post')!, { inputs, outputs: two }).open).toBe(1);
    // Banner mit Einsatz-Platzhaltern passt nicht zur DWD-Vorlage → Platz bleibt offen
    const dwd = templateGraph(TEMPLATES.find((x) => x.id === 'dwd-banner-post')!, refs);
    expect(dwd.graph.nodes.find((x) => x.id === 'out1')!.data).not.toHaveProperty('outputId');
  });
});

describe('Workflows: Zusammenfassung in einem Satz', () => {
  it('beschreibt Auslöser, Bedingung und Aktionen verständlich', () => {
    const g = graphSchema.parse({
      nodes: [n('in', 'input', { inputId: IN }), n('if', 'condition', { combinator: 'and', rules: [{ field: 'stichwort', op: 'starts_with', value: 'F 2' }] }), n('o', 'output', { outputId: OUT })],
      edges: [e('a', 'in', 'if'), e('b', 'if', 'o', 'true')],
    });
    expect(summarizeGraph(g, refs, { sites: new Map([[SITE, 'Website der Wehr']]) })).toBe('Wenn ein neuer Alarm über „FE2 Leitstelle“ eingeht und Stichwort mit „F 2“ beginnt, erscheint nach Freigabe auf „Website der Wehr“ ein Banner der Stufe „Warnung“.');
    expect(summarizeGraph(g, refs)).toContain('auf der Website ein Banner');
  });

  it('Direktversand nur, wenn markiert und erlaubt; offene Plätze und leere Workflows werden benannt', () => {
    const g = graphSchema.parse({ nodes: [n('in', 'input', { inputId: IN2 }), n('o', 'output', { outputId: OUT2, direct: true })], edges: [e('a', 'in', 'o')] });
    expect(summarizeGraph(g, refs)).toBe('Wenn eine neue amtliche Warnung für das eigene Gebiet über „Unwetter“ eingeht, entsteht ein Beitragsentwurf.');
    expect(summarizeGraph(g, refs, {}, true)).toMatch(/direkt auf der Website veröffentlicht/);
    expect(summarizeGraph(graphSchema.parse({ nodes: [], edges: [] }), refs)).toMatch(/Noch leer/);
    const open = templateGraph(TEMPLATES.find((x) => x.id === 'warning-notify')!, { inputs: new Map(), outputs: new Map() }).graph;
    expect(summarizeGraph(open, { inputs: new Map(), outputs: new Map() })).toBe('Wenn eine neue amtliche Warnung für das eigene Gebiet eingeht, geht eine Benachrichtigung in BlaulichtCMS hinaus.');
  });

  it('komplexe Abläufe: Auslöser, Aktionen und Zahl der Zwischenschritte', () => {
    const g = graphSchema.parse({
      nodes: [n('in', 'input', { inputId: IN }), n('w', 'delay', { minutes: 5 }), n('o', 'output', { outputId: OUT2 })],
      edges: [e('a', 'in', 'w'), e('b', 'w', 'o')],
    });
    expect(summarizeGraph(g, refs)).toMatch(/über einen Zwischenschritt \(Warten\)\.$/);
  });
});
