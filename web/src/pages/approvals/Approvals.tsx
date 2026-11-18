import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, EmptyLine, EmptyState, ErrorBox, LinkButton, Notice, PageHeader, Rev, SegmentedControl, SkeletonRows } from '../../components/ui/core';
import { FilterEmpty, ListToolbar, ResponsiveTable, type Column } from '../../components/ui/list';
import { Icon } from '../../components/ui/Icon';
import { useListState } from '../../lib/listState';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { DecisionDialog, type Approval } from '../automations/Approvals';
import { approvalDetail, KIND_ICON, KIND_LABEL, spellRevision, useApprovals, type PendingItem, type ReadyItem } from './model';

/**
 * Freigaben (#251): eine Arbeitsliste über alle Arten, für die die Person entscheiden darf – Beiträge, Banner, Einsatzliste,
 * Warnentwürfe, Antworten an die Presse und Freigaben aus Workflows. „Prüfen →“ öffnet die bestehende Prüfansicht der Art;
 * entschieden wird dort mit allen Regeln. Was die Person wegen des Vier-Augen-Prinzips nicht entscheiden darf, steht
 * ausgegraut mit Grund in der Liste. Darunter, nur mit Veröffentlichungsrechten: Freigegebenes, das noch nicht
 * veröffentlicht bzw. versandt ist. Filter und Sortierung stehen in der Adresse (?art=einsatzliste&sortierung=aelteste).
 */
const asApproval = (i: PendingItem): Approval => ({
  id: i.id,
  kind: i.meta.approval_kind === 'mail' ? 'mail' : 'approval',
  title: i.title,
  summary: i.meta.summary ?? '',
  created_at: i.submitted_at,
  expires_at: i.meta.expires_at,
  run_id: i.meta.run_id,
  automation_id: i.meta.automation_id,
  automation_name: i.meta.automation_name,
  can_decide: !i.blocked,
});

function Kind({ kind }: { kind: PendingItem['kind'] }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon name={KIND_ICON[kind]} size={15} className="text-fg-muted shrink-0" />
      {KIND_LABEL[kind]}
    </span>
  );
}

function Revision({ i }: { i: { kind: PendingItem['kind']; revision: number | null } }) {
  if (i.revision == null) return <span className="text-fg-muted">–</span>;
  return spellRevision(i.kind) ? <span>Fassung {i.revision}</span> : <Rev n={i.revision} />;
}

