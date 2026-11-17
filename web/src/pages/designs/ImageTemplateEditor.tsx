import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get, put } from '../../api/client';
import { Button, Card, cx, ErrorBox, FieldWrap, FilePickButton, Input, Notice, PageHeader, SegmentedControl, Select, SkeletonRows, Switch } from '../../components/ui/core';
import { usePageMeta } from '../../components/layout/AppShell';
import { Icon } from '../../components/ui/Icon';
import { UnsavedChangesGuard, useErrorToast, useToast } from '../../components/ui/overlays';
import { useServerPreview, type Layout, type LayoutElement } from './ImageFill';

/*
 * Editor für befüllbare Bildvorlagen (#209): Elemente mit Maus (ziehen, Ecke ziehen) und Tastatur (Pfeiltasten
 * verschieben, Strg/⌘ + Pfeiltasten Größe, mit Umschalt in 10er-Schritten) positionieren; alle Werte auch als Zahlen.
 * Die Vorschau rendert der Server – sie zeigt Schrift, Umbruch und Verkleinerung genau wie das erzeugte Bild.
 */

interface FontInfo {
  key: string;
  label: string;
  bundled: boolean;
}
interface Preset {
  key: string;
  label: string;
  width: number;
  height: number;
}

const TYPE_LABEL: Record<LayoutElement['type'], string> = { text: 'Textfeld', image: 'Bild-Platzhalter', logo: 'Logo', shape: 'Fläche' };
const TYPE_ICON: Record<LayoutElement['type'], string> = { text: 'Type', image: 'Image', logo: 'Star', shape: 'Square' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Element innerhalb der Fläche halten (Größe zuerst, dann Lage). */
function fitInside(e: LayoutElement, l: Layout): LayoutElement {
  const w = clamp(Math.round(e.w), 4, l.width);
  const h = clamp(Math.round(e.h), 4, l.height);
  return { ...e, w, h, x: clamp(Math.round(e.x), 0, l.width - w), y: clamp(Math.round(e.y), 0, l.height - h) };
}

function newElement(type: LayoutElement['type'], l: Layout, ids: string[]): LayoutElement {
  const base = { text: 'text', image: 'bild', logo: 'logo', shape: 'flaeche' }[type];
  let n = 1;
  while (ids.includes(n === 1 ? base : `${base}${n}`)) n++;
  const id = n === 1 ? base : `${base}${n}`;
  const m = Math.min(l.width, l.height);
  const w = Math.round(l.width * (type === 'logo' ? 0.25 : 0.6));
  const h = Math.round(l.height * (type === 'text' ? 0.12 : type === 'logo' ? 0.1 : 0.3));
  const common = { id, label: `${TYPE_LABEL[type]}${n > 1 ? ` ${n}` : ''}`, type, x: Math.round((l.width - w) / 2), y: Math.round((l.height - h) / 2), w, h };
  if (type === 'text') return { ...common, font: 'barlow-condensed-bold', size: Math.round(m * 0.07), minSize: Math.round(m * 0.03), color: '#ffffff', align: 'left', valign: 'top', maxLines: 2, lineHeight: 1, uppercase: false, maxLength: 120, default: '', hint: '' };
  if (type === 'image') return { ...common, fit: 'cover', radius: 0, required: false };
  if (type === 'logo') return { ...common, assetId: null };
  return { ...common, color: '#000000', opacity: 0.6, radius: 0 };
}

async function uploadAsset(templateId: string, file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  return (await api<{ id: string }>('POST', `/design-templates/${templateId}/assets`, fd)).id;
}

/** Zahlenfeld: übernimmt gültige Werte sofort, alles andere erst beim Verlassen (dann auf die Grenzen gesetzt). */
function NumberField({ id, label, value, onChange, min, max, step = 1 }: { id: string; label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  const ok = (n: number) => Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max);
  return (
    <FieldWrap label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && ok(n)) onChange(n);
        }}
        onBlur={() => {
          focused.current = false;
          const n = Number(text);
          if (text !== '' && Number.isFinite(n)) {
            const c = clamp(n, min ?? -Infinity, max ?? Infinity);
            if (c !== value) onChange(c);
            setText(String(c));
          } else setText(String(value));
        }}
      />
    </FieldWrap>
  );
}

