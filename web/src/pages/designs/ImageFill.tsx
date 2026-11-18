import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, get } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Button, cx, EmptyState, FieldWrap, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { previewUrl, type TemplateListItem } from './DesignTemplates';

/* Befüllbare Bildvorlage ausfüllen (#209): Texte, Bilder mit Zuschnitt, Live-Vorschau vom Server, Erzeugen in die Medien. */

export interface LayoutElement {
  id: string;
  type: 'text' | 'image' | 'logo' | 'shape';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  [k: string]: any;
}

export interface Layout {
  width: number;
  height: number;
  background: { color: string; assetId: string | null };
  elements: LayoutElement[];
}

interface ImageChoice {
  mediaId: string;
  focusX: number;
  focusY: number;
  zoom: number;
  name?: string;
}

/** Vorschau vom Server (JPEG) für einen Anfragekörper – entprellt, alte Bilder werden freigegeben. */
export function useServerPreview(path: string | null, body: unknown, delay = 350) {
  const [url, setUrl] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<Response>('POST', path, JSON.parse(key), { raw: true, signal: ctrl.signal });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          setError(j?.message ?? `Vorschau nicht möglich (${res.status}).`);
          return;
        }
        const blob = await res.blob();
        setTruncated((res.headers.get('x-text-truncated') ?? '').split(',').filter(Boolean));
        setError(null);
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
      } catch (e) {
        if (!ctrl.signal.aborted) setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, delay);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [path, key, delay]);
  useEffect(() => () => setUrl((old) => (old && URL.revokeObjectURL(old), null)), []);
  return { url, truncated, error, loading };
}

