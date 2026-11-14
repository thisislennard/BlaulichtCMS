import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Button, Chip, EmptyState, ErrorBox, Monogram, Notice, PageHeader, SegmentedControl, Skeleton } from '../../components/ui/core';
import { CopyButton } from '../../components/ui/overlays';
import { NodeIcon } from '../../components/ui/data';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { NewWorkflowDialog } from './NewWorkflowDialog';
import type { WorkflowRow } from './WorkflowList';

interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  connectors: string[];
  nodes: { type: string; name: string }[];
}

export default function Templates() {
  const { can } = useAuth();
  const q = useQuery<Template[]>({ queryKey: ['workflow-templates'], queryFn: () => get('/workflow-templates'), staleTime: 5 * 60_000 });
  const wf = useQuery<WorkflowRow[]>({ queryKey: ['workflows'], queryFn: () => get('/workflows'), staleTime: 30_000 });
  const catalog = useCatalog().data;
  const [cat, setCat] = useState('all');
  const [use, setUse] = useState<Template | null>(null);
  const folders = useMemo(() => [...new Set((wf.data ?? []).map((w) => w.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [wf.data]);
  const categories = useMemo(() => [...new Set((q.data ?? []).map((x) => x.category))], [q.data]);
  const list = (q.data ?? []).filter((x) => cat === 'all' || x.category === cat);
  const canEdit = can('workflow.edit');

  return (
    <>
      <PageHeader title={t('workflows.templates.title')} subtitle={t('workflows.templates.subtitle')} />
      <Notice tone="primary" icon="Info">
        {t('workflows.templates.notice')}
      </Notice>
      {!canEdit && (
        <Notice tone="warning" icon="Lock">
          {t('workflows.templates.noEdit')}
        </Notice>
      )}
      {categories.length > 1 && (
        <div>
          <SegmentedControl
            label={t('workflows.templates.categories')}
            value={cat}
            onChange={setCat}
            options={[{ value: 'all', label: t('workflows.templates.all'), count: q.data?.length }, ...categories.map((c) => ({ value: c, label: c, count: q.data!.filter((x) => x.category === c).length }))]}
          />
        </div>
      )}

      {q.isError ? (
        <ErrorBox
          title={t('workflows.templates.errorTitle')}
          actions={
            <>
              <Button size="sm" icon="RefreshCw" onClick={() => q.refetch()}>
                {t('workflows.templates.retry')}
              </Button>
              <CopyButton size="sm" value={String((q.error as Error)?.message)} label={t('workflows.details')} />
            </>
          }
        >
          {t('workflows.templates.errorText')}
        </ErrorBox>
      ) : !q.data ? (
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[240px] !rounded-card" />
          ))}
        </div>
      ) : !list.length ? (
        <EmptyState icon="LayoutTemplate" title={t('workflows.templates.emptyTitle')} text={t('workflows.templates.emptyText')} />
      ) : (
        <ul className="m-0 p-0 list-none grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
          {list.map((tp) => (
            <li key={tp.id} className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-3.5 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <h3 className="m-0 text-section font-semibold">{tp.name}</h3>
                <Chip className="shrink-0">{tp.category}</Chip>
              </div>
              <p className="m-0 text-sm text-fg-muted flex-1">{tp.description}</p>

              <div className="flex flex-col gap-1.5">
                <span className="text-meta text-fg-muted">{t('workflows.templates.needs')}</span>
                <ul className="m-0 p-0 list-none flex flex-wrap gap-2">
                  {tp.connectors.map((c) => {
                    const info = catalog?.connectors.find((x) => x.id === c);
                    return (
                      <li key={c} className="inline-flex items-center gap-1.5 text-sm">
                        <Monogram text={info?.monogram ?? c.slice(0, 2).toUpperCase()} color={info?.color ?? 'var(--ll-text-2)'} size={24} />
                        {info?.name ?? c}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-meta text-fg-muted">{t('workflows.templates.flow')}</span>
                <ol className="m-0 p-0 list-none flex flex-wrap items-center gap-1">
                  {tp.nodes.map((n, i) => {
                    const nt = catalog?.nodes.find((x) => x.type === n.type);
                    return (
                      <Fragment key={i}>
                        {i > 0 && (
                          <li aria-hidden="true" className="text-fg-muted">
                            <Icon name="ChevronRight" size={14} />
                          </li>
                        )}
                        <li className="inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-chip bg-raised text-meta max-w-full" title={nt?.title}>
                          {nt ? <NodeIcon icon={nt.icon} category={nt.category} size={20} /> : <Icon name="Box" size={14} />}
                          <span className="truncate">{n.name}</span>
                        </li>
                      </Fragment>
                    );
                  })}
                </ol>
              </div>

              <div className="flex justify-end pt-1">
                <Button variant={canEdit ? 'primary' : 'secondary'} size="sm" icon="Plus" disabled={!canEdit} title={!canEdit ? t('workflows.templates.noEdit') : undefined} onClick={() => setUse(tp)}>
                  {t('workflows.templates.use')}
                  <span className="sr-only">: {tp.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <NewWorkflowDialog
        open={!!use}
        onClose={() => setUse(null)}
        folders={folders}
        templateId={use?.id}
        defaultName={use?.name ?? ''}
        title={use ? t('workflows.templates.useTitle', { name: use.name }) : undefined}
        footerHint={
          <Notice tone="primary" icon="Plug">
            {t('workflows.templates.notice')}
          </Notice>
        }
      />
    </>
  );
}
