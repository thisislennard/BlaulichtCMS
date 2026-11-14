import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyNodeChanges,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection as FlowConnection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ApiError, del, download, get, patch, post, put } from '../../api/client';
import type { Catalog, Graph, GraphEdge, GraphNode, Issue, NodeTypeInfo } from '../../api/types';
import { useCatalog } from '../../components/forms/SchemaForm';
import { usePageMeta } from '../../components/layout/AppShell';
import { Button, cx, EmptyState, ErrorBox, Notice, Skeleton } from '../../components/ui/core';
import { CATEGORY_COLOR } from '../../components/ui/data';
import { Icon } from '../../components/ui/Icon';
import { DeleteDialog, Menu, Popover, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDuration } from '../../lib/format';
import { EditorCtx, edgeTypes, nodeTypes, type EdgeState, type FlowEdge, type FlowNode } from './canvasParts';
import { ConfigPanel, type Connection, type NodeTestResult, type WorkflowDetail } from './ConfigPanel';
import { PublishDialog, RealTestDialog, VersionsButton, WebhookSecretDialog, type WebhookInfo } from './dialogs';
import {
  autoLayout,
  createsCycle,
  dataLabel,
  defaultConfig,
  edgeId,
  isRunFinished,
  latestSteps,
  newId,
  portsOf,
  renameKeyRefs,
  T,
  typeOf,
  uniqueKey,
  type RunInfo,
} from './lib';
import { DND_TYPE, Palette } from './Palette';

