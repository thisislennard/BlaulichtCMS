import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, cx, FieldWrap, Input, Notice, Select, Switch } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { KeywordMeaning } from '../../components/KeywordMeaning';
import { meaning, useKeywords } from '../../lib/keywords';
import { ImageMediaPicker } from '../designs/ImageFill';
import { FieldList, Help, NumberField, SelectField, TemplateField, inputSummary, normKey, outputSummary, type Catalog, type InputDef, type OutputDef } from './shared';

/* Seitenleiste des Editors: Einstellungen des gewählten Knotens. Bedingungen und Vorlagen sind reine Daten. */

export type NodeType = 'input' | 'output' | 'condition' | 'switch' | 'template' | 'delay' | 'dedup' | 'approval' | 'merge' | 'image';
export interface GNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: any;
}
export interface GEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle?: string | null;
}

export function ports(n: Pick<GNode, 'type' | 'data'>): { id: string; label: string }[] {
  switch (n.type) {
    case 'condition':
      return [
        { id: 'true', label: 'trifft zu' },
        { id: 'false', label: 'trifft nicht zu' },
      ];
    case 'switch':
      return [...((n.data?.cases ?? []) as { id: string; value: string }[]).map((c) => ({ id: `case:${c.id}`, label: c.value || '(leer)' })), { id: 'default', label: 'sonst' }];
    case 'approval':
      return [
        { id: 'approved', label: 'freigegeben' },
        { id: 'rejected', label: 'abgelehnt' },
      ];
    case 'output':
      return [{ id: 'out', label: 'danach' }];
    default:
      return [{ id: 'out', label: 'weiter' }];
  }
}

