import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  EdgeChangeset,
  NodeChangeset,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './flow.css';
import { Graph as DagreGraph, layout as dagreLayout } from '@dagrejs/dagre';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, Card, cx, ErrorBox, FieldWrap, Input, Notice, PageHeader, SegmentedControl, Select, SkeletonRows, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, UnsavedChangesGuard, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { usePageMeta } from '../../components/layout/AppShell';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { NodePanel, defaultData, newId, ports, type GEdge, type GNode, type NodeType } from './NodePanel';
import { RunDialog, RunsCard, StartDialog, TestDialog, type RunDetail } from './Runs';
import { ActivationChecklist, GuidedEditor } from './Guided';
import { wantKinds, type GuidedGraph } from './workflowModel';
import type { CreateRefRequest } from './CreateRef';
import { AutomationBadge, DirectBadge, Help, STEP_STATUS, inputSummary, outputSummary, useCatalog, useInputs, useOutputs, type Catalog, type InputDef, type OutputDef } from './shared';

// Formulare für Auslöser und Aktionen erst laden, wenn jemand direkt aus dem Workflow einen anlegt
const CreateRefDialog = lazy(() => import('./CreateRef').then((m) => ({ default: m.CreateRefDialog })));

/*
 * Editor eines Workflows: geführte Ansicht „Wenn → Nur wenn → Dann“ (Standard) und erweitert die Fläche (React Flow) mit Palette, Werkzeugleiste, Minikarte und Seitenleiste – dazu eine
 * Listenansicht für Tastatur und Handy („verbinden mit …“). Gespeichert wird nur der Ablauf als Daten.
 */

interface Problem {
  nodeId?: string;
  edgeId?: string;
  message: string;
}
interface Validation {
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
  fields: Record<string, string[]>;
  directNodes: string[];
  open?: string[];
  summary?: string;
}
interface AutomationDetail {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'disabled';
  active_version: number | null;
  active: { version: number; activated_at: string; activated_by_name: string | null; direct_publish: boolean; current: boolean } | null;
  tested: boolean;
  tested_at: string | null;
  direct_publish: boolean;
  direct_publish_at: string | null;
  direct_nodes: number;
  draft_hash: string;
  summary?: string;
  graph: { nodes: GNode[]; edges: GEdge[] };
  validation: Validation;
  versions: { version: number; activated_at: string; direct_publish: boolean; activated_by_name: string | null }[];
}

type FData = { t: NodeType; d: any };
type FNode = Node<FData, 'bc'>;

interface Ctx {
  cat: Catalog;
  inputs: Map<string, InputDef>;
  outputs: Map<string, OutputDef>;
  errors: Record<string, string[]>;
  steps: Record<string, string>;
  readOnly: boolean;
}
const EditorCtx = createContext<Ctx | null>(null);

const CATEGORY = {
  input: { label: 'Auslöser', chip: 'bg-flow-input-soft text-flow-input' },
  process: { label: 'Verarbeitung', chip: 'bg-raised text-fg-muted' },
  output: { label: 'Aktion', chip: 'bg-flow-output-soft text-flow-output' },
} as const;

/** Anzeigename eines Knotens. */
function nodeTitle(t: NodeType, d: any, ctx: Pick<Ctx, 'cat' | 'inputs' | 'outputs'>): string {
  if (d?.label) return d.label;
  if (t === 'input') return ctx.inputs.get(d?.inputId)?.name ?? 'Auslöser wählen';
  if (t === 'output') return ctx.outputs.get(d?.outputId)?.name ?? 'Aktion wählen';
  return ctx.cat.nodeTypes.find((x) => x.type === t)?.label ?? t;
}

/** Kurzbeschreibung unter dem Titel (Bedingung, Zeit, Art …). */
function nodeSummary(t: NodeType, d: any, ctx: Pick<Ctx, 'cat' | 'inputs' | 'outputs'>): string {
  const op = (o: string) => ctx.cat.operators[o] ?? o;
  switch (t) {
    case 'input': {
      const i = ctx.inputs.get(d?.inputId);
      return i ? `${ctx.cat.inputKinds.find((k) => k.kind === i.kind)?.label} · ${inputSummary(i, ctx.cat)}` : 'Noch kein Auslöser gewählt';
    }
    case 'output': {
      const o = ctx.outputs.get(d?.outputId);
      return o ? `${ctx.cat.outputKinds.find((k) => k.kind === o.kind)?.label} · ${outputSummary(o, ctx.cat)}` : 'Noch keine Aktion gewählt';
    }
    case 'condition': {
      const rules = (d?.rules ?? []) as any[];
      const txt = rules.map((r) => (r.rules ? `(${r.rules.length} Regeln)` : `${r.field} ${op(r.op)}${r.value ? ` „${r.value}“` : ''}`)).join(d?.combinator === 'or' ? ' oder ' : ' und ');
      return txt || 'Keine Regeln';
    }
    case 'switch':
      return `nach „${d?.field ?? '?'}“`;
    case 'template':
      return (d?.fields ?? []).map((f: any) => f.key).join(', ');
    case 'delay':
      return `${d?.minutes ?? '?'} Minuten`;
    case 'dedup':
      return `${(d?.fields ?? []).join(' + ')} · ${d?.windowMinutes ?? '?'} min`;
    case 'approval':
      return `Frist ${d?.timeoutHours ?? '?'} h`;
    case 'image':
      return ctx.cat.imageTemplates?.find((t) => t.id === d?.templateId)?.title ?? (d?.templateName ? `„${d.templateName}“ fehlt` : 'Noch keine Bildvorlage gewählt');
    default:
      return '';
  }
}

