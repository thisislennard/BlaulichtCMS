import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Badge, Button, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime, plural } from '../../lib/format';
import { Lightbox, MarkBox, MediaList, MediaThumb, mediaName, Pager, useGalleryPrefs, ViewControls, type MenuItems } from './gallery';
import { MediaDetailsDialog } from './MediaDetails';
import { MediaNav } from './MediaNav';
import { usePageMeta } from '../../components/layout/AppShell';
import { FilterEmpty, ListToolbar } from '../../components/ui/list';
import { useListState } from '../../lib/listState';
import { MoveCopyDialog, TagsDialog, useTagSuggestions } from './organize';

interface Filters {
  q: string;
  kind: string;
  selection: string;
  status: string;
  tag: string;
  collection: string;
  via: string;
  flagged: string;
  from: string;
  to: string;
}
/** Filter ↔ Parameter der Adresse (#260), z. B. /medien/dateien?sichtung=pending&suche=brand */
const URL_KEYS: Record<keyof Filters, string> = { q: 'suche', kind: 'art', selection: 'sichtung', status: 'stand', tag: 'schlagwort', collection: 'sammlung', via: 'herkunft', flagged: 'markiert', from: 'von', to: 'bis' };
const URL_DEFAULTS = { suche: '', art: '', sichtung: '', stand: '', schlagwort: '', sammlung: '', herkunft: '', markiert: '', von: '', bis: '' };

