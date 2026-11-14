import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '../../api/client';
import type { Category } from '../../api/types';
import { Badge, Button, cx, EmptyState, ErrorBox, LinkButton, Notice, Skeleton, StatusBadge, Tabs } from '../../components/ui/core';
import { CopyButton, Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { CategoryDot, JsonView } from '../../components/ui/data';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtDuration, fmtRelative } from '../../lib/format';
import { ACTIVE_RUN, FAILED_RUN, triggerInfo, useNow } from './runShared';

interface StepError {
  klasse?: string;
  klasse_text?: string;
  meldung?: string;
  hinweis?: string | null;
  technisch?: string | null;
  doppelwirkung_moeglich?: boolean;
}

interface Step {
  id: number;
  node_id: string;
  node_type: string;
  node_name: string;
  category: Category;
  status: 'running' | 'success' | 'error' | 'skipped' | 'waiting' | 'simulated';
  attempt: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  output_port: string | null;
  input_preview: unknown;
  output_preview: unknown;
  error: StepError | null;
  external_ref: string | null;
  status_text: string | null;
}

interface RunData {
  id: number;
  workflow_id: string;
  workflow_name: string;
  version_number: number | null;
  mode: 'production' | 'test';
  simulate: boolean;
  trigger_kind: string;
  trigger_label: string;
  status: string;
  correlation_id: string;
  parent_run_id: number | null;
  replay_kind: 'full' | 'from_failed' | null;
  started_by_name: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_class_label: string | null;
  error_message: string | null;
  error_node_id: string | null;
  input_preview: unknown;
  summary: string;
  steps: Step[];
  graph: { nodes: { id: string; name: string; type: string; key: string; position: { x: number; y: number }; category: Category; icon: string }[]; edges: { source: string; target: string; sourcePort: string }[] } | null;
  event: { id: number; received_at: string; source: string; dedup_key: string | null; correlation_id: string | null; duplicate: boolean } | null;
  children: { id: number; status: string; replay_kind: string | null; created_at: string }[];
  replay: { fromFailed: { allowed: boolean; reason?: string }; full: { allowed: boolean }; warning: string | null };
}

interface Row {
  nodeId: string;
  name: string;
  category: Category;
  status: Step['status'] | 'none' | 'canceled';
  start: number | null;
  end: number | null;
  durationMs: number | null;
  attempts: Step[];
}

const BAR: Record<Row['status'], string> = {
  success: 'bg-ok opacity-80',
  error: 'bg-err',
  waiting: 'bg-warn ll-pulse',
  running: 'bg-primary ll-pulse',
  skipped: 'bg-fg-muted opacity-50',
  simulated: 'bg-cyan opacity-80',
  none: 'border border-dashed border-line bg-transparent',
  canceled: 'bg-fg-muted opacity-50',
};
const STEP_TEXT: Record<Row['status'], string> = {
  success: 'text-fg-muted',
  error: 'text-err',
  waiting: 'text-warn',
  running: 'text-fg-link',
  skipped: 'text-fg-muted',
  simulated: 'text-cyan',
  none: 'text-fg-muted',
  canceled: 'text-fg-muted',
};

type Tab = 'in' | 'out' | 'err';