function FlowNode({ id, data, selected }: NodeProps<FNode>) {
  const ctx = useContext(EditorCtx)!;
  const nt = ctx.cat.nodeTypes.find((x) => x.type === data.t);
  const cat = CATEGORY[nt?.category ?? 'process'];
  const errs = ctx.errors[id] ?? [];
  const ps = ports({ type: data.t, data: data.d });
  const step = ctx.steps[id];
  const title = nodeTitle(data.t, data.d, ctx);
  return (
    <div
      className={cx('relative w-[248px] bg-card border rounded-node text-left', selected ? 'border-primary shadow-selected' : errs.length ? 'border-err' : 'border-line')}
      aria-label={`${cat.label}: ${title}${errs.length ? `, ${errs.length} Fehler` : ''}`}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={cx('w-6 h-6 rounded-chip inline-flex items-center justify-center shrink-0', cat.chip)}>
          <Icon name={nt?.icon ?? 'Box'} size={14} />
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-muted">{cat.label}</span>
        <span className="ml-auto flex items-center gap-1">
          {data.d?.direct && <Badge tone="warning">Direkt</Badge>}
          {step && <Badge tone={STEP_STATUS[step]?.tone ?? 'neutral'}>{STEP_STATUS[step]?.label ?? step}</Badge>}
        </span>
      </div>
      <div className="px-3 pt-1 pb-2">
        <div className="text-sm font-semibold truncate" title={title}>
          {title}
        </div>
        <div className="text-meta text-fg-muted line-clamp-2 break-words">{nodeSummary(data.t, data.d, ctx)}</div>
        {errs.length > 0 && (
          <div className="mt-1 text-meta text-err inline-flex items-center gap-1" title={errs.join('\n')}>
            <Icon name="AlertTriangle" size={12} />
            {errs.length === 1 ? '1 Fehler' : `${errs.length} Fehler`}
          </div>
        )}
      </div>
      {data.t !== 'input' && (
        <>
          <Handle type="target" position={Position.Left} id="in" style={{ top: 22 }} aria-label={`Eingehender Anschluss von „${title}“`} isConnectable={!ctx.readOnly} />
          <span className="absolute left-2 top-[34px] sr-only">ein</span>
        </>
      )}
      <div className="border-t border-line py-1">
        {ps.map((p) => (
          <div key={p.id} className="relative flex justify-end items-center h-6 pr-3.5 text-meta text-fg-muted">
            {p.label}
            <Handle type="source" position={Position.Right} id={p.id} aria-label={`Zweig „${p.label}“ von „${title}“`} isConnectable={!ctx.readOnly} />
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { bc: FlowNode };

const ARIA = {
  'node.a11yDescription.default': 'Enter oder Leertaste wählt den Knoten. Entf entfernt ihn, Escape bricht ab.',
  'node.a11yDescription.keyboardDisabled': 'Enter oder Leertaste wählt den Knoten. Pfeiltasten verschieben ihn, Entf entfernt ihn, Escape bricht ab.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) => `Knoten nach ${direction} verschoben. Neue Position: x ${x}, y ${y}`,
  'edge.a11yDescription.default': 'Enter oder Leertaste wählt die Verbindung. Entf entfernt sie, Escape bricht ab.',
  'controls.ariaLabel': 'Zoom',
  'controls.zoomIn.ariaLabel': 'Vergrößern',
  'controls.zoomOut.ariaLabel': 'Verkleinern',
  'controls.fitView.ariaLabel': 'Einpassen',
  'controls.interactive.ariaLabel': 'Bearbeiten sperren oder freigeben',
  'minimap.ariaLabel': 'Übersichtskarte',
  'handle.ariaLabel': 'Anschluss',
};

const toG = (nodes: FNode[], edges: Edge[]): { nodes: GNode[]; edges: GEdge[] } => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.t, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data.d })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: 'in' })),
});
const fromG = (g: { nodes: GNode[]; edges: GEdge[] }): { nodes: FNode[]; edges: Edge[] } => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: 'bc', position: n.position ?? { x: 0, y: 0 }, data: { t: n.type, d: n.data ?? {} } })),
  edges: g.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: 'in' })),
});

/** Führt ein Weg von `from` zu `to`? (Kreise verhindern) */
function reaches(edges: { source: string; target: string }[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of edges) if (e.source === n) stack.push(e.target);
  }
  return false;
}

function autoLayout(nodes: FNode[], edges: Edge[]): FNode[] {
  const g = new DagreGraph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.measured?.width ?? 248, height: n.measured?.height ?? 120 });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagreLayout(g);
  return nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number; width: number; height: number };
    return { ...n, position: { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2) } };
  });
}

interface PaletteItem {
  key: string;
  type: NodeType;
  label: string;
  hint: string;
  icon: string;
  data: Record<string, any>;
}

function Palette({ items, onAdd, readOnly }: { items: { title: string; manage?: { to: string; label: string }; list: PaletteItem[] }[]; onAdd: (it: PaletteItem) => void; readOnly: boolean }) {
  const nav = useNavigate();
  return (
    <nav aria-label="Bausteine" className="flex flex-col gap-4">
      {items.map((sec) => (
        <div key={sec.title} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between pb-1.5 border-b border-fg">
            <h3 className="m-0 font-mono text-[12px] font-medium uppercase tracking-[0.08em]">{sec.title}</h3>
            {sec.manage && (
              <button type="button" className="text-meta text-fg-muted hover:text-fg" onClick={() => nav(sec.manage!.to)}>
                {sec.manage.label}
              </button>
            )}
          </div>
          {sec.list.length === 0 && <p className="m-0 text-meta text-fg-muted">Noch keine eingerichtet.</p>}
          {sec.list.map((it) => (
            <div
              key={it.key}
              draggable={!readOnly}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-bc-node', JSON.stringify({ type: it.type, data: it.data }));
                e.dataTransfer.effectAllowed = 'move';
              }}
              className={cx('group flex items-center gap-2 px-2 py-1.5 rounded-control border border-line bg-card', !readOnly && 'cursor-grab hover:bg-raised')}
              title={it.hint}
            >
              <Icon name={it.icon} size={15} className="text-fg-muted shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{it.label}</span>
                <span className="block text-meta text-fg-muted truncate">{it.hint}</span>
              </span>
              {!readOnly && <Button size="sm" iconOnly icon="Plus" aria-label={`„${it.label}“ hinzufügen`} onClick={() => onAdd(it)} />}
            </div>
          ))}
        </div>
      ))}
      {!readOnly && <p className="m-0 text-meta text-fg-muted">Auf die Fläche ziehen oder mit „+“ hinzufügen. Verbinden: vom Punkt rechts eines Knotens zum Punkt links des nächsten ziehen.</p>}
    </nav>
  );
}

