import { useMemo, type ReactNode } from 'react';
import { Badge, Button, Card, cx, FieldWrap, Notice, Select } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { RuleRow, newId } from './NodePanel';
import { activationChecklist, graphToGuided, guidedToGraph, wantKinds, type ChecklistInput, type GuidedGraph, type GuidedModel, type GuidedRule } from './workflowModel';
import { Help, inputSummary, outputSummary, type Catalog, type InputDef, type OutputDef } from './shared';
import type { CreateRefRequest } from './CreateRef';

/*
 * Geführte Ansicht eines Workflows: Schritt 1 „Wenn“ (Auslöser), Schritt 2 „Nur wenn“ (einfache Bedingungen),
 * Schritt 3 „Dann“ (Aktionen). Bearbeitet denselben gespeicherten Ablauf wie der erweiterte Editor.
 */

function Step({ n, title, hint, children, action }: { n: number; title: string; hint: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-raised border border-line text-fg inline-flex items-center justify-center font-mono text-meta font-semibold" aria-hidden="true">
            {n}
          </span>
          {title}
        </span>
      }
      subtitle={hint}
      action={action}
    >
      <div className="flex flex-col gap-3">{children}</div>
    </Card>
  );
}

/** Ein Platz für einen Auslöser bzw. eine Aktion: Auswahl, „Neu anlegen …“, Entfernen; offene Plätze sind hervorgehoben. */
function Slot({
  idp,
  type,
  data,
  options,
  kindLabel,
  summary,
  errors,
  readOnly,
  onPick,
  onCreate,
  onRemove,
}: {
  idp: string;
  type: 'input' | 'output';
  data: any;
  options: { value: string; label: string }[];
  kindLabel: string;
  summary?: string;
  errors: string[];
  readOnly: boolean;
  onPick: (id: string) => void;
  onCreate: () => void;
  onRemove: () => void;
}) {
  const value = (type === 'input' ? data.inputId : data.outputId) ?? '';
  const open = !value;
  const word = type === 'input' ? 'Auslöser' : 'Aktion';
  return (
    <div className={cx('rounded-node border p-3 flex flex-col gap-2', open ? 'border-warn bg-warn-soft' : errors.length ? 'border-err' : 'border-line bg-card')}>
      <div className="flex flex-wrap items-center gap-2">
        {open ? <Badge tone="warning">Offen</Badge> : <Badge tone="success">Gewählt</Badge>}
        {data.label && <strong className="text-sm">{data.label}</strong>}
        {data.direct && <Badge tone="warning">Direkt</Badge>}
        {open && kindLabel && <span className="text-meta text-fg-muted">Passend: {kindLabel}</span>}
        {!readOnly && (
          <span className="ml-auto">
            <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label={`${word} entfernen`} onClick={onRemove} />
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2 items-end">
        <FieldWrap label={word} htmlFor={idp} className="flex-1 min-w-[220px]" help={summary}>
          <Select id={idp} value={value} disabled={readOnly} invalid={open} onChange={(e) => e.target.value && onPick(e.target.value)}>
            <option value="">{options.length ? 'Bitte wählen …' : 'Noch keine passenden vorhanden'}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FieldWrap>
        {!readOnly && (
          <Button icon="Plus" onClick={onCreate}>
            Neu anlegen …
          </Button>
        )}
      </div>
      {errors.filter((e) => !/noch nicht gewählt/.test(e)).map((e, i) => (
        <p key={i} className="m-0 text-meta text-err inline-flex items-start gap-1">
          <Icon name="AlertTriangle" size={12} className="mt-0.5 shrink-0" />
          {e}
        </p>
      ))}
    </div>
  );
}

export function GuidedEditor({
  graph,
  onChange,
  cat,
  inputs,
  outputs,
  errors,
  readOnly,
  onCreate,
  onAdvanced,
}: {
  graph: GuidedGraph;
  onChange: (g: GuidedGraph) => void;
  cat: Catalog;
  inputs: InputDef[];
  outputs: OutputDef[];
  errors: Record<string, string[]>;
  readOnly: boolean;
  /** Auslöser oder Aktion direkt anlegen; `assign` setzt ihn danach in den Platz ein */
  onCreate: (req: CreateRefRequest, assign: (id: string) => void) => void;
  onAdvanced: () => void;
}) {
  const conv = useMemo(() => graphToGuided(graph), [graph]);
  const inKind = (k: string) => cat.inputKinds.find((x) => x.kind === k);
  const outKind = (k: string) => cat.outputKinds.find((x) => x.kind === k);

  if (!conv.ok) {
    return (
      <Notice tone="info" title="Dieser Workflow ist für die geführte Ansicht zu verzweigt">
        <div className="flex flex-col gap-2">
          <ul className="m-0 pl-5">
            {conv.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <span>Er bleibt unverändert erhalten. Ansehen und bearbeiten im erweiterten Editor.</span>
          <span>
            <Button size="sm" icon="Workflow" onClick={onAdvanced}>
              Erweitert öffnen
            </Button>
          </span>
        </div>
      </Notice>
    );
  }
  const m = conv.model;
  const set = (next: GuidedModel) => onChange(guidedToGraph(next, graph, newId));
  const pick = (list: 'inputs' | 'outputs', id: string, refId: string) =>
    set({ ...m, [list]: m[list].map((x) => (x.id === id ? { id, data: { ...withoutWant(x.data), [list === 'inputs' ? 'inputId' : 'outputId']: refId } } : x)) });

  // Felder für Bedingungen: gemeinsame Felder aller Auslöser (offene Plätze: Felder der passenden Art)
  const fieldsOf = (d: any) => {
    const inp = inputs.find((i) => i.id === d.inputId);
    if (inp) return inp.fields.concat(inp.kind === 'manual' ? (inp.config.fields ?? []).map((f: any) => ({ key: f.key, label: f.label, type: 'text', example: '' })) : []);
    const kinds = wantKinds(d);
    return (kinds.length ? kinds : cat.inputKinds.map((k) => k.kind)).flatMap((k) => inKind(k)?.fields ?? []);
  };
  const lists = m.inputs.map((x) => fieldsOf(x.data));
  const condFields = lists.length ? lists[0].filter((f, i, a) => a.findIndex((y) => y.key === f.key) === i && lists.every((l) => l.some((y) => y.key === f.key))) : [];
  const fieldOpts = condFields.map((f) => ({ key: f.key, label: f.label }));

  const cond = m.condition;
  const setRules = (rules: GuidedRule[]) => set({ ...m, condition: rules.length ? { ...(cond ?? { id: newId('n'), combinator: 'and', extra: {} }), rules } : null });

  return (
    <div className="flex flex-col gap-4">
      <Step
        n={1}
        title="Wenn"
        hint="Welches Ereignis startet den Workflow? Mehrere Auslöser sind möglich – jeder startet einen eigenen Lauf."
        action={<Help title="Auslöser" anchor="ausloeser">Mögliche Auslöser: Alarm (FE2, Feuersoftware), amtliche Warnung, RSS-Eintrag, Uploads, Zeitplan oder Start von Hand. „Neu anlegen …“ richtet einen Auslöser direkt hier ein.</Help>}
      >
        {m.inputs.map((x) => {
          const kinds = wantKinds(x.data);
          const opts = inputs.filter((i) => !kinds.length || kinds.includes(i.kind) || i.id === x.data.inputId);
          const sel = inputs.find((i) => i.id === x.data.inputId);
          return (
            <Slot
              key={x.id}
              idp={`g-in-${x.id}`}
              type="input"
              data={x.data}
              options={opts.map((i) => ({ value: i.id, label: `${i.name} (${inKind(i.kind)?.label ?? i.kind})` }))}
              kindLabel={kinds.map((k) => inKind(k)?.label ?? k).join(' oder ')}
              summary={sel ? inputSummary(sel, cat) : undefined}
              errors={errors[x.id] ?? []}
              readOnly={readOnly}
              onPick={(id) => pick('inputs', x.id, id)}
              onCreate={() => onCreate({ type: 'input', kinds, preset: x.data.want }, (id) => pick('inputs', x.id, id))}
              onRemove={() => set({ ...m, inputs: m.inputs.filter((y) => y.id !== x.id) })}
            />
          );
        })}
        {m.inputs.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch kein Auslöser.</p>}
        {!readOnly && (
          <Button size="sm" icon="Plus" className="self-start" onClick={() => set({ ...m, inputs: [...m.inputs, { id: newId('n'), data: {} }] })}>
            {m.inputs.length ? 'Weiterer Auslöser' : 'Auslöser wählen'}
          </Button>
        )}
      </Step>

      <Step n={2} title="Nur wenn (optional)" hint="Bedingungen in der Form Feld – Vergleich – Wert. Ohne Bedingung läuft der Workflow bei jedem Auslöser.">
        {cond && cond.rules.length > 1 && (
          <FieldWrap label="Verknüpfung" htmlFor="g-comb">
            <Select id="g-comb" value={cond.combinator} disabled={readOnly} onChange={(e) => set({ ...m, condition: { ...cond, combinator: e.target.value as 'and' | 'or' } })}>
              <option value="and">Alle Bedingungen müssen zutreffen</option>
              <option value="or">Eine Bedingung genügt</option>
            </Select>
          </FieldWrap>
        )}
        {(cond?.rules ?? []).map((r, i) => (
          <RuleRow key={i} r={r} fields={fieldOpts} ops={cat.operators} idp={`g-r-${i}`} disabled={readOnly} onChange={(x) => setRules(cond!.rules.map((y, j) => (j === i ? x : y)))} onRemove={() => setRules(cond!.rules.filter((_, j) => j !== i))} />
        ))}
        {cond && (errors[cond.id] ?? []).map((e, i) => (
          <p key={i} className="m-0 text-meta text-err">{e}</p>
        ))}
        {!cond && <p className="m-0 text-sm text-fg-muted">Keine Bedingung – jeder Auslöser führt zu den Aktionen.</p>}
        {!readOnly && (
          <Button size="sm" icon="Plus" className="self-start" disabled={(cond?.rules.length ?? 0) >= 20} onClick={() => setRules([...(cond?.rules ?? []), { field: fieldOpts.find((f) => f.key === 'stichwort')?.key ?? fieldOpts[0]?.key ?? 'stichwort', op: 'eq', value: '' }])}>
            Bedingung hinzufügen
          </Button>
        )}
      </Step>

      <Step n={3} title="Dann" hint="Was soll passieren? Banner und Beiträge entstehen als Entwurf bzw. gehen zur Freigabe – veröffentlicht wird nach menschlicher Freigabe.">
        {m.outputs.map((x) => {
          const kinds = wantKinds(x.data);
          const opts = outputs.filter((o) => !kinds.length || kinds.includes(o.kind) || o.id === x.data.outputId);
          const sel = outputs.find((o) => o.id === x.data.outputId);
          return (
            <Slot
              key={x.id}
              idp={`g-out-${x.id}`}
              type="output"
              data={x.data}
              options={opts.map((o) => ({ value: o.id, label: `${o.name} (${outKind(o.kind)?.label ?? o.kind})` }))}
              kindLabel={kinds.map((k) => outKind(k)?.label ?? k).join(' oder ')}
              summary={sel ? outputSummary(sel, cat) : undefined}
              errors={errors[x.id] ?? []}
              readOnly={readOnly}
              onPick={(id) => pick('outputs', x.id, id)}
              onCreate={() => onCreate({ type: 'output', kinds, preset: x.data.want }, (id) => pick('outputs', x.id, id))}
              onRemove={() => set({ ...m, outputs: m.outputs.filter((y) => y.id !== x.id) })}
            />
          );
        })}
        {m.outputs.length === 0 && <p className="m-0 text-sm text-fg-muted">Noch keine Aktion.</p>}
        {!readOnly && (
          <Button size="sm" icon="Plus" className="self-start" onClick={() => set({ ...m, outputs: [...m.outputs, { id: newId('n'), data: {} }] })}>
            {m.outputs.length ? 'Weitere Aktion' : 'Aktion wählen'}
          </Button>
        )}
      </Step>
    </div>
  );
}

/** Platz-Hinweis entfernen, sobald ein Auslöser oder Aktion gewählt ist. */
function withoutWant(d: Record<string, any>) {
  const { want: _w, ...rest } = d;
  return rest;
}

/** „Vor dem Aktivieren“: was noch fehlt. */
export function ActivationChecklist(props: ChecklistInput) {
  const items = activationChecklist(props);
  const open = items.filter((x) => x.state === 'todo').length;
  return (
    <Card title="Vor dem Aktivieren" subtitle={open ? `Noch ${open} ${open === 1 ? 'Punkt' : 'Punkte'} offen.` : 'Alles bereit zum Aktivieren.'}>
      <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="Checkliste vor dem Aktivieren">
        {items.map((x) => (
          <li key={x.id} className="flex items-start gap-2 text-sm">
            <Icon name={x.state === 'ok' ? 'CheckCircle2' : x.state === 'info' ? 'Info' : 'CircleDashed'} size={16} className={cx('mt-0.5 shrink-0', x.state === 'ok' ? 'text-ok' : x.state === 'info' ? 'text-fg-muted' : 'text-warn')} />
            <span className="flex flex-col">
              <span>
                {x.label}
                <span className="sr-only">{x.state === 'ok' ? ' – erledigt' : x.state === 'todo' ? ' – offen' : ''}</span>
              </span>
              {x.hint && <span className="text-meta text-fg-muted">{x.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