function useMedia(query: string) {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

export default function Editor() {
  const { id = '' } = useParams();
  const wfQ = useQuery<WorkflowDetail>({
    queryKey: ['workflow', id],
    queryFn: () => get(`/workflows/${id}`),
    refetchOnWindowFocus: false,
    refetchInterval: (q) => (q.state.data?.listening ? 2000 : false),
  });
  const catQ = useCatalog();
  usePageMeta({ title: wfQ.data?.name ?? T('title'), crumb: 'Workflows', fullBleed: true, collapseSidebar: true });

  if (wfQ.error || catQ.error) {
    const e = (wfQ.error ?? catQ.error) as ApiError;
    return (
      <div className="p-8 max-w-[640px]">
        <ErrorBox
          title={e?.status === 404 ? T('load.notFound') : T('load.failed')}
          actions={
            <>
              <Button size="sm" icon="RefreshCw" onClick={() => (wfQ.refetch(), catQ.refetch())}>
                {T('load.retry')}
              </Button>
              <Link to="/workflows" className="inline-flex items-center h-ctl-sm px-3 text-sm">
                {T('load.back')}
              </Link>
            </>
          }
        >
          {e?.status === 404 ? T('load.notFoundText') : e?.message}
        </ErrorBox>
      </div>
    );
  }
  if (!wfQ.data || !catQ.data) return <EditorSkeleton />;
  return (
    <ReactFlowProvider>
      <EditorInner key={id} workflow={wfQ.data} catalog={catQ.data} refetch={wfQ.refetch} />
    </ReactFlowProvider>
  );
}

function EditorSkeleton() {
  return (
    <div className="h-[calc(100vh-64px)] flex flex-col" aria-busy="true" aria-label={T('common.loading')}>
      <div className="h-14 border-b border-line flex items-center gap-3 px-4">
        <Skeleton className="w-8 h-8" />
        <div className="flex flex-col gap-1.5 flex-1">
          <Skeleton className="w-24 h-3" />
          <Skeleton className="w-56 h-4" />
        </div>
        <Skeleton className="w-24 h-8" />
        <Skeleton className="w-24 h-8" />
        <Skeleton className="w-28 h-8" />
      </div>
      <div className="flex-1 flex min-h-0">
        <div className="w-palette border-r border-line bg-sidebar p-3 flex flex-col gap-3">
          <Skeleton className="h-8" />
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
        <div className="flex-1 ll-canvas-grid relative">
          <Skeleton className="absolute left-[120px] top-[200px] w-[200px] h-[100px] !rounded-node" />
          <Skeleton className="absolute left-[400px] top-[200px] w-[200px] h-[100px] !rounded-node" />
          <Skeleton className="absolute left-[680px] top-[120px] w-[200px] h-[100px] !rounded-node" />
        </div>
      </div>
    </div>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

function EditorInner({ workflow: wf, catalog, refetch }: { workflow: WorkflowDetail; catalog: Catalog; refetch: () => Promise<{ data?: WorkflowDetail }> }) {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const narrow = useMedia('(max-width: 1023px)');
  const wide = useMedia('(min-width: 1440px)');
  const canEdit = can('workflow.edit');
  const canPublish = can('workflow.publish');
  const readOnly = !canEdit || narrow;
  const connQ = useQuery<Connection[]>({ queryKey: ['connections'], queryFn: () => get('/connections'), enabled: canEdit || can('connection.read'), staleTime: 30_000 });
  const connectionsList = connQ.data ?? [];

  /* ------------------------------ Graph + History ------------------------------------ */
  const [graph, setGraphState] = useState<Graph>(() => ({ nodes: wf.draft?.nodes ?? [], edges: wf.draft?.edges ?? [], viewport: wf.draft?.viewport }));
  const graphRef = useRef(graph);
  const past = useRef<Graph[]>([]);
  const future = useRef<Graph[]>([]);
  const lastCoalesce = useRef({ key: '', t: 0 });
  const [, setHistTick] = useState(0);
  const setGraph = (g: Graph) => {
    graphRef.current = g;
    setGraphState(g);
  };

  /* ---------------------------------- Autosave --------------------------------------- */
  const revRef = useRef(wf.draft_revision);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);
  const viewportRef = useRef<Viewport | undefined>(wf.draft?.viewport);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const conflictRef = useRef(false);

  const [issues, setIssues] = useState<Issue[]>([]);
  const validateTimer = useRef<number | null>(null);
  const runValidate = useCallback(() => {
    if (validateTimer.current) window.clearTimeout(validateTimer.current);
    validateTimer.current = window.setTimeout(async () => {
      try {
        const r = await post(`/workflows/${wf.id}/validate`);
        setIssues(r.issues ?? []);
      } catch {
        /* Validierung ist nur ein Hinweis */
      }
    }, 250);
  }, [wf.id]);
  useEffect(() => {
    runValidate();
  }, [runValidate]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) await savingRef.current;
    if (conflictRef.current) return false;
    if (!dirtyRef.current) return true;
    dirtyRef.current = false;
    setSaveState('saving');
    const body = { revision: revRef.current, graph: { nodes: graphRef.current.nodes, edges: graphRef.current.edges, ...(viewportRef.current ? { viewport: viewportRef.current } : {}) } };
    const p = put(`/workflows/${wf.id}/draft`, body)
      .then((r: any) => {
        revRef.current = r.draft_revision;
        setSaveError(null);
        setSaveState(dirtyRef.current ? 'dirty' : 'saved');
        runValidate();
        return true;
      })
      .catch((e: ApiError) => {
        if (e.status === 409) {
          conflictRef.current = true;
          setConflict(e.message);
        } else {
          dirtyRef.current = true;
          setSaveError(e.message);
        }
        setSaveState('error');
        return false;
      });
    savingRef.current = p;
    const ok = await p;
    savingRef.current = null;
    if (ok && dirtyRef.current) scheduleSave();
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf.id, runValidate]);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    dirtyRef.current = true;
    setSaveState((s) => (s === 'saving' ? s : 'dirty'));
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void saveNow(), 800);
  }, [readOnly, saveNow]);

  const flush = useCallback(async () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (readOnly) return true;
    return saveNow();
  }, [readOnly, saveNow]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (dirtyRef.current && !conflictRef.current) void saveNow();
    };
  }, [saveNow]);

  const commit = useCallback(
    (updater: (g: Graph) => Graph, coalesce?: string) => {
      if (readOnly) return;
      const prev = graphRef.current;
      const next = updater(prev);
      if (next === prev) return;
      const now = Date.now();
      const merge = !!coalesce && lastCoalesce.current.key === coalesce && now - lastCoalesce.current.t < 1200;
      if (!merge) {
        past.current.push(prev);
        if (past.current.length > 100) past.current.shift();
      }
      lastCoalesce.current = { key: coalesce ?? '', t: now };
      future.current = [];
      setGraph(next);
      setHistTick((x) => x + 1);
      scheduleSave();
    },
    [readOnly, scheduleSave],
  );

  const undo = useCallback(() => {
    if (readOnly || !past.current.length) return;
    future.current.push(graphRef.current);
    setGraph(past.current.pop()!);
    lastCoalesce.current = { key: '', t: 0 };
    setHistTick((x) => x + 1);
    scheduleSave();
  }, [readOnly, scheduleSave]);
  const redo = useCallback(() => {
    if (readOnly || !future.current.length) return;
    past.current.push(graphRef.current);
    setGraph(future.current.pop()!);
    lastCoalesce.current = { key: '', t: 0 };
    setHistTick((x) => x + 1);
    scheduleSave();
  }, [readOnly, scheduleSave]);

  const reloadFromServer = useCallback(async () => {
    const r = await refetch();
    if (!r.data) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    revRef.current = r.data.draft_revision;
    dirtyRef.current = false;
    conflictRef.current = false;
    past.current = [];
    future.current = [];
    setConflict(null);
    setSaveState('saved');
    setGraph({ nodes: r.data.draft?.nodes ?? [], edges: r.data.draft?.edges ?? [], viewport: r.data.draft?.viewport });
    setHistTick((x) => x + 1);
    runValidate();
  }, [refetch, runValidate]);

  /* ------------------------------ React-Flow-Zustand ---------------------------------- */
  const [rfNodes, setRfNodes] = useState<FlowNode[]>([]);
  const pendingSelect = useRef<Set<string> | null>(null);
  useEffect(() => {
    const sel = pendingSelect.current;
    pendingSelect.current = null;
    setRfNodes((prev) => {
      const pm = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((n) => {
        const p = pm.get(n.id);
        const selected = sel ? sel.has(n.id) : (p?.selected ?? false);
        if (p && p.data.node === n && p.selected === selected) return p;
        const info = typeOf(catalog, n.type);
        return { ...(p ?? {}), id: n.id, type: 'll' as const, position: n.position, data: { node: n }, selected, ariaLabel: `${info?.title ?? n.type}: ${n.name}`, deletable: false };
      });
    });
  }, [graph, catalog]);

  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const selectedNodes = rfNodes.filter((n) => n.selected);
  const panelNodeId = selectedNodes.length === 1 ? selectedNodes[0].id : null;
  const panelNode = panelNodeId ? graph.nodes.find((n) => n.id === panelNodeId) : undefined;
  const panelInfo = panelNode ? typeOf(catalog, panelNode.type) : undefined;

  const selectOnly = useCallback((ids: string[]) => {
    const s = new Set(ids);
    setRfNodes((nds) => nds.map((n) => (n.selected === s.has(n.id) ? n : { ...n, selected: s.has(n.id) })));
    setSelectedEdges(new Set());
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const allowed = changes.filter((c) => c.type !== 'remove' && (!readOnly || c.type === 'select' || c.type === 'dimensions'));
      if (allowed.length) setRfNodes((nds) => applyNodeChanges(allowed, nds));
    },
    [readOnly],
  );
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    const sel = changes.filter((c) => c.type === 'select');
    if (!sel.length) return;
    setSelectedEdges((cur) => {
      const next = new Set(cur);
      for (const c of sel) if (c.type === 'select') c.selected ? next.add(c.id) : next.delete(c.id);
      return next;
    });
  }, []);

  /* ------------------------------------ Testlauf -------------------------------------- */
  const [runId, setRunId] = useState<number | null>(null);
  const runQ = useQuery<RunInfo>({
    queryKey: ['run', runId],
    queryFn: () => get(`/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && isRunFinished(q.state.data.status) && q.state.data.status !== 'waiting' ? false : 1000),
  });
  const run = runId ? runQ.data : undefined;
  const runFinished = !!run && isRunFinished(run.status);
  const steps = useMemo(() => (run ? latestSteps(run) : null), [run]);
  const lastQ = useQuery<{ runId: number | null; outputs: Record<string, any> }>({ queryKey: ['last-outputs', wf.id], queryFn: () => get(`/workflows/${wf.id}/last-outputs`), staleTime: 30_000 });
  useEffect(() => {
    if (runFinished) qc.invalidateQueries({ queryKey: ['last-outputs', wf.id] });
  }, [runFinished, qc, wf.id]);
  const stepOutputs = useMemo(() => {
    const o: Record<string, any> = {};
    steps?.forEach((s, k) => {
      if (s.output_preview != null) o[k] = s.output_preview;
    });
    return o;
  }, [steps]);

  const [testing, setTesting] = useState(false);
  const [realOpen, setRealOpen] = useState(false);
  const [testMenu, setTestMenu] = useState(false);
  const testMenuBtn = useRef<HTMLButtonElement>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  const issuesMap = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i]);
    return m;
  }, [issues]);

  const runTest = async (simulate: boolean) => {
    setTesting(true);
    try {
      if (!(await flush())) {
        toast({ tone: 'warning', title: T('test.notSaved') });
        return;
      }
      const r = await post(`/workflows/${wf.id}/test`, { simulate });
      setRunId(r.runId);
      toast({ tone: 'info', title: simulate ? T('test.startedSim', { id: r.runId }) : T('test.startedReal', { id: r.runId }) });
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'invalid_graph') {
        if (Array.isArray(err.details)) setIssues(err.details);
        toast({ tone: 'error', title: T('test.invalid'), text: err.message, action: { label: T('test.showProblems'), onClick: () => setPublishOpen(true) } });
      } else errorToast(e, T('test.failed'));
    } finally {
      setTesting(false);
    }
  };

  /* ---------------------------------- Node-Test ----------------------------------------- */
  const [nodeTest, setNodeTest] = useState<NodeTestResult | null>(null);
  const [nodeTesting, setNodeTesting] = useState(false);
  const testNode = async (nodeId: string) => {
    const g = graphRef.current;
    const lo = lastQ.data?.outputs ?? {};
    const data: Record<string, unknown> = {};
    for (const n of g.nodes) {
      const info = typeOf(catalog, n.type);
      let v = stepOutputs[n.id] ?? lo[n.id];
      if (v == null && info?.category === 'trigger') {
        if (wf.sample_event) v = wf.sample_event.data;
        else if (n.type === 'trigger.manual') {
          try {
            v = { data: JSON.parse(n.config?.sample ?? '{}') };
          } catch {
            v = { data: {} };
          }
        }
      }
      v ??= info?.sampleOutput;
      if (v != null) {
        data[n.key] = v;
        if (info?.category === 'trigger') data.trigger = v;
      }
    }
    setNodeTesting(true);
    try {
      const r = await post(`/workflows/${wf.id}/nodes/${nodeId}/test`, { data, simulate: true, graph: { nodes: g.nodes, edges: g.edges } });
      setNodeTest({ nodeId, ...r });
    } catch (e) {
      errorToast(e, T('test.nodeFailed'));
    } finally {
      setNodeTesting(false);
    }
  };

  /* ------------------------------- Bearbeitungsaktionen --------------------------------- */
  const hasTrigger = graph.nodes.some((n) => typeOf(catalog, n.type)?.category === 'trigger');
  const canvasRef = useRef<HTMLDivElement>(null);

  const addNode = useCallback(
    (info: NodeTypeInfo, at?: { x: number; y: number }) => {
      if (readOnly) return;
      const g = graphRef.current;
      if (info.category === 'trigger' && g.nodes.some((n) => typeOf(catalog, n.type)?.category === 'trigger')) {
        toast({ tone: 'warning', title: T('palette.oneTrigger') });
        return;
      }
      const sel = rfNodes.filter((n) => n.selected);
      const from = sel.length === 1 && !at && info.category !== 'trigger' ? g.nodes.find((n) => n.id === sel[0].id) : undefined;
      let position = at;
      if (!position && from) position = { x: from.position.x + 280, y: from.position.y };
      if (!position) {
        const r = canvasRef.current?.getBoundingClientRect();
        const c = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
        position = { x: c.x - 100, y: c.y - 50 };
      }
      while (g.nodes.some((n) => Math.abs(n.position.x - position!.x) < 40 && Math.abs(n.position.y - position!.y) < 40)) position = { x: position.x, y: position.y + 140 };
      const node: GraphNode = { id: newId(), type: info.type, key: uniqueKey(info.title, new Set(g.nodes.map((n) => n.key))), name: info.title, position: { x: Math.round(position.x), y: Math.round(position.y) }, config: defaultConfig(info) };
      const edges = [...g.edges];
      if (from) {
        const port = portsOf(typeOf(catalog, from.type), from)[0];
        if (port) edges.push({ id: edgeId(from.id, port.id, node.id), source: from.id, sourcePort: port.id, target: node.id, targetPort: 'in' });
      }
      pendingSelect.current = new Set([node.id]);
      commit((cur) => ({ ...cur, nodes: [...cur.nodes, node], edges }));
      if (!at) {
        const r = canvasRef.current?.getBoundingClientRect();
        const sp = rf.flowToScreenPosition({ x: node.position.x + 100, y: node.position.y + 50 });
        if (r && (sp.x < r.left + 60 || sp.x > r.right - 60 || sp.y < r.top + 60 || sp.y > r.bottom - 60)) {
          window.setTimeout(() => rf.setCenter(node.position.x + 100, node.position.y + 50, { zoom: rf.getZoom(), duration: 250 }), 30);
        }
      }
    },
    [readOnly, catalog, rfNodes, rf, commit, toast],
  );

  const deleteSelection = useCallback(() => {
    if (readOnly) return;
    const ids = new Set(rfNodes.filter((n) => n.selected).map((n) => n.id));
    const eids = selectedEdges;
    if (!ids.size && !eids.size) return;
    commit((g) => ({ ...g, nodes: g.nodes.filter((n) => !ids.has(n.id)), edges: g.edges.filter((e) => !eids.has(e.id) && !ids.has(e.source) && !ids.has(e.target)) }));
    setSelectedEdges(new Set());
    toast({
      tone: 'info',
      title: ids.size ? T(ids.size === 1 ? 'canvas.deletedOne' : 'canvas.deletedMany', { n: ids.size }) : T(eids.size === 1 ? 'canvas.deletedEdge' : 'canvas.deletedEdges', { n: eids.size }),
      action: { label: T('common.undo'), onClick: () => undo() },
    });
  }, [readOnly, rfNodes, selectedEdges, commit, toast, undo]);

  const deleteNode = (id: string) => {
    commit((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.source !== id && e.target !== id) }));
    toast({ tone: 'info', title: T('canvas.deletedOne'), action: { label: T('common.undo'), onClick: () => undo() } });
  };

  const deleteEdge = useCallback(
    (id: string) => {
      commit((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }));
      setSelectedEdges(new Set());
    },
    [commit],
  );

  const clipboard = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const copy = () => {
    const ids = new Set(rfNodes.filter((n) => n.selected).map((n) => n.id));
    if (!ids.size) return;
    const g = graphRef.current;
    clipboard.current = structuredClone({ nodes: g.nodes.filter((n) => ids.has(n.id)), edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) });
    toast({ tone: 'info', title: T(ids.size === 1 ? 'canvas.copiedOne' : 'canvas.copiedMany', { n: ids.size }) });
  };
  const paste = () => {
    const clip = clipboard.current;
    if (!clip || readOnly) return;
    const g = graphRef.current;
    const keys = new Set(g.nodes.map((n) => n.key));
    let trig = g.nodes.some((n) => typeOf(catalog, n.type)?.category === 'trigger');
    const map = new Map<string, string>();
    const nodes: GraphNode[] = [];
    let skipped = 0;
    for (const n of clip.nodes) {
      if (typeOf(catalog, n.type)?.category === 'trigger') {
        if (trig) {
          skipped++;
          continue;
        }
        trig = true;
      }
      const id = newId();
      map.set(n.id, id);
      const key = uniqueKey(n.key, keys);
      keys.add(key);
      nodes.push({ ...structuredClone(n), id, key, position: { x: n.position.x + 40, y: n.position.y + 40 } });
    }
    const edges = clip.edges.filter((e) => map.has(e.source) && map.has(e.target)).map((e) => ({ ...e, id: edgeId(map.get(e.source)!, e.sourcePort, map.get(e.target)!), source: map.get(e.source)!, target: map.get(e.target)! }));
    if (!nodes.length) {
      if (skipped) toast({ tone: 'warning', title: T('palette.oneTrigger') });
      return;
    }
    clipboard.current = { nodes: clip.nodes.map((n) => ({ ...n, position: { x: n.position.x + 40, y: n.position.y + 40 } })), edges: clip.edges };
    pendingSelect.current = new Set(nodes.map((n) => n.id));
    commit((cur) => ({ ...cur, nodes: [...cur.nodes, ...nodes], edges: [...cur.edges, ...edges] }));
    if (skipped) toast({ tone: 'warning', title: T('canvas.pasteSkippedTrigger') });
  };

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (readOnly || !c.source || !c.target) return;
      const g = graphRef.current;
      const port = c.sourceHandle ?? 'out';
      const target = g.nodes.find((n) => n.id === c.target);
      let problem: string | null = null;
      if (c.source === c.target) problem = T('canvas.noSelf');
      else if (target && typeOf(catalog, target.type)?.category === 'trigger') problem = T('canvas.noIntoTrigger');
      else if (g.edges.some((e) => e.source === c.source && e.sourcePort === port && e.target === c.target)) problem = T('canvas.duplicate');
      else if (createsCycle(g, c.source, c.target)) problem = T('canvas.noCycle');
      if (problem) {
        toast({ tone: 'warning', title: problem });
        return;
      }
      commit((cur) => ({ ...cur, edges: [...cur.edges, { id: edgeId(c.source, port, c.target), source: c.source, sourcePort: port, target: c.target, targetPort: 'in' }] }));
    },
    [readOnly, catalog, commit, toast],
  );

  const updateNode = useCallback(
    (nodeId: string, p: Partial<GraphNode>, coalesce?: string) => {
      commit((g) => {
        const nodes = g.nodes.map((n) => (n.id === nodeId ? { ...n, ...p } : n));
        let edges = g.edges;
        // Ausgänge, die es nicht mehr gibt (Fehler-Ausgang aus, Switch-Fall gelöscht), werden abgehängt
        const node = nodes.find((n) => n.id === nodeId)!;
        const ports = new Set(portsOf(typeOf(catalog, node.type), node).map((x) => x.id));
        if (edges.some((e) => e.source === nodeId && !ports.has(e.sourcePort))) edges = edges.filter((e) => e.source !== nodeId || ports.has(e.sourcePort));
        return { ...g, nodes, edges };
      }, coalesce);
    },
    [commit, catalog],
  );

  const renameKey = (nodeId: string, key: string) => {
    commit((g) => {
      const old = g.nodes.find((n) => n.id === nodeId)?.key;
      const renamed = { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, key } : n)) };
      return old ? renameKeyRefs(renamed, old, key) : renamed;
    });
    toast({ tone: 'success', title: T('panel.keyRenamed', { key }), text: T('panel.keyRenamedText') });
  };

  const arrange = () => {
    commit((g) => autoLayout(g));
    window.setTimeout(() => rf.fitView({ padding: 0.2, duration: 250 }), 50);
  };

  /* ------------------------------------ Tastatur ---------------------------------------- */
  const searchRef = useRef<HTMLInputElement>(null);
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const tgt = e.target as HTMLElement;
    const typing = !!tgt.closest?.('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (typing) return;
      if (selectedNodes.length || selectedEdges.size) {
        selectOnly([]);
        e.preventDefault();
      }
      return;
    }
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    const inSide = !!tgt.closest?.('aside, [role="dialog"], [role="menu"]');
    if (e.key === '/' && !mod) {
      if (readOnly) return;
      e.preventDefault();
      if (searchRef.current) searchRef.current.focus();
      else {
        selectOnly([]);
        window.setTimeout(() => searchRef.current?.focus(), 30);
      }
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (inSide) return;
    if (mod && e.key.toLowerCase() === 'c') {
      copy();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      paste();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  /* ---------------------------------- Kanten-Darstellung -------------------------------- */
  const rfEdges = useMemo<FlowEdge[]>(() => {
    return graph.edges.map((e) => {
      let state: EdgeState = 'idle';
      let label: string | undefined;
      if (steps) {
        const s = steps.get(e.source);
        const t = steps.get(e.target);
        const okSrc = s && (s.status === 'success' || s.status === 'simulated') && (s.output_port ?? 'out') === e.sourcePort;
        const errSrc = s && s.status === 'error' && e.sourcePort === 'error';
        if ((okSrc || errSrc) && t) {
          state = errSrc ? 'error' : t.status === 'waiting' || t.status === 'running' ? 'waiting' : t.status === 'error' ? 'error' : 'active';
          label = dataLabel(s!.output_preview);
        } else if (runFinished) state = 'skipped';
      }
      return { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourcePort, targetHandle: 'in', type: 'll' as const, selected: selectedEdges.has(e.id), data: { state, label }, deletable: false };
    });
  }, [graph.edges, steps, runFinished, selectedEdges]);

  /* --------------------------------- Fokus aus Problemen -------------------------------- */
  const [focusId, setFocusId] = useState<string | null>(null);
  const jumpTo = (nodeId: string) => {
    setPublishOpen(false);
    selectOnly([nodeId]);
    setFocusId(nodeId);
    window.setTimeout(() => rf.fitView({ nodes: [{ id: nodeId }], maxZoom: 1.1, duration: 300, padding: 0.6 }), 60);
    window.setTimeout(() => setFocusId((f) => (f === nodeId ? null : f)), 2500);
  };

  /* ------------------------------------ Workflow-Aktionen ------------------------------- */
  const [name, setName] = useState(wf.name);
  useEffect(() => setName(wf.name), [wf.name]);
  const saveName = async () => {
    const v = name.trim();
    if (!v || v === wf.name) return setName(wf.name);
    try {
      await patch(`/workflows/${wf.id}`, { name: v });
      await refetch();
      qc.invalidateQueries({ queryKey: ['workflows'] });
    } catch (e) {
      setName(wf.name);
      errorToast(e, T('toolbar.renameFailed'));
    }
  };

  const [secretInfo, setSecretInfo] = useState<WebhookInfo | null>(null);
  const showSecret = (w?: WebhookInfo | null) => {
    if (w?.secret) setSecretInfo(w);
  };

  const active = wf.status === 'active';
  const [statusBusy, setStatusBusy] = useState(false);
  const setStatus = async (next: 'active' | 'inactive', withUndo = true) => {
    setStatusBusy(true);
    try {
      const r = await post(`/workflows/${wf.id}/status`, { status: next });
      await refetch();
      qc.invalidateQueries({ queryKey: ['workflows'] });
      showSecret(r?.webhook);
      if (withUndo)
        toast({
          tone: 'success',
          title: next === 'active' ? T('toolbar.activated') : T('toolbar.deactivated'),
          action: { label: T('common.undo'), onClick: () => void setStatus(next === 'active' ? 'inactive' : 'active', false) },
        });
    } catch (e) {
      errorToast(e);
    } finally {
      setStatusBusy(false);
    }
  };

  const [deleteOpen, setDeleteOpen] = useState(false);
  const duplicate = async () => {
    try {
      await flush();
      const r = await post(`/workflows/${wf.id}/duplicate`);
      qc.invalidateQueries({ queryKey: ['workflows'] });
      toast({ tone: 'success', title: T('toolbar.duplicated', { name: r.name }) });
      navigate(`/workflows/${r.id}`);
    } catch (e) {
      errorToast(e);
    }
  };

  const latestVersion = wf.versions[0]?.number;
  const activeVersion = wf.versions.find((v) => v.active)?.number;
  const needsApproval = wf.fourEyes || !canPublish;
  const saveLabel =
    saveState === 'saving'
      ? T('save.saving')
      : saveState === 'dirty'
        ? T('save.dirty')
        : saveState === 'error' && !conflict
          ? T('save.error')
          : latestVersion
            ? T('save.savedV', { n: latestVersion })
            : T('save.savedDraft');

  /* ---------------------------------------- Render -------------------------------------- */
  const panelOpen = !!panelNode && !!panelInfo;
  const showPalette = !readOnly && (!panelOpen || wide);
  const ctxValue = useMemo(() => ({ catalog, steps, runFinished, issues: issuesMap, readOnly, focusId, deleteEdge }), [catalog, steps, runFinished, issuesMap, readOnly, focusId, deleteEdge]);

  const counts = useMemo(() => {
    const c = { ok: 0, err: 0, wait: 0, sim: 0 };
    steps?.forEach((s) => {
      if (s.status === 'success') c.ok++;
      if (s.status === 'simulated') (c.ok++, c.sim++);
      if (s.status === 'error') c.err++;
      if (s.status === 'waiting' || s.status === 'running') c.wait++;
    });
    return c;
  }, [steps]);

  return (
    <EditorCtx.Provider value={ctxValue}>
      <div className="h-[calc(100vh-64px)] min-h-[480px] flex flex-col min-w-0">
        {/* Toolbar */}
        <div role="toolbar" aria-label={T('toolbar.aria')} className="flex items-center gap-2.5 flex-wrap min-h-14 px-4 py-2 box-border border-b border-line bg-bg">
          <Link to="/workflows" aria-label={T('toolbar.back')} title={T('toolbar.back')} className="w-8 h-8 inline-flex items-center justify-center rounded-control !text-fg-muted hover:bg-raised hover:!text-fg">
            <Icon name="ArrowLeft" size={16} />
          </Link>
          <div className="flex flex-col flex-[1_1_240px] min-w-0">
            <span className="text-meta text-fg-muted truncate">
              {T('toolbar.path')}
              {(wf as any).folder ? ` / ${(wf as any).folder}` : ''}
            </span>
            <div className="flex items-center gap-2.5 min-w-0">
              <label htmlFor="ll-wfname" className="sr-only">
                {T('toolbar.name')}
              </label>
              <input
                id="ll-wfname"
                value={name}
                readOnly={!canEdit}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setName(wf.name);
                }}
                size={Math.max(8, Math.min(40, name.length + 1))}
                className="bg-transparent border-0 outline-none p-0 text-section font-semibold text-fg min-w-0 max-w-full rounded-[4px] focus-visible:shadow-ring"
              />
              <span className={cx('text-meta whitespace-nowrap inline-flex items-center gap-1.5', saveState === 'error' ? 'text-err' : 'text-fg-muted')} role="status" aria-live="polite">
                {saveState === 'saving' && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-warn ll-pulse" />}
                {saveLabel}
                {saveState === 'error' && !conflict && (
                  <button type="button" className="text-fg-link underline" onClick={() => void flush()} title={saveError ?? undefined}>
                    {T('save.retry')}
                  </button>
                )}
              </span>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={active}
            disabled={!canPublish || !wf.active_version_id || statusBusy}
            title={!canPublish ? T('toolbar.activeNoRight') : !wf.active_version_id ? T('toolbar.activeNoVersion') : activeVersion ? T('toolbar.activeVersion', { n: activeVersion }) : undefined}
            onClick={() => setStatus(active ? 'inactive' : 'active')}
            className="inline-flex items-center gap-2 h-ctl-sm pl-1.5 pr-2.5 rounded-control border border-line text-sm font-medium hover:bg-raised disabled:opacity-55 disabled:hover:bg-transparent"
          >
            <span aria-hidden="true" className={cx('relative inline-block shrink-0 w-[30px] h-[18px] rounded-full transition-colors duration-fast', 'border', active ? 'bg-primary-solid border-primary-solid' : 'bg-raised border-line')}>
              <span className={cx('absolute left-0 top-[1px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform duration-fast', active ? 'translate-x-[13px]' : 'translate-x-[1px]')} />
            </span>
            {active ? T('toolbar.active') : T('toolbar.inactive')}
          </button>

          <VersionsButton
            workflow={wf}
            canApprove={can('workflow.approve')}
            canPublish={canPublish}
            myName={me?.user.name ?? ''}
            onChanged={async (res) => {
              if (res?.rolledBack) await reloadFromServer();
              else await refetch();
              qc.invalidateQueries({ queryKey: ['workflows'] });
              showSecret(res?.webhook);
            }}
          />

          {canEdit && (
            <div className="inline-flex" role="group" aria-label={T('toolbar.test')}>
              <Button size="sm" icon="FlaskConical" loading={testing} disabled={narrow} onClick={() => runTest(true)} className="rounded-r-none" title={T('test.simHint')}>
                {T('toolbar.test')}
              </Button>
              <Button ref={testMenuBtn} size="sm" iconOnly icon="ChevronDown" aria-label={T('test.options')} aria-haspopup="menu" aria-expanded={testMenu} disabled={narrow} onClick={() => setTestMenu((o) => !o)} className="rounded-l-none border-l-0" />
              <Popover open={testMenu} onClose={() => setTestMenu(false)} anchor={testMenuBtn} width={300}>
                <div role="menu" className="p-1.5 flex flex-col">
                  <button
                    role="menuitem"
                    type="button"
                    className="flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-chip text-left hover:bg-raised"
                    onClick={() => {
                      setTestMenu(false);
                      void runTest(true);
                    }}
                  >
                    <span className="text-sm font-medium">{T('test.simulate')}</span>
                    <span className="text-meta text-fg-muted">{T('test.simulateHelp')}</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={!canPublish}
                    title={!canPublish ? T('test.realNoRight') : undefined}
                    className="flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-chip text-left hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent"
                    onClick={() => {
                      setTestMenu(false);
                      setRealOpen(true);
                    }}
                  >
                    <span className="text-sm font-medium text-warn">{T('test.real')}</span>
                    <span className="text-meta text-fg-muted">{canPublish ? T('test.realHelp') : T('test.realNoRight')}</span>
                  </button>
                </div>
              </Popover>
            </div>
          )}

          {canEdit && (
            <Button size="sm" variant="primary" icon={needsApproval ? 'Send' : 'Upload'} onClick={() => setPublishOpen(true)} disabled={narrow}>
              {needsApproval ? T('toolbar.requestApproval') : T('toolbar.publish')}
            </Button>
          )}
          <Menu
            size="sm"
            label={T('toolbar.more')}
            items={[
              canEdit && { label: T('toolbar.duplicate'), icon: 'Copy', onClick: duplicate },
              { label: T('toolbar.export'), icon: 'Download', onClick: async () => (await flush(), download(`/workflows/${wf.id}/export`)) },
              canPublish && { label: T('toolbar.delete'), icon: 'Trash2', danger: true, onClick: () => setDeleteOpen(true) },
            ]}
          />
        </div>

        {conflict && (
          <div className="px-4 py-2 border-b border-line bg-warn-soft flex items-center gap-3 flex-wrap text-sm" role="alert">
            <Icon name="AlertTriangle" size={16} className="text-warn" />
            <span className="flex-1 min-w-0">
              <strong className="font-semibold">{conflictName(conflict) ? T('save.conflictBy', { name: conflictName(conflict)! }) : T('save.conflict')}</strong>
              <span className="text-fg-muted"> · {T('save.conflictText')}</span>
            </span>
            <Button size="sm" icon="RefreshCw" onClick={() => void reloadFromServer()}>
              {T('save.reload')}
            </Button>
          </div>
        )}
        {narrow && (
          <div className="px-4 py-2 border-b border-line">
            <Notice tone="primary" icon="MonitorCog" title={T('readonly.narrowTitle')}>
              {T('readonly.narrowText')}
            </Notice>
          </div>
        )}
        {!canEdit && !narrow && (
          <div className="px-4 py-2 border-b border-line bg-primary-soft text-sm flex items-center gap-2">
            <Icon name="Eye" size={15} className="text-fg-link" />
            {T('readonly.noRight')}
          </div>
        )}

        <div className="flex-1 min-h-0 flex min-w-0 relative">
          {showPalette && <Palette ref={searchRef} catalog={catalog} hasTrigger={hasTrigger} onAdd={(info) => addNode(info)} />}

          <div
            ref={canvasRef}
            className="flex-1 min-w-0 relative ll-canvas-grid"
            onDragOver={(e) => {
              if (readOnly) return;
              if (e.dataTransfer.types.includes(DND_TYPE)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(e) => {
              const type = e.dataTransfer.getData(DND_TYPE);
              const info = typeOf(catalog, type);
              if (!info || readOnly) return;
              e.preventDefault();
              const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
              addNode(info, { x: Math.round((p.x - 100) / 20) * 20, y: Math.round((p.y - 50) / 20) * 20 });
            }}
          >
            <ReactFlow<FlowNode, FlowEdge>
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={(c) => c.source !== c.target && !createsCycle(graphRef.current, c.source, c.target)}
              onNodeDragStop={(_, __, nodes) => {
                const pos = new Map(nodes.map((n) => [n.id, n.position]));
                commit((g) => ({ ...g, nodes: g.nodes.map((n) => (pos.has(n.id) ? { ...n, position: { x: Math.round(pos.get(n.id)!.x), y: Math.round(pos.get(n.id)!.y) } } : n)) }));
              }}
              onMoveEnd={(_, vp) => {
                viewportRef.current = vp;
              }}
              onPaneClick={() => setSelectedEdges(new Set())}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              elementsSelectable
              deleteKeyCode={null}
              selectionKeyCode="Shift"
              multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
              snapToGrid
              snapGrid={[20, 20]}
              minZoom={0.25}
              maxZoom={2}
              defaultViewport={graph.viewport ?? { x: 40, y: 80, zoom: 1 }}
              fitView={graph.nodes.length > 0}
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ type: 'll' }}
              connectionRadius={24}
            >
              <MiniMap
                position="bottom-right"
                ariaLabel={T('canvas.minimap')}
                pannable
                zoomable
                className="!m-4 rounded-node border border-line overflow-hidden"
                style={{ width: 188, height: 112 }}
                nodeColor={(n) => CATEGORY_COLOR[typeOf(catalog, (n as FlowNode).data.node.type)?.category ?? 'control']}
                nodeBorderRadius={6}
              />
            </ReactFlow>

            {graph.nodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="pointer-events-auto bg-card border border-line rounded-card shadow-float">
                  <EmptyState icon="Zap" title={T('canvas.emptyTitle')} text={readOnly ? T('canvas.emptyReadOnly') : T('canvas.emptyText')} />
                </div>
              </div>
            )}

            {run && (
              <div role="status" className="absolute left-4 top-4 z-10 flex items-center gap-2.5 flex-wrap max-w-[calc(100%-32px)] px-3 py-2 rounded-node border border-line bg-card text-sm shadow-float">
                <span aria-hidden="true" className={cx('w-2 h-2 rounded-full', !runFinished || run.status === 'waiting' ? 'bg-warn ll-pulse' : run.status === 'success' ? 'bg-ok' : run.status === 'error' || run.status === 'dead' ? 'bg-err' : 'bg-fg-muted')} />
                <span className="font-semibold">{T('run.title', { id: run.id })}</span>
                <span className="font-mono text-meta text-fg-muted">{run.duration_ms != null ? fmtDuration(run.duration_ms) : T('run.running')}</span>
                {run.simulate && <span className="text-meta text-cyan font-medium">{T('run.simulated')}</span>}
                <span className="text-ok">{T('run.ok', { n: counts.ok })}</span>
                <span className="text-err">{T('run.err', { n: counts.err })}</span>
                <span className="text-warn">{T('run.wait', { n: counts.wait })}</span>
                {can('run.read') && <Link to={`/ausfuehrungen/${run.id}`}>{T('run.data')}</Link>}
                <button
                  type="button"
                  aria-label={T('run.close')}
                  title={T('run.close')}
                  onClick={() => setRunId(null)}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-chip text-fg-muted hover:bg-raised hover:text-fg"
                >
                  <Icon name="X" size={13} />
                </button>
              </div>
            )}
            {runId && !run && runQ.isLoading && (
              <div role="status" className="absolute left-4 top-4 z-10 flex items-center gap-2 px-3 py-2 rounded-node border border-line bg-card text-sm">
                <span aria-hidden="true" className="w-2 h-2 rounded-full bg-warn ll-pulse" />
                {T('run.title', { id: runId })} · {T('run.running')}
              </div>
            )}

            <ViewControls readOnly={readOnly} canUndo={past.current.length > 0} canRedo={future.current.length > 0} onUndo={undo} onRedo={redo} onArrange={arrange} />
          </div>

          {panelOpen && (
            <ConfigPanel
              key={panelNode!.id}
              node={panelNode!}
              info={panelInfo!}
              catalog={catalog}
              graph={graph}
              workflow={wf}
              connections={connectionsList}
              readOnly={readOnly}
              narrow={narrow}
              issues={issuesMap.get(panelNode!.id) ?? []}
              step={steps?.get(panelNode!.id)}
              runId={run?.id ?? null}
              stepOutputs={stepOutputs}
              lastOutputs={lastQ.data ?? { runId: null, outputs: {} }}
              testResult={nodeTest}
              testing={nodeTesting}
              onChange={(p, c) => updateNode(panelNode!.id, p, c)}
              onRenameKey={(k) => renameKey(panelNode!.id, k)}
              onDelete={() => deleteNode(panelNode!.id)}
              onClose={() => selectOnly([])}
              onTest={() => testNode(panelNode!.id)}
              flush={flush}
              refetchWorkflow={() => void refetch()}
            />
          )}
        </div>
      </div>

      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        workflow={wf}
        canPublish={canPublish}
        nodeName={(nid) => graph.nodes.find((n) => n.id === nid)?.name ?? null}
        flush={flush}
        onJump={jumpTo}
        onDone={async (r) => {
          toast({ tone: 'success', title: r.needsApproval ? T('publish.requested', { n: r.version.number }) : T('publish.done', { n: r.version.number }) });
          await refetch();
          qc.invalidateQueries({ queryKey: ['workflows'] });
          showSecret(r.webhook);
        }}
      />
      <RealTestDialog open={realOpen} onClose={() => setRealOpen(false)} onConfirm={() => void runTest(false)} />
      <WebhookSecretDialog info={secretInfo} onClose={() => setSecretInfo(null)} />
      <DeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        objectType="Workflow"
        name={wf.name}
        onConfirm={async (typed) => {
          await del(`/workflows/${wf.id}`, { confirm: typed });
          dirtyRef.current = false;
          qc.invalidateQueries({ queryKey: ['workflows'] });
          toast({ tone: 'success', title: T('toolbar.deleted', { name: wf.name }) });
          navigate('/workflows');
        }}
      />
    </EditorCtx.Provider>
  );

}

function conflictName(msg: string): string | null {
  return /von (.+?) geändert/.exec(msg)?.[1] ?? null;
}

function ViewControls({ readOnly, canUndo, canRedo, onUndo, onRedo, onArrange }: { readOnly: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onArrange: () => void }) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const btn = 'w-8 h-8 inline-flex items-center justify-center rounded-[7px] text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div role="group" aria-label={T('canvas.view')} className="absolute left-4 bottom-4 z-10 flex items-center gap-0.5 p-1 rounded-node border border-line bg-card flex-wrap">
      {!readOnly && (
        <>
          <button type="button" className={btn} aria-label={T('canvas.undo')} title={T('canvas.undo')} disabled={!canUndo} onClick={onUndo}>
            <Icon name="Undo2" size={15} />
          </button>
          <button type="button" className={btn} aria-label={T('canvas.redo')} title={T('canvas.redo')} disabled={!canRedo} onClick={onRedo}>
            <Icon name="Redo2" size={15} />
          </button>
          <span aria-hidden="true" className="w-px h-5 bg-line mx-1" />
        </>
      )}
      <button type="button" className={btn} aria-label={T('canvas.zoomOut')} title={T('canvas.zoomOut')} onClick={() => rf.zoomOut({ duration: 150 })}>
        <Icon name="Minus" size={15} />
      </button>
      <button type="button" className="min-w-[52px] h-8 px-1 rounded-[7px] font-mono text-meta text-fg tabular hover:bg-raised" title={T('canvas.zoomReset')} aria-label={T('canvas.zoomResetAria', { n: Math.round(zoom * 100) })} onClick={() => rf.zoomTo(1, { duration: 150 })}>
        {Math.round(zoom * 100)} %
      </button>
      <button type="button" className={btn} aria-label={T('canvas.zoomIn')} title={T('canvas.zoomIn')} onClick={() => rf.zoomIn({ duration: 150 })}>
        <Icon name="Plus" size={15} />
      </button>
      <span aria-hidden="true" className="w-px h-5 bg-line mx-1" />
      <button type="button" className={btn} aria-label={T('canvas.fit')} title={T('canvas.fit')} onClick={() => rf.fitView({ padding: 0.2, duration: 250, maxZoom: 1.2 })}>
        <Icon name="Maximize2" size={15} />
      </button>
      {!readOnly && (
        <button type="button" className="h-8 px-2.5 rounded-[7px] text-sm text-fg hover:bg-raised" onClick={onArrange}>
          {T('canvas.arrange')}
        </button>
      )}
    </div>
  );
}
