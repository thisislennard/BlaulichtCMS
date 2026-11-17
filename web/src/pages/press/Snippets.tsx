import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Button, Card, Chip, EmptyState, FieldWrap, Input, SkeletonRows, Textarea } from '../../components/ui/core';
import { Dialog, useConfirm, useErrorToast } from '../../components/ui/overlays';
import { SNIPPET_PLACEHOLDERS } from './Messages';

interface Snippet {
  id: string;
  title: string;
  body: string;
  updated_at: string;
}

function SnippetDialog({ snippet, onClose }: { snippet: Snippet | null; onClose: () => void }) {
  const toastError = useErrorToast();
  const [title, setTitle] = useState(snippet?.title ?? '');
  const [body, setBody] = useState(snippet?.body ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (snippet) await put(`/press/snippets/${snippet.id}`, { title, body });
      else await post('/press/snippets', { title, body });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      title={snippet ? 'Textbaustein bearbeiten' : 'Neuer Textbaustein'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={title.trim().length < 2 || !body.trim()} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Bezeichnung" required htmlFor="sn-title">
          <Input id="sn-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="z. B. Begrüßung, Verweis auf Pressemitteilung" />
        </FieldWrap>
        <FieldWrap label="Text" required htmlFor="sn-body" help="Platzhalter werden beim Einfügen in eine Antwort durch die Angaben der Anfrage ersetzt.">
          <Textarea id="sn-body" rows={8} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
        </FieldWrap>
        <div className="flex flex-wrap gap-1.5" aria-label="Platzhalter">
          {SNIPPET_PLACEHOLDERS.map((p) => (
            <button key={p.key} type="button" className="inline-flex" title={p.label} onClick={() => setBody((b) => `${b}{{${p.key}}}`)}>
              <Chip mono>{`{{${p.key}}}`}</Chip>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/** Textbausteine für Antworten auf Presseanfragen (#206). */
export function SnippetSettings() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const toastError = useErrorToast();
  const q = useQuery({ queryKey: ['press-snippets'], queryFn: () => get<Snippet[]>('/press/snippets') });
  const [edit, setEdit] = useState<Snippet | null | undefined>(undefined);
  const refresh = () => qc.invalidateQueries({ queryKey: ['press-snippets'] });
  return (
    <Card title="Bausteine" subtitle="Wiederkehrende Formulierungen für Antworten – mit Platzhaltern wie {{name}} oder {{thema}}." action={<Button size="sm" icon="Plus" onClick={() => setEdit(null)}>Neuer Baustein</Button>}>
      {q.isLoading && <SkeletonRows rows={3} />}
      {q.data && !q.data.length && <EmptyState icon="TextCursorInput" title="Noch keine Textbausteine" />}
      <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
        {(q.data ?? []).map((s) => (
          <li key={s.id} className="py-3 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.title}</div>
              <p className="m-0 text-sm text-fg-muted whitespace-pre-wrap line-clamp-3">{s.body}</p>
            </div>
            <Button size="sm" iconOnly icon="Pencil" aria-label={`${s.title} bearbeiten`} onClick={() => setEdit(s)} />
            <Button
              size="sm"
              iconOnly
              icon="Trash2"
              aria-label={`${s.title} löschen`}
              onClick={async () => {
                if (!(await ask({ title: 'Textbaustein löschen?', text: `„${s.title}“ wird gelöscht.`, confirmLabel: 'Löschen' }))) return;
                try {
                  await del(`/press/snippets/${s.id}`);
                } catch (e) {
                  toastError(e);
                }
                refresh();
              }}
            />
          </li>
        ))}
      </ul>
      {edit !== undefined && (
        <SnippetDialog
          snippet={edit}
          onClose={() => {
            setEdit(undefined);
            refresh();
          }}
        />
      )}
    </Card>
  );
}
