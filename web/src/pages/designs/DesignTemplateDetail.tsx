import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, get, post } from '../../api/client';
import { Badge, Button, Card, Chip, ErrorBox, FieldWrap, joinMeta, LinkButton, Notice, PageHeader, SkeletonRows, Table, Td, Textarea, Th } from '../../components/ui/core';
import { usePageMeta } from '../../components/layout/AppShell';
import { Icon } from '../../components/ui/Icon';
import { DeleteDialog, Dialog, Menu, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDateTime, fmtRelative } from '../../lib/format';
import { previewUrl, TemplateMetaDialog, type TemplateListItem } from './DesignTemplates';
import { ImageFillDialog, type Layout } from './ImageFill';

interface TplFile {
  id: string;
  name: string;
  format: string;
  format_label: string;
  size_bytes: number;
  download_count: number;
  created_at: string;
}

interface Version {
  id: string;
  number: number;
  note: string;
  current: boolean;
  created_at: string;
  created_by_name: string | null;
  files: TplFile[];
}

export interface TemplateDetail extends TemplateListItem {
  created_by_name: string | null;
  updated_by_name: string | null;
  preview_source: 'none' | 'auto' | 'upload';
  layout: Layout | null;
  versions: Version[];
}

const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.svg,.pdf,.ai,.eps,.ps,.psd,.psb,.indd,.indt,.idml,.afdesign,.afphoto,.afpub,.xcf,.zip,.docx,.pptx,.xlsx,.odt,.odp,.ods,.odg,.sketch,.xd,.ttf,.otf,.woff,.woff2,.txt,.md';

function NewVersionDialog({ id, next, onClose }: { id: string; next: number; onClose: () => void }) {
  const toastError = useErrorToast();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Version ${next} anlegen`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/design-templates/${id}/versions`, { note: note.trim() });
                qc.invalidateQueries({ queryKey: ['design-template', id] });
                qc.invalidateQueries({ queryKey: ['design-templates'] });
                onClose();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            Version anlegen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm">Die neue Version ist zunächst leer – danach die aktuellen Dateien hochladen. Alle bisherigen Versionen bleiben unverändert abrufbar.</p>
        <FieldWrap label="Was ist neu?" htmlFor="v-note">
          <Textarea id="v-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="z. B. Neues Logo ab 2026" />
        </FieldWrap>
      </div>
    </Dialog>
  );
}

/** Mehrere Dateien nacheinander in die aktuelle Version hochladen. */
function UploadFiles({ id, onDone }: { id: string; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const toastError = useErrorToast();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          let ok = 0;
          for (const f of files) {
            setBusy(f.name);
            try {
              const fd = new FormData();
              fd.append('file', f);
              await api('POST', `/design-templates/${id}/files`, fd);
              ok++;
            } catch (err) {
              toastError(err);
            }
          }
          setBusy(null);
          if (ok) toast({ tone: 'success', title: ok === 1 ? 'Datei hochgeladen' : `${ok} Dateien hochgeladen` });
          onDone();
        }}
      />
      <Button icon="Upload" loading={!!busy} onClick={() => ref.current?.click()}>
        {busy ? `Lädt ${busy} …` : 'Dateien hochladen'}
      </Button>
    </>
  );
}

