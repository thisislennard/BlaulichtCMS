import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { del, post, put } from '../../api/client';
import { Button, Card, Chip, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SkeletonRows, Switch } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { BannerPreview } from '../banners/Banners';
import { CheckList, Help, NumberField, SelectField, TemplateField, outputSummary, useCatalog, useOutputs, type Catalog, type OutputDef } from './shared';

/** Ausgänge: wiederverwendbare Aktionen mit ihrer Gestaltung (Banner-Stil, Beitragsvorlage, E-Mail, Benachrichtigung, Warnentwurf). */

const DEFAULTS: Record<string, Record<string, any>> = {
  banner: { siteIds: [], title: '', text: '', tone: 'auto', priority: 2, durationHours: 6, endFromField: true, linkUrl: '', linkText: '', submit: true },
  post: { kind: 'news', title: '', body: '', excerpt: '', variants: {}, siteId: null, submit: false },
  mail: { roles: [], responsibilityIds: [], subject: '', body: '' },
  notify: { roles: [], userIds: [], kind: 'info', title: '', body: '', link: '' },
  warning_draft: { data: {}, responsibilityIds: [] },
};

/** Alle Felder aller Eingänge (die Prüfung im Editor sagt, ob ein Feld an der jeweiligen Stelle vorhanden ist). */
function allFields(cat: Catalog) {
  const m = new Map<string, { key: string; label: string }>();
  for (const k of cat.inputKinds) for (const f of k.fields) if (!m.has(f.key)) m.set(f.key, { key: f.key, label: f.label });
  for (const k of cat.outputKinds) for (const f of k.produces) if (!m.has(f.key)) m.set(f.key, { key: f.key, label: f.label });
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

function OutputDialog({ output, kind, cat, onClose }: { output: OutputDef | null; kind: string; cat: Catalog; onClose: (saved: boolean) => void }) {
  const toastError = useErrorToast();
  const def = cat.outputKinds.find((k) => k.kind === kind)!;
  const [name, setName] = useState(output?.name ?? def.label);
  const [c, setC] = useState<Record<string, any>>({ ...DEFAULTS[kind], ...(output?.config ?? {}) });
  const [busy, setBusy] = useState(false);
  const set = (patch: Record<string, any>) => setC((x) => ({ ...x, ...patch }));
  const fields = useMemo(() => allFields(cat), [cat]);
  const T = (k: string, label: string, opts: { rows?: number; max?: number; help?: string; required?: boolean } = {}) => <TemplateField id={`o-${k}`} label={label} value={c[k] ?? ''} onChange={(v) => set({ [k]: v })} fields={fields} {...opts} />;
  const sites = cat.sites.filter((s) => s.status === 'active' || (c.siteIds ?? []).includes(s.id) || c.siteId === s.id);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, config: c };
      if (output) await put(`/automation-outputs/${output.id}`, body);
      else await post('/automation-outputs', { ...body, kind });
      onClose(true);
    } catch (e) {
      toastError(e, 'Ausgang nicht gespeichert');
    } finally {
      setBusy(false);
    }
  };
  const previewTone = c.tone === 'auto' ? 'danger' : c.tone;
  const strip = (s: string) => String(s ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, '[$1]');
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      width={720}
      title={output ? `Ausgang bearbeiten: ${output.name}` : `Neuer Ausgang: ${def.label}`}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-muted">{def.description}</p>
        <FieldWrap label="Name" htmlFor="o-name" required help="So erscheint der Ausgang in der Palette des Editors.">
          <Input id="o-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </FieldWrap>
        <Notice icon="Braces">
          Texte dürfen <code>{'{{feld}}'}</code>-Platzhalter enthalten (z. B. <code>{'{{stichwort}}'}</code>). Beim Lauf werden sie nur als Text eingesetzt; fehlende Felder bleiben leer. Ob ein Feld zur Verfügung steht, prüft der Editor an der jeweiligen Stelle.
        </Notice>

        {kind === 'banner' && (
          <>
            <BannerPreview b={{ tone: previewTone, title: strip(c.title) || 'Titel', text: strip(c.text), link_url: c.linkUrl || null, link_text: strip(c.linkText) || null }} />
            <CheckList legend="Websites (je Website ein Banner)" options={sites.map((s) => ({ value: s.id, label: s.name }))} value={c.siteIds ?? []} onChange={(v) => set({ siteIds: v })} />
            {!sites.length && <Notice tone="warning">Zuerst unter Kanäle → Websites eine Website koppeln.</Notice>}
            {T('title', 'Titel', { max: 300, required: true, help: 'Höchstens 120 Zeichen nach dem Einsetzen.' })}
            {T('text', 'Text', { rows: 3, max: 1000, help: 'Höchstens 500 Zeichen nach dem Einsetzen.' })}
            <div className="grid sm:grid-cols-2 gap-4">
              <SelectField
                id="o-tone"
                label="Stil"
                value={c.tone}
                onChange={(v) => set({ tone: v })}
                options={[{ value: 'auto', label: 'Nach Warnstufe (Feld „stufe“)' }, { value: 'info', label: 'Hinweis' }, { value: 'warning', label: 'Warnung' }, { value: 'danger', label: 'Gefahr' }]}
                labelAction={<Help title="Stil nach Warnstufe" anchor="ausgaenge">Bei amtlichen Warnungen: Stufe 1 = Hinweis, 2 = Warnung, ab 3 = Gefahr. Ohne Feld „stufe“ gilt „Hinweis“. Farben kommen aus dem Banner-Stil der Website.</Help>}
              />
              <SelectField id="o-prio" label="Priorität" value={String(c.priority)} onChange={(v) => set({ priority: Number(v) })} options={[{ value: '3', label: 'hoch' }, { value: '2', label: 'normal' }, { value: '1', label: 'niedrig' }]} />
              <NumberField id="o-dur" label="Dauer" unit="Stunden" min={1} max={168} value={c.durationHours} onChange={(v) => set({ durationHours: v })} help="Ablauf ab Anlage, wenn kein Gültig-bis-Feld vorhanden ist." />
              <div className="pt-6">
                <Switch checked={!!c.endFromField} onChange={(v) => set({ endFromField: v })} label="Ablauf aus „gueltig_bis“" description="Amtliche Warnungen: Banner endet mit der Warnung." />
              </div>
              {T('linkUrl', 'Link (optional)', { max: 500, help: 'Nur https-Adressen, z. B. {{link}}.' })}
              {T('linkText', 'Linktext', { max: 100 })}
            </div>
            <Switch checked={c.submit !== false} onChange={(v) => set({ submit: v })} label="Zur Freigabe einreichen" description="Sonst bleibt das Banner ein Entwurf. Veröffentlicht wird nur nach Freigabe – außer der Ausgang ist im Editor für den Direktversand markiert." />
          </>
        )}

        {kind === 'post' && (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <SelectField id="o-kind" label="Art des Beitrags" value={c.kind} onChange={(v) => set({ kind: v })} options={[{ value: 'news', label: 'Meldung' }, { value: 'incident', label: 'Einsatz' }, { value: 'event', label: 'Termin' }, { value: 'situation', label: 'Lage' }]} />
              <SelectField id="o-site" label="Zielkanal (optional)" value={c.siteId ?? ''} onChange={(v) => set({ siteId: v || null })} placeholder="Kein Zielkanal (intern)" options={sites.map((s) => ({ value: s.id, label: s.name }))} help="Für den Direktversand nötig." />
            </div>
            {T('title', 'Titel', { max: 400, required: true })}
            {T('body', 'Text', { rows: 6, max: 20000 })}
            {T('excerpt', 'Kurzfassung', { rows: 2, max: 1000 })}
            <details>
              <summary className="cursor-pointer text-sm font-medium">Texte je Kanal (optional)</summary>
              <div className="flex flex-col gap-3 pt-3">
                <TemplateField id="o-wp-title" label="WordPress: Titel" value={c.variants?.wordpress?.title ?? ''} onChange={(v) => set({ variants: { ...c.variants, wordpress: { ...c.variants?.wordpress, title: v } } })} fields={fields} max={400} />
                <TemplateField id="o-wp-body" label="WordPress: Text" rows={4} value={c.variants?.wordpress?.body ?? ''} onChange={(v) => set({ variants: { ...c.variants, wordpress: { ...c.variants?.wordpress, body: v } } })} fields={fields} max={20000} />
                <TemplateField id="o-fb-body" label="Facebook: Text" rows={3} value={c.variants?.facebook?.body ?? ''} onChange={(v) => set({ variants: { ...c.variants, facebook: { body: v } } })} fields={fields} max={20000} />
                <TemplateField id="o-ig-body" label="Instagram: Text" rows={3} value={c.variants?.instagram?.body ?? ''} onChange={(v) => set({ variants: { ...c.variants, instagram: { body: v } } })} fields={fields} max={2200} />
                <p className="m-0 text-meta text-fg-muted">Soziale Kanäle selbst wählt die Redaktion im Beitrag – Automationen veröffentlichen nie direkt in sozialen Netzwerken.</p>
              </div>
            </details>
            <Switch checked={!!c.submit} onChange={(v) => set({ submit: v })} label="Zur Freigabe einreichen" description="Nur mit Text. Sonst bleibt der Beitrag ein Entwurf für die Redaktion." />
          </>
        )}

        {kind === 'mail' && (
          <>
            <CheckList legend="An Rollen (Konten in BlaulichtCMS)" options={cat.roles.map((r) => ({ value: r.id, label: r.label }))} value={c.roles ?? []} onChange={(v) => set({ roles: v })} />
            <CheckList legend="An Zuständigkeiten (externe Adressen aus Warnentwurf → Pflege)" options={cat.responsibilities.map((r) => ({ value: r.id, label: `${r.name}${r.area ? ` (${r.area})` : ''}` }))} value={c.responsibilityIds ?? []} onChange={(v) => set({ responsibilityIds: v })} />
            <Notice>
              Nur hinterlegte Konten und Zuständigkeiten – keine freien Adressen. An Konten geht die E-Mail sofort (wie eine Benachrichtigung). An Zuständigkeiten nur nach Freigabe durch eine Person mit Freigaberecht oder mit Direktversand; im Testmodus des Mailversands nur an das Testpostfach.
            </Notice>
            {T('subject', 'Betreff', { max: 300, required: true })}
            {T('body', 'Text', { rows: 8, max: 10000, required: true })}
          </>
        )}

        {kind === 'notify' && (
          <>
            <CheckList legend="An Rollen" options={cat.roles.map((r) => ({ value: r.id, label: r.label }))} value={c.roles ?? []} onChange={(v) => set({ roles: v })} />
            <CheckList legend="An Personen" options={cat.users.map((u) => ({ value: u.id, label: u.name }))} value={c.userIds ?? []} onChange={(v) => set({ userIds: v })} />
            <SelectField id="o-nkind" label="Art" value={c.kind} onChange={(v) => set({ kind: v })} options={[{ value: 'info', label: 'Hinweis' }, { value: 'warning', label: 'Warnung' }]} />
            {T('title', 'Titel', { max: 300, required: true })}
            {T('body', 'Text', { rows: 3, max: 1000 })}
            {T('link', 'Link (optional)', { max: 300, help: 'Seite in BlaulichtCMS, z. B. {{beitrag_link}} oder /banner.' })}
          </>
        )}

        {kind === 'warning_draft' && (
          <>
            <Notice tone="warning" title="Nur vorbereiten">Die Automation legt einen Warnentwurf mit vorausgefüllten Feldern an. Warnstufe, Freigabe und Versand bleiben immer bei den zuständigen Personen.</Notice>
            {cat.warningFields.length === 0 && <Notice tone="warning">Es gibt keine aktive Warnvorlage.</Notice>}
            {cat.warningFields.map((f) => (
              <TemplateField key={f.key} id={`o-wf-${f.key}`} label={`${f.label}${f.required ? ' (Pflicht in der Vorlage)' : ''}`} rows={f.key.includes('text') || f.key.includes('desc') ? 3 : 1} value={c.data?.[f.key] ?? ''} onChange={(v) => set({ data: Object.fromEntries(Object.entries({ ...c.data, [f.key]: v }).filter(([, x]) => String(x).length)) })} fields={fields} max={2000} />
            ))}
            <CheckList legend="Zuständigkeiten vorauswählen" options={cat.responsibilities.map((r) => ({ value: r.id, label: r.name }))} value={c.responsibilityIds ?? []} onChange={(v) => set({ responsibilityIds: v })} />
          </>
        )}
      </div>
    </Dialog>
  );
}

