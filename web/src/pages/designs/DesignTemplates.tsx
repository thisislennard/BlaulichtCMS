import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../../api/client';
import { api, del as apiDel } from '../../api/client';
import { Badge, Button, Card, Chip, EmptyState, ErrorBox, FieldWrap, FilePickButton, Input, PageHeader, SegmentedControl, Select, SkeletonRows, Switch, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { useListState } from '../../lib/listState';
import { FilterEmpty, ListToolbar } from '../../components/ui/list';

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
export function TemplateMetaDialog({ tpl, onClose, onSaved }: { tpl?: Partial<TemplateListItem> & { id?: string }; onClose: () => void; onSaved?: (id: string, kind: 'files' | 'image') => void }) {
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
    format: 'square',
  });
  const editing = !!tpl?.id;
  const formats = useQuery({ queryKey: ['design-fonts'], queryFn: () => get<{ formats: { key: string; label: string; width: number; height: number }[] }>('/design-fonts'), enabled: !editing });
  const preset = formats.data?.formats.find((f) => f.key === v.format);
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
      ...(editing ? {} : { kind: v.kind, ...(v.kind === 'image' && preset ? { width: preset.width, height: preset.height } : {}) }),
    };
    try {
      const id = editing ? (await patch(`/design-templates/${tpl!.id}`, body), tpl!.id!) : (await post<{ id: string }>('/design-templates', body)).id;
      toast({ tone: 'success', title: editing ? 'Designvorlage gespeichert' : 'Designvorlage angelegt' });
      onSaved?.(id, v.kind);
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
      title={editing ? 'Designvorlage bearbeiten' : 'Neue Designvorlage'}
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
        {!editing && (
          <SegmentedControl
            label="Art der Designvorlage"
            value={v.kind}
            onChange={(kind) => setV({ ...v, kind })}
            options={[
              { value: 'files', label: 'Dateien zum Herunterladen' },
              { value: 'image', label: 'Befüllbare Bildvorlage' },
            ]}
          />
        )}
        {!editing && v.kind === 'image' && (
          <FieldWrap label="Format" htmlFor="dt-format" help="Lässt sich im Editor noch ändern.">
            <Select id="dt-format" value={v.format} onChange={(e) => setV({ ...v, format: e.target.value })}>
              {(formats.data?.formats ?? []).map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </FieldWrap>
        )}
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
        <FieldWrap label="Nutzungshinweis" htmlFor="dt-note" help="Steht gut sichtbar bei der Designvorlage, z. B. „Nur unverändert verwenden“ oder „Nicht für Werbung“.">
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
                    {c.name} <span className="text-fg-muted text-sm">· {c.template_count} {c.template_count === 1 ? 'Designvorlage' : 'Designvorlagen'}</span>
                  </span>
                  <Button size="sm" iconOnly icon="Pencil" aria-label={`${c.name} umbenennen`} onClick={() => setEdit({ ...edit, [c.id]: c.name })} />
                  <Button
                    size="sm"
                    iconOnly
                    icon="Trash2"
                    aria-label={`${c.name} löschen`}
                    onClick={async () => {
                      if (await confirm({ title: `Kategorie „${c.name}“ löschen?`, text: 'Die Designvorlagen bleiben erhalten und stehen danach ohne Kategorie in der Bibliothek.', confirmLabel: 'Löschen', danger: true })) run(() => del(`/design-template-categories/${c.id}`));
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

interface FontRow {
  key: string;
  label: string;
  bundled: boolean;
  license: string;
}

/** Schriften: mitgelieferte (SIL Open Font License) und eigene mit Lizenzhinweis. */
function FontsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['design-fonts'], queryFn: () => get<{ fonts: FontRow[] }>('/design-fonts') });
  const [file, setFile] = useState<File | null>(null);
  const [license, setLicense] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['design-fonts'] });
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('license', license.trim());
      fd.append('confirm', ok ? 'true' : 'false');
      fd.append('file', file);
      const r = await api<any>('POST', '/design-fonts', fd);
      toast({ tone: 'success', title: 'Schrift hinzugefügt', text: r.family });
      setFile(null);
      setLicense('');
      setOk(false);
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Schriften" width={640} footer={<Button onClick={onClose}>Schließen</Button>}>
      <div className="flex flex-col gap-4">
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {(q.data?.fonts ?? []).map((f) => (
            <li key={f.key} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {f.label} {f.bundled && <span className="text-fg-muted font-normal">· mitgeliefert</span>}
                </div>
                <div className="text-meta text-fg-muted break-words">Lizenz: {f.license}</div>
              </div>
              {!f.bundled && (
                <Button
                  size="sm"
                  iconOnly
                  icon="Trash2"
                  aria-label={`${f.label} löschen`}
                  onClick={async () => {
                    if (!(await confirm({ title: `Schrift „${f.label}“ löschen?`, text: 'Nur möglich, wenn keine Bildvorlage sie verwendet.', confirmLabel: 'Löschen' }))) return;
                    try {
                      await apiDel(`/design-fonts/${f.key.slice(7)}`);
                      refresh();
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        <fieldset className="m-0 p-3 border border-line rounded-card flex flex-col gap-3">
          <legend className="px-1 text-sm font-medium">Eigene Schrift hinzufügen</legend>
          <FieldWrap label="Schriftdatei" htmlFor="font-file" help="TrueType (.ttf) oder OpenType (.otf), höchstens 10 MB; je Schnitt (z. B. Fett) eine Datei.">
            <FilePickButton id="font-file" name="Schriftdatei" accept=".ttf,.otf,font/ttf,font/otf" label="Schriftdatei wählen …" fileName={file?.name} onPick={([f]) => setFile(f)} onRemove={() => setFile(null)} />
          </FieldWrap>
          <FieldWrap label="Lizenz" required htmlFor="font-license" help="z. B. „SIL Open Font License 1.1“ oder „Hausschrift, Lizenz der Organisation bis 2028“.">
            <Input id="font-license" value={license} maxLength={500} onChange={(e) => setLicense(e.target.value)} />
          </FieldWrap>
          <Switch checked={ok} onChange={setOk} label="Ich bestätige, dass die Schrift für Bilder der Organisation verwendet werden darf." />
          <div>
            <Button icon="Upload" loading={busy} disabled={!file || license.trim().length < 3 || !ok} onClick={upload}>
              Schrift hochladen
            </Button>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

export default function DesignTemplates() {
  const { can } = useAuth();
  const nav = useNavigate();
  // Suche und Filter in der Adresse (#260)
  const ls = useListState({ suche: '', kategorie: '', format: '', art: '' });
  const { suche: search, kategorie: category, format, art: kind } = ls.values;
  const [term, setTerm] = useState(search.trim());
  const [create, setCreate] = useState(false);
  const [cats, setCats] = useState(false);
  const [fonts, setFonts] = useState(false);
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
        subtitle="Interne Bibliothek mit Logos, Layouts und Bildvorlagen zum Herunterladen – mit Nutzungshinweisen und älteren Versionen."
        actions={
          can('templates.manage') && (
            <>
              <Button icon="Tags" onClick={() => setCats(true)}>
                Kategorien
              </Button>
              <Button icon="Type" onClick={() => setFonts(true)}>
                Schriften
              </Button>
              <Button variant="primary" icon="Plus" onClick={() => setCreate(true)}>
                Neue Designvorlage
              </Button>
            </>
          )
        }
      />
      <ListToolbar
        search={{ value: search, onChange: (v) => ls.set({ suche: v }), placeholder: 'Suchen in Designvorlagen', label: 'Designvorlagen durchsuchen (Titel, Beschreibung, Schlagwort)' }}
        filters={[
          { key: 'kategorie', label: 'Kategorie', value: category, onChange: (v) => ls.set({ kategorie: v }), allLabel: 'Alle Kategorien', options: [...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name })), { value: 'none', label: 'Ohne Kategorie' }] },
          { key: 'format', label: 'Format', value: format, onChange: (v) => ls.set({ format: v }), allLabel: 'Alle Formate', options: (q.data?.formats ?? []).map((f) => ({ value: f.key, label: f.label })) },
          { key: 'art', label: 'Art', value: kind, onChange: (v) => ls.set({ art: v }), allLabel: 'Alle Arten', options: [{ value: 'files', label: 'Dateien zum Herunterladen' }, { value: 'image', label: 'Befüllbare Bildvorlagen' }] },
        ]}
        count={list ? { n: list.length, one: 'Designvorlage', many: 'Designvorlagen' } : undefined}
        onReset={() => ls.reset()}
      />
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Designvorlagen konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {list && list.length === 0 &&
        (filtered ? (
          <FilterEmpty onReset={() => ls.reset()} />
        ) : (
          <EmptyState
            icon="Palette"
            title="Noch keine Designvorlage."
            text={can('templates.manage') ? 'Lege Logos, Layouts und Bildvorlagen hier ab, damit alle dieselben aktuellen Dateien verwenden.' : 'Designvorlagen legt an, wer Designvorlagen verwalten darf.'}
            action={can('templates.manage') && <Button icon="Plus" onClick={() => setCreate(true)}>Neue Designvorlage</Button>}
          />
        ))}
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
                      {t.kind === 'image' && <Badge>Befüllbar</Badge>}
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
      {create && <TemplateMetaDialog onClose={() => setCreate(false)} onSaved={(id, kind) => nav(kind === 'image' ? `/designvorlagen/${id}/editor` : `/designvorlagen/${id}`)} />}
      {cats && <CategoriesDialog onClose={() => setCats(false)} />}
      {fonts && <FontsDialog onClose={() => setFonts(false)} />}
    </div>
  );
}
