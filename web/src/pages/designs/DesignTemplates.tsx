import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../../api/client';
import { Badge, Button, Card, Chip, EmptyState, ErrorBox, FieldWrap, Input, PageHeader, Select, SkeletonRows, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

export interface TemplateListItem {
  id: string;
  title: string;
  description: string;
  usage_note: string;
  category: { id: string; name: string } | null;
  tags: string[];
  kind: 'files' | 'image';
  has_preview: boolean;
  preview_rev: number;
  current_version: number;
  download_count: number;
  formats: { key: string; label: string }[];
  file_count: number;
  updated_at: string;
}

export interface Category {
  id: string;
  name: string;
  sort_order: number;
  template_count: number;
}

export const previewUrl = (t: { id: string; preview_rev: number }) => `/api/v1/design-templates/${t.id}/preview?v=${t.preview_rev}`;

export function useCategories() {
  return useQuery({ queryKey: ['design-template-categories'], queryFn: () => get<Category[]>('/design-template-categories') });
}

/** Anlegen bzw. Ändern der Angaben einer Vorlage (Titel, Kategorie, Beschreibung, Nutzungshinweis, Schlagworte). */
export function TemplateMetaDialog({ tpl, onClose, onSaved }: { tpl?: Partial<TemplateListItem> & { id?: string }; onClose: () => void; onSaved?: (id: string) => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const cats = useCategories();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    title: tpl?.title ?? '',
    categoryId: tpl?.category?.id ?? '',
    description: tpl?.description ?? '',
    usageNote: tpl?.usage_note ?? '',
    tags: (tpl?.tags ?? []).join(', '),
    kind: (tpl?.kind ?? 'files') as 'files' | 'image',
  });
  const editing = !!tpl?.id;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const body = {
      title: v.title.trim(),
      categoryId: v.categoryId || null,
      description: v.description.trim(),
      usageNote: v.usageNote.trim(),
      tags: v.tags
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      ...(editing ? {} : { kind: v.kind }),
    };
    try {
      const id = editing ? (await patch(`/design-templates/${tpl!.id}`, body), tpl!.id!) : (await post<{ id: string }>('/design-templates', body)).id;
      toast({ tone: 'success', title: editing ? 'Vorlage gespeichert' : 'Vorlage angelegt' });
      onSaved?.(id);
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={editing ? 'Vorlage bearbeiten' : 'Neue Designvorlage'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={v.title.trim().length < 2} onClick={save}>
            {editing ? 'Speichern' : 'Anlegen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Titel" required htmlFor="dt-title">
          <Input id="dt-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={150} placeholder="z. B. Logo der Organisation" />
        </FieldWrap>
        <FieldWrap label="Kategorie" htmlFor="dt-cat" help={cats.data?.length === 0 ? 'Kategorien legst du in der Bibliothek unter „Kategorien“ an.' : undefined}>
          <Select id="dt-cat" value={v.categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })}>
            <option value="">Ohne Kategorie</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Beschreibung" htmlFor="dt-desc">
          <Textarea id="dt-desc" rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={2000} />
        </FieldWrap>
        <FieldWrap label="Nutzungshinweis" htmlFor="dt-note" help="Steht gut sichtbar bei der Vorlage, z. B. „Nur unverändert verwenden“ oder „Nicht für Werbung“.">
          <Textarea id="dt-note" rows={2} value={v.usageNote} onChange={(e) => setV({ ...v, usageNote: e.target.value })} maxLength={1000} />
        </FieldWrap>
        <FieldWrap label="Schlagworte" htmlFor="dt-tags" help="Mit Komma trennen; helfen bei der Suche.">
          <Input id="dt-tags" value={v.tags} onChange={(e) => setV({ ...v, tags: e.target.value })} maxLength={800} placeholder="Logo, Druck, Social Media" />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

/** Kategorien pflegen: anlegen, umbenennen, löschen (Vorlagen bleiben ohne Kategorie erhalten). */
function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const cats = useCategories();
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const refresh = () => (qc.invalidateQueries({ queryKey: ['design-template-categories'] }), qc.invalidateQueries({ queryKey: ['design-templates'] }));
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Kategorien" width={560} footer={<Button onClick={onClose}>Schließen</Button>}>
      <div className="flex flex-col gap-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length < 2) return;
            run(async () => {
              await post('/design-template-categories', { name: name.trim() });
              setName('');
            });
          }}
        >
          <FieldWrap label="Neue Kategorie" htmlFor="cat-new" className="flex-1">
            <Input id="cat-new" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="z. B. Social Media" />
          </FieldWrap>
          <Button type="submit" icon="Plus" disabled={name.trim().length < 2}>
            Hinzufügen
          </Button>
        </form>
        {cats.data?.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch keine Kategorien.</p>}
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {(cats.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              {edit[c.id] !== undefined ? (
                <>
                  <Input aria-label={`Neuer Name für ${c.name}`} value={edit[c.id]} onChange={(e) => setEdit({ ...edit, [c.id]: e.target.value })} maxLength={60} className="flex-1" />
                  <Button size="sm" variant="primary" disabled={edit[c.id].trim().length < 2} onClick={() => run(async () => (await patch(`/design-template-categories/${c.id}`, { name: edit[c.id].trim() }), setEdit(({ [c.id]: _, ...rest }) => rest)))}>
                    Speichern
                  </Button>
                  <Button size="sm" onClick={() => setEdit(({ [c.id]: _, ...rest }) => rest)}>
                    Abbrechen
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1">
                    {c.name} <span className="text-fg-muted text-sm">· {c.template_count} {c.template_count === 1 ? 'Vorlage' : 'Vorlagen'}</span>
                  </span>
                  <Button size="sm" iconOnly icon="Pencil" aria-label={`${c.name} umbenennen`} onClick={() => setEdit({ ...edit, [c.id]: c.name })} />
                  <Button
                    size="sm"
                    iconOnly
                    icon="Trash2"
                    aria-label={`${c.name} löschen`}
                    onClick={async () => {
                      if (await confirm({ title: `Kategorie „${c.name}“ löschen?`, text: 'Die Vorlagen bleiben erhalten und stehen danach ohne Kategorie in der Bibliothek.', confirmLabel: 'Löschen', danger: true })) run(() => del(`/design-template-categories/${c.id}`));
                    }}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

export default function DesignTemplates() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [category, setCategory] = useState('');
  const [format, setFormat] = useState('');
  const [kind, setKind] = useState('');
  const [create, setCreate] = useState(false);
  const [cats, setCats] = useState(false);
  const categories = useCategories();
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const q = useQuery({
    queryKey: ['design-templates', term, category, format, kind],
    queryFn: () => get<{ templates: TemplateListItem[]; formats: { key: string; label: string }[] }>(`/design-templates${qs({ q: term, category, format, kind })}`),
    placeholderData: keepPreviousData,
  });
  const list = q.data?.templates;
  const filtered = !!(term || category || format || kind);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Designvorlagen"
        subtitle="Interne Bibliothek mit Logos, Layouts und Vorlagen zum Herunterladen – mit Nutzungshinweisen und älteren Versionen."
        actions={
          can('templates.manage') && (
            <>
              <Button icon="Tags" onClick={() => setCats(true)}>
                Kategorien
              </Button>
              <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
                Neue Vorlage
              </Button>
            </>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Input type="search" aria-label="Vorlagen durchsuchen" placeholder="Titel, Beschreibung, Schlagwort …" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[320px]" />
        <Select aria-label="Kategorie" value={category} onChange={(e) => setCategory(e.target.value)} className="max-w-[220px]">
          <option value="">Alle Kategorien</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="none">Ohne Kategorie</option>
        </Select>
        <Select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)} className="max-w-[220px]">
          <option value="">Alle Formate</option>
          {(q.data?.formats ?? []).map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Art" value={kind} onChange={(e) => setKind(e.target.value)} className="max-w-[220px]">
          <option value="">Alle Arten</option>
          <option value="files">Dateien zum Herunterladen</option>
          <option value="image">Befüllbare Bildvorlagen</option>
        </Select>
      </div>
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Vorlagen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {list && list.length === 0 && (
        <EmptyState
          icon="Palette"
          title={filtered ? 'Keine passende Vorlage' : 'Noch keine Designvorlage'}
          text={filtered ? 'Suche oder Filter anpassen.' : 'Lege Logos, Layouts und Vorlagen hier ab, damit alle dieselben aktuellen Dateien verwenden.'}
          action={!filtered && can('templates.manage') && <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>Neue Vorlage</Button>}
        />
      )}
      {list && list.length > 0 && (
        <ul className="m-0 p-0 list-none grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => (
            <li key={t.id}>
              <Link to={`/designvorlagen/${t.id}`} className="block !text-fg no-underline h-full">
                <Card className="h-full hover:border-line-strong transition-colors" bodyClassName="!p-0">
                  <div className="aspect-[16/9] bg-raised rounded-t-card overflow-hidden flex items-center justify-center">
                    {t.has_preview ? <img src={previewUrl(t)} alt="" className="w-full h-full object-contain" loading="lazy" /> : <Icon name={t.kind === 'image' ? 'ImageUp' : 'Palette'} size={32} className="text-fg-muted" />}
                  </div>
                  <div className="p-4 flex flex-col gap-1.5">
                    <div className="font-semibold truncate">{t.title}</div>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {t.kind === 'image' && <Badge tone="primary">Befüllbar</Badge>}
                      {t.category && <Chip>{t.category.name}</Chip>}
                      {t.formats.map((f) => (
                        <Chip key={f.key} mono>
                          {f.label}
                        </Chip>
                      ))}
                    </div>
                    {t.usage_note && (
                      <div className="text-sm text-warn flex items-start gap-1">
                        <Icon name="Info" size={13} className="mt-0.5 shrink-0" /> <span className="line-clamp-2">{t.usage_note}</span>
                      </div>
                    )}
                    <div className="text-meta text-fg-muted">
                      Version {t.current_version} · {t.download_count} {t.download_count === 1 ? 'Download' : 'Downloads'} · geändert {fmtRelative(t.updated_at)}
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {create && <TemplateMetaDialog onClose={() => setCreate(false)} onSaved={(id) => nav(`/designvorlagen/${id}`)} />}
      {cats && <CategoriesDialog onClose={() => setCats(false)} />}
    </div>
  );
}
