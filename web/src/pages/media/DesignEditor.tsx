import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get, put } from '../../api/client';
import { Button, Card, cx, ErrorBox, FieldWrap, FilePickButton, Input, Notice, PageHeader, SegmentedControl, Select, SkeletonRows, Switch, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { UnsavedChangesGuard, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { DesignedPage, type DesignBlock, type UploadDesign } from '../public/DesignedPage';
import type { LinkInfo } from '../public/UploadPage';
import { usePageMeta } from '../../components/layout/AppShell';

interface Meta {
  accents: Record<string, string>;
  blockTypes: Record<string, string>;
  maxBlocks: number;
}

const BLOCK_ICONS: Record<string, string> = { banner: 'PanelTop', logo: 'Image', heading: 'Type', text: 'FileText', image: 'ImageUp', note: 'Info', divider: 'SeparatorHorizontal', welcome: 'MessageCircle', upload: 'Upload' };
const NEW_BLOCK: Record<string, DesignBlock> = {
  banner: { type: 'banner', image: '', alt: '', height: 'm' },
  logo: { type: 'logo', image: '', alt: '', align: 'center' },
  heading: { type: 'heading', text: '{thema}', size: 'l' },
  text: { type: 'text', text: '' },
  image: { type: 'image', image: '', alt: '', caption: '' },
  note: { type: 'note', text: '', style: 'info' },
  divider: { type: 'divider' },
  welcome: { type: 'welcome' },
};

/** Bild für einen Baustein hochladen (neu kodiert, ohne Metadaten). */
async function uploadImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await api<any>('POST', '/media/design-images', fd);
  return res.id as string;
}

function BlockFields({ b, onChange, idx }: { b: DesignBlock; onChange: (b: DesignBlock) => void; idx: number }) {
  const toastError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const id = (k: string) => `de-${idx}-${k}`;
  const set = (k: string, v: string) => onChange({ ...b, [k]: v });
  const imageField = (
    <FieldWrap label="Bild" htmlFor={id('img')} help="JPEG, PNG oder WebP bis 15 MB; wird neu kodiert, Standort- und Kameradaten werden entfernt.">
      <FilePickButton
        id={id('img')}
        name="Bild"
        accept="image/jpeg,image/png,image/webp"
        label={b.image ? 'Anderes Bild …' : 'Bild wählen …'}
        emptyText="Kein Bild"
        busy={busy}
        preview={b.image ? <img src={`/api/v1/public/design-images/${b.image}`} alt="" className="h-12 w-auto rounded-chip border border-line" /> : undefined}
        onPick={async ([f]) => {
          setBusy(true);
          try {
            set('image', await uploadImage(f));
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </FieldWrap>
  );
  const alt = (
    <FieldWrap label="Bildbeschreibung (Alternativtext)" htmlFor={id('alt')} help="Für Screenreader; leer bei rein dekorativen Bildern.">
      <Input id={id('alt')} value={b.alt ?? ''} maxLength={150} onChange={(e) => set('alt', e.target.value)} />
    </FieldWrap>
  );
  switch (b.type) {
    case 'banner':
      return (
        <>
          {imageField}
          {alt}
          <FieldWrap label="Höhe" htmlFor={id('h')}>
            <Select id={id('h')} value={b.height} onChange={(e) => set('height', e.target.value)}>
              <option value="s">niedrig</option>
              <option value="m">mittel</option>
              <option value="l">hoch</option>
            </Select>
          </FieldWrap>
        </>
      );
    case 'logo':
      return (
        <>
          {imageField}
          {alt}
          <FieldWrap label="Ausrichtung" htmlFor={id('a')}>
            <Select id={id('a')} value={b.align} onChange={(e) => set('align', e.target.value)}>
              <option value="center">mittig</option>
              <option value="left">links</option>
            </Select>
          </FieldWrap>
        </>
      );
    case 'heading':
      return (
        <>
          <FieldWrap label="Text" htmlFor={id('t')} help="Platzhalter: {thema} = Titel der Sammlung, {datum} = Veranstaltungsdatum.">
            <Input id={id('t')} value={b.text ?? ''} maxLength={120} onChange={(e) => set('text', e.target.value)} />
          </FieldWrap>
          <FieldWrap label="Größe" htmlFor={id('s')}>
            <Select id={id('s')} value={b.size} onChange={(e) => set('size', e.target.value)}>
              <option value="l">groß</option>
              <option value="m">mittel</option>
            </Select>
          </FieldWrap>
        </>
      );
    case 'text':
      return (
        <FieldWrap label="Text" htmlFor={id('t')} help="Platzhalter {thema} und {datum}. Nur Text – Formatierungen und Links werden nicht übernommen.">
          <Textarea id={id('t')} rows={4} value={b.text ?? ''} maxLength={2000} onChange={(e) => set('text', e.target.value)} />
        </FieldWrap>
      );
    case 'image':
      return (
        <>
          {imageField}
          {alt}
          <FieldWrap label="Bildunterschrift" htmlFor={id('c')}>
            <Input id={id('c')} value={b.caption ?? ''} maxLength={200} onChange={(e) => set('caption', e.target.value)} />
          </FieldWrap>
        </>
      );
    case 'note':
      return (
        <>
          <FieldWrap label="Text" htmlFor={id('t')}>
            <Textarea id={id('t')} rows={3} value={b.text ?? ''} maxLength={500} onChange={(e) => set('text', e.target.value)} />
          </FieldWrap>
          <FieldWrap label="Art" htmlFor={id('st')}>
            <Select id={id('st')} value={b.style} onChange={(e) => set('style', e.target.value)}>
              <option value="info">Hinweis</option>
              <option value="warning">Warnung</option>
            </Select>
          </FieldWrap>
        </>
      );
    case 'welcome':
      return <p className="m-0 text-sm text-fg-muted">Zeigt den Begrüßungstext des Links bzw. den Hinweis der Sammlung.</p>;
    case 'upload':
      return <p className="m-0 text-sm text-fg-muted">Knöpfe zum Auswählen und Aufnehmen, abgefragte Angaben, Liste und Senden. Pflicht, genau einmal.</p>;
    default:
      return null;
  }
}

/**
 * Gestaltung der Upload-Seite (wie LiFeOS): Bausteine, Akzentfarbe, Live-Vorschau (Handy/Rechner).
 * Ohne `?link=` die Standardgestaltung (speichern: „Medien administrieren“), mit `?link=` die eines Links.
 */
export default function DesignEditor() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const linkId = params.get('link');
  const { can } = useAuth();
  // Gestaltung eines einzelnen Upload-Links gehört zur Sammlung (Medien), die Standard-Gestaltung zu Einrichtung
  usePageMeta(linkId ? { title: 'Upload-Link gestalten', navId: 'media' } : {});
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const ask = useConfirm();
  const q = useQuery({ queryKey: ['design', linkId], queryFn: () => get<any>(linkId ? `/upload-links/${linkId}/design` : '/media/design') });
  const [design, setDesign] = useState<UploadDesign | null>(null);
  const [own, setOwn] = useState(true);
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');
  const [addType, setAddType] = useState('heading');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setDesign(structuredClone(linkId ? (q.data.own ?? q.data.default) : q.data.design));
    setOwn(linkId ? !!q.data.own : true);
    setDirty(false);
  }, [q.data, linkId]);
  const meta: Meta | undefined = q.data;
  const canSave = linkId ? can('media.design') : can('media.admin');
  const update = (d: UploadDesign) => (setDesign(d), setDirty(true));
  const info: LinkInfo = useMemo(
    () => ({
      collection: { title: q.data?.link?.title ?? 'Sommerfest', purpose: q.data?.link?.purpose ?? 'Fotos und Videos vom Sommerfest', note: q.data?.link?.note ?? '' },
      welcome_text: q.data?.link?.welcome_text ?? null,
      camera_buttons: true,
      organization: 'Organisation',
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      max_file_bytes: 2 * 1024 ** 3,
      remaining_files: 100,
      accept: 'image/*,video/*',
      privacy: { controller: '', dpo_contact: '', policy_url: '', notice: '', ip_retention_days: 30, collection_retention_days: 365 },
    }),
    [q.data],
  );
  // Veranstaltungsdatum ist ein reines Datum (JJJJ-MM-TT) – ohne Umrechnung in eine Zeitzone lesen
  const eventDay = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(q.data?.link?.event_date ?? ''));
  const resolve = (t: string) => (t ?? '').replaceAll('{thema}', info.collection.title).replaceAll('{datum}', eventDay ? `${eventDay[3]}.${eventDay[2]}.${eventDay[1]}` : '');
  const previewDesign = design ? { ...design, blocks: design.blocks.map((b) => ({ ...b, ...(b.text !== undefined ? { text: resolve(b.text) } : {}), ...(b.caption !== undefined ? { caption: resolve(b.caption) } : {}) })) } : null;

  const move = (i: number, d: -1 | 1) => {
    if (!design) return;
    const blocks = [...design.blocks];
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    update({ ...design, blocks });
  };
  const save = async (value: UploadDesign | null) => {
    setBusy(true);
    try {
      await put(linkId ? `/upload-links/${linkId}/design` : '/media/design', { design: value });
      toast({ tone: 'success', title: 'Gestaltung gespeichert' });
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['design'] });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (q.isLoading || (!design && !q.error)) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorBox title="Gestaltung konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>;
  const d = design!;
  return (
    <div className="flex flex-col gap-5">
      <UnsavedChangesGuard when={dirty} />
      <PageHeader
        subtitle={linkId ? `${q.data.link.title}${q.data.link.label ? ` · ${q.data.link.label}` : ''}` : 'Standard für alle Upload-Links ohne eigene Gestaltung.'}
        actions={
          canSave && (
            <>
              {linkId && own && (
                <Button
                  icon="Undo2"
                  onClick={async () => {
                    if (!(await ask({ title: 'Standard verwenden?', text: 'Die eigene Gestaltung dieses Links wird verworfen.', confirmLabel: 'Standard verwenden' }))) return;
                    await save(null);
                  }}
                >
                  Standard verwenden
                </Button>
              )}
              <Button variant="primary" icon="Save" loading={busy} disabled={!dirty && (own || !linkId)} onClick={() => void save(d)}>
                Speichern
              </Button>
            </>
          )
        }
      />
      {linkId && (
        <Button size="sm" variant="ghost" icon="ArrowLeft" className="self-start" onClick={() => navigate(-1)}>
          Zurück zur Sammlung
        </Button>
      )}
      {!canSave && <Notice>Ansehen ist möglich; die Standardgestaltung ändert, wer „Medien administrieren“ hat. Einzelne Links lassen sich mit „Upload-Seite gestalten“ gestalten.</Notice>}
      {linkId && !own && <Notice>Dieser Link nutzt die Standardgestaltung. Änderungen hier werden als eigene Gestaltung des Links gespeichert.</Notice>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Allgemein">
            <div className="flex flex-col gap-4">
              <FieldWrap label="Akzentfarbe" htmlFor="de-accent" help="Feste Auswahl mit gutem Kontrast; gilt für die Knöpfe der Upload-Seite.">
                <div className="flex flex-wrap items-center gap-2">
                  <Select id="de-accent" value={d.accent} onChange={(e) => update({ ...d, accent: e.target.value })} className="max-w-[220px]">
                    {Object.entries(meta!.accents).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  <span aria-hidden="true" className="inline-block w-8 h-8 rounded-control border border-line" style={{ backgroundColor: `var(--bc-upload-accent-${d.accent})` }} />
                </div>
              </FieldWrap>
              <Switch checked={d.header} onChange={(v) => update({ ...d, header: v })} label="Kopfbereich anzeigen" description="Organisation, Titel und Zweck der Sammlung sowie Gültigkeit des Links." />
            </div>
          </Card>
          <Card
            title={`Bausteine (${d.blocks.length} von ${meta!.maxBlocks})`}
            subtitle="Reihenfolge mit den Pfeilen. Der Datenschutzabschnitt steht immer am Ende und lässt sich nicht entfernen."
            action={
              <div className="flex items-center gap-2">
                <Select aria-label="Baustein wählen" value={addType} onChange={(e) => setAddType(e.target.value)} className="!h-ctl-sm !w-auto">
                  {Object.keys(NEW_BLOCK)
                    .filter((t) => t !== 'welcome' || !d.blocks.some((b) => b.type === 'welcome'))
                    .map((t) => (
                      <option key={t} value={t}>
                        {meta!.blockTypes[t]}
                      </option>
                    ))}
                </Select>
                <Button size="sm" icon="Plus" disabled={d.blocks.length >= meta!.maxBlocks} onClick={() => update({ ...d, blocks: [...d.blocks, structuredClone(NEW_BLOCK[addType])] })}>
                  Hinzufügen
                </Button>
              </div>
            }
            bodyClassName="flex flex-col gap-3"
          >
            {d.blocks.map((b, i) => (
              <section key={i} aria-label={meta!.blockTypes[b.type]} className="border border-line rounded-node p-3 flex flex-col gap-3 bg-card">
                <div className="flex items-center gap-2">
                  <Icon name={BLOCK_ICONS[b.type] ?? 'Box'} size={16} className="text-fg-muted" />
                  <span className="font-medium text-sm flex-1">{meta!.blockTypes[b.type]}</span>
                  <Button size="sm" iconOnly icon="ArrowUp" aria-label="Nach oben" disabled={i === 0} onClick={() => move(i, -1)} />
                  <Button size="sm" iconOnly icon="ArrowDown" aria-label="Nach unten" disabled={i === d.blocks.length - 1} onClick={() => move(i, 1)} />
                  {b.type !== 'upload' && <Button size="sm" iconOnly variant="ghost" icon="Trash2" aria-label={`${meta!.blockTypes[b.type]} entfernen`} onClick={() => update({ ...d, blocks: d.blocks.filter((_, j) => j !== i) })} />}
                </div>
                <BlockFields b={b} idx={i} onChange={(nb) => update({ ...d, blocks: d.blocks.map((x, j) => (j === i ? nb : x)) })} />
              </section>
            ))}
          </Card>
        </div>
        <div className="flex flex-col gap-3 min-w-0 xl:sticky xl:top-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-label uppercase text-fg-muted">Vorschau</span>
            <SegmentedControl
              label="Gerät"
              size="sm"
              value={device}
              onChange={setDevice}
              options={[
                { value: 'phone', label: 'Handy' },
                { value: 'desktop', label: 'Rechner' },
              ]}
            />
          </div>
          <div className="border border-line rounded-card bg-raised p-3 overflow-auto max-h-[80vh]">
            <div className={cx('mx-auto bg-bg rounded-node border border-line px-4 py-6 transition-[max-width]', device === 'phone' ? 'max-w-[390px]' : 'max-w-[760px]')} aria-label="Vorschau der Upload-Seite" role="region">
              {previewDesign && <DesignedPage info={info} design={previewDesign} token="vorschau" preview />}
            </div>
          </div>
          <p className="m-0 text-meta text-fg-muted">Die Vorschau nutzt Beispieldaten; Datenschutzangaben kommen auf der echten Seite aus Einstellungen → Datenschutz.</p>
        </div>
      </div>
    </div>
  );
}
