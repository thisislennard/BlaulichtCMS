import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { get, qs } from '../../api/client';
import { Button, cx, EmptyState, ErrorBox, Input, PageHeader, SegmentedControl, SkeletonRows, Table, Td, Th } from '../../components/ui/core';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { CHANNEL_LABEL, PressStatusBadge, RequestDialog, type PressRequestRow } from './shared';

type Filter = 'open' | 'overdue' | 'mine' | 'answered' | 'done' | 'expiring' | 'all';
const FILTERS: Filter[] = ['open', 'overdue', 'mine', 'answered', 'done', 'expiring', 'all'];

/** Presseanfragen (#204): Übersicht mit Filtern (offen, überfällig, meine …) und Suche. */
export default function PressRequests() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  // Benachrichtigung „… werden gelöscht“ verlinkt /presse?filter=expiring
  const [filter, setFilter] = useState<Filter>(() => (FILTERS.includes(params.get('filter') as Filter) ? (params.get('filter') as Filter) : 'open'));
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['press-requests', filter, q], queryFn: () => get<{ requests: PressRequestRow[]; counts: Record<string, number> }>(`/press/requests${qs({ filter, q: q.trim() || undefined })}`), refetchInterval: 30_000 });
  const c = list.data?.counts;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Presseanfragen"
        subtitle="Anfragen von Redaktionen erfassen und bis zur Erledigung nachverfolgen – mit Zuständigkeit, Frist und Verlauf."
        actions={can('press.manage') && <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>Anfrage erfassen</Button>}
      />
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <SegmentedControl<Filter>
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'Offen', count: c?.open },
            { value: 'overdue', label: 'Überfällig', count: c?.overdue },
            { value: 'mine', label: 'Meine', count: c?.mine },
            { value: 'answered', label: 'Beantwortet', count: c?.answered },
            { value: 'done', label: 'Erledigt' },
            ...(c?.expiring || filter === 'expiring' ? [{ value: 'expiring' as Filter, label: 'Löschung angekündigt', count: c?.expiring }] : []),
            { value: 'all', label: 'Alle' },
          ]}
        />
        <div className="w-full sm:w-72">
          <Input type="search" aria-label="Anfragen durchsuchen" placeholder="Nummer, Thema, Medium, Name …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {list.isLoading && <SkeletonRows rows={5} />}
      {list.error && <ErrorBox title="Presseanfragen konnten nicht geladen werden">{(list.error as Error).message}</ErrorBox>}
      {list.data && !list.data.requests.length && (
        <EmptyState icon="MessageSquareQuote" title={filter === 'open' ? 'Keine offene Presseanfrage' : 'Keine Anfragen'} text={filter === 'open' && can('press.manage') ? 'Neue Anfragen kommen über das Presse-Postfach oder werden hier von Hand erfasst.' : undefined} />
      )}
      {!!list.data?.requests.length && (
        <Table>
          <thead>
            <tr>
              <Th>Anfrage</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Medium</Th>
              <Th className="hidden md:table-cell">Zuständig</Th>
              <Th>Frist</Th>
            </tr>
          </thead>
          <tbody>
            {list.data.requests.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-raised" onClick={() => nav(`/presse/${r.id}`)}>
                <Td>
                  <Link to={`/presse/${r.id}`} className="font-medium block truncate max-w-[420px]" onClick={(e) => e.stopPropagation()}>
                    {r.topic}
                  </Link>
                  <span className="text-meta text-fg-muted">
                    <span className="font-mono">{r.case_no}</span> · {CHANNEL_LABEL[r.channel] ?? r.channel} · {fmtRelative(r.created_at)}
                  </span>
                </Td>
                <Td>
                  <PressStatusBadge status={r.status} />
                </Td>
                <Td className="hidden md:table-cell">{r.outlet || <span className="text-fg-muted">–</span>}</Td>
                <Td className="hidden md:table-cell">{r.assignee_name ?? <span className="text-fg-muted">niemand</span>}</Td>
                <Td>{r.due_at ? <span className={cx(r.overdue && 'text-err font-medium')}>{r.overdue ? 'überfällig · ' : ''}{fmtDateTime(r.due_at)}</span> : <span className="text-fg-muted">–</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && (
        <RequestDialog
          onClose={(id) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['press-requests'] });
            if (id) nav(`/presse/${id}`);
          }}
        />
      )}
    </div>
  );
}