/** Bild aus den Medien wählen (nur geprüfte Bilder). */
export function ImageMediaPicker({ onClose, onPick }: { onClose: () => void; onPick: (m: MediaItem) => void }) {
  const all = useQuery({ queryKey: ['collections', false], queryFn: () => get<any[]>('/collections') });
  const [cid, setCid] = useState('');
  const detail = useQuery({ queryKey: ['collection', cid], queryFn: () => get<any>(`/collections/${cid}`), enabled: !!cid });
  const list: MediaItem[] = (detail.data?.media ?? []).filter((m: MediaItem) => m.status === 'ready' && m.kind === 'image' && m.has_public);
  return (
    <Dialog open onClose={onClose} title="Bild wählen" width={720} footer={<Button onClick={onClose}>Abbrechen</Button>}>
      <div className="flex flex-col gap-3">
        <FieldWrap label="Sammlung" htmlFor="mc-c">
          <Select id="mc-c" value={cid} onChange={(e) => setCid(e.target.value)}>
            <option value="">– wählen –</option>
            {(all.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </Select>
        </FieldWrap>
        {cid && detail.isSuccess && list.length === 0 && <p className="m-0 text-sm text-fg-muted">Keine geprüften Bilder in dieser Sammlung.</p>}
        <ul className="m-0 p-0 list-none grid gap-2 grid-cols-3 sm:grid-cols-4">
          {list.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => (onPick(m), onClose())} className="block w-full rounded-control overflow-hidden border-2 border-transparent hover:border-primary focus-visible:border-primary">
                <img decoding="async" src={`/api/v1/media/${m.id}/preview`} alt={(m as any).alt_text || m.description || m.original_name} className="w-full aspect-square object-cover" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/** Auswahl der Bildvorlage (z. B. im Beitragseditor). */
function TemplateChooser({ onPick }: { onPick: (id: string) => void }) {
  const q = useQuery({ queryKey: ['design-templates', '', '', '', 'image'], queryFn: () => get<{ templates: TemplateListItem[] }>('/design-templates?kind=image') });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const list = q.data?.templates ?? [];
  if (!list.length) return <EmptyState icon="ImageUp" title="Noch keine befüllbare Bildvorlage" text="Bildvorlagen legt die Verwaltung unter Redaktion → Designvorlagen an." />;
  return (
    <ul className="m-0 p-0 list-none grid gap-3 grid-cols-2 sm:grid-cols-3">
      {list.map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => onPick(t.id)} className="w-full text-left rounded-card border border-line hover:border-line-strong focus-visible:border-primary overflow-hidden bg-surface">
            <div className="aspect-square bg-raised flex items-center justify-center">{t.has_preview ? <img src={previewUrl(t)} alt="" className="w-full h-full object-contain" /> : <Icon name="ImageUp" size={28} className="text-fg-muted" />}</div>
            <div className="p-2 text-sm font-medium truncate">{t.title}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

const pct = (v: number) => Math.round(v * 100);

/**
 * Dialog „Bild aus Vorlage“: Vorlage wählen (falls nicht vorgegeben), ausfüllen, Vorschau ansehen, erzeugen.
 * Das erzeugte Bild landet geprüft und ausgewählt in den Medien (Sammlung des Beitrags bzw. „Bilder aus Vorlagen“).
 */
export function ImageFillDialog({ templateId: initial, postId, onClose, onDone }: { templateId?: string; postId?: string; onClose: () => void; onDone?: (m: MediaItem) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const toastError = useErrorToast();
  const [templateId, setTemplateId] = useState(initial ?? '');
  const detail = useQuery({ queryKey: ['design-template', templateId], queryFn: () => get<TemplateListItem & { layout: Layout | null; usage_note: string }>(`/design-templates/${templateId}`), enabled: !!templateId });
  const layout = detail.data?.layout ?? null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, ImageChoice | null>>({});
  const [alt, setAlt] = useState('');
  const altTouched = useRef(false);
  const [choose, setChoose] = useState<string | null>(null);
  const [collectionId, setCollectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const cols = useQuery({ queryKey: ['collections', false], queryFn: () => get<any[]>('/collections'), enabled: can('media.view') });
  const texts = useMemo(() => (layout?.elements ?? []).filter((e) => e.type === 'text'), [layout]);
  const slots = useMemo(() => (layout?.elements ?? []).filter((e) => e.type === 'image'), [layout]);
  const body = { values, images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v ? { mediaId: v.mediaId, focusX: v.focusX, focusY: v.focusY, zoom: v.zoom } : null])) };
  const preview = useServerPreview(layout ? `/design-templates/${templateId}/fill-preview` : null, body);
  // Alternativtext folgt den Texten, bis er von Hand geändert wird
  useEffect(() => {
    if (altTouched.current || !layout) return;
    setAlt(
      texts
        .map((e) => (values[e.id] ?? e.default ?? '').trim())
        .filter(Boolean)
        .join(' – ')
        .slice(0, 1000),
    );
  }, [values, texts, layout]);
  const missing = slots.filter((e) => e.required && !images[e.id]);
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api<any>('POST', `/design-templates/${templateId}/generate`, { ...body, altText: alt.trim(), collectionId: collectionId || null, postId: postId ?? null });
      toast({ tone: 'success', title: 'Bild erzeugt', text: `Abgelegt in „${r.collection.title}“.` });
      onDone?.(r.media);
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
      width={1040}
      title={detail.data ? `Bild aus Vorlage: ${detail.data.title}` : 'Bild aus Vorlage'}
      footer={
        <>
          {!initial && templateId && (
            <Button variant="ghost" icon="ArrowLeft" onClick={() => setTemplateId('')} className="mr-auto">
              Andere Bildvorlage
            </Button>
          )}
          <Button onClick={onClose}>Abbrechen</Button>
          {layout && (
            <Button variant="primary" icon="ImageUp" loading={busy} disabled={missing.length > 0} onClick={generate}>
              Bild erzeugen
            </Button>
          )}
        </>
      }
    >
      {!templateId ? (
        <TemplateChooser onPick={setTemplateId} />
      ) : !layout ? (
        detail.isLoading ? <Skeleton className="h-64" /> : <Notice tone="error">Diese Designvorlage ist keine befüllbare Bildvorlage.</Notice>
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4 min-w-0">
            {detail.data?.usage_note && (
              <Notice tone="warning" icon="Info">
                {detail.data.usage_note}
              </Notice>
            )}
            {texts.map((e) => {
              const id = `fill-${e.id}`;
              const v = values[e.id] ?? '';
              const multi = (e.maxLines ?? 1) > 1;
              const props = { id, value: v, maxLength: e.maxLength, placeholder: e.default || undefined, onChange: (ev: any) => setValues({ ...values, [e.id]: ev.target.value }) };
              return (
                <FieldWrap
                  key={e.id}
                  label={e.label}
                  htmlFor={id}
                  help={preview.truncated.includes(e.id) ? undefined : e.hint || (e.default ? `Leer lassen für „${e.default}“.` : undefined)}
                  error={preview.truncated.includes(e.id) ? 'Der Text ist zu lang und wird gekürzt – bitte kürzer fassen.' : null}
                >
                  {multi ? <Textarea rows={Math.min(4, e.maxLines)} {...props} /> : <Input {...props} />}
                </FieldWrap>
              );
            })}
            {slots.map((e) => {
              const c = images[e.id];
              const set = (patch: Partial<ImageChoice>) => setImages({ ...images, [e.id]: { ...c!, ...patch } });
              return (
                <fieldset key={e.id} className="m-0 p-3 border border-line rounded-card flex flex-col gap-3 min-w-0">
                  <legend className="px-1 text-sm font-medium">
                    {e.label}
                    {e.required && (
                      <>
                        <span className="text-err ml-0.5" aria-hidden="true">
                          *
                        </span>
                        {/* Bildauswahl über Knöpfe: Pflicht als Text in der Gruppenbeschriftung */}
                        <span className="sr-only"> (Pflichtfeld)</span>
                      </>
                    )}
                  </legend>
                  {c ? (
                    <>
                      <div className="flex items-center gap-3">
                        <img src={`/api/v1/media/${c.mediaId}/preview`} alt="" className="h-14 w-14 object-cover rounded-chip border border-line" />
                        <span className="text-sm truncate flex-1">{c.name ?? 'Gewähltes Bild'}</span>
                        <Button size="sm" onClick={() => setChoose(e.id)}>
                          Ändern
                        </Button>
                        <Button size="sm" iconOnly icon="X" aria-label={`Bild für ${e.label} entfernen`} onClick={() => setImages({ ...images, [e.id]: null })} />
                      </div>
                      {e.fit !== 'contain' && (
                        <div className="grid gap-3 sm:grid-cols-3">
                          <FieldWrap label={`Zoom ${c.zoom.toFixed(1)}×`} htmlFor={`z-${e.id}`}>
                            <input id={`z-${e.id}`} type="range" min={1} max={4} step={0.1} value={c.zoom} onChange={(ev) => set({ zoom: Number(ev.target.value) })} />
                          </FieldWrap>
                          <FieldWrap label={`Ausschnitt waagerecht ${pct(c.focusX)} %`} htmlFor={`fx-${e.id}`}>
                            <input id={`fx-${e.id}`} type="range" min={0} max={1} step={0.01} value={c.focusX} onChange={(ev) => set({ focusX: Number(ev.target.value) })} />
                          </FieldWrap>
                          <FieldWrap label={`Ausschnitt senkrecht ${pct(c.focusY)} %`} htmlFor={`fy-${e.id}`}>
                            <input id={`fy-${e.id}`} type="range" min={0} max={1} step={0.01} value={c.focusY} onChange={(ev) => set({ focusY: Number(ev.target.value) })} />
                          </FieldWrap>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-3">
                      <Button icon="Image" onClick={() => setChoose(e.id)} disabled={!can('media.view')}>
                        Bild aus den Medien wählen
                      </Button>
                      {!e.required && <span className="text-sm text-fg-muted">optional</span>}
                    </div>
                  )}
                </fieldset>
              );
            })}
            <FieldWrap label="Alternativtext" htmlFor="fill-alt" help="Beschreibt das Bild für Screenreader; wird am erzeugten Bild in den Medien gespeichert.">
              <Textarea
                id="fill-alt"
                rows={2}
                maxLength={1000}
                value={alt}
                onChange={(e) => {
                  altTouched.current = true;
                  setAlt(e.target.value);
                }}
              />
            </FieldWrap>
            {can('media.view') && (
              <FieldWrap label="Ablegen in" htmlFor="fill-target" help={postId ? 'Automatisch: in der Sammlung des Beitrags, sonst in „Bilder aus Vorlagen“.' : 'Automatisch: in der Sammlung „Bilder aus Vorlagen“.'}>
                <Select id="fill-target" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                  <option value="">Automatisch</option>
                  {(cols.data ?? [])
                    .filter((c) => !c.archived_at)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                </Select>
              </FieldWrap>
            )}
          </div>
          <div className="flex flex-col gap-2 min-w-0 md:sticky md:top-0 self-start w-full">
            <div className="text-sm font-medium flex items-center gap-2">
              Vorschau {preview.loading && <Icon name="RefreshCw" size={13} className="animate-spin text-fg-muted" />}
            </div>
            <div className={cx('rounded-card border border-line bg-raised overflow-hidden flex items-center justify-center', preview.loading && 'opacity-80')} style={{ aspectRatio: `${layout.width} / ${layout.height}`, maxHeight: '70vh' }}>
              {preview.url ? <img src={preview.url} alt={alt ? `Vorschau: ${alt}` : 'Vorschau des Bildes'} className="w-full h-full object-contain" /> : <Skeleton className="w-full h-full" />}
            </div>
            {preview.error && <Notice tone="error">{preview.error}</Notice>}
            <p className="m-0 text-meta text-fg-muted">
              {layout.width} × {layout.height} px · erzeugt wird in voller Größe als PNG
            </p>
          </div>
        </div>
      )}
      {choose && <ImageMediaPicker onClose={() => setChoose(null)} onPick={(m) => setImages({ ...images, [choose]: { mediaId: m.id, focusX: 0.5, focusY: 0.5, zoom: 1, name: m.display_name || m.original_name } })} />}
    </Dialog>
  );
}