export default function Approvals() {
  const q = useApprovals();
  const d = q.data;
  const list = useListState({ art: 'alle', sortierung: 'neueste' });
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<PendingItem | null>(null);
  const kinds = d?.kinds ?? [];
  const art = kinds.some((k) => k.param === list.values.art) ? list.values.art : 'alle';
  const kindOf = (param: string) => kinds.find((k) => k.param === param)?.kind;
  const oldestFirst = list.values.sortierung === 'aelteste';

  const shown = useMemo(() => {
    const k = art === 'alle' ? null : kindOf(art);
    const rows = (d?.items ?? []).filter((i) => !k || i.kind === k);
    return oldestFirst ? [...rows].reverse() : rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, art, oldestFirst]);
  const ready = useMemo(() => {
    const k = art === 'alle' ? null : kindOf(art);
    return (d?.ready ?? []).filter((r) => !k || r.kind === k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, art]);

  // Verweis aus der Benachrichtigung: /freigaben?workflow=<id> öffnet die Entscheidung direkt
  const linkedWorkflow = params.get('workflow');
  const linkedItem = linkedWorkflow ? d?.items.find((i) => i.kind === 'automation' && i.id === linkedWorkflow) : undefined;
  useEffect(() => {
    if (linkedItem) setDialog(linkedItem);
  }, [linkedItem]);
  const closeDialog = () => {
    setDialog(null);
    if (linkedWorkflow) {
      const next = new URLSearchParams(params);
      next.delete('workflow');
      setParams(next, { replace: true });
    }
  };

  const columns: Column<PendingItem>[] = [
    { key: 'kind', header: 'Art', cell: (i) => <Kind kind={i.kind} />, card: 'meta', className: 'w-[1%]' },
    {
      key: 'title',
      header: 'Titel',
      card: 'title',
      cell: (i) => (
        <div className="flex flex-col gap-0.5 min-w-0">
          <Link to={i.link} className={i.blocked ? '!text-fg-muted font-medium' : 'font-medium'} onClick={i.kind === 'automation' ? (e) => (e.preventDefault(), setDialog(i)) : undefined}>
            {i.title}
          </Link>
          {approvalDetail(i) && <span className="text-meta text-fg-muted font-normal">{approvalDetail(i)}</span>}
          {i.blocked && (
            <span className="text-meta text-fg-muted font-normal inline-flex items-center gap-1">
              <Icon name="Lock" size={12} className="shrink-0" /> {i.blocked}
            </span>
          )}
        </div>
      ),
    },
    { key: 'revision', header: 'Fassung', cell: (i) => <Revision i={i} />, from: 'lg' },
    {
      key: 'submitted',
      header: 'Eingereicht',
      cell: (i) => (
        <span className="flex flex-col">
          <span className="font-mono text-meta whitespace-nowrap" title={fmtDateTime(i.submitted_at)}>
            {fmtRelative(i.submitted_at)}
          </span>
          {i.submitted_by_name && <span className="text-meta text-fg-muted">von {i.submitted_by_name}</span>}
          {!i.submitted_by_name && i.kind === 'automation' && <span className="text-meta text-fg-muted">aus dem Workflow</span>}
        </span>
      ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Aktion</span>,
      cardLabel: 'Aktion',
      align: 'right',
      card: 'footer',
      cell: (i) =>
        i.kind === 'automation' ? (
          <Button size="sm" onClick={() => setDialog(i)} aria-label={`${i.blocked ? 'Ansehen' : 'Prüfen'}: ${i.title}`}>
            {i.blocked ? 'Ansehen' : 'Prüfen →'}
          </Button>
        ) : (
          <LinkButton size="sm" to={i.link}>
            <span aria-hidden="true">{i.blocked ? 'Ansehen' : 'Prüfen →'}</span>
            <span className="sr-only">
              {i.blocked ? 'Ansehen' : 'Prüfen'}: {i.title}
            </span>
          </LinkButton>
        ),
    },
  ];

  const readyColumns: Column<ReadyItem>[] = [
    { key: 'kind', header: 'Art', cell: (r) => <Kind kind={r.kind} />, card: 'meta', className: 'w-[1%]' },
    {
      key: 'title',
      header: 'Titel',
      card: 'title',
      cell: (r) => (
        <div className="flex flex-col gap-0.5 min-w-0">
          <Link to={r.link} className="font-medium">
            {r.title}
          </Link>
          {approvalDetail(r) && <span className="text-meta text-fg-muted font-normal">{approvalDetail(r)}</span>}
        </div>
      ),
    },
    { key: 'revision', header: 'Fassung', cell: (r) => <Revision i={r} />, from: 'lg' },
    {
      key: 'approved',
      header: 'Freigegeben',
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-mono text-meta whitespace-nowrap" title={r.approved_at ? fmtDateTime(r.approved_at) : undefined}>
            {r.approved_at ? fmtRelative(r.approved_at) : '–'}
          </span>
          {r.approved_by_name && <span className="text-meta text-fg-muted">von {r.approved_by_name}</span>}
        </span>
      ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Aktion</span>,
      cardLabel: 'Aktion',
      align: 'right',
      card: 'footer',
      cell: (r) => (
        <LinkButton size="sm" to={r.link}>
          <span aria-hidden="true">{r.kind === 'warning' ? 'Versenden →' : 'Veröffentlichen →'}</span>
          <span className="sr-only">
            {r.kind === 'warning' ? 'Versenden' : 'Veröffentlichen'}: {r.title}
          </span>
        </LinkButton>
      ),
    },
  ];

  const nothing = !!d && d.items.length === 0 && d.ready.length === 0;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Was auf eine Entscheidung wartet – über alle Arten, für die du freigeben darfst." />
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Freigaben konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {linkedWorkflow && d && !linkedItem && (
        <Notice tone="info" icon="CheckCircle2">
          Diese Freigabe aus einem Workflow ist nicht mehr offen – sie wurde entschieden, abgebrochen oder ihre Frist ist abgelaufen.
        </Notice>
      )}
      {nothing && <EmptyState icon="CheckCircle2" title="Nichts wartet auf dich." text={kinds.length ? 'Eingereichte Vorgänge aller Arten, über die du entscheiden darfst, erscheinen hier.' : 'Freigegebene Vorgänge, die du veröffentlichen darfst, erscheinen hier.'} />}
      {d && !nothing && kinds.length > 0 && (
        <section aria-labelledby="freigaben-offen" className="flex flex-col gap-3">
          <h2 id="freigaben-offen" className="m-0 text-section font-semibold">
            Zur Entscheidung
          </h2>
          <ListToolbar
            label="Freigaben filtern"
            tabs={{
              label: 'Art',
              value: art,
              onChange: (v) => list.set({ art: v }),
              options: [{ value: 'alle', label: 'Alle', count: d.total }, ...kinds.map((k) => ({ value: k.param, label: k.many, count: k.count }))],
            }}
            count={{ n: shown.length, one: 'Vorgang', many: 'Vorgänge' }}
          >
            <SegmentedControl
              size="sm"
              label="Sortierung"
              value={oldestFirst ? 'aelteste' : 'neueste'}
              onChange={(v) => list.set({ sortierung: v })}
              options={[
                { value: 'neueste', label: 'Neueste zuerst' },
                { value: 'aelteste', label: 'Älteste zuerst' },
              ]}
            />
          </ListToolbar>
          {d.items.length === 0 ? (
            <EmptyLine>Nichts wartet auf dich.</EmptyLine>
          ) : shown.length === 0 ? (
            <FilterEmpty text="In dieser Art wartet nichts." onReset={() => list.reset()} />
          ) : (
            <ResponsiveTable label="Offene Freigaben" rows={shown} columns={columns} rowKey={(i) => `${i.kind}:${i.id}`} rowId={(i) => `freigabe-${i.kind}-${i.id}`} />
          )}
        </section>
      )}
      {d && ready.length > 0 && (
        <section aria-labelledby="freigaben-bereit" className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 id="freigaben-bereit" className="m-0 text-section font-semibold">
              Bereit zur Veröffentlichung
            </h2>
            <p className="m-0 text-meta text-fg-muted">Freigegeben, aber noch nicht veröffentlicht bzw. versandt – für Konten mit dem passenden Recht.</p>
          </div>
          <ResponsiveTable label="Bereit zur Veröffentlichung" rows={ready} columns={readyColumns} rowKey={(r) => `${r.kind}:${r.id}`} />
        </section>
      )}
      {dialog && <DecisionDialog a={asApproval(dialog)} onClose={closeDialog} />}
    </div>
  );
}
