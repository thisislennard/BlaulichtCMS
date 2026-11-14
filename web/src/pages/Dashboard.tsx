import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../api/client';
import { Button, Card, cx, EmptyState, ErrorBox, Notice, PageHeader, Select, SkeletonRows, StatusBadge } from '../components/ui/core';
import { KpiCard } from '../components/ui/data';
import { Icon } from '../components/ui/Icon';
import { useErrorToast, useToast } from '../components/ui/overlays';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtRelative, fmtTime } from '../lib/format';
import { useLive } from '../lib/live';
import { NewCollectionDialog } from './media/Collections';
import { NewPostDialog } from './posts/Posts';

type WidgetId = 'approvals' | 'ready' | 'publications' | 'uploads' | 'media' | 'sites' | 'banners' | 'rss';
type Size = 's' | 'm' | 'l';
interface Layout {
  desktop: { id: WidgetId; size: Size }[];
  mobile: WidgetId[];
}

const TITLES: Record<WidgetId, string> = {
  media: 'Kennzahlen',
  approvals: 'Offene Freigaben',
  ready: 'Bereit zur Veröffentlichung',
  publications: 'Veröffentlichungen',
  uploads: 'Neue Uploads',
  sites: 'Websites',
  banners: 'Aktive Banner',
  rss: 'Quellen (RSS)',
};
const SPAN: Record<Size, string> = { s: 'lg:col-span-4 md:col-span-6', m: 'lg:col-span-6 md:col-span-6', l: 'col-span-12' };
const SIZE_LABEL: Record<Size, string> = { s: 'Klein', m: 'Mittel', l: 'Breit' };

function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return m;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">{children}</ul>;
}

