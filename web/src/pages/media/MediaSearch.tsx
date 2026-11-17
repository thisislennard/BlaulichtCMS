import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
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
const EMPTY: Filters = { q: '', kind: '', selection: '', status: 'ready', tag: '', collection: '', via: '', flagged: '', from: '', to: '' };

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
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [f, setF] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [moveCopy, setMoveCopy] = useState<null | { mode: 'move' | 'copy'; ids: string[] }>(null);
  const [tagging, setTagging] = useState<null | { ids: string[]; current?: string[] }>(null);
  const [zip, setZip] = useState(false);
  const tags = useTagSuggestions();
  const cols = useQuery({ queryKey: ['collections', 'targets'], queryFn: () => get<any[]>('/collections?archived=true') });
  // Suchtext verzögert übernehmen, Auswahlfelder sofort
  useEffect(() => {
    const t = setTimeout(() => (setF(draft), setPage(1)), draft.q === f.q ? 0 : 350);
    return () => clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useQuery({
    queryKey: ['media-search', f, page, prefs.perPage],
    queryFn: () => get<{ items: MediaItem[]; total: number; page: number; pages: number }>(`/media/search${qs({ ...f, page, perPage: prefs.perPage })}`),
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
  const set = (k: keyof Filters, v: string) => setDraft((d) => ({ ...d, [k]: v }));
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
      <form className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 items-end" onSubmit={(e) => e.preventDefault()} aria-label="Filter">
        <FieldWrap label="Suche" htmlFor="ms-q" className="sm:col-span-2">
          <Input id="ms-q" type="search" value={draft.q} placeholder="Name, Beschreibung, Hinweis, Sammlung oder Vorgangsnummer" onChange={(e) => set('q', e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Sammlung" htmlFor="ms-col">
          <Select id="ms-col" value={draft.collection} onChange={(e) => set('collection', e.target.value)}>
            <option value="">Alle Sammlungen</option>
            {(cols.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Schlagwort" htmlFor="ms-tag">
          <Select id="ms-tag" value={draft.tag} onChange={(e) => set('tag', e.target.value)}>
            <option value="">Alle</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name} ({t.count})
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Art" htmlFor="ms-kind">
          <Select id="ms-kind" value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">Fotos und Videos</option>
            <option value="image">Nur Fotos</option>
            <option value="video">Nur Videos</option>
          </Select>
        </FieldWrap>
        <FieldWrap label="Sichtung" htmlFor="ms-sel">
          <Select id="ms-sel" value={draft.selection} onChange={(e) => set('selection', e.target.value)}>
            <option value="">Alle</option>
            <option value="pending">Offen</option>
            <option value="selected">Ausgewählt</option>
            <option value="on_hold">Zurückgestellt</option>
            <option value="skipped">Übersprungen</option>
          </Select>
        </FieldWrap>
        <FieldWrap label="Hochgeladen" htmlFor="ms-via">
          <Select id="ms-via" value={draft.via} onChange={(e) => set('via', e.target.value)}>
            <option value="">Alle</option>
            <option value="link">Über Upload-Link</option>
            <option value="intern">Intern</option>
          </Select>
        </FieldWrap>
        <FieldWrap label="Stand" htmlFor="ms-status">
          <Select id="ms-status" value={draft.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ready">Geprüft</option>
            <option value="problems">In Prüfung / gesperrt / abgewiesen</option>
          </Select>
        </FieldWrap>
        <FieldWrap label="Eingang ab" htmlFor="ms-from">
          <Input id="ms-from" type="date" value={draft.from} onChange={(e) => set('from', e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Eingang bis" htmlFor="ms-to">
          <Input id="ms-to" type="date" value={draft.to} onChange={(e) => set('to', e.target.value)} />
        </FieldWrap>
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer h-ctl">
          <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={!!draft.flagged} onChange={(e) => set('flagged', e.target.checked ? '1' : '')} />
          Nur mit Datenschutz-Markierung
        </label>
        <Button variant="ghost" icon="X" onClick={() => setDraft(EMPTY)}>
          Filter zurücksetzen
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-fg-muted" aria-live="polite">
          {q.data ? `${q.data.total} Treffer` : ''}
        </div>
        <ViewControls view={prefs.view} setView={prefs.setView} perPage={prefs.perPage} setPerPage={(n) => (prefs.setPerPage(n), setPage(1))} />
      </div>
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
      {q.data && items.length === 0 && <EmptyState icon="Search" title="Keine Treffer" text="Filter anpassen oder zurücksetzen." />}
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
      {details && <MediaDetailsDialog mediaId={details} manage={may.organize} onClose={() => setDetails(null)} onSaved={refresh} />}
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
