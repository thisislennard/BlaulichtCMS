import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Button, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, Select, SkeletonRows, Table, Td, Textarea, Th } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { KIND_LABEL } from './Posts';

interface Tpl {
  id: string;
  name: string;
  kind: string;
  title: string;
  body: string;
  excerpt: string;
  updated_at: string;
  created_by_name: string | null;
}

function TemplateDialog({ tpl, onClose }: { tpl: Partial<Tpl> | null; onClose: () => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({ name: tpl?.name ?? '', kind: tpl?.kind ?? 'news', title: tpl?.title ?? '', body: tpl?.body ?? '', excerpt: tpl?.excerpt ?? '' });
  return (
    <Dialog
      open
      onClose={onClose}
      width={680}
      title={tpl?.id ? 'Vorlage bearbeiten' : 'Neue Vorlage'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={v.name.trim().length < 2}
            loading={busy}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              try {
                if (tpl?.id) await put(`/templates/${tpl.id}`, v);
                else await post('/templates', v);
                toast({ tone: 'success', title: tpl?.id ? 'Vorlage gespeichert' : 'Vorlage angelegt' });
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
        <FieldWrap label="Name der Vorlage" required htmlFor="t-name">
          <Input id="t-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={100} placeholder="z. B. Einsatzbericht kurz" />
        </FieldWrap>
        <FieldWrap label="Titel (Vorschlag)" help="Wird beim Anlegen eines Beitrags vorbelegt." htmlFor="t-title">
          <Input id="t-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} placeholder="z. B. Einsatz am [Datum] in [Ort]" />
        </FieldWrap>
        <FieldWrap label="Art" htmlFor="t-kind">
          <Select id="t-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Text" help="Platzhalter wie [Datum] oder [Ort] erleichtern das Ausfüllen." htmlFor="t-body">
          <Textarea id="t-body" rows={8} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} maxLength={50000} />
        </FieldWrap>
        <FieldWrap label="Kurzfassung" htmlFor="t-excerpt">
          <Textarea id="t-excerpt" rows={2} value={v.excerpt} onChange={(e) => setV({ ...v, excerpt: e.target.value })} maxLength={1000} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

export default function Templates() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => get<Tpl[]>('/templates') });
  const [edit, setEdit] = useState<Partial<Tpl> | null | undefined>(undefined);
  const [archive, setArchive] = useState<Tpl | null>(null);
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['templates'] });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Vorlagen"
        subtitle="Redaktionelle Vorlagen für wiederkehrende Beiträge, z. B. Einsatzberichte oder Veranstaltungshinweise."
        actions={can('post.templates') && <Button variant="primary" icon="Plus" onClick={() => setEdit(null)}>Neue Vorlage</Button>}
      />
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Vorlagen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && <EmptyState icon="FileText" title="Noch keine Vorlage" />}
      {q.data && q.data.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Art</Th>
              <Th className="hidden md:table-cell">Geändert</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">{t.name}</Td>
                <Td>{KIND_LABEL[t.kind]}</Td>
                <Td className="hidden md:table-cell">{fmtRelative(t.updated_at)}</Td>
                <Td align="right">
                  {can('post.templates') && (
                    <span className="inline-flex gap-2">
                      <Button size="sm" icon="Pencil" onClick={() => setEdit(t)}>
                        Bearbeiten
                      </Button>
                      <Button size="sm" iconOnly icon="Archive" aria-label={`${t.name} archivieren`} onClick={() => setArchive(t)} />
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit !== undefined && <TemplateDialog tpl={edit} onClose={() => (setEdit(undefined), refresh())} />}
      {archive && (
        <Dialog
          open
          onClose={() => setArchive(null)}
          title="Vorlage archivieren?"
          footer={
            <>
              <Button onClick={() => setArchive(null)}>Abbrechen</Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await del(`/templates/${archive.id}`);
                    toast({ tone: 'success', title: 'Vorlage archiviert' });
                  } catch (e) {
                    toastError(e);
                  }
                  setArchive(null);
                  refresh();
                }}
              >
                Archivieren
              </Button>
            </>
          }
        >
          <p className="m-0 text-sm">„{archive.name}“ steht danach nicht mehr für neue Beiträge zur Auswahl. Bestehende Beiträge bleiben unverändert.</p>
        </Dialog>
      )}
    </div>
  );
}
