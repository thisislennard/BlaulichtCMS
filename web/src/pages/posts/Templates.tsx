import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Button, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, Select, SkeletonRows, Table, Td, Textarea, Th } from '../../components/ui/core';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
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
            onClick={async () => {
              try {
                if (tpl?.id) await put(`/templates/${tpl.id}`, v);
                else await post('/templates', v);
                onClose();
              } catch (e) {
                toastError(e);
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
  const refresh = () => qc.invalidateQueries({ queryKey: ['templates'] });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Vorlagen"
        subtitle="Redaktionelle Vorlagen für wiederkehrende Beiträge, z. B. Einsatzberichte oder Veranstaltungshinweise."
        actions={can('post.edit') && <Button variant="primary" icon="Plus" onClick={() => setEdit(null)}>Neue Vorlage</Button>}
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
                  {can('post.edit') && (
                    <span className="inline-flex gap-2">
                      <Button size="sm" icon="Pencil" onClick={() => setEdit(t)}>
                        Bearbeiten
                      </Button>
                      <Button size="sm" iconOnly icon="Archive" aria-label={`${t.name} archivieren`} onClick={async () => (await del(`/templates/${t.id}`).catch(toastError), refresh())} />
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit !== undefined && <TemplateDialog tpl={edit} onClose={() => (setEdit(undefined), refresh())} />}
    </div>
  );
}
