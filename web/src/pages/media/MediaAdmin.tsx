import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Badge, Button, Card, EmptyState, ErrorBox, FieldWrap, PageHeader, Select, SkeletonRows, Textarea } from '../../components/ui/core';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { mediaName } from './gallery';
import { MediaNav } from './MediaNav';
import { StorageCard } from './StorageCard';


type Blocked = MediaItem & { reject_step: string | null; collection_title: string; link_label: string | null; processed_at: string | null; file_present: boolean };

const STEP_LABELS: Record<string, string> = { type: 'Dateityp', structure: 'Aufbau', limits: 'Grenzen', decode: 'Dekodierprüfung', error: 'Prüfung fehlgeschlagen' };

/** Aktionen für gesperrte Dateien – auch in der Sammlung (Reiter „In Prüfung / abgewiesen“) verwendet. */
export function useBlockedActions(onDone: () => void) {
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const [release, setRelease] = useState<{ id: string; name: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, title: string) => {
    try {
      await fn();
      toast({ tone: 'success', title });
    } catch (e) {
      toastError(e);
    }
    onDone();
  };
  return {
    recheck: (id: string) => run(() => post(`/media/${id}/recheck`), 'Wird erneut geprüft'),
    purge: async (id: string, name: string) => {
      if (!(await ask({ title: `„${name}“ endgültig löschen?`, text: 'Die gesperrte Datei wird mit ihrem Datensatz sofort entfernt.', confirmLabel: 'Endgültig löschen' }))) return;
      await run(() => post(`/media/${id}/purge`), 'Endgültig gelöscht');
    },
    forceRelease: (id: string, name: string) => setRelease({ id, name }),
    dialog: release && <ForceReleaseDialog target={release} onClose={() => setRelease(null)} onDone={() => (setRelease(null), onDone())} />,
  };
}

