import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../../api/client';
import { Button, Card, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SegmentedControl, SkeletonRows } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';

function AddFeedDialog({ onClose }: { onClose: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title="Quelle hinzufügen"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          {!preview ? (
            <Button
              variant="primary"
              loading={busy}
              disabled={!/^https?:\/\//.test(url)}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  setPreview(await post('/rss/preview', { url: url.trim() }));
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Vorschau laden
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="Plus"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await post<any>('/rss/feeds', { url: url.trim() });
                  toast({ tone: 'success', title: `„${r.feed.title}“ hinzugefügt`, text: `${r.added} Einträge übernommen` });
                  onClose();
                } catch (e) {
                  toastError(e);
                  setBusy(false);
                }
              }}
            >
              Quelle hinzufügen
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <FieldWrap label="Adresse des RSS- oder Atom-Feeds" htmlFor="rss-url">
          <Input id="rss-url" type="url" value={url} onChange={(e) => (setUrl(e.target.value), setPreview(null))} placeholder="https://example.org/feed.xml" />
        </FieldWrap>
        {err && <Notice tone="error">{err}</Notice>}
        {preview && (
          <div className="flex flex-col gap-2">
            <div className="font-semibold">{preview.title}</div>
            <div className="text-fg-muted">{preview.count} Einträge{preview.siteUrl ? ` · ${preview.siteUrl}` : ''}</div>
            <ul className="m-0 pl-5 flex flex-col gap-1">
              {preview.items.map((i: any, n: number) => (
                <li key={n}>
                  {i.title}
                  {i.published && <span className="text-fg-muted"> · {fmtDateTime(i.published)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export default function Sources() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [filter, setFilter] = useState<'new' | 'starred' | 'hidden'>('new');
  const [adding, setAdding] = useState(false);
  const feeds = useQuery({ queryKey: ['rss', 'feeds'], queryFn: () => get<any[]>('/rss/feeds') });
  const items = useQuery({ queryKey: ['rss', 'items', filter], queryFn: () => get<any[]>(`/rss/items?filter=${filter}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['rss'] });
  const edit = can('post.edit');
  const itemAction = async (id: string, action: string) => {
    // Merken/Ausblenden sofort zeigen, Server bestätigt im Hintergrund
    qc.setQueryData<any[]>(['rss', 'items', filter], (old) => (old ?? []).filter((i) => !(action === 'hide' && filter !== 'hidden' && i.id === id) && !(action === 'unhide' && filter === 'hidden' && i.id === id)).map((i) => (i.id === id ? { ...i, starred_at: action === 'star' ? new Date().toISOString() : action === 'unstar' ? null : i.starred_at } : i)));
    await post(`/rss/items/${id}`, { action }).catch(toastError);
    refresh();
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Quellen"
        subtitle="RSS- und Atom-Feeds als Anregung für Themen. Einträge merken, ausblenden oder als Themenidee übernehmen."
        actions={edit && <Button variant="primary" icon="Plus" onClick={() => setAdding(true)}>Quelle hinzufügen</Button>}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <SegmentedControl label="Filter" value={filter} onChange={setFilter} options={[{ value: 'new', label: 'Neu' }, { value: 'starred', label: 'Gemerkt' }, { value: 'hidden', label: 'Ausgeblendet' }]} />
          {items.isLoading && <SkeletonRows rows={5} />}
          {items.error && <ErrorBox title="Einträge konnten nicht geladen werden">{(items.error as Error).message}</ErrorBox>}
          {items.data && items.data.length === 0 && <EmptyState icon="Newspaper" title="Keine Einträge" />}
          <ul className="m-0 p-0 list-none flex flex-col gap-3">
            {(items.data ?? []).map((i) => (
              <li key={i.id}>
                <Card>
                  <div className="flex flex-col gap-2">
                    <div className="text-meta text-fg-muted">
                      {i.feed_title} · {i.published_at ? fmtRelative(i.published_at) : `abgerufen ${fmtRelative(i.fetched_at)}`}
                    </div>
                    <a href={i.link ?? '#'} target="_blank" rel="noopener noreferrer" className="font-semibold">
                      {i.title} <Icon name="ExternalLink" size={12} className="inline" />
                    </a>
                    {i.summary && <p className="m-0 text-sm text-fg-muted line-clamp-3">{i.summary}</p>}
                    {edit && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" icon="Sparkles" aria-pressed={!!i.starred_at} onClick={() => itemAction(i.id, i.starred_at ? 'unstar' : 'star')}>
                          {i.starred_at ? 'Gemerkt' : 'Merken'}
                        </Button>
                        <Button size="sm" icon={i.hidden_at ? 'Eye' : 'EyeOff'} onClick={() => itemAction(i.id, i.hidden_at ? 'unhide' : 'hide')}>
                          {i.hidden_at ? 'Einblenden' : 'Ausblenden'}
                        </Button>
                        {i.idea_post_id ? (
                          <Button size="sm" icon="FileText" onClick={() => nav(`/beitraege/${i.idea_post_id}`)}>
                            Zur Themenidee
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            icon="Plus"
                            onClick={async () => {
                              try {
                                const r = await post<any>(`/rss/items/${i.id}/idea`);
                                nav(`/beitraege/${r.postId}`);
                              } catch (e) {
                                toastError(e);
                              }
                            }}
                          >
                            Als Themenidee übernehmen
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </div>
        <Card title="Eingetragene Quellen">
          {feeds.data && feeds.data.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch keine Quelle.</p>}
          <ul className="m-0 p-0 list-none flex flex-col gap-3 text-sm">
            {(feeds.data ?? []).map((f) => (
              <li key={f.id} className="flex flex-col gap-1">
                <span className="font-medium">{f.title}</span>
                <span className="text-meta text-fg-muted break-all">{f.url}</span>
                <span className="text-meta text-fg-muted">
                  {f.item_count} Einträge · {f.last_success_at ? `aktualisiert ${fmtRelative(f.last_success_at)}` : 'noch nicht abgerufen'} · alle {f.interval_min} Min.
                </span>
                {f.last_error && <span className="text-meta text-err">{f.last_error}</span>}
                {edit && (
                  <span className="flex gap-2">
                    <Button size="sm" icon="RefreshCw" onClick={async () => (await post(`/rss/feeds/${f.id}/refresh`).catch(toastError), refresh())}>
                      Abrufen
                    </Button>
                    <Button size="sm" iconOnly icon="Trash2" aria-label={`${f.title} entfernen`} onClick={async () => confirm(`Quelle „${f.title}“ entfernen?`) && (await del(`/rss/feeds/${f.id}`).catch(toastError), refresh())} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {adding && <AddFeedDialog onClose={() => (setAdding(false), refresh())} />}
    </div>
  );
}
