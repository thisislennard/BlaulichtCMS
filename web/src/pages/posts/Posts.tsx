import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import type { PostListItem } from '../../api/types';
import { Button, Chip, EmptyAction, EmptyLine, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, Rev, Select, SkeletonRows, StatusBadge } from '../../components/ui/core';
import { FilterEmpty, ListToolbar, ResponsiveTable } from '../../components/ui/list';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { AutomationApprovals } from '../automations/Approvals';
import { fmtRelative, fmtWeekdayDateTime, plural } from '../../lib/format';
import { useListState } from '../../lib/listState';
import { SOCIAL_LABEL, type SocialKind } from '../../lib/social';
import { safeHref } from '../../lib/url';

export const KIND_LABEL: Record<string, string> = { news: 'Nachricht', incident: 'Einsatzbericht', event: 'Veranstaltung', situation: 'Lage-Info' };

export function NewPostDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('news');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const tpls = useQuery({ queryKey: ['templates'], queryFn: () => get<any[]>('/templates') });
  const create = async () => {
    setBusy(true);
    try {
      const p = await post<any>('/posts', { title: title.trim(), kind, templateId: templateId || null });
      nav(`/beitraege/${p.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Neuer Beitrag"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" icon="Plus" loading={busy} disabled={title.trim().length < 2} onClick={create}>
            Anlegen
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), title.trim().length >= 2 && create())}>
        <FieldWrap label="Arbeitstitel" required htmlFor="p-title">
          <Input id="p-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="z. B. Übung am Wochenende" />
        </FieldWrap>
        {(tpls.data?.length ?? 0) > 0 && (
          <FieldWrap label="Beitragsvorlage (optional)" htmlFor="p-tpl">
            <Select
              id="p-tpl"
              value={templateId}
              onChange={(e) => {
                // Art und (wenn noch leer) Titel aus der Vorlage übernehmen – die Anzeige entspricht dem, was angelegt wird
                const t = tpls.data!.find((x) => x.id === e.target.value);
                setTemplateId(e.target.value);
                if (t) {
                  setKind(t.kind);
                  if (!title.trim() && t.title) setTitle(t.title);
                }
              }}
            >
              <option value="">– ohne Beitragsvorlage –</option>
              {tpls.data!.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FieldWrap>
        )}
        <FieldWrap label="Art" help={templateId ? 'Aus der Beitragsvorlage übernommen.' : undefined} htmlFor="p-kind">
          <Select id="p-kind" value={kind} disabled={!!templateId} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </FieldWrap>
      </form>
    </Dialog>
  );
}

/** Reiter der Beitragsliste (Adresse `?status=…`) und welche Zustände dazugehören. */
const TABS = { alle: null, arbeit: ['draft', 'rejected'], freigabe: ['in_review', 'approved', 'scheduled', 'failed', 'unknown'], veroeffentlicht: ['published', 'publishing', 'deactivated'] } as const;
type Tab = keyof typeof TABS;
const PERIODS: Record<string, { label: string; days: number }> = { heute: { label: 'Heute', days: 1 }, '7': { label: 'Letzte 7 Tage', days: 7 }, '30': { label: 'Letzte 30 Tage', days: 30 }, '365': { label: 'Letzte 12 Monate', days: 365 } };

/** Veröffentlichungsziele eines Beitrags: Website (mit „Ansehen“) und soziale Netzwerke samt Stand, geplanter Zeitpunkt. */
function Targets({ p }: { p: PostListItem }) {
  if (!p.site_name && !p.social.length) return <span className="text-fg-muted">nur intern</span>;
  const done = (s: string | null) => s === 'published';
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        {p.site_name && (
          <Chip className="max-w-full" title={`Website: ${p.site_name}`}>
            <Icon name="Globe" size={12} />
            <span className="truncate max-w-[160px]">{p.site_name}</span>
            {p.published_url && (
              <a href={safeHref(p.published_url)} target="_blank" rel="noopener noreferrer" title={p.published_url} aria-label={`Auf der Website ansehen: ${p.published_url} (öffnet in neuem Tab)`} className="inline-flex items-center justify-center max-md:w-8 max-md:h-8 !text-fg-muted hover:!text-fg">
                <Icon name="ExternalLink" size={12} />
              </a>
            )}
          </Chip>
        )}
        {p.social.map((s, i) => (
          <Chip key={`${s.kind}-${i}`} title={`${s.name}${done(s.status) ? ' – veröffentlicht' : s.status === 'failed' ? ' – fehlgeschlagen' : ''}`}>
            {done(s.status) && <Icon name="Check" size={12} className="text-ok" />}
            {s.status === 'failed' && <Icon name="XCircle" size={12} className="text-err" />}
            {SOCIAL_LABEL[s.kind as SocialKind] ?? s.kind}
            {done(s.status) && <span className="sr-only"> (veröffentlicht)</span>}
            {s.status === 'failed' && <span className="sr-only"> (fehlgeschlagen)</span>}
          </Chip>
        ))}
      </div>
      {p.scheduled_at && (
        <span className="text-meta text-fg-muted inline-flex items-center gap-1">
          <Icon name="CalendarClock" size={12} /> geplant für {fmtWeekdayDateTime(p.scheduled_at)}
        </span>
      )}
    </div>
  );
}

export default function Posts({ mode }: { mode?: 'approvals' }) {
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  // Suche, Reiter und Filter in der Adresse (#260): Zurück aus dem Beitrag stellt die Liste wieder her
  const list = useListState({ suche: '', status: mode === 'approvals' ? 'freigabe' : 'alle', art: '', ziel: '', person: '', zeitraum: '' }, { tabKeys: ['status'] });
  const v = list.values;
  const tab: Tab = v.status in TABS ? (v.status as Tab) : 'alle';
  const [term, setTerm] = useState(v.suche.trim());
  useEffect(() => {
    const t = setTimeout(() => setTerm(v.suche.trim()), 250);
    return () => clearTimeout(t);
  }, [v.suche]);
  const q = useQuery({ queryKey: ['posts', term], queryFn: () => get<PostListItem[]>(`/posts${qs({ q: term || undefined })}`), refetchInterval: 20_000, placeholderData: keepPreviousData });
  const all = q.data ?? [];
  const since = v.zeitraum && PERIODS[v.zeitraum] ? Date.now() - PERIODS[v.zeitraum].days * 86_400_000 : 0;
  const inTab = (p: PostListItem, t: Tab) => !TABS[t] || (TABS[t] as readonly string[]).includes(p.state);
  const filtered = all.filter(
    (p) =>
      (!v.art || p.kind === v.art) &&
      (!v.ziel || (v.ziel === 'website' ? !!p.site_name : v.ziel === 'intern' ? !p.site_name && !p.social.length : p.social.some((s) => s.kind === v.ziel))) &&
      (!v.person || p.updated_by === v.person) &&
      (!since || new Date(p.updated_at).getTime() >= since),
  );
  const rows = filtered.filter((p) => inTab(p, tab));
  const people = [...new Map(all.filter((p) => p.updated_by && p.updated_by_name).map((p) => [p.updated_by!, p.updated_by_name!])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'de'));
  const networks = [...new Set(all.flatMap((p) => p.social.map((s) => s.kind)))];
  const narrowed = list.activeCount > 0;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle={mode === 'approvals' ? 'Fassungen, die auf Freigabe oder Veröffentlichung warten.' : 'Jede Änderung erzeugt eine neue Fassung. Freigaben gelten genau für eine Fassung.'}
        actions={
          can('post.create') && (
            <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
              Neuer Beitrag
            </Button>
          )
        }
      />
      {mode === 'approvals' && <AutomationApprovals />}
      <ListToolbar<Tab>
        search={{ value: v.suche, onChange: (s) => list.set({ suche: s }), placeholder: 'Suchen in Beiträgen', label: 'Beiträge durchsuchen (Titel und Text)' }}
        tabs={{
          label: 'Status',
          value: tab,
          onChange: (s) => list.set({ status: s }),
          options: [
            { value: 'alle', label: 'Alle', count: filtered.length },
            { value: 'arbeit', label: 'In Arbeit', count: filtered.filter((p) => inTab(p, 'arbeit')).length },
            { value: 'freigabe', label: 'Freigabe & Veröffentlichung', count: filtered.filter((p) => inTab(p, 'freigabe')).length },
            { value: 'veroeffentlicht', label: 'Veröffentlicht', count: filtered.filter((p) => inTab(p, 'veroeffentlicht')).length },
          ],
        }}
        filters={[
          { key: 'art', label: 'Art', value: v.art, onChange: (s) => list.set({ art: s }), options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) },
          {
            key: 'ziel',
            label: 'Ziel',
            value: v.ziel,
            onChange: (s) => list.set({ ziel: s }),
            options: [{ value: 'website', label: 'Website' }, ...networks.map((k) => ({ value: k, label: SOCIAL_LABEL[k as SocialKind] ?? k })), { value: 'intern', label: 'Nur intern' }],
          },
          { key: 'person', label: 'Zuletzt geändert von', value: v.person, onChange: (s) => list.set({ person: s }), allLabel: 'Alle Personen', options: people.map(([value, label]) => ({ value, label })) },
          { key: 'zeitraum', label: 'Geändert', value: v.zeitraum, onChange: (s) => list.set({ zeitraum: s }), allLabel: 'Jederzeit', options: Object.entries(PERIODS).map(([value, p]) => ({ value, label: p.label })) },
        ]}
        count={q.data ? { n: rows.length, one: 'Beitrag', many: 'Beiträge' } : undefined}
        onReset={() => list.reset(['status'])}
      />
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Beiträge konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && rows.length === 0 &&
        (narrowed ? (
          <FilterEmpty onReset={() => list.reset(['status'])} />
        ) : !all.length && tab === 'alle' ? (
          <EmptyState icon="FileText" title="Noch keine Beiträge." text={can('post.create') ? 'Der erste Beitrag entsteht mit „Neuer Beitrag“ – oder aus einer Sammlung mit „Fotos sammeln“.' : 'Beiträge legt die Redaktion an.'} action={can('post.create') && <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>Neuer Beitrag</Button>} />
        ) : (
          <EmptyLine className="py-4" action={tab !== 'alle' && <EmptyAction onClick={() => list.set({ status: 'alle' })}>Alle Beiträge zeigen</EmptyAction>}>
            {tab === 'freigabe' ? 'Nichts wartet auf Freigabe oder Veröffentlichung.' : tab === 'arbeit' ? 'Kein Beitrag in Arbeit.' : tab === 'veroeffentlicht' ? 'Noch nichts veröffentlicht.' : 'Kein Beitrag.'}
          </EmptyLine>
        ))}
      {rows.length > 0 && (
        <ResponsiveTable
          label="Beiträge"
          rows={rows}
          rowKey={(p) => p.id}
          columns={[
            {
              key: 'title',
              header: 'Titel',
              card: 'title',
              cell: (p) => (
                <>
                  <Link to={`/beitraege/${p.id}`} className="font-medium">
                    {p.title}
                  </Link>
                  <div className="text-meta text-fg-muted font-normal max-md:hidden">
                    {KIND_LABEL[p.kind]} · <Rev n={p.current_revision} />
                    {p.collection_count > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1" title={plural(p.collection_count, 'Sammlung', 'Sammlungen')}>
                        <Icon name="Images" size={12} /> {p.collection_count}
                      </span>
                    )}
                  </div>
                </>
              ),
            },
            {
              key: 'meta',
              header: 'Art',
              card: 'meta',
              table: false,
              cell: (p) => (
                <>
                  {KIND_LABEL[p.kind]} · <Rev n={p.current_revision} /> · {fmtRelative(p.updated_at)}
                  {p.updated_by_name ? ` · ${p.updated_by_name}` : ''}
                </>
              ),
            },
            { key: 'state', header: 'Status', card: 'status', cell: (p) => <StatusBadge status={p.state} /> },
            { key: 'targets', header: 'Ziele', cell: (p) => <Targets p={p} /> },
            {
              key: 'changed',
              header: 'Geändert',
              from: 'lg',
              card: 'hide',
              cell: (p) => (
                <>
                  <span className="font-mono text-meta">{fmtRelative(p.updated_at)}</span>
                  {p.updated_by_name && <div className="text-meta text-fg-muted">{p.updated_by_name}</div>}
                </>
              ),
            },
          ]}
        />
      )}
      {create && <NewPostDialog onClose={() => setCreate(false)} />}
    </div>
  );
}