/** Inhalt eines Widgets – rein darstellend, Daten kommen vom bestätigten Stand des Servers. */
function WidgetBody({ id, d }: { id: WidgetId; d: any }) {
  switch (id) {
    case 'media':
      return (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {d.pendingApprovals && <KpiCard label="Offene Freigaben" icon="ListChecks" value={d.pendingApprovals.length} href="/freigaben" />}
          {d.readyToPublish && <KpiCard label="Bereit zur Veröffentlichung" icon="Globe" value={d.readyToPublish.length} href="/freigaben" />}
          {d.media && <KpiCard label="Uploads (24 h)" icon="UploadCloud" value={d.media.last_24h} href="/medien" />}
          {d.media && <KpiCard label="Zu sichten" icon="CheckSquare" value={d.media.unreviewed} delta={d.media.quarantine ? `${d.media.quarantine} in Prüfung` : undefined} deltaTone="muted" href="/medien" />}
        </div>
      );
    case 'approvals':
      return !d.pendingApprovals?.length ? (
        <EmptyState icon="CheckCircle2" title="Nichts offen" />
      ) : (
        <List>
          {d.pendingApprovals.map((p: any) => (
            <li key={p.id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/beitraege/${p.id}`} className="font-medium truncate block">
                  {p.title}
                </Link>
                <div className="text-meta text-fg-muted">
                  Fassung {p.number} · eingereicht {fmtRelative(p.submitted_at)}
                  {p.submitted_by_name ? ` von ${p.submitted_by_name}` : ''}
                </div>
              </div>
              <StatusBadge status="in_review" />
            </li>
          ))}
        </List>
      );
    case 'ready':
      return !d.readyToPublish?.length ? (
        <EmptyState icon="Globe" title="Nichts wartet" />
      ) : (
        <List>
          {d.readyToPublish.map((p: any) => (
            <li key={p.id} className="py-2.5 flex items-center gap-2">
              <Link to={`/beitraege/${p.id}`} className="font-medium flex-1 truncate">
                {p.title}
              </Link>
              <span className="text-meta text-fg-muted">{p.site_id ? 'mit Zielkanal' : 'intern'}</span>
            </li>
          ))}
        </List>
      );
    case 'publications':
      return !d.publications?.length ? (
        <EmptyState icon="Globe" title="Noch keine Veröffentlichung" />
      ) : (
        <List>
          {d.publications.map((p: any) => (
            <li key={p.id} className="py-2.5 flex flex-col gap-1">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={p.status} labels={p.action === 'unpublish' ? { published: 'Zurückgezogen' } : undefined} />
                <Link to={`/beitraege/${p.post_id}`} className="font-medium">
                  {p.title}
                </Link>
                <span className="text-meta text-fg-muted">
                  {p.site_name} · Fassung {p.revision_number}
                </span>
              </div>
              {p.remote_url && p.action !== 'unpublish' && (
                <a href={p.remote_url} target="_blank" rel="noopener noreferrer" className="text-sm break-all">
                  {p.remote_url}
                </a>
              )}
              {p.error && <div className="text-sm text-err">{p.error}</div>}
              <div className="text-meta text-fg-muted">{p.result_at ? `bestätigt ${fmtDateTime(p.result_at)}` : `beauftragt ${fmtRelative(p.created_at)}`}</div>
            </li>
          ))}
        </List>
      );
    case 'uploads':
      return !d.recentCollections?.length ? (
        <EmptyState icon="Images" title="Keine neuen Uploads" />
      ) : (
        <List>
          {d.recentCollections.map((c: any) => (
            <li key={c.id} className="py-2.5 flex items-center gap-3">
              <Icon name="Images" size={16} className="text-fg-muted" />
              <Link to={`/medien/${c.id}`} className="font-medium flex-1 truncate">
                {c.title}
              </Link>
              <span className="text-meta text-fg-muted">
                {c.uploads} · {fmtRelative(c.last_upload)}
              </span>
            </li>
          ))}
        </List>
      );
    case 'sites':
      return !d.sites?.length ? (
        <EmptyState icon="Globe" title="Keine Website gekoppelt" text="Der interne Ablauf funktioniert auch ohne Website." />
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2 text-sm">
          {d.sites.map((s: any) => (
            <li key={s.id} className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={s.status} labels={{ pending: 'Wartet auf Kopplung' }} />
              <span className="font-medium">{s.name}</span>
              <span className="text-fg-muted">{s.last_seen_at ? `zuletzt ${fmtRelative(s.last_seen_at)}` : 'noch nicht gemeldet'}</span>
            </li>
          ))}
        </ul>
      );
    case 'banners':
      return !d.banners?.length ? (
        <EmptyState icon="Megaphone" title="Kein Banner aktiv" />
      ) : (
        <List>
          {d.banners.map((b: any) => (
            <li key={b.id} className="py-2.5 flex items-center gap-2">
              <span className={cx('w-2 h-2 rounded-full shrink-0', b.tone === 'danger' ? 'bg-err' : b.tone === 'warning' ? 'bg-warn' : 'bg-primary')} aria-hidden="true" />
              <Link to="/banner" className="font-medium flex-1 truncate">
                {b.title}
              </Link>
              <span className="text-meta text-fg-muted">bis {fmtTime(b.ends_at)}</span>
            </li>
          ))}
        </List>
      );
    case 'rss':
      return !d.rss?.length ? (
        <EmptyState icon="Newspaper" title="Keine Einträge" text="Quellen lassen sich unter „Quellen“ hinzufügen." />
      ) : (
        <List>
          {d.rss.map((i: any) => (
            <li key={i.id} className="py-2 flex flex-col">
              <a href={i.link ?? '#'} target="_blank" rel="noopener noreferrer" className="font-medium">
                {i.starred_at && <Icon name="Sparkles" size={12} className="inline mr-1 text-warn" />}
                {i.title}
              </a>
              <span className="text-meta text-fg-muted">
                {i.feed_title} · {i.published_at ? fmtRelative(i.published_at) : ''}
              </span>
            </li>
          ))}
        </List>
      );
  }
}

const LINKS: Partial<Record<WidgetId, [string, string]>> = { approvals: ['/freigaben', 'Alle'], sites: ['/kanaele', 'Verwalten'], banners: ['/banner', 'Alle'], rss: ['/quellen', 'Alle'], uploads: ['/medien', 'Alle'] };

export default function Dashboard() {
  const { me, can, isPlatformAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const live = useLive();
  const isMobile = useIsMobile();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/dashboard'), refetchInterval: live === 'live' ? 120_000 : 15_000, refetchOnWindowFocus: true });
  const lq = useQuery({ queryKey: ['dashboard-layout'], queryFn: () => get<{ layout: Layout; source: string; widgets: WidgetId[] }>('/dashboard/layout') });
  const [newPost, setNewPost] = useState(false);
  const [newCollection, setNewCollection] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [shareTarget, setShareTarget] = useState('');
  const first = me?.user.name.split(' ')[0];

  // Schnellzugriffe der installierten App: /?aktion=beitrag bzw. /?aktion=medien
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    const a = sp.get('aktion');
    if (a === 'beitrag' && can('post.edit')) setNewPost(true);
    if (a === 'medien' && can('media.manage')) setNewCollection(true);
    if (a) setSp({}, { replace: true });
  }, [sp, setSp, can]);

  const available = lq.data?.widgets ?? [];
  const layout: Layout | null = draft ?? lq.data?.layout ?? null;
  const visible = useMemo(() => {
    if (!layout) return [];
    if (isMobile && !editing) return layout.mobile.filter((id) => available.includes(id)).map((id) => ({ id, size: 'l' as Size }));
    return layout.desktop.filter((w) => available.includes(w.id));
  }, [layout, isMobile, editing, available]);

  const startEdit = () => {
    setDraft(structuredClone(lq.data!.layout));
    setEditing(true);
  };
  const update = (fn: (l: Layout) => Layout) => setDraft((l) => (l ? fn(structuredClone(l)) : l));
  const move = (from: number, to: number) =>
    update((l) => {
      const [w] = l.desktop.splice(from, 1);
      l.desktop.splice(Math.max(0, Math.min(l.desktop.length, to)), 0, w);
      return l;
    });
  const save = async (scope: 'personal' | 'role' | 'all', role?: string, layoutValue: Layout | null = draft) => {
    try {
      await put('/dashboard/layout', { scope, role, layout: layoutValue });
      toast({ tone: 'success', title: scope === 'personal' ? (layoutValue ? 'Dashboard gespeichert' : 'Auf Vorlage zurückgesetzt') : 'Vorlage gespeichert' });
      await qc.invalidateQueries({ queryKey: ['dashboard-layout'] });
      if (scope === 'personal') {
        setEditing(false);
        setDraft(null);
      }
    } catch (e) {
      toastError(e);
    }
  };
  const d = q.data ?? {};
  const hidden = available.filter((id) => !layout?.desktop.some((w) => w.id === id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={first ? `Hallo ${first}` : 'Dashboard'}
        subtitle={
          <span>
            {me?.instance.organization}
            {d.confirmedAt && <span className="text-fg-muted"> · Stand {fmtTime(d.confirmedAt, true)}</span>}
          </span>
        }
        actions={
          !editing ? (
            <>
              {can('media.manage') && (
                <Button icon="Camera" onClick={() => setNewCollection(true)}>
                  Medien sammeln
                </Button>
              )}
              {can('post.edit') && (
                <Button variant="primary" icon="Plus" onClick={() => setNewPost(true)}>
                  Neuer Beitrag
                </Button>
              )}
              {lq.data && (
                <Button icon="LayoutDashboard" onClick={startEdit} aria-label="Dashboard anpassen">
                  <span className="hidden sm:inline">Anpassen</span>
                </Button>
              )}
            </>
          ) : (
            <>
              <Button onClick={() => (setEditing(false), setDraft(null))}>Abbrechen</Button>
              {lq.data?.source === 'personal' && <Button onClick={() => save('personal', undefined, null)}>Auf Vorlage zurücksetzen</Button>}
              <Button variant="primary" icon="Save" onClick={() => save('personal')}>
                Für mich speichern
              </Button>
            </>
          )
        }
      />
      {live === 'reconnecting' && <Notice tone="warning">Verbindung unterbrochen. Angezeigt wird der zuletzt bestätigte Stand; nach der Wiederverbindung wird neu geladen.</Notice>}
      {editing && draft && (
        <Card title="Dashboard anpassen" subtitle="Widgets ziehen, Größe wählen und festlegen, was auf dem Handy erscheint.">
          <div className="flex flex-col gap-4 text-sm">
            {hidden.length > 0 && (
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-fg-muted">Hinzufügen:</span>
                {hidden.map((id) => (
                  <Button key={id} size="sm" icon="Plus" onClick={() => update((l) => (l.desktop.push({ id, size: 'm' }), l))}>
                    {TITLES[id]}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="font-medium">Reihenfolge auf dem Handy</span>
              <ol className="m-0 pl-5 flex flex-col gap-1">
                {draft.mobile.filter((id) => available.includes(id)).map((id, i) => (
                  <li key={id} className="flex items-center gap-2">
                    <span className="flex-1">{TITLES[id]}</span>
                    <Button size="sm" iconOnly icon="ArrowUp" aria-label={`${TITLES[id]} nach oben`} disabled={i === 0} onClick={() => update((l) => (([l.mobile[i - 1], l.mobile[i]] = [l.mobile[i], l.mobile[i - 1]]), l))} />
                    <Button size="sm" iconOnly icon="ArrowDown" aria-label={`${TITLES[id]} nach unten`} disabled={i === draft.mobile.length - 1} onClick={() => update((l) => (([l.mobile[i + 1], l.mobile[i]] = [l.mobile[i], l.mobile[i + 1]]), l))} />
                  </li>
                ))}
              </ol>
            </div>
            {isPlatformAdmin && (
              <div className="flex flex-wrap gap-2 items-center border-t border-line pt-3">
                <span className="text-fg-muted">Als gemeinsame Vorlage speichern für</span>
                <Select value={shareTarget} onChange={(e) => setShareTarget(e.target.value)} className="max-w-[220px]" aria-label="Vorlage für">
                  <option value="">– wählen –</option>
                  <option value="*">alle</option>
                  <option value="editor">Redaktion</option>
                  <option value="media_manager">Medienverwaltung</option>
                  <option value="approver">Freigabe</option>
                  <option value="publisher">Veröffentlichung</option>
                  <option value="viewer">Lesezugriff</option>
                  <option value="platform_admin">Administration</option>
                </Select>
                <Button size="sm" disabled={!shareTarget} onClick={() => save(shareTarget === '*' ? 'all' : 'role', shareTarget === '*' ? undefined : shareTarget)}>
                  Vorlage speichern
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
      {(q.isLoading || lq.isLoading) && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Dashboard konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && layout && (
        <div className="grid grid-cols-12 gap-5">
          {visible.map((w, i) => {
            const link = LINKS[w.id];
            const body = <WidgetBody id={w.id} d={d} />;
            return (
              <section
                key={w.id}
                aria-label={TITLES[w.id]}
                className={cx('col-span-12', SPAN[w.size], editing && 'outline-dashed outline-2 outline-line rounded-card', dragIdx === i && 'opacity-50')}
                draggable={editing}
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => editing && dragIdx !== null && dragIdx !== i && e.preventDefault()}
                onDrop={(e) => (e.preventDefault(), dragIdx !== null && move(dragIdx, i), setDragIdx(null))}
                onDragEnd={() => setDragIdx(null)}
              >
                {editing && (
                  <div className="flex flex-wrap items-center gap-1.5 p-2 text-sm cursor-grab">
                    <Icon name="Menu" size={14} className="text-fg-muted" />
                    <span className="font-medium flex-1">{TITLES[w.id]}</span>
                    {(['s', 'm', 'l'] as Size[]).map((s) => (
                      <Button key={s} size="sm" variant={w.size === s ? 'primary' : 'secondary'} aria-pressed={w.size === s} onClick={() => update((l) => ((l.desktop[i].size = s), l))}>
                        {SIZE_LABEL[s]}
                      </Button>
                    ))}
                    <label className="flex items-center gap-1 ml-1">
                      <input
                        type="checkbox"
                        checked={draft!.mobile.includes(w.id)}
                        onChange={(e) => update((l) => ((l.mobile = e.target.checked ? [...l.mobile, w.id] : l.mobile.filter((x) => x !== w.id)), l))}
                      />
                      Handy
                    </label>
                    <Button size="sm" iconOnly icon="ArrowUp" aria-label="Nach vorne" disabled={i === 0} onClick={() => move(i, i - 1)} />
                    <Button size="sm" iconOnly icon="ArrowDown" aria-label="Nach hinten" disabled={i === visible.length - 1} onClick={() => move(i, i + 1)} />
                    <Button size="sm" iconOnly icon="X" aria-label={`${TITLES[w.id]} ausblenden`} onClick={() => update((l) => ((l.desktop = l.desktop.filter((x) => x.id !== w.id)), (l.mobile = l.mobile.filter((x) => x !== w.id)), l))} />
                  </div>
                )}
                {w.id === 'media' ? (
                  body
                ) : (
                  <Card className="h-full" title={TITLES[w.id]} action={link && !editing ? <Link to={link[0]} className="text-sm">{link[1]}</Link> : undefined}>
                    {body}
                  </Card>
                )}
              </section>
            );
          })}
          {!visible.length && <div className="col-span-12"><EmptyState icon="LayoutDashboard" title="Keine Widgets" text="Über „Anpassen“ Widgets hinzufügen." /></div>}
        </div>
      )}
      {newPost && <NewPostDialog onClose={() => setNewPost(false)} />}
      {newCollection && <NewCollectionDialog open onClose={() => setNewCollection(false)} />}
    </div>
  );
}
