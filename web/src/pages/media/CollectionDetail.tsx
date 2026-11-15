import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, del, get, patch, post } from '../../api/client';
import type { MediaItem, UploadLink } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { UploadLinksCard } from './UploadLinks';
import { Badge, Button, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Tabs } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { newClientKey, uploadResumable } from '../../lib/upload';
import { PrivacyDialog } from './PrivacyDialog';
import { Lightbox, MarkBox, MediaList, MediaThumb, mediaName, Pager, useGalleryPrefs, ViewControls, type MenuItems } from './gallery';
import { MediaDetailsDialog } from './MediaDetails';
import { ReviewDialog, type Decision } from './ReviewDialog';

type Filter = 'pending' | 'selected' | 'on_hold' | 'all' | 'problems';
type Selection = 'pending' | 'selected' | 'skipped' | 'on_hold';

function uploadInternal(collectionId: string, file: File, onProgress: (p: number) => void): Promise<unknown> {
  return uploadResumable(`/api/v1/collections/${collectionId}/upload-sessions`, file, { clientKey: newClientKey(), onProgress });
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
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useQuery({
    queryKey: ['collection', id],
    queryFn: () => get<{ collection: any; media: MediaItem[]; links: UploadLink[]; accept: string }>(`/collections/${id}`),
    refetchInterval: (query) => ((query.state.data?.media ?? []).some((m) => m.status === 'quarantine') ? 3000 : false),
  });
  usePageMeta({ title: q.data?.collection.title });
  const refresh = () => qc.invalidateQueries({ queryKey: ['collection', id] });
  const manage = can('media.manage');
  const [privacyItem, setPrivacyItem] = useState<MediaItem | null>(null);
  const setFilter = (f: Filter) => (setFilterState(f), setPage(1));

  const media = q.data?.media ?? [];
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
      toast({ tone: 'success', title: `${r.updated} Datei(en) ${body.action === 'delete' ? 'gelöscht' : 'geändert'}` });
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
    if (!(await ask({ title: 'Datei löschen?', text: `„${mediaName(m)}“ wird mit allen Fassungen gelöscht.`, confirmLabel: 'Löschen' }))) return;
    await del(`/media/${m.id}`).catch(toastError);
    refresh();
  };

  const menuFor = (m: MediaItem): MenuItems => [
    { label: 'Groß anzeigen', icon: 'Maximize2', onClick: () => setLightbox(pageItems.indexOf(m)) },
    { label: 'Details', icon: 'Info', onClick: () => setDetails(m.id) },
    // Originale können Standortdaten enthalten – nur mit „Medien verwalten“
    manage && m.status === 'ready' ? { label: 'Original herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/original`, '_blank') } : null,
    m.has_public && m.status === 'ready' ? { label: 'Öffentliche Fassung herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`, '_blank') } : null,
    manage && m.status === 'ready' ? { label: 'Datenschutz und Unkenntlichmachen', icon: 'EyeOff', onClick: () => setPrivacyItem(m) } : null,
    manage && m.status === 'ready' && m.selection !== 'on_hold' ? { label: 'Zurückstellen', icon: 'Pause', onClick: () => setSelection([m.id], 'on_hold').catch(toastError) } : null,
    manage && m.status === 'ready' && m.selection !== 'pending' ? { label: 'Auswahl zurücksetzen', icon: 'Undo2', onClick: () => setSelection([m.id], 'pending').catch(toastError) } : null,
    manage && m.status === 'ready' ? { label: 'Nach vorne', icon: 'ArrowUp', onClick: () => reorder(m.id, null, -1) } : null,
    manage && m.status === 'ready' ? { label: 'Nach hinten', icon: 'ArrowDown', onClick: () => reorder(m.id, null, 1) } : null,
    manage ? { label: 'Löschen', icon: 'Trash2', danger: true, onClick: () => void deleteOne(m) } : null,
  ];

  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Sammlung konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const c = q.data!.collection;
  const canDrag = manage && filter !== 'problems' && prefs.view === 'grid';

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
          manage && (
            <>
              <Button icon="Upload" onClick={() => fileRef.current?.click()} disabled={!!c.archived_at}>
                Hochladen
              </Button>
              {lists.all.length > 0 && (
                <Button variant={lists.pending.length ? 'primary' : 'secondary'} icon="CheckSquare" onClick={() => setReview(true)}>
                  {lists.pending.length ? `${lists.pending.length} sichten` : 'Sichten'}
                </Button>
              )}
              <Menu
                items={[
                  { label: 'Bearbeiten', icon: 'Pencil', onClick: () => setEditing(true) },
                  { label: 'Sammeldownload (ZIP)', icon: 'Download', onClick: () => setExporting({}) },
                  { label: 'Beitrag zuordnen', icon: 'FileText', onClick: () => setAssign(true) },
                  {
                    label: c.archived_at ? 'Wiederherstellen' : 'Archivieren',
                    icon: 'Archive',
                    onClick: async () => {
                      await patch(`/collections/${id}`, { archived: !c.archived_at }).catch(toastError);
                      refresh();
                    },
                  },
                  {
                    label: 'Sammlung löschen',
                    icon: 'Trash2',
                    danger: true,
                    onClick: async () => {
                      if (
                        !(await ask({
                          title: 'Sammlung endgültig löschen?',
                          text: `„${c.title}“ wird mit allen Dateien (Originale, Vorschauen, öffentliche Fassungen), Sammeldownloads und Upload-Links gelöscht. Gedruckte QR-Codes funktionieren danach nicht mehr. Das lässt sich nicht rückgängig machen; in Sicherungen bleiben die Daten bis zu deren Ablauf erhalten. Dateien, die ein laufender Beitrag verwendet, verhindern die Löschung.`,
                          confirmLabel: 'Endgültig löschen',
                        }))
                      )
                        return;
                      try {
                        const r = await del<{ media: number }>(`/collections/${id}`);
                        toast({ tone: 'success', title: 'Sammlung gelöscht', text: `${r.media} Datei(en) entfernt.` });
                        qc.removeQueries({ queryKey: ['collection', id] });
                        navigate('/medien');
                      } catch (e) {
                        toastError(e);
                      }
                    },
                  },
                ]}
              />
            </>
          )
        }
      />
      <input
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
              await uploadInternal(id, files[i], (p) => setUpload((u) => u && u.map((x, j) => (j === i ? { ...x, progress: p } : x))));
            } catch (err) {
              failed++;
              toastError(err);
            }
          }
          setUpload(null);
          toast({ tone: failed ? 'warning' : 'success', title: `${files.length - failed} Datei(en) hochgeladen`, text: 'Sie werden jetzt geprüft.' });
          refresh();
        }}
      />
      {upload && (
        <Notice title="Upload läuft">
          {upload.map((u) => (
            <div key={u.name} className="text-sm">
              {u.name}: {u.progress} %
            </div>
          ))}
        </Notice>
      )}

      {manage && <UploadLinksCard collection={c} links={q.data!.links} onChanged={refresh} />}

      <Tabs
        label="Medien filtern"
        value={filter}
        onChange={setFilter}
        tabs={[
          { value: 'pending', label: 'Zu sichten', count: lists.pending.length },
          { value: 'selected', label: 'Ausgewählt', count: lists.selected.length },
          ...(lists.on_hold.length ? [{ value: 'on_hold' as const, label: 'Zurückgestellt', count: lists.on_hold.length }] : []),
          { value: 'all', label: 'Alle', count: lists.all.length },
          { value: 'problems', label: 'In Prüfung / abgewiesen', count: lists.problems.length },
        ]}
      />
      {current.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2 text-sm">
            {manage && (
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
          <ViewControls view={prefs.view} setView={prefs.setView} perPage={prefs.perPage} setPerPage={(n) => (prefs.setPerPage(n), setPage(1))} />
        </div>
      )}
      {manage && marked.size > 0 && (
        <div role="region" aria-label="Sammelaktionen" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 p-2.5 rounded-card border border-line-strong bg-card shadow-float">
          <span className="font-mono text-sm px-1">{marked.size} markiert</span>
          <Button size="sm" icon="Check" onClick={() => void bulk({ action: 'selection', selection: 'selected' })}>Auswählen</Button>
          <Button size="sm" icon="SkipForward" onClick={() => void bulk({ action: 'selection', selection: 'skipped' })}>Überspringen</Button>
          <Button size="sm" icon="Pause" onClick={() => void bulk({ action: 'selection', selection: 'on_hold' })}>Zurückstellen</Button>
          <Button size="sm" icon="Undo2" onClick={() => void bulk({ action: 'selection', selection: 'pending' })}>Zurücksetzen</Button>
          <Button size="sm" icon="Download" onClick={() => setExporting({ ids: [...marked] })}>ZIP</Button>
          <Button
            size="sm"
            variant="danger"
            icon="Trash2"
            onClick={async () => {
              if (!(await ask({ title: `${marked.size} Datei(en) löschen?`, text: 'Die markierten Dateien werden mit allen Fassungen gelöscht. Dateien in laufenden Beiträgen verhindern die Aktion.', confirmLabel: 'Löschen' }))) return;
              await bulk({ action: 'delete' });
            }}
          >
            Löschen
          </Button>
          <Button size="sm" variant="ghost" icon="X" onClick={() => setMarked(new Set())}>Markierung aufheben</Button>
        </div>
      )}
      {current.length === 0 ? (
        <EmptyState icon="Images" title={filter === 'pending' ? 'Nichts zu sichten' : 'Keine Dateien'} text={filter === 'pending' && media.length === 0 ? 'Teile den Upload-Link oder lade selbst Dateien hoch.' : undefined} />
      ) : prefs.view === 'list' ? (
        <MediaList items={pageItems} marked={manage ? marked : undefined} onMark={manage ? mark : undefined} onOpen={setLightbox} menu={menuFor} />
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
              {manage && <MarkBox checked={marked.has(m.id)} onChange={(v) => mark(m.id, v)} label={`${mediaName(m)} markieren`} className="absolute top-1 left-1 z-[1] bg-card/90" />}
              <button type="button" className="block p-0 border-0 bg-transparent" onClick={() => setLightbox(i)} aria-label={`${mediaName(m)} groß anzeigen`}>
                <MediaThumb m={m} className="aspect-square" />
              </button>
              <div className="p-2 flex flex-col gap-1.5 text-sm">
                <div className="truncate" title={m.original_name}>
                  {mediaName(m)}
                </div>
                {m.duplicate_of && <Badge tone="warning" className="self-start">Duplikat</Badge>}
                {(m.status === 'rejected' || m.status === 'blocked') && <div className="text-err text-meta">{m.reject_reason}</div>}
                <div className="flex items-center gap-1 flex-wrap">
                  {m.status === 'ready' && m.selection !== 'pending' && <StatusBadge status={m.selection!} />}
                  {manage && m.status === 'ready' && (
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
      {details && <MediaDetailsDialog mediaId={details} manage={manage} onClose={() => setDetails(null)} onSaved={refresh} />}
      {privacyItem && <PrivacyDialog m={privacyItem} onClose={() => setPrivacyItem(null)} onSaved={() => refresh()} />}
      {exporting && <ExportDialog collectionId={id} selectedCount={lists.selected.length} ids={exporting.ids} originals={manage} onClose={() => setExporting(null)} />}
      {assign && <AssignPostDialog collectionId={id} current={c.post_id} onClose={() => (setAssign(false), refresh())} />}
      {editing && <EditCollectionDialog collection={c} onClose={() => (setEditing(false), refresh())} />}
    </div>
  );
}

/** ZIP-Sammeldownload: wird im Hintergrund erzeugt, Fortschritt per Abfrage, Download läuft nach Ablauf der Frist ab. */
function ExportDialog({ collectionId, selectedCount, ids, originals, onClose }: { collectionId: string; selectedCount: number; ids?: string[]; originals: boolean; onClose: () => void }) {
  const toastError = useErrorToast();
  const [selection, setSelection] = useState<'selected' | 'all' | 'ids'>(ids?.length ? 'ids' : selectedCount ? 'selected' : 'all');
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
            <Button variant="primary" icon="Download" onClick={async () => setJob(await post<any>(`/collections/${collectionId}/exports`, { selection, variant, ...(selection === 'ids' ? { ids } : {}) }).catch((e) => (toastError(e), null)))}>
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
            </Select>
          </FieldWrap>
          <FieldWrap label="Fassung" htmlFor="ex-var" help={originals ? 'Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale sind nur für den internen Gebrauch.' : 'Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale dürfen nur Personen mit „Medien verwalten“ herunterladen.'}>
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
function EditCollectionDialog({ collection, onClose }: { collection: { id: string; title: string; purpose: string; note: string }; onClose: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [v, setV] = useState({ title: collection.title, purpose: collection.purpose ?? '', note: collection.note ?? '' });
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
                await patch(`/collections/${collection.id}`, { title: v.title.trim(), purpose: v.purpose.trim(), note: v.note.trim() });
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
      </div>
    </Dialog>
  );
}
