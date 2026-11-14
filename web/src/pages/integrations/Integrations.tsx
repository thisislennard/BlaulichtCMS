import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import type { ConnectorInfo } from '../../api/types';
import { Badge, cx, EmptyState, ErrorBox, LinkButton, Monogram, PageHeader, SegmentedControl, Skeleton, type Tone } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { expiryNote, isConnectable, pl, useConnections, type ConnectionRow } from './shared';

type Filter = 'all' | 'on' | 'issue' | 'avail';
type CardState = 'ok' | 'warning' | 'error' | 'available' | 'noConnection';

interface CardModel {
  c: ConnectorInfo;
  conns: ConnectionRow[];
  state: CardState;
  note: { tone: 'warning' | 'error'; text: string } | null;
  workflows: number | null;
  cta: { label: string; to: string } | null;
}

const STATE_TONE: Record<CardState, Tone> = { ok: 'success', warning: 'warning', error: 'error', available: 'neutral', noConnection: 'primary' };

function buildCard(c: ConnectorInfo, all: ConnectionRow[], wfByConnector: Map<string, number> | null, canEdit: boolean): CardModel {
  const conns = all.filter((x) => x.connector === c.id);
  const active = conns.filter((x) => x.status !== 'disabled');
  const errored = active.find((x) => x.status === 'error');
  const warned = active.find((x) => x.status === 'warning');
  const expiring = active.map((x) => ({ x, n: expiryNote(x.credentials_expire_at) })).filter((e) => e.n);
  const expiredErr = expiring.find((e) => e.n!.tone === 'error');
  let state: CardState;
  let note: CardModel['note'] = null;
  let target: ConnectionRow | undefined;
  if (!conns.length) state = c.needsConnection ? 'available' : 'noConnection';
  else if (errored || expiredErr) {
    state = 'error';
    target = errored ?? expiredErr!.x;
    note = errored ? { tone: 'error', text: `${conns.length > 1 ? `${errored.name}: ` : ''}${errored.status_message ?? t('integrations.cards.errorNoMessage')}` } : { tone: 'error', text: expiredErr!.n!.text };
  } else if (warned || expiring.length) {
    state = 'warning';
    target = warned ?? expiring[0].x;
    note = warned ? { tone: 'warning', text: `${conns.length > 1 ? `${warned.name}: ` : ''}${warned.status_message ?? t('integrations.cards.warningNoMessage')}` } : { tone: 'warning', text: expiring[0].n!.text };
  } else state = 'ok';

  const workflows = wfByConnector ? (wfByConnector.get(c.id) ?? 0) : conns.length ? conns.reduce((a, x) => a + (x.workflow_count ?? 0), 0) : null;
  const detail = (x?: ConnectionRow) => (x ? `/verbindungen/${x.id}` : conns.length === 1 ? `/verbindungen/${conns[0].id}` : `/verbindungen?integration=${c.id}`);
  const wizard = `/schnittstellen/${c.id}/verbinden`;

  let cta: CardModel['cta'] = null;
  if (c.id === 'webhook') cta = { label: t('integrations.cards.ctaManage'), to: '/webhooks' };
  else if (state === 'error') cta = { label: t('integrations.cards.ctaError'), to: detail(target) };
  else if (state === 'warning') cta = { label: t('integrations.cards.ctaReauth'), to: detail(target) };
  else if (c.id === 'wordpress' && conns.length) cta = { label: t('integrations.cards.ctaManage'), to: '/wordpress' };
  else if (conns.length) cta = { label: t('integrations.cards.ctaConfigure'), to: detail() };
  else if (canEdit && isConnectable(c)) cta = { label: t('integrations.cards.ctaConnect'), to: wizard };
  return { c, conns, state, note, workflows, cta };
}

