import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, patch, post, put } from '../../api/client';
import { Button, Chip, FieldWrap, Input, Notice, Select } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';

export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
  archived_at?: string | null;
  media_count?: number;
}

/** Pfad (oberste Ebene → Ordner). */
export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  const seen = new Set<string>();
  for (let cur = id ? byId.get(id) : undefined; cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

export function descendantIds(folders: Folder[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const f of folders) if (f.parent_id === cur && !out.includes(f.id)) (out.push(f.id), queue.push(f.id));
  }
  return out;
}

/** Ordner als eingerückte Auswahlliste („Einsatz › Drohne“). */
export function FolderOptions({ folders, exclude }: { folders: Folder[]; exclude?: string[] }) {
  const sorted = useMemo(() => {
    const out: { f: Folder; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of folders.filter((x) => x.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
        if (exclude?.includes(f.id)) continue;
        out.push({ f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, exclude]);
  return (
    <>
      {sorted.map(({ f, depth }) => (
        <option key={f.id} value={f.id}>
          {`${'  '.repeat(depth)}${depth ? '› ' : ''}${f.name}`}
        </option>
      ))}
    </>
  );
}

/* ------------------------------------- Ordnerleiste ------------------------------------- */

/** Brotkrumen, Unterordner als Kacheln und Ordneraktionen über dem Raster einer Sammlung. */
export function FolderBar({ collectionId, folders, current, onOpen, manage, counts, deep, setDeep, onChanged, onTrash }: {
  collectionId: string;
  folders: Folder[];
  current: string | null;
  onOpen: (id: string | null) => void;
  manage: boolean;
  counts: Record<string, number>;
  deep: boolean;
  setDeep: (v: boolean) => void;
  onChanged: () => void;
  onTrash?: (f: Folder) => void;
}) {
  const ask = useConfirm();
  const toastError = useErrorToast();
  const [naming, setNaming] = useState<null | { folder?: Folder; parent: string | null }>(null);
  const [moving, setMoving] = useState<Folder | null>(null);
  const path = folderPath(folders, current);
  const children = folders.filter((f) => f.parent_id === current).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  if (!folders.length && !manage) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Ordnerpfad" className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="inline-flex items-center gap-1 px-1.5 h-7 rounded-chip hover:bg-raised" aria-current={current === null ? 'location' : undefined} onClick={() => onOpen(null)}>
            <Icon name="FolderOpen" size={14} /> Oberste Ebene
          </button>
          {path.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1">
              <Icon name="ChevronRight" size={13} className="text-fg-muted" />
              <button type="button" className="px-1.5 h-7 rounded-chip hover:bg-raised font-medium" aria-current={f.id === current ? 'location' : undefined} onClick={() => onOpen(f.id)}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>
        <span className="flex-1" />
        {folders.length > 0 && (
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary-solid)]" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
            Unterordner einbeziehen
          </label>
        )}
        {manage && (
          <Button size="sm" icon="FolderPlus" onClick={() => setNaming({ parent: current })}>
            Neuer Ordner
          </Button>
        )}
      </div>
      {children.length > 0 && (
        <ul className="m-0 p-0 list-none grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {children.map((f) => (
            <li key={f.id} className="flex items-center gap-1 border border-line rounded-node bg-card pr-1">
              <button type="button" className="flex-1 min-w-0 flex items-center gap-2 px-3 h-11 text-left text-sm" onClick={() => onOpen(f.id)}>
                <Icon name="Folder" size={16} className="text-fg-muted shrink-0" />
                <span className="truncate font-medium">{f.name}</span>
                <span className="ml-auto font-mono text-meta text-fg-muted">{counts[f.id] ?? 0}</span>
                {f.archived_at && <span className="text-meta text-fg-muted">archiviert</span>}
              </button>
              {manage && (
                <Menu
                  size="sm"
                  label={`Aktionen für Ordner ${f.name}`}
                  items={[
                    { label: 'Umbenennen', icon: 'Pencil', onClick: () => setNaming({ folder: f, parent: f.parent_id }) },
                    { label: 'Verschieben', icon: 'FolderInput', onClick: () => setMoving(f) },
                    { label: f.archived_at ? 'Wiederherstellen' : 'Archivieren', icon: 'Archive', onClick: () => void patch(`/folders/${f.id}`, { archived: !f.archived_at }).then(onChanged, toastError) },
                    onTrash
                      ? {
                          label: 'In den Papierkorb',
                          icon: 'Trash2',
                          danger: true,
                          onClick: async () => {
                            if (!(await ask({ title: `Ordner „${f.name}“ in den Papierkorb?`, text: 'Der Ordner kommt mit Unterordnern und Dateien in den Papierkorb und lässt sich dort wiederherstellen. Dateien in laufenden Beiträgen verhindern das.', confirmLabel: 'In den Papierkorb' }))) return;
                            onTrash(f);
                          },
                        }
                      : null,
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {naming && <FolderNameDialog collectionId={collectionId} folder={naming.folder} parent={naming.parent} onClose={() => setNaming(null)} onSaved={() => (setNaming(null), onChanged())} />}
      {moving && <MoveFolderDialog folder={moving} folders={folders} onClose={() => setMoving(null)} onSaved={() => (setMoving(null), onChanged())} />}
    </div>
  );
}

function FolderNameDialog({ collectionId, folder, parent, onClose, onSaved }: { collectionId: string; folder?: Folder; parent: string | null; onClose: () => void; onSaved: () => void }) {
  const toastError = useErrorToast();
  const [name, setName] = useState(folder?.name ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (folder) await patch(`/folders/${folder.id}`, { name: name.trim() });
      else await post(`/collections/${collectionId}/folders`, { name: name.trim(), parentId: parent });
      onSaved();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={folder ? 'Ordner umbenennen' : 'Neuer Ordner'} width={440} footer={<><Button onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>Speichern</Button></>}>
      <FieldWrap label="Name" htmlFor="fd-name" required>
        <Input id="fd-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
      </FieldWrap>
    </Dialog>
  );
}

function MoveFolderDialog({ folder, folders, onClose, onSaved }: { folder: Folder; folders: Folder[]; onClose: () => void; onSaved: () => void }) {
  const toastError = useErrorToast();
  const [target, setTarget] = useState(folder.parent_id ?? '');
  const exclude = [folder.id, ...descendantIds(folders, folder.id)];
  return (
    <Dialog
      open
      onClose={onClose}
      title={`„${folder.name}“ verschieben`}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => void patch(`/folders/${folder.id}`, { parentId: target || null }).then(onSaved, toastError)}>
            Verschieben
          </Button>
        </>
      }
    >
      <FieldWrap label="Neuer Ort" htmlFor="mf-target">
        <Select id="mf-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Oberste Ebene</option>
          <FolderOptions folders={folders} exclude={exclude} />
        </Select>
      </FieldWrap>
    </Dialog>
  );
}

/* ----------------------------------- Verschieben / Kopieren ----------------------------------- */

/** Ziel wählen (Sammlung und Ordner) und Dateien verschieben oder kopieren. Medien behalten beim Verschieben ihre ID. */
export function MoveCopyDialog({ mode, ids, defaultCollection, onClose, onDone }: { mode: 'move' | 'copy'; ids: string[]; defaultCollection?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const cols = useQuery({ queryKey: ['collections', 'targets'], queryFn: () => get<any[]>('/collections') });
  const [collectionId, setCollectionId] = useState(defaultCollection ?? '');
  const folders = useQuery({ queryKey: ['folders', collectionId], queryFn: () => get<Folder[]>(`/collections/${collectionId}/folders`), enabled: !!collectionId });
  const [folderId, setFolderId] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${ids.length} Datei(en) ${mode === 'move' ? 'verschieben' : 'kopieren'}`}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            icon={mode === 'move' ? 'FolderInput' : 'CopyPlus'}
            loading={busy}
            disabled={!collectionId}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<any>(`/media/${mode}`, { ids, collectionId, folderId: folderId || null });
                toast({ tone: 'success', title: mode === 'move' ? `${r.moved} Datei(en) verschoben` : `${r.copied} Datei(en) kopiert` });
                onDone();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            {mode === 'move' ? 'Verschieben' : 'Kopieren'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Sammlung" htmlFor="mc-col">
          <Select id="mc-col" value={collectionId} onChange={(e) => (setCollectionId(e.target.value), setFolderId(''))}>
            <option value="">– Sammlung wählen –</option>
            {(cols.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <FieldWrap label="Ordner" htmlFor="mc-folder">
          <Select id="mc-folder" value={folderId} disabled={!collectionId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">Oberste Ebene</option>
            <FolderOptions folders={folders.data ?? []} />
          </Select>
        </FieldWrap>
        {mode === 'copy' ? (
          <Notice>Kopien übernehmen Anzeigename, Beschreibung, Schlagworte und alle Datenschutz-Entscheidungen (Markierungen, unkenntliche Bereiche, Zuschnitt, ohne Ton). Die Sichtung beginnt neu. Nur geprüfte Dateien lassen sich kopieren.</Notice>
        ) : (
          <Notice>Verschobene Dateien behalten ihre ID – Beiträge und Freigaben, die sie verwenden, bleiben gültig. Das Kontingent der Zielsammlung wird geprüft.</Notice>
        )}
      </div>
    </Dialog>
  );
}

/* ---------------------------------------- Schlagworte ---------------------------------------- */

/** Schlagworte als Chips mit Eingabe (Komma oder Enter fügt hinzu). */
export function TagInput({ value, onChange, id, suggestions }: { value: string[]; onChange: (v: string[]) => void; id: string; suggestions?: string[] }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const t = raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((t) => (
            <Chip key={t}>
              {t}
              <button type="button" className="ml-0.5 text-fg-muted hover:text-fg" aria-label={`Schlagwort ${t} entfernen`} onClick={() => onChange(value.filter((x) => x !== t))}>
                <Icon name="X" size={12} />
              </button>
            </Chip>
          ))}
        </div>
      )}
      <Input
        id={id}
        value={draft}
        list={suggestions?.length ? `${id}-list` : undefined}
        placeholder="Schlagwort eingeben, Enter fügt hinzu"
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.preventDefault(), add(draft));
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
      {suggestions?.length ? (
        <datalist id={`${id}-list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

export function useTagSuggestions() {
  const q = useQuery({ queryKey: ['media-tags'], queryFn: () => get<{ id: string; name: string; count: number }[]>('/media-tags'), staleTime: 30_000 });
  return q.data ?? [];
}

/** Schlagworte einer Datei setzen bzw. für mehrere Dateien hinzufügen/entfernen. */
export function TagsDialog({ ids, current, onClose, onDone }: { ids: string[]; current?: string[]; onClose: () => void; onDone: () => void }) {
  const toastError = useErrorToast();
  const single = ids.length === 1 && current !== undefined;
  const all = useTagSuggestions();
  const [tags, setTags] = useState<string[]>(current ?? []);
  const [remove, setRemove] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={single ? 'Schlagworte' : `Schlagworte für ${ids.length} Datei(en)`}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            icon="Tags"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (single) await put(`/media/${ids[0]}/tags`, { tags });
                else await post('/media/tags', { ids, add: tags, remove });
                onDone();
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
        <FieldWrap label={single ? 'Schlagworte' : 'Hinzufügen'} htmlFor="tg-add" help="Kleinschreibung, höchstens 40 Zeichen. Schlagworte (Medien) sind unabhängig von den Stichwörtern der Warnentwürfe.">
          <TagInput id="tg-add" value={tags} onChange={setTags} suggestions={all.map((t) => t.name)} />
        </FieldWrap>
        {!single && (
          <FieldWrap label="Entfernen" htmlFor="tg-remove">
            <TagInput id="tg-remove" value={remove} onChange={setRemove} suggestions={all.map((t) => t.name)} />
          </FieldWrap>
        )}
      </div>
    </Dialog>
  );
}