export default function DesignTemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const previewRef = useRef<HTMLInputElement>(null);
  const [edit, setEdit] = useState(false);
  const [newVersion, setNewVersion] = useState(false);
  const [remove, setRemove] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [fill, setFill] = useState(false);
  const q = useQuery({ queryKey: ['design-template', id], queryFn: () => get<TemplateDetail>(`/design-templates/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['design-template', id] });
    qc.invalidateQueries({ queryKey: ['design-templates'] });
  };
  const manage = can('templates.manage');
  usePageMeta({ title: q.data?.title });
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error || !q.data) return <ErrorBox title="Designvorlage konnte nicht geladen werden">{(q.error as Error)?.message}</ErrorBox>;
  const t = q.data;
  const current = t.versions.find((v) => v.current);
  const older = t.versions.filter((v) => !v.current);
  const fileTable = (v: Version) =>
    v.files.length === 0 ? (
      <p className="m-0 text-sm text-fg-muted">{v.current ? 'Noch keine Dateien in dieser Version.' : 'Keine Dateien.'}</p>
    ) : (
      <Table>
        <thead>
          <tr>
            <Th>Datei</Th>
            <Th>Format</Th>
            <Th align="right">Größe</Th>
            <Th align="right">Downloads</Th>
            <Th>
              <span className="sr-only">Aktionen</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {v.files.map((f) => (
            <tr key={f.id}>
              <Td>
                <span className="break-all">{f.name}</span>
              </Td>
              <Td>
                <Chip mono>{f.format_label}</Chip>
              </Td>
              <Td align="right" mono>
                {fmtBytes(f.size_bytes)}
              </Td>
              <Td align="right" mono>
                {f.download_count}
              </Td>
              <Td align="right">
                <div className="flex justify-end gap-1">
                  <a className="inline-flex items-center gap-1 text-sm" href={`/api/v1/design-templates/files/${f.id}`} download onClick={() => setTimeout(refresh, 800)} aria-label={`${f.name} herunterladen`}>
                    <Icon name="Download" size={14} /> Laden
                  </a>
                  {manage && v.current && (
                    <Button
                      size="sm"
                      iconOnly
                      icon="Trash2"
                      aria-label={`${f.name} entfernen`}
                      onClick={async () => {
                        if (!(await confirm({ title: `„${f.name}“ entfernen?`, text: 'Die Datei wird aus der aktuellen Version entfernt. Ältere Versionen bleiben unverändert.', confirmLabel: 'Entfernen' }))) return;
                        try {
                          await del(`/design-templates/files/${f.id}`);
                          refresh();
                        } catch (e) {
                          toastError(e);
                        }
                      }}
                    />
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/designvorlagen" className="text-sm inline-flex items-center gap-1">
          <Icon name="ArrowLeft" size={14} /> Designvorlagen
        </Link>
      </div>
      <PageHeader
        title={t.title}
        subtitle={
          <span className="flex flex-wrap gap-1.5 items-center">
            {t.kind === 'image' && <Badge>Befüllbare Bildvorlage</Badge>}
            {t.category && <Chip>{t.category.name}</Chip>}
            {t.tags.map((x) => (
              <Chip key={x}>#{x}</Chip>
            ))}
          </span>
        }
        actions={
          (manage || (t.kind === 'image' && can('templates.use'))) && (
            <>
              {t.kind === 'image' && can('templates.use') && (
                <Button variant="primary" icon="ImageUp" onClick={() => setFill(true)}>
                  Bild erzeugen
                </Button>
              )}
              {t.kind === 'image' && manage && (
                <LinkButton to={`/designvorlagen/${t.id}/editor`} icon="LayoutTemplate">
                  Layout bearbeiten
                </LinkButton>
              )}
              {manage && (
              <Button icon="Pencil" onClick={() => setEdit(true)}>
                Bearbeiten
              </Button>
              )}
              {manage && (
              <Menu
                items={[
                  { label: 'Neue Version anlegen', icon: 'History', onClick: () => setNewVersion(true) },
                  { label: 'Eigenes Vorschaubild hochladen', icon: 'ImageUp', onClick: () => previewRef.current?.click() },
                  ...(t.preview_source === 'upload'
                    ? [
                        {
                          label: 'Vorschaubild automatisch erzeugen',
                          icon: 'RotateCcw',
                          onClick: async () => {
                            try {
                              await del(`/design-templates/${t.id}/preview`);
                              refresh();
                            } catch (e) {
                              toastError(e);
                            }
                          },
                        },
                      ]
                    : []),
                  { label: 'Designvorlage löschen', icon: 'Trash2', danger: true, onClick: () => setRemove(true) },
                ]}
              />
              )}
            </>
          )
        }
      />
      <input
        ref={previewRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            const fd = new FormData();
            fd.append('file', f);
            await api('POST', `/design-templates/${t.id}/preview`, fd);
            refresh();
          } catch (err) {
            toastError(err);
          }
        }}
      />
      {t.usage_note && (
        <Notice tone="warning" icon="Info" title="Nutzungshinweis">
          <span className="whitespace-pre-wrap">{t.usage_note}</span>
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card bodyClassName="!p-0">
          <div className="aspect-[4/3] bg-raised rounded-card overflow-hidden flex items-center justify-center">
            {t.has_preview ? <img src={previewUrl(t)} alt={`Vorschau: ${t.title}`} className="w-full h-full object-contain" /> : <Icon name="Palette" size={40} className="text-fg-muted" />}
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          {t.description && <p className="m-0 whitespace-pre-wrap">{t.description}</p>}
          {t.kind === 'image' && t.layout && (
            <div className="text-sm">
              <div className="font-medium mb-1">
                Befüllbare Bildvorlage · {t.layout.width} × {t.layout.height} px
              </div>
              <ul className="m-0 pl-5">
                {t.layout.elements
                  .filter((e) => e.type === 'text' || e.type === 'image')
                  .map((e) => (
                    <li key={e.id}>
                      {e.label} <span className="text-fg-muted">({e.type === 'text' ? 'Text' : 'Bild'}{e.type === 'image' && e.required ? ', Pflicht' : ''}, Kennung {e.id})</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <div className="text-sm text-fg-muted">
            {t.download_count} {t.download_count === 1 ? 'Download' : 'Downloads'} insgesamt · angelegt von {t.created_by_name ?? 'unbekannt'} · zuletzt geändert {fmtRelative(t.updated_at)}
            {t.updated_by_name ? ` von ${t.updated_by_name}` : ''}
          </div>
        </div>
      </div>
      {current && (t.kind === 'files' || current.files.length > 0 || manage) && (
        <Card
          title={`Aktuelle Version ${current.number}`}
          subtitle={joinMeta([fmtDateTime(current.created_at), current.created_by_name, current.note])}
          action={manage && <UploadFiles id={t.id} onDone={refresh} />}
        >
          {fileTable(current)}
        </Card>
      )}
      {older.length > 0 && (
        <Card
          title="Ältere Versionen"
          subtitle="Bleiben unverändert abrufbar, z. B. für Nachdrucke."
          action={
            <Button size="sm" icon={showOld ? 'ChevronDown' : 'ChevronRight'} aria-expanded={showOld} onClick={() => setShowOld(!showOld)}>
              {showOld ? 'Ausblenden' : `${older.length} anzeigen`}
            </Button>
          }
        >
          {showOld && (
            <div className="flex flex-col gap-5">
              {older.map((v) => (
                <section key={v.id} className="flex flex-col gap-2">
                  <h3 className="m-0 text-base font-semibold">
                    Version {v.number}{' '}
                    <span className="text-sm font-normal text-fg-muted">
                      · {fmtDateTime(v.created_at)}
                      {v.created_by_name ? ` · ${v.created_by_name}` : ''}
                      {v.note ? ` · ${v.note}` : ''}
                    </span>
                  </h3>
                  {fileTable(v)}
                </section>
              ))}
            </div>
          )}
        </Card>
      )}
      {fill && <ImageFillDialog templateId={t.id} onClose={() => setFill(false)} onDone={refresh} />}
      {edit && <TemplateMetaDialog tpl={t} onClose={() => setEdit(false)} onSaved={refresh} />}
      {newVersion && <NewVersionDialog id={t.id} next={t.current_version + 1} onClose={() => setNewVersion(false)} />}
      <DeleteDialog
        open={remove}
        onClose={() => setRemove(false)}
        objectType="Designvorlage"
        name={t.title}
        extra="Alle Versionen und Dateien dieser Designvorlage werden endgültig gelöscht."
        onConfirm={async () => {
          await del(`/design-templates/${t.id}`);
          qc.invalidateQueries({ queryKey: ['design-templates'] });
          nav('/designvorlagen');
        }}
      />
    </div>
  );
}
