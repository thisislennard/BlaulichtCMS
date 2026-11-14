import { forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { del, post } from '../../api/client';
import type { Catalog, Graph, GraphNode, Issue, NodeTypeInfo } from '../../api/types';
import { SchemaForm } from '../../components/forms/SchemaForm';
import { Button, cx, ErrorBox, FieldWrap, Input, Notice, SegmentedControl, Select, Switch, Tabs, Textarea } from '../../components/ui/core';
import { CopyButton, OneTimeSecret, useErrorToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { CATEGORY_LABEL, JsonView, NodeIcon } from '../../components/ui/data';
import { fmtDateTime, fmtDuration } from '../../lib/format';
import { ancestors, flatten, keyProblem, shortValue, T, typeLabel, typeOf, valueType, type StepInfo } from './lib';
import { VariablePicker, type VarGroup, type VarItem } from './VariablePicker';

export interface Connection {
  id: string;
  connector: string;
  name: string;
  status: 'untested' | 'ok' | 'warning' | 'error' | 'disabled';
  status_message?: string | null;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  status: string;
  draft: Graph;
  draft_revision: number;
  active_version_id: string | null;
  sample_event: { nodeId: string; data: any; received_at: string } | null;
  listening: boolean;
  fourEyes: boolean;
  versions: { id: string; number: number; state: string; change_note: string; requested_at: string | null; approved_at: string | null; requested_by?: string | null; requested_by_name: string | null; approved_by_name: string | null; active: boolean }[];
  endpoints: { id: string; node_id: string; auth_mode: 'hmac' | 'token'; status: string; last_received_at: string | null; received_count: number; url: string; path: string }[];
}

export interface NodeTestResult {
  nodeId: string;
  ok: boolean;
  simulated?: boolean;
  durationMs?: number;
  port?: string;
  output?: any;
  statusText?: string | null;
  error?: any;
}

const CONN_STATUS: Record<string, { tone: string; dot: string; label: string }> = {
  ok: { tone: 'text-ok', dot: 'bg-ok', label: 'conn.ok' },
  warning: { tone: 'text-warn', dot: 'bg-warn', label: 'conn.warning' },
  error: { tone: 'text-err', dot: 'bg-err', label: 'conn.error' },
  disabled: { tone: 'text-fg-muted', dot: 'bg-fg-muted', label: 'conn.disabled' },
  untested: { tone: 'text-fg-muted', dot: 'bg-fg-muted', label: 'conn.untested' },
};

interface Props {
  node: GraphNode;
  info: NodeTypeInfo;
  catalog: Catalog;
  graph: Graph;
  workflow: WorkflowDetail;
  connections: Connection[];
  readOnly: boolean;
  narrow: boolean;
  issues: Issue[];
  step: StepInfo | undefined;
  runId: number | null;
  stepOutputs: Record<string, any>;
  lastOutputs: { runId: number | null; outputs: Record<string, any> };
  testResult: NodeTestResult | null;
  testing: boolean;
  onChange: (patch: Partial<GraphNode>, coalesce?: string) => void;
  onRenameKey: (key: string) => void;
  onDelete: () => void;
  onClose: () => void;
  onTest: () => void;
  flush: () => Promise<boolean>;
  refetchWorkflow: () => void;
}

type Tab = 'params' | 'settings' | 'output';

export const ConfigPanel = forwardRef<HTMLElement, Props>(function ConfigPanel(p, ref) {
  const { node, info, catalog } = p;
  const [tab, setTab] = useState<Tab>('params');
  const [picker, setPicker] = useState<{ anchor: HTMLElement; insert: (t: string) => void } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setPicker(null);
  }, [node.id]);
  useEffect(() => {
    if (p.testResult?.nodeId === node.id) setTab('output');
  }, [p.testResult, node.id]);

  const connector = info.connector ? catalog.connectors.find((c) => c.id === info.connector) : undefined;
  const system = connector?.name ?? info.title;
  const cat = info.category;

  const groups = useMemo<VarGroup[]>(() => buildGroups(p.graph, node, catalog, p.stepOutputs, p.lastOutputs.outputs, p.workflow.sample_event), [p.graph, node, catalog, p.stepOutputs, p.lastOutputs.outputs, p.workflow.sample_event]);
  const source = p.runId ? T('picker.fromRun', { id: p.runId }) : p.lastOutputs.runId ? T('picker.fromRun', { id: p.lastOutputs.runId }) : T('picker.examples');

  const renderVariableButton = (insert: (t: string) => void) =>
    p.readOnly ? null : (
      <button
        type="button"
        aria-label={T('picker.open')}
        title={T('picker.open')}
        aria-haspopup="dialog"
        onClick={(e) => {
          const anchor = e.currentTarget;
          setPicker((cur) => (cur?.anchor === anchor ? null : { anchor, insert }));
        }}
        className="h-[26px] px-1.5 rounded-chip border border-line bg-raised font-mono text-meta text-fg-link hover:border-primary"
      >
        {'{ }'}
      </button>
    );

  const fieldErrors: Record<string, string> = {};
  for (const i of p.issues) if (i.field && !fieldErrors[i.field]) fieldErrors[i.field] = i.message.replace(`${node.name}: `, '');
  const general = p.issues.filter((i) => !i.field || !info.fields.some((f) => f.key === i.field) && i.field !== 'connection' && i.field !== 'key');

  return (
    <aside
      ref={(el) => {
        panelRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      aria-label={T('panel.aria')}
      className={cx('w-panel max-w-full shrink-0 border-l border-line bg-sidebar flex flex-col min-h-0', p.narrow && 'absolute right-0 top-0 bottom-0 z-20 shadow-float')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !picker) {
          e.stopPropagation();
          p.onClose();
        }
      }}
    >
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
        <NodeIcon icon={info.icon} category={cat} size={34} />
        <div className="flex flex-col min-w-0 flex-1">
          <input
            aria-label={T('panel.nodeName')}
            value={node.name}
            readOnly={p.readOnly}
            maxLength={80}
            onChange={(e) => p.onChange({ name: e.target.value }, `name:${node.id}`)}
            className="bg-transparent border-0 outline-none text-section font-semibold text-fg p-0 rounded-[4px] focus-visible:shadow-ring min-w-0"
          />
          <span className="text-meta text-fg-muted truncate">
            {CATEGORY_LABEL[cat]} · {system}
          </span>
        </div>
        <Button iconOnly icon="X" variant="ghost" size="sm" aria-label={T('panel.close')} title={T('panel.close')} onClick={p.onClose} />
      </div>
      <div className="px-4">
        <Tabs
          label={T('panel.tabs')}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'params', label: T('panel.tabParams') },
            { value: 'settings', label: T('panel.tabSettings') },
            { value: 'output', label: T('panel.tabOutput') },
          ]}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-4" role="tabpanel">
        {tab === 'params' && (
          <>
            {p.step?.status === 'error' && <StepErrorBox step={p.step} connectionId={node.connectionId ?? null} />}
            {general.length > 0 && (
              <Notice tone="warning" title={T('panel.incomplete')}>
                <ul className="m-0 pl-4 flex flex-col gap-0.5">
                  {general.map((i, k) => (
                    <li key={k}>{i.message.replace(`${node.name}: `, '')}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {info.trigger === 'webhook' && <WebhookBox {...p} />}
            {info.connector && <ConnectionField {...p} error={fieldErrors.connection} />}
            {info.fields.length > 0 ? (
              <SchemaForm
                key={node.id}
                fields={info.fields}
                values={node.config ?? {}}
                onChange={(config) => p.onChange({ config }, `cfg:${node.id}`)}
                catalog={catalog}
                errors={fieldErrors}
                renderVariableButton={(insert) => renderVariableButton(insert)}
                wpConnectionId={info.connector === 'wordpress' ? (node.connectionId ?? null) : null}
                disabled={p.readOnly}
              />
            ) : (
              <p className="m-0 text-sm text-fg-muted">{T('panel.noFields')}</p>
            )}
            <KeyField node={node} graph={p.graph} readOnly={p.readOnly} serverError={fieldErrors.key} onCommit={p.onRenameKey} />
          </>
        )}
        {tab === 'settings' && <SettingsTab {...p} />}
        {tab === 'output' && <OutputTab {...p} />}
      </div>
      <div className="flex items-center gap-2 px-4 py-3 border-t border-line">
        <Button size="sm" icon="Play" onClick={p.onTest} loading={p.testing} disabled={p.readOnly}>
          {T('panel.testNode')}
        </Button>
        <span className="flex-1 text-meta text-fg-muted text-center truncate">{p.readOnly ? T('panel.readOnly') : T('panel.autosaved')}</span>
        {!p.readOnly && <Button size="sm" iconOnly icon="Trash2" variant="ghost" aria-label={T('panel.deleteNode')} title={T('panel.deleteNode')} onClick={p.onDelete} />}
      </div>
      {picker && (
        <VariablePicker
          anchor={picker.anchor}
          panel={panelRef.current}
          groups={groups}
          filters={catalog.filters}
          source={source}
          onInsert={picker.insert}
          onClose={() => setPicker(null)}
        />
      )}
    </aside>
  );
});

/* ------------------------------------------------------------------------------------- */

function buildGroups(graph: Graph, node: GraphNode, catalog: Catalog, stepOutputs: Record<string, any>, lastOutputs: Record<string, any>, sample: WorkflowDetail['sample_event']): VarGroup[] {
  const anc = ancestors(graph, node.id);
  const trig = graph.nodes.find((n) => typeOf(catalog, n.type)?.category === 'trigger');
  if (trig && trig.id !== node.id) anc.add(trig.id);
  const list = graph.nodes.filter((n) => anc.has(n.id)).sort((a, b) => (a.id === trig?.id ? -1 : b.id === trig?.id ? 1 : a.position.x - b.position.x));
  const groups: VarGroup[] = list.map((n) => {
    const info = typeOf(catalog, n.type);
    const isTrig = n.id === trig?.id;
    const value = stepOutputs[n.id] ?? lastOutputs[n.id] ?? (isTrig && sample ? sample.data : undefined) ?? info?.sampleOutput;
    const items: VarItem[] = flatten(value).map(({ path, value: v }) => ({ insert: `${n.key}.${path}`, key: path, type: typeLabel(valueType(v), v), value: shortValue(v) }));
    for (const f of info?.outputFields ?? []) {
      if (!items.some((i) => i.key === f.path)) items.push({ insert: `${n.key}.${f.path}`, key: f.path, type: typeLabel(f.type), value: f.description });
    }
    return { id: n.id, label: n.name.toLowerCase() === n.key ? n.name : `${n.name} · ${n.key}`, category: info?.category ?? 'control', items };
  });
  groups.push({
    id: '__system',
    label: T('picker.system'),
    category: 'control',
    items: [
      { insert: 'run.id', key: 'run.id', type: typeLabel('number'), value: T('picker.sysRunId') },
      { insert: 'run.started_at', key: 'run.started_at', type: typeLabel('date'), value: T('picker.sysStarted') },
      { insert: 'run.workflow', key: 'run.workflow', type: typeLabel('text'), value: T('picker.sysWorkflow') },
      { insert: 'now', key: 'now', type: typeLabel('date'), value: T('picker.sysNow') },
    ],
  });
  return groups;
}

function StepErrorBox({ step, connectionId }: { step: StepInfo; connectionId: string | null }) {
  const e = step.error ?? {};
  return (
    <ErrorBox
      title={e.klasse_text ?? T('panel.stepFailed')}
      actions={
        <>
          {connectionId && (
            <Link to={`/verbindungen/${connectionId}`} className="inline-flex items-center gap-1.5 h-ctl-sm px-3 rounded-control border border-line bg-card text-sm font-medium !text-fg hover:bg-raised">
              <Icon name="Plug" size={14} />
              {T('panel.openConnection')}
            </Link>
          )}
          <CopyButton size="sm" value={JSON.stringify(e, null, 2)} label={T('panel.copyDetails')} />
        </>
      }
    >
      <span className="block">{e.meldung ?? step.status_text ?? T('panel.stepFailed')}</span>
      {e.hinweis && <span className="block mt-1">{e.hinweis}</span>}
      {e.doppelwirkung_moeglich && <span className="block mt-1 text-warn">{T('panel.sideEffectUnknown')}</span>}
    </ErrorBox>
  );
}

function ConnectionField({ info, node, connections, readOnly, onChange, catalog, error }: Props & { error?: string }) {
  const list = connections.filter((c) => c.connector === info.connector);
  const cur = list.find((c) => c.id === node.connectionId);
  const st = cur ? CONN_STATUS[cur.status] ?? CONN_STATUS.untested : null;
  const connName = catalog.connectors.find((c) => c.id === info.connector)?.name ?? info.connector ?? '';
  return (
    <FieldWrap
      label={T('panel.connection')}
      required={!info.connectionOptional}
      htmlFor={`conn-${node.id}`}
      error={error}
      labelAction={
        cur && st ? (
          <span className={cx('inline-flex items-center gap-1.5 text-meta font-medium', st.tone)}>
            <span aria-hidden="true" className={cx('w-1.5 h-1.5 rounded-full', st.dot)} />
            {T(st.label)}
          </span>
        ) : undefined
      }
    >
      <Select id={`conn-${node.id}`} value={node.connectionId ?? ''} disabled={readOnly} invalid={!!error} onChange={(e) => onChange({ connectionId: e.target.value || null })}>
        <option value="">{list.length ? T('panel.chooseConnection') : T('panel.noConnection', { name: connName })}</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {T((CONN_STATUS[c.status] ?? CONN_STATUS.untested).label)}
          </option>
        ))}
      </Select>
      <div className="flex gap-3 flex-wrap text-meta">
        {cur && (
          <Link to={`/verbindungen/${cur.id}`} className="inline-flex items-center gap-1">
            <Icon name="ExternalLink" size={12} />
            {T('panel.openConnection')}
          </Link>
        )}
        {!readOnly && (
          <Link to={`/schnittstellen/${info.connector}/verbinden`} className="inline-flex items-center gap-1">
            <Icon name="Plus" size={12} />
            {T('panel.newConnection')}
          </Link>
        )}
      </div>
    </FieldWrap>
  );
}

