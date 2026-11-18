import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, del, get, patch, post } from '../../api/client';
import type { MediaItem, UploadLink } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { UploadLinksCard } from './UploadLinks';
import { Badge, Button, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Tabs } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime, plural } from '../../lib/format';
import { newClientKey, uploadResumable } from '../../lib/upload';
import { openFaces, PrivacyDialog } from './PrivacyDialog';
import { Lightbox, MarkBox, MediaList, MediaThumb, mediaName, Pager, useGalleryPrefs, ViewControls, type MenuItems } from './gallery';
import { MediaDetailsDialog } from './MediaDetails';
import { ReviewDialog, type Decision } from './ReviewDialog';
import { descendantIds, FolderBar, FolderOptions, MoveCopyDialog, TagsDialog, type Folder } from './organize';
import { useBlockedActions } from './MediaAdmin';

type Filter = 'pending' | 'selected' | 'on_hold' | 'all' | 'problems';
type Selection = 'pending' | 'selected' | 'skipped' | 'on_hold';

function uploadInternal(collectionId: string, file: File, onProgress: (p: number) => void, folderId: string | null): Promise<unknown> {
  return uploadResumable(`/api/v1/collections/${collectionId}/upload-sessions`, file, { clientKey: newClientKey(), onProgress, extra: folderId ? { folderId } : undefined });
}

