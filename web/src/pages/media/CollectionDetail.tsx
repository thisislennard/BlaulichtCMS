import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../../api/client';
import type { MediaItem, UploadLink } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { UploadLinksCard } from './UploadLinks';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Tabs } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, useErrorToast, useToast, useConfirm } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime, fmtRelative } from '../../lib/format';
import { newClientKey, uploadResumable } from '../../lib/upload';
import { PrivacyDialog, SENSITIVE_LABELS, SENSITIVE_ORDER } from './PrivacyDialog';

type Filter = 'pending' | 'selected' | 'all' | 'problems';

function MediaThumb({ m, className }: { m: MediaItem; className?: string }) {
  if (m.status !== 'ready') {
    return (
      <div className={cx('bg-raised flex flex-col items-center justify-center gap-1 text-fg-muted text-sm p-2 text-center', className)}>
        <Icon name={m.status === 'rejected' ? 'Ban' : 'Hourglass'} size={22} />
        {m.status === 'rejected' ? 'Abgewiesen' : 'Wird geprüft'}
      </div>
    );
  }
  if (!m.has_preview) {
    return (
      <div className={cx('bg-raised flex flex-col items-center justify-center gap-1 text-fg-muted text-sm', className)}>
        <Icon name={m.kind === 'video' ? 'Film' : 'ImageOff'} size={22} />
        Keine Vorschau
      </div>
    );
  }
  return (
    <div className={cx('relative bg-raised overflow-hidden', className)}>
      <img src={`/api/v1/media/${m.id}/preview`} alt={m.original_name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
      {m.kind === 'video' && (
        <span className="absolute bottom-1.5 left-1.5 bg-black/70 text-white rounded-chip px-1.5 py-0.5 text-meta flex items-center gap-1">
          <Icon name="Film" size={12} /> Video
        </span>
      )}
      {!!m.sensitive_flags?.length && (
        <span className="absolute top-1.5 right-1.5 bg-warn-soft text-warn rounded-chip px-1.5 py-0.5 text-meta flex items-center gap-1" title={m.sensitive_flags.map((f) => SENSITIVE_LABELS[f]).join(', ')}>
          <Icon name="ShieldAlert" size={12} /> {m.sensitive_flags.length > 1 ? `${m.sensitive_flags.length} Hinweise` : SENSITIVE_LABELS[m.sensitive_flags[0]]}
        </span>
      )}
    </div>
  );
}

function MediaInfo({ m }: { m: MediaItem }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      <dt className="text-fg-muted">Datei</dt>
      <dd className="m-0 truncate">{m.original_name}</dd>
      {m.size_bytes != null && (
        <>
          <dt className="text-fg-muted">Größe</dt>
          <dd className="m-0">
            {fmtBytes(m.size_bytes)}
            {m.width ? ` · ${m.width} × ${m.height}` : ''}
          </dd>
        </>
      )}
      <dt className="text-fg-muted">Eingang</dt>
      <dd className="m-0">
        {fmtDateTime(m.created_at)} · {m.via_link ? 'Upload-Link' : (m.uploaded_by_name ?? 'intern')}
      </dd>
      {m.uploader_note && (
        <>
          <dt className="text-fg-muted">Hinweis</dt>
          <dd className="m-0">{m.uploader_note}</dd>
        </>
      )}
      {m.had_location && (
        <>
          <dt className="text-fg-muted">Standort</dt>
          <dd className="m-0">{m.location_stripped ? 'beim Upload enthalten, aus Original und öffentlicher Fassung entfernt' : 'im Original enthalten, in der öffentlichen Fassung entfernt'}</dd>
        </>
      )}
      {!!m.sensitive_flags?.length && (
        <>
          <dt className="text-fg-muted">Markiert</dt>
          <dd className="m-0">{m.sensitive_flags.map((f) => SENSITIVE_LABELS[f]).join(', ')}</dd>
        </>
      )}
      {(!!m.redactions?.length || !!m.crop || m.strip_audio) && (
        <>
          <dt className="text-fg-muted">Öffentlich</dt>
          <dd className="m-0">
            {[m.redactions?.length ? `${m.redactions.length} Bereich(e) unkenntlich` : '', m.crop ? 'zugeschnitten' : '', m.strip_audio ? 'ohne Ton' : ''].filter(Boolean).join(' · ')}
          </dd>
        </>
      )}
      {m.had_location === null && (
        <>
          <dt className="text-fg-muted">Standort</dt>
          <dd className="m-0">unbekannt – das Format wird nicht ausgewertet; das Original kann Standortdaten enthalten</dd>
        </>
      )}
      {!m.had_location && m.had_location !== null && m.location_stripped && (
        <>
          <dt className="text-fg-muted">Original</dt>
          <dd className="m-0">ohne Standort-, Seriennummer- und Personenangaben gespeichert</dd>
        </>
      )}
    </dl>
  );
}