/** Kennung: frei tippen, beim Verlassen auf Kleinbuchstaben, Ziffern und _ bringen. */
function IdField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <FieldWrap label="Kennung" htmlFor={id} help="Für Workflows, z. B. titel (Kleinbuchstaben, Ziffern, _).">
      <Input
        id={id}
        value={text}
        mono
        maxLength={40}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const clean = text.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '').slice(0, 40);
          if (clean && clean !== value) onChange(clean);
          else setText(value);
        }}
      />
    </FieldWrap>
  );
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <FieldWrap label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} wählen`} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-11 shrink-0 cursor-pointer rounded-control border border-line bg-bg" />
        <Input
          id={id}
          value={text}
          maxLength={7}
          mono
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
        />
      </div>
    </FieldWrap>
  );
}

function AssetField({ id, label, templateId, assetId, onChange }: { id: string; label: string; templateId: string; assetId: string | null; onChange: (id: string | null) => void }) {
  const toastError = useErrorToast();
  const [busy, setBusy] = useState(false);
  return (
    <FieldWrap label={label} htmlFor={id} help="PNG, JPEG, WebP oder SVG; SVG wird bereinigt, Fotos ohne Metadaten neu gespeichert.">
      <FilePickButton
        id={id}
        name={label}
        accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
        label={assetId ? 'Anderes Bild …' : 'Bild wählen …'}
        emptyText="Kein Bild"
        busy={busy}
        preview={assetId ? <img src={`/api/v1/design-templates/${templateId}/assets/${assetId}`} alt="" className="h-12 w-auto max-w-[120px] object-contain rounded-chip border border-line bg-raised" /> : undefined}
        onRemove={() => onChange(null)}
        onPick={async ([f]) => {
          setBusy(true);
          try {
            onChange(await uploadAsset(templateId, f));
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </FieldWrap>
  );
}

function ElementProps({ el, layout, fonts, templateId, onChange }: { el: LayoutElement; layout: Layout; fonts: FontInfo[]; templateId: string; onChange: (e: LayoutElement) => void }) {
  const set = (patch: Partial<LayoutElement>) => onChange(fitInside({ ...el, ...patch }, layout));
  const id = (k: string) => `el-${k}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 grid-cols-2">
        <FieldWrap label="Bezeichnung" htmlFor={id('label')} help="Steht beim Ausfüllen über dem Feld.">
          <Input id={id('label')} value={el.label} maxLength={60} onChange={(e) => onChange({ ...el, label: e.target.value })} />
        </FieldWrap>
        <IdField id={id('id')} value={el.id} onChange={(v) => onChange({ ...el, id: v })} />
      </div>
      <div className="grid gap-3 grid-cols-4">
        <NumberField id={id('x')} label="X" value={el.x} onChange={(v) => set({ x: v })} min={0} max={layout.width} />
        <NumberField id={id('y')} label="Y" value={el.y} onChange={(v) => set({ y: v })} min={0} max={layout.height} />
        <NumberField id={id('w')} label="Breite" value={el.w} onChange={(v) => set({ w: v })} min={4} max={layout.width} />
        <NumberField id={id('h')} label="Höhe" value={el.h} onChange={(v) => set({ h: v })} min={4} max={layout.height} />
      </div>
      {el.type === 'text' && (
        <>
          <FieldWrap label="Schrift" htmlFor={id('font')}>
            <Select id={id('font')} value={el.font} onChange={(e) => set({ font: e.target.value })}>
              {fonts.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                  {f.bundled ? '' : ' (eigene)'}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <div className="grid gap-3 grid-cols-3">
            <NumberField id={id('size')} label="Größe (px)" value={el.size} onChange={(v) => set({ size: clamp(v, 8, 400), minSize: Math.min(el.minSize, clamp(v, 8, 400)) })} min={8} max={400} />
            <NumberField id={id('min')} label="Mindestgröße" value={el.minSize} onChange={(v) => set({ minSize: clamp(v, 6, el.size) })} min={6} max={el.size} />
            <NumberField id={id('lines')} label="Max. Zeilen" value={el.maxLines} onChange={(v) => set({ maxLines: clamp(v, 1, 20) })} min={1} max={20} />
          </div>
          <div className="grid gap-3 grid-cols-2">
            <ColorField id={id('color')} label="Farbe" value={el.color} onChange={(v) => set({ color: v })} />
            <NumberField id={id('lh')} label="Zeilenhöhe" value={el.lineHeight} onChange={(v) => set({ lineHeight: clamp(v, 0.8, 2) })} min={0.8} max={2} step={0.05} />
          </div>
          <SegmentedControl label="Ausrichtung" size="sm" value={el.align} onChange={(v) => set({ align: v })} options={[{ value: 'left', label: 'Links' }, { value: 'center', label: 'Mitte' }, { value: 'right', label: 'Rechts' }]} />
          <SegmentedControl label="Senkrecht" size="sm" value={el.valign} onChange={(v) => set({ valign: v })} options={[{ value: 'top', label: 'Oben' }, { value: 'middle', label: 'Mitte' }, { value: 'bottom', label: 'Unten' }]} />
          <Switch checked={el.uppercase} onChange={(v) => set({ uppercase: v })} label="Großbuchstaben" />
          <FieldWrap label="Vorgabetext" htmlFor={id('def')} help="Erscheint, wenn beim Ausfüllen nichts eingetragen wird.">
            <Input id={id('def')} value={el.default} maxLength={500} onChange={(e) => set({ default: e.target.value })} />
          </FieldWrap>
          <div className="grid gap-3 grid-cols-2">
            <NumberField id={id('maxlen')} label="Max. Zeichen" value={el.maxLength} onChange={(v) => set({ maxLength: clamp(v, 1, 500) })} min={1} max={500} />
            <FieldWrap label="Hinweis beim Ausfüllen" htmlFor={id('hint')}>
              <Input id={id('hint')} value={el.hint} maxLength={200} onChange={(e) => set({ hint: e.target.value })} />
            </FieldWrap>
          </div>
        </>
      )}
      {el.type === 'image' && (
        <>
          <SegmentedControl label="Einpassen" size="sm" value={el.fit} onChange={(v) => set({ fit: v })} options={[{ value: 'cover', label: 'Füllen (Zuschnitt)' }, { value: 'contain', label: 'Ganz zeigen' }]} />
          <NumberField id={id('radius')} label="Eckenradius (px)" value={el.radius} onChange={(v) => set({ radius: clamp(v, 0, 2000) })} min={0} />
          <Switch checked={el.required} onChange={(v) => set({ required: v })} label="Bild ist Pflicht" />
        </>
      )}
      {el.type === 'logo' && <AssetField id={id('asset')} label="Bild des Logos" templateId={templateId} assetId={el.assetId} onChange={(v) => set({ assetId: v })} />}
      {el.type === 'shape' && (
        <div className="grid gap-3 grid-cols-3">
          <ColorField id={id('color')} label="Farbe" value={el.color} onChange={(v) => set({ color: v })} />
          <NumberField id={id('op')} label="Deckkraft (%)" value={Math.round(el.opacity * 100)} onChange={(v) => set({ opacity: clamp(v, 0, 100) / 100 })} min={0} max={100} />
          <NumberField id={id('radius')} label="Eckenradius" value={el.radius} onChange={(v) => set({ radius: clamp(v, 0, 2000) })} min={0} />
        </div>
      )}
    </div>
  );
}