export default function CollectionDetail() {
  const ask = useConfirm();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const prefs = useGalleryPrefs();
  const [filter, setFilterState] = useState<Filter>('pending');
  const [page, setPage] = useState(1);
  const [review, setReview] = useState(false);
  const [assign, setAssign] = useState(false);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState<null | { ids?: string[] }>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; progress: number }[] | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [moveCopy, setMoveCopy] = useState<null | { mode: 'move' | 'copy'; ids: string[] }>(null);
  const [tagging, setTagging] = useState<null | { ids: string[]; current?: string[] }>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [deep, setDeep] = useState(false);
  const [params, setParams] = useSearchParams();
  const folder = params.get('ordner');
  const openFolder = (fid: string | null) => {
    const p = new URLSearchParams(params);
    if (fid) p.set('ordner', fid);
    else p.delete('ordner');
    setParams(p);
    setPage(1);
    setMarked(new Set());
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useQuery({
    queryKey: ['collection', id],
    queryFn: () => get<{ collection: any; media: MediaItem[]; folders: Folder[]; links: UploadLink[]; accept: string }>(`/collections/${id}`),
    refetchInterval: (query) => ((query.state.data?.media ?? []).some((m) => m.status === 'quarantine') ? 3000 : false),
  });
  usePageMeta({ title: q.data?.collection.title });
  const refresh = () => qc.invalidateQueries({ queryKey: ['collection', id] });
  // Jede Aktion hängt an genau dem Recht, das der Server dafür verlangt
  const may = {
    upload: can('media.upload'),
    links: can('media.links'),
    review: can('media.review'),
    organize: can('media.organize'),
    redact: can('media.redact'),
    trash: can('media.trash'),
    collections: can('media.collections'),
    originals: can('media.download_original'),
    export: can('media.export'),
  };
  const canMark = may.review || may.organize || may.trash || may.export;
  const [privacyItem, setPrivacyItem] = useState<MediaItem | null>(null);
  const setFilter = (f: Filter) => (setFilterState(f), setPage(1));
  const mediaAdmin = can('media.admin');
  const blockedActions = useBlockedActions(() => refresh());

  const allMedia = q.data?.media ?? [];
  const folders = q.data?.folders ?? [];
  // Ohne Ordner: alle Dateien wie bisher. Mit Ordnern: Inhalt des aktuellen Ordners (optional samt Unterordnern)
  const media = useMemo(() => {
    let list = allMedia;
    if (folders.length) {
      const inScope = new Set<string | null>([folder, ...(deep && folder ? descendantIds(folders, folder) : [])]);
      list = deep && !folder ? list : list.filter((m) => inScope.has(m.folder_id ?? null));
    }
    if (tagFilter) list = list.filter((m) => (m.tags ?? []).includes(tagFilter));
    return list;
  }, [allMedia, folders, folder, deep, tagFilter]);
  const folderCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of folders) {
      const scope = new Set([f.id, ...descendantIds(folders, f.id)]);
      out[f.id] = allMedia.filter((m) => m.folder_id && scope.has(m.folder_id)).length;
    }
    return out;
  }, [allMedia, folders]);
  const tagsInCollection = useMemo(() => [...new Set(allMedia.flatMap((m) => m.tags ?? []))].sort((a, b) => a.localeCompare(b, 'de')), [allMedia]);
  const lists = useMemo(
    () => ({
      pending: media.filter((m) => m.status === 'ready' && m.selection === 'pending'),
      selected: media.filter((m) => m.status === 'ready' && m.selection === 'selected'),
      on_hold: media.filter((m) => m.status === 'ready' && m.selection === 'on_hold'),
      all: media.filter((m) => m.status === 'ready'),
      problems: media.filter((m) => m.status !== 'ready'),
    }),
    [media],
  );
  // Schnellaktion „Sichten“ am Handy (/medien/<id>?sichten=1, #264): Sichtung gleich öffnen
  const wantsReview = params.get('sichten') === '1';
  useEffect(() => {
    if (!wantsReview || !q.data) return;
    if (may.review && lists.all.length > 0) setReview(true);
    const next = new URLSearchParams(params);
    next.delete('sichten');
    setParams(next, { replace: true });
  }, [wantsReview, q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = lists[filter];
  const pages = Math.max(1, Math.ceil(current.length / prefs.perPage));
  const pageItems = current.slice((Math.min(page, pages) - 1) * prefs.perPage, Math.min(page, pages) * prefs.perPage);
  // Markierungen auf noch vorhandene Dateien beschränken (z. B. nach Löschen)
  useEffect(() => {
    if (!marked.size) return;
    const ids = new Set(media.map((m) => m.id));
    if ([...marked].some((x) => !ids.has(x))) setMarked(new Set([...marked].filter((x) => ids.has(x))));
  }, [media, marked]);
  const mark = (mid: string, v: boolean) => setMarked((s) => {
    const n = new Set(s);
    if (v) n.add(mid);
    else n.delete(mid);
    return n;
  });
  const allOnPage = pageItems.length > 0 && pageItems.every((m) => marked.has(m.id));

  // Sichtung reagiert sofort (Auswahl ist keine Freigabe); der Server bestätigt im Hintergrund, bei Fehler wird neu geladen
  const setSelection = async (ids: string[], selection: Selection, versions?: Record<string, number>) => {
    qc.setQueryData<any>(['collection', id], (old: any) => (old ? { ...old, media: old.media.map((m: MediaItem) => (ids.includes(m.id) ? { ...m, selection } : m)) } : old));
    try {
      const r = await post<{ versions: Record<string, number> }>('/media/selection', { ids, selection, versions });
      qc.setQueryData<any>(['collection', id], (old: any) => (old ? { ...old, media: old.media.map((m: MediaItem) => (r.versions[m.id] != null ? { ...m, selection_version: r.versions[m.id] } : m)) } : old));
    } catch (e) {
      await refresh();
      throw e;
    }
  };
  const bulk = async (body: { action: 'selection' | 'delete'; selection?: Selection }) => {
    const ids = [...marked];
    try {
      const r = await post<{ updated: number }>('/media/bulk', { ids, ...body });
      toast({ tone: 'success', title: `${plural(r.updated, 'Datei', 'Dateien')} ${body.action === 'delete' ? 'im Papierkorb' : 'geändert'}` });
      setMarked(new Set());
    } catch (e) {
      toastError(e);
    }
    refresh();
  };

  /** Neue Reihenfolge speichern (Drag-and-drop oder Menü „nach vorne/hinten“) – sofort sichtbar, Server bestätigt. */
  const reorder = async (movedId: string, targetId: string | null, dir?: -1 | 1) => {
    const all = (q.data?.media ?? []).map((m) => m.id);
    const from = all.indexOf(movedId);
    if (from < 0) return;
    all.splice(from, 1);
    let to = targetId ? all.indexOf(targetId) : from + (dir ?? 0);
    if (targetId && dir === undefined && from <= to) to++;
    to = Math.max(0, Math.min(all.length, to));
    all.splice(to, 0, movedId);
    qc.setQueryData<any>(['collection', id], (old: any) => (old ? { ...old, media: all.map((mid, i) => ({ ...old.media.find((m: MediaItem) => m.id === mid), sort_order: i + 1 })) } : old));
    try {
      await post(`/collections/${id}/order`, { ids: all });
    } catch (e) {
      toastError(e);
      refresh();
    }
  };

  const deleteOne = async (m: MediaItem) => {
    if (!(await ask({ title: 'Datei in den Papierkorb?', text: `„${mediaName(m)}“ kommt in den Papierkorb und lässt sich dort bis zum Ablauf der Frist wiederherstellen.`, confirmLabel: 'In den Papierkorb' }))) return;
    await del(`/media/${m.id}`).catch(toastError);
    refresh();
  };

  const menuFor = (m: MediaItem): MenuItems => [
    { label: 'Groß anzeigen', icon: 'Maximize2', onClick: () => setLightbox(pageItems.indexOf(m)) },
    { label: 'Details', icon: 'Info', onClick: () => setDetails(m.id) },
    // Originale können Standortdaten enthalten – nur mit „Originale herunterladen“
    may.originals && m.status === 'ready' ? { label: 'Original herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/original`, '_blank') } : null,
    m.has_public && m.status === 'ready' ? { label: 'Öffentliche Fassung herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`, '_blank') } : null,
    may.redact && m.status === 'ready' ? { label: 'Datenschutz und Unkenntlichmachen', icon: 'EyeOff', onClick: () => setPrivacyItem(m) } : null,
    may.organize ? { label: 'Schlagworte', icon: 'Tags', onClick: () => setTagging({ ids: [m.id], current: m.tags ?? [] }) } : null,
    may.organize ? { label: 'Verschieben', icon: 'FolderInput', onClick: () => setMoveCopy({ mode: 'move', ids: [m.id] }) } : null,
    may.organize && m.status === 'ready' ? { label: 'Kopieren', icon: 'CopyPlus', onClick: () => setMoveCopy({ mode: 'copy', ids: [m.id] }) } : null,
    may.collections && m.status === 'ready' && m.has_preview ? { label: 'Als Titelbild', icon: 'Star', onClick: () => void patch(`/collections/${id}`, { coverMediaId: m.id }).then(() => (toast({ tone: 'success', title: 'Titelbild gesetzt' }), refresh()), toastError) } : null,
    may.review && m.status === 'ready' && m.selection !== 'on_hold' ? { label: 'Zurückstellen', icon: 'Pause', onClick: () => setSelection([m.id], 'on_hold').catch(toastError) } : null,
    may.review && m.status === 'ready' && m.selection !== 'pending' ? { label: 'Auswahl zurücksetzen', icon: 'Undo2', onClick: () => setSelection([m.id], 'pending').catch(toastError) } : null,
    may.organize && m.status === 'ready' ? { label: 'Nach vorne', icon: 'ArrowUp', onClick: () => reorder(m.id, null, -1) } : null,
    may.organize && m.status === 'ready' ? { label: 'Nach hinten', icon: 'ArrowDown', onClick: () => reorder(m.id, null, 1) } : null,
    may.trash ? { label: 'In den Papierkorb', icon: 'Trash2', danger: true, onClick: () => void deleteOne(m) } : null,
  ];

  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Sammlung konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const c = q.data!.collection;
  const canDrag = may.organize && filter !== 'problems' && prefs.view === 'grid';
  if (c.deleted_at)
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title={c.title} subtitle="Diese Sammlung liegt im Papierkorb." />
        <Notice tone="warning" title="Im Papierkorb">
          Upload-Links dieser Sammlung funktionieren nicht. Nach Ablauf der Frist wird sie endgültig gelöscht.
          {may.trash && (
            <div className="mt-2">
              <Button size="sm" icon="Undo2" onClick={() => void post('/trash/restore', { type: 'collection', id }).then(refresh, toastError)}>
                Wiederherstellen
              </Button>
            </div>
          )}
        </Notice>
      </div>
    );

  const headerMenu: MenuItems = [
    may.collections ? { label: 'Bearbeiten', icon: 'Pencil', onClick: () => setEditing(true) } : null,
    may.export ? { label: 'Sammeldownload (ZIP)', icon: 'Download', onClick: () => setExporting({}) } : null,
    may.collections && can('post.view') ? { label: 'Beitrag zuordnen', icon: 'FileText', onClick: () => setAssign(true) } : null,
    may.collections
      ? {
          label: c.archived_at ? 'Wiederherstellen' : 'Archivieren',
          icon: 'Archive',
          onClick: async () => {
            await patch(`/collections/${id}`, { archived: !c.archived_at }).catch(toastError);
            refresh();
          },
        }
      : null,
    may.trash
      ? {
          label: 'In den Papierkorb',
          icon: 'Trash2',
          danger: true,
          onClick: async () => {
            if (
              !(await ask({
                title: 'Sammlung in den Papierkorb?',
                text: `„${c.title}“ kommt mit allen Dateien in den Papierkorb. Ihre Upload-Links funktionieren dort nicht mehr; nach dem Wiederherstellen gelten sie wieder. Nach Ablauf der Frist wird alles endgültig gelöscht. Dateien, die ein laufender Beitrag verwendet, verhindern das.`,
                confirmLabel: 'In den Papierkorb',
              }))
            )
              return;
            try {
              await del<{ media: number }>(`/collections/${id}`);
              toast({ tone: 'success', title: 'Sammlung im Papierkorb', text: 'Unter Medien → Papierkorb lässt sie sich wiederherstellen.' });
              qc.removeQueries({ queryKey: ['collection', id] });
              navigate('/medien');
            } catch (e) {
              toastError(e);
            }
          },
        }
      : null,
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={c.title}
        subtitle={
          <span className="flex flex-wrap gap-x-3 gap-y-1 items-center">
            {c.purpose && <span>{c.purpose}</span>}
            {c.post_id ? (
              <Link to={`/beitraege/${c.post_id}`} className="flex items-center gap-1">
                <Icon name="FileText" size={13} /> {c.post_title}
              </Link>
            ) : (
              <span className="text-fg-muted">keinem Beitrag zugeordnet</span>
            )}
            {c.archived_at && <Badge tone="neutral">Archiviert</Badge>}
          </span>
        }
        actions={
          (may.upload || may.review || headerMenu.some(Boolean)) && (
            <>
              {may.upload && (
                <Button icon="Upload" onClick={() => fileRef.current?.click()} disabled={!!c.archived_at}>
                  Hochladen
                </Button>
              )}
              {may.review && lists.all.length > 0 && (
                <Button variant={lists.pending.length ? 'primary' : 'secondary'} icon="CheckSquare" onClick={() => setReview(true)}>
                  {lists.pending.length ? `${lists.pending.length} sichten` : 'Sichten'}
                </Button>
              )}
              {headerMenu.some(Boolean) && <Menu items={headerMenu} />}
            </>
          )
        }
      />
      {may.upload && <input
        ref={fileRef}
        type="file"
        multiple
        accept={q.data!.accept}
        className="sr-only"
        aria-label="Dateien hochladen"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (!files.length) return;
          setUpload(files.map((f) => ({ name: f.name, progress: 0 })));
          let failed = 0;
          for (let i = 0; i < files.length; i++) {
            try {
              await uploadInternal(id, files[i], (p) => setUpload((u) => u && u.map((x, j) => (j === i ? { ...x, progress: p } : x))), folder);
            } catch (err) {
              failed++;
              toastError(err);
            }
          }
          setUpload(null);
          toast({ tone: failed ? 'warning' : 'success', title: `${plural(files.length - failed, 'Datei', 'Dateien')} hochgeladen`, text: 'Sie werden jetzt geprüft.' });
          refresh();
        }}
      />}
      {upload && (
        <Notice title="Upload läuft">
          {upload.map((u) => (
            <div key={u.name} className="text-sm">
              {u.name}: {u.progress} %
            </div>
          ))}
        </Notice>
      )}

      {may.links && <UploadLinksCard collection={c} links={q.data!.links} folders={folders} onChanged={refresh} />}

      <FolderBar
        collectionId={id}
        folders={folders}
        current={folder}
        onOpen={openFolder}
        manage={may.organize}
        counts={folderCounts}
        deep={deep}
        setDeep={setDeep}
        onChanged={refresh}
        onTrash={
          may.trash
            ? (f) =>
                void del(`/folders/${f.id}`).then(
                  () => (toast({ tone: 'success', title: 'Ordner im Papierkorb' }), folder && (folder === f.id || descendantIds(folders, f.id).includes(folder)) && openFolder(f.parent_id), refresh()),
                  toastError,
                )
            : undefined
        }
      />

      <Tabs
        label="Medien filtern"
        value={filter}
        onChange={setFilter}
        tabs={[
          { value: 'pending', label: 'Zu sichten', count: lists.pending.length },
          { value: 'selected', label: 'Ausgewählt', count: lists.selected.length },
          ...(lists.on_hold.length ? [{ value: 'on_hold' as const, label: 'Zurückgestellt', count: lists.on_hold.length }] : []),
          { value: 'all', label: 'Alle', count: lists.all.length },
          { value: 'problems', label: 'In Prüfung / gesperrt', count: lists.problems.length },
        ]}
      />
      {current.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2 text-sm">
            {canMark && (
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={allOnPage} onChange={(e) => setMarked((s) => {
                  const n = new Set(s);
                  for (const m of pageItems) if (e.target.checked) n.add(m.id);
                  else n.delete(m.id);
                  return n;
                })} />
                Alle auf dieser Seite markieren
              </label>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {tagsInCollection.length > 0 && (
              <Select aria-label="Nach Schlagwort filtern" value={tagFilter} onChange={(e) => (setTagFilter(e.target.value), setPage(1))} className="!h-ctl-sm !w-auto">
                <option value="">Alle Schlagworte</option>
                {tagsInCollection.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
            <ViewControls view={prefs.view} setView={prefs.setView} perPage={prefs.perPage} setPerPage={(n) => (prefs.setPerPage(n), setPage(1))} />
          </div>
        </div>
      )}
      {canMark && marked.size > 0 && (
        <div role="region" aria-label="Sammelaktionen" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 p-2.5 rounded-card border border-line-strong bg-card shadow-float">
          <span className="font-mono text-sm px-1">{marked.size} markiert</span>
          {may.review && (
            <>
              <Button size="sm" icon="Check" onClick={() => void bulk({ action: 'selection', selection: 'selected' })}>Auswählen</Button>
              <Button size="sm" icon="SkipForward" onClick={() => void bulk({ action: 'selection', selection: 'skipped' })}>Überspringen</Button>
              <Button size="sm" icon="Pause" onClick={() => void bulk({ action: 'selection', selection: 'on_hold' })}>Zurückstellen</Button>
              <Button size="sm" icon="Undo2" onClick={() => void bulk({ action: 'selection', selection: 'pending' })}>Zurücksetzen</Button>
            </>
          )}
          {may.organize && (
            <>
              <Button size="sm" icon="Tags" onClick={() => setTagging({ ids: [...marked] })}>Schlagworte</Button>
              <Button size="sm" icon="FolderInput" onClick={() => setMoveCopy({ mode: 'move', ids: [...marked] })}>Verschieben</Button>
              <Button size="sm" icon="CopyPlus" onClick={() => setMoveCopy({ mode: 'copy', ids: [...marked] })}>Kopieren</Button>
            </>
          )}
          {may.export && <Button size="sm" icon="Download" onClick={() => setExporting({ ids: [...marked] })}>ZIP</Button>}
          {may.trash && (
            <Button
              size="sm"
              variant="danger"
              icon="Trash2"
              onClick={async () => {
                if (!(await ask({ title: `${plural(marked.size, 'Datei', 'Dateien')} in den Papierkorb?`, text: 'Die markierten Dateien kommen in den Papierkorb und lassen sich dort wiederherstellen. Dateien in laufenden Beiträgen verhindern die Aktion.', confirmLabel: 'In den Papierkorb' }))) return;
                await bulk({ action: 'delete' });
              }}
            >
              Papierkorb
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="X" onClick={() => setMarked(new Set())}>Markierung aufheben</Button>
        </div>
      )}
      {current.length === 0 ? (
        <EmptyState icon="Images" title={filter === 'pending' ? 'Nichts zu sichten' : 'Keine Dateien'} text={filter === 'pending' && media.length === 0 && (may.upload || may.links) ? 'Teile den Upload-Link oder lade selbst Dateien hoch.' : undefined} />
      ) : prefs.view === 'list' ? (
        <MediaList items={pageItems} marked={canMark ? marked : undefined} onMark={canMark ? mark : undefined} onOpen={setLightbox} menu={menuFor} />
      ) : (
        <ul className="m-0 p-0 list-none grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {pageItems.map((m, i) => (
            <li
              key={m.id}
              draggable={canDrag}
              onDragStart={(e) => (setDragId(m.id), (e.dataTransfer.effectAllowed = 'move'))}
              onDragOver={(e) => dragId && dragId !== m.id && e.preventDefault()}
              onDrop={(e) => (e.preventDefault(), dragId && dragId !== m.id && reorder(dragId, m.id), setDragId(null))}
              onDragEnd={() => setDragId(null)}
              className={cx('relative border rounded-card overflow-hidden bg-card flex flex-col', marked.has(m.id) ? 'border-primary-solid shadow-selected' : m.selection === 'selected' ? 'border-ok' : 'border-line', dragId === m.id && 'opacity-50', canDrag && 'cursor-grab')}
            >
              {canMark && <MarkBox checked={marked.has(m.id)} onChange={(v) => mark(m.id, v)} label={`${mediaName(m)} markieren`} className="absolute top-1 left-1 z-[1] bg-card/90" />}
              <button type="button" className="block p-0 border-0 bg-transparent" onClick={() => setLightbox(i)} aria-label={`${mediaName(m)} groß anzeigen`}>
                <MediaThumb m={m} className="aspect-square" />
              </button>
              <div className="p-2 flex flex-col gap-1.5 text-sm">
                <div className="truncate" title={m.original_name}>
                  {mediaName(m)}
                </div>
                {openFaces(m) > 0 &&
                  (may.redact ? (
                    <Button size="sm" icon="ScanFace" className="self-start" onClick={() => setPrivacyItem(m)}>
                      {openFaces(m) === 1 ? 'Gesicht prüfen' : `${openFaces(m)} Gesichter prüfen`}
                    </Button>
                  ) : (
                    <Badge tone="warning" className="self-start">
                      Gesichtsvorschläge offen
                    </Badge>
                  ))}
                {(m.duplicate_of || !!m.tags?.length) && (
                  <div className="flex flex-wrap gap-1">
                    {m.duplicate_of && <Badge tone="warning">Duplikat</Badge>}
                    {(m.tags ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="text-meta text-fg-muted bg-raised rounded-chip px-1.5">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {(m.status === 'rejected' || m.status === 'blocked') && <div className="text-err text-meta">{m.reject_reason}</div>}
                {m.status === 'blocked' && mediaAdmin && (
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" icon="RefreshCw" onClick={() => void blockedActions.recheck(m.id)}>
                      Erneut prüfen
                    </Button>
                    {m.reject_step === 'decode' && (
                      <Button size="sm" icon="ShieldAlert" onClick={() => blockedActions.forceRelease(m.id, mediaName(m))}>
                        Trotzdem freigeben
                      </Button>
                    )}
                    <Button size="sm" iconOnly variant="danger" icon="Trash2" aria-label={`${mediaName(m)} endgültig löschen`} onClick={() => void blockedActions.purge(m.id, mediaName(m))} />
                  </div>
                )}
                <div className="flex items-center gap-1 flex-wrap">
                  {m.status === 'ready' && m.selection !== 'pending' && <StatusBadge status={m.selection!} />}
                  {may.review && m.status === 'ready' && (
                    <>
                      {m.selection !== 'selected' && (
                        <Button size="sm" icon="Check" aria-label={`${mediaName(m)} auswählen`} onClick={() => setSelection([m.id], 'selected').catch(toastError)}>
                          Auswählen
                        </Button>
                      )}
                      {m.selection !== 'skipped' && <Button size="sm" iconOnly icon="SkipForward" aria-label={`${mediaName(m)} überspringen`} onClick={() => setSelection([m.id], 'skipped').catch(toastError)} />}
                    </>
                  )}
                  <Menu size="sm" label={`Aktionen für ${mediaName(m)}`} items={menuFor(m)} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pager page={Math.min(page, pages)} pages={pages} total={current.length} onPage={setPage} />
      {review && (
        <ReviewDialog
          ready={lists.all}
          onClose={() => setReview(false)}
          onDecide={(m: MediaItem, s: Decision) =>
            setSelection([m.id], s, { [m.id]: m.selection_version ?? 0 }).catch((e) => {
              if (e instanceof ApiError && e.status === 409) toast({ tone: 'warning', title: 'Bereits anders gesichtet', text: e.message });
              else toastError(e);
            })
          }
          onChanged={refresh}
        />
      )}
      {lightbox !== null && pageItems.length > 0 && <Lightbox items={pageItems} start={lightbox} onClose={() => setLightbox(null)} onDetails={(m) => (setLightbox(null), setDetails(m.id))} />}
      {details && <MediaDetailsDialog mediaId={details} manage={may.organize} onClose={() => setDetails(null)} onSaved={refresh} />}
      {privacyItem && <PrivacyDialog m={privacyItem} onClose={() => setPrivacyItem(null)} onSaved={() => refresh()} />}
      {blockedActions.dialog}
      {exporting && <ExportDialog collectionId={id} selectedCount={lists.selected.length} ids={exporting.ids} folders={folders} currentFolder={folder} originals={may.originals} onClose={() => setExporting(null)} />}
      {moveCopy && <MoveCopyDialog mode={moveCopy.mode} ids={moveCopy.ids} defaultCollection={id} onClose={() => setMoveCopy(null)} onDone={() => (setMoveCopy(null), setMarked(new Set()), refresh())} />}
      {tagging && <TagsDialog ids={tagging.ids} current={tagging.current} onClose={() => setTagging(null)} onDone={() => (setTagging(null), refresh(), qc.invalidateQueries({ queryKey: ['media-tags'] }))} />}
      {assign && <AssignPostDialog collectionId={id} current={c.post_id} onClose={() => (setAssign(false), refresh())} />}
      {editing && <EditCollectionDialog collection={c} onClose={() => (setEditing(false), refresh())} />}
    </div>
  );
}

/** ZIP-Sammeldownload: wird im Hintergrund erzeugt, Fortschritt per Abfrage, Download läuft nach Ablauf der Frist ab. */
function ExportDialog({ collectionId, selectedCount, ids, folders, currentFolder, originals, onClose }: { collectionId: string; selectedCount: number; ids?: string[]; folders: Folder[]; currentFolder: string | null; originals: boolean; onClose: () => void }) {
  const toastError = useErrorToast();
  const [selection, setSelection] = useState<'selected' | 'all' | 'ids' | 'folder'>(ids?.length ? 'ids' : currentFolder ? 'folder' : selectedCount ? 'selected' : 'all');
  const [folderId, setFolderId] = useState(currentFolder ?? '');
  const [withFolders, setWithFolders] = useState(true);
  const [withCsv, setWithCsv] = useState(false);
  const [variant, setVariant] = useState<'public' | 'original'>('public');
  const [job, setJob] = useState<{ id: string; files: number } | null>(null);
  const st = useQuery({ queryKey: ['export', job?.id], queryFn: () => get<any>(`/exports/${job!.id}`), enabled: !!job, refetchInterval: (q) => (q.state.data?.status === 'ready' || q.state.data?.status === 'failed' ? false : 1500) });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Sammeldownload (ZIP)"
      footer={
        !job ? (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" icon="Download" onClick={async () => setJob(await post<any>(`/collections/${collectionId}/exports`, { selection, variant, withFolders, withCsv, ...(selection === 'ids' ? { ids } : {}), ...(selection === 'folder' ? { folderId: folderId || null } : {}) }).catch((e) => (toastError(e), null)))}>
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
          <FieldWrap label="Dateien" htmlFor="ex-sel">
            <Select id="ex-sel" value={selection} onChange={(e) => setSelection(e.target.value as any)}>
              {ids?.length ? <option value="ids">Markierte Dateien ({ids.length})</option> : null}
              <option value="selected" disabled={!selectedCount}>Nur ausgewählte ({selectedCount})</option>
              <option value="all">Alle geprüften Dateien</option>
              {folders.length > 0 && <option value="folder">Ordner (inkl. Unterordner)</option>}
            </Select>
          </FieldWrap>
          {selection === 'folder' && (
            <FieldWrap label="Ordner" htmlFor="ex-folder">
              <Select id="ex-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">Oberste Ebene (ohne Ordner)</option>
                <FolderOptions folders={folders} />
              </Select>
            </FieldWrap>
          )}
          {folders.length > 0 && (
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={withFolders} onChange={(e) => setWithFolders(e.target.checked)} />
              Ordnerstruktur im ZIP beibehalten
            </label>
          )}
          <label className="inline-flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[var(--bc-primary-solid)]" checked={withCsv} onChange={(e) => setWithCsv(e.target.checked)} />
            <span>
              Metadaten-CSV beilegen (<code>metadaten.csv</code>)
              <span className="block text-meta text-fg-muted">Dateiname, Anzeigename, Beschreibung, Schlagworte, Ordner, Eingang, Größe, Prüfsumme, Sichtung, Markierungen. Angaben zu Hochladenden nur bei Originalen.</span>
            </span>
          </label>
          <FieldWrap label="Fassung" htmlFor="ex-var" help={originals ? 'Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale sind nur für den internen Gebrauch.' : 'Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale dürfen nur Personen mit dem Recht „Originale herunterladen“ laden.'}>
            <Select id="ex-var" value={variant} onChange={(e) => setVariant(e.target.value as any)}>
              <option value="public">Öffentliche Fassung (empfohlen)</option>
              <option value="original" disabled={!originals}>Originale</option>
            </Select>
          </FieldWrap>
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
          <Icon name="Hourglass" size={16} /> ZIP mit {job.files} Dateien wird erstellt … Du kannst den Dialog schließen; die Datei bleibt eine Weile verfügbar.
        </div>
      )}
    </Dialog>
  );
}

function AssignPostDialog({ collectionId, current, onClose }: { collectionId: string; current: string | null; onClose: () => void }) {
  const toastError = useErrorToast();
  const posts = useQuery({ queryKey: ['posts'], queryFn: () => get<any[]>('/posts') });
  const [value, setValue] = useState(current ?? '');
  return (
    <Dialog
      open
      onClose={onClose}
      title="Beitrag zuordnen"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            onClick={async () => {
              await patch(`/collections/${collectionId}`, { postId: value || null }).catch(toastError);
              onClose();
            }}
          >
            Speichern
          </Button>
        </>
      }
    >
      <FieldWrap label="Beitrag" htmlFor="a-post">
        <Select id="a-post" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">– keinem Beitrag zugeordnet –</option>
          {(posts.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
      </FieldWrap>
    </Dialog>
  );
}

/** Titel, Zweck und interne Notiz einer Sammlung ändern. Der Zweck steht auch auf der Upload-Seite und dem Aushang. */
function EditCollectionDialog({ collection, onClose }: { collection: { id: string; title: string; purpose: string; note: string; event_date?: string | null }; onClose: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [v, setV] = useState({ title: collection.title, purpose: collection.purpose ?? '', note: collection.note ?? '', eventDate: collection.event_date ? String(collection.event_date).slice(0, 10) : '' });
  const [busy, setBusy] = useState(false);
  const valid = v.title.trim().length >= 2;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Sammlung bearbeiten"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={async () => {
              setBusy(true);
              try {
                await patch(`/collections/${collection.id}`, { title: v.title.trim(), purpose: v.purpose.trim(), note: v.note.trim(), eventDate: v.eventDate || null });
                toast({ tone: 'success', title: 'Sammlung gespeichert' });
                onClose();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Titel" required htmlFor="ce-title" error={valid ? null : 'Mindestens 2 Zeichen.'}>
          <Input id="ce-title" value={v.title} maxLength={120} onChange={(e) => setV({ ...v, title: e.target.value })} />
        </FieldWrap>
        <FieldWrap label="Zweck" help="Steht auf der Upload-Seite und dem Aushang." htmlFor="ce-purpose">
          <Input id="ce-purpose" value={v.purpose} maxLength={300} onChange={(e) => setV({ ...v, purpose: e.target.value })} />
        </FieldWrap>
        <FieldWrap label="Hinweis für Hochladende" help="Erscheint auf der Upload-Seite." htmlFor="ce-note">
          <Input id="ce-note" value={v.note} maxLength={1000} onChange={(e) => setV({ ...v, note: e.target.value })} />
        </FieldWrap>
        <FieldWrap label="Veranstaltungsdatum (optional)" help="Sortiert die Übersicht und steht für {datum} in der Gestaltung der Upload-Seite." htmlFor="ce-date">
          <Input id="ce-date" type="date" value={v.eventDate} onChange={(e) => setV({ ...v, eventDate: e.target.value })} className="max-w-[200px]" />
        </FieldWrap>
      </div>
    </Dialog>
  );
}