export default function Integrations() {
  const { can } = useAuth();
  const catalog = useCatalog();
  const connections = useConnections();
  const wf = useQuery<any[]>({ queryKey: ['workflows'], queryFn: () => get('/workflows'), enabled: can('workflow.read'), staleTime: 30_000 });
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const canEdit = can('connection.edit');

  const cards = useMemo(() => {
    if (!catalog.data || !connections.data) return [];
    let wfMap: Map<string, number> | null = null;
    if (wf.data) {
      wfMap = new Map();
      for (const w of wf.data) for (const id of (w.connectors ?? []) as string[]) wfMap.set(id, (wfMap.get(id) ?? 0) + 1);
    }
    return catalog.data.connectors.map((c) => buildCard(c, connections.data!, wfMap, canEdit));
  }, [catalog.data, connections.data, wf.data, canEdit]);

  const pass = (m: CardModel, f: Filter) => f === 'all' || (f === 'on' && m.conns.length > 0) || (f === 'issue' && (m.state === 'error' || m.state === 'warning')) || (f === 'avail' && m.conns.length === 0);
  const needle = q.trim().toLowerCase();
  const visible = cards.filter((m) => pass(m, filter) && (!needle || `${m.c.name} ${m.c.kind} ${m.c.description} ${m.c.group}`.toLowerCase().includes(needle)));
  const count = (f: Filter) => cards.filter((m) => pass(m, f)).length;

  const nConnected = connections.data?.filter((x) => x.status !== 'disabled').length ?? 0;
  const nWarn = cards.filter((m) => m.state === 'warning').length;
  const nErr = cards.filter((m) => m.state === 'error').length;
  const loading = catalog.isLoading || connections.isLoading;
  const error = catalog.error || connections.error;

  return (
    <>
      <PageHeader
        title={t('integrations.overview.title')}
        subtitle={loading ? t('integrations.common.loading') : `${pl(nConnected, 'integrations.overview.active')} · ${t('integrations.overview.subtitleIssues', { w: nWarn, e: nErr })}`}
        actions={canEdit && <LinkButton to="/schnittstellen/auswahl/verbinden" variant="primary" icon="Plus">{t('integrations.overview.connect')}</LinkButton>}
      />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SegmentedControl<Filter>
          label={t('integrations.overview.filterLabel')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('integrations.overview.filterAll'), count: count('all') },
            { value: 'on', label: t('integrations.overview.filterOn'), count: count('on') },
            { value: 'issue', label: t('integrations.overview.filterIssue'), count: count('issue') },
            { value: 'avail', label: t('integrations.overview.filterAvail'), count: count('avail') },
          ]}
        />
        <label className="flex items-center gap-2 h-[34px] px-2.5 border border-line rounded-control bg-card flex-[0_1_300px] min-w-[200px] text-fg-muted focus-within:border-primary focus-within:shadow-ring">
          <Icon name="Search" size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('integrations.overview.search')} placeholder={t('integrations.overview.search')} className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-fg placeholder:text-fg-muted" />
        </label>
      </div>

      {error ? (
        <ErrorBox title={t('integrations.overview.loadError')}>{(error as Error).message}</ErrorBox>
      ) : loading ? (
        <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(290px,1fr))]" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-3.5">
              <div className="flex gap-3 items-start">
                <Skeleton className="w-10 h-10 rounded-node" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-8 w-full mt-2" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 && filter !== 'all' && !needle ? (
        <EmptyState icon="Plug" title={t('integrations.overview.emptyFilterTitle')} text={t('integrations.overview.emptyFilterText')} />
      ) : (
        <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(290px,1fr))]">
          {visible.map((m) => (
            <IntegrationCard key={m.c.id} m={m} />
          ))}
          {visible.length === 0 && (
            <p className="m-0 text-sm text-fg-muted col-span-full">{t('integrations.overview.noMatch', { q })}</p>
          )}
          {(filter === 'all' || filter === 'avail') && <CustomCard canEdit={canEdit} />}
        </div>
      )}
    </>
  );
}

function IntegrationCard({ m }: { m: CardModel }) {
  const { c } = m;
  const statusLabel = t(`integrations.cardState.${m.state}`);
  return (
    <article className="bg-card border border-line rounded-card p-[18px] flex flex-col gap-3.5 transition-colors duration-fast hover:border-primary-solid min-w-0">
      <div className="flex items-start gap-3">
        <Monogram text={c.monogram} color={c.color} size={40} />
        <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
          <h3 className="m-0 text-section font-semibold break-words">{c.name}</h3>
          <span className="text-meta text-fg-muted">{c.kind}</span>
        </div>
        <Badge tone={STATE_TONE[m.state]}>{statusLabel}</Badge>
      </div>
      <p className="m-0 text-sm text-fg-muted leading-normal line-clamp-2 min-h-[39px]">{c.description}</p>
      {m.note && (
        <div className={cx('px-2.5 py-2 rounded-control text-meta leading-snug flex gap-2 items-start', m.note.tone === 'error' ? 'bg-err-soft text-err' : 'bg-warn-soft text-warn')}>
          <Icon name={m.note.tone === 'error' ? 'XCircle' : 'AlertTriangle'} size={14} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{m.note.text}</span>
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 pt-3 border-t border-line">
        <span className="inline-flex items-center gap-1.5 text-meta text-fg-muted min-w-0">
          <Icon name="GitBranch" size={14} className="shrink-0" />
          <span className="truncate">
            {!c.needsConnection && m.conns.length === 0
              ? m.workflows != null
                ? `${t('integrations.cards.noConn')} · ${pl(m.workflows, 'integrations.cards.wf')}`
                : t('integrations.cards.noConnNeeded')
              : m.conns.length === 0
                ? t('integrations.cards.unused')
                : m.workflows != null
                  ? `${pl(m.conns.length, 'integrations.cards.conn')} · ${pl(m.workflows, 'integrations.cards.wf')}`
                  : pl(m.conns.length, 'integrations.cards.conn')}
          </span>
        </span>
        {m.cta && (
          <Link to={m.cta.to} className="inline-flex items-center h-[30px] px-2.5 border border-line rounded-[7px] !text-fg text-meta font-medium whitespace-nowrap hover:bg-raised transition-colors duration-fast" aria-label={`${m.cta.label}: ${c.name}`}>
            {m.cta.label}
          </Link>
        )}
      </div>
    </article>
  );
}

function CustomCard({ canEdit }: { canEdit: boolean }) {
  const body = (
    <>
      <span className="w-10 h-10 rounded-node flex items-center justify-center bg-primary-soft text-fg-link">
        <Icon name="Plus" size={18} />
      </span>
      <span className="text-section font-semibold">{t('integrations.custom.title')}</span>
      <span className="text-sm text-fg-muted leading-normal">{t('integrations.custom.text')}</span>
      {canEdit && <span className="text-sm text-fg-link font-medium inline-flex items-center gap-1">{t('integrations.custom.cta')} <Icon name="ArrowRight" size={14} /></span>}
    </>
  );
  const cls = 'border border-dashed border-line rounded-card p-[18px] flex flex-col items-start justify-center gap-2.5 min-h-[200px] !text-fg transition-colors duration-fast';
  return canEdit ? (
    <Link to="/schnittstellen/http/verbinden" className={cx(cls, 'hover:border-primary-solid')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