/** Mediensuche über alle Sammlungen (wie „Medien“ in LiFeOS): Name, Typ, Sichtung, Schlagwort, Zeitraum, Hochladende. */
export default function MediaSearch() {
  const { can } = useAuth();
  usePageMeta({ title: 'Alle Dateien' });
  const navigate = useNavigate();
  const may = { review: can('media.review'), organize: can('media.organize'), trash: can('media.trash'), originals: can('media.download_original'), export: can('media.export') };
  const canMark = may.review || may.organize || may.trash || may.export;
  const qc = useQueryClient();
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const prefs = useGalleryPrefs();
  // Filter in der Adresse (#260): Zurück, Lesezeichen und die Schnellaktion „Sichten“ zeigen dieselbe Auswahl
  const ls = useListState(URL_DEFAULTS);
  const draft = Object.fromEntries((Object.keys(URL_KEYS) as (keyof Filters)[]).map((k) => [k, ls.values[URL_KEYS[k] as keyof typeof URL_DEFAULTS]])) as unknown as Filters;
  const [f, setF] = useState<Filters>(draft);
  const [page, setPage] = useState(1);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  // Verweis aus den Aktivitäten (/medien/dateien?datei=<id>, #258): Details dieser Datei öffnen
  const [params, setParams] = useSearchParams();
  const linkedFile = params.get('datei');
  const shownDetails = details ?? linkedFile;
  const closeDetails = () => {
    setDetails(null);
    if (!linkedFile) return;
    const next = new URLSearchParams(params);
    next.delete('datei');
    setParams(next, { replace: true });
  };
  const [moveCopy, setMoveCopy] = useState<null | { mode: 'move' | 'copy'; ids: string[] }>(null);
  const [tagging, setTagging] = useState<null | { ids: string[]; current?: string[] }>(null);
  const [zip, setZip] = useState(false);
  const tags = useTagSuggestions();
  const cols = useQuery({ queryKey: ['collections', 'targets'], queryFn: () => get<any[]>('/collections?archived=true') });
  // Suchtext verzögert übernehmen, Auswahlfelder sofort
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (draftKey === JSON.stringify(f)) return;
    const t = setTimeout(() => (setF(draft), setPage(1)), draft.q === f.q ? 0 : 350);
    return () => clearTimeout(t);
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useQuery({
    queryKey: ['media-search', f, page, prefs.perPage],
    queryFn: () => get<{ items: MediaItem[]; total: number; page: number; pages: number }>(`/media/search${qs({ ...f, status: f.status || 'ready', page, perPage: prefs.perPage })}`),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['media-search'] });
  const mark = (id: string, v: boolean) => setMarked((s) => {
    const n = new Set(s);
    if (v) n.add(id);
    else n.delete(id);
    return n;
  });
  const set = (k: keyof Filters, v: string) => ls.set({ [URL_KEYS[k]]: v } as Partial<typeof URL_DEFAULTS>);
  const bulkSelection = async (selection: string) => {
    try {
      const r = await post<{ updated: number }>('/media/bulk', { ids: [...marked], action: 'selection', selection });
      toast({ tone: 'success', title: `${plural(r.updated, 'Datei', 'Dateien')} geändert` });
      setMarked(new Set());
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  const menuFor = (m: MediaItem): MenuItems => [
    { label: 'Groß anzeigen', icon: 'Maximize2', onClick: () => setLightbox(items.indexOf(m)) },
    { label: 'Details', icon: 'Info', onClick: () => setDetails(m.id) },
    { label: 'Zur Sammlung', icon: 'FolderOpen', onClick: () => navigate(`/medien/${m.collection_id}${m.folder_id ? `?ordner=${m.folder_id}` : ''}`) },
    may.originals && m.status === 'ready' ? { label: 'Original herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/original`, '_blank') } : null,
    m.has_public && m.status === 'ready' ? { label: 'Öffentliche Fassung herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`, '_blank') } : null,
    may.organize ? { label: 'Schlagworte', icon: 'Tags', onClick: () => setTagging({ ids: [m.id], current: m.tags ?? [] }) } : null,
    may.organize ? { label: 'Verschieben', icon: 'FolderInput', onClick: () => setMoveCopy({ mode: 'move', ids: [m.id] }) } : null,
    may.organize && m.status === 'ready' ? { label: 'Kopieren', icon: 'CopyPlus', onClick: () => setMoveCopy({ mode: 'copy', ids: [m.id] }) } : null,
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader subtitle="Fotos und Videos über alle Sammlungen suchen und ordnen." />
      <MediaNav />
      <ListToolbar
        search={{ value: draft.q, onChange: (v) => set('q', v), placeholder: 'Suchen in allen Dateien', label: 'Dateien durchsuchen (Name, Beschreibung, Hinweis, Sammlung oder Vorgangsnummer)' }}
        filters={[
          { key: 'collection', label: 'Sammlung', value: draft.collection, onChange: (v) => set('collection', v), allLabel: 'Alle Sammlungen', options: (cols.data ?? []).map((c) => ({ value: c.id, label: c.title })) },
          { key: 'tag', label: 'Schlagwort', value: draft.tag, onChange: (v) => set('tag', v), options: tags.map((t) => ({ value: t.name, label: `${t.name} (${t.count})` })) },
          { key: 'kind', label: 'Art', value: draft.kind, onChange: (v) => set('kind', v), allLabel: 'Fotos und Videos', options: [{ value: 'image', label: 'Nur Fotos' }, { value: 'video', label: 'Nur Videos' }] },
          { key: 'selection', label: 'Sichtung', value: draft.selection, onChange: (v) => set('selection', v), options: [{ value: 'pending', label: 'Offen' }, { value: 'selected', label: 'Ausgewählt' }, { value: 'on_hold', label: 'Zurückgestellt' }, { value: 'skipped', label: 'Übersprungen' }] },
          { key: 'via', label: 'Hochgeladen', value: draft.via, onChange: (v) => set('via', v), options: [{ value: 'link', label: 'Über Upload-Link' }, { value: 'intern', label: 'Intern' }] },
          { key: 'status', label: 'Stand', value: draft.status, onChange: (v) => set('status', v), allLabel: 'Geprüft', options: [{ value: 'problems', label: 'In Prüfung / gesperrt / abgewiesen' }] },
          { key: 'flagged', label: 'Datenschutz', value: draft.flagged, onChange: (v) => set('flagged', v), options: [{ value: '1', label: 'Nur mit Datenschutz-Markierung' }] },
          { key: 'from', label: 'Eingang ab', type: 'date', value: draft.from, onChange: (v) => set('from', v) },
          { key: 'to', label: 'Eingang bis', type: 'date', value: draft.to, onChange: (v) => set('to', v) },
        ]}
        count={q.data ? { n: q.data.total, one: 'Treffer', many: 'Treffer' } : undefined}
        onReset={() => ls.reset()}
        actions={<ViewControls view={prefs.view} setView={prefs.setView} perPage={prefs.perPage} setPerPage={(n) => (prefs.setPerPage(n), setPage(1))} />}
      />
      {canMark && marked.size > 0 && (
        <div role="region" aria-label="Sammelaktionen" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 p-2.5 rounded-card border border-line-strong bg-card shadow-float">
          <span className="font-mono text-sm px-1">{marked.size} markiert</span>
          {may.review && (
            <>
              <Button size="sm" icon="Check" onClick={() => void bulkSelection('selected')}>Auswählen</Button>
              <Button size="sm" icon="Pause" onClick={() => void bulkSelection('on_hold')}>Zurückstellen</Button>
            </>
          )}
          {may.organize && (
            <>
              <Button size="sm" icon="Tags" onClick={() => setTagging({ ids: [...marked] })}>Schlagworte</Button>
              <Button size="sm" icon="FolderInput" onClick={() => setMoveCopy({ mode: 'move', ids: [...marked] })}>Verschieben</Button>
              <Button size="sm" icon="CopyPlus" onClick={() => setMoveCopy({ mode: 'copy', ids: [...marked] })}>Kopieren</Button>
            </>
          )}
          {may.export && <Button size="sm" icon="Download" onClick={() => setZip(true)}>ZIP</Button>}
          {may.trash && (
            <Button
              size="sm"
              variant="danger"
              icon="Trash2"
              onClick={async () => {
                if (!(await ask({ title: `${plural(marked.size, 'Datei', 'Dateien')} in den Papierkorb?`, text: 'Die Dateien lassen sich im Papierkorb wiederherstellen. Dateien in laufenden Beiträgen verhindern die Aktion.', confirmLabel: 'In den Papierkorb' }))) return;
                try {
                  await post('/media/bulk', { ids: [...marked], action: 'delete' });
                  setMarked(new Set());
                } catch (e) {
                  toastError(e);
                }
                refresh();
              }}
            >
              Papierkorb
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="X" onClick={() => setMarked(new Set())}>Markierung aufheben</Button>
        </div>
      )}
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Suche fehlgeschlagen">{(q.error as Error).message}</ErrorBox>}
      {q.data && items.length === 0 && (ls.changed ? <FilterEmpty onReset={() => ls.reset()} /> : <EmptyState icon="Images" title="Noch keine Dateien." text="Fotos und Videos kommen über Sammlungen und Upload-Links hierher." />)}
      {items.length > 0 &&
        (prefs.view === 'list' ? (
          <MediaList items={items} marked={canMark ? marked : undefined} onMark={canMark ? mark : undefined} onOpen={setLightbox} menu={menuFor} extraColumn={{ label: 'Sammlung', render: (m) => <Link to={`/medien/${m.collection_id}`}>{m.collection_title}</Link> }} />
        ) : (
          <ul className="m-0 p-0 list-none grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {items.map((m, i) => (
              <li key={m.id} className={cx('relative border rounded-card overflow-hidden bg-card flex flex-col', marked.has(m.id) ? 'border-primary-solid shadow-selected' : 'border-line')}>
                {canMark && <MarkBox checked={marked.has(m.id)} onChange={(v) => mark(m.id, v)} label={`${mediaName(m)} markieren`} className="absolute top-1 left-1 z-[1] bg-card/90" />}
                <button type="button" className="block p-0 border-0 bg-transparent" onClick={() => setLightbox(i)} aria-label={`${mediaName(m)} groß anzeigen`}>
                  <MediaThumb m={m} className="aspect-square" />
                </button>
                <div className="p-2 flex flex-col gap-1 text-sm min-w-0">
                  <div className="truncate font-medium" title={m.original_name}>
                    {mediaName(m)}
                  </div>
                  <Link to={`/medien/${m.collection_id}`} className="truncate text-meta !text-fg-muted">
                    <Icon name="Images" size={11} /> {m.collection_title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-1">
                    {m.status === 'ready' ? m.selection !== 'pending' && <StatusBadge status={m.selection!} /> : <StatusBadge status={m.status} />}
                    {m.duplicate_of && <Badge tone="warning">Duplikat</Badge>}
                  </div>
                  <div className="text-meta text-fg-muted font-mono">
                    {m.size_bytes != null ? fmtBytes(m.size_bytes) : ''} · {fmtDateTime(m.created_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ))}
      <Pager page={page} pages={q.data?.pages ?? 1} total={q.data?.total ?? 0} onPage={setPage} />
      {lightbox !== null && items.length > 0 && <Lightbox items={items} start={lightbox} onClose={() => setLightbox(null)} onDetails={(m) => (setLightbox(null), setDetails(m.id))} />}
      {shownDetails && <MediaDetailsDialog mediaId={shownDetails} manage={may.organize} onClose={closeDetails} onSaved={refresh} />}
      {moveCopy && <MoveCopyDialog mode={moveCopy.mode} ids={moveCopy.ids} onClose={() => setMoveCopy(null)} onDone={() => (setMoveCopy(null), setMarked(new Set()), refresh())} />}
      {tagging && <TagsDialog ids={tagging.ids} current={tagging.current} onClose={() => setTagging(null)} onDone={() => (setTagging(null), refresh(), qc.invalidateQueries({ queryKey: ['media-tags'] }))} />}
      {zip && <CrossExportDialog ids={[...marked]} originals={may.originals} onClose={() => setZip(false)} />}
    </div>
  );
}

/** ZIP aus markierten Dateien mehrerer Sammlungen: Ordner je Sammlung (und Ordnerstruktur), optional metadaten.csv. */
function CrossExportDialog({ ids, originals, onClose }: { ids: string[]; originals: boolean; onClose: () => void }) {
  const toastError = useErrorToast();
  const [variant, setVariant] = useState<'public' | 'original'>('public');
  const [withFolders, setWithFolders] = useState(true);
  const [withCsv, setWithCsv] = useState(false);
  const [job, setJob] = useState<{ id: string; files: number } | null>(null);
  const st = useQuery({ queryKey: ['export', job?.id], queryFn: () => get<any>(`/exports/${job!.id}`), enabled: !!job, refetchInterval: (x) => (x.state.data?.status === 'ready' || x.state.data?.status === 'failed' ? false : 1500) });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`ZIP aus ${plural(ids.length, 'Datei', 'Dateien')}`}
      footer={
        !job ? (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon="Download" onClick={async () => setJob(await post<any>('/exports', { ids, variant, withFolders, withCsv }).catch((e) => (toastError(e), null)))}>
              ZIP erstellen
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Schließen</Button>
        )
      }
    >
      {!job ? (
        <div className="flex flex-col gap-4 text-sm">
          <FieldWrap label="Fassung" htmlFor="cx-var">
            <Select id="cx-var" value={variant} onChange={(e) => setVariant(e.target.value as any)}>
              <option value="public">Öffentliche Fassung (empfohlen)</option>
              <option value="original" disabled={!originals}>Originale</option>
            </Select>
          </FieldWrap>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={withFolders} onChange={(e) => setWithFolders(e.target.checked)} />
            Ordnerstruktur beibehalten (je Sammlung ein Ordner)
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={withCsv} onChange={(e) => setWithCsv(e.target.checked)} />
            Metadaten-CSV beilegen
          </label>
        </div>
      ) : st.data?.status === 'ready' ? (
        <div className="flex flex-col gap-3 items-start text-sm">
          <Notice tone="success" title="ZIP ist fertig">
            {st.data.file_count} Dateien · {fmtBytes(st.data.size_bytes)} · verfügbar bis {fmtDateTime(st.data.expires_at)}
          </Notice>
          <Button variant="primary" icon="Download" onClick={() => window.open(`/api/v1/exports/${job.id}/download`, '_blank')}>
            Herunterladen
          </Button>
        </div>
      ) : st.data?.status === 'failed' ? (
        <Notice tone="error">ZIP konnte nicht erstellt werden: {st.data.error}</Notice>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <Icon name="Hourglass" size={16} /> ZIP mit {job.files} Dateien wird erstellt …
        </div>
      )}
    </Dialog>
  );
}
