import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { get, qs } from '../../api/client';
import { Button, cx, EmptyLine, EmptyState, ErrorBox, PageHeader, SkeletonRows } from '../../components/ui/core';
import { FilterEmpty, ListToolbar, ResponsiveTable } from '../../components/ui/list';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { useListState } from '../../lib/listState';
import { CHANNEL_LABEL, PressStatusBadge, RequestDialog, type PressRequestRow } from './shared';

type Filter = 'open' | 'overdue' | 'mine' | 'answered' | 'done' | 'expiring' | 'all';
const FILTERS: Filter[] = ['open', 'overdue', 'mine', 'answered', 'done', 'expiring', 'all'];

/** Presseanfragen (#204): Übersicht mit Filtern (offen, überfällig, meine …) und Suche. */
export default function PressRequests() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  // Reiter und Suche in der Adresse (#260): Zurück aus einer Anfrage zeigt wieder denselben Reiter. Benachrichtigungen
  // verlinken z. B. /presse?filter=expiring, die Suche (Strg K) /presse?filter=all&suche=…
  const ls = useListState({ filter: 'open', suche: '' }, { tabKeys: ['filter'] });
  const filter: Filter = FILTERS.includes(ls.values.filter as Filter) ? (ls.values.filter as Filter) : 'open';
  const [q, setQ] = useState(ls.values.suche.trim());
  useEffect(() => {
    const t = setTimeout(() => setQ(ls.values.suche.trim()), 250);
    return () => clearTimeout(t);
  }, [ls.values.suche]);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['press-requests', filter, q], queryFn: () => get<{ requests: PressRequestRow[]; counts: Record<string, number> }>(`/press/requests${qs({ filter, q: q || undefined })}`), refetchInterval: 30_000, placeholderData: keepPreviousData });
  const c = list.data?.counts;
  const rows = list.data?.requests ?? [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Anfragen von Redaktionen erfassen und bis zur Erledigung nachverfolgen – mit Zuständigkeit, Frist und Verlauf."
        actions={can('press.manage') && <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>Anfrage erfassen</Button>}
      />
      <ListToolbar<Filter>
        search={{ value: ls.values.suche, onChange: (s) => ls.set({ suche: s }), placeholder: 'Suchen in Presseanfragen', label: 'Presseanfragen durchsuchen (Nummer, Thema, Medium, Name)' }}
        tabs={{
          label: 'Ansicht',
          value: filter,
          onChange: (f) => ls.set({ filter: f }),
          options: [
            { value: 'open', label: 'Offen', count: c?.open },
            { value: 'overdue', label: 'Überfällig', count: c?.overdue },
            { value: 'mine', label: 'Meine', count: c?.mine },
            { value: 'answered', label: 'Beantwortet', count: c?.answered },
            { value: 'done', label: 'Erledigt' },
            ...(c?.expiring || filter === 'expiring' ? [{ value: 'expiring' as Filter, label: 'Löschung angekündigt', count: c?.expiring }] : []),
            { value: 'all', label: 'Alle' },
          ],
        }}
        count={list.data ? { n: rows.length, one: 'Anfrage', many: 'Anfragen' } : undefined}
        onReset={() => ls.reset(['filter'])}
      />
      {list.isLoading && <SkeletonRows rows={5} />}
      {list.error && <ErrorBox title="Presseanfragen konnten nicht geladen werden">{(list.error as Error).message}</ErrorBox>}
      {list.data && !rows.length &&
        (q ? (
          <FilterEmpty onReset={() => ls.reset(['filter'])} />
        ) : filter === 'open' && !c?.open && !c?.answered && !c?.overdue ? (
          <EmptyState
            icon="MessageSquareQuote"
            title="Keine offene Presseanfrage."
            text={can('press.manage') ? 'Neue Anfragen kommen über das Presse-Postfach oder werden hier von Hand erfasst.' : 'Anfragen erfasst die Pressestelle.'}
            action={can('press.manage') && <Button icon="Plus" onClick={() => setCreating(true)}>Anfrage erfassen</Button>}
          />
        ) : (
          <EmptyLine className="py-4">{filter === 'overdue' ? 'Keine überfällige Anfrage.' : filter === 'mine' ? 'Dir ist keine offene Anfrage zugewiesen.' : filter === 'answered' ? 'Keine beantwortete Anfrage offen.' : filter === 'done' ? 'Noch keine erledigte Anfrage.' : filter === 'expiring' ? 'Keine Löschung angekündigt.' : 'Keine Anfrage in dieser Ansicht.'}</EmptyLine>
        ))}
      {rows.length > 0 && (
        <ResponsiveTable
          label="Presseanfragen"
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/presse/${r.id}`)}
          columns={[
            {
              key: 'topic',
              header: 'Anfrage',
              card: 'title',
              cell: (r) => (
                <>
                  <Link to={`/presse/${r.id}`} className="font-medium block truncate max-w-[420px] max-md:whitespace-normal">
                    {r.topic}
                  </Link>
                  <span className="text-meta text-fg-muted font-normal">
                    <span className="font-mono">{r.case_no}</span> · {CHANNEL_LABEL[r.channel] ?? r.channel} · {fmtRelative(r.created_at)}
                  </span>
                </>
              ),
            },
            { key: 'status', header: 'Status', card: 'status', cell: (r) => <PressStatusBadge status={r.status} /> },
            { key: 'outlet', header: 'Medium', cell: (r) => r.outlet || <span className="text-fg-muted">–</span> },
            { key: 'assignee', header: 'Zuständig', cell: (r) => r.assignee_name ?? <span className="text-fg-muted">niemand</span> },
            { key: 'due', header: 'Frist', cell: (r) => (r.due_at ? <span className={cx(r.overdue && 'text-err font-medium')}>{r.overdue ? 'überfällig · ' : ''}{fmtDateTime(r.due_at)}</span> : <span className="text-fg-muted">–</span>) },
          ]}
        />
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
