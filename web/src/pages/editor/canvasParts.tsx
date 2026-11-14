import { createContext, Fragment, memo, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import type { Catalog, GraphNode, Issue } from '../../api/types';
import { cx } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { CATEGORY_LABEL, NodeIcon } from '../../components/ui/data';
import { fmtDuration } from '../../lib/format';
import { NODE_H, NODE_W, portsOf, summarize, T, typeOf, type StepInfo } from './lib';

export interface EditorCtxValue {
  catalog: Catalog | undefined;
  steps: Map<string, StepInfo> | null;
  runFinished: boolean;
  issues: Map<string, Issue[]>;
  readOnly: boolean;
  focusId: string | null;
  deleteEdge: (id: string) => void;
}
export const EditorCtx = createContext<EditorCtxValue>({ catalog: undefined, steps: null, runFinished: false, issues: new Map(), readOnly: true, focusId: null, deleteEdge: () => {} });

export type FlowNode = Node<{ node: GraphNode }, 'll'>;
export type EdgeState = 'idle' | 'active' | 'error' | 'waiting' | 'skipped';
export type FlowEdge = Edge<{ state: EdgeState; label?: string; portLabel?: string }, 'll'>;

type Tone = 'ok' | 'err' | 'warn' | 'cyan' | 'muted' | 'link';
const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', err: 'text-err', warn: 'text-warn', cyan: 'text-cyan', muted: 'text-fg-muted', link: 'text-fg-link' };
const TONE_BORDER: Record<Tone, string> = { ok: 'border-ok', err: 'border-err', warn: 'border-warn', cyan: 'border-cyan', muted: 'border-line', link: 'border-primary' };

export interface NodeState {
  tone: Tone;
  text: string;
  pulse: boolean;
  dim: boolean;
  /** Rahmen ändert sich (Status), sonst neutraler Rahmen */
  ring: boolean;
}

/** Status eines Bausteins aus Testlauf, Validierung und Einstellungen. */
export function nodeState(node: GraphNode, ctx: Pick<EditorCtxValue, 'steps' | 'runFinished' | 'issues'>): NodeState {
  const step = ctx.steps?.get(node.id);
  if (ctx.steps) {
    if (step) {
      const dur = step.duration_ms != null ? ` · ${fmtDuration(step.duration_ms)}` : '';
      const st = step.status_text ? ` · ${step.status_text}` : '';
      switch (step.status) {
        case 'success':
          return { tone: 'ok', text: `${T('status.success')}${st}${dur}`, pulse: false, dim: false, ring: true };
        case 'simulated':
          return { tone: 'cyan', text: `${T('status.simulated')}${st}${dur}`, pulse: false, dim: false, ring: true };
        case 'error':
          return { tone: 'err', text: `${T('status.error')} · ${step.error?.meldung ?? step.status_text ?? ''}`, pulse: false, dim: false, ring: true };
        case 'waiting':
          return { tone: 'warn', text: `${T('status.waiting')}${st}`, pulse: true, dim: false, ring: true };
        case 'running':
          return { tone: 'link', text: T('status.running'), pulse: true, dim: false, ring: true };
        case 'skipped':
          return { tone: 'muted', text: T('status.skipped'), pulse: false, dim: true, ring: false };
      }
    }
    if (ctx.runFinished) return { tone: 'muted', text: T('status.skipped'), pulse: false, dim: true, ring: false };
    return { tone: 'muted', text: T('status.pending'), pulse: false, dim: false, ring: false };
  }
  if (node.disabled) return { tone: 'muted', text: T('status.disabled'), pulse: false, dim: true, ring: false };
  const iss = ctx.issues.get(node.id) ?? [];
  const err = iss.find((i) => i.severity === 'error');
  const warn = iss.find((i) => i.severity === 'warning');
  const strip = (m: string) => m.replace(`${node.name}: `, '');
  if (err) return { tone: 'err', text: iss.length > 1 ? T('status.problems', { n: iss.length, first: strip(err.message) }) : strip(err.message), pulse: false, dim: false, ring: true };
  if (warn) return { tone: 'warn', text: strip(warn.message), pulse: false, dim: false, ring: true };
  return { tone: 'muted', text: T('status.ready'), pulse: false, dim: false, ring: false };
}

export function nodeHeight(ports: number) {
  return Math.max(NODE_H, ports * 22 + 16);
}

export const NodeCard = memo(function NodeCard({ data, selected, id }: NodeProps<FlowNode>) {
  const ctx = useContext(EditorCtx);
  const n = data.node;
  const info = typeOf(ctx.catalog, n.type);
  const ports = portsOf(info, n);
  const st = nodeState(n, ctx);
  const isTrigger = info?.category === 'trigger';
  const cat = info?.category ?? 'control';
  const h = nodeHeight(ports.length);
  const focused = ctx.focusId === id;
  return (
    <div
      className={cx(
        'relative box-border rounded-node bg-card border px-3 py-2.5 flex flex-col gap-[7px] text-left text-fg transition-[box-shadow,opacity] duration-fast',
        selected || focused ? 'border-primary shadow-selected' : st.ring ? TONE_BORDER[st.tone] : 'border-line',
        st.ring && !selected && 'shadow-[0_4px_14px_rgba(2,6,23,.25)]',
      )}
      style={{ width: NODE_W, height: h, opacity: st.dim && !selected ? 0.62 : 1 }}
    >
      <div className="flex items-center gap-[9px] min-w-0">
        <NodeIcon icon={info?.icon ?? 'Box'} category={cat} size={28} />
        <div className="flex flex-col min-w-0 leading-[1.2]">
          <span className="text-sm font-semibold truncate">{n.name || info?.title}</span>
          <span className="text-[11px] text-fg-muted truncate">{CATEGORY_LABEL[cat]}</span>
        </div>
      </div>
      <span className="text-meta text-fg-muted truncate shrink-0">{summarize(n, info, ctx.catalog)}</span>
      <span className={cx('flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap overflow-hidden', TONE_TEXT[st.tone])}>
        <span aria-hidden="true" className={cx('w-1.5 h-1.5 rounded-full shrink-0 bg-current', st.pulse && 'll-pulse')} />
        <span className="truncate">{st.text}</span>
      </span>
      {!isTrigger && <Handle type="target" position={Position.Left} id="in" isConnectable={!ctx.readOnly} aria-label={T('port.inAria')} />}
      {ports.map((p, i) => {
        const top = `${((i + 1) / (ports.length + 1)) * 100}%`;
        return (
          <Fragment key={p.id}>
            <Handle type="source" position={Position.Right} id={p.id} isConnectable={!ctx.readOnly} style={{ top, borderColor: p.id === 'error' ? 'var(--ll-err)' : undefined }} aria-label={T('port.outAria', { label: p.label })} />
            {(ports.length > 1 || p.id === 'error') && (
              <span
                className={cx('absolute left-full ml-2.5 -translate-y-1/2 text-[11px] font-medium whitespace-nowrap px-1 rounded-[4px] bg-bg pointer-events-none', p.id === 'error' ? 'text-err' : 'text-fg-muted')}
                style={{ top }}
              >
                {p.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
});

const EDGE_STROKE: Record<EdgeState, string> = {
  idle: 'var(--ll-text-2)',
  active: 'var(--ll-ok)',
  error: 'var(--ll-err)',
  waiting: 'var(--ll-warn)',
  skipped: 'var(--ll-text-2)',
};

export function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<FlowEdge>) {
  const ctx = useContext(EditorCtx);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const state = data?.state ?? 'idle';
  const animated = state === 'active' || state === 'waiting';
  // Daten-Label nur so lang, wie zwischen den Bausteinen Platz ist (Mono 11 ≈ 6,7 px je Zeichen)
  const room = Math.abs(targetX - sourceX) - 12;
  const full = data?.label ?? '';
  const short = full.split(' · ')[0];
  const shown = !full ? '' : full.length * 6.7 + 14 <= room ? full : short.length * 6.7 + 14 <= room ? short : '';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={animated ? 'll-edge-flow' : undefined}
        style={{
          stroke: selected ? 'var(--ll-primary)' : EDGE_STROKE[state],
          strokeWidth: selected || animated ? 2.2 : 1.8,
          strokeDasharray: state === 'skipped' ? '2 5' : undefined,
          opacity: state === 'skipped' ? 0.7 : 1,
        }}
      />
      {(shown || (selected && !ctx.readOnly)) && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan absolute flex items-center gap-1" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: 'all' }}>
            {shown && (
              <span title={full} className="font-mono text-[11px] px-1.5 py-0.5 rounded-chip border border-line bg-card text-fg whitespace-nowrap">
                {shown}
              </span>
            )}
            {selected && !ctx.readOnly && (
              <button
                type="button"
                aria-label={T('canvas.deleteEdge')}
                title={T('canvas.deleteEdge')}
                onClick={() => ctx.deleteEdge(id)}
                className="w-6 h-6 inline-flex items-center justify-center rounded-full border border-line bg-card text-fg-muted hover:text-err hover:border-err"
              >
                <Icon name="X" size={12} />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const nodeTypes = { ll: NodeCard };
export const edgeTypes = { ll: FlowEdgeView };
