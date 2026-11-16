import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Button, Card, EmptyState, ErrorBox, Notice, PageHeader, SkeletonRows } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { MediaThumb, mediaName } from './gallery';
import { MediaNav } from './MediaNav';

interface TrashData {
  days: number;
  collections: { id: string; title: string; deleted_at: string; deleted_by_name: string | null; media_count: number; purge_at: string | null }[];
  folders: { id: string; name: string; collection_id: string; collection_title: string; deleted_at: string; deleted_by_name: string | null; media_count: number; purge_at: string | null }[];
  media: (MediaItem & { deleted_at: string; deleted_by_name: string | null; purge_at: string | null })[];
}

/** Papierkorb (wie LiFeOS): Wiederherstellen mit „Medien löschen (Papierkorb)“, endgültig löschen mit „Medien administrieren“. */
export default function Trash() {
  const { can } = useAuth();
  const admin = can('media.admin');
  const qc = useQueryClient();
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['trash'], queryFn: () => get<TrashData>('/trash') });
  const refresh = () => (qc.invalidateQueries({ queryKey: ['trash'] }), qc.invalidateQueries({ queryKey: ['collections'] }));
  const restore = async (type: string, id: string) => {
    try {
      await post('/trash/restore', { type, id });
      toast({ tone: 'success', title: 'Wiederhergestellt' });
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  const purge = async (type: string, id: string, name: string) => {
    if (!(await ask({ title: `„${name}“ endgültig löschen?`, text: 'Dateien und Datensätze werden sofort entfernt. Das lässt sich nicht rückgängig machen; in Sicherungen bleiben die Daten bis zu deren Ablauf erhalten.', confirmLabel: 'Endgültig löschen' }))) return;
    try {
      await post('/trash/purge', { type, id });
      toast({ tone: 'success', title: 'Endgültig gelöscht' });
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  const d = q.data;
  const empty = d && !d.collections.length && !d.folders.length && !d.media.length;
  const actions = (type: string, id: string, name: string) => (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" icon="Undo2" onClick={() => void restore(type, id)}>
        Wiederherstellen
      </Button>
      {admin && (
        <Button size="sm" variant="danger" icon="Trash2" onClick={() => void purge(type, id, name)}>
          Endgültig löschen
        </Button>
      )}
    </div>
  );
  const when = (x: { deleted_at: string; deleted_by_name: string | null; purge_at: string | null }) => (
    <span className="text-meta text-fg-muted">
      gelöscht {fmtRelative(x.deleted_at)}
      {x.deleted_by_name ? ` von ${x.deleted_by_name}` : ''}
      {x.purge_at ? ` · endgültig ab ${fmtDateTime(x.purge_at)}` : ''}
    </span>
  );
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Papierkorb"
        subtitle="Gelöschte Dateien, Ordner und Sammlungen lassen sich bis zum Ablauf der Frist wiederherstellen."
        actions={
          admin &&
          !empty &&
          d && (
            <Button
              variant="danger"
              icon="Trash2"
              onClick={async () => {
                if (!(await ask({ title: 'Papierkorb leeren?', text: 'Alle Einträge werden sofort endgültig gelöscht. Das lässt sich nicht rückgängig machen.', confirmLabel: 'Papierkorb leeren' }))) return;
                try {
                  const r = await post<any>('/trash/empty');
                  toast({ tone: 'success', title: 'Papierkorb geleert', text: `${r.media} Datei(en), ${r.folders} Ordner, ${r.collections} Sammlung(en)` });
                } catch (e) {
                  toastError(e);
                }
                refresh();
              }}
            >
              Papierkorb leeren
            </Button>
          )
        }
      />
      <MediaNav />
      {d && (
        <Notice>
          {d.days > 0 ? `Einträge werden ${d.days} Tage nach dem Löschen automatisch endgültig entfernt (Einstellungen → Datenschutz).` : 'Automatisches Leeren ist ausgeschaltet (Einstellungen → Datenschutz).'}
          {!admin && ' Endgültig löschen kann, wer „Medien administrieren“ hat.'}
        </Notice>
      )}
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Papierkorb konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {empty && <EmptyState icon="Trash2" title="Der Papierkorb ist leer" />}
      {d && d.collections.length > 0 && (
        <Card title="Sammlungen" bodyClassName="!p-0">
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {d.collections.map((c) => (
              <li key={c.id} className="p-4 flex flex-wrap items-center gap-3">
                <Icon name="Images" size={18} className="text-fg-muted" />
                <div className="flex-1 min-w-0 flex flex-col">
                  <Link to={`/medien/${c.id}`} className="font-medium truncate">
                    {c.title}
                  </Link>
                  <span className="text-meta text-fg-muted">{c.media_count} Datei(en)</span>
                  {when(c)}
                </div>
                {actions('collection', c.id, c.title)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {d && d.folders.length > 0 && (
        <Card title="Ordner" bodyClassName="!p-0">
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {d.folders.map((f) => (
              <li key={f.id} className="p-4 flex flex-wrap items-center gap-3">
                <Icon name="Folder" size={18} className="text-fg-muted" />
                <div className="flex-1 min-w-0 flex flex-col">
                  <span className="font-medium truncate">{f.name}</span>
                  <span className="text-meta text-fg-muted">
                    in „{f.collection_title}“ · {f.media_count} Datei(en)
                  </span>
                  {when(f)}
                </div>
                {actions('folder', f.id, f.name)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {d && d.media.length > 0 && (
        <Card title="Dateien" bodyClassName="!p-0">
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {d.media.map((m) => (
              <li key={m.id} className="p-3 flex flex-wrap items-center gap-3">
                <MediaThumb m={m} className="w-14 h-14 rounded-chip [&_span]:hidden text-[0px]" />
                <div className="flex-1 min-w-0 flex flex-col">
                  <span className="font-medium truncate">{mediaName(m)}</span>
                  <span className="text-meta text-fg-muted">in „{m.collection_title}“</span>
                  {when(m)}
                </div>
                {actions('media', m.id, mediaName(m))}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
