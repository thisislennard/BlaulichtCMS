import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../../api/client';
import type { MediaItem, UploadLink } from '../../api/types';
import { usePageMeta } from '../../components/layout/AppShell';
import { ShareActions } from '../../components/share';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Tabs } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime, fmtRelative } from '../../lib/format';
import { newClientKey, uploadResumable } from '../../lib/upload';

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
          <dd className="m-0">im Original enthalten, in der öffentlichen Fassung entfernt</dd>
        </>
      )}
    </dl>
  );
}

/** Sichtung Datei für Datei: große Vorschau, Infos darunter, gleichwertige Buttons, Tastatur (→ auswählen, ← überspringen). */
function ReviewDialog({ items, onClose, onDecide }: { items: MediaItem[]; onClose: () => void; onDecide: (m: MediaItem, s: 'selected' | 'skipped') => Promise<void> }) {
  // Liste beim Öffnen festhalten, damit optimistische Änderungen die Reihenfolge nicht verschieben
  const [list] = useState(items);
  const [idx, setIdx] = useState(0);
  const busy = false;
  const m = list[idx];
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
              <video src={`/api/v1/media/${m.id}/public`} poster={m.has_preview ? `/api/v1/media/${m.id}/preview` : undefined} controls className="w-full max-h-[55vh] bg-black" />
            ) : (
              <MediaThumb m={m} className="w-full max-h-[55vh] aspect-[4/3] [&_img]:object-contain" />
            )}
          </div>
          <MediaInfo m={m} />
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
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const [filter, setFilter] = useState<Filter>('pending');
  const [review, setReview] = useState(false);
  const [linkDialog, setLinkDialog] = useState(false);
  const [assign, setAssign] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; progress: number }[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useQuery({
    queryKey: ['collection', id],
    queryFn: () => get<{ collection: any; media: MediaItem[]; links: UploadLink[]; accept: string }>(`/collections/${id}`),
    refetchInterval: (query) => ((query.state.data?.media ?? []).some((m) => m.status === 'quarantine') ? 3000 : false),
  });
  usePageMeta({ title: q.data?.collection.title, crumb: q.data?.collection.title });
  const refresh = () => qc.invalidateQueries({ queryKey: ['collection', id] });
  const manage = can('media.manage');

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
  const activeLinks = q.data!.links.filter((l) => l.state === 'active');

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
        <Notice tone="primary" title="Upload läuft">
          {upload.map((u) => (
            <div key={u.name} className="text-sm">
              {u.name}: {u.progress} %
            </div>
          ))}
        </Notice>
      )}

      {manage && (
        <Card
          title="Upload-Links"
          subtitle="Personen ohne Konto laden über den Link oder QR-Code in genau diese Sammlung hoch."
          action={
            <Button size="sm" icon="Plus" onClick={() => setLinkDialog(true)} disabled={!!c.archived_at}>
              Neuer Link
            </Button>
          }
        >
          {q.data!.links.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch kein Upload-Link.</p>}
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
            {q.data!.links.map((l) => (
              <li key={l.id} className="py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={l.state} />
                  <span className="font-medium">{l.label || 'Upload-Link'}</span>
                  <span className="text-sm text-fg-muted">
                    {l.state === 'active' ? `gültig bis ${fmtDateTime(l.expires_at)}` : l.state === 'revoked' ? `widerrufen ${fmtRelative(l.revoked_at)}` : `abgelaufen ${fmtRelative(l.expires_at)}`} · {l.upload_count} von {l.max_files} Dateien
                  </span>
                </div>
                {l.state === 'active' && l.url && (
                  <div className="flex flex-wrap items-center gap-2">
                    <ShareActions
                      target={{
                        url: l.url,
                        title: c.title,
                        purpose: c.purpose || 'Fotos und Videos hochladen',
                        validUntil: l.expires_at,
                        sensitive: 'Jede Person mit diesem Link oder QR-Code kann bis zum Ablauf Dateien in diese Sammlung hochladen. Beim Widerruf verliert auch ein gedruckter Code seine Wirkung.',
                      }}
                    />
                    <Button
                      size="sm"
                      variant="danger"
                      icon="Ban"
                      onClick={async () => {
                        if (!confirm('Link widerrufen? Auch gedruckte QR-Codes funktionieren danach nicht mehr.')) return;
                        await post(`/upload-links/${l.id}/revoke`).catch(toastError);
                        refresh();
                      }}
                    >
                      Widerrufen
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {activeLinks.length === 0 && q.data!.links.length > 0 && <p className="m-0 mt-2 text-sm text-fg-muted">Kein aktiver Link – Uploads von außen sind gesperrt.</p>}
        </Card>
      )}

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
                        { label: 'Original herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/original`, '_blank') },
                        m.has_public ? { label: 'Öffentliche Fassung herunterladen', icon: 'Download', onClick: () => window.open(`/api/v1/media/${m.id}/public`, '_blank') } : null,
                        manage && m.selection !== 'pending' ? { label: 'Auswahl zurücksetzen', icon: 'Undo2', onClick: () => setSelection([m.id], 'pending').catch(toastError) } : null,
                        manage ? { label: 'Nach vorne', icon: 'ArrowUp', onClick: () => reorder(m.id, null, -1) } : null,
                        manage ? { label: 'Nach hinten', icon: 'ArrowDown', onClick: () => reorder(m.id, null, 1) } : null,
                        manage
                          ? {
                              label: 'Löschen',
                              icon: 'Trash2',
                              danger: true,
                              onClick: async () => {
                                if (!confirm(`„${m.original_name}“ endgültig löschen?`)) return;
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
      {review && <ReviewDialog items={lists.pending} onClose={() => setReview(false)} onDecide={(m, s) => setSelection([m.id], s).catch(toastError)} />}
      {linkDialog && <NewLinkDialog collectionId={id} onClose={() => (setLinkDialog(false), refresh())} />}
      {exporting && <ExportDialog collectionId={id} selectedCount={lists.selected.length} onClose={() => setExporting(false)} />}
      {assign && <AssignPostDialog collectionId={id} current={c.post_id} onClose={() => (setAssign(false), refresh())} />}
    </div>
  );
}

/** ZIP-Sammeldownload: wird im Hintergrund erzeugt, Fortschritt per Abfrage, Download läuft nach 24 h ab. */
function ExportDialog({ collectionId, selectedCount, onClose }: { collectionId: string; selectedCount: number; onClose: () => void }) {
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
          <FieldWrap label="Fassung" htmlFor="ex-var" help="Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale sind nur für den internen Gebrauch.">
            <Select id="ex-var" value={variant} onChange={(e) => setVariant(e.target.value as any)}>
              <option value="public">Öffentliche Fassung (empfohlen)</option>
              <option value="original">Originale</option>
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

function NewLinkDialog({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const toastError = useErrorToast();
  const [days, setDays] = useState(7);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Neuer Upload-Link"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/collections/${collectionId}/links`, { days, label: label.trim() });
                onClose();
              } catch (e) {
                toastError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Link erstellen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Bezeichnung" help="Nur intern sichtbar, z. B. „Aushang Gerätehaus“." htmlFor="l-label">
          <Input id="l-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </FieldWrap>
        <FieldWrap label="Gültig für (Tage)" htmlFor="l-days">
          <Input id="l-days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} className="max-w-[120px]" />
        </FieldWrap>
      </div>
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