/** Listenansicht: alle Knoten mit „verbinden mit …“ – ohne Maus und am Handy bedienbar. */
function NodeList({ nodes, edges, onSelect, onConnect, onDisconnect, onRemove, readOnly, palette, onAdd, selectedId }: { nodes: FNode[]; edges: Edge[]; onSelect: (id: string) => void; onConnect: (c: Connection) => void; onDisconnect: (edgeId: string) => void; onRemove: (id: string) => void; readOnly: boolean; palette: PaletteItem[]; onAdd: (it: PaletteItem) => void; selectedId: string | null }) {
  const ctx = useContext(EditorCtx)!;
  const title = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? nodeTitle(n.data.t, n.data.d, ctx) : id;
  };
  const [add, setAdd] = useState('');
  const order = [...nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  return (
    <div className="flex flex-col gap-3">
      {!readOnly && (
        <div className="flex gap-2 items-end flex-wrap">
          <FieldWrap label="Baustein hinzufügen" htmlFor="nl-add" className="flex-1 min-w-[220px]">
            <Select id="nl-add" value={add} onChange={(e) => setAdd(e.target.value)}>
              <option value="">Bitte wählen …</option>
              {palette.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({ctx.cat.nodeTypes.find((t) => t.type === p.type)?.label})
                </option>
              ))}
            </Select>
          </FieldWrap>
          <Button icon="Plus" disabled={!add} onClick={() => (onAdd(palette.find((p) => p.key === add)!), setAdd(''))}>
            Hinzufügen
          </Button>
        </div>
      )}
      {order.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch keine Knoten.</p>}
      <ol className="m-0 p-0 list-none flex flex-col gap-2">
        {order.map((n) => {
          const nt = ctx.cat.nodeTypes.find((t) => t.type === n.data.t);
          const errs = ctx.errors[n.id] ?? [];
          return (
            <li key={n.id} className={cx('rounded-node border p-3 flex flex-col gap-2 bg-card', selectedId === n.id ? 'border-primary shadow-selected' : errs.length ? 'border-err' : 'border-line')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-muted">{CATEGORY[nt?.category ?? 'process'].label}</span>
                <strong className="text-sm">{title(n.id)}</strong>
                {n.data.d?.direct && <Badge tone="warning">Direkt</Badge>}
                {errs.length > 0 && <Badge tone="error">{errs.length} Fehler</Badge>}
                <span className="ml-auto flex gap-1">
                  <Button size="sm" icon={readOnly ? 'Eye' : 'Pencil'} onClick={() => onSelect(n.id)}>
                    {readOnly ? 'Ansehen' : 'Bearbeiten'}
                  </Button>
                  {!readOnly && <Button size="sm" iconOnly icon="Trash2" aria-label={`„${title(n.id)}“ entfernen`} onClick={() => onRemove(n.id)} />}
                </span>
              </div>
              <div className="text-meta text-fg-muted">{nodeSummary(n.data.t, n.data.d, ctx)}</div>
              {ports({ type: n.data.t, data: n.data.d }).map((p) => {
                const outs = edges.filter((e) => e.source === n.id && (e.sourceHandle ?? 'out') === p.id);
                const candidates = nodes.filter((x) => x.id !== n.id && x.data.t !== 'input' && !outs.some((e) => e.target === x.id) && !reaches(edges, x.id, n.id));
                return (
                  <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-fg-muted min-w-[110px]">„{p.label}“ →</span>
                    {outs.map((e) => (
                      <span key={e.id} className="inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-chip bg-raised">
                        {title(e.target)}
                        {!readOnly && (
                          <button type="button" className="w-5 h-5 inline-flex items-center justify-center rounded-chip hover:bg-card" aria-label={`Verbindung „${p.label}“ zu „${title(e.target)}“ entfernen`} onClick={() => onDisconnect(e.id)}>
                            <Icon name="X" size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                    {!readOnly && candidates.length > 0 && (
                      <select aria-label={`„${title(n.id)}“, Zweig „${p.label}“: verbinden mit …`} className="h-7 text-sm bg-bg border border-line rounded-chip px-1.5" value="" onChange={(e) => e.target.value && onConnect({ source: n.id, sourceHandle: p.id, target: e.target.value, targetHandle: 'in' })}>
                        <option value="">verbinden mit …</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {title(c.id)}
                          </option>
                        ))}
                      </select>
                    )}
                    {outs.length === 0 && (readOnly || candidates.length === 0) && <span className="text-meta text-fg-muted">nicht verbunden</span>}
                  </div>
                );
              })}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EditorInner({ a, cat, inputs, outputs }: { a: AutomationDetail; cat: Catalog; inputs: InputDef[]; outputs: OutputDef[] }) {
  const { can } = useAuth();
  const readOnly = !can('automation.manage');
  const canPublish = can('automation.publish');
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const toastError = useErrorToast();
  const ask = useConfirm();
  const rf = useReactFlow<FNode, Edge>();
  const wrapper = useRef<HTMLDivElement>(null);
  // Volle Breite: die Fläche braucht Platz neben Palette und Seitenleiste
  usePageMeta({ title: a.name, fullBleed: true });

  const initial = useMemo(() => fromG(a.graph), [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes] = useState<FNode[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [meta, setMeta] = useState({ name: a.name, description: a.description });
  const [baseHash, setBaseHash] = useState(a.draft_hash);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify({ g: toG(initial.nodes, initial.edges), m: { name: a.name, description: a.description } }));
  const [validation, setValidation] = useState<Validation>(a.validation);
  const [view, setView] = useState<'canvas' | 'list'>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches ? 'list' : 'canvas'));
  const [panelId, setPanelId] = useState<string | null>(null);
  const [mode, setMode] = useState<'guided' | 'advanced'>('guided');
  const [createReq, setCreateReq] = useState<{ req: CreateRefRequest; assign: (id: string) => void } | null>(null);
  const [steps, setSteps] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<null | 'test' | 'start' | 'meta' | 'direct'>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastRecord = useRef(0);
  const [, force] = useState(0);

  const graph = useMemo(() => toG(nodes, edges), [nodes, edges]);
  const currentJson = JSON.stringify({ g: graph, m: meta });
  const dirty = currentJson !== savedJson;
  const inputsById = useMemo(() => new Map(inputs.map((i) => [i.id, i])), [inputs]);
  const outputsById = useMemo(() => new Map(outputs.map((o) => [o.id, o])), [outputs]);
  const errors = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const e of validation.errors) if (e.nodeId) (m[e.nodeId] ??= []).push(e.message);
    return m;
  }, [validation]);
  const ctx: Ctx = { cat, inputs: inputsById, outputs: outputsById, errors, steps, readOnly };

  /* Rückgängig/Wiederholen: Momentaufnahmen von Knoten und Kanten */
  const snapshot = useCallback(() => JSON.stringify({ nodes, edges }), [nodes, edges]);
  const record = useCallback(
    (coalesce = false) => {
      const now = Date.now();
      if (coalesce && now - lastRecord.current < 800) return;
      lastRecord.current = now;
      past.current = [...past.current.slice(-49), snapshot()];
      future.current = [];
      force((x) => x + 1);
    },
    [snapshot],
  );
  const restore = (s: string) => {
    const v = JSON.parse(s) as { nodes: FNode[]; edges: Edge[] };
    setNodes(v.nodes);
    setEdges(v.edges);
  };
  const undo = () => {
    const s = past.current.pop();
    if (!s) return;
    future.current.push(snapshot());
    restore(s);
    force((x) => x + 1);
  };
  const redo = () => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push(snapshot());
    restore(s);
    force((x) => x + 1);
  };

  /* Prüfung des Entwurfs während des Bearbeitens */
  useEffect(() => {
    const t = setTimeout(() => {
      post<Validation>(`/automations/${a.id}/validate`, { graph })
        .then(setValidation)
        .catch(() => {});
    }, 450);
    return () => clearTimeout(t);
  }, [graph, a.id]);

  // React Flow 13 liefert Änderungen als Changeset (statt Array); nur lesend: bloß Auswahl/Größe übernehmen
  const onNodesChange = useCallback(
    (changes: NodeChangeset<FNode>) => {
      if (readOnly) changes = new NodeChangeset<FNode>(changes.toArray().filter((c) => c.type === 'select' || c.type === 'dimensions'));
      if (changes.getByType('remove').length) record();
      setNodes((ns) => changes.applyTo(ns));
      const sel = changes.getByType('select').find((c) => c.selected);
      if (sel) setPanelId(sel.id);
    },
    [readOnly, record],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChangeset<Edge>) => {
      if (readOnly) changes = new EdgeChangeset<Edge>(changes.toArray().filter((c) => c.type === 'select'));
      if (changes.getByType('remove').length) record();
      setEdges((es) => changes.applyTo(es));
    },
    [readOnly, record],
  );
  const valid = useCallback(
    (c: Connection | Edge) => !!c.source && !!c.target && c.source !== c.target && (c.targetHandle ?? 'in') === 'in' && !edges.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? 'out') === (c.sourceHandle ?? 'out')) && !reaches(edges, c.target, c.source),
    [edges],
  );
  const connect = useCallback(
    (c: Connection) => {
      if (readOnly || !valid(c)) return;
      record();
      setEdges((es) => [...es, { id: newId('e'), source: c.source, sourceHandle: c.sourceHandle ?? 'out', target: c.target, targetHandle: 'in' }]);
    },
    [readOnly, valid, record],
  );

  const addNode = (type: NodeType, data: Record<string, any>, position?: { x: number; y: number }) => {
    if (readOnly) return;
    if (nodes.length >= cat.limits.maxNodes) return toast({ tone: 'warning', title: `Höchstens ${cat.limits.maxNodes} Knoten` });
    record();
    let pos = position;
    if (!pos) {
      const r = wrapper.current?.getBoundingClientRect();
      pos = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2 - 120, y: r.top + r.height / 2 - 50 }) : { x: 0, y: 0 };
      // nicht genau übereinander legen
      while (nodes.some((n) => Math.abs(n.position.x - pos!.x) < 20 && Math.abs(n.position.y - pos!.y) < 20)) pos = { x: pos.x + 30, y: pos.y + 30 };
    }
    const id = newId('n');
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: 'bc', position: pos!, selected: true, data: { t: type, d: defaultData(type, data) } }]);
    setPanelId(id);
  };
  /** Ganzen Ablauf ersetzen (geführte Ansicht) – rückgängig machbar wie jede andere Änderung. */
  const applyGraph = (g: GuidedGraph) => {
    if (readOnly) return;
    record();
    const f = fromG(g as { nodes: GNode[]; edges: GEdge[] });
    setNodes(f.nodes);
    setEdges(f.edges);
  };
  /** Auslöser/Aktion aus dem Seitenleisten-Panel direkt anlegen und in den Knoten einsetzen. */
  const createForNode = (n: GNode) => {
    const { want, ...rest } = n.data ?? {};
    setCreateReq({ req: { type: n.type === 'input' ? 'input' : 'output', kinds: wantKinds(n.data), preset: want }, assign: (id) => updateData(n.id, { ...rest, [n.type === 'input' ? 'inputId' : 'outputId']: id }) });
  };
  const removeNode = (id: string) => {
    record();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    if (panelId === id) setPanelId(null);
  };
  const updateData = (id: string, d: any) => {
    record(true);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, d } } : n)));
  };
  const select = (id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setPanelId(id);
    if (view === 'canvas') {
      const n = nodes.find((x) => x.id === id);
      if (n) rf.fitView({ nodes: [{ id }], padding: '22%', duration: 250, maxZoom: 1.2 });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-bc-node');
    if (!raw) return;
    const { type, data } = JSON.parse(raw);
    addNode(type, data, rf.screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 30 }));
  };

  const arrange = () => {
    record();
    setNodes((ns) => autoLayout(ns, edges));
    setTimeout(() => rf.fitView({ padding: '8%', duration: 300 }), 50);
  };
  const focusSelection = () => {
    const sel = nodes.filter((n) => n.selected);
    if (!sel.length) return toast({ tone: 'info', title: 'Kein Knoten gewählt', text: 'Zuerst einen oder mehrere Knoten auswählen.' });
    rf.fitView({ nodes: sel.map((n) => ({ id: n.id })), padding: '19%', duration: 300, maxZoom: 1.4 });
  };
  const removeSelected = () => {
    const ids = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    const eids = new Set(edges.filter((e) => e.selected).map((e) => e.id));
    if (!ids.size && !eids.size) return;
    record();
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !eids.has(e.id) && !ids.has(e.source) && !ids.has(e.target)));
    if (panelId && ids.has(panelId)) setPanelId(null);
  };

  // Erste Anordnung, wenn Positionen fehlen (z. B. per API angelegt) – zählt nicht als ungespeicherte Änderung
  useEffect(() => {
    if (nodes.length > 1 && nodes.every((n) => n.position.x === 0 && n.position.y === 0)) {
      setTimeout(() => {
        const laid = autoLayout(nodes, edges);
        setNodes(laid);
        setSavedJson(JSON.stringify({ g: toG(laid, edges), m: meta }));
        setTimeout(() => rf.fitView({ padding: '6.5%', maxZoom: 1.1 }), 60);
      }, 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (): Promise<boolean> => {
    if (readOnly) return false;
    setSaving(true);
    try {
      const r = await put<AutomationDetail>(`/automations/${a.id}`, { name: meta.name, description: meta.description, graph, baseHash });
      setBaseHash(r.draft_hash);
      setSavedJson(currentJson);
      setValidation({ ...r.validation, summary: r.summary });
      qc.setQueryData(['automation', a.id], (old: AutomationDetail | undefined) => (old ? { ...old, ...r, graph } : old));
      qc.invalidateQueries({ queryKey: ['automations'] });
      toast({ tone: 'success', title: 'Gespeichert', text: r.validation.ok ? 'Für das Aktivieren ist ein erfolgreicher Testlauf nötig.' : 'Der Ablauf hat noch Fehler (siehe Prüfung).' });
      return true;
    } catch (e) {
      toastError(e, 'Nicht gespeichert');
      return false;
    } finally {
      setSaving(false);
    }
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['automation', a.id] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      refresh();
      qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (e) {
      toastError(e);
    }
  };
  const openTest = async () => {
    if (dirty && !(await save())) return;
    setDialog('test');
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault();
      if (dirty) save();
    }
    const target = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) (e.preventDefault(), undo());
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) (e.preventDefault(), redo());
  };

  const palette: { title: string; manage?: { to: string; label: string }; list: PaletteItem[] }[] = [
    {
      title: 'Auslöser',
      manage: { to: '/workflows/ausloeser', label: 'Verwalten →' },
      list: inputs.map((i) => ({ key: `in:${i.id}`, type: 'input', label: i.name, hint: cat.inputKinds.find((k) => k.kind === i.kind)?.label ?? i.kind, icon: cat.inputKinds.find((k) => k.kind === i.kind)?.icon ?? 'Zap', data: { inputId: i.id } })),
    },
    {
      title: 'Verarbeitung',
      list: cat.nodeTypes.filter((t) => t.category === 'process').map((t) => ({ key: `p:${t.type}`, type: t.type as NodeType, label: t.label, hint: t.description, icon: t.icon, data: {} })),
    },
    {
      title: 'Aktionen',
      manage: { to: '/workflows/aktionen', label: 'Verwalten →' },
      list: outputs.map((o) => ({ key: `out:${o.id}`, type: 'output', label: o.name, hint: cat.outputKinds.find((k) => k.kind === o.kind)?.label ?? o.kind, icon: cat.outputKinds.find((k) => k.kind === o.kind)?.icon ?? 'Send', data: { outputId: o.id } })),
    },
  ];
  const flatPalette = palette.flatMap((s) => s.list);

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const k of cat.inputKinds) for (const f of k.fields) m.set(f.key, f.label);
    for (const k of cat.outputKinds) for (const f of k.produces) m.set(f.key, f.label);
    for (const i of inputs) for (const f of i.fields) m.set(f.key, f.label);
    return m;
  }, [cat, inputs]);
  const panelNode = panelId ? graph.nodes.find((n) => n.id === panelId) : undefined;
  const panelFields = panelNode ? (validation.fields[panelNode.id] ?? []).map((k) => ({ key: k, label: labelOf.get(k) ?? k })) : [];

  const rfEdges = useMemo(
    () =>
      edges.map((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const p = src ? ports({ type: src.data.t, data: src.data.d }).find((x) => x.id === (e.sourceHandle ?? 'out')) : undefined;
        const showLabel = p && !['out'].includes(p.id);
        return { ...e, type: 'default', label: showLabel ? p!.label : undefined, labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 4, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }, ariaLabel: `Verbindung von „${src ? nodeTitle(src.data.t, src.data.d, ctx) : e.source}“${showLabel ? ` (${p!.label})` : ''} zu „${(() => { const t = nodes.find((n) => n.id === e.target); return t ? nodeTitle(t.data.t, t.data.d, ctx) : e.target; })()}“` };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, nodes, inputsById, outputsById],
  );

  const manualInputs = (a.status === 'active' ? a.graph.nodes : []).filter((n) => n.type === 'input' && inputsById.get(n.data?.inputId)?.kind === 'manual').map((n) => ({ nodeId: n.id, name: inputsById.get(n.data.inputId)!.name, fields: inputsById.get(n.data.inputId)!.config.fields ?? [] }));
  const testInputs = graph.nodes.filter((n) => n.type === 'input' && inputsById.has(n.data?.inputId)).map((n) => ({ nodeId: n.id, name: nodeTitle('input', n.data, ctx), fields: inputsById.get(n.data.inputId)!.fields.concat(inputsById.get(n.data.inputId)!.kind === 'manual' ? (inputsById.get(n.data.inputId)!.config.fields ?? []).map((f: any) => ({ key: f.key, label: f.label, type: 'text', example: f.example ?? '' })) : []) }));
  const canActivate = !readOnly && !dirty && a.tested && validation.ok && !(a.status === 'active' && a.active?.current);
  const directMarked = graph.nodes.filter((n) => n.type === 'output' && n.data?.direct).length;
  const globalProblems = [...validation.errors.filter((e) => !e.nodeId), ...validation.warnings];
  const summary = validation.summary ?? a.summary;
  const checklist = <ActivationChecklist graph={graph} validation={validation} dirty={dirty} tested={a.tested} directMarked={directMarked} directAllowed={a.direct_publish} canPublish={canPublish} enabled={cat.enabled} />;

  const infoCards = (
    <>
            <Card title="Prüfung" subtitle={validation.ok ? 'Keine Fehler. Vor dem Aktivieren ist ein erfolgreicher Testlauf nötig.' : 'Fehler verhindern Testlauf und Aktivierung; gespeichert werden kann trotzdem.'}>
              {validation.ok && globalProblems.length === 0 && (
                <p className="m-0 text-sm text-ok inline-flex items-center gap-1.5">
                  <Icon name="CheckCircle2" size={15} />
                  Ablauf vollständig.
                </p>
              )}
              <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                {[...validation.errors.map((e) => ({ ...e, tone: 'error' as const })), ...validation.warnings.map((w) => ({ ...w, tone: 'warning' as const }))].map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Icon name={p.tone === 'error' ? 'XCircle' : 'AlertTriangle'} size={15} className={cx('mt-0.5 shrink-0', p.tone === 'error' ? 'text-err' : 'text-warn')} />
                    <span className="flex-1">{p.message}</span>
                    {p.nodeId && graph.nodes.some((n) => n.id === p.nodeId) && (
                      <Button size="sm" variant="ghost" onClick={() => (setMode('advanced'), select(p.nodeId!))}>
                        Zum Knoten
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>

            <RunsCard automationId={a.id} onOpen={setRunId} />

            {a.versions.length > 0 && (
              <Card title="Versionen" subtitle="Jede Aktivierung speichert den getesteten Stand samt Auslösern und Aktionen.">
                <ul className="m-0 p-0 list-none flex flex-col gap-1 text-sm">
                  {a.versions.map((v) => (
                    <li key={v.version} className="flex flex-wrap gap-2 items-center">
                      <span className="font-mono">V{v.version}</span>
                      <span className="text-fg-muted">
                        {fmtDateTime(v.activated_at)}
                        {v.activated_by_name ? ` · ${v.activated_by_name}` : ''}
                      </span>
                      {v.direct_publish && <Badge tone="warning">mit Direktversand</Badge>}
                      {a.active_version === v.version && <Badge tone="success">aktiv</Badge>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
    </>
  );

  return (
    <EditorCtx.Provider value={ctx}>
      <div className="flex flex-col gap-4 w-full max-w-[1920px] mx-auto px-4 md:px-6 pt-8 pb-14" onKeyDown={onKey}>
        <UnsavedChangesGuard when={dirty && !readOnly} text="Der Ablauf hat ungespeicherte Änderungen. Beim Verlassen gehen sie verloren." />
        <PageHeader
          title={meta.name}
          subtitle={meta.description || undefined}
          actions={
            <>
              {!readOnly && (
                <Button variant={dirty ? 'primary' : 'secondary'} icon="Save" loading={saving} disabled={!dirty} onClick={save}>
                  Speichern
                </Button>
              )}
              {!readOnly && (
                <Button icon="FlaskConical" disabled={!validation.ok} title={validation.ok ? 'Entwurf mit Beispieldaten testen' : 'Erst die Fehler beheben'} onClick={openTest}>
                  Testlauf
                </Button>
              )}
              {!readOnly && (a.status !== 'active' || !a.active?.current) && (
                <Button
                  variant={!dirty && canActivate ? 'primary' : 'secondary'}
                  icon="Power"
                  disabled={!canActivate}
                  title={dirty ? 'Erst speichern' : !a.tested ? 'Erst erfolgreich testen' : undefined}
                  onClick={async () => {
                    if (directMarked && !(await ask({ title: 'Mit Direktversand aktivieren?', text: `${directMarked === 1 ? 'Eine Aktion veröffentlicht bzw. versendet' : `${directMarked} Aktionen veröffentlichen bzw. versenden`} ohne menschliche Freigabe. Das wird auditiert und der Administration gemeldet.`, confirmLabel: 'Aktivieren' }))) return;
                    act(() => post(`/automations/${a.id}/activate`), 'Aktiviert');
                  }}
                >
                  {a.status === 'active' ? 'Neue Version aktivieren' : 'Aktivieren'}
                </Button>
              )}
              {!readOnly && a.status === 'active' && (
                <Button variant="danger" icon="PowerOff" onClick={async () => (await ask({ title: 'Workflow deaktivieren?', text: 'Neue Ereignisse starten keine Läufe mehr; wartende Läufe und offene Freigaben werden abgebrochen.', confirmLabel: 'Deaktivieren' })) && act(() => post(`/automations/${a.id}/disable`), 'Deaktiviert')}>
                  Deaktivieren
                </Button>
              )}
              <Menu
                items={[
                  manualInputs.length > 0 && !readOnly && { label: 'Jetzt starten …', icon: 'Play', onClick: () => setDialog('start') },
                  !readOnly && { label: 'Name und Beschreibung …', icon: 'Pencil', onClick: () => setDialog('meta') },
                  !readOnly && (canPublish || a.direct_publish) && { label: a.direct_publish ? 'Direktversand entziehen …' : 'Direktversand erlauben …', icon: 'ShieldAlert', onClick: () => setDialog('direct') },
                  !readOnly && {
                    label: 'Workflow löschen',
                    icon: 'Trash2',
                    danger: true,
                    onClick: async () => {
                      if (!(await ask({ title: 'Workflow löschen?', text: `„${a.name}“ wird deaktiviert und entfernt. Laufprotokolle bleiben bis zur Löschfrist.`, confirmLabel: 'Löschen' }))) return;
                      try {
                        await del(`/automations/${a.id}`);
                        nav('/workflows');
                      } catch (e) {
                        toastError(e);
                      }
                    },
                  },
                ]}
              />
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <AutomationBadge status={a.status} />
            {a.active && (
              <span className="font-mono text-meta text-fg-muted" title={`Aktiviert ${fmtDateTime(a.active.activated_at)}${a.active.activated_by_name ? ` von ${a.active.activated_by_name}` : ''}`}>
                aktiv: V{a.active.version}
              </span>
            )}
            {a.status === 'active' && a.active && !a.active.current && <Badge tone="warning">Entwurf weicht von der aktiven Version ab</Badge>}
            {dirty ? <Badge tone="warning">Ungespeichert</Badge> : a.tested ? <Badge tone="success">Getestet</Badge> : <Badge tone="neutral">Nicht getestet</Badge>}
            {!validation.ok && <Badge tone="error">{validation.errors.length} Fehler</Badge>}
            {a.direct_publish && <DirectBadge />}
            {directMarked > 0 && !a.direct_publish && <Badge tone="neutral">{directMarked} für Direktversand markiert (nicht erlaubt)</Badge>}
            {readOnly && <Badge tone="neutral">Nur lesen</Badge>}
          </div>
          {summary && (
            <p className="m-0 pt-2 text-sm max-w-[900px]" aria-label="Zusammenfassung">
              {summary}
            </p>
          )}
        </PageHeader>

        {!cat.enabled && <Notice tone="warning" title="Workflows sind global abgeschaltet">Läufe starten erst wieder, wenn der Schalter unter Einstellungen → Redaktion an ist.</Notice>}

        <div className="flex items-center gap-3 flex-wrap">
          <SegmentedControl
            label="Bearbeiten"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'guided', label: 'Geführt (Wenn → Dann)' },
              { value: 'advanced', label: 'Erweitert' },
            ]}
          />
          {mode === 'advanced' && (
            <SegmentedControl
              label="Ansicht"
              value={view}
              onChange={setView}
              options={[
                { value: 'canvas', label: 'Fläche' },
                { value: 'list', label: 'Liste (Tastatur, Handy)' },
              ]}
            />
          )}
          <Help title="Editor bedienen" anchor={mode === 'guided' ? 'gefuehrt-wenn-nur-wenn-dann' : 'erweiterter-editor'}>
            Geführt: Auslöser, optionale Bedingungen und Aktionen in drei Schritten. Erweitert: alle Bausteine auf der Fläche.
            Fläche: Bausteine aus der Palette ziehen, Punkte rechts (Zweige) mit dem Punkt links (Anschluss) des nächsten Knotens verbinden, Knoten anklicken zum Einstellen. Entf löscht, Strg+Z/Strg+Y macht rückgängig, Strg+S speichert. Liste: dasselbe ohne Maus über „verbinden mit …“.
          </Help>
          {Object.keys(steps).length > 0 && (
            <Button size="sm" variant="ghost" icon="X" onClick={() => setSteps({})}>
              Laufergebnis ausblenden
            </Button>
          )}
        </div>

        {mode === 'guided' ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
            <div className="min-w-0 flex flex-col gap-4">
              <GuidedEditor graph={graph} onChange={applyGraph} cat={cat} inputs={inputs} outputs={outputs} errors={errors} readOnly={readOnly} onCreate={(req, assign) => setCreateReq({ req, assign })} onAdvanced={() => setMode('advanced')} />
              {infoCards}
            </div>
            <aside className="lg:sticky lg:top-4">{checklist}</aside>
          </div>
        ) : (
        <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)_340px] items-start">
          <aside className="hidden lg:block lg:max-h-[calc(100vh-260px)] overflow-y-auto pr-1">
            <Palette items={palette} onAdd={(it) => addNode(it.type, it.data)} readOnly={readOnly} />
          </aside>

          <div className="min-w-0 flex flex-col gap-4">
            {view === 'canvas' ? (
              <div ref={wrapper} className="bc-flow relative h-[min(72vh,760px)] min-h-[460px] rounded-card border border-line overflow-hidden bg-bg" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))} onDrop={onDrop}>
                <ReactFlow<FNode, Edge>
                  nodes={nodes}
                  edges={rfEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={connect}
                  isValidConnection={valid}
                  onNodeDragStart={() => record()}
                  onPaneClick={() => setPanelId(null)}
                  nodesDraggable={!readOnly}
                  nodesConnectable={!readOnly}
                  deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
                  fitView
                  // Rand in % je Seite: React Flow 13 liest Zahlen ohne Einheit als Pixel (12: 0.2 ≈ 8 %)
                  fitViewOptions={{ padding: '8%', maxZoom: 1.1 }}
                  minZoom={0.2}
                  maxZoom={2}
                  ariaLabelConfig={ARIA as any}
                  defaultEdgeOptions={{ type: 'default' }}
                  proOptions={{ hideAttribution: false }}
                >
                  <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} />
                  <MiniMap pannable zoomable position="bottom-right" nodeBorderRadius={6} ariaLabel="Übersichtskarte" style={{ width: 168, height: 112 }} />
                  <Controls position="bottom-left" showInteractive={false} />
                  <Panel position="top-left">
                    <div role="toolbar" aria-label="Werkzeuge der Fläche" className="flex flex-wrap gap-1 p-1 bg-card border border-line rounded-control shadow-float max-w-[calc(100vw-48px)]">
                      <Button size="sm" variant="ghost" icon="RotateCcw" onClick={() => rf.setViewport({ x: 40, y: 40, zoom: 1 }, { duration: 250 })}>
                        Ansicht zurücksetzen
                      </Button>
                      <Button size="sm" variant="ghost" icon="Maximize2" onClick={() => rf.fitView({ padding: '8%', duration: 250 })}>
                        Einpassen
                      </Button>
                      {!readOnly && (
                        <Button size="sm" variant="ghost" icon="Wand2" disabled={nodes.length < 2} onClick={arrange}>
                          Automatisch anordnen
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon="Search" onClick={focusSelection}>
                        Auswahl fokussieren
                      </Button>
                      {!readOnly && (
                        <>
                          <span aria-hidden="true" className="w-px bg-line mx-0.5" />
                          <Button size="sm" variant="ghost" iconOnly icon="Undo2" aria-label="Rückgängig (Strg+Z)" title="Rückgängig (Strg+Z)" disabled={!past.current.length} onClick={undo} />
                          <Button size="sm" variant="ghost" iconOnly icon="Redo2" aria-label="Wiederholen (Strg+Y)" title="Wiederholen (Strg+Y)" disabled={!future.current.length} onClick={redo} />
                          <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label="Auswahl löschen (Entf)" title="Auswahl löschen (Entf)" disabled={!nodes.some((n) => n.selected) && !edges.some((e) => e.selected)} onClick={removeSelected} />
                        </>
                      )}
                    </div>
                  </Panel>
                  {nodes.length === 0 && (
                    <Panel position="top-center" className="!top-1/3">
                      <div className="text-center text-sm text-fg-muted bg-card border border-line rounded-card px-5 py-4 max-w-[340px]">
                        <Icon name="Workflow" size={22} className="mx-auto mb-2" />
                        Einen Auslöser, die Verarbeitung und eine Aktion aus der Palette auf die Fläche ziehen und verbinden.
                      </div>
                    </Panel>
                  )}
                </ReactFlow>
              </div>
            ) : (
              <Card>
                <NodeList nodes={nodes} edges={edges} onSelect={select} onConnect={connect} onDisconnect={(id) => (record(), setEdges((es) => es.filter((e) => e.id !== id)))} onRemove={removeNode} readOnly={readOnly} palette={flatPalette} onAdd={(it) => addNode(it.type, it.data)} selectedId={panelId} />
              </Card>
            )}

            <div className="lg:hidden">
              <details className="rounded-card border border-line bg-card p-4">
                <summary className="cursor-pointer text-sm font-medium">Bausteine</summary>
                <div className="pt-3">
                  <Palette items={palette} onAdd={(it) => addNode(it.type, it.data)} readOnly={readOnly} />
                </div>
              </details>
            </div>

            {panelNode && (
              <div className="xl:hidden">
                <Card>
                  <NodePanel node={panelNode} onChange={(d) => updateData(panelNode.id, d)} onRemove={() => removeNode(panelNode.id)} onClose={() => setPanelId(null)} cat={cat} inputs={inputs} outputs={outputs} fields={panelFields} errors={errors[panelNode.id] ?? []} canPublish={canPublish} readOnly={readOnly} onCreate={() => createForNode(panelNode)} />
                </Card>
              </div>
            )}

            {checklist}

            {infoCards}
          </div>

          <aside className="hidden xl:block sticky top-4 max-h-[calc(100vh-120px)] overflow-y-auto">
            <Card>
              {panelNode ? (
                <NodePanel node={panelNode} onChange={(d) => updateData(panelNode.id, d)} onRemove={() => removeNode(panelNode.id)} onClose={() => setPanelId(null)} cat={cat} inputs={inputs} outputs={outputs} fields={panelFields} errors={errors[panelNode.id] ?? []} canPublish={canPublish} readOnly={readOnly} onCreate={() => createForNode(panelNode)} />
              ) : (
                <div className="flex flex-col gap-2 text-sm text-fg-muted">
                  <strong className="text-fg">Einstellungen</strong>
                  Einen Knoten anklicken, um ihn einzustellen.
                  <span className="text-meta">
                    {nodes.length} Knoten · {edges.length} Verbindungen (höchstens {cat.limits.maxNodes} bzw. {cat.limits.maxEdges})
                  </span>
                </div>
              )}
            </Card>
          </aside>
        </div>
        )}
      </div>

      {dialog === 'test' && (
        <TestDialog
          automationId={a.id}
          inputs={testInputs}
          onClose={() => setDialog(null)}
          onDone={(r: RunDetail) => {
            setSteps(Object.fromEntries(r.steps.map((s) => [s.node_id, s.status])));
            refresh();
            qc.invalidateQueries({ queryKey: ['automation-runs', a.id] });
          }}
        />
      )}
      {dialog === 'start' && <StartDialog automationId={a.id} inputs={manualInputs} onClose={() => setDialog(null)} onStarted={(id) => (setDialog(null), setRunId(id), qc.invalidateQueries({ queryKey: ['automation-runs', a.id] }))} />}
      {dialog === 'meta' && <MetaDialog value={meta} onClose={() => setDialog(null)} onSave={(m) => (setMeta(m), setDialog(null))} />}
      {dialog === 'direct' && <DirectDialog a={a} onClose={() => setDialog(null)} onDone={() => (setDialog(null), refresh(), qc.invalidateQueries({ queryKey: ['automations'] }))} />}
      {runId && <RunDialog runId={runId} onClose={() => setRunId(null)} />}
      {createReq && (
        <Suspense fallback={null}>
          <CreateRefDialog req={createReq.req} cat={cat} onClose={() => setCreateReq(null)} onCreated={createReq.assign} />
        </Suspense>
      )}
    </EditorCtx.Provider>
  );
}

function MetaDialog({ value, onClose, onSave }: { value: { name: string; description: string }; onClose: () => void; onSave: (v: { name: string; description: string }) => void }) {
  const [v, setV] = useState(value);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Name und Beschreibung"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={v.name.trim().length < 2} onClick={() => onSave({ name: v.name.trim(), description: v.description.trim() })}>
            Übernehmen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Name" htmlFor="m-name" required>
          <Input id="m-name" value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </FieldWrap>
        <FieldWrap label="Beschreibung" htmlFor="m-desc" help="Wird mit „Speichern“ übernommen.">
          <Textarea id="m-desc" rows={3} maxLength={500} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

function DirectDialog({ a, onClose, onDone }: { a: AutomationDetail; onClose: () => void; onDone: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const enable = !a.direct_publish;
  const go = async () => {
    setBusy(true);
    try {
      await post(`/automations/${a.id}/direct-publish`, { enabled: enable });
      toast({ tone: enable ? 'warning' : 'success', title: enable ? 'Direktversand erlaubt' : 'Direktversand entzogen' });
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={580}
      title={enable ? 'Direktversand erlauben?' : 'Direktversand entziehen?'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant={enable ? 'danger' : 'primary'} loading={busy} disabled={enable && !a.tested} onClick={go}>
            {enable ? 'Erlauben (mit Passwort bestätigen)' : 'Entziehen'}
          </Button>
        </>
      }
    >
      {enable ? (
        <div className="flex flex-col gap-3 text-sm">
          <Notice tone="warning" title="Ohne Vier-Augen-Prinzip">
            Markierte Aktionen dieses Workflows veröffentlichen Banner und Beiträge auf der Website bzw. senden E-Mails an externe Empfänger, ohne dass ein Mensch freigibt.
          </Notice>
          <ul className="m-0 pl-5 flex flex-col gap-1 text-fg-muted">
            <li>Nur mit dem Recht „Workflows direkt veröffentlichen lassen“ und frischer Passwortbestätigung.</li>
            <li>Voraussetzung: ein erfolgreicher Testlauf des aktuellen Stands{a.tested ? ' (vorhanden)' : ' – noch nicht vorhanden'}.</li>
            <li>Wirksam erst mit einer neu aktivierten Version, die markierte Aktionen enthält.</li>
            <li>Jede Änderung wird auditiert und der Administration als Sicherheitsmeldung gemeldet.</li>
            <li>Entziehen oder Deaktivieren wirkt sofort – auch für bereits laufende Abläufe.</li>
          </ul>
        </div>
      ) : (
        <p className="m-0 text-sm">Markierte Aktionen legen ab sofort wieder nur Entwürfe an bzw. fordern eine Freigabe an.</p>
      )}
    </Dialog>
  );
}

export default function Editor() {
  const { id } = useParams();
  const cat = useCatalog();
  const inputs = useInputs();
  const outputs = useOutputs();
  const q = useQuery({ queryKey: ['automation', id], queryFn: () => get<AutomationDetail>(`/automations/${id}`), enabled: !!id });
  if (q.error || cat.error) return <ErrorBox title="Workflow konnte nicht geladen werden">{((q.error ?? cat.error) as Error).message}</ErrorBox>;
  if (!q.data || !cat.data || !inputs.data || !outputs.data) return <SkeletonRows rows={8} />;
  return (
    <ReactFlowProvider>
      <EditorInner key={q.data.id} a={q.data} cat={cat.data} inputs={inputs.data} outputs={outputs.data} />
    </ReactFlowProvider>
  );
}
