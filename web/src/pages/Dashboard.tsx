import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client';
import { Button, Card, EmptyState, ErrorBox, PageHeader, SkeletonRows, StatusBadge } from '../components/ui/core';
import { KpiCard } from '../components/ui/data';
import { Icon } from '../components/ui/Icon';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { NewCollectionDialog } from './media/Collections';
import { NewPostDialog } from './posts/Posts';

/** Erstes Dashboard: offene Freigaben, bestätigter Veröffentlichungsstand, Medieneingang, Websites. */
export default function Dashboard() {
  const { me, can } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/dashboard'), refetchInterval: 15_000, refetchOnWindowFocus: true });
  const [newPost, setNewPost] = useState(false);
  const [newCollection, setNewCollection] = useState(false);
  const d = q.data ?? {};
  const first = me?.user.name.split(' ')[0];
  // Schnellzugriffe der installierten App: /?aktion=beitrag bzw. /?aktion=medien
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    const a = sp.get('aktion');
    if (a === 'beitrag' && can('post.edit')) setNewPost(true);
    if (a === 'medien' && can('media.manage')) setNewCollection(true);
    if (a) setSp({}, { replace: true });
  }, [sp, setSp, can]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={first ? `Hallo ${first}` : 'Dashboard'}
        subtitle={me?.instance.organization}
        actions={
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
          </>
        }
      />
      {q.isLoading && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Dashboard konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && (
        <>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            {d.pendingApprovals && <KpiCard label="Offene Freigaben" icon="ListChecks" value={d.pendingApprovals.length} href="/freigaben" />}
            {d.readyToPublish && <KpiCard label="Bereit zur Veröffentlichung" icon="Globe" value={d.readyToPublish.length} href="/freigaben" />}
            {d.media && <KpiCard label="Uploads (24 h)" icon="UploadCloud" value={d.media.last_24h} href="/medien" />}
            {d.media && <KpiCard label="Zu sichten" icon="CheckSquare" value={d.media.unreviewed} delta={d.media.quarantine ? `${d.media.quarantine} in Prüfung` : undefined} deltaTone="muted" href="/medien" />}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {d.pendingApprovals && (
              <Card title="Offene Freigaben" action={<Link to="/freigaben" className="text-sm">Alle</Link>}>
                {d.pendingApprovals.length === 0 ? (
                  <EmptyState icon="CheckCircle2" title="Nichts offen" />
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
                    {d.pendingApprovals.map((p: any) => (
                      <li key={p.id} className="py-2.5 flex items-center gap-3">
                        <Icon name="FileText" size={16} className="text-fg-muted" />
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
                  </ul>
                )}
              </Card>
            )}

            {d.publications && (
              <Card title="Veröffentlichungen" subtitle="Bestätigter Stand der Websites">
                {d.publications.length === 0 ? (
                  <EmptyState icon="Globe" title="Noch keine Veröffentlichung" />
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
                    {d.publications.map((p: any) => (
                      <li key={p.id} className="py-2.5 flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusBadge status={p.status} />
                          <Link to={`/beitraege/${p.post_id}`} className="font-medium">
                            {p.title}
                          </Link>
                          <span className="text-meta text-fg-muted">
                            {p.site_name} · Fassung {p.revision_number}
                          </span>
                        </div>
                        {p.remote_url && (
                          <a href={p.remote_url} target="_blank" rel="noopener noreferrer" className="text-sm break-all">
                            {p.remote_url}
                          </a>
                        )}
                        {p.error && <div className="text-sm text-err">{p.error}</div>}
                        <div className="text-meta text-fg-muted">{p.result_at ? `bestätigt ${fmtDateTime(p.result_at)}` : `beauftragt ${fmtRelative(p.created_at)}`}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {d.recentCollections && (
              <Card title="Neue Uploads" subtitle="Letzte 7 Tage">
                {d.recentCollections.length === 0 ? (
                  <EmptyState icon="Images" title="Keine neuen Uploads" />
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
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
                  </ul>
                )}
              </Card>
            )}

            {d.sites && (
              <Card title="Websites" action={<Link to="/kanaele" className="text-sm">Verwalten</Link>}>
                {d.sites.length === 0 ? (
                  <EmptyState icon="Globe" title="Keine Website gekoppelt" text="Der interne Ablauf funktioniert auch ohne Website." />
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col gap-2 text-sm">
                    {d.sites.map((s: any) => (
                      <li key={s.id} className="flex items-center gap-2">
                        <StatusBadge status={s.status} labels={{ pending: 'Wartet auf Kopplung' }} />
                        <span className="font-medium">{s.name}</span>
                        <span className="text-fg-muted">{s.last_seen_at ? `zuletzt ${fmtRelative(s.last_seen_at)}` : 'noch nicht gemeldet'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </>
      )}
      {newPost && <NewPostDialog onClose={() => setNewPost(false)} />}
      {newCollection && <NewCollectionDialog open onClose={() => setNewCollection(false)} />}
    </div>
  );
}