export const newId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}`;

/** Startwerte je Knotentyp. */
export function defaultData(type: NodeType, extra: Record<string, any> = {}): any {
  switch (type) {
    case 'condition':
      return { combinator: 'and', rules: [{ field: 'stichwort', op: 'starts_with', value: '' }], ...extra };
    case 'switch':
      return { field: 'vorgang', cases: [{ id: newId('c'), value: 'neu' }], ...extra };
    case 'template':
      return { fields: [{ key: 'text', template: '' }], ...extra };
    case 'delay':
      return { minutes: 10, ...extra };
    case 'dedup':
      return { fields: ['stichwort'], windowMinutes: 60, ...extra };
    case 'approval':
      return { title: 'Freigabe: {{automation}}', summary: '', timeoutHours: 4, ...extra };
    case 'image':
      return { texts: {}, images: {}, altText: '', collectionId: null, ...extra };
    default:
      return { ...extra };
  }
}

export interface Rule {
  field: string;
  op: string;
  value?: string;
}
interface Group {
  combinator: 'and' | 'or';
  rules: (Rule | Group)[];
}
const isGroup = (r: Rule | Group): r is Group => Array.isArray((r as Group).rules);

export function RuleRow({ r, fields, ops, onChange, onRemove, idp, disabled }: { r: Rule; fields: { key: string; label: string }[]; ops: Record<string, string>; onChange: (r: Rule) => void; onRemove: () => void; idp: string; disabled?: boolean }) {
  const noValue = r.op === 'exists' || r.op === 'not_exists';
  const known = fields.some((f) => f.key === r.field);
  // Stichwortverzeichnis (#195): Vorschläge für Stichwort und Stichwort-Kategorie, unbekannte Werte bleiben erlaubt
  const kw = useKeywords();
  const kwList = r.field === 'stichwort' || r.field === 'stichwort_kategorie' ? (kw.data?.entries ?? []) : [];
  const suggestions = r.field === 'stichwort' ? kwList.map((k) => ({ value: k.code, label: meaning(k) || k.category })) : [...new Set(kwList.map((k) => k.category).filter(Boolean))].map((c) => ({ value: c, label: '' }));
  return (
    <div className="grid grid-cols-[1fr_auto] gap-1.5 p-2 rounded-node bg-bg border border-line">
      <div className="flex flex-col gap-1.5 min-w-0">
        <label className="sr-only" htmlFor={`${idp}-f`}>Feld</label>
        <Select id={`${idp}-f`} value={r.field} disabled={disabled} invalid={!known} onChange={(e) => onChange({ ...r, field: e.target.value })}>
          {!known && <option value={r.field}>{r.field} (nicht verfügbar)</option>}
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </Select>
        <div className="flex flex-col gap-1.5">
          <label className="sr-only" htmlFor={`${idp}-o`}>Vergleich</label>
          <Select id={`${idp}-o`} value={r.op} disabled={disabled} onChange={(e) => onChange({ ...r, op: e.target.value })}>
            {Object.entries(ops).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          <label className="sr-only" htmlFor={`${idp}-v`}>Wert</label>
          <Input id={`${idp}-v`} list={suggestions.length ? `${idp}-vl` : undefined} value={noValue ? '' : (r.value ?? '')} disabled={disabled || noValue} placeholder={r.op === 'in' ? 'a, b, c' : noValue ? '–' : 'Wert'} maxLength={500} onChange={(e) => onChange({ ...r, value: e.target.value })} />
          {suggestions.length > 0 && (
            <datalist id={`${idp}-vl`}>
              {suggestions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </datalist>
          )}
          {r.field === 'stichwort' && !noValue && r.op !== 'in' && r.value ? <KeywordMeaning code={r.value} /> : null}
        </div>
      </div>
      <Button size="sm" iconOnly icon="X" aria-label="Regel entfernen" disabled={disabled} onClick={onRemove} />
    </div>
  );
}

function GroupEditor({ g, fields, ops, onChange, onRemove, depth, idp, disabled }: { g: Group; fields: { key: string; label: string }[]; ops: Record<string, string>; onChange: (g: Group) => void; onRemove?: () => void; depth: number; idp: string; disabled?: boolean }) {
  const set = (i: number, r: Rule | Group) => onChange({ ...g, rules: g.rules.map((x, j) => (j === i ? r : x)) });
  const remove = (i: number) => onChange({ ...g, rules: g.rules.filter((_, j) => j !== i) });
  const first = fields[0]?.key ?? 'stichwort';
  return (
    <div className={cx('flex flex-col gap-2', depth > 0 && 'pl-3 border-l-2 border-line')}>
      <FieldWrap label={depth ? 'Untergruppe' : 'Verknüpfung'} htmlFor={`${idp}-c`}>
        <Select id={`${idp}-c`} value={g.combinator} disabled={disabled} onChange={(e) => onChange({ ...g, combinator: e.target.value as 'and' | 'or' })}>
          <option value="and">Alle Regeln müssen zutreffen (UND)</option>
          <option value="or">Mindestens eine Regel trifft zu (ODER)</option>
        </Select>
      </FieldWrap>
      {g.rules.map((r, i) => (isGroup(r) ? <GroupEditor key={i} g={r} fields={fields} ops={ops} depth={depth + 1} idp={`${idp}-${i}`} disabled={disabled} onChange={(x) => set(i, x)} onRemove={() => remove(i)} /> : <RuleRow key={i} r={r} fields={fields} ops={ops} idp={`${idp}-${i}`} disabled={disabled} onChange={(x) => set(i, x)} onRemove={() => remove(i)} />))}
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" icon="Plus" disabled={disabled || g.rules.length >= 20} onClick={() => onChange({ ...g, rules: [...g.rules, { field: first, op: 'eq', value: '' }] })}>
          Regel
        </Button>
        {depth === 0 && (
          <Button size="sm" icon="Plus" disabled={disabled || g.rules.length >= 20} onClick={() => onChange({ ...g, rules: [...g.rules, { combinator: 'or', rules: [{ field: first, op: 'eq', value: '' }] }] })}>
            Untergruppe
          </Button>
        )}
        {depth > 0 && onRemove && (
          <Button size="sm" variant="ghost" icon="Trash2" disabled={disabled} onClick={onRemove}>
            Untergruppe entfernen
          </Button>
        )}
      </div>
    </div>
  );
}

export function NodePanel({
  node,
  onChange,
  onRemove,
  onClose,
  cat,
  inputs,
  outputs,
  fields,
  errors,
  canPublish,
  readOnly,
  onCreate,
}: {
  node: GNode;
  onChange: (data: any) => void;
  onRemove: () => void;
  onClose: () => void;
  cat: Catalog;
  inputs: InputDef[];
  outputs: OutputDef[];
  fields: { key: string; label: string }[];
  errors: string[];
  canPublish: boolean;
  readOnly: boolean;
  /** Ein-/Ausgang direkt hier anlegen und einsetzen */
  onCreate?: () => void;
}) {
  const d = node.data ?? {};
  const set = (patch: Record<string, any>) => onChange({ ...d, ...patch });
  const nt = cat.nodeTypes.find((t) => t.type === node.type);
  const input = node.type === 'input' ? inputs.find((i) => i.id === d.inputId) : undefined;
  const output = node.type === 'output' ? outputs.find((o) => o.id === d.outputId) : undefined;
  const outKind = output ? cat.outputKinds.find((k) => k.kind === output.kind) : undefined;
  const idp = `np-${node.id}`;
  return (
    <section aria-labelledby={`${idp}-h`} className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-label uppercase text-fg-muted">{nt?.category === 'input' ? 'Eingang' : nt?.category === 'output' ? 'Ausgang' : 'Verarbeitung'}</div>
          <h3 id={`${idp}-h`} className="m-0 text-section font-semibold">{nt?.label}</h3>
          <p className="m-0 text-meta text-fg-muted">{nt?.description}</p>
        </div>
        <Button size="sm" iconOnly icon="X" aria-label="Einstellungen schließen" onClick={onClose} />
      </div>
      {errors.length > 0 && (
        <div role="alert" className="rounded-node border border-err/60 bg-err-soft p-3 flex flex-col gap-1 text-sm">
          <strong className="inline-flex items-center gap-1.5">
            <Icon name="XCircle" size={14} className="text-err" />
            {errors.length === 1 ? '1 Fehler' : `${errors.length} Fehler`}
          </strong>
          {errors.map((e, i) => (
            <span key={i} className="text-fg-muted">
              {e}
            </span>
          ))}
        </div>
      )}
      <FieldWrap label="Bezeichnung (optional)" htmlFor={`${idp}-label`} help="Eigener Name auf der Fläche, z. B. „Nur Brandeinsätze“.">
        <Input id={`${idp}-label`} value={d.label ?? ''} maxLength={80} disabled={readOnly} onChange={(e) => set({ label: e.target.value || undefined })} />
      </FieldWrap>

      {node.type === 'input' && (
        <>
          <SelectField id={`${idp}-in`} label="Eingang" value={d.inputId ?? ''} disabled={readOnly} onChange={(v) => set({ inputId: v })} placeholder="Bitte wählen …" options={inputs.map((i) => ({ value: i.id, label: i.name }))} help={input ? inputSummary(input, cat) : undefined} labelAction={<Help title="Eingang" anchor="eingaenge">Eingänge werden unter Workflows → Eingänge eingerichtet. Ein Ablauf darf mehrere Eingänge haben; ein Lauf startet immer an genau einem.</Help>} />
          {input && (
            <details open>
              <summary className="cursor-pointer text-sm font-medium">Felder dieses Eingangs</summary>
              <div className="pt-2">
                <FieldList fields={input.fields} />
              </div>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {!readOnly && onCreate && (
              <Button size="sm" icon="Plus" onClick={onCreate}>
                Neuen Eingang anlegen …
              </Button>
            )}
            <Link to="/workflows/eingaenge" className="text-sm !text-fg-muted hover:!text-fg">Eingänge verwalten →</Link>
          </div>
        </>
      )}

      {node.type === 'output' && (
        <>
          <SelectField id={`${idp}-out`} label="Ausgang" value={d.outputId ?? ''} disabled={readOnly} onChange={(v) => set({ outputId: v })} placeholder="Bitte wählen …" options={outputs.map((o) => ({ value: o.id, label: o.name }))} help={output ? `${outKind?.label} · ${outputSummary(output, cat)}` : undefined} />
          {output && output.needs.length > 0 && (
            <p className="m-0 text-meta text-fg-muted">
              Braucht die Felder: <span className="font-mono">{output.needs.join(', ')}</span>
            </p>
          )}
          {outKind?.directCapable && (
            <div className="rounded-node border border-line p-3 flex flex-col gap-2">
              <Switch
                checked={!!d.direct}
                disabled={readOnly || !canPublish}
                onChange={(v) => set({ direct: v || undefined })}
                label="Direkt veröffentlichen / versenden"
                description={
                  canPublish
                    ? 'Ohne menschliche Freigabe – wirkt nur, wenn der Workflow „Darf direkt veröffentlichen“ hat und die Version damit aktiviert wurde.'
                    : 'Nur mit dem Recht „Workflows direkt veröffentlichen lassen“ (Administration).'
                }
              />
              {d.direct && <Badge tone="warning" className="self-start">Direktversand markiert</Badge>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {!readOnly && onCreate && (
              <Button size="sm" icon="Plus" onClick={onCreate}>
                Neuen Ausgang anlegen …
              </Button>
            )}
            <Link to="/workflows/ausgaenge" className="text-sm !text-fg-muted hover:!text-fg">Ausgänge verwalten →</Link>
          </div>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <GroupEditor g={{ combinator: d.combinator ?? 'and', rules: d.rules ?? [] }} fields={fields} ops={cat.operators} depth={0} idp={idp} disabled={readOnly} onChange={(g) => set({ combinator: g.combinator, rules: g.rules })} />
          <Notice>
            Vergleiche ohne Groß-/Kleinschreibung. „ist mindestens/höchstens“ nur für Zahlen (z. B. Warnstufe). „ist eines von“: Werte mit Komma trennen.
          </Notice>
        </>
      )}

      {node.type === 'switch' && (
        <>
          <SelectField id={`${idp}-sf`} label="Feld" value={d.field ?? ''} disabled={readOnly} onChange={(v) => set({ field: v })} options={fields.map((f) => ({ value: f.key, label: f.label }))} />
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
            <legend className="text-sm font-medium mb-1">Fälle (je Fall ein Ausgang, dazu „sonst“)</legend>
            {(d.cases ?? []).map((c: { id: string; value: string }, i: number) => (
              <div key={c.id} className="flex gap-1.5">
                <label className="sr-only" htmlFor={`${idp}-case-${c.id}`}>Wert für Fall {i + 1}</label>
                <Input id={`${idp}-case-${c.id}`} value={c.value} disabled={readOnly} maxLength={200} onChange={(e) => set({ cases: d.cases.map((x: any) => (x.id === c.id ? { ...x, value: e.target.value } : x)) })} />
                <Button iconOnly icon="X" aria-label={`Fall „${c.value}“ entfernen`} disabled={readOnly || d.cases.length <= 1} onClick={() => set({ cases: d.cases.filter((x: any) => x.id !== c.id) })} />
              </div>
            ))}
            <Button size="sm" icon="Plus" className="self-start" disabled={readOnly || (d.cases ?? []).length >= cat.limits.maxCases} onClick={() => set({ cases: [...(d.cases ?? []), { id: newId('c'), value: '' }] })}>
              Fall
            </Button>
          </fieldset>
        </>
      )}

      {node.type === 'template' && (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-3">
          <legend className="text-sm font-medium mb-1 inline-flex items-center gap-1">
            Neue Felder
            <Help title="Felder setzen" anchor="verarbeitung">Legt Felder aus Textvorlagen an, z. B. <code>titel</code> = „{'{{stichwort_text}}'} in {'{{ort}}'}“. Die neuen Felder stehen danach in Bedingungen und Ausgängen zur Verfügung. Platzhalter werden nur als Text eingesetzt.</Help>
          </legend>
          {(d.fields ?? []).map((f: { key: string; template: string }, i: number) => (
            <div key={i} className="flex flex-col gap-1.5 p-2 rounded-node bg-bg border border-line">
              <div className="flex gap-1.5 items-end">
                <FieldWrap label="Feldname" htmlFor={`${idp}-tk-${i}`} className="flex-1">
                  <Input id={`${idp}-tk-${i}`} mono value={f.key} disabled={readOnly} maxLength={40} invalid={!/^[a-z][a-z0-9_]{0,39}$/.test(f.key)} onChange={(e) => set({ fields: d.fields.map((x: any, j: number) => (j === i ? { ...x, key: e.target.value } : x)) })} onBlur={(e) => set({ fields: d.fields.map((x: any, j: number) => (j === i ? { ...x, key: normKey(e.target.value) } : x)) })} />
                </FieldWrap>
                <Button iconOnly icon="X" aria-label={`Feld ${f.key} entfernen`} disabled={readOnly || d.fields.length <= 1} onClick={() => set({ fields: d.fields.filter((_: any, j: number) => j !== i) })} />
              </div>
              <TemplateField id={`${idp}-tt-${i}`} label="Vorlage" rows={3} max={5000} value={f.template} disabled={readOnly} fields={fields} onChange={(v) => set({ fields: d.fields.map((x: any, j: number) => (j === i ? { ...x, template: v } : x)) })} />
            </div>
          ))}
          <Button size="sm" icon="Plus" className="self-start" disabled={readOnly || (d.fields ?? []).length >= 20} onClick={() => set({ fields: [...(d.fields ?? []), { key: `feld_${(d.fields ?? []).length + 1}`, template: '' }] })}>
            Feld
          </Button>
        </fieldset>
      )}

      {node.type === 'delay' && <NumberField id={`${idp}-min`} label="Warten" unit="Minuten" min={1} max={cat.limits.maxDelayMinutes} value={d.minutes} disabled={readOnly} onChange={(v) => set({ minutes: v })} help="Höchstens 24 Stunden. Der Lauf hält an und wird danach fortgesetzt; Testläufe warten nicht." />}

      {node.type === 'dedup' && (
        <>
          <fieldset className="m-0 p-0 border-0 flex flex-col gap-1">
            <legend className="text-sm font-medium mb-1 inline-flex items-center gap-1">
              Schlüssel aus den Feldern
              <Help title="Einmal je Vorgang" anchor="verarbeitung">Gleiche Werte dieser Felder im Zeitfenster gelten als derselbe Vorgang – nur der erste Lauf geht weiter. Beispiel: Ort + Stichwort, 60 Minuten.</Help>
            </legend>
            {fields.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm min-h-[30px]">
                <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary)]" disabled={readOnly} checked={(d.fields ?? []).includes(f.key)} onChange={(e) => set({ fields: e.target.checked ? [...(d.fields ?? []), f.key].slice(0, 5) : (d.fields ?? []).filter((x: string) => x !== f.key) })} />
                {f.label}
              </label>
            ))}
          </fieldset>
          <NumberField id={`${idp}-win`} label="Zeitfenster" unit="Minuten" min={1} max={cat.limits.maxDedupMinutes} value={d.windowMinutes} disabled={readOnly} onChange={(v) => set({ windowMinutes: v })} />
        </>
      )}

      {node.type === 'approval' && (
        <>
          <TemplateField id={`${idp}-at`} label="Titel der Freigabe" value={d.title ?? ''} max={200} fields={fields} disabled={readOnly} onChange={(v) => set({ title: v })} />
          <TemplateField id={`${idp}-as`} label="Beschreibung" rows={4} value={d.summary ?? ''} max={1000} fields={fields} disabled={readOnly} onChange={(v) => set({ summary: v })} />
          <NumberField id={`${idp}-ah`} label="Frist" unit="Stunden" min={1} max={cat.limits.maxApprovalHours} value={d.timeoutHours} disabled={readOnly} onChange={(v) => set({ timeoutHours: v })} help="Ohne Entscheidung gilt die Anfrage danach als abgelehnt." />
          <Notice>Entscheiden dürfen Personen mit „Fassungen freigeben“ – auf der Seite Freigaben. Mit Vier-Augen-Prinzip nicht, wer den Workflow geändert oder aktiviert hat.</Notice>
        </>
      )}

      {node.type === 'image' && <ImageStep idp={idp} d={d} set={set} cat={cat} fields={fields} readOnly={readOnly} />}

      {node.type === 'merge' && <p className="m-0 text-sm text-fg-muted">Führt Wege zusammen. Weiter geht es, sobald ein eingehender Weg aktiv ist; danach stehen nur Felder zur Verfügung, die auf allen Wegen vorhanden sind.</p>}

      {node.type !== 'input' && fields.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-fg-muted">Verfügbare Felder an dieser Stelle ({fields.length})</summary>
          <ul className="m-0 mt-2 p-0 list-none flex flex-wrap gap-1">
            {fields.map((f) => (
              <li key={f.key} className="font-mono text-meta bg-raised rounded-chip px-1.5 py-0.5" title={f.label}>
                {f.key}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!readOnly && (
        <Button variant="danger" icon="Trash2" className="self-start" onClick={onRemove}>
          Knoten entfernen
        </Button>
      )}
    </section>
  );
}

/** Einstellungen von „Bild aus Vorlage erzeugen“ (#210): Bildvorlage, Texte mit Platzhaltern, feste Bilder, Ablage. */
function ImageStep({ idp, d, set, cat, fields, readOnly }: { idp: string; d: any; set: (p: Record<string, any>) => void; cat: Catalog; fields: { key: string; label: string }[]; readOnly: boolean }) {
  const [pick, setPick] = useState<string | null>(null);
  const list = cat.imageTemplates ?? [];
  const tpl = list.find((t) => t.id === d.templateId);
  const texts: Record<string, string> = d.texts ?? {};
  const images: Record<string, string> = d.images ?? {};
  return (
    <>
      {d.templateName && !d.templateId && <Notice tone="warning">Aus dem Import: Bildvorlage „{d.templateName}“ gibt es hier nicht – bitte eine Bildvorlage wählen.</Notice>}
      <SelectField
        id={`${idp}-tpl`}
        label="Bildvorlage"
        value={d.templateId ?? ''}
        disabled={readOnly}
        placeholder="Bitte wählen …"
        onChange={(v) => {
          const t = list.find((x) => x.id === v);
          // Vorhandene Texte behalten, für neue Felder leer starten
          set({ templateId: v || undefined, templateName: undefined, texts: Object.fromEntries((t?.texts ?? []).map((f) => [f.id, texts[f.id] ?? ''])), images: {} });
        }}
        options={list.map((t) => ({ value: t.id, label: t.title }))}
        help={list.length ? 'Befüllbare Bildvorlagen aus Redaktion → Designvorlagen.' : 'Noch keine befüllbare Bildvorlage – unter Redaktion → Designvorlagen anlegen.'}
      />
      {tpl && (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-3">
          <legend className="text-sm font-medium mb-1">Texte der Vorlage</legend>
          {tpl.texts.map((f) => (
            <TemplateField
              key={f.id}
              id={`${idp}-txt-${f.id}`}
              label={`${f.label} (${f.id})`}
              rows={2}
              max={2000}
              value={texts[f.id] ?? ''}
              disabled={readOnly}
              fields={fields}
              help={f.default ? `Leer: „${f.default}“. Höchstens ${f.maxLength} Zeichen.` : `Höchstens ${f.maxLength} Zeichen.`}
              onChange={(v) => set({ texts: { ...texts, [f.id]: v } })}
            />
          ))}
          {tpl.images.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Bilder der Vorlage</span>
              {tpl.images.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0">
                    {f.label}
                    {f.required ? ' (Pflicht)' : ''}
                  </span>
                  {images[f.id] && <img src={`/api/v1/media/${images[f.id]}/preview`} alt="" className="h-10 w-10 object-cover rounded-chip border border-line" />}
                  <Button size="sm" disabled={readOnly} onClick={() => setPick(f.id)}>
                    {images[f.id] ? 'Ändern' : 'Festes Bild wählen'}
                  </Button>
                  {images[f.id] && (
                    <Button size="sm" iconOnly icon="X" aria-label={`Bild für ${f.label} entfernen`} disabled={readOnly} onClick={() => set({ images: Object.fromEntries(Object.entries(images).filter(([k]) => k !== f.id)) })} />
                  )}
                </div>
              ))}
              <p className="m-0 text-meta text-fg-muted">Ohne festes Bild bleibt der Platzhalter leer (Hintergrund der Vorlage).</p>
            </div>
          )}
          <TemplateField id={`${idp}-alt`} label="Alternativtext" rows={2} max={1000} value={d.altText ?? ''} disabled={readOnly} fields={fields} help="Leer: die Texte der Vorlage." onChange={(v) => set({ altText: v })} />
          <SelectField
            id={`${idp}-col`}
            label="Ablegen in"
            value={d.collectionId ?? ''}
            disabled={readOnly}
            onChange={(v) => set({ collectionId: v || null })}
            options={[{ value: '', label: 'Automatisch („Bilder aus Vorlagen“)' }, ...cat.collections.map((c) => ({ value: c.id, label: c.title }))]}
          />
          <Notice>Ein Beitrags-Ausgang danach übernimmt das Bild (erstes Bild als Titelbild) – damit auch für soziale Kanäle und Storys des Beitrags. Der Testlauf zeigt nur eine Vorschau und legt nichts an.</Notice>
        </fieldset>
      )}
      {pick && <ImageMediaPicker onClose={() => setPick(null)} onPick={(m) => set({ images: { ...images, [pick]: m.id } })} />}
    </>
  );
}