export default function ImageTemplateEditor() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const detail = useQuery({ queryKey: ['design-template', id], queryFn: () => get<any>(`/design-templates/${id}`) });
  usePageMeta({ title: detail.data?.title ? `Bildvorlage gestalten: ${detail.data.title}` : 'Bildvorlage gestalten' });
  const fontsQ = useQuery({ queryKey: ['design-fonts'], queryFn: () => get<{ fonts: FontInfo[]; formats: Preset[] }>('/design-fonts') });
  const [layout, setLayout] = useState<Layout | null>(null);
  const [saved, setSaved] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; sx: number; sy: number; start: LayoutElement } | null>(null);

  useEffect(() => {
    if (detail.data?.layout && !layout) {
      setLayout(detail.data.layout);
      setSaved(JSON.stringify(detail.data.layout));
      setSel(detail.data.layout.elements[0]?.id ?? null);
    }
  }, [detail.data, layout]);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !layout) return;
    // Größter Maßstab, bei dem die Fläche in die Breite und in 75 % der Fensterhöhe passt
    const fit = () => setScale(Math.min(el.clientWidth / layout.width, (window.innerHeight * 0.75) / layout.height));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    fit();
    return () => (ro.disconnect(), window.removeEventListener('resize', fit));
  }, [layout?.width, layout?.height, !!layout]);
  const preview = useServerPreview(layout ? `/design-templates/${id}/layout-preview` : null, { layout });

  if (detail.isLoading || fontsQ.isLoading) return <SkeletonRows rows={6} />;
  if (detail.error) return <ErrorBox title="Vorlage konnte nicht geladen werden">{(detail.error as Error).message}</ErrorBox>;
  if (detail.data && detail.data.kind !== 'image') return <ErrorBox title="Keine Bildvorlage">Diese Vorlage enthält Dateien zum Herunterladen und hat keinen Editor.</ErrorBox>;
  if (!layout) return <SkeletonRows rows={6} />;

  const dirty = JSON.stringify(layout) !== saved;
  const current = layout.elements.find((e) => e.id === sel) ?? null;
  const update = (eid: string, e: LayoutElement) => {
    setLayout({ ...layout, elements: layout.elements.map((x) => (x.id === eid ? e : x)) });
    if (eid !== e.id) setSel(e.id);
  };
  const move = (i: number, d: -1 | 1) => {
    const list = [...layout.elements];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setLayout({ ...layout, elements: list });
  };
  const setFormat = (w: number, h: number) => {
    const sx = w / layout.width;
    const sy = h / layout.height;
    const next: Layout = { ...layout, width: w, height: h };
    next.elements = layout.elements.map((e) => fitInside({ ...e, x: e.x * sx, y: e.y * sy, w: e.w * sx, h: e.h * sy, ...(e.type === 'text' ? { size: Math.max(8, Math.round(e.size * Math.min(sx, sy))), minSize: Math.max(6, Math.round(e.minSize * Math.min(sx, sy))) } : {}) }, next));
    setLayout(next);
  };
  const onKey = (ev: React.KeyboardEvent, e: LayoutElement) => {
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[ev.key];
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      setLayout({ ...layout, elements: layout.elements.filter((x) => x.id !== e.id) });
      setSel(null);
      return;
    }
    if (!d) return;
    ev.preventDefault();
    const step = ev.shiftKey ? 10 : 1;
    const resize = ev.ctrlKey || ev.metaKey;
    update(e.id, fitInside(resize ? { ...e, w: e.w + d[0] * step, h: e.h + d[1] * step } : { ...e, x: e.x + d[0] * step, y: e.y + d[1] * step }, layout));
  };
  const onPointerDown = (ev: React.PointerEvent, e: LayoutElement, mode: 'move' | 'resize') => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    setSel(e.id);
    drag.current = { id: e.id, mode, sx: ev.clientX, sy: ev.clientY, start: e };
  };
  const onPointerMove = (ev: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const dx = (ev.clientX - g.sx) / scale;
    const dy = (ev.clientY - g.sy) / scale;
    const s = g.start;
    update(g.id, fitInside(g.mode === 'move' ? { ...s, x: s.x + dx, y: s.y + dy } : { ...s, w: s.w + dx, h: s.h + dy }, layout));
  };
  const endDrag = () => (drag.current = null);
  const save = async () => {
    setBusy(true);
    try {
      const r = await put<{ layout: Layout }>(`/design-templates/${id}/layout`, { layout });
      setLayout(r.layout);
      setSaved(JSON.stringify(r.layout));
      qc.invalidateQueries({ queryKey: ['design-template', id] });
      qc.invalidateQueries({ queryKey: ['design-templates'] });
      toast({ tone: 'success', title: 'Layout gespeichert' });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const presets = fontsQ.data?.formats ?? [];
  const presetKey = presets.find((p) => p.width === layout.width && p.height === layout.height)?.key ?? 'custom';
  return (
    <div className="flex flex-col gap-5">
      <UnsavedChangesGuard when={dirty} />
      <div>
        <Link to={`/designvorlagen/${id}`} className="text-sm inline-flex items-center gap-1">
          <Icon name="ArrowLeft" size={14} /> {detail.data?.title}
        </Link>
      </div>
      <PageHeader
        subtitle="Elemente mit der Maus ziehen oder auswählen und mit den Pfeiltasten verschieben. Die Vorschau zeigt das Ergebnis genau so, wie es erzeugt wird."
        actions={
          <Button variant="primary" icon="Save" loading={busy} disabled={!dirty} onClick={save}>
            Speichern
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(340px,2fr)]">
        <Card bodyClassName="flex flex-col gap-2">
          <p id="stage-help" className="m-0 text-meta text-fg-muted">
            Tastatur: Element mit Tab wählen, Pfeiltasten verschieben (mit Umschalt 10 px), Strg bzw. ⌘ + Pfeiltasten ändern die Größe, Entf entfernt das Element.
          </p>
          <div ref={stageRef} className="w-full">
          <div
            className="relative select-none bg-raised rounded-control overflow-hidden touch-none mx-auto"
            style={{ width: Math.floor(layout.width * scale), height: Math.floor(layout.height * scale) }}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerDown={() => setSel(null)}
          >
            {preview.url && <img src={preview.url} alt="Vorschau der Vorlage mit Vorgabetexten" className="absolute inset-0 w-full h-full" draggable={false} />}
            {layout.elements.map((e) => {
              const on = e.id === sel;
              return (
                <div
                  key={e.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  aria-describedby="stage-help"
                  aria-label={`${e.label} (${TYPE_LABEL[e.type]}), X ${e.x}, Y ${e.y}, ${e.w} × ${e.h} Pixel`}
                  className={cx('absolute outline-none cursor-move', on ? 'ring-2 ring-primary' : 'ring-1 ring-white/70 hover:ring-primary/70 focus-visible:ring-2 focus-visible:ring-primary')}
                  style={{ left: e.x * scale, top: e.y * scale, width: e.w * scale, height: e.h * scale, boxShadow: on ? '0 0 0 1px rgba(0,0,0,.5)' : undefined }}
                  onPointerDown={(ev) => onPointerDown(ev, e, 'move')}
                  onFocus={() => setSel(e.id)}
                  onKeyDown={(ev) => onKey(ev, e)}
                >
                  <span className="absolute left-0 top-0 -translate-y-full text-[11px] leading-4 px-1 rounded-t bg-primary-solid text-on-primary whitespace-nowrap pointer-events-none" hidden={!on}>
                    {e.label}
                  </span>
                  {on && (
                    <span
                      aria-hidden="true"
                      className="absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-sm bg-primary-solid border border-white cursor-nwse-resize"
                      onPointerDown={(ev) => onPointerDown(ev, e, 'resize')}
                    />
                  )}
                </div>
              );
            })}
          </div>
          </div>
          {preview.error && <Notice tone="error">{preview.error}</Notice>}
          <p className="m-0 text-meta text-fg-muted">
            {layout.width} × {layout.height} px{preview.loading ? ' · Vorschau wird aktualisiert …' : ''}
          </p>
        </Card>
        <div className="flex flex-col gap-5 min-w-0">
          <Card title="Format und Hintergrund" bodyClassName="flex flex-col gap-3">
            <FieldWrap label="Format" htmlFor="fmt" help="Beim Wechsel werden die Elemente mitskaliert.">
              <Select id="fmt" value={presetKey} onChange={(e) => { const p = presets.find((x) => x.key === e.target.value); if (p) setFormat(p.width, p.height); }}>
                {presets.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
                {presetKey === 'custom' && <option value="custom">Eigenes Format</option>}
              </Select>
            </FieldWrap>
            <div className="grid gap-3 grid-cols-2">
              <NumberField id="fmt-w" label="Breite (px)" value={layout.width} onChange={(v) => setFormat(Math.round(v), layout.height)} min={200} max={4000} />
              <NumberField id="fmt-h" label="Höhe (px)" value={layout.height} onChange={(v) => setFormat(layout.width, Math.round(v))} min={200} max={4000} />
            </div>
            <ColorField id="bg-color" label="Hintergrundfarbe" value={layout.background.color} onChange={(v) => setLayout({ ...layout, background: { ...layout.background, color: v } })} />
            <AssetField id="bg-asset" label="Hintergrundbild" templateId={id} assetId={layout.background.assetId} onChange={(v) => setLayout({ ...layout, background: { ...layout.background, assetId: v } })} />
          </Card>
          <Card title="Elemente" subtitle="Oben in der Liste liegt hinten im Bild.">
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
              {layout.elements.map((e, i) => (
                <li key={e.id} className={cx('flex items-center gap-2 rounded-control px-2 py-1', e.id === sel && 'bg-raised')}>
                  <Icon name={TYPE_ICON[e.type]} size={15} className="text-fg-muted shrink-0" />
                  <button type="button" className="flex-1 text-left text-sm truncate bg-transparent border-0 p-1 cursor-pointer text-fg" aria-pressed={e.id === sel} onClick={() => setSel(e.id)}>
                    {e.label} <span className="text-fg-muted">· {TYPE_LABEL[e.type]}</span>
                  </button>
                  <Button size="sm" iconOnly icon="ArrowUp" aria-label={`${e.label} nach hinten`} disabled={i === 0} onClick={() => move(i, -1)} />
                  <Button size="sm" iconOnly icon="ArrowDown" aria-label={`${e.label} nach vorn`} disabled={i === layout.elements.length - 1} onClick={() => move(i, 1)} />
                  <Button size="sm" iconOnly icon="Trash2" aria-label={`${e.label} entfernen`} onClick={() => (setLayout({ ...layout, elements: layout.elements.filter((x) => x.id !== e.id) }), setSel(null))} />
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2 mt-3">
              {(['text', 'image', 'logo', 'shape'] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  icon="Plus"
                  disabled={layout.elements.length >= 30}
                  onClick={() => {
                    const e = newElement(t, layout, layout.elements.map((x) => x.id));
                    setLayout({ ...layout, elements: [...layout.elements, e] });
                    setSel(e.id);
                  }}
                >
                  {TYPE_LABEL[t]}
                </Button>
              ))}
            </div>
          </Card>
          {current && (
            <Card title={`${TYPE_LABEL[current.type]}: ${current.label}`}>
              <ElementProps el={current} layout={layout} fonts={fontsQ.data?.fonts ?? []} templateId={id} onChange={(e) => update(current.id, e)} />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