function KeyField({ node, graph, readOnly, serverError, onCommit }: { node: GraphNode; graph: Graph; readOnly: boolean; serverError?: string; onCommit: (k: string) => void }) {
  const [draft, setDraft] = useState(node.key);
  useEffect(() => setDraft(node.key), [node.key, node.id]);
  const problem = draft === node.key ? (serverError ?? null) : keyProblem(draft, node.id, graph);
  const commit = () => {
    if (draft !== node.key && !keyProblem(draft, node.id, graph)) onCommit(draft);
  };
  return (
    <FieldWrap label={T('panel.key')} htmlFor={`key-${node.id}`} help={T('panel.keyHelp', { key: draft || node.key })} error={problem}>
      <Input
        id={`key-${node.id}`}
        mono
        value={draft}
        readOnly={readOnly}
        maxLength={41}
        invalid={!!problem}
        onChange={(e) => setDraft(e.target.value.toLowerCase())}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(node.key);
        }}
        autoComplete="off"
        spellCheck={false}
      />
    </FieldWrap>
  );
}

function numOrUndef(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function SettingsTab({ node, info, readOnly, onChange }: Props) {
  const s = node.settings ?? {};
  const set = (patch: Partial<NonNullable<GraphNode['settings']>>) => {
    const next = { ...s, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k];
    onChange({ settings: next }, `set:${node.id}`);
  };
  const range = (v: number | undefined, min: number, max: number) => (v != null && (v < min || v > max) ? T('settings.range', { min, max }) : null);
  const idem = !info.sideEffect ? 'safe' : info.idempotent === true ? 'idempotent' : info.idempotent === false ? 'unsafe' : 'depends';
  return (
    <>
      {idem === 'safe' && <Notice tone="success" icon="ShieldCheck">{T('settings.idemSafe')}</Notice>}
      {idem === 'idempotent' && <Notice tone="success" icon="ShieldCheck">{T('settings.idemYes')}</Notice>}
      {idem === 'unsafe' && <Notice tone="warning">{T('settings.idemNo')}</Notice>}
      {idem === 'depends' && <Notice tone="primary">{T('settings.idemDepends')}</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <FieldWrap label={T('settings.retries')} htmlFor={`r-${node.id}`} error={range(s.retries, 0, 10)} help={T('settings.retriesHelp')}>
          <Input id={`r-${node.id}`} type="number" min={0} max={10} className="tabular" placeholder="3" value={s.retries ?? ''} readOnly={readOnly} onChange={(e) => set({ retries: numOrUndef(e.target.value) })} />
        </FieldWrap>
        <FieldWrap label={T('settings.delay')} htmlFor={`d-${node.id}`} error={range(s.retryDelaySec, 1, 3600)} help={T('settings.seconds')}>
          <Input id={`d-${node.id}`} type="number" min={1} max={3600} className="tabular" placeholder={T('settings.auto')} value={s.retryDelaySec ?? ''} readOnly={readOnly} onChange={(e) => set({ retryDelaySec: numOrUndef(e.target.value) })} />
        </FieldWrap>
      </div>
      <FieldWrap label={T('settings.timeout')} htmlFor={`t-${node.id}`} error={range(s.timeoutSec, 1, 300)} help={T('settings.timeoutHelp')}>
        <div className="flex items-center gap-2">
          <Input id={`t-${node.id}`} type="number" min={1} max={300} className="max-w-[140px] tabular" placeholder="30" value={s.timeoutSec ?? ''} readOnly={readOnly} onChange={(e) => set({ timeoutSec: numOrUndef(e.target.value) })} />
          <span className="text-sm text-fg-muted">{T('settings.secondsUnit')}</span>
        </div>
      </FieldWrap>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{T('settings.onError')}</span>
        <SegmentedControl
          label={T('settings.onError')}
          value={s.onError ?? 'stop'}
          onChange={(v) => !readOnly && set({ onError: v === 'stop' ? undefined : v })}
          options={[
            { value: 'stop', label: T('settings.onErrorStop') },
            { value: 'continue', label: T('settings.onErrorContinue') },
          ]}
        />
        <span className="text-meta text-fg-muted">{s.onError === 'continue' ? T('settings.onErrorContinueHelp') : T('settings.onErrorStopHelp')}</span>
      </div>
      <Switch checked={!!node.disabled} disabled={readOnly} onChange={(v) => onChange({ disabled: v || undefined })} label={T('settings.disable')} description={T('settings.disableHelp')} />
      <FieldWrap label={T('settings.notes')} htmlFor={`no-${node.id}`} help={T('settings.notesHelp')}>
        <Textarea id={`no-${node.id}`} rows={4} maxLength={2000} value={node.notes ?? ''} readOnly={readOnly} onChange={(e) => onChange({ notes: e.target.value || undefined }, `notes:${node.id}`)} />
      </FieldWrap>
    </>
  );
}

function OutputTab({ node, info, step, runId, lastOutputs, testResult }: Props) {
  const own = testResult?.nodeId === node.id ? testResult : null;
  let value: unknown;
  let source: ReactNode;
  if (own?.ok) {
    value = own.output;
    source = T(own.simulated ? 'output.fromNodeTestSim' : 'output.fromNodeTest', { ms: fmtDuration(own.durationMs ?? 0) });
  } else if (step && step.output_preview != null) {
    value = step.output_preview;
    source = T('output.fromRun', { id: runId ?? '' });
  } else if (lastOutputs.outputs[node.id] != null) {
    value = lastOutputs.outputs[node.id];
    source = T('output.fromRun', { id: lastOutputs.runId ?? '' });
  } else {
    value = info.sampleOutput;
    source = T('output.example');
  }
  const rows = flatten(value).filter((r) => !(r.value && typeof r.value === 'object' && !Array.isArray(r.value)));
  return (
    <>
      {own && !own.ok && (
        <ErrorBox title={own.error?.klasse_text ?? T('panel.stepFailed')} actions={<CopyButton size="sm" value={JSON.stringify(own.error, null, 2)} label={T('panel.copyDetails')} />}>
          {own.error?.meldung}
          {own.error?.hinweis && <span className="block mt-1">{own.error.hinweis}</span>}
        </ErrorBox>
      )}
      {own?.ok && (
        <Notice tone={own.simulated ? 'primary' : 'success'} icon={own.simulated ? 'FlaskConical' : 'CheckCircle2'} title={own.simulated ? T('output.simulatedOk') : T('output.ok')}>
          {[own.statusText, own.port && own.port !== 'out' ? T('output.port', { port: own.port }) : null].filter(Boolean).join(' · ') || null}
        </Notice>
      )}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="m-0 text-meta font-semibold">{T('output.preview')}</h3>
          <span className="text-meta text-fg-muted truncate">{source}</span>
        </div>
        {rows.length ? (
          <dl className="m-0 grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1.5 p-3 rounded-node border border-line bg-bg font-mono text-meta">
            {rows.slice(0, 60).map((r) => (
              <div key={r.path} className="contents">
                <dt className="text-fg-muted break-all">{r.path}</dt>
                <dd className="m-0 text-fg break-words">{r.value === undefined ? '' : JSON.stringify(r.value)}</dd>
              </div>
            ))}
          </dl>
        ) : value != null && typeof value !== 'object' ? (
          <JsonView value={value} />
        ) : (
          <p className="m-0 text-sm text-fg-muted">{T('output.none')}</p>
        )}
      </section>
      {info.outputFields.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-meta font-semibold">{T('output.fields')}</h3>
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {info.outputFields.map((f) => (
              <li key={f.path} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <code className="font-mono text-meta text-fg-link">
                    {node.key}.{f.path}
                  </code>
                  <span className="text-[11px] text-fg-muted">{typeLabel(f.type)}</span>
                </span>
                <span className="text-meta text-fg-muted">{f.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function WebhookBox({ node, workflow, readOnly, flush, refetchWorkflow }: Props) {
  const errorToast = useErrorToast();
  const ep = workflow.endpoints.find((e) => e.node_id === node.id);
  const [created, setCreated] = useState<{ url: string; secret: string | null; authMode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const url = created?.url ?? ep?.url;
  const mode = (node.type === 'alamos.alarm' ? 'token' : (ep?.auth_mode ?? node.config?.authMode ?? 'hmac')) as 'hmac' | 'token';
  const sample = workflow.sample_event && (!workflow.sample_event.nodeId || workflow.sample_event.nodeId === node.id) ? workflow.sample_event : null;

  const createAddress = async () => {
    setBusy(true);
    try {
      if (!(await flush())) return;
      const r = await post(`/workflows/${workflow.id}/nodes/${node.id}/webhook`);
      setCreated({ url: r.url, secret: r.secret ?? null, authMode: r.authMode });
      refetchWorkflow();
    } catch (e) {
      errorToast(e, T('webhook.createFailed'));
    } finally {
      setBusy(false);
    }
  };
  const listen = async (stop = false) => {
    try {
      if (!stop && !(await flush())) return;
      await post(`/workflows/${workflow.id}/listen`, { stop });
      refetchWorkflow();
    } catch (e) {
      errorToast(e);
    }
  };
  const discard = async () => {
    try {
      await del(`/workflows/${workflow.id}/sample`);
      refetchWorkflow();
    } catch (e) {
      errorToast(e);
    }
  };
  const curl =
    mode === 'token'
      ? `curl -X POST "${url ?? '<ADRESSE>'}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-LifeLink-Token: <GEHEIMNIS>" \\\n  -d '{"titel":"Test"}'`
      : `TS=$(date +%s); BODY='{"titel":"Test"}'\nSIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "<GEHEIMNIS>" | sed 's/^.* //')\ncurl -X POST "${url ?? '<ADRESSE>'}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-LifeLink-Timestamp: $TS" \\\n  -H "X-LifeLink-Signature: v1=$SIG" \\\n  -d "$BODY"`;

  return (
    <section aria-label={T('webhook.title')} className="flex flex-col gap-3 p-3.5 rounded-node border border-line bg-card">
      <div className="flex items-center gap-2">
        <Icon name="Webhook" size={15} className="text-fg-link" />
        <h3 className="m-0 text-sm font-semibold flex-1">{T('webhook.title')}</h3>
        {ep && <span className="text-meta text-fg-muted">{T('webhook.received', { n: ep.received_count })}</span>}
      </div>
      {url ? (
        <div className="flex gap-2">
          <Input readOnly value={url} mono aria-label={T('webhook.address')} onFocus={(e) => e.target.select()} />
          <CopyButton value={url} size="md" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sm text-fg-muted">{T('webhook.noAddress')}</p>
          {!readOnly && (
            <div>
              <Button size="sm" icon="Link2" loading={busy} onClick={createAddress}>
                {T('webhook.create')}
              </Button>
            </div>
          )}
        </div>
      )}
      {created?.secret ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{mode === 'token' ? T('webhook.secretToken') : T('webhook.secretHmac')}</span>
          <OneTimeSecret value={created.secret} label={T('webhook.secret')} />
        </div>
      ) : url ? (
        <p className="m-0 text-meta text-fg-muted">
          {T('webhook.secretHint')}{' '}
          <Link to="/webhooks">{T('webhook.secretLink')}</Link>
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-semibold">{T('webhook.security')}</span>
        <span className="text-meta text-fg-muted">{mode === 'token' ? T('webhook.securityToken') : T('webhook.securityHmac')}</span>
        <details className="text-meta">
          <summary className="cursor-pointer text-fg-link">{T('webhook.curl')}</summary>
          <pre className="m-0 mt-1.5 p-2.5 rounded-node border border-line bg-bg font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{curl}</pre>
        </details>
      </div>
      {!readOnly && url && (
        <div className="flex flex-col gap-2 pt-1 border-t border-line">
          {workflow.listening ? (
            <div className="flex items-center gap-2 flex-wrap pt-2">
              <span className="inline-flex items-center gap-1.5 text-sm text-warn font-medium">
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-warn ll-pulse" />
                {T('webhook.listening')}
              </span>
              <Button size="sm" variant="ghost" onClick={() => listen(true)}>
                {T('webhook.stopListening')}
              </Button>
            </div>
          ) : (
            <div className="pt-2">
              <Button size="sm" icon="Hourglass" onClick={() => listen(false)}>
                {T('webhook.listen')}
              </Button>
            </div>
          )}
        </div>
      )}
      {sample && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-meta font-semibold text-ok inline-flex items-center gap-1.5">
              <Icon name="CheckCircle2" size={13} />
              {T('webhook.sampleReceived', { at: fmtDateTime(sample.received_at, { seconds: true }) })}
            </span>
            {!readOnly && (
              <Button size="sm" variant="ghost" onClick={discard}>
                {T('webhook.discard')}
              </Button>
            )}
          </div>
          <JsonView value={sample.data} className="max-h-[220px]" />
        </div>
      )}
    </section>
  );
}
