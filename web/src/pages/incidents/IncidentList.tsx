import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get, post, put, del } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Badge, Button, Card, Chip, cx, EmptyState, ErrorBox, FieldWrap, FilePickButton, Input, Notice, PageHeader, SegmentedControl, Select, SkeletonRows, StatusBadge, Switch, Table, Td, Textarea, Th } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { HelpTip } from '../../components/ui/HelpTip';
import { Dialog, Menu, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { KeywordMeaning } from '../../components/KeywordMeaning';
import { useAuth } from '../../lib/auth';
import { useLinkedItem } from '../../lib/linked-item';
import { fmtDate, fmtDateTime, fmtTime, fromLocalInput, toLocalInput, plural } from '../../lib/format';
import { MediaPicker } from '../posts/PostEditor';
import { PRIVACY_CHECKS, PrivacyCheckList } from '../posts/DecisionDialog';
import { SENSITIVE_LABELS } from '../media/PrivacyDialog';

/** Einsatzliste der Website (#213): Einträge vorschlagen, bearbeiten, freigeben, veröffentlichen und zurückziehen. */

interface Entry {
  id: string;
  site_id: string | null;
  site_name: string | null;
  revision: number;
  content_hash: string;
  alarm_at: string;
  number: number | null;
  keyword: string;
  keyword_label: string;
  category: string;
  title: string;
  location: string;
  report: string;
  vehicles: string;
  units: string;
  link_url: string | null;
  featured: boolean;
  false_alarm: boolean;
  media_ids: string[];
  source: 'manual' | 'alarm' | 'workflow' | 'import';
  created_by_name: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  rejected_note: string | null;
  state: 'draft' | 'in_review' | 'approved' | 'publishing' | 'live' | 'failed' | 'withdrawing' | 'withdrawn';
  /** Datenschutz-Prüfung (#241): markierte Bilder bzw. offene Gesichtsvorschläge */
  privacy: { flagged: number; faces: number; flags: string[]; approve_check: boolean; publish_check: boolean };
  job: { status: string; action: string; error: string | null; remote_url: string | null; result_at: string | null } | null;
}
interface ListResponse {
  year: number | 'alle';
  years: { year: number; n: number }[];
  entries: Entry[];
}
interface Config {
  locations: string[];
  default_site_id: string | null;
  min_bridge: string;
  sites: { id: string; name: string; status: string; plugin_version: string | null; supports_list: boolean }[];
}
interface Suggestion {
  id: string;
  source: string;
  received_at: string;
  alarm_at: string;
  keyword: string;
  keyword_label: string;
  title: string;
  location: string;
  location_removed: boolean;
  units: string;
}

const LABELS: Record<string, string> = { live: 'Auf der Website', publishing: 'Wird übertragen', withdrawing: 'Wird zurückgezogen', withdrawn: 'Zurückgezogen' };
const SOURCE: Record<string, string> = { manual: 'von Hand', alarm: 'aus Einsatzmeldung', workflow: 'aus Workflow', import: 'importiert' };
const FILTERS = [
  { value: 'all', label: 'Alle' },
  { value: 'open', label: 'In Arbeit' },
  { value: 'in_review', label: 'Zur Freigabe' },
  { value: 'approved', label: 'Freigegeben' },
  { value: 'live', label: 'Auf der Website' },
  { value: 'problem', label: 'Fehler' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];
const matches = (e: Entry, f: Filter) =>
  f === 'all' || (f === 'open' && ['draft', 'withdrawn'].includes(e.state)) || (f === 'problem' && e.state === 'failed') || e.state === f || (f === 'live' && ['live', 'publishing'].includes(e.state));

/* ------------------------------------------------------------------ Eintrag bearbeiten */

function EntryDialog({ entry, cfg, onClose }: { entry: Entry | null; cfg: Config; onClose: (saved: boolean) => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const { can } = useAuth();
  const detail = useQuery({ queryKey: ['incident', entry?.id], queryFn: () => get<Entry & { media: MediaItem[] }>(`/incidents/${entry!.id}`), enabled: !!entry });
  const [v, setV] = useState({
    siteId: entry?.site_id ?? cfg.default_site_id ?? '',
    alarmAt: toLocalInput(entry?.alarm_at ?? new Date().toISOString()),
    number: entry?.number ? String(entry.number) : '',
    keyword: entry?.keyword ?? '',
    keywordLabel: entry?.keyword_label ?? '',
    category: entry?.category ?? '',
    title: entry?.title ?? '',
    location: entry?.location ?? '',
    report: entry?.report ?? '',
    vehicles: entry?.vehicles ?? '',
    units: entry?.units ?? '',
    linkUrl: entry?.link_url ?? '',
    featured: entry?.featured ?? false,
    falseAlarm: entry?.false_alarm ?? false,
    mediaIds: entry?.media_ids ?? ([] as string[]),
  });
  const [picker, setPicker] = useState(false);
  const [added, setAdded] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const media = [...(detail.data?.media ?? []), ...added];
  const save = async () => {
    setBusy(true);
    const body = { ...v, siteId: v.siteId || null, alarmAt: fromLocalInput(v.alarmAt), number: v.number ? Number(v.number) : null, linkUrl: v.linkUrl.trim() || null };
    try {
      if (entry) {
        const r = await put<any>(`/incidents/${entry.id}`, body);
        if (r.changed && entry.approved_by_name) toast({ tone: 'warning', title: 'Neue Fassung gespeichert', text: 'Die bisherige Freigabe gilt nicht mehr.' });
      } else await post('/incidents', body);
      onClose(true);
    } catch (e) {
      toastError(e, 'Eintrag nicht gespeichert');
    } finally {
      setBusy(false);
    }
  };
  const sites = cfg.sites.filter((s) => s.status === 'active' || s.id === v.siteId);
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      width={720}
      title={entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={v.title.trim().length < 2 || !v.alarmAt} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Notice icon="ShieldCheck">Öffentlich sichtbar: keine Adressen, keine Namen, keine Kennzeichen. Der Ort nur als Ortsteil bzw. Gemeinde.</Notice>
        <div className="grid sm:grid-cols-3 gap-4">
          <FieldWrap label="Alarmzeit" required htmlFor="i-at" className="sm:col-span-2">
            <Input id="i-at" type="datetime-local" value={v.alarmAt} onChange={(e) => set({ alarmAt: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Lfd. Nr." htmlFor="i-nr" help="Leer = nach Alarmzeit gezählt">
            <Input id="i-nr" type="number" min={1} max={99999} value={v.number} onChange={(e) => set({ number: e.target.value })} />
          </FieldWrap>
          <FieldWrap label="Stichwort" htmlFor="i-kw" help={<KeywordMeaning code={v.keyword} />}>
            <Input id="i-kw" value={v.keyword} onChange={(e) => set({ keyword: e.target.value })} maxLength={60} placeholder="z. B. F 2" />
          </FieldWrap>
          <FieldWrap label="Bedeutung" htmlFor="i-kwl" help="Leer = aus dem Stichwortverzeichnis">
            <Input id="i-kwl" value={v.keywordLabel} onChange={(e) => set({ keywordLabel: e.target.value })} maxLength={200} />
          </FieldWrap>
          <FieldWrap label="Kategorie" htmlFor="i-cat" help="Leer = aus dem Stichwortverzeichnis (z. B. Brand)">
            <Input id="i-cat" value={v.category} onChange={(e) => set({ category: e.target.value })} maxLength={60} />
          </FieldWrap>
        </div>
        <FieldWrap label="Einsatzmeldung" required htmlFor="i-title">
          <Input id="i-title" value={v.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} placeholder="z. B. Kaminbrand" />
        </FieldWrap>
        <div className="grid sm:grid-cols-2 gap-4">
          <FieldWrap label="Ort (Ortsteil)" htmlFor="i-loc" help={cfg.locations.length ? 'Nur erlaubte Ortsangaben (Einstellungen der Einsatzliste).' : 'Ohne Straße und Hausnummer.'}>
            {cfg.locations.length ? (
              <Select id="i-loc" value={v.location} onChange={(e) => set({ location: e.target.value })}>
                <option value="">– ohne Ortsangabe –</option>
                {cfg.locations.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id="i-loc" value={v.location} onChange={(e) => set({ location: e.target.value })} maxLength={80} />
            )}
          </FieldWrap>
          <FieldWrap label="Website" htmlFor="i-site">
            <Select id="i-site" value={v.siteId} onChange={(e) => set({ siteId: e.target.value })}>
              <option value="">– später wählen –</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {!s.supports_list ? ` (Bridge ${cfg.min_bridge} nötig)` : ''}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap label="Fahrzeuge (optional)" htmlFor="i-veh">
            <Input id="i-veh" value={v.vehicles} onChange={(e) => set({ vehicles: e.target.value })} maxLength={500} placeholder="z. B. HLF, DLK" />
          </FieldWrap>
          <FieldWrap label="Weitere Kräfte (optional)" htmlFor="i-units">
            <Input id="i-units" value={v.units} onChange={(e) => set({ units: e.target.value })} maxLength={500} placeholder="z. B. Rettungsdienst, Polizei" />
          </FieldWrap>
        </div>
        <FieldWrap label="Kurzbericht (optional)" htmlFor="i-report">
          <Textarea id="i-report" rows={4} value={v.report} onChange={(e) => set({ report: e.target.value })} maxLength={5000} />
        </FieldWrap>
        <FieldWrap label="Weiterführender Bericht (optional)" htmlFor="i-link" help="Adresse eines ausführlichen Beitrags, z. B. auf der eigenen Website.">
          <Input id="i-link" type="url" value={v.linkUrl} onChange={(e) => set({ linkUrl: e.target.value })} placeholder="https://" />
        </FieldWrap>
        <div className="flex flex-wrap gap-6">
          <Switch checked={v.featured} onChange={(x) => set({ featured: x })} label="Besonderer Einsatz" description="Hervorgehoben; auf der Website auch einzeln auflistbar." />
          <Switch checked={v.falseAlarm} onChange={(x) => set({ falseAlarm: x })} label="Fehlalarm" />
        </div>
        <FieldWrap
          label="Bilder (optional)"
          help="Öffentliche Fassung ohne Standortdaten; das erste Bild ist das Vorschaubild."
          labelAction={
            can('media.view') && (
              <Button size="sm" icon="Images" onClick={() => setPicker(true)} disabled={v.mediaIds.length >= 10}>
                Bilder wählen
              </Button>
            )
          }
        >
          {v.mediaIds.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">Keine Bilder.</p>
          ) : (
            <ul className="m-0 p-0 list-none grid gap-2 grid-cols-3 sm:grid-cols-5">
              {v.mediaIds.map((mid, i) => {
                const m = media.find((x) => x.id === mid);
                return (
                  <li key={mid} className="flex flex-col gap-1">
                    {m?.has_preview ? <img src={`/api/v1/media/${mid}/preview`} alt={m.original_name} className="w-full aspect-[4/3] object-cover rounded-control" /> : <div className="aspect-[4/3] bg-raised rounded-control flex items-center justify-center"><Icon name="Image" /></div>}
                    <div className="flex gap-1">
                      <Button size="sm" iconOnly icon="ArrowUp" aria-label="Nach vorne" disabled={i === 0} onClick={() => set({ mediaIds: v.mediaIds.map((x, k) => (k === i - 1 ? mid : k === i ? v.mediaIds[i - 1] : x)) })} />
                      <Button size="sm" iconOnly icon="Trash2" aria-label="Bild entfernen" onClick={() => set({ mediaIds: v.mediaIds.filter((x) => x !== mid) })} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </FieldWrap>
      </div>
      {picker && (
        <MediaPicker
          collections={[]}
          chosen={v.mediaIds}
          onClose={() => setPicker(false)}
          onAdd={(ms) => {
            const imgs = ms.filter((m) => m.kind === 'image');
            setAdded((a) => [...a, ...imgs]);
            set({ mediaIds: [...v.mediaIds, ...imgs.map((m) => m.id)].slice(0, 10) });
          }}
        />
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Import */

function ImportDialog({ cfg, onClose }: { cfg: Config; onClose: (done: boolean) => void }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [opts, setOpts] = useState({ siteId: cfg.default_site_id ?? '', includeReports: false, submit: false });
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<any>('/incidents/import', { csv, dryRun, includeReports: opts.includeReports, submit: opts.submit, siteId: opts.siteId || null });
      if (dryRun) setRes(r);
      else {
        toast({ tone: 'success', title: `${plural(r.created, 'Eintrag', 'Einträge')} importiert`, text: r.duplicates ? `${r.duplicates} schon vorhanden – übersprungen.` : undefined });
        onClose(true);
      }
    } catch (e) {
      toastError(e, 'Import fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      width={860}
      title="Einsätze importieren (CSV)"
      footer={
        <>
          <Button onClick={() => onClose(false)}>Abbrechen</Button>
          <Button disabled={!csv} loading={busy && !res} onClick={() => run(true)}>
            Prüfen
          </Button>
          <Button variant="primary" disabled={!res || !res.total || res.total === res.duplicates} loading={busy && !!res} onClick={() => run(false)}>
            {res ? `${res.total - res.duplicates} importieren` : 'Importieren'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm">
          CSV mit Spaltennamen in der ersten Zeile, z. B. der Export der WordPress-Erweiterung „Einsatzverwaltung“ (Werkzeuge → Einsatzberichte exportieren, Format CSV). Erkannt werden u. a. <Chip>Lfd.</Chip> <Chip>Alarmzeit</Chip>/<Chip>Datum</Chip> <Chip>Einsatzart</Chip>/<Chip>Stichwort</Chip> <Chip>Berichtstitel</Chip>/<Chip>Einsatzmeldung</Chip> <Chip>Einsatzort</Chip> <Chip>Fahrzeuge</Chip> <Chip>Externe Einsatzmittel</Chip> <Chip>Besonderer Einsatz</Chip> <Chip>Fehlalarm</Chip>. Einsatzleiter und Mannschaftsstärke werden nie übernommen.
        </p>
        <FieldWrap label="Datei" htmlFor="imp-file" help="CSV, höchstens 5 MB, UTF-8.">
          <FilePickButton
            id="imp-file"
            name="Datei"
            accept=".csv,text/csv,text/plain"
            label="CSV-Datei wählen …"
            fileName={name ? `${name} · ${Math.round(csv.length / 1024)} KB` : null}
            onPick={async ([f]) => {
              setRes(null);
              if (f.size > 5 * 1024 * 1024) return toastError(new Error('Die Datei ist größer als 5 MB.'));
              setName(f.name);
              setCsv(await f.text());
            }}
          />
        </FieldWrap>
        <div className="grid sm:grid-cols-2 gap-4">
          <FieldWrap label="Website" htmlFor="imp-site">
            <Select id="imp-site" value={opts.siteId} onChange={(e) => setOpts({ ...opts, siteId: e.target.value })}>
              <option value="">– später wählen –</option>
              {cfg.sites.filter((s) => s.status === 'active').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <div className="flex flex-col gap-3">
            <Switch checked={opts.includeReports} onChange={(x) => (setOpts({ ...opts, includeReports: x }), setRes(null))} label="Berichtstexte übernehmen" description="Nur, wenn sie keine Namen oder Adressen enthalten." />
            <Switch checked={opts.submit} onChange={(x) => setOpts({ ...opts, submit: x })} label="Gleich zur Freigabe einreichen" />
          </div>
        </div>
        {res && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge>{res.total} Zeilen gelesen</Badge>
              {res.duplicates > 0 && <Badge tone="neutral">{res.duplicates} schon vorhanden</Badge>}
              {res.location_removed > 0 && <Badge tone="warning">Ort bei {res.location_removed} entfernt (Adresse bzw. nicht erlaubt)</Badge>}
              {res.errors.length > 0 && <Badge tone="error">{res.errors.length} Hinweise</Badge>}
            </div>
            {res.errors.length > 0 && (
              <Notice tone="warning" title="Hinweise">
                <ul className="m-0 pl-4">
                  {res.errors.slice(0, 10).map((x: string) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {res.preview.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>Nr.</Th>
                    <Th>Alarmzeit</Th>
                    <Th>Stichwort</Th>
                    <Th>Einsatzmeldung</Th>
                    <Th>Ort</Th>
                    <Th>Fahrzeuge</Th>
                  </tr>
                </thead>
                <tbody>
                  {res.preview.slice(0, 15).map((r: any) => (
                    <tr key={r.line} className={r.duplicate ? 'opacity-60' : ''}>
                      <Td mono>{r.number ?? '–'}</Td>
                      <Td>{fmtDateTime(r.alarm_at)}</Td>
                      <Td>{r.keyword}</Td>
                      <Td>
                        {r.title}
                        {r.duplicate && <span className="text-meta text-fg-muted"> (schon vorhanden)</span>}
                      </Td>
                      <Td>{r.location_removed ? <span className="text-warn">entfernt</span> : r.location || '–'}</Td>
                      <Td>{r.vehicles}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Einstellungen */

function ConfigDialog({ cfg, onClose }: { cfg: Config; onClose: (saved: boolean) => void }) {
  const { can } = useAuth();
  const toastError = useErrorToast();
  const edit = can('incident.settings');
  const [locs, setLocs] = useState(cfg.locations.join('\n'));
  const [site, setSite] = useState(cfg.default_site_id ?? '');
  const save = async () => {
    try {
      await put('/incidents/config', { locations: locs.split('\n').map((x) => x.trim()).filter(Boolean), defaultSiteId: site || null });
      onClose(true);
    } catch (e) {
      toastError(e, 'Nicht gespeichert');
    }
  };
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      title="Einstellungen der Einsatzliste"
      width={600}
      footer={
        <>
          <Button onClick={() => onClose(false)}>{edit ? 'Abbrechen' : 'Schließen'}</Button>
          {edit && (
            <Button variant="primary" onClick={save}>
              Speichern
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldWrap label="Erlaubte Ortsangaben" htmlFor="cfg-locs" help="Eine je Zeile, z. B. die Ortsteile des Einsatzgebiets. Mit Liste wählt man den Ort nur noch daraus; Einsatzmeldungen und Importe werden darauf abgebildet (sonst entfällt der Ort). Ohne Liste werden Straßen und Hausnummern zurückgewiesen.">
          <Textarea id="cfg-locs" rows={8} value={locs} onChange={(e) => setLocs(e.target.value)} disabled={!edit} />
        </FieldWrap>
        <FieldWrap label="Standard-Website" htmlFor="cfg-site" help="Für neue Einträge, Einsatzmeldungen und Workflows ohne eigene Wahl.">
          <Select id="cfg-site" value={site} onChange={(e) => setSite(e.target.value)} disabled={!edit}>
            <option value="">– keine –</option>
            {cfg.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FieldWrap>
        <Notice icon="LayoutTemplate" title="Darstellung auf der Website">
          Spalten, Sortierung, Filter, Anzahl je Seite, Farben und Symbole je Kategorie, Tabelle oder Karten, Jahresstatistik und Detailseiten stellt man in WordPress ein: Einstellungen → BlaulichtCMS Einsatzliste (mit Vorschau). Shortcodes <Chip mono>[blaulichtcms_einsatzliste]</Chip> und <Chip mono>[blaulichtcms_einsatzstatistik]</Chip>.
        </Notice>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Datenschutz-Prüfung */

/**
 * Freigeben bzw. Veröffentlichen eines Eintrags mit markierten Bildern oder offenen Gesichtsvorschlägen (#241): wie bei
 * Beiträgen nur mit ausdrücklich bestätigten Prüfpunkten. Der Server prüft dasselbe.
 */
function PrivacyConfirmDialog({ entry, action, onClose, onDone }: { entry: Entry; action: 'approve' | 'publish'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const [checks, setChecks] = useState<boolean[]>(PRIVACY_CHECKS.map(() => false));
  const [busy, setBusy] = useState(false);
  const p = entry.privacy;
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/incidents/${entry.id}/${action}`, { contentHash: entry.content_hash, privacyChecked: true });
      toast({ tone: 'success', title: action === 'approve' ? 'Freigegeben' : 'Wird übertragen' });
      onDone();
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
      title={action === 'approve' ? 'Eintrag freigeben' : 'Auf der Website veröffentlichen'}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={checks.some((c) => !c)} onClick={submit}>
            {action === 'approve' ? 'Freigeben' : 'Veröffentlichen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          „{entry.title}“ (Fassung {entry.revision}) enthält Bilder, die vor der Veröffentlichung geprüft werden müssen.
          {action === 'publish' && ' Bei der Freigabe war diese Prüfung noch nicht bestätigt (z. B. weil die Markierung erst danach gesetzt wurde).'}
        </p>
        <fieldset className="m-0 p-3 border border-warn rounded-node flex flex-col gap-2">
          <legend className="px-1 font-medium">Datenschutz-Prüfung</legend>
          {p.flagged > 0 && (
            <p className="m-0">
              {p.flagged === 1 ? 'Ein Bild ist' : `${p.flagged} Bilder sind`} markiert: {p.flags.map((f) => SENSITIVE_LABELS[f as keyof typeof SENSITIVE_LABELS] ?? f).join(', ')}.
            </p>
          )}
          {p.faces > 0 && (
            <Notice tone="warning" icon="ScanFace" title="Gesichtsvorschläge offen">
              {p.faces === 1 ? 'Ein Bild hat' : `${p.faces} Bilder haben`} noch ungeprüfte Vorschläge der Gesichtssuche. Gefundene Gesichter sind nicht automatisch unkenntlich – vorher in den Medien unter „Datenschutz und Unkenntlichmachen“ übernehmen oder verwerfen, sonst bewusst bestätigen.
            </Notice>
          )}
          <PrivacyCheckList checks={checks} onChange={setChecks} />
        </fieldset>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Seite */

export default function IncidentList() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  // Verweis aus Aktivitäten oder Benachrichtigung (/einsatzliste?eintrag=<id>, #258): alle Jahre laden, Eintrag hervorheben
  const [year, setYear] = useState<string>(() => (new URLSearchParams(window.location.search).has('eintrag') ? 'alle' : ''));
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Entry | null | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [config, setConfig] = useState(false);
  const [reject, setReject] = useState<Entry | null>(null);
  const [privacy, setPrivacy] = useState<{ entry: Entry; action: 'approve' | 'publish' } | null>(null);
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['incidents', year], queryFn: () => get<ListResponse>(`/incidents${year ? `?year=${year}` : ''}`), refetchInterval: 30_000 });
  const cfg = useQuery({ queryKey: ['incidents', 'config'], queryFn: () => get<Config>('/incidents/config') });
  const sugg = useQuery({ queryKey: ['incidents', 'suggestions'], queryFn: () => get<Suggestion[]>('/incidents/suggestions'), enabled: can('incident.edit') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['incidents'] });
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ tone: 'success', title: ok });
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  const needle = search.trim().toLowerCase();
  const list = useMemo(
    () => (q.data?.entries ?? []).filter((e) => matches(e, filter) && (!needle || [e.title, e.keyword, e.keyword_label, e.location, e.category].some((x) => x.toLowerCase().includes(needle)))),
    [q.data, filter, needle],
  );
  const linked = useLinkedItem('eintrag', !!q.data, 'incident');
  const linkedMissing = !!linked.id && !!q.data && q.data.year === 'alle' && !q.data.entries.some((e) => e.id === linked.id);
  const chosen = list.filter((e) => sel.has(e.id));
  const toggle = (id: string) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const bulk = async (what: 'submit' | 'approve' | 'publish') => {
    const fitting = chosen.filter((e) => (what === 'submit' ? ['draft', 'withdrawn'].includes(e.state) && !e.submitted_at : what === 'approve' ? e.state === 'in_review' : ['approved', 'failed'].includes(e.state)));
    // Datenschutz-Prüfung (#241) nur einzeln – die Sammelaktion überspringt solche Einträge (prüft auch der Server)
    const needsCheck = (e: Entry) => (what === 'approve' ? e.privacy.approve_check : what === 'publish' ? e.privacy.publish_check : false);
    const items = fitting.filter((e) => !needsCheck(e));
    const held = fitting.length - items.length;
    const heldText = held ? `${held === 1 ? 'Ein Eintrag enthält' : `${held} Einträge enthalten`} markierte Bilder oder offene Gesichtsvorschläge – bitte einzeln über das Aktionsmenü prüfen.` : undefined;
    if (!items.length) return toast({ tone: 'warning', title: held ? 'Datenschutz-Prüfung nötig' : 'Keine passenden Einträge ausgewählt', text: heldText });
    const label = { submit: 'zur Freigabe einreichen', approve: 'freigeben', publish: 'auf der Website veröffentlichen' }[what];
    if (!(await ask({ title: `${plural(items.length, 'Eintrag', 'Einträge')} ${label}?`, text: held ? `Übersprungen: ${heldText}` : undefined, confirmLabel: 'Ja', danger: false }))) return;
    try {
      const r = await post<any>(`/incidents/bulk/${what}`, what === 'submit' ? { ids: items.map((e) => e.id) } : { items: items.map((e) => ({ id: e.id, contentHash: e.content_hash })) });
      const skipped = Array.isArray(r.skipped) ? r.skipped.length : r.skipped;
      toast({ tone: skipped ? 'warning' : 'success', title: `${r.done} erledigt${skipped ? `, ${skipped} übersprungen` : ''}`, text: Array.isArray(r.skipped) && r.skipped[0] ? r.skipped[0].reason : undefined });
      setSel(new Set());
    } catch (e) {
      toastError(e);
    }
    refresh();
  };
  const c = cfg.data;
  const noBridge = c && c.sites.filter((s) => s.status === 'active').length > 0 && !c.sites.some((s) => s.status === 'active' && s.supports_list);
  const years = q.data?.years ?? [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Einsätze für die Website – aus Einsatzmeldungen vorgeschlagen, von Hand ergänzt, freigegeben und veröffentlicht."
        actions={
          <>
            <Button icon="Settings" onClick={() => setConfig(true)} disabled={!c}>
              Einstellungen
            </Button>
            {can('incident.edit') && (
              <>
                <Button icon="FileUp" onClick={() => setImporting(true)} disabled={!c}>
                  Importieren
                </Button>
                <Button variant="primary" icon="Plus" onClick={() => setEdit(null)} disabled={!c}>
                  Neuer Eintrag
                </Button>
              </>
            )}
          </>
        }
      />
      {noBridge && (
        <Notice tone="warning" title={`BlaulichtCMS Bridge ${c!.min_bridge} nötig`}>
          Die gekoppelten Websites verwenden eine ältere Bridge. Veröffentlichte Einträge warten, bis die Bridge aktualisiert ist (Einrichtung → Websites).
        </Notice>
      )}
      {c && !c.locations.length && can('incident.settings') && (
        <Notice icon="ShieldCheck" title="Erlaubte Ortsangaben festlegen">
          Mit einer Liste der Ortsteile bleibt der Ort sicher grob – auch bei Einsatzmeldungen und Importen. <Button size="sm" onClick={() => setConfig(true)}>Jetzt festlegen</Button>
        </Notice>
      )}
      {can('incident.edit') && (sugg.data?.length ?? 0) > 0 && (
        <Card title="Vorschläge aus Einsatzmeldungen" subtitle="Eingegangene Einsätze der letzten 60 Tage, die noch nicht in der Liste stehen.">
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
            {sugg.data!.slice(0, 8).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="tabular text-sm text-fg-muted w-[9.5rem]">{fmtDateTime(s.alarm_at)}</span>
                <span className="flex-1 min-w-[12rem]">
                  <strong>{s.title || s.keyword}</strong>
                  {s.keyword && <span className="text-fg-muted"> · {s.keyword}</span>}
                  {s.location && <span className="text-fg-muted"> · {s.location}</span>}
                  {s.location_removed && <span className="text-meta text-warn"> · Ort entfällt (keine erlaubte Ortsangabe)</span>}
                </span>
                <Button size="sm" icon="Plus" onClick={() => act(() => post(`/incidents/suggestions/${s.id}`), 'In die Einsatzliste übernommen')}>
                  Übernehmen
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="flex flex-wrap gap-3 items-end">
        <FieldWrap label="Jahr" htmlFor="inc-year" className="w-36">
          <Select id="inc-year" value={year || String(q.data?.year ?? '')} onChange={(e) => (setYear(e.target.value), setSel(new Set()))}>
            {years.map((y) => (
              <option key={y.year} value={y.year}>
                {y.year} ({y.n})
              </option>
            ))}
            {!years.some((y) => y.year === new Date().getFullYear()) && <option value={new Date().getFullYear()}>{new Date().getFullYear()} (0)</option>}
            <option value="alle">Alle Jahre</option>
          </Select>
        </FieldWrap>
        <SegmentedControl label="Stand" size="sm" value={filter} onChange={(f) => (setFilter(f), setSel(new Set()))} options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: (q.data?.entries ?? []).filter((e) => matches(e, f.value)).length }))} />
        <FieldWrap label="Suche" htmlFor="inc-q" className="min-w-[12rem] flex-1">
          <Input id="inc-q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Stichwort, Meldung, Ort" />
        </FieldWrap>
      </div>
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-card border border-line bg-raised" role="region" aria-label="Auswahl">
          <span className="text-sm font-medium">{chosen.length} ausgewählt</span>
          {can('incident.edit') && <Button size="sm" icon="Send" onClick={() => bulk('submit')}>Einreichen</Button>}
          {can('approval.incident') && <Button size="sm" icon="Check" onClick={() => bulk('approve')}>Freigeben</Button>}
          {can('incident.publish') && <Button size="sm" variant="primary" icon="Globe" onClick={() => bulk('publish')}>Veröffentlichen</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Auswahl aufheben</Button>
        </div>
      )}
      {linkedMissing && (
        <Notice tone="warning" title="Eintrag nicht gefunden">
          <div className="flex flex-col items-start gap-2">
            Den verlinkten Eintrag gibt es nicht mehr in der Einsatzliste.
            <Button size="sm" onClick={linked.clear}>
              Hinweis schließen
            </Button>
          </div>
        </Notice>
      )}
      {q.isLoading && <SkeletonRows rows={6} />}
      {q.error && <ErrorBox title="Einsatzliste konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && list.length === 0 && <EmptyState icon="ListOrdered" title="Keine Einträge" text={q.data.entries.length ? 'Kein Eintrag passt zum Filter.' : 'Einträge entstehen aus Einsatzmeldungen, per Workflow, von Hand oder per Import.'} />}
      {list.length > 0 && (
        <Card bodyClassName="p-0">
          <Table>
            <thead>
              <tr>
                <Th className="w-8">
                  <input type="checkbox" aria-label="Alle auswählen" checked={chosen.length === list.length} onChange={(e) => setSel(e.target.checked ? new Set(list.map((x) => x.id)) : new Set())} />
                </Th>
                <Th>Nr.</Th>
                <Th>Datum</Th>
                <Th>Stichwort</Th>
                <Th>Einsatzmeldung</Th>
                <Th>Ort</Th>
                <Th>Stand</Th>
                <Th align="right">
                  <span className="sr-only">Aktionen</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} id={`incident-${e.id}`} className={cx(linked.id === e.id ? 'bg-primary-soft' : 'hover:bg-raised')}>
                  <Td>
                    <input type="checkbox" aria-label={`${e.title} auswählen`} checked={sel.has(e.id)} onChange={() => toggle(e.id)} />
                  </Td>
                  <Td mono>{e.number ?? '–'}</Td>
                  <Td className="whitespace-nowrap tabular">
                    {fmtDate(e.alarm_at)} <span className="text-fg-muted">{fmtTime(e.alarm_at)}</span>
                  </Td>
                  <Td>
                    <div>{e.keyword || '–'}</div>
                    {(e.keyword_label || e.category) && <div className="text-meta text-fg-muted">{[e.keyword_label, e.category].filter(Boolean).join(' · ')}</div>}
                  </Td>
                  <Td>
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => setEdit(e)}>
                      {e.title}
                    </button>
                    <div className="text-meta text-fg-muted flex flex-wrap gap-x-2">
                      {e.featured && <span className="inline-flex items-center gap-1"><Icon name="Star" size={12} /> besonders</span>}
                      {e.false_alarm && <span>Fehlalarm</span>}
                      {e.media_ids.length > 0 && <span>{plural(e.media_ids.length, 'Bild', 'Bilder')}</span>}
                      {e.privacy.approve_check && (
                        <span className="inline-flex items-center gap-1 text-warn" title="Markierte Bilder oder offene Gesichtsvorschläge: Freigabe und Veröffentlichung nur mit bestätigter Datenschutz-Prüfung">
                          <Icon name="ShieldAlert" size={12} /> Datenschutz-Prüfung
                        </span>
                      )}
                      <span>{SOURCE[e.source]}</span>
                      {/* Ausgeschrieben: „F1“ läse sich neben dem Stichwort „F 1“ wie ein Einsatzstichwort (#257) */}
                      <span>Fassung {e.revision}</span>
                    </div>
                  </Td>
                  <Td>{e.location || '–'}</Td>
                  <Td>
                    <StatusBadge status={e.state} labels={LABELS} />
                    {e.site_name && <div className="text-meta text-fg-muted">{e.site_name}</div>}
                    {e.rejected_note && e.state === 'draft' && <div className="text-meta text-err" title={e.rejected_note}>Zurückgewiesen</div>}
                    {e.state === 'failed' && e.job?.error && <div className="text-meta text-err">{e.job.error}</div>}
                    {e.state === 'live' && e.job?.remote_url && (
                      <a className="text-meta" href={e.job.remote_url} target="_blank" rel="noreferrer">
                        Ansehen
                      </a>
                    )}
                  </Td>
                  <Td align="right">
                    <Menu
                      size="sm"
                      label={`Aktionen für ${e.title}`}
                      items={[
                        can('incident.edit') && { label: 'Bearbeiten', icon: 'Pencil', onClick: () => setEdit(e) },
                        can('incident.edit') && ['draft', 'withdrawn'].includes(e.state) && !e.submitted_at && { label: 'Zur Freigabe einreichen', icon: 'Send', onClick: () => act(() => post(`/incidents/${e.id}/submit`), 'Eingereicht') },
                        can('approval.incident') && e.state === 'in_review' && { label: e.privacy.approve_check ? 'Freigeben (mit Datenschutz-Prüfung) …' : 'Freigeben', icon: 'Check', onClick: () => (e.privacy.approve_check ? setPrivacy({ entry: e, action: 'approve' }) : act(() => post(`/incidents/${e.id}/approve`, { contentHash: e.content_hash }), 'Freigegeben')) },
                        can('approval.incident') && e.state === 'in_review' && { label: 'Zurückweisen', icon: 'Undo2', onClick: () => (setNote(''), setReject(e)) },
                        can('incident.publish') && ['approved', 'failed'].includes(e.state) && !!e.approved_at && { label: e.privacy.publish_check ? 'Auf Website veröffentlichen (mit Datenschutz-Prüfung) …' : 'Auf Website veröffentlichen', icon: 'Globe', onClick: () => (e.privacy.publish_check ? setPrivacy({ entry: e, action: 'publish' }) : act(() => post(`/incidents/${e.id}/publish`, { contentHash: e.content_hash }), 'Wird übertragen')) },
                        can('incident.publish') &&
                          (['live', 'publishing'].includes(e.state) || (e.job?.action === 'upsert' && ['approved', 'in_review', 'draft'].includes(e.state) && e.job.status === 'done')) && {
                            label: 'Von Website zurückziehen',
                            icon: 'CircleStop',
                            danger: true,
                            onClick: async () => (await ask({ title: 'Von der Website zurückziehen?', text: `„${e.title}“ verschwindet beim nächsten Abruf der Bridge aus der Einsatzliste der Website.`, confirmLabel: 'Zurückziehen' })) && act(() => post(`/incidents/${e.id}/withdraw`), 'Wird zurückgezogen'),
                          },
                        can('incident.edit') &&
                          ['draft', 'in_review', 'approved', 'withdrawn'].includes(e.state) && {
                            label: 'Löschen',
                            icon: 'Trash2',
                            danger: true,
                            onClick: async () => (await ask({ title: 'Eintrag löschen?', text: `„${e.title}“ wird endgültig gelöscht.`, confirmLabel: 'Löschen' })) && act(() => del(`/incidents/${e.id}`), 'Gelöscht'),
                          },
                      ]}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <p className="m-0 text-meta text-fg-muted">
        Auf der Website: Shortcodes <Chip mono>[blaulichtcms_einsatzliste]</Chip> und <Chip mono>[blaulichtcms_einsatzstatistik]</Chip> bzw. die gleichnamigen Blöcke – Einstellungen in WordPress. Workflows: Aktion „Einsatz in Einsatzliste“ unter <Link to="/workflows/aktionen">Workflows → Aktionen</Link>.
      </p>
      {edit !== undefined && c && <EntryDialog entry={edit} cfg={c} onClose={(s) => (setEdit(undefined), s && refresh())} />}
      {importing && c && <ImportDialog cfg={c} onClose={(d) => (setImporting(false), d && refresh())} />}
      {config && c && <ConfigDialog cfg={c} onClose={(s) => (setConfig(false), s && refresh())} />}
      {privacy && <PrivacyConfirmDialog entry={privacy.entry} action={privacy.action} onClose={() => setPrivacy(null)} onDone={refresh} />}
      {reject && (
        <Dialog
          open
          onClose={() => setReject(null)}
          title="Eintrag zurückweisen"
          footer={
            <>
              <Button onClick={() => setReject(null)}>Abbrechen</Button>
              <Button variant="danger" disabled={note.trim().length < 2} onClick={() => act(() => post(`/incidents/${reject.id}/reject`, { note }), 'Zurückgewiesen').then(() => setReject(null))}>
                Zurückweisen
              </Button>
            </>
          }
        >
          <FieldWrap label="Begründung" required htmlFor="rej-note" help="Geht an die Person, die den Eintrag eingereicht hat.">
            <Textarea id="rej-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </FieldWrap>
        </Dialog>
      )}
    </div>
  );
}