function ForceReleaseDialog({ target, onClose, onDone }: { target: { id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const toastError = useErrorToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Video trotzdem freigeben?"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            icon="ShieldAlert"
            loading={busy}
            disabled={reason.trim().length < 5}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/media/${target.id}/force-release`, { reason: reason.trim() });
                onDone();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            Trotzdem freigeben
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          „{target.name}“ ist nur an der Dekodierprüfung gescheitert. Beim Freigeben werden Dateityp, Aufbau, Länge und Auflösung weiter geprüft, die Dekodierprüfung entfällt. Die Freigabe steht mit Begründung im Audit und wird der Administration als Sicherheitsmeldung angezeigt.
        </p>
        <FieldWrap label="Begründung" htmlFor="fr-reason" required>
          <Textarea id="fr-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. Video der eigenen Drohne, Wiedergabe vorab geprüft" />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

/** „Medien → Verwaltung“ (nur „Medien administrieren“): gesperrte Dateien, Sicherheitsereignisse, Aufträge, Speicher. */
export default function MediaAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['media-admin'] });
  const blocked = useQuery({ queryKey: ['media-admin', 'blocked'], queryFn: () => get<Blocked[]>('/media-admin/blocked') });
  const jobs = useQuery({ queryKey: ['media-admin', 'jobs'], queryFn: () => get<any[]>('/media-admin/jobs') });
  const [event, setEvent] = useState('');
  const [page, setPage] = useState(1);
  const events = useQuery({ queryKey: ['media-admin', 'events', event, page], queryFn: () => get<any>(`/media-admin/security-events${qs({ event, page })}`) });
  const actions = useBlockedActions(refresh);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Verwaltung der Medien" subtitle="Gesperrte Dateien, Sicherheitsereignisse der Upload-Seiten, Aufträge und Speicher." />
      <MediaNav />
      <StorageCard />
      <Card
        title="Gesperrte Dateien"
        subtitle="Dateien mit Prüfbefund bleiben in der Quarantäne (nie ausgeliefert) und werden nach der Frist gelöscht. Schadsoftware wird sofort gelöscht."
        action={
          !!blocked.data?.length && (
            <Button size="sm" icon="RefreshCw" onClick={() => void post<any>('/media-admin/recheck-all').then((r) => (toast({ tone: 'success', title: `${r.count} Datei(en) werden erneut geprüft` }), refresh()), toastError)}>
              Alle erneut prüfen
            </Button>
          )
        }
        bodyClassName="!p-0"
      >
        {blocked.isLoading && <SkeletonRows rows={3} />}
        {blocked.error && <ErrorBox title="Konnte nicht geladen werden">{(blocked.error as Error).message}</ErrorBox>}
        {blocked.data && blocked.data.length === 0 && <p className="m-0 p-4 text-sm text-fg-muted">Keine gesperrten Dateien.</p>}
        <ul className="m-0 p-0 list-none divide-y divide-line">
          {(blocked.data ?? []).map((m) => (
            <li key={m.id} className="p-4 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-[240px] flex flex-col gap-1">
                <span className="font-medium break-all">{mediaName(m)}</span>
                <span className="text-sm text-err">{m.reject_reason}</span>
                <span className="text-meta text-fg-muted">
                  <Badge tone="error" dot={false}>{STEP_LABELS[m.reject_step ?? ''] ?? 'Befund'}</Badge> in <Link to={`/medien/${m.collection_id}`}>{m.collection_title}</Link>
                  {m.link_label ? ` · Link „${m.link_label}“` : ''} · {fmtRelative(m.processed_at)}
                  {!m.file_present ? ' · Datei fehlt' : ''}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon="RefreshCw" disabled={!m.file_present} onClick={() => void actions.recheck(m.id)}>
                  Erneut prüfen
                </Button>
                {m.reject_step === 'decode' && (
                  <Button size="sm" icon="ShieldAlert" disabled={!m.file_present} onClick={() => actions.forceRelease(m.id, mediaName(m))}>
                    Trotzdem freigeben
                  </Button>
                )}
                <Button size="sm" variant="danger" icon="Trash2" onClick={() => void actions.purge(m.id, mediaName(m))}>
                  Endgültig löschen
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Fehlgeschlagene Aufträge" subtitle="Prüfung, Standort-Bereinigung, öffentliche Fassung und ZIP-Downloads, die wiederholt fehlgeschlagen sind." bodyClassName="!p-0">
        {jobs.data && jobs.data.length === 0 && <p className="m-0 p-4 text-sm text-fg-muted">Keine fehlgeschlagenen Aufträge.</p>}
        <ul className="m-0 p-0 list-none divide-y divide-line">
          {(jobs.data ?? []).map((j) => (
            <li key={j.id} className="p-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[240px] flex flex-col gap-0.5">
                <span className="font-mono text-sm">
                  #{j.id} {j.kind}
                </span>
                {j.original_name && <span className="text-sm">{j.original_name}</span>}
                <span className="text-meta text-err break-all">{j.last_error}</span>
                <span className="text-meta text-fg-muted">
                  {j.status === 'dead' ? 'endgültig fehlgeschlagen' : 'wird wiederholt'} · {j.attempts} Versuch(e) · {fmtDateTime(j.updated_at)}
                </span>
              </div>
              <Button size="sm" icon="RefreshCw" onClick={() => void post(`/media-admin/jobs/${j.id}/retry`).then(() => (toast({ tone: 'success', title: 'Auftrag neu eingeplant' }), refresh()), toastError)}>
                Erneut versuchen
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Sicherheitsereignisse der Upload-Seiten" subtitle="Ohne Klar-IP (nur gekürzter Hash), ohne Token und ohne Namen. Gleiche Ereignisse höchstens einmal in 10 Minuten." bodyClassName="flex flex-col gap-3">
        <FieldWrap label="Ereignis" htmlFor="se-event" className="max-w-[320px]">
          <Select id="se-event" value={event} onChange={(e) => (setEvent(e.target.value), setPage(1))}>
            <option value="">Alle</option>
            {Object.entries(events.data?.labels ?? {}).map(([k, v]) => (
              <option key={k} value={k}>
                {v as string}
              </option>
            ))}
          </Select>
        </FieldWrap>
        {events.data && events.data.items.length === 0 && <EmptyState icon="ShieldCheck" title="Keine Ereignisse" />}
        {events.data && events.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-fg-muted border-b border-line">
                  <th className="py-2 pr-3 font-medium">Zeit</th>
                  <th className="py-2 pr-3 font-medium">Ereignis</th>
                  <th className="py-2 pr-3 font-medium">Link</th>
                  <th className="py-2 pr-3 font-medium">Gerät</th>
                  <th className="py-2 font-medium">Einzelheiten</th>
                </tr>
              </thead>
              <tbody>
                {events.data.items.map((e: any) => (
                  <tr key={e.id} className="border-b border-line last:border-0 align-top">
                    <td className="py-2 pr-3 font-mono text-meta whitespace-nowrap">{fmtDateTime(e.at)}</td>
                    <td className="py-2 pr-3">{e.label}</td>
                    <td className="py-2 pr-3">{e.collection_id ? <Link to={`/medien/${e.collection_id}`}>{e.link_label || e.collection_title}</Link> : '–'}</td>
                    <td className="py-2 pr-3 font-mono text-meta">{e.ip_hash || '–'}</td>
                    <td className="py-2 break-all">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.data && events.data.pages > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Zurück</Button>
            <span className="font-mono">Seite {page} von {events.data.pages}</span>
            <Button size="sm" disabled={page >= events.data.pages} onClick={() => setPage(page + 1)}>Weiter</Button>
          </div>
        )}
      </Card>
      {actions.dialog}
    </div>
  );
}
