import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { del, post, put } from '../../api/client';
import { Button, Card, Chip, EmptyState, ErrorBox, FieldWrap, Input, Notice, PageHeader, SkeletonRows, Switch } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { FormProblems, useFormCheck } from '../../components/ui/form';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { usePageMeta } from '../../components/layout/AppShell';
import { WorkflowTabs } from './WorkflowTabs';
import { CheckList, FieldList, Help, NumberField, SelectField, inputSummary, normKey, useCatalog, useInputs, type Catalog, type InputDef } from './shared';

/** Auslöser auf Grundlage der vorhandenen Verbindungen, Quellen und Sammlungen – hier eingerichtet, im Editor verwendet. */

const DEFAULTS: Record<string, Record<string, any>> = {
  fe2: { connectionId: '', phases: ['neu'] },
  feuersoftware: { connectionId: '', phases: ['neu'] },
  warnfeed: { connectionId: '', phases: ['neu'], onlyInArea: true },
  rss: { feedId: null },
  upload: { collectionId: null, windowMinutes: 30 },
  schedule: { mode: 'daily', time: '07:00', weekdays: [] },
  manual: { fields: [] },
  press: { channels: [] },
  calendar: { timing: 'start', beforeValue: 60, beforeUnit: 'minutes', categoryIds: [], tags: [], sources: [], textContains: '' },
};

/** Kommagetrennte Liste: Text bleibt beim Tippen erhalten, gespeichert wird die bereinigte Liste. */
function TagsInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20));
      }}
    />
  );
}