export default function Outputs() {
  const { can } = useAuth();
  const manage = can('automation.manage');
  const cat = useCatalog();
  const q = useOutputs();
  const qc = useQueryClient();
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const [edit, setEdit] = useState<{ output: OutputDef | null; kind: string } | null>(null);
  const [choose, setChoose] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['automation-outputs'] });
  const remove = async (o: OutputDef) => {
    if (!(await ask({ title: 'Ausgang löschen?', text: `„${o.name}“ steht danach im Editor nicht mehr zur Verfügung.`, confirmLabel: 'Löschen' }))) return;
    try {
      await del(`/automation-outputs/${o.id}`);
      toast({ tone: 'success', title: 'Ausgang gelöscht' });
      refresh();
    } catch (e) {
      toastError(e, 'Nicht gelöscht');
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Ausgänge"
        subtitle="Aktionen mit ihrer Gestaltung: Banner-Stil, Beitragsvorlage, E-Mail, App-Benachrichtigung, Warnentwurf."
        actions={manage && <Button variant="primary" icon="Plus" disabled={!cat.data} onClick={() => setChoose(true)}>Neuer Ausgang</Button>}
      />
      <Notice icon="ShieldCheck">Ausgänge legen Entwürfe und Benachrichtigungen an – die Freigabe bleibt bei den Menschen. Direktversand ist nur je Automation mit eigenem Recht möglich.</Notice>
      {(q.isLoading || cat.isLoading) && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Ausgänge konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && <EmptyState icon="Send" title="Noch keine Ausgänge" text="Ein Ausgang legt fest, was eine Automation tut – etwa einen Banner-Entwurf im Stil „Unwetter“ anlegen." />}
      <div className="grid gap-4 lg:grid-cols-2">
        {(q.data ?? []).map((o) => {
          const kind = cat.data?.outputKinds.find((k) => k.kind === o.kind);
          return (
            <Card
              key={o.id}
              title={
                <span className="inline-flex items-center gap-2">
                  <Icon name={kind?.icon ?? 'Send'} size={16} className="text-fg-muted" />
                  {o.name}
                </span>
              }
              subtitle={`${kind?.label ?? o.kind} · ${outputSummary(o, cat.data)}`}
              action={
                manage && (
                  <div className="flex gap-1">
                    <Button size="sm" icon="Pencil" onClick={() => setEdit({ output: o, kind: o.kind })}>
                      Bearbeiten
                    </Button>
                    <Button size="sm" iconOnly icon="Trash2" aria-label={`Ausgang „${o.name}“ löschen`} onClick={() => remove(o)} />
                  </div>
                )
              }
            >
              <div className="flex flex-wrap gap-1.5 items-center text-meta text-fg-muted">
                {o.needs.length ? (
                  <>
                    Braucht:
                    {o.needs.map((n) => (
                      <Chip key={n} mono>
                        {n}
                      </Chip>
                    ))}
                  </>
                ) : (
                  'Braucht keine Felder.'
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 items-center text-meta text-fg-muted">
                {o.used_by.length ? (
                  <>
                    Verwendet in:
                    {o.used_by.map((u) => (
                      <Link key={u.id} to={`/automationen/${u.id}`}>
                        <Chip>{u.name}</Chip>
                      </Link>
                    ))}
                  </>
                ) : (
                  'Noch in keiner Automation verwendet.'
                )}
                <span className="ml-auto">geändert {fmtDateTime(o.updated_at)}{o.updated_by_name ? ` · ${o.updated_by_name}` : ''}</span>
              </div>
              {o.used_by.length > 0 && <p className="m-0 mt-2 text-meta text-fg-muted">Änderungen wirken erst, wenn die Automation neu getestet und aktiviert wurde.</p>}
            </Card>
          );
        })}
      </div>
      {choose && cat.data && (
        <Dialog open onClose={() => setChoose(false)} title="Art des Ausgangs wählen" width={620}>
          <div className="grid sm:grid-cols-2 gap-2">
            {cat.data.outputKinds.map((k) => (
              <button key={k.kind} type="button" onClick={() => (setChoose(false), setEdit({ output: null, kind: k.kind }))} className="text-left flex gap-3 p-3 rounded-node border border-line bg-card hover:bg-raised focus-visible:shadow-ring">
                <Icon name={k.icon} size={18} className="text-fg-muted mt-0.5 shrink-0" />
                <span className="flex flex-col gap-0.5">
                  <strong className="text-sm">{k.label}</strong>
                  <span className="text-meta text-fg-muted">{k.description}</span>
                </span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {edit && cat.data && <OutputDialog output={edit.output} kind={edit.kind} cat={cat.data} onClose={(saved) => (setEdit(null), saved && refresh())} />}
    </div>
  );
}
