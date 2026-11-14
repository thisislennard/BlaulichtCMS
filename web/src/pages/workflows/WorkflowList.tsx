import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, download, get, post } from '../../api/client';
import { Badge, Button, Chip, cx, EmptyState, ErrorBox, Input, LinkButton, PageHeader, Select, Skeleton, SkeletonRows, Textarea, type Tone } from '../../components/ui/core';
import { CopyButton, DeleteDialog, Dialog, Menu, useErrorToast, useToast } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNumber, fmtPercent, fmtRelative } from '../../lib/format';
import { FAILED_RUN, runLabel, StatusDot, toneDot, runTone } from '../runs/runShared';
import { NewWorkflowDialog } from './NewWorkflowDialog';

export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  folder: string;
  status: 'active' | 'inactive' | 'archived';
  draft_updated_at: string;
  created_at: string;
  active_version_id: string | null;
  active_version: number | null;
  published_at: string | null;
  latest_version: number | null;
  pending_approvals: number;
  last_run_at: string | null;
  last_status: string | null;
  runs_30d: number | null;
  ok_30d: number | null;
  recent: string[] | null;
  success_rate: number | null;
  connectors: string[];
  trigger: string | null;
}

interface WorkflowDetail {
  id: string;
  versions: { id: string; number: number; state: string; change_note: string; requested_at: string; approved_at: string | null; requested_by_name: string | null; approved_by_name: string | null; active: boolean }[];
}

type DerivedStatus = 'active' | 'inactive' | 'draft' | 'archived';
type FolderSel = 'all' | 'none' | 'archive' | `f:${string}`;
type SortKey = 'name' | 'last' | 'rate' | 'changed';

export function derivedStatus(w: WorkflowRow): DerivedStatus {
  if (w.status === 'archived') return 'archived';
  if (!w.active_version_id) return 'draft';
  return w.status;
}

const STATUS_TONE: Record<DerivedStatus, Tone> = { active: 'success', inactive: 'neutral', draft: 'primary', archived: 'neutral' };

function WorkflowStatus({ w }: { w: WorkflowRow }) {
  const s = derivedStatus(w);
  const failing = s === 'active' && !!w.last_status && FAILED_RUN.includes(w.last_status);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {failing ? (
        <Badge tone="error" title={t('workflows.status.failingHint')}>
          {t('workflows.status.failing')}
        </Badge>
      ) : (
        <Badge tone={STATUS_TONE[s]}>{t(`workflows.status.${s}`)}</Badge>
      )}
      {w.pending_approvals > 0 && (
        <Badge tone="warning" title={t('workflows.status.approvalHint')}>
          {t('workflows.status.approval')}
        </Badge>
      )}
    </span>
  );
}

function RateBar({ w }: { w: WorkflowRow }) {
  if (w.success_rate == null) return <span className="text-fg-muted">–</span>;
  const r = w.success_rate;
  const color = r >= 97 ? 'bg-ok' : r >= 90 ? 'bg-warn' : 'bg-err';
  return (
    <span className="inline-flex items-center gap-2" title={t('workflows.rateTitle', { ok: w.ok_30d ?? 0, n: w.runs_30d ?? 0 })}>
      <span aria-hidden="true" className="w-10 h-1.5 rounded-full bg-raised overflow-hidden shrink-0">
        <span className={cx('block h-full rounded-full', color)} style={{ width: `${Math.max(2, r)}%` }} />
      </span>
      <span className="font-mono text-meta tabular whitespace-nowrap">{fmtPercent(r)}</span>
    </span>
  );
}

