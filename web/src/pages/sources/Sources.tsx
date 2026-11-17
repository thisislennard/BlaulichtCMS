import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Button, Card, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SegmentedControl, SkeletonRows } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { HelpLink, HelpTip } from '../../components/ui/HelpTip';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { safeHref } from '../../lib/url';

/** ?-Knopf: Wo finde ich die Adresse eines Feeds? */
function FeedUrlHelp() {
  return (
    <HelpTip title="Feed-Adresse finden" more="/hilfe/quellen#feed-adresse-finden">
      <ul className="m-0 pl-4 flex flex-col gap-1 list-disc">
        <li>Auf der Website nach einem Feed-Symbol oder Link „RSS“/„Feed“ suchen und dessen Adresse kopieren.</li>
        <li>WordPress-Websites: meist <code className="font-mono">https://…/feed/</code>.</li>
        <li>Im Seitenquelltext nach <code className="font-mono">rel="alternate"</code> mit <code className="font-mono">application/rss+xml</code> oder <code className="font-mono">atom+xml</code> suchen (<HelpLink href="https://www.rssboard.org/rss-autodiscovery">Erklärung</HelpLink>).</li>
      </ul>
      <p className="m-0 text-fg-muted">Übernommen wird eine Quelle nur nach einem erfolgreichen Abruf.</p>
    </HelpTip>
  );
}

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
        <FieldWrap label="Adresse des RSS- oder Atom-Feeds" htmlFor="rss-url" labelAction={<FeedUrlHelp />} help="Übernommen wird eine Quelle nur, wenn BlaulichtCMS sie erfolgreich abrufen und lesen kann.">
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

/** Name, Adresse und Abrufintervall ändern. Eine neue Adresse übernimmt der Server erst nach erfolgreichem Abruf. */
function EditFeedDialog({ feed, onClose }: { feed: any; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: feed.title as string, url: feed.url as string, intervalMin: feed.interval_min as number });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = form.title.trim().length > 0 && /^https?:\/\//.test(form.url.trim()) && form.intervalMin >= 5 && form.intervalMin <= 1440;
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title="Quelle bearbeiten"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            icon="Save"
            loading={busy}
            disabled={!valid}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await put<any>(`/rss/feeds/${feed.id}`, { title: form.title.trim(), url: form.url.trim(), intervalMin: form.intervalMin });
                toast({ tone: 'success', title: 'Quelle gespeichert', text: form.url.trim() !== feed.url ? `Neue Adresse geprüft, ${r.added} Einträge übernommen` : undefined });
                onClose();
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <FieldWrap label="Name" htmlFor="rss-e-title"><Input id="rss-e-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} /></FieldWrap>
        <FieldWrap label="Adresse des RSS- oder Atom-Feeds" htmlFor="rss-e-url" help="Eine neue Adresse wird beim Speichern abgerufen und nur übernommen, wenn sie einen lesbaren Feed liefert." labelAction={<FeedUrlHelp />}>
          <Input id="rss-e-url" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </FieldWrap>
        <FieldWrap label="Abrufintervall (Minuten)" htmlFor="rss-e-int"><Input id="rss-e-int" type="number" min={5} max={1440} value={form.intervalMin} onChange={(e) => setForm({ ...form, intervalMin: Number(e.target.value) })} className="max-w-[120px]" /></FieldWrap>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Dialog>
  );
}

export default function Sources() {
  const ask = useConfirm();
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [filter, setFilter] = useState<'new' | 'starred' | 'hidden'>('new');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const feeds = useQuery({ queryKey: ['rss', 'feeds'], queryFn: () => get<any[]>('/rss/feeds') });
  const items = useQuery({ queryKey: ['rss', 'items', filter], queryFn: () => get<any[]>(`/rss/items?filter=${filter}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['rss'] });
  const manage = can('source.manage');
  const mayItems = can('source.items');
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
        actions={manage && <Button variant="primary" icon="Plus" onClick={() => setAdding(true)}>Quelle hinzufügen</Button>}
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
                    <a href={safeHref(i.link)} target="_blank" rel="noopener noreferrer" className="font-semibold">
                      {i.title} <Icon name="ExternalLink" size={12} className="inline" />
                    </a>
                    {i.summary && <p className="m-0 text-sm text-fg-muted line-clamp-3">{i.summary}</p>}
                    {mayItems && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" icon="Sparkles" aria-pressed={!!i.starred_at} onClick={() => itemAction(i.id, i.starred_at ? 'unstar' : 'star')}>
                          {i.starred_at ? 'Gemerkt' : 'Merken'}
                        </Button>
                        <Button size="sm" icon={i.hidden_at ? 'Eye' : 'EyeOff'} onClick={() => itemAction(i.id, i.hidden_at ? 'unhide' : 'hide')}>
                          {i.hidden_at ? 'Einblenden' : 'Ausblenden'}
                        </Button>
                        {i.idea_post_id ? (
                          can('post.view') && (
                            <Button size="sm" icon="FileText" onClick={() => nav(`/beitraege/${i.idea_post_id}`)}>
                              Zur Themenidee
                            </Button>
                          )
                        ) : (
                          <Button
                            size="sm"
                            icon="Plus"
                            onClick={async () => {
                              try {
                                const r = await post<any>(`/rss/items/${i.id}/idea`);
                                if (can('post.view')) nav(`/beitraege/${r.postId}`);
                                else refresh();
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
                {!f.last_error && f.last_warning && <span className="text-meta text-warn">{f.last_warning}</span>}
                {manage && (
                  <span className="flex gap-2">
                    <Button size="sm" icon="RefreshCw" onClick={async () => (await post(`/rss/feeds/${f.id}/refresh`).catch(toastError), refresh())}>
                      Abrufen
                    </Button>
                    <Button size="sm" iconOnly icon="Pencil" aria-label={`${f.title} bearbeiten`} onClick={() => setEditing(f)} />
                    <Button size="sm" iconOnly icon="Trash2" aria-label={`${f.title} entfernen`} onClick={async () => (await ask({ title: "Quelle entfernen?", text: `„${f.title}“ und ihre gesammelten Einträge werden entfernt. Bereits übernommene Themenideen bleiben.`, confirmLabel: "Entfernen" })) && (await del(`/rss/feeds/${f.id}`).catch(toastError), refresh())} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {adding && <AddFeedDialog onClose={() => (setAdding(false), refresh())} />}
      {editing && <EditFeedDialog feed={editing} onClose={() => (setEditing(null), refresh())} />}
    </div>
  );
}