/** Sichtung Datei für Datei: große Vorschau, Infos darunter, gleichwertige Buttons, Tastatur (→ auswählen, ← überspringen). */
function ReviewDialog({ items, onClose, onDecide, onChanged }: { items: MediaItem[]; onClose: () => void; onDecide: (m: MediaItem, s: 'selected' | 'skipped') => Promise<void>; onChanged: () => void }) {
  const toastError = useErrorToast();
  // Liste beim Öffnen festhalten, damit optimistische Änderungen die Reihenfolge nicht verschieben
  const [list, setList] = useState(items);
  const [idx, setIdx] = useState(0);
  const busy = false;
  const m = list[idx];
  // Markierungen direkt in der Sichtung setzen (#118)
  const toggleFlag = async (f: (typeof SENSITIVE_ORDER)[number]) => {
    if (!m) return;
    const cur = m.sensitive_flags ?? [];
    const flags = cur.includes(f) ? cur.filter((x) => x !== f) : SENSITIVE_ORDER.filter((x) => x === f || cur.includes(x));
    setList((l) => l.map((x) => (x.id === m.id ? { ...x, sensitive_flags: flags } : x)));
    try {
      await patch(`/media/${m.id}/privacy`, { flags });
      onChanged();
    } catch (e) {
      toastError(e);
      setList((l) => l.map((x) => (x.id === m.id ? { ...x, sensitive_flags: cur } : x)));
    }
  };
  const decide = useCallback(
    (s: 'selected' | 'skipped') => {
      if (!m) return;
      // sofort weiter zur nächsten Datei; Speichern läuft im Hintergrund
      void onDecide(m, s);
      setIdx((i) => i + 1);
    },
    [m, onDecide],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') decide('selected');
      if (e.key === 'ArrowLeft') decide('skipped');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [decide]);
  // Nächste Vorschau vorladen, damit das Weiterschalten ohne Wartezeit klappt
  useEffect(() => {
    const next = list[idx + 1];
    if (next?.has_preview) new Image().src = `/api/v1/media/${next.id}/preview`;
  }, [idx, list]);
  // Wischgeste auf der Vorschau
  const start = useRef<number | null>(null);
  return (
    <Dialog open onClose={onClose} title={m ? `Sichten · ${idx + 1} von ${list.length}` : 'Sichtung abgeschlossen'} width={760}>
      {!m ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Icon name="CheckCircle2" size={36} className="text-ok" />
          <p className="m-0">Alle Dateien gesichtet.</p>
          <Button variant="primary" onClick={onClose}>
            Schließen
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div
            className="rounded-card overflow-hidden bg-raised touch-pan-y"
            onTouchStart={(e) => (start.current = e.touches[0].clientX)}
            onTouchEnd={(e) => {
              if (start.current === null) return;
              const dx = e.changedTouches[0].clientX - start.current;
              start.current = null;
              if (dx > 70) decide('selected');
              if (dx < -70) decide('skipped');
            }}
          >
            {m.kind === 'video' && m.has_public ? (
              <video src={`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`} poster={m.has_preview ? `/api/v1/media/${m.id}/preview` : undefined} controls className="w-full max-h-[55vh] bg-black" />
            ) : (
              <MediaThumb m={m} className="w-full max-h-[55vh] aspect-[4/3] [&_img]:object-contain" />
            )}
          </div>
          <MediaInfo m={m} />
          <div className="flex flex-col gap-2">
            <span className="text-label uppercase text-fg-muted">Hinweise zur Datei</span>
            <div className="flex flex-wrap gap-2">
              {SENSITIVE_ORDER.map((f) => {
                const on = (m.sensitive_flags ?? []).includes(f);
                return (
                  <Button key={f} size="sm" variant={on ? 'primary' : 'secondary'} icon={on ? 'CheckSquare' : 'Square'} aria-pressed={on} onClick={() => void toggleFlag(f)}>
                    {SENSITIVE_LABELS[f]}
                  </Button>
                );
              })}
            </div>
            <p className="m-0 text-meta text-fg-muted">Erkennbare Personen, Verletzte oder Kennzeichen? Markieren – unkenntlich machen lässt sich die Datei danach über ihr Menü („Datenschutz und Unkenntlichmachen“).</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Button size="md" icon="SkipForward" className="!h-12" disabled={busy} onClick={() => decide('skipped')}>
              Überspringen
            </Button>
            <Button size="md" variant="primary" icon="Check" className="!h-12" disabled={busy} onClick={() => decide('selected')}>
              Auswählen
            </Button>
          </div>
          <p className="m-0 text-meta text-fg-muted text-center">Tastatur: → auswählen · ← überspringen · Esc schließen. Am Handy: nach rechts oder links wischen.</p>
        </div>
      )}
    </Dialog>
  );
}