export default function WorkflowList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const [params, setParams] = useSearchParams();
  const catalog = useCatalog().data;
  const q = useQuery<WorkflowRow[]>({ queryKey: ['workflows', 'mitArchiv'], queryFn: () => get('/workflows?archived=true'), refetchInterval: 60_000 });
  const all = q.data ?? [];

  const [folder, setFolder] = useState<FolderSel>('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | DerivedStatus | 'failing' | 'approval'>('all');
  const [connector, setConnector] = useState('all');
  const [sort, setSort] = useState<SortKey>('name');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const createOpen = params.get('neu') === '1';
  const setCreateOpen = (v: boolean) => {
    const p = new URLSearchParams(params);
    if (v) p.set('neu', '1');
    else p.delete('neu');
    setParams(p, { replace: true });
  };

  const live = all.filter((w) => w.status !== 'archived');
  const folders = useMemo(() => [...new Set(live.map((w) => w.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [live]);
  const connName = (id: string) => catalog?.connectors.find((c) => c.id === id)?.name ?? id;
  const usedConnectors = useMemo(() => [...new Set(all.flatMap((w) => w.connectors))].sort(), [all]);

  const inFolder = all.filter((w) => {
    if (folder === 'archive') return w.status === 'archived';
    if (w.status === 'archived') return false;
    if (folder === 'all') return true;
    if (folder === 'none') return !w.folder;
    return w.folder === folder.slice(2);
  });
  const needle = search.trim().toLowerCase();
  const rows = inFolder
    .filter((w) => !needle || w.name.toLowerCase().includes(needle) || w.description.toLowerCase().includes(needle) || (w.trigger ?? '').toLowerCase().includes(needle))
    .filter((w) => {
      if (status === 'all') return true;
      if (status === 'approval') return w.pending_approvals > 0;
      if (status === 'failing') return derivedStatus(w) === 'active' && !!w.last_status && FAILED_RUN.includes(w.last_status);
      return derivedStatus(w) === status;
    })
    .filter((w) => connector === 'all' || w.connectors.includes(connector))
    .sort((a, b) => {
      if (sort === 'last') return (b.last_run_at ?? '').localeCompare(a.last_run_at ?? '');
      if (sort === 'rate') return (a.success_rate ?? 101) - (b.success_rate ?? 101);
      if (sort === 'changed') return b.draft_updated_at.localeCompare(a.draft_updated_at);
      return a.name.localeCompare(b.name, 'de');
    });
  const filtered = !!needle || status !== 'all' || connector !== 'all';

  const selected = all.find((w) => w.id === selectedId) ?? null;
  useEffect(() => {
    if (!q.data) return;
    if (!selectedId || !rows.some((r) => r.id === selectedId)) setSelectedId(rows[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, folder, search, status, connector]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['workflows'] });

  const setWfStatus = async (w: WorkflowRow, next: 'active' | 'inactive' | 'archived', undoable = true) => {
    try {
      const res = await post<{ ok: boolean; previous: 'active' | 'inactive' | 'archived' }>(`/workflows/${w.id}/status`, { status: next });
      await refresh();
      const key = next === 'inactive' && w.status === 'archived' ? 'restored' : next;
      toast({
        tone: 'success',
        title: t(`workflows.toast.${key}`, { name: w.name }),
        action: undoable
          ? {
              label: t('workflows.toast.undo'),
              onClick: async () => {
                try {
                  await post(`/workflows/${w.id}/status`, { status: res.previous });
                  await refresh();
                  toast({ tone: 'info', title: t('workflows.toast.undone') });
                } catch (e) {
                  errToast(e, t('workflows.toast.statusFailed'));
                }
              },
            }
          : undefined,
      });
    } catch (e) {
      errToast(e, t('workflows.toast.statusFailed'));
    }
  };

  const duplicate = async (w: WorkflowRow) => {
    try {
      const c = await post<{ id: string; name: string }>(`/workflows/${w.id}/duplicate`);
      await refresh();
      setSelectedId(c.id);
      toast({ tone: 'success', title: t('workflows.toast.duplicated'), text: t('workflows.toast.duplicatedText', { name: c.name }), action: { label: t('workflows.detail.open'), onClick: () => navigate(`/workflows/${c.id}`) } });
    } catch (e) {
      errToast(e);
    }
  };

  const onImport = async (file: File) => {
    try {
      let obj: any;
      try {
        obj = JSON.parse(await file.text());
      } catch {
        throw new Error(t('workflows.toast.importInvalid'));
      }
      if (!obj || typeof obj !== 'object' || !obj.graph || !Array.isArray(obj.graph.nodes) || !Array.isArray(obj.graph.edges)) throw new Error(t('workflows.toast.importInvalid'));
      const name = String(obj.name || file.name.replace(/\.json$/i, '')).slice(0, 120);
      const w = await post<{ id: string }>('/workflows', { name, description: String(obj.description ?? '').slice(0, 1000), folder: String(obj.folder ?? '').slice(0, 80), graph: obj.graph });
      await refresh();
      toast({ tone: 'success', title: t('workflows.toast.imported'), text: name });
      navigate(`/workflows/${w.id}`);
    } catch (e) {
      errToast(e, t('workflows.toast.importFailed'));
    }
  };

  const activeCount = live.filter((w) => w.status === 'active').length;
  const folderItems: { id: FolderSel; label: string; n: number; icon: string }[] = [
    { id: 'all', label: t('workflows.folders.all'), n: live.length, icon: 'Workflow' },
    ...folders.map((f) => ({ id: `f:${f}` as FolderSel, label: f, n: live.filter((w) => w.folder === f).length, icon: 'FolderOpen' })),
    ...(live.some((w) => !w.folder) && folders.length ? [{ id: 'none' as FolderSel, label: t('workflows.folders.none'), n: live.filter((w) => !w.folder).length, icon: 'Inbox' }] : []),
    { id: 'archive', label: t('workflows.folders.archive'), n: all.length - live.length, icon: 'Archive' },
  ];

  return (
    <>
      <PageHeader
        title={t('workflows.title')}
        subtitle={q.data ? t('workflows.subtitle', { n: fmtNumber(live.length), f: fmtNumber(folders.length), a: fmtNumber(activeCount) }) : undefined}
        actions={
          can('workflow.edit') ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onImport(f);
                }}
              />
              <Button icon="Upload" onClick={() => fileRef.current?.click()}>
                {t('workflows.import')}
              </Button>
              <LinkButton to="/vorlagen" icon="LayoutTemplate">
                {t('workflows.fromTemplate')}
              </LinkButton>
              <Button variant="primary" icon="Plus" onClick={() => setCreateOpen(true)}>
                {t('workflows.new')}
              </Button>
            </>
          ) : undefined
        }
      >
        {!q.data && !q.isError && <Skeleton className="h-4 w-56 mt-1" />}
      </PageHeader>

      {q.isError ? (
        <ErrorBox
          title={t('workflows.errorTitle')}
          actions={
            <>
              <Button size="sm" icon="RefreshCw" onClick={() => q.refetch()}>
                {t('workflows.retry')}
              </Button>
              <CopyButton size="sm" value={String((q.error as Error)?.message)} label={t('workflows.details')} />
            </>
          }
        >
          {t('workflows.errorText')}
        </ErrorBox>
      ) : (
        <div className="grid gap-5 items-start xl:grid-cols-[180px_minmax(0,1fr)_340px] 2xl:grid-cols-[200px_minmax(0,1fr)_380px]">
          {/* Ordner */}
          <nav aria-label={t('workflows.folders.label')} className="flex xl:flex-col gap-1 overflow-x-auto xl:overflow-visible -mx-1 px-1 pb-1 xl:pb-0">
            <div className="hidden xl:block text-label uppercase text-fg-muted px-2.5 pb-1.5">{t('workflows.folders.label')}</div>
            {!q.data
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-9 min-w-[120px]" />)
              : folderItems.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={folder === f.id}
                    onClick={() => setFolder(f.id)}
                    className={cx(
                      'flex items-center gap-2 h-9 px-2.5 rounded-control text-sm text-left whitespace-nowrap shrink-0 transition-colors duration-fast',
                      folder === f.id ? 'bg-primary-soft text-fg font-medium' : 'text-fg-muted hover:bg-raised hover:text-fg',
                      f.id === 'archive' && 'xl:mt-2',
                    )}
                  >
                    <Icon name={f.icon} size={15} className="shrink-0" />
                    <span className="flex-1 truncate">{f.label}</span>
                    <span className="text-meta tabular text-fg-muted">{f.n}</span>
                  </button>
                ))}
          </nav>

          {/* Tabelle */}
          <section aria-label={t('workflows.title')} className="bg-card border border-line rounded-card min-w-0 flex flex-col">
            <div className="flex flex-wrap gap-2 p-3 border-b border-line">
              <label className="relative flex-[1_1_220px] min-w-0">
                <span className="sr-only">{t('workflows.filter.search')}</span>
                <Icon name="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('workflows.filter.search')} className="!h-ctl pl-9" />
              </label>
              <div className="flex-[1_1_150px] min-w-[150px]">
                <Select aria-label={t('workflows.filter.status')} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="!h-ctl">
                  <option value="all">{t('workflows.filter.statusAll')}</option>
                  <option value="active">{t('workflows.status.active')}</option>
                  <option value="inactive">{t('workflows.status.inactive')}</option>
                  <option value="draft">{t('workflows.status.draft')}</option>
                  <option value="failing">{t('workflows.status.failing')}</option>
                  <option value="approval">{t('workflows.status.approval')}</option>
                </Select>
              </div>
              <div className="flex-[1_1_170px] min-w-[150px]">
                <Select aria-label={t('workflows.filter.connector')} value={connector} onChange={(e) => setConnector(e.target.value)} className="!h-ctl">
                  <option value="all">{t('workflows.filter.connectorAll')}</option>
                  {usedConnectors.map((c) => (
                    <option key={c} value={c}>
                      {connName(c)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex-[1_1_200px] min-w-[150px]">
                <Select aria-label={t('workflows.filter.sort')} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="!h-ctl">
                  <option value="name">{t('workflows.filter.sortName')}</option>
                  <option value="last">{t('workflows.filter.sortLast')}</option>
                  <option value="rate">{t('workflows.filter.sortRate')}</option>
                  <option value="changed">{t('workflows.filter.sortChanged')}</option>
                </Select>
              </div>
            </div>
            {!q.data ? (
              <SkeletonRows rows={6} className="p-3" />
            ) : !rows.length ? (
              filtered ? (
                <EmptyState
                  icon="Search"
                  title={t('workflows.emptyFilterTitle')}
                  text={t('workflows.emptyFilterText')}
                  action={
                    <Button
                      size="sm"
                      onClick={() => {
                        setSearch('');
                        setStatus('all');
                        setConnector('all');
                      }}
                    >
                      {t('workflows.filter.reset')}
                    </Button>
                  }
                />
              ) : folder === 'archive' ? (
                <EmptyState icon="Archive" title={t('workflows.emptyArchiveTitle')} text={t('workflows.emptyArchiveText')} />
              ) : (
                <EmptyState
                  icon="Workflow"
                  title={t('workflows.emptyTitle')}
                  text={t('workflows.emptyText')}
                  action={
                    can('workflow.edit') ? (
                      <Button variant="primary" size="sm" icon="Plus" onClick={() => setCreateOpen(true)}>
                        {t('workflows.new')}
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full border-collapse text-sm min-w-[780px] xl:min-w-[540px] 2xl:min-w-[780px] table-fixed">
                  <colgroup>
                    <col />
                    <col className="w-[120px]" />
                    <col className="w-[108px]" />
                    <col className="w-[120px]" />
                    <col className="w-[210px] xl:w-0 2xl:w-[210px]" />
                  </colgroup>
                  <thead>
                    <tr>
                      {[t('workflows.col.name'), t('workflows.col.status'), t('workflows.col.last'), t('workflows.col.rate'), t('workflows.col.connectors')].map((h, i) => (
                        <th key={h} scope="col" className={cx('text-meta font-medium text-fg-muted py-2.5 px-3 first:pl-4 border-b border-line text-left whitespace-nowrap', i === 4 && 'xl:hidden 2xl:table-cell')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w) => {
                      const on = w.id === selectedId;
                      return (
                        <tr
                          key={w.id}
                          onClick={() => setSelectedId(w.id)}
                          onDoubleClick={() => navigate(`/workflows/${w.id}`)}
                          className={cx('cursor-pointer transition-colors duration-fast', on ? 'bg-primary-soft' : 'hover:bg-raised', w.status === 'archived' && 'opacity-70')}
                        >
                          <td className="py-2.5 px-3 pl-4 border-b border-line max-w-[360px]">
                            <button
                              type="button"
                              aria-pressed={on}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedId(w.id);
                                if (window.innerWidth < 1280) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                              }}
                              className="flex flex-col items-start text-left min-w-0 w-full rounded-chip"
                            >
                              <span className="font-medium truncate max-w-full">{w.name}</span>
                              {w.description && <span className="text-meta text-fg-muted truncate max-w-full">{w.description}</span>}
                              {w.connectors.length > 0 && (
                                <span className="hidden xl:block 2xl:hidden text-meta text-fg-muted truncate max-w-full">
                                  <span className="sr-only">{t('workflows.col.connectors')}: </span>
                                  {w.connectors.map(connName).join(' · ')}
                                </span>
                              )}
                            </button>
                          </td>
                          <td className="py-2.5 px-3 border-b border-line">
                            <WorkflowStatus w={w} />
                          </td>
                          <td className="py-2.5 px-3 border-b border-line whitespace-nowrap text-meta">
                            {w.last_run_at ? (
                              <span className="inline-flex items-center gap-1.5" title={`${fmtDateTime(w.last_run_at)} · ${runLabel(w.last_status ?? '')}`}>
                                <StatusDot status={w.last_status ?? ''} />
                                {fmtRelative(w.last_run_at)}
                                <span className="sr-only">· {runLabel(w.last_status ?? '')}</span>
                              </span>
                            ) : (
                              <span className="text-fg-muted">{t('workflows.never')}</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 border-b border-line">
                            <RateBar w={w} />
                          </td>
                          <td className="py-2.5 px-3 border-b border-line xl:hidden 2xl:table-cell">
                            <span className="flex flex-wrap gap-1">
                              {w.connectors.length ? w.connectors.map((c) => <Chip key={c}>{connName(c)}</Chip>) : <span className="text-fg-muted">–</span>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {q.data && rows.length > 0 && <div className="px-4 py-2.5 text-meta text-fg-muted">{t('workflows.shown', { n: rows.length, total: inFolder.length })}</div>}
          </section>

          {/* Detail */}
          <aside ref={detailRef} aria-label={t('workflows.detail.label')} className="bg-card border border-line rounded-card p-[18px] min-w-0 flex flex-col gap-[18px] scroll-mt-4">
            {!q.data ? (
              <SkeletonRows rows={5} />
            ) : !selected ? (
              <EmptyState icon="MousePointerClick" title={t('workflows.detail.none')} text={t('workflows.detail.noneText')} />
            ) : (
              <Detail
                w={selected}
                connName={connName}
                onStatus={setWfStatus}
                onDuplicate={duplicate}
                onDelete={() => setDeleteOpen(true)}
                canEdit={can('workflow.edit')}
                canPublish={can('workflow.publish')}
              />
            )}
          </aside>
        </div>
      )}

      <NewWorkflowDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        folders={folders}
        defaultFolder={folder.startsWith('f:') ? folder.slice(2) : ''}
        footerHint={
          <p className="m-0 text-meta text-fg-muted">
            {t('workflows.create.templateHint')} <Link to="/vorlagen">{t('workflows.create.templateLink')}</Link>
          </p>
        }
      />
      {selected && (
        <DeleteDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          objectType={t('workflows.deleteType')}
          name={selected.name}
          extra={<p className="m-0 text-fg-muted">{t('workflows.deleteExtra')}</p>}
          onConfirm={async (typed) => {
            await del(`/workflows/${selected.id}`, { confirm: typed });
            setSelectedId(null);
            await refresh();
            toast({ tone: 'success', title: t('workflows.toast.deleted'), text: selected.name });
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------ Detail ----------------------------------------- */

function Detail({
  w,
  connName,
  onStatus,
  onDuplicate,
  onDelete,
  canEdit,
  canPublish,
}: {
  w: WorkflowRow;
  connName: (id: string) => string;
  onStatus: (w: WorkflowRow, s: 'active' | 'inactive' | 'archived') => void;
  onDuplicate: (w: WorkflowRow) => void;
  onDelete: () => void;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const detail = useQuery<WorkflowDetail>({ queryKey: ['workflow', w.id], queryFn: () => get(`/workflows/${w.id}`), staleTime: 15_000 });
  const s = derivedStatus(w);
  const recent = [...(w.recent ?? [])].reverse();
  const tiles = [...Array.from({ length: Math.max(0, 30 - recent.length) }, () => null), ...recent.slice(-30)];
  const okCount = recent.filter((x) => x === 'success').length;
  const versions = detail.data?.versions ?? [];

  const menu = canPublish
    ? [
        s === 'active' && { label: t('workflows.detail.deactivate'), icon: 'PowerOff', onClick: () => onStatus(w, 'inactive') },
        (s === 'inactive' || s === 'draft') && { label: t('workflows.detail.activate'), icon: 'Power', onClick: () => onStatus(w, 'active'), disabled: s === 'draft', hint: s === 'draft' ? t('workflows.detail.activateHint') : undefined },
        s !== 'archived' && { label: t('workflows.detail.archive'), icon: 'Archive', onClick: () => onStatus(w, 'archived') },
        s === 'archived' && { label: t('workflows.detail.restore'), icon: 'RotateCcw', onClick: () => onStatus(w, 'inactive') },
        { label: t('workflows.detail.delete'), icon: 'Trash2', onClick: onDelete, danger: true },
      ]
    : [];

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <WorkflowStatus w={w} />
          <span className="font-mono text-meta text-fg-muted">
            {w.active_version ? t(w.status === 'active' ? 'workflows.detail.versionActive' : 'workflows.detail.versionLive', { n: w.active_version }) : t('workflows.detail.notPublished')}
          </span>
        </div>
        <h3 className="m-0 text-title font-semibold break-words">{w.name}</h3>
        <p className={cx('m-0 text-sm break-words', w.description ? 'text-fg-muted' : 'text-fg-muted italic')}>{w.description || t('workflows.detail.noDescription')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <LinkButton to={`/workflows/${w.id}`} variant="primary" icon="Pencil" size="sm">
          {t('workflows.detail.open')}
        </LinkButton>
        {canEdit && (
          <Button size="sm" icon="Copy" onClick={() => onDuplicate(w)}>
            {t('workflows.detail.duplicate')}
          </Button>
        )}
        {w.status === 'active' && w.trigger === 'Manuell starten' && <ManualRunButton workflowId={w.id} />}
        <Button size="sm" icon="Download" onClick={() => download(`/workflows/${w.id}/export`)}>
          {t('workflows.detail.export')}
        </Button>
        {menu.length > 0 && <Menu size="sm" label={t('workflows.detail.more')} items={menu} />}
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex justify-between text-meta text-fg-muted">
          <span>{t('workflows.detail.history')}</span>
          <Link to={`/ausfuehrungen?workflow=${w.id}`}>{t('workflows.detail.historyLink')}</Link>
        </div>
        <div role="img" aria-label={recent.length ? t('workflows.detail.historyLabel', { ok: okCount, n: recent.length }) : t('workflows.detail.historyNone')} className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-[3px]">
          {tiles.map((st, i) => (
            <span key={i} title={st ? runLabel(st) : undefined} className={cx('h-[18px] rounded-[3px]', st ? toneDot(runTone(st)) : 'bg-raised', st === 'success' && 'opacity-75')} />
          ))}
        </div>
        {!recent.length && <span className="text-meta text-fg-muted">{t('workflows.detail.historyNone')}</span>}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 m-0 text-sm">
        <dt className="text-fg-muted">{t('workflows.detail.trigger')}</dt>
        <dd className="m-0 min-w-0 break-words">{w.trigger ?? t('workflows.detail.noTrigger')}</dd>
        <dt className="text-fg-muted">{t('workflows.detail.connectors')}</dt>
        <dd className="m-0 min-w-0 break-words">{w.connectors.length ? w.connectors.map(connName).join(', ') : t('workflows.detail.dash')}</dd>
        <dt className="text-fg-muted">{t('workflows.detail.runs30')}</dt>
        <dd className="m-0 tabular">{w.runs_30d ? `${fmtNumber(w.runs_30d)} · ${fmtPercent(w.success_rate)}` : t('workflows.detail.dash')}</dd>
        <dt className="text-fg-muted">{t('workflows.detail.folder')}</dt>
        <dd className="m-0 min-w-0 break-words">{w.folder || t('workflows.folders.none')}</dd>
        <dt className="text-fg-muted">{t('workflows.detail.changed')}</dt>
        <dd className="m-0">{fmtRelative(w.draft_updated_at)}</dd>
        {w.published_at && (
          <>
            <dt className="text-fg-muted">{t('workflows.detail.published')}</dt>
            <dd className="m-0">{fmtDateTime(w.published_at)}</dd>
          </>
        )}
        <dt className="text-fg-muted">{t('workflows.detail.created')}</dt>
        <dd className="m-0">{fmtDateTime(w.created_at)}</dd>
      </dl>

      <div className="flex flex-col gap-2">
        <span className="text-meta text-fg-muted">{t('workflows.detail.versions')}</span>
        {detail.isLoading ? (
          <SkeletonRows rows={2} />
        ) : !versions.length ? (
          <span className="text-meta text-fg-muted">{t('workflows.detail.versionsNone')}</span>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
            {versions.slice(0, 4).map((v) => (
              <li key={v.id} className="flex items-center gap-2.5 text-sm min-w-0">
                <span className={cx('font-mono text-meta px-1.5 h-5 inline-flex items-center rounded-[5px] shrink-0', v.active ? 'bg-primary-soft text-fg-link' : 'bg-raised text-fg-muted')}>v{v.number}</span>
                <span className="flex-1 min-w-0 truncate" title={v.change_note || undefined}>
                  {t(`workflows.versionState.${v.state}`)}
                  {v.change_note ? ` · ${v.change_note}` : ''}
                </span>
                <span className="text-meta text-fg-muted shrink-0">{fmtRelative(v.approved_at ?? v.requested_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Manuellen Workflow starten (nur aktive Version, Recht „Aktivieren & veröffentlichen“). */
function ManualRunButton({ workflowId }: { workflowId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!can('workflow.publish')) return null;
  const start = async () => {
    let data: unknown;
    try {
      data = text.trim() ? JSON.parse(text) : {};
    } catch {
      return setErr(t('workflows.manualRun.invalid'));
    }
    setBusy(true);
    setErr(null);
    try {
      const empty = !!data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data as object).length === 0;
      const r = await post<{ runId: number }>(`/workflows/${workflowId}/run`, empty ? {} : { data });
      setOpen(false);
      toast({ tone: 'success', title: t('workflows.manualRun.started', { id: r.runId }), action: { label: t('workflows.manualRun.open'), onClick: () => navigate(`/ausfuehrungen/${r.runId}`) } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" icon="Play" onClick={() => setOpen(true)}>
        {t('workflows.manualRun.button')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('workflows.manualRun.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('workflows.manualRun.cancel')}
            </Button>
            <Button variant="primary" icon="Play" loading={busy} onClick={start}>
              {t('workflows.manualRun.button')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sm text-fg-muted">{t('workflows.manualRun.help')}</p>
          <label className="text-sm font-medium" htmlFor="manual-data">
            {t('workflows.manualRun.data')}
          </label>
          <Textarea id="manual-data" mono rows={6} value={text} onChange={(e) => setText(e.target.value)} invalid={!!err} />
          {err && <p className="m-0 text-meta text-err">{err}</p>}
        </div>
      </Dialog>
    </>
  );
}
