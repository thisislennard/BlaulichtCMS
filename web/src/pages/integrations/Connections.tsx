import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { cx, EmptyState, ErrorBox, LinkButton, Monogram, PageHeader, Select, SkeletonRows, Table, Td, Th } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useCatalog } from '../../components/forms/SchemaForm';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDuration, fmtRelative } from '../../lib/format';
import { ConnStatusBadge, expiryNote, pl, useConnections, type ConnStatus } from './shared';

const STATUSES: ConnStatus[] = ['ok', 'warning', 'error', 'untested', 'disabled'];

export default function Connections() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const connections = useConnections();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const integration = params.get('integration') ?? '';
  const status = params.get('status') ?? '';
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const byId = useMemo(() => new Map((catalog.data?.connectors ?? []).map((c) => [c.id, c])), [catalog.data]);
  const rows = connections.data ?? [];
  const needle = q.trim().toLowerCase();
  const visible = rows.filter(
    (r) =>
      (!integration || r.connector === integration) &&
      (!status || r.status === status) &&
      (!needle || `${r.name} ${byId.get(r.connector)?.name ?? r.connector} ${r.status_message ?? ''}`.toLowerCase().includes(needle)),
  );
  const usedConnectors = [...new Set(rows.map((r) => r.connector))];
  const nIssues = rows.filter((r) => r.status === 'error' || r.status === 'warning').length;

  return (
    <>
      <PageHeader
        title={t('integrations.connections.title')}
        subtitle={connections.data ? `${pl(rows.length, 'integrations.connections.count')} · ${t('integrations.connections.subtitleIssues', { e: nIssues })}` : t('integrations.connections.subtitleLoading')}
        actions={can('connection.edit') && <LinkButton to="/schnittstellen" variant="primary" icon="Plus">{t('integrations.connections.add')}</LinkButton>}
      />

      <section aria-label={t('integrations.connections.title')} className="bg-card border border-line rounded-card min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap p-4 border-b border-line">
          <label className="flex items-center gap-2 h-field px-3 border border-line rounded-control bg-bg flex-[1_1_240px] min-w-0 max-w-[360px] text-fg-muted focus-within:border-primary focus-within:shadow-ring">
            <Icon name="Search" size={15} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('integrations.connections.search')} placeholder={t('integrations.connections.search')} className="flex-1 min-w-0 bg-transparent border-0 outline-none text-base text-fg placeholder:text-fg-muted" />
          </label>
          <div className="w-[200px] max-w-full">
            <Select aria-label={t('integrations.connections.filterIntegration')} value={integration} onChange={(e) => setParam('integration', e.target.value)}>
              <option value="">{t('integrations.connections.allIntegrations')}</option>
              {usedConnectors.map((id) => (
                <option key={id} value={id}>
                  {byId.get(id)?.name ?? id}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-[180px] max-w-full">
            <Select aria-label={t('integrations.connections.filterStatus')} value={status} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">{t('integrations.connections.allStatus')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`integrations.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {connections.error ? (
          <div className="p-4">
            <ErrorBox title={t('integrations.connections.loadError')}>{(connections.error as Error).message}</ErrorBox>
          </div>
        ) : connections.isLoading ? (
          <SkeletonRows rows={5} className="p-4" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="Link2"
            title={t('integrations.connections.emptyTitle')}
            text={t('integrations.connections.emptyText')}
            action={can('connection.edit') && <LinkButton to="/schnittstellen" variant="primary" icon="Plus">{t('integrations.connections.add')}</LinkButton>}
          />
        ) : visible.length === 0 ? (
          <EmptyState icon="Filter" title={t('integrations.connections.noMatchTitle')} text={t('integrations.connections.noMatchText')} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('integrations.connections.colName')}</Th>
                <Th>{t('integrations.connections.colStatus')}</Th>
                <Th>{t('integrations.connections.colTest')}</Th>
                <Th>{t('integrations.connections.colUsed')}</Th>
                <Th align="right">{t('integrations.connections.colWorkflows')}</Th>
                <Th>{t('integrations.connections.colExpires')}</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const c = byId.get(r.connector);
                const exp = expiryNote(r.credentials_expire_at);
                return (
                  <tr key={r.id} className={cx('hover:bg-raised cursor-pointer transition-colors duration-fast', r.status === 'disabled' && 'opacity-60')} onClick={() => navigate(`/verbindungen/${r.id}`)}>
                    <Td>
                      <div className="flex items-center gap-3 min-w-[220px]">
                        <Monogram text={c?.monogram ?? r.connector.slice(0, 2).toUpperCase()} color={c?.color ?? '#475569'} size={32} />
                        <div className="flex flex-col min-w-0">
                          <Link to={`/verbindungen/${r.id}`} className="font-medium !text-fg hover:!text-fg-link truncate" onClick={(e) => e.stopPropagation()}>
                            {r.name}
                          </Link>
                          <span className="text-meta text-fg-muted truncate">{c?.name ?? r.connector}</span>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-1 items-start max-w-[320px]">
                        <ConnStatusBadge status={r.status} />
                        {r.status_message && (r.status === 'error' || r.status === 'warning') && <span className="text-meta text-fg-muted line-clamp-2">{r.status_message}</span>}
                      </div>
                    </Td>
                    <Td>
                      {r.last_test_at ? (
                        <span className="flex flex-col whitespace-nowrap">
                          <span>{fmtRelative(r.last_test_at)}</span>
                          <span className="font-mono text-meta text-fg-muted tabular">{fmtDuration(r.last_test_ms)}</span>
                        </span>
                      ) : (
                        <span className="text-fg-muted">{t('integrations.connections.never')}</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">{r.last_used_at ? fmtRelative(r.last_used_at) : <span className="text-fg-muted">{t('integrations.connections.never')}</span>}</Td>
                    <Td align="right" mono>
                      {r.workflow_count}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {r.credentials_expire_at ? (
                        <span className={cx('inline-flex items-center gap-1.5', exp?.tone === 'error' ? 'text-err' : exp?.tone === 'warning' ? 'text-warn' : '')}>
                          {exp && <Icon name="AlertTriangle" size={13} />}
                          {fmtDate(r.credentials_expire_at)}
                        </span>
                      ) : (
                        <span className="text-fg-muted">–</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