function uploadInternal(collectionId: string, file: File, onProgress: (p: number) => void): Promise<unknown> {
  return uploadResumable(`/api/v1/collections/${collectionId}/upload-sessions`, file, { clientKey: newClientKey(), onProgress });
}

export default function CollectionDetail() {
  const ask = useConfirm();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const [filter, setFilter] = useState<Filter>('pending');
  const [review, setReview] = useState(false);
  const [assign, setAssign] = useState(false);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; progress: number }[] | null>(null);
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

  const media = q.data?.media ?? [];
  const lists = useMemo(
    () => ({
      pending: media.filter((m) => m.status === 'ready' && m.selection === 'pending'),
      selected: media.filter((m) => m.status === 'ready' && m.selection === 'selected'),
      all: media.filter((m) => m.status === 'ready'),
      problems: media.filter((m) => m.status !== 'ready'),
    }),
    [media],
  );

  // Sichtung reagiert sofort (Auswahl ist keine Freigabe); der Server bestätigt im Hintergrund, bei Fehler wird neu geladen
  const setSelection = async (ids: string[], selection: 'pending' | 'selected' | 'skipped') => {
    qc.setQueryData<any>(['collection', id], (old: any) => (old ? { ...old, media: old.media.map((m: MediaItem) => (ids.includes(m.id) ? { ...m, selection } : m)) } : old));
    try {
      await post('/media/selection', { ids, selection });
    } catch (e) {
      await refresh();
      throw e;
    }
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

  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Sammlung konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const c = q.data!.collection;

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
              {lists.pending.length > 0 && (
                <Button variant="primary" icon="CheckSquare" onClick={() => setReview(true)}>
                  {lists.pending.length} sichten
                </Button>
              )}
              <Menu
                items={[
                  { label: 'Bearbeiten', icon: 'Pencil', onClick: () => setEditing(true) },
                  { label: 'Sammeldownload (ZIP)', icon: 'Download', onClick: () => setExporting(true) },
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
          { value: 'all', label: 'Alle', count: lists.all.length },
          { value: 'problems', label: 'In Prüfung / abgewiesen', count: lists.problems.length },
        ]}
      />
      {lists[filter].length === 0 ? (
        <EmptyState icon="Images" title={filter === 'pending' ? 'Nichts zu sichten' : 'Keine Dateien'} text={filter === 'pending' && media.length === 0 ? 'Teile den Upload-Link oder lade selbst Dateien hoch.' : undefined} />
      ) : (
        <ul className="m-0 p-0 list-none grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {lists[filter].map((m) => (
            <li
              key={m.id}
              draggable={manage && filter !== 'problems'}
              onDragStart={(e) => (setDragId(m.id), (e.dataTransfer.effectAllowed = 'move'))}
              onDragOver={(e) => dragId && dragId !== m.id && e.preventDefault()}
              onDrop={(e) => (e.preventDefault(), dragId && dragId !== m.id && reorder(dragId, m.id), setDragId(null))}
              onDragEnd={() => setDragId(null)}
              className={cx('border rounded-card overflow-hidden bg-card flex flex-col', m.selection === 'selected' ? 'border-ok' : 'border-line', dragId === m.id && 'opacity-50', manage && filter !== 'problems' && 'cursor-grab')}
            >
              <MediaThumb m={m} className="aspect-square" />
              <div className="p-2 flex flex-col gap-1.5 text-sm">
                <div className="truncate" title={m.original_name}>
                  {m.original_name}
                </div>
                {m.status === 'rejected' && <div className="text-err text-meta">{m.reject_reason}</div>}
                {m.status === 'ready' && (
                  <div className="flex items-center gap-1 flex-wrap">
                    {m.selection !== 'pending' && <StatusBadge status={m.selection!} />}
                    {manage && (
                      <>
                        {m.selection !== 'selected' && (
                          <Button size="sm" icon="Check" aria-label={`${m.original_name} auswählen`} onClick={() => setSelection([m.id], 'selected').catch(toastError)}>
                            Auswählen
                          </Button>
                        )}
                        {m.selection !== 'skipped' && (
                          <Button size="sm" iconOnly icon="SkipForward" aria-label={`${m.original_name} überspringen`} onClick={() => setSelection([m.id], 'skipped').catch(toastError)} />
                        )}
                      </>
                    )}
                    <Menu
                      size="sm"
                      items={[
                        // Originale können Standortdaten enthalten – nur mit „Medien verwalten“
                        manage ? { label: 'Original herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/original`, '_blank') } : null,
                        m.has_public ? { label: 'Öffentliche Fassung herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`, '_blank') } : null,
                        manage ? { label: 'Datenschutz und Unkenntlichmachen', icon: 'EyeOff', onClick: () => setPrivacyItem(m) } : null,
                        manage && m.selection !== 'pending' ? { label: 'Auswahl zurücksetzen', icon: 'Undo2', onClick: () => setSelection([m.id], 'pending').catch(toastError) } : null,
                        manage ? { label: 'Nach vorne', icon: 'ArrowUp', onClick: () => reorder(m.id, null, -1) } : null,
                        manage ? { label: 'Nach hinten', icon: 'ArrowDown', onClick: () => reorder(m.id, null, 1) } : null,
                        manage
                          ? {
                              label: 'Löschen',
                              icon: 'Trash2',
                              danger: true,
                              onClick: async () => {
                                if (!(await ask({ title: 'Datei endgültig löschen?', text: `„${m.original_name}“ wird mit allen Fassungen gelöscht.`, confirmLabel: 'Löschen' }))) return;
                                await del(`/media/${m.id}`).catch(toastError);
                                refresh();
                              },
                            }
                          : null,
                      ]}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {review && <ReviewDialog items={lists.pending} onClose={() => setReview(false)} onDecide={(m, s) => setSelection([m.id], s).catch(toastError)} onChanged={refresh} />}
      {privacyItem && <PrivacyDialog m={privacyItem} onClose={() => setPrivacyItem(null)} onSaved={() => refresh()} />}
      {exporting && <ExportDialog collectionId={id} selectedCount={lists.selected.length} originals={manage} onClose={() => setExporting(false)} />}
      {assign && <AssignPostDialog collectionId={id} current={c.post_id} onClose={() => (setAssign(false), refresh())} />}
      {editing && <EditCollectionDialog collection={c} onClose={() => (setEditing(false), refresh())} />}
    </div>
  );
}

/** ZIP-Sammeldownload: wird im Hintergrund erzeugt, Fortschritt per Abfrage, Download läuft nach 24 h ab. */
function ExportDialog({ collectionId, selectedCount, originals, onClose }: { collectionId: string; selectedCount: number; originals: boolean; onClose: () => void }) {
  const toastError = useErrorToast();
  const [selection, setSelection] = useState<'selected' | 'all'>(selectedCount ? 'selected' : 'all');
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
            <Button variant="primary" icon="Download" onClick={async () => setJob(await post<any>(`/collections/${collectionId}/exports`, { selection, variant }).catch((e) => (toastError(e), null)))}>
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
          <Icon name="Hourglass" size={16} /> ZIP mit {job.files} Dateien wird erstellt … Du kannst den Dialog schließen; die Datei bleibt 24 Stunden verfügbar.
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