/** Dialog zum Anlegen/Bearbeiten – auch direkt aus dem Workflow (`preset`: Startwerte einer Vorlage; `onClose` liefert die ID). */
export function InputDialog({ input, kind, cat, onClose, preset }: { input: InputDef | null; kind: string; cat: Catalog; onClose: (saved: boolean, id?: string) => void; preset?: { name?: string; config?: Record<string, any> } }) {
  const toastError = useErrorToast();
  const [name, setName] = useState(input?.name ?? preset?.name ?? cat.inputKinds.find((k) => k.kind === kind)?.label ?? '');
  const [c, setC] = useState<Record<string, any>>({ ...DEFAULTS[kind], ...(input ? input.config : (preset?.config ?? {})) });
  const [busy, setBusy] = useState(false);
  const def = cat.inputKinds.find((k) => k.kind === kind)!;
  const set = (patch: Record<string, any>) => setC((x) => ({ ...x, ...patch }));
  const conns = cat.connections.filter((x) => x.kind === def.connectionKind);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, config: c };
      if (input) {
        await put(`/automation-inputs/${input.id}`, body);
        onClose(true, input.id);
      } else onClose(true, (await post<{ id: string }>('/automation-inputs', { ...body, kind })).id);
    } catch (e) {
      toastError(e, 'Auslöser nicht gespeichert');
    } finally {
      setBusy(false);
    }
  };
  const fields = (c.fields ?? []) as { key: string; label: string; example: string }[];
  const setField = (i: number, patch: Partial<{ key: string; label: string; example: string }>) => set({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const check = useFormCheck({ 'in-name': name.trim().length < 2 && 'Bitte einen Namen angeben (mindestens 2 Zeichen).' });
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      width={620}
      title={input ? `Auslöser bearbeiten: ${input.name}` : `Neuer Auslöser: ${def.label}`}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Abbrechen</Button>
          <Button variant="primary" loading={busy} onClick={() => check.submit(save)}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormProblems check={check} />
        <p className="m-0 text-sm text-fg-muted">{def.description}</p>
        <FieldWrap label="Name" htmlFor="in-name" required error={check.error('in-name')} help="So erscheint der Auslöser in der Palette des Editors.">
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
              help={conns.length ? 'Nur aktive Verbindungen liefern Ereignisse. Eingerichtet wird die Verbindung unter Einrichtung → Verbindungen.' : undefined}
              labelAction={<Help title="Verbindung" anchor="ausloeser">Ein Auslöser hört auf eine bestehende Verbindung. Zugangsdaten, Tests und Gebietsfilter bleiben dort; hier wird nur festgelegt, welche Ereignisse einen Workflow starten.</Help>}
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
                <FieldWrap label="Uhrzeit" htmlFor="in-time" help="Zeitzone der Instanz (Einstellungen → Organisation).">
                  <Input id="in-time" type="time" value={c.time} onChange={(e) => set({ time: e.target.value })} className="max-w-[160px]" />
                </FieldWrap>
                <CheckList legend="Nur an diesen Tagen (leer = jeden Tag)" columns={7} options={['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((l, i) => ({ value: i + 1, label: l }))} value={c.weekdays ?? []} onChange={(v) => set({ weekdays: [...v].sort() })} />
              </>
            )}
            <Notice>Verpasste Termine (z. B. während eines Neustarts länger als 10 Minuten) werden nicht nachgeholt.</Notice>
          </>
        )}
        {kind === 'calendar' && (
          <>
            <SelectField
              id="in-cal-timing"
              label="Zeitpunkt"
              value={c.timing ?? 'start'}
              onChange={(v) => set({ timing: v })}
              options={[
                { value: 'start', label: 'Zu Beginn des Termins' },
                { value: 'end', label: 'Zum Ende des Termins' },
                { value: 'before', label: 'Vor Beginn (X Minuten/Stunden/Tage)' },
              ]}
              help="Gilt für eigene und eingelesene Termine, auch für jeden Termin einer Serie – jeder Zeitpunkt löst genau einmal aus."
              labelAction={<Help title="Kalendereintrag" anchor="ausloeser">Der Worker prüft alle 30 Sekunden. Wird ein Termin verschoben, löst er zum neuen Zeitpunkt aus. Verpasste Zeitpunkte (z. B. Neustart) werden höchstens 10 Minuten nachgeholt, Zeitpunkte vor dem Aktivieren des Workflows nie.</Help>}
            />
            {c.timing === 'before' && (
              <div className="grid grid-cols-[1fr_1fr] gap-3">
                <NumberField id="in-cal-before" label="Wie lange vorher" min={1} max={999} value={c.beforeValue} onChange={(v) => set({ beforeValue: v })} help="Höchstens 30 Tage." />
                <SelectField id="in-cal-unit" label="Einheit" value={c.beforeUnit ?? 'minutes'} onChange={(v) => set({ beforeUnit: v })} options={[{ value: 'minutes', label: 'Minuten' }, { value: 'hours', label: 'Stunden' }, { value: 'days', label: 'Tage' }]} />
              </div>
            )}
            <CheckList legend="Nur Termine dieser Kategorien (leer = alle)" columns={2} options={(cat.calendarCategories ?? []).map((x) => ({ value: x.id, label: x.name }))} value={c.categoryIds ?? []} onChange={(v) => set({ categoryIds: v })} />
            <CheckList legend="Nur aus diesen Quellen (leer = alle)" columns={2} options={[{ value: 'own', label: 'Eigene Termine' }, ...(cat.calendarSources ?? []).map((x) => ({ value: x.id, label: `iCal: ${x.name}` }))]} value={c.sources ?? []} onChange={(v) => set({ sources: v })} />
            <FieldWrap label="Schlagwörter (eines davon, leer = alle)" htmlFor="in-cal-tags" help="Mehrere mit Komma trennen; Groß-/Kleinschreibung egal.">
              <TagsInput id="in-cal-tags" value={c.tags ?? []} onChange={(tags) => set({ tags })} />
            </FieldWrap>
            <FieldWrap label="Titel oder Beschreibung enthält" htmlFor="in-cal-text" help="Leer = keine Einschränkung.">
              <Input id="in-cal-text" value={c.textContains ?? ''} maxLength={100} onChange={(e) => set({ textContains: e.target.value })} />
            </FieldWrap>
          </>
        )}
        {kind === 'press' && (
          <CheckList
            legend="Nur bei diesen Eingangswegen (leer = jeder)"
            columns={2}
            options={[{ value: 'phone', label: 'Telefon' }, { value: 'mail', label: 'E-Mail (von Hand erfasst)' }, { value: 'mailbox', label: 'Presse-Postfach' }, { value: 'in_person', label: 'Persönlich' }, { value: 'other', label: 'Sonstiges' }]}
            value={c.channels ?? []}
            onChange={(v) => set({ channels: v })}
          />
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
                  <Input id={`mf-k-${i}`} mono value={f.key} maxLength={40} onChange={(e) => setField(i, { key: e.target.value })} onBlur={(e) => setField(i, { key: normKey(e.target.value) })} invalid={!/^[a-z][a-z0-9_]{0,39}$/.test(f.key)} />
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
  usePageMeta({ title: 'Auslöser' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['automation-inputs'] });
  const remove = async (i: InputDef) => {
    if (!(await ask({ title: 'Auslöser löschen?', text: `„${i.name}“ steht danach im Editor nicht mehr zur Verfügung.`, confirmLabel: 'Löschen' }))) return;
    try {
      await del(`/automation-inputs/${i.id}`);
      toast({ tone: 'success', title: 'Auslöser gelöscht' });
      refresh();
    } catch (e) {
      toastError(e, 'Nicht gelöscht');
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        subtitle="Auslöser für Workflows: Einsätze, amtliche Warnungen, RSS-Einträge, Uploads, Zeitpläne, Presseanfragen, Kalendertermine und manueller Start."
        actions={manage && <Button variant="primary" icon="Plus" loading={!cat.data} onClick={() => setChoose(true)}>Neuer Auslöser</Button>}
      />
      <WorkflowTabs />
      {cat.data && !cat.data.enabled && <Notice tone="warning" title="Workflows sind abgeschaltet">Unter Einstellungen → Workflows lassen sie sich wieder einschalten.</Notice>}
      {(q.isLoading || cat.isLoading) && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Auslöser konnten nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {q.data && q.data.length === 0 && <EmptyState icon="Zap" title="Noch keine Auslöser." text={manage ? 'Ein Auslöser legt fest, welches Ereignis einen Workflow startet.' : 'Auslöser legt an, wer Workflows verwalten darf.'} action={manage && <Button icon="Plus" disabled={!cat.data} onClick={() => setChoose(true)}>Neuer Auslöser</Button>} />}
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
                    <Button size="sm" iconOnly icon="Trash2" aria-label={`Auslöser „${i.name}“ löschen`} onClick={() => remove(i)} />
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
                      <Link key={u.id} to={`/workflows/${u.id}`}>
                        <Chip>{u.name}</Chip>
                      </Link>
                    ))}
                  </>
                ) : (
                  'Noch in keinem Workflow verwendet.'
                )}
                <span className="ml-auto">geändert {fmtDateTime(i.updated_at)}{i.updated_by_name ? ` · ${i.updated_by_name}` : ''}</span>
              </div>
            </Card>
          );
        })}
      </div>
      {choose && cat.data && (
        <Dialog open onClose={() => setChoose(false)} title="Art des Auslösers wählen" width={620}>
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
