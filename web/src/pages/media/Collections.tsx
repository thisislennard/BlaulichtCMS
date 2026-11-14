import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { Button, Card, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, SkeletonRows, Switch, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

export function NewCollectionDialog({ open, onClose, postId, defaultTitle }: { open: boolean; onClose: () => void; postId?: string; defaultTitle?: string }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState(7);
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
                const r = await post<any>('/collections', { title: title.trim(), purpose: purpose.trim(), note: note.trim(), postId: postId ?? null, createLink, linkDays: days });
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
        <Switch checked={createLink} onChange={setCreateLink} label="Upload-Link gleich erstellen" description="Personen ohne Konto können damit Fotos und Videos in diese Sammlung hochladen." />
        {createLink && (
          <FieldWrap label="Gültig für (Tage)" htmlFor="c-days">
            <Input id="c-days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} className="max-w-[120px]" />
          </FieldWrap>
        )}
      </div>
    </Dialog>
  );
}

export default function Collections() {
  const { can } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const [create, setCreate] = useState(false);
  const q = useQuery({ queryKey: ['collections', showArchived], queryFn: () => get<any[]>(`/collections?archived=${showArchived}`) });
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
      <div>
        <Switch checked={showArchived} onChange={setShowArchived} label="Archivierte anzeigen" />
      </div>
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Sammlungen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon="Images"
          title="Noch keine Sammlung"
          text="Lege eine Sammlung an oder nutze im Beitrag „Fotos und Videos sammeln“."
          action={can('media.manage') && <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>Neue Sammlung</Button>}
        />
      )}
      {q.data && q.data.length > 0 && (
        <ul className="m-0 p-0 list-none grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((c) => (
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
                    <div className="text-meta text-fg-muted">angelegt {fmtRelative(c.created_at)}</div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {create && <NewCollectionDialog open onClose={() => setCreate(false)} />}
    </div>
  );
}
