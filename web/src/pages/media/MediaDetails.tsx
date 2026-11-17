import { useState } from 'react';
import { HelpTip } from '../../components/ui/HelpTip';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, patch } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Button, ErrorBox, FieldWrap, Input, SkeletonRows, StatusBadge, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { MediaThumb, mediaName } from './gallery';
import { SENSITIVE_LABELS } from './PrivacyDialog';

interface Details {
  media: MediaItem;
  sha256: string;
  collection_title: string;
  link_label: string | null;
  selection_by_name: string | null;
  selection_at: string | null;
  processed_at: string | null;
  duplicates: { id: string; collection_id: string; collection_title: string; original_name: string; display_name: string; created_at: string }[];
  posts: { id: string; title: string; current: boolean }[];
  uploader?: { name?: string; email?: string; place?: string; date?: string } | null;
  consent_at?: string | null;
}

/** Details je Datei (wie die Detailseite in LiFeOS): bearbeitbare Angaben, Prüfsumme, Duplikate, Upload, Beiträge. */
export function MediaDetailsDialog({ mediaId, manage, onClose, onSaved }: { mediaId: string; manage: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['media-details', mediaId], queryFn: () => get<Details>(`/media/${mediaId}/details`) });
  const [form, setForm] = useState<{ displayName: string; description: string; internalNote: string; altText: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const m = d?.media;
  const f = form ?? (m ? { displayName: m.display_name ?? '', description: m.description ?? '', internalNote: m.internal_note ?? '', altText: m.alt_text ?? '' } : null);
  const dirty = !!(m && f && (f.displayName !== (m.display_name ?? '') || f.description !== (m.description ?? '') || f.internalNote !== (m.internal_note ?? '') || f.altText !== (m.alt_text ?? '')));
  const row = (k: string, v: React.ReactNode) => (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className="m-0 min-w-0 break-words">{v}</dd>
    </>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={m ? `Details: ${mediaName(m)}` : 'Details'}
      width={720}
      footer={
        manage ? (
          <>
            <Button onClick={onClose}>Schließen</Button>
            <Button
              variant="primary"
              icon="Save"
              loading={busy}
              disabled={!dirty}
              onClick={async () => {
                setBusy(true);
                try {
                  await patch(`/media/${mediaId}`, f);
                  toast({ tone: 'success', title: 'Angaben gespeichert' });
                  setForm(null);
                  await q.refetch();
                  onSaved();
                } catch (e) {
                  toastError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Speichern
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Schließen</Button>
        )
      }
    >
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <ErrorBox title="Details konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {d && m && f && (
        <div className="grid gap-5 md:grid-cols-[220px_1fr]">
          <MediaThumb m={m} className="w-full aspect-square rounded-node" />
          <div className="flex flex-col gap-4 min-w-0">
            {manage ? (
              <>
                <FieldWrap label="Anzeigename" htmlFor="md-name" help="Nur intern. Der öffentliche Dateiname bleibt neutral.">
                  <Input id="md-name" value={f.displayName} maxLength={200} placeholder={m.original_name} onChange={(e) => setForm({ ...f, displayName: e.target.value })} />
                </FieldWrap>
                {m.kind === 'image' && (
                  <FieldWrap label="Alternativtext" htmlFor="md-alt" help={`Beschreibt das Bild für Menschen, die es nicht sehen (Screenreader). Öffentlich – wird für Website und soziale Netzwerke vorgeschlagen. ${f.altText.length} / 1000`} labelAction={
                    <HelpTip title="Guter Alternativtext" more="/hilfe/beitraege#alternativtext">
                      <p className="m-0">Kurz sagen, was zu sehen ist und warum es wichtig ist – z. B. „Löschfahrzeug vor dem Gerätehaus, Einsatzkräfte rollen Schläuche aus“. Nicht „Bild von …“ und keine Namen von Personen.</p>
                    </HelpTip>
                  }>
                    <Textarea id="md-alt" rows={2} maxLength={1000} value={f.altText} onChange={(e) => setForm({ ...f, altText: e.target.value })} />
                  </FieldWrap>
                )}
                <FieldWrap label="Beschreibung" htmlFor="md-desc">
                  <Textarea id="md-desc" rows={3} maxLength={2000} value={f.description} onChange={(e) => setForm({ ...f, description: e.target.value })} />
                </FieldWrap>
                <FieldWrap label="Interne Notiz" htmlFor="md-note" help="Nur für angemeldete Personen mit Zugriff auf Medien sichtbar.">
                  <Textarea id="md-note" rows={2} maxLength={2000} value={f.internalNote} onChange={(e) => setForm({ ...f, internalNote: e.target.value })} />
                </FieldWrap>
              </>
            ) : (
              (m.description || m.internal_note || m.alt_text) && (
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {m.alt_text ? row('Alternativtext', m.alt_text) : null}
                  {m.description ? row('Beschreibung', <span className="whitespace-pre-line">{m.description}</span>) : null}
                  {m.internal_note ? row('Interne Notiz', <span className="whitespace-pre-line">{m.internal_note}</span>) : null}
                </dl>
              )
            )}
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {row('Sammlung', <Link to={`/medien/${m.collection_id}`}>{d.collection_title}</Link>)}
              {row('Originalname', m.original_name)}
              {row('Typ', `${m.mime ?? 'unbekannt'}${m.width ? ` · ${m.width} × ${m.height}` : ''}`)}
              {m.size_bytes != null && row('Größe', fmtBytes(m.size_bytes))}
              {row('Prüfsumme (SHA-256)', <code className="font-mono text-meta break-all">{d.sha256}</code>)}
              {row('Eingang', `${fmtDateTime(m.created_at)} · ${m.via_link ? `Upload-Link${d.link_label ? ` „${d.link_label}“` : ''}` : (m.uploaded_by_name ?? 'intern')}`)}
              {m.upload_ref ? row('Vorgangsnummer', <span className="font-mono">{m.upload_ref}</span>) : null}
              {m.uploader_note ? row('Hinweis beim Upload', m.uploader_note) : null}
              {d.uploader?.name ? row('Name (Hochladende/r)', d.uploader.name) : null}
              {d.uploader?.email ? row('E-Mail', d.uploader.email) : null}
              {d.uploader?.place ? row('Aufnahmeort', d.uploader.place) : null}
              {d.uploader?.date ? row('Aufnahmedatum', d.uploader.date) : null}
              {d.consent_at ? row('Bestätigt', fmtDateTime(d.consent_at)) : null}
              {d.processed_at ? row('Geprüft', fmtDateTime(d.processed_at)) : null}
              {row(
                'Sichtung',
                <span className="inline-flex flex-wrap items-center gap-2">
                  <StatusBadge status={m.selection ?? 'pending'} />
                  {d.selection_at ? `${fmtDateTime(d.selection_at)}${d.selection_by_name ? ` · ${d.selection_by_name}` : ''}` : ''}
                </span>,
              )}
              {m.sensitive_flags?.length ? row('Markiert', m.sensitive_flags.map((x) => SENSITIVE_LABELS[x]).join(', ')) : null}
              {m.had_location ? row('Standort', m.location_stripped ? 'aus Original und öffentlicher Fassung entfernt' : 'im Original enthalten, öffentlich entfernt') : null}
            </dl>
            {d.duplicates.length > 0 && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-label uppercase text-fg-muted">Gleicher Inhalt (Duplikat)</span>
                <ul className="m-0 pl-4">
                  {d.duplicates.map((x) => (
                    <li key={x.id}>
                      <Link to={`/medien/${x.collection_id}`}>{x.display_name || x.original_name}</Link> in „{x.collection_title}“ · {fmtDateTime(x.created_at)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-label uppercase text-fg-muted">Verwendet in Beiträgen</span>
              {d.posts.length === 0 ? (
                <span className="text-fg-muted">noch in keinem Beitrag</span>
              ) : (
                <ul className="m-0 pl-4">
                  {d.posts.map((p) => (
                    <li key={p.id}>
                      {can('post.view') ? <Link to={`/beitraege/${p.id}`}>{p.title}</Link> : p.title}
                      {p.current ? '' : ' (frühere Fassung)'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