export function RunDetail({ id }: { id: number }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const catalog = useCatalog().data;
  const q = useQuery<RunData>({
    queryKey: ['run', id],
    queryFn: () => get(`/runs/${id}`),
    refetchInterval: (query) => (query.state.data && ACTIVE_RUN.includes(query.state.data.status) ? 2000 : false),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const run = q.data;
  const active = !!run && ACTIVE_RUN.includes(run.status);
  const now = useNow(active ? 500 : 60_000);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('out');
  const [confirm, setConfirm] = useState<{ kind: 'full' | 'from_failed'; warning: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    if (!run) return [];
    const byNode = new Map<string, Step[]>();
    for (const s of run.steps) {
      const l = byNode.get(s.node_id) ?? [];
      l.push(s);
      byNode.set(s.node_id, l);
    }
    const out: Row[] = [];
    for (const [nodeId, list] of byNode) {
      const last = list[list.length - 1];
      const start = Math.min(...list.map((s) => new Date(s.started_at).getTime()));
      const ends = list.map((s) => (s.finished_at ? new Date(s.finished_at).getTime() : null));
      const end = ends.some((e) => e == null) ? null : Math.max(...(ends as number[]));
      out.push({ nodeId, name: last.node_name, category: (last.category as Category) ?? 'control', status: !ACTIVE_RUN.includes(run.status) && (last.status === 'waiting' || last.status === 'running') ? 'canceled' : last.status, start, end, durationMs: list.reduce((a, s) => a + (s.duration_ms ?? 0), 0), attempts: list });
    }
    const pending = (run.graph?.nodes ?? []).filter((n) => !byNode.has(n.id)).sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
    for (const n of pending) out.push({ nodeId: n.id, name: n.name, category: n.category, status: 'none', start: null, end: null, durationMs: null, attempts: [] });
    return out;
  }, [run]);

  // Standardauswahl: fehlerhafter Node, sonst der zuletzt ausgeführte
  useEffect(() => {
    if (!run || selNode) return;
    const err = rows.find((r) => r.nodeId === run.error_node_id) ?? rows.find((r) => r.status === 'error');
    const pick = err ?? [...rows].reverse().find((r) => r.status !== 'none') ?? rows[0];
    if (pick) {
      setSelNode(pick.nodeId);
      setTab(pick.status === 'error' ? 'err' : 'out');
    }
  }, [run, rows, selNode]);

  if (q.isLoading)
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-[150px] !rounded-card" />
        <Skeleton className="h-[220px] !rounded-card" />
        <Skeleton className="h-[260px] !rounded-card" />
      </div>
    );
  if (q.isError || !run) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="bg-card border border-line rounded-card p-5">
        {notFound ? (
          <EmptyState icon="Inbox" title={t('runs.detail.notFoundTitle')} text={t('runs.detail.notFoundText')} />
        ) : (
          <ErrorBox title={t('runs.detail.errorTitle')} actions={<CopyButton size="sm" value={String((q.error as Error)?.message)} label={t('runs.detail.copyDetails')} />}>
            {(q.error as Error)?.message}
          </ErrorBox>
        )}
      </div>
    );
  }

  const failed = FAILED_RUN.includes(run.status);
  const canReplay = can('run.replay');
  const runStart = new Date(run.started_at ?? run.created_at).getTime();
  const runEnd = run.finished_at ? new Date(run.finished_at).getTime() : active ? now : runStart + (run.duration_ms ?? 0);
  const total = Math.max(1, runEnd - runStart, ...rows.filter((r) => r.end).map((r) => (r.end as number) - runStart));
  const tr = triggerInfo(catalog, run.trigger_kind);
  const attempts = Math.max(run.attempts, ...run.steps.map((s) => s.attempt), 1);
  const sel = rows.find((r) => r.nodeId === selNode) ?? null;
  const selLast = sel?.attempts[sel.attempts.length - 1] ?? null;
  const selError = sel?.attempts.slice().reverse().find((s) => s.error)?.error ?? null;
  const effectNames = [
    ...new Set(
      run.steps
        .filter((s) => s.status === 'success' && catalog?.nodes.find((n) => n.type === s.node_type)?.sideEffect)
        .map((s) => s.node_name),
    ),
  ];

  const doReplay = async (kind: 'full' | 'from_failed', ok = false) => {
    if (run.replay.warning && !ok) {
      setConfirmed(false);
      setConfirm({ kind, warning: run.replay.warning });
      return;
    }
    setBusy(kind);
    try {
      const res = await post<{ runId: number }>(`/runs/${run.id}/replay`, { kind, confirm: ok });
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: ['runs'] });
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
      toast({ tone: 'success', title: t('runs.detail.replayStarted', { id: res.runId }) });
      navigate(`/ausfuehrungen/${res.runId}${window.location.search}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details?.warning) {
        setConfirmed(false);
        setConfirm({ kind, warning: e.details.warning });
      } else errToast(e, t('runs.detail.replayFailedToast'));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    try {
      await post(`/runs/${run.id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['run', run.id] });
      await qc.invalidateQueries({ queryKey: ['runs'] });
      toast({ tone: 'success', title: t('runs.detail.cancelDone', { id: run.id }) });
    } catch (e) {
      errToast(e, t('runs.detail.cancelFailed'));
    } finally {
      setBusy(null);
    }
  };

  const fromFailedReason = !canReplay ? t('runs.detail.noReplayPerm') : run.replay.fromFailed.reason;
  const fullReason = !canReplay ? t('runs.detail.noReplayPerm') : !run.replay.full.allowed ? t('runs.detail.fullNotAllowed') : undefined;

  /* Daten des gewählten Nodes */
  const inputData = (() => {
    if (!sel || !selLast) return { value: undefined as unknown, note: null as string | null };
    if (selLast.input_preview != null) return { value: selLast.input_preview, note: null };
    if (sel.category === 'trigger') return { value: run.input_preview, note: t('runs.detail.inputTrigger') };
    const preds = (run.graph?.edges ?? []).filter((e) => e.target === sel.nodeId).map((e) => e.source);
    const obj: Record<string, unknown> = {};
    for (const p of preds) {
      const steps = run.steps.filter((s) => s.node_id === p);
      const last = steps[steps.length - 1];
      const key = run.graph?.nodes.find((n) => n.id === p)?.key ?? p;
      if (last?.output_preview != null) obj[key] = last.output_preview;
    }
    return Object.keys(obj).length ? { value: obj, note: t('runs.detail.inputFromPrev') } : { value: undefined, note: null };
  })();

  const nodeType = sel ? catalog?.nodes.find((n) => n.type === (selLast?.node_type ?? run.graph?.nodes.find((x) => x.id === sel.nodeId)?.type)) : undefined;
  const idemNote = (() => {
    if (!selError) return null;
    if (selError.doppelwirkung_moeglich) return <Notice tone="warning" title={t('runs.detail.idemUnknown')} />;
    if (!nodeType?.sideEffect) return <Notice tone="success" icon="ShieldCheck" title={t('runs.detail.idemNoEffect')} />;
    if (nodeType.idempotent === false || run.replay.warning) return <Notice tone="warning" title={run.replay.warning ?? t('runs.detail.idemUnsafe')} />;
    return <Notice tone="success" icon="ShieldCheck" title={t('runs.detail.idemSafe')} />;
  })();

  const tabs: { value: Tab; label: string }[] = [
    { value: 'in', label: t('runs.detail.tabInput') },
    { value: 'out', label: t('runs.detail.tabOutput') },
    ...(selError ? [{ value: 'err' as Tab, label: t('runs.detail.tabError') }] : []),
  ];
  const curTab: Tab = tab === 'err' && !selError ? 'out' : tab;

  return (
    <>
      {/* Kopf */}
      <div className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-4">
        {run.mode === 'test' && (
          <div className={cx('flex items-start gap-2 rounded-node border border-dashed px-3 py-2 text-sm', run.simulate ? 'border-cyan/60 bg-[rgba(6,182,212,.08)]' : 'border-warn/60 bg-warn-soft')}>
            <Icon name="FlaskConical" size={16} className={cx('mt-0.5 shrink-0', run.simulate ? 'text-cyan' : 'text-warn')} />
            <span>
              <strong className={cx('font-semibold', run.simulate ? 'text-cyan' : 'text-warn')}>{run.simulate ? t('runs.detail.testSimulated') : t('runs.detail.testReal')}</strong>
              <span className="text-fg-muted"> · {run.simulate ? t('runs.detail.testSimulatedHint') : t('runs.detail.testRealHint')}</span>
            </span>
          </div>
        )}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm text-fg-muted">#{run.id}</span>
              <StatusBadge status={run.status} />
              {run.mode === 'production' && <Badge tone="neutral" dot={false}>{t('runs.detail.production')}</Badge>}
              {active && <span className="text-meta text-fg-muted">{t('runs.detail.refreshing')}</span>}
            </div>
            <h2 className="m-0 text-title font-semibold break-words">{run.workflow_name}</h2>
            {run.summary && <p className="m-0 text-sm text-fg-muted break-words">{run.summary}</p>}
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <LinkButton to={`/workflows/${run.workflow_id}`} icon="Pencil" size="sm">
              {t('runs.detail.openEditor')}
            </LinkButton>
            {active && canReplay && (
              <Button size="sm" variant="danger" icon="CircleStop" loading={busy === 'cancel'} onClick={cancel}>
                {t('runs.detail.cancel')}
              </Button>
            )}
            {!active && (
              <span title={fullReason}>
                <Button size="sm" icon="RefreshCw" disabled={!!fullReason} loading={busy === 'full'} onClick={() => doReplay('full')}>
                  {t('runs.detail.replayFull')}
                </Button>
              </span>
            )}
            {failed && (
              <span title={fromFailedReason}>
                <Button size="sm" variant="primary" icon="RotateCcw" disabled={!canReplay || !run.replay.fromFailed.allowed} loading={busy === 'from_failed'} onClick={() => doReplay('from_failed')}>
                  {t('runs.detail.replayFailed')}
                </Button>
              </span>
            )}
          </div>
        </div>
        {!active && (
          <div className="flex flex-col gap-1 text-meta text-fg-muted">
            {failed && (run.replay.fromFailed.allowed ? <span>{t('runs.detail.fromFailedExplain')}</span> : fromFailedReason && <span className="text-warn">{t('runs.detail.replayFailed')}: {fromFailedReason}</span>)}
            {run.replay.full.allowed && (
              <span>
                {t('runs.detail.fullExplain', { version: run.version_number ?? '–' })} {effectNames.length ? <span className="text-warn">{t('runs.detail.fullSideEffects', { names: effectNames.join(', ') })}</span> : t('runs.detail.fullSafe')}
              </span>
            )}
          </div>
        )}
        <dl className="m-0 grid gap-x-5 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))] border-t border-line pt-4">
          <Metric label={t('runs.detail.start')} value={fmtDateTime(run.started_at ?? run.created_at, { seconds: true })} mono />
          <Metric label={t('runs.detail.end')} value={run.finished_at ? fmtDateTime(run.finished_at, { seconds: true }) : active ? t('runs.detail.running') : '–'} mono />
          <Metric label={t('runs.detail.duration')} value={active ? fmtDuration(now - runStart) : fmtDuration(run.duration_ms)} mono />
          <Metric
            label={t('runs.detail.trigger')}
            value={
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <Icon name={tr.icon} size={14} className="shrink-0 text-fg-muted" />
                <span className="break-words">{run.trigger_label || tr.title}</span>
              </span>
            }
          />
          <Metric label={t('runs.detail.attempts')} value={String(attempts)} mono />
          <Metric label={t('runs.detail.version')} value={run.version_number ? `v${run.version_number}` : t('runs.detail.draftVersion')} mono />
          <div className="flex flex-col gap-1 min-w-0 col-span-full sm:col-span-2">
            <dt className="text-meta text-fg-muted">{t('runs.detail.correlation')}</dt>
            <dd className="m-0 flex items-center gap-2 min-w-0">
              <span className="font-mono text-meta truncate">{run.correlation_id}</span>
              <CopyButton size="sm" value={run.correlation_id} label={t('runs.detail.copy')} />
            </dd>
          </div>
        </dl>
      </div>

      {failed && !run.steps.some((s) => s.error) && (
        <ErrorBox title={t('runs.detail.runError')} actions={<CopyButton size="sm" value={JSON.stringify({ lauf: run.id, klasse: run.error_code, meldung: run.error_message, korrelation: run.correlation_id }, null, 2)} label={t('runs.detail.copyDetails')} />}>
          {run.error_message}
          {run.error_class_label && <span className="block mt-1">{run.error_class_label}</span>}
        </ErrorBox>
      )}

      {/* Zeitachse */}
      <section aria-labelledby="run-nodes" className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 id="run-nodes" className="m-0 text-section font-semibold">
            {t('runs.detail.nodes')}
          </h3>
          <span className="font-mono text-meta text-fg-muted">{t('runs.detail.timeline', { d: fmtDuration(total) })}</span>
        </div>
        {!rows.length ? (
          <p className="m-0 text-sm text-fg-muted">{t('runs.detail.noData')}</p>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
            {rows.map((r) => {
              const on = r.nodeId === selNode;
              const left = r.start != null ? ((r.start - runStart) / total) * 100 : 100;
              const end = (r.status === 'waiting' || r.status === 'running') && active ? now : r.end ?? (r.start != null ? now : null);
              const width = r.start != null && end != null ? Math.max(0.8, ((end - r.start) / total) * 100) : 0;
              const statusLabel = t(`runs.stepStatus.${r.status}`);
              return (
                <li key={r.nodeId}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setSelNode(r.nodeId);
                      setTab(r.status === 'error' ? 'err' : r.category === 'trigger' ? 'out' : 'in');
                    }}
                    className={cx('w-full grid grid-cols-[minmax(0,1fr)_auto] gap-y-1.5 sm:grid-cols-[minmax(160px,230px)_minmax(0,1fr)_84px] items-center gap-3 px-2 py-2 rounded-control text-left transition-colors duration-fast', on ? 'bg-raised' : 'hover:bg-raised', r.status === 'none' && 'opacity-70')}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <CategoryDot category={r.category} />
                      <span className="text-sm truncate">{r.name}</span>
                      {r.attempts.length > 1 && <span className="text-meta text-fg-muted shrink-0">×{r.attempts.length}</span>}
                    </span>
                    <span aria-hidden="true" className="relative h-2.5 rounded-full bg-raised col-span-2 sm:col-span-1 order-last sm:order-none">
                      {r.status === 'none' ? (
                        <span className={cx('absolute inset-y-0 left-0 right-0 rounded-full', BAR.none)} />
                      ) : (
                        <span className={cx('absolute inset-y-0 rounded-full', BAR[r.status])} style={{ left: `${Math.min(left, 99.2)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.2))}%` }} />
                      )}
                    </span>
                    <span className={cx('font-mono text-meta tabular text-right', STEP_TEXT[r.status])}>
                      {r.status === 'none' ? '—' : r.status === 'waiting' ? t('runs.stepStatus.waiting') : r.end == null ? '…' : fmtDuration(r.durationMs)}
                      <span className="sr-only">
                        {' '}
                        · {statusLabel}
                        {r.attempts.length > 1 ? ` · ${t('runs.detail.attemptsN', { n: r.attempts.length })}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-muted" aria-hidden="true">
          {(['success', 'error', 'waiting', 'simulated', 'skipped', 'canceled', 'none'] as const)
            .filter((s) => rows.some((r) => r.status === s))
            .map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className={cx('inline-block w-3 h-2 rounded-full', BAR[s].replace('ll-pulse', ''))} />
                {t(`runs.stepStatus.${s}`)}
              </span>
            ))}
        </div>
      </section>

      {/* Daten */}
      {sel && (
        <section aria-labelledby="run-data" className="bg-card border border-line rounded-card flex flex-col">
          <h3 id="run-data" className="sr-only">
            {t('runs.detail.data')}
          </h3>
          <div className="flex items-end justify-between gap-3 px-[18px] pt-2 border-b border-line flex-wrap">
            <div className="-mb-px">
              <Tabs<Tab> label={t('runs.detail.data')} value={curTab} onChange={setTab} tabs={tabs} />
            </div>
            <span className="pb-2.5 text-meta text-fg-muted truncate max-w-full">{sel.name}</span>
          </div>
          <div role="tabpanel" className="p-[18px] flex flex-col gap-3">
            {!selLast ? (
              <p className="m-0 text-sm text-fg-muted">{t('runs.detail.noStep')}</p>
            ) : curTab === 'err' && selError ? (
              <>
                <ErrorBox
                  title={selError.meldung ?? run.error_message ?? t('runs.detail.runError')}
                  actions={
                    <CopyButton
                      size="sm"
                      label={t('runs.detail.copyDetails')}
                      value={JSON.stringify({ lauf: run.id, node: sel.name, typ: selLast.node_type, klasse: selError.klasse, meldung: selError.meldung, technisch: selError.technisch, korrelation: run.correlation_id }, null, 2)}
                    />
                  }
                >
                  {selError.klasse_text && (
                    <span className="block">
                      {t('runs.detail.errorClass')}: {selError.klasse_text}
                    </span>
                  )}
                  {selError.hinweis && (
                    <span className="block mt-1">
                      {t('runs.detail.hint')}: {selError.hinweis}
                    </span>
                  )}
                </ErrorBox>
                <div className="flex flex-col gap-1.5">
                  <span className="text-meta text-fg-muted">{t('runs.detail.attemptList')}</span>
                  <ol className="m-0 p-0 list-none flex flex-col border border-line rounded-node">
                    {sel.attempts.map((a) => (
                      <li key={a.id} className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 border-b border-line last:border-b-0 text-sm">
                        <span className="font-mono text-meta text-fg-muted">{t('runs.detail.attempt', { n: a.attempt })}</span>
                        <span className="font-mono text-meta tabular">{fmtDateTime(a.started_at, { seconds: true }).split(', ')[1]}</span>
                        <span className={cx('min-w-0 truncate', a.status === 'error' ? 'text-err' : 'text-fg-muted')} title={a.status_text ?? a.error?.meldung ?? undefined}>
                          {t(`runs.stepStatus.${a.status}`)}
                          {a.status_text || a.error?.meldung ? ` · ${a.status_text ?? a.error?.meldung}` : ''}
                        </span>
                        <span className="font-mono text-meta tabular text-fg-muted">{fmtDuration(a.duration_ms)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                {idemNote}
              </>
            ) : (
              <>
                <p className="m-0 flex items-center gap-1.5 text-meta text-fg-muted">
                  <Icon name="Lock" size={13} /> {t('runs.detail.masked')}
                </p>
                {curTab === 'in' ? (
                  inputData.value === undefined ? (
                    <p className="m-0 text-sm text-fg-muted">{t('runs.detail.noData')}</p>
                  ) : (
                    <>
                      {inputData.note && <p className="m-0 text-meta text-fg-muted">{inputData.note}</p>}
                      <JsonView value={inputData.value} className="max-h-[420px]" />
                    </>
                  )
                ) : selLast.output_preview == null ? (
                  <p className="m-0 text-sm text-fg-muted">{t('runs.detail.noData')}</p>
                ) : (
                  <JsonView value={selLast.output_preview} className="max-h-[420px]" />
                )}
                {selLast.status_text && curTab === 'out' && <p className="m-0 text-meta text-fg-muted">{selLast.status_text}</p>}
              </>
            )}
          </div>
        </section>
      )}

      {/* Verknüpfte Läufe / Ereignis */}
      {(run.parent_run_id || run.children.length > 0 || run.event) && (
        <section aria-labelledby="run-linked" className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-3">
          <h3 id="run-linked" className="m-0 text-section font-semibold">
            {t('runs.detail.linked')}
          </h3>
          <dl className="m-0 grid grid-cols-[minmax(140px,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            {run.parent_run_id && (
              <>
                <dt className="text-fg-muted">{t('runs.detail.parent')}</dt>
                <dd className="m-0">
                  <Link to={`/ausfuehrungen/${run.parent_run_id}`} className="font-mono">
                    #{run.parent_run_id}
                  </Link>
                  {run.replay_kind && <span className="text-fg-muted"> · {run.replay_kind === 'full' ? t('runs.detail.replayKindFull') : t('runs.detail.replayKindFromFailed')}</span>}
                </dd>
              </>
            )}
            {run.children.length > 0 && (
              <>
                <dt className="text-fg-muted">{t('runs.detail.children')}</dt>
                <dd className="m-0 flex flex-col gap-1.5">
                  {run.children.map((c) => (
                    <span key={c.id} className="flex items-center gap-2 flex-wrap">
                      <Link to={`/ausfuehrungen/${c.id}`} className="font-mono">
                        #{c.id}
                      </Link>
                      <StatusBadge status={c.status} />
                      <span className="text-meta text-fg-muted">
                        {c.replay_kind === 'full' ? t('runs.detail.replayKindFull') : t('runs.detail.replayKindFromFailed')} · {fmtRelative(c.created_at)}
                      </span>
                    </span>
                  ))}
                </dd>
              </>
            )}
            {run.event && (
              <>
                <dt className="text-fg-muted">{t('runs.detail.event')}</dt>
                <dd className="m-0">
                  <span className="font-mono text-meta">{t('runs.detail.eventInfo', { id: run.event.id, source: run.event.source, when: fmtRelative(run.event.received_at) })}</span>
                  {run.event.duplicate && (
                    <Badge tone="warning" className="ml-2">
                      {t('runs.detail.eventDuplicate')}
                    </Badge>
                  )}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t('runs.detail.confirmTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('runs.detail.confirmCancel')}
            </Button>
            <Button variant="danger" icon="RotateCcw" disabled={!confirmed} loading={!!busy} onClick={() => confirm && doReplay(confirm.kind, true)}>
              {t('runs.detail.confirmSubmit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Notice tone="warning" title={confirm?.warning} />
          <p className="m-0 text-sm text-fg-muted">{confirm?.kind === 'full' ? t('runs.detail.fullExplain') : t('runs.detail.fromFailedExplain')}</p>
          <label className="flex items-start gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--ll-primary-solid)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>{t('runs.detail.confirmCheck')}</span>
          </label>
        </div>
      </Dialog>
    </>
  );
}

function Metric({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <dt className="text-meta text-fg-muted">{label}</dt>
      <dd className={cx('m-0 text-sm min-w-0 break-words', mono && 'font-mono tabular')}>{value}</dd>
    </div>
  );
}


