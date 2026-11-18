import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import { Button, Card, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, SkeletonRows, Switch, Textarea } from '../../components/ui/core';
import { MediaNav } from './MediaNav';
import { Pager } from './gallery';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtRelative } from '../../lib/format';
import { DEFAULT_VALIDITY, ValidityPicker, validityPayload, type Validity } from './UploadLinks';
import { useListState } from '../../lib/listState';
import { FilterEmpty, ListToolbar } from '../../components/ui/list';

/** Neue Sammlung (mit Upload-Link). Vom Dashboard aus heißt der Dialog wie die Aktion: „Fotos sammeln“ (#257). */
export function NewCollectionDialog({ open, onClose, postId, defaultTitle, title: dialogTitle }: { open: boolean; onClose: () => void; postId?: string; defaultTitle?: string; title?: string }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const mayLinks = useAuth().can('media.links');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [validity, setValidity] = useState<Validity>(DEFAULT_VALIDITY);
  const [eventDate, setEventDate] = useState('');
  const [createLink, setCreateLink] = useState(mayLinks);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={dialogTitle ?? 'Neue Sammlung'}
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
        {mayLinks && <Switch checked={createLink} onChange={setCreateLink} label="Upload-Link gleich erstellen" description="Personen ohne Konto können damit Fotos und Videos in diese Sammlung hochladen." />}
        {createLink && <ValidityPicker value={validity} onChange={setValidity} idPrefix="c" />}
      </div>
    </Dialog>
  );
}

export default function Collections() {
  const { can } = useAuth();
  // Suche, Status, Sichtung und Seite in der Adresse (#260): Zurück aus einer Sammlung zeigt dieselbe Auswahl
  const ls = useListState({ suche: '', status: 'active', sichtung: '', seite: '1' }, { tabKeys: ['status', 'seite'] });
  const status = (['active', 'archived', 'all'] as const).find((s) => s === ls.values.status) ?? 'active';
  const search = ls.values.suche;
  const page = Math.max(1, Number(ls.values.seite) || 1);
  const setPage = (p: number) => ls.set({ seite: String(p) });
  const [term, setTerm] = useState(search.trim());
  const [create, setCreate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const pending = ls.values.sichtung === 'offen';
  const q = useQuery({
    queryKey: ['collections', 'paged', status, term, page, pending],
    queryFn: () => get<{ items: any[]; total: number; page: number; pages: number }>(`/collections${qs({ paged: 1, status, q: term, page, perPage: 24, pending: pending ? 1 : undefined })}`),
    placeholderData: keepPreviousData,
  });
  const narrowed = !!term || pending || status !== 'active';
  const list = q.data?.items;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Sammlungen mit Fotos und Videos. Neue Uploads landen zuerst in der Prüfung."
        actions={
          can('media.collections') && (
            <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
              Neue Sammlung
            </Button>
          )
        }
      />
      <MediaNav />
      <ListToolbar<'active' | 'archived' | 'all'>
        search={{ value: search, onChange: (s) => ls.set({ suche: s, seite: '1' }), placeholder: 'Suchen in Sammlungen', label: 'Sammlungen durchsuchen (Titel, Zweck, Notiz)' }}
        tabs={{
          label: 'Status',
          value: status,
          onChange: (v) => ls.set({ status: v, seite: '1' }),
          options: [
            { value: 'active', label: 'Aktiv' },
            { value: 'archived', label: 'Archiviert' },
            { value: 'all', label: 'Alle' },
          ],
        }}
        filters={[{ key: 'sichtung', label: 'Sichtung', value: ls.values.sichtung, onChange: (v) => ls.set({ sichtung: v, seite: '1' }), options: [{ value: 'offen', label: 'Mit offenen Dateien' }] }]}
        count={q.data ? { n: q.data.total, one: 'Sammlung', many: 'Sammlungen' } : undefined}
        onReset={() => ls.reset(['status'])}
      />
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Sammlungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {list && list.length === 0 &&
        (narrowed ? (
          <FilterEmpty onReset={() => ls.reset()} />
        ) : (
          <EmptyState
            icon="Images"
            title="Noch keine Sammlung."
            text={can('media.collections') ? 'Lege eine Sammlung an oder nutze im Beitrag „Fotos sammeln“.' : 'Sammlungen legt die Redaktion an.'}
            action={can('media.collections') && <Button icon="Plus" onClick={() => setCreate(true)}>Neue Sammlung</Button>}
          />
        ))}
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
