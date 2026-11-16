import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { del, post, put } from '../../api/client';
import { Button, Card, Chip, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SkeletonRows, Switch } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { CheckList, FieldList, Help, NumberField, SelectField, inputSummary, useCatalog, useInputs, type Catalog, type InputDef } from './shared';

/** Eingänge: Auslöser auf Grundlage der vorhandenen Verbindungen, Quellen und Sammlungen – hier eingerichtet, im Editor verwendet. */

const DEFAULTS: Record<string, Record<string, any>> = {
  fe2: { connectionId: '', phases: ['neu'] },
  feuersoftware: { connectionId: '', phases: ['neu'] },
  warnfeed: { connectionId: '', phases: ['neu'], onlyInArea: true },
  rss: { feedId: null },
  upload: { collectionId: null, windowMinutes: 30 },
  schedule: { mode: 'daily', time: '07:00', weekdays: [] },
  manual: { fields: [] },
};

function InputDialog({ input, kind, cat, onClose }: { input: InputDef | null; kind: string; cat: Catalog; onClose: (saved: boolean) => void }) {
  const toastError = useErrorToast();
  const [name, setName] = useState(input?.name ?? cat.inputKinds.find((k) => k.kind === kind)?.label ?? '');
  const [c, setC] = useState<Record<string, any>>({ ...DEFAULTS[kind], ...(input?.config ?? {}) });
  const [busy, setBusy] = useState(false);
  const def = cat.inputKinds.find((k) => k.kind === kind)!;
  const set = (patch: Record<string, any>) => setC((x) => ({ ...x, ...patch }));
  const conns = cat.connections.filter((x) => x.kind === def.connectionKind);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, config: c };
      if (input) await put(`/automation-inputs/${input.id}`, body);
      else await post('/automation-inputs', { ...body, kind });
      onClose(true);
    } catch (e) {
      toastError(e, 'Eingang nicht gespeichert');
    } finally {
      setBusy(false);
    }
  };
  const fields = (c.fields ?? []) as { key: string; label: string; example: string }[];
  const setField = (i: number, patch: Partial<{ key: string; label: string; example: string }>) => set({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      width={620}
      title={input ? `Eingang bearbeiten: ${input.name}` : `Neuer Eingang: ${def.label}`}
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
        <FieldWrap label="Name" htmlFor="in-name" required help="So erscheint der Eingang in der Palette des Editors.">
          <Input id="in-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </FieldWrap>
        {def.source === 'connection' && (
          <>
            <SelectField
              id="in-conn"
              label="Verbindung"
              value={c.connectionId ?? ''}
              onChange={(v) => set({ connectionId: v })}
              placeholder="Bitte wählen …"
              options={conns.map((x) => ({ value: x.id, label: `${x.name}${x.status !== 'active' ? ` (${x.status === 'disabled' ? 'deaktiviert' : 'nicht aktiv'})` : ''}` }))}
              help={conns.length ? 'Nur aktive Verbindungen liefern Ereignisse. Eingerichtet wird die Verbindung unter Kanäle → Verbindungen.' : undefined}
              labelAction={<Help title="Verbindung" anchor="eingaenge">Ein Eingang hört auf eine bestehende Verbindung. Zugangsdaten, Tests und Gebietsfilter bleiben dort; hier wird nur festgelegt, welche Ereignisse eine Automation starten.</Help>}
            />
            {!conns.length && <Notice tone="warning">Es gibt noch keine passende Verbindung. <Link to="/verbindungen">Verbindungen öffnen →</Link></Notice>}
            <CheckList legend="Welche Vorgänge starten einen Lauf?" options={(def.phases ?? []).map((p) => ({ value: p.value, label: p.label }))} value={c.phases ?? []} onChange={(v) => set({ phases: v })} />
            {kind === 'warnfeed' && <Switch checked={c.onlyInArea !== false} onChange={(v) => set({ onlyInArea: v })} label="Nur Warnungen im eigenen Gebiet" description="Gebietsfilter der Verbindung. Aus: auch Warnungen außerhalb (Feld „im_gebiet“ = nein)." />}
          </>
        )}
        {kind === 'rss' && <SelectField id="in-feed" label="Quelle" value={c.feedId ?? ''} onChange={(v) => set({ feedId: v || null })} placeholder="Alle Quellen" options={cat.feeds.map((f) => ({ value: f.id, label: f.title }))} help="Neue Einträge beim regelmäßigen Abruf starten je einen Lauf. Das erste Einlesen einer Quelle zählt nicht." />}
        {kind === 'upload' && (
          <>
            <SelectField id="in-coll" label="Sammlung" value={c.collectionId ?? ''} onChange={(v) => set({ collectionId: v || null })} placeholder="Alle Sammlungen" options={cat.collections.map((x) => ({ value: x.id, label: x.title }))} />
            <NumberField id="in-window" label="Bündeln je Zeitfenster" unit="Minuten" min={5} max={1440} value={c.windowMinutes} onChange={(v) => set({ windowMinutes: v })} help="Alle Uploads im Zeitfenster ergeben einen Lauf am Ende des Fensters (Feld „anzahl“). Angaben der Hochladenden werden nie übergeben." />
          </>
        )}
        {kind === 'schedule' && (
          <>
            <SelectField id="in-mode" label="Art" value={c.mode} onChange={(v) => setC(v === 'interval' ? { mode: 'interval', minutes: 60 } : { mode: 'daily', time: '07:00', weekdays: [] })} options={[{ value: 'daily', label: 'Täglich zu einer Uhrzeit' }, { value: 'interval', label: 'Alle N Minuten' }]} />
            {c.mode === 'interval' ? (
              <NumberField id="in-minutes" label="Abstand" unit="Minuten" min={cat.limits.minIntervalMinutes} max={1440} value={c.minutes} onChange={(v) => set({ minutes: v })} help={`Mindestens ${cat.limits.minIntervalMinutes} Minuten (Schutz vor Fluten).`} />
            ) : (
              <>
                <FieldWrap label="Uhrzeit" htmlFor="in-time" help="Zeitzone der Instanz (Einstellungen → Allgemein).">
                  <Input id="in-time" type="time" value={c.time} onChange={(e) => set({ time: e.target.value })} className="max-w-[160px]" />
                </FieldWrap>
                <CheckList legend="Nur an diesen Tagen (leer = jeden Tag)" columns={7} options={['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((l, i) => ({ value: i + 1, label: l }))} value={c.weekdays ?? []} onChange={(v) => set({ weekdays: [...v].sort() })} />
              </>
            )}
            <Notice>Verpasste Termine (z. B. während eines Neustarts länger als 10 Minuten) werden nicht nachgeholt.</Notice>
          </>
        )}
        {kind === 'manual' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Eigene Felder beim Start</span>
              <Button size="sm" icon="Plus" disabled={fields.length >= 10} onClick={() => set({ fields: [...fields, { key: `feld_${fields.length + 1}`, label: '', example: '' }] })}>
                Feld hinzufügen
              </Button>
            </div>
            {fields.length === 0 && <p className="m-0 text-sm text-fg-muted">Ohne eigene Felder steht nur „gestartet_von“ zur Verfügung.</p>}
            {fields.map((f, i) => (
              <div key={i} className="grid sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                <FieldWrap label="Bezeichnung" htmlFor={`mf-l-${i}`}>
                  <Input id={`mf-l-${i}`} value={f.label} maxLength={80} onChange={(e) => setField(i, { label: e.target.value })} />
                </FieldWrap>
                <FieldWrap label="Feldname" htmlFor={`mf-k-${i}`}>
                  <Input id={`mf-k-${i}`} mono value={f.key} maxLength={40} onChange={(e) => setField(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
                </FieldWrap>
                <FieldWrap label="Beispiel (Testlauf)" htmlFor={`mf-e-${i}`}>
                  <Input id={`mf-e-${i}`} value={f.example} maxLength={300} onChange={(e) => setField(i, { example: e.target.value })} />
                </FieldWrap>
                <Button iconOnly icon="Trash2" aria-label={`Feld ${f.label || i + 1} entfernen`} onClick={() => set({ fields: fields.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export default function Inputs() {
  const { can } = useAuth();
  const manage = can('automation.manage');
  const cat = useCatalog();
  const q = useInputs();
  const qc = useQueryClient();
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const [edit, setEdit] = useState<{ input: InputDef | null; kind: string } | null>(null);
  const [choose, setChoose] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['automation-inputs'] });
  const remove = async (i: InputDef) => {
    if (!(await ask({ title: 'Eingang löschen?', text: `„${i.name}“ steht danach im Editor nicht mehr zur Verfügung.`, confirmLabel: 'Löschen' }))) return;
    try {
      await del(`/automation-inputs/${i.id}`);
      toast({ tone: 'success', title: 'Eingang gelöscht' });
      refresh();
    } catch (e) {
      toastError(e, 'Nicht gelöscht');
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Eingänge"
        subtitle="Auslöser für Automationen: Einsätze, amtliche Warnungen, RSS-Einträge, Uploads, Zeitpläne und manueller Start."
        actions={manage && <Button variant="primary" icon="Plus" disabled={!cat.data} onClick={() => setChoose(true)}>Neuer Eingang</Button>}
      />
      {cat.data && !cat.data.enabled && <Notice tone="warning" title="Automationen sind abgeschaltet">Unter Einstellungen → Redaktion lassen sie sich wieder einschalten.</Notice>}
      {(q.isLoading || cat.isLoading) && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Eingänge konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && <EmptyState icon="Zap" title="Noch keine Eingänge" text="Ein Eingang legt fest, welches Ereignis eine Automation startet." />}
      <div className="grid gap-4 lg:grid-cols-2">
        {(q.data ?? []).map((i) => {
          const kind = cat.data?.inputKinds.find((k) => k.kind === i.kind);
          return (
            <Card
              key={i.id}
              title={
                <span className="inline-flex items-center gap-2">
                  <Icon name={kind?.icon ?? 'Zap'} size={16} className="text-fg-muted" />
                  {i.name}
                </span>
              }
              subtitle={`${kind?.label ?? i.kind} · ${inputSummary(i, cat.data)}`}
              action={
                manage && (
                  <div className="flex gap-1">
                    <Button size="sm" icon="Pencil" onClick={() => setEdit({ input: i, kind: i.kind })}>
                      Bearbeiten
                    </Button>
                    <Button size="sm" iconOnly icon="Trash2" aria-label={`Eingang „${i.name}“ löschen`} onClick={() => remove(i)} />
                  </div>
                )
              }
            >
              <details className="group">
                <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg select-none">Felder für Platzhalter und Bedingungen ({i.fields.length})</summary>
                <div className="pt-3">
                  <FieldList fields={i.fields} />
                </div>
              </details>
              <div className="mt-3 flex flex-wrap gap-1.5 items-center text-meta text-fg-muted">
                {i.used_by.length ? (
                  <>
                    Verwendet in:
                    {i.used_by.map((u) => (
                      <Link key={u.id} to={`/automationen/${u.id}`}>
                        <Chip>{u.name}</Chip>
                      </Link>
                    ))}
                  </>
                ) : (
                  'Noch in keiner Automation verwendet.'
                )}
                <span className="ml-auto">geändert {fmtDateTime(i.updated_at)}{i.updated_by_name ? ` · ${i.updated_by_name}` : ''}</span>
              </div>
            </Card>
          );
        })}
      </div>
      {choose && cat.data && (
        <Dialog open onClose={() => setChoose(false)} title="Art des Eingangs wählen" width={620}>
          <div className="grid sm:grid-cols-2 gap-2">
            {cat.data.inputKinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => (setChoose(false), setEdit({ input: null, kind: k.kind }))}
                className="text-left flex gap-3 p-3 rounded-node border border-line bg-card hover:bg-raised focus-visible:shadow-ring"
              >
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
      {edit && cat.data && <InputDialog input={edit.input} kind={edit.kind} cat={cat.data} onClose={(saved) => (setEdit(null), saved && refresh())} />}
    </div>
  );
}
