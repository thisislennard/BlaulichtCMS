import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import { Button, Card, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, SegmentedControl, SkeletonRows, Switch, Textarea } from '../../components/ui/core';
import { MediaNav } from './MediaNav';
import { Pager } from './gallery';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtRelative } from '../../lib/format';
import { DEFAULT_VALIDITY, ValidityPicker, validityPayload, type Validity } from './UploadLinks';

export function NewCollectionDialog({ open, onClose, postId, defaultTitle }: { open: boolean; onClose: () => void; postId?: string; defaultTitle?: string }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [validity, setValidity] = useState<Validity>(DEFAULT_VALIDITY);
  const [eventDate, setEventDate] = useState('');
  const [createLink, setCreateLink] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Neue Sammlung"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            icon="Plus"
            loading={busy}
            disabled={title.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              try {
                const v = validityPayload(validity);
                const r = await post<any>('/collections', { title: title.trim(), purpose: purpose.trim(), note: note.trim(), postId: postId ?? null, eventDate: eventDate || null, createLink, linkDays: v.days, linkHours: v.hours, linkExpiresAt: v.expiresAt });
                onClose();
                nav(`/medien/${r.collection.id}`);
              } catch (e) {
                toastError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Sammlung anlegen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Titel" required htmlFor="c-title">
          <Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="z. B. Sommerfest 2026" />
        </FieldWrap>
        <FieldWrap label="Zweck" help="Erscheint auf der Upload-Seite und auf dem Aushang." htmlFor="c-purpose">
          <Input id="c-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} placeholder="Fotos und Videos vom Sommerfest" />
        </FieldWrap>
        <FieldWrap label="Hinweis für Hochladende" htmlFor="c-note">
          <Textarea id="c-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Bitte keine erkennbaren Personen ohne deren Einverständnis." />
        </FieldWrap>
        <FieldWrap label="Veranstaltungsdatum (optional)" htmlFor="c-date">
          <Input id="c-date" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="max-w-[200px]" />
        </FieldWrap>
        <Switch checked={createLink} onChange={setCreateLink} label="Upload-Link gleich erstellen" description="Personen ohne Konto können damit Fotos und Videos in diese Sammlung hochladen." />
        {createLink && <ValidityPicker value={validity} onChange={setValidity} idPrefix="c" />}
      </div>
    </Dialog>
  );
}

export default function Collections() {
  const { can } = useAuth();
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [create, setCreate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => (setTerm(search.trim()), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [search]);
  const q = useQuery({
    queryKey: ['collections', 'paged', status, term, page],
    queryFn: () => get<{ items: any[]; total: number; page: number; pages: number }>(`/collections${qs({ paged: 1, status, q: term, page, perPage: 24 })}`),
    placeholderData: keepPreviousData,
  });
  const list = q.data?.items;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Medien"
        subtitle="Sammlungen mit Fotos und Videos. Neue Uploads landen zuerst in der Prüfung."
        actions={
          can('media.manage') && (
            <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
              Neue Sammlung
            </Button>
          )
        }
      />
      <MediaNav />
      <div className="flex flex-wrap items-center gap-3">
        <Input type="search" aria-label="Sammlungen durchsuchen" placeholder="Sammlungen durchsuchen" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[320px]" />
        <SegmentedControl
          label="Status"
          size="sm"
          value={status}
          onChange={(v) => (setStatus(v), setPage(1))}
          options={[
            { value: 'active', label: 'Aktiv' },
            { value: 'archived', label: 'Archiviert' },
            { value: 'all', label: 'Alle' },
          ]}
        />
      </div>
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Sammlungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {list && list.length === 0 && (
        <EmptyState
          icon="Images"
          title={term || status !== 'active' ? 'Keine passende Sammlung' : 'Noch keine Sammlung'}
          text={term || status !== 'active' ? 'Suche oder Filter anpassen.' : 'Lege eine Sammlung an oder nutze im Beitrag „Fotos und Videos sammeln“.'}
          action={!term && status === 'active' && can('media.manage') && <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>Neue Sammlung</Button>}
        />
      )}
      {list && list.length > 0 && (
        <ul className="m-0 p-0 list-none grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => (
            <li key={c.id}>
              <Link to={`/medien/${c.id}`} className="block !text-fg no-underline">
                <Card className="h-full hover:border-line-strong transition-colors" bodyClassName="!p-0">
                  <div className="aspect-[16/9] bg-raised rounded-t-card overflow-hidden flex items-center justify-center">
                    {c.cover_id ? <img src={`/api/v1/media/${c.cover_id}/preview`} alt="" className="w-full h-full object-cover" loading="lazy" /> : <Icon name="Images" size={32} className="text-fg-muted" />}
                  </div>
                  <div className="p-4 flex flex-col gap-1.5">
                    <div className="font-semibold truncate">{c.title}</div>
                    {c.post_title && (
                      <div className="text-sm text-fg-muted truncate flex items-center gap-1">
                        <Icon name="FileText" size={13} /> {c.post_title}
                      </div>
                    )}
                    <div className="text-sm text-fg-muted flex flex-wrap gap-x-3 gap-y-1">
                      <span>{c.media_count} Dateien</span>
                      {c.pending_count > 0 && <span className="text-warn">{c.pending_count} zu sichten</span>}
                      {c.selected_count > 0 && <span>{c.selected_count} ausgewählt</span>}
                      {c.quarantine_count > 0 && <span>{c.quarantine_count} in Prüfung</span>}
                      {c.active_links > 0 && <span className="flex items-center gap-1"><Icon name="Link" size={12} /> {c.active_links} aktiver Link</span>}
                    </div>
                    <div className="text-meta text-fg-muted">
                      {c.event_date ? `Termin ${fmtDate(c.event_date)} · ` : ''}angelegt {fmtRelative(c.created_at)}
                      {c.archived_at ? ' · archiviert' : ''}
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pages={q.data?.pages ?? 1} total={q.data?.total ?? 0} onPage={setPage} />
      {create && <NewCollectionDialog open onClose={() => setCreate(false)} />}
    </div>
  );
}
