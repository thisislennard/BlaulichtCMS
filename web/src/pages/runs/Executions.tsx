import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api/client';
import { Button, Chip, cx, EmptyState, ErrorBox, Input, Select, SkeletonRows } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { fmtDuration, fmtNumber } from '../../lib/format';
import { ACTIVE_RUN, fmtWhen, runLabel, StatusDot, triggerInfo } from './runShared';
import { RunDetail } from './RunDetail';

export interface RunListItem {
  id: number;
  workflow_id: string;
  workflow_name: string;
  version_number: number | null;
  mode: 'production' | 'test';
  simulate: boolean;
  trigger_kind: string;
  trigger_label: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  summary: string;
  parent_run_id: number | null;
  replay_kind: string | null;
}

interface RunsPage {
  runs: RunListItem[];
  counts: { error: number; running: number; success: number; all: number };
  nextBefore: number | null;
}

type StatusFilter = 'all' | 'error' | 'running' | 'success';
type ModeFilter = 'all' | 'production' | 'test';

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

export default function Executions() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const workflowId = params.get('workflow') ?? undefined;
  const [status, setStatus] = useState<StatusFilter>('all');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const catalog = useCatalog().data;
  const workflows = useQuery<{ id: string; name: string }[]>({ queryKey: ['workflows'], queryFn: () => get('/workflows'), staleTime: 30_000, enabled: !!workflowId });
  const suffix = params.toString() ? `?${params.toString()}` : '';

  const list = useInfiniteQuery({
    queryKey: ['runs', { status, mode, q, workflowId }],
    queryFn: ({ pageParam }) => get<RunsPage>(`/runs${qs({ status, mode, q, workflowId, before: pageParam, limit: 40 })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.runs.some((r) => ACTIVE_RUN.includes(r.status))) ? 3000 : 15_000),
  });
  const runs = list.data?.pages.flatMap((p) => p.runs) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const selectedId = runId ? Number(runId) : null;

  // Breite Ansicht: ohne Auswahl automatisch den neuesten Lauf öffnen
  useEffect(() => {
    if (selectedId || !runs.length) return;
    if (window.matchMedia('(min-width: 1024px)').matches) navigate(`/ausfuehrungen/${runs[0].id}${suffix}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, runs[0]?.id]);

  const filtered = status !== 'all' || mode !== 'all' || !!q || !!workflowId;
  const wfName = workflowId ? (workflows.data?.find((w) => w.id === workflowId)?.name ?? runs.find((r) => r.workflow_id === workflowId)?.workflow_name ?? '…') : '';

  const chips: { value: StatusFilter; label: string; n?: number }[] = [
    { value: 'all', label: t('runs.list.all'), n: counts?.all },
    { value: 'error', label: t('runs.list.error'), n: counts?.error },
    { value: 'running', label: t('runs.list.running'), n: counts?.running },
    { value: 'success', label: t('runs.list.success'), n: counts?.success },
  ];

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] gap-5 items-start">
      <section aria-label={t('runs.list.label')} className={cx('bg-card border border-line rounded-card flex flex-col min-w-0 w-full lg:sticky lg:top-4', !!selectedId && 'hidden lg:flex')}>
        <div className="flex flex-col gap-2.5 p-3 border-b border-line">
          <label className="relative">
            <span className="sr-only">{t('runs.list.searchLabel')}</span>
            <Icon name="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('runs.list.search')} className="!h-ctl pl-9" />
          </label>
          <div role="group" aria-label={t('runs.list.status')} className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={status === c.value}
                onClick={() => setStatus(c.value)}
                className={cx('h-7 px-2.5 rounded-full border text-meta font-medium inline-flex items-center gap-1.5 transition-colors duration-fast', status === c.value ? 'border-primary bg-primary-soft text-fg' : 'border-line text-fg-muted hover:text-fg hover:bg-raised')}
              >
                {c.label}
                {c.n != null && <span className="tabular text-fg-muted">{fmtNumber(c.n)}</span>}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <div className="flex-1 min-w-[140px]">
              <Select aria-label={t('runs.list.mode')} value={mode} onChange={(e) => setMode(e.target.value as ModeFilter)} className="!h-ctl-sm text-sm">
                <option value="all">{t('runs.list.modeAll')}</option>
                <option value="production">{t('runs.list.modeProduction')}</option>
                <option value="test">{t('runs.list.modeTest')}</option>
              </Select>
            </div>
            {workflowId && (
              <span className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-primary-soft text-meta text-fg max-w-full">
                <span className="truncate">{t('runs.list.workflowFilter', { name: wfName })}</span>
                <button
                  type="button"
                  aria-label={t('runs.list.workflowFilterRemove')}
                  className="w-5 h-5 inline-flex items-center justify-center rounded-full hover:bg-raised text-fg-muted hover:text-fg"
                  onClick={() => {
                    const p = new URLSearchParams(params);
                    p.delete('workflow');
                    setParams(p, { replace: true });
                  }}
                >
                  <Icon name="X" size={12} />
                </button>
              </span>
            )}
          </div>
        </div>

        {list.isError ? (
          <div className="p-3">
            <ErrorBox
              title={t('runs.list.errorTitle')}
              actions={
                <Button size="sm" icon="RefreshCw" onClick={() => list.refetch()}>
                  {t('runs.list.retry')}
                </Button>
              }
            >
              {t('runs.list.errorText')}
            </ErrorBox>
          </div>
        ) : list.isLoading ? (
          <SkeletonRows rows={8} className="p-3" />
        ) : !runs.length ? (
          filtered ? (
            <EmptyState
              icon="Search"
              title={t('runs.list.emptyFilterTitle')}
              text={t('runs.list.emptyFilterText')}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setStatus('all');
                    setMode('all');
                    setSearch('');
                    const p = new URLSearchParams(params);
                    p.delete('workflow');
                    setParams(p, { replace: true });
                  }}
                >
                  {t('runs.list.reset')}
                </Button>
              }
            />
          ) : (
            <EmptyState icon="History" title={t('runs.list.emptyTitle')} text={t('runs.list.emptyText')} />
          )
        ) : (
          <>
            <ul className="m-0 p-1.5 list-none flex flex-col gap-0.5 lg:max-h-[calc(100vh-300px)] lg:overflow-y-auto">
              {runs.map((r) => {
                const on = r.id === selectedId;
                const tr = triggerInfo(catalog, r.trigger_kind);
                return (
                  <li key={r.id}>
                    <Link
                      to={`/ausfuehrungen/${r.id}${suffix}`}
                      aria-current={on ? 'true' : undefined}
                      className={cx('flex items-start gap-2.5 px-2.5 py-2.5 rounded-control !text-fg transition-colors duration-fast', on ? 'bg-primary-soft' : 'hover:bg-raised')}
                    >
                      <StatusDot status={r.status} className="mt-1.5" />
                      <span className="flex flex-col min-w-0 flex-1 gap-0.5">
                        <span className="text-sm font-medium truncate">{r.workflow_name}</span>
                        <span className="text-meta text-fg-muted truncate">
                          <span className="font-mono">#{r.id}</span> · <Icon name={tr.icon} size={12} className="inline -mt-0.5" /> {r.trigger_label || tr.title} · {runLabel(r.status)}
                        </span>
                        {r.mode === 'test' && (
                          <span className="flex">
                            <Chip className={cx('!h-[18px] !px-1.5 !text-[11px] border border-dashed', r.simulate ? 'border-cyan/60 text-cyan' : 'border-warn/60 text-warn')}>
                              <Icon name="FlaskConical" size={11} />
                              {t('runs.list.test')}
                              {r.simulate ? ` · ${t('runs.list.simulated')}` : ''}
                            </Chip>
                          </span>
                        )}
                      </span>
                      <span className="flex flex-col items-end gap-0.5 font-mono text-meta text-fg-muted tabular shrink-0">
                        <span>{fmtWhen(r.created_at, true)}</span>
                        <span>{ACTIVE_RUN.includes(r.status) ? '…' : fmtDuration(r.duration_ms)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {list.hasNextPage && (
              <div className="px-3 pb-3">
                <Button size="sm" className="w-full" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                  {t('runs.list.more')}
                </Button>
              </div>
            )}
          </>
        )}
        {counts && <div className="px-4 py-2.5 border-t border-line text-meta text-fg-muted">{t('runs.list.footer', { n: fmtNumber(counts.all) })}</div>}
      </section>

      <section aria-label={t('runs.detail.label')} className={cx('min-w-0 w-full flex flex-col gap-4', !!!selectedId && 'hidden lg:flex')}>
        {selectedId ? (
          <>
            <div className="lg:hidden">
              <Link to={`/ausfuehrungen${suffix}`} className="inline-flex items-center gap-1.5 text-sm">
                <Icon name="ArrowLeft" size={15} /> {t('runs.detail.back')}
              </Link>
            </div>
            <RunDetail key={selectedId} id={selectedId} />
          </>
        ) : (
          <div className="bg-card border border-line rounded-card">
            <EmptyState icon="MousePointerClick" title={t('runs.detail.selectTitle')} text={t('runs.detail.selectText')} />
          </div>
        )}
      </section>
    </div>
  );
}
