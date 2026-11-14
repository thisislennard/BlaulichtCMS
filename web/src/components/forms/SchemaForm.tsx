import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import type { Catalog, Field } from '../../api/types';
import { Button, cx, FieldWrap, Input, Select, Switch, Textarea } from '../ui/core';
import { Icon } from '../ui/Icon';
import { SecretField } from '../ui/overlays';

/**
 * Rendert Felder aus einem Schema (configSchema eines Nodes bzw. credentialsSchema einer
 * Integration). Feldtypen siehe Design §9. `secret` wird immer als SecretField gerendert.
 */
export interface SchemaFormProps {
  fields: Field[];
  values: Record<string, any>;
  onChange: (values: Record<string, any>) => void;
  catalog?: Catalog | null;
  /** Fehlertexte je Feld */
  errors?: Record<string, string>;
  /** Für variableText-Felder: Knopf, der den Variablen-Picker öffnet und Text einfügt. */
  renderVariableButton?: (insert: (text: string) => void, fieldKey: string) => ReactNode;
  /** Zustand gespeicherter Geheimnisse: { feld: { set } } */
  secretState?: Record<string, { set: boolean }>;
  secretSavedAt?: string | null;
  /** WordPress-Verbindung für Zielseiten-Felder */
  wpConnectionId?: string | null;
  disabled?: boolean;
  /** Erweiterte Optionen anfangs geöffnet */
  advancedOpen?: boolean;
}

export function isVisible(f: Field, values: Record<string, any>) {
  if (!f.showIf) return true;
  const v = values[f.showIf.key];
  const eq = f.showIf.equals;
  if (Array.isArray(eq)) return eq.includes(v);
  if (Array.isArray(v)) return v.includes(eq);
  return v === eq;
}

/** Abhängige Standardwerte (TLS an → Port 8883 usw.) */
function applyDefaults(key: string, value: any, values: Record<string, any>): Record<string, any> {
  const next = { ...values, [key]: value };
  if (key === 'security' && (values.port == null || [465, 587, '465', '587', ''].includes(values.port))) next.port = value === 'tls' ? 465 : 587;
  if (key === 'tls' && (values.port == null || [1883, 8883, '1883', '8883', ''].includes(values.port))) next.port = value ? 8883 : 1883;
  return next;
}

export function SchemaForm(props: SchemaFormProps) {
  const { fields, values, onChange } = props;
  const [advanced, setAdvanced] = useState(!!props.advancedOpen);
  const visible = fields.filter((f) => isVisible(f, values));
  const main = visible.filter((f) => !f.advanced);
  const adv = visible.filter((f) => f.advanced);
  const set = (key: string, v: any) => onChange(applyDefaults(key, v, values));
  return (
    <div className="flex flex-col gap-4">
      {main.map((f) => (
        <FieldRenderer key={`${f.key}-${f.label}`} field={f} value={values[f.key]} onValue={(v) => set(f.key, v)} {...props} />
      ))}
      {adv.length > 0 && (
        <div className="border border-line rounded-node">
          <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} className="w-full flex items-center gap-2 px-3.5 h-11 text-sm text-left">
            <Icon name={advanced ? 'ChevronDown' : 'ChevronRight'} size={15} className="text-fg-muted" />
            <span className="font-medium">Erweiterte Optionen</span>
            <span className="text-meta text-fg-muted truncate">· {adv.map((f) => f.label).join(', ')}</span>
          </button>
          {advanced && (
            <div className="flex flex-col gap-4 px-3.5 pb-4 pt-1">
              {adv.map((f) => (
                <FieldRenderer key={`${f.key}-${f.label}`} field={f} value={values[f.key]} onValue={(v) => set(f.key, v)} {...props} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRenderer({ field: f, value, onValue, ...p }: SchemaFormProps & { field: Field; value: any; onValue: (v: any) => void }) {
  const id = useId();
  const err = p.errors?.[f.key];
  const v = value ?? f.default;
  const common = { label: f.label, help: f.help, required: f.required, error: err, htmlFor: id };
  switch (f.type) {
    case 'secret':
      return <SecretField id={id} label={f.label} set={!!p.secretState?.[f.key]?.set} savedAt={p.secretSavedAt} value={value ?? ''} onReplace={onValue} help={f.help} required={f.required} />;
    case 'switch':
      return <Switch checked={!!v} onChange={onValue} label={f.label} description={f.help} disabled={p.disabled} />;
    case 'select':
      return (
        <FieldWrap {...common}>
          <Select id={id} value={v ?? ''} onChange={(e) => onValue(e.target.value)} disabled={p.disabled} invalid={!!err}>
            {!f.required && v == null && <option value="">– bitte wählen –</option>}
            {(f.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {f.options?.find((o) => o.value === v)?.hint && <span className="text-meta text-fg-muted">{f.options.find((o) => o.value === v)!.hint}</span>}
        </FieldWrap>
      );
    case 'number':
    case 'port':
      return (
        <FieldWrap {...common}>
          <Input id={id} type="number" inputMode="numeric" min={f.min} max={f.max} value={v ?? ''} onChange={(e) => onValue(e.target.value === '' ? null : Number(e.target.value))} disabled={p.disabled} invalid={!!err} className="max-w-[220px] tabular" />
        </FieldWrap>
      );
    case 'duration':
      return (
        <FieldWrap {...common}>
          <div className="flex items-center gap-2">
            <Input id={id} type="number" min={0} value={v ?? ''} onChange={(e) => onValue(e.target.value === '' ? null : Number(e.target.value))} disabled={p.disabled} className="max-w-[140px] tabular" />
            <span className="text-sm text-fg-muted">{f.unit === 'seconds' ? 'Sekunden' : 'Minuten'}</span>
          </div>
        </FieldWrap>
      );
    case 'textarea':
      return (
        <FieldWrap {...common}>
          <Textarea id={id} value={v ?? ''} onChange={(e) => onValue(e.target.value)} placeholder={f.placeholder} disabled={p.disabled} invalid={!!err} />
        </FieldWrap>
      );
    case 'json': {
      let bad: string | null = null;
      if (typeof v === 'string' && v.trim()) {
        try {
          JSON.parse(v);
        } catch (e) {
          bad = 'Kein gültiges JSON.';
        }
      }
      return (
        <FieldWrap {...common} error={err ?? bad}>
          <Textarea id={id} mono rows={6} value={typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2)} onChange={(e) => onValue(e.target.value)} disabled={p.disabled} invalid={!!(err ?? bad)} spellCheck={false} />
        </FieldWrap>
      );
    }
    case 'variableText':
    case 'variableTextarea':
      return <VariableInput {...common} id={id} multiline={f.type === 'variableTextarea'} value={v ?? ''} onValue={onValue} placeholder={f.placeholder} disabled={p.disabled} renderVariableButton={p.renderVariableButton ? (ins) => p.renderVariableButton!(ins, f.key) : undefined} />;
    case 'color':
      return (
        <FieldWrap label={f.label} help={f.help} error={err}>
          <div role="radiogroup" aria-label={f.label} className="flex gap-2.5 flex-wrap">
            {(f.options ?? []).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={v === o.value}
                aria-label={o.label}
                title={o.label}
                onClick={() => onValue(o.value)}
                className="w-7 h-7 rounded-full transition-shadow duration-fast"
                style={{ background: o.hint, boxShadow: v === o.value ? `0 0 0 2px var(--ll-card), 0 0 0 4px ${o.hint}` : undefined }}
              />
            ))}
          </div>
        </FieldWrap>
      );
    case 'multiselect':
      return (
        <FieldWrap label={f.label} help={f.help} error={err}>
          <ChipChoice options={f.options ?? []} value={Array.isArray(v) ? v : []} onChange={onValue} label={f.label} />
        </FieldWrap>
      );
    case 'wpPages':
      return <WpPagesField label={f.label} help={f.help} error={err} value={Array.isArray(v) ? v : ['front']} onChange={onValue} connectionId={p.wpConnectionId} />;
    case 'list':
      return <ListField {...common} id={id} value={Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []} onChange={onValue} placeholder={f.placeholder} />;
    case 'keyvalue':
    case 'mappings':
      return <RowsField label={f.label} help={f.help} error={err} rows={Array.isArray(v) ? v : []} onChange={onValue} keyLabel={f.type === 'mappings' ? 'Feldname' : 'Name'} valueLabel="Wert" renderVariableButton={p.renderVariableButton ? (ins) => p.renderVariableButton!(ins, f.key) : undefined} />;
    case 'conditions':
      return <ConditionsField label={f.label} error={err} rows={Array.isArray(v) ? v : []} onChange={onValue} operators={p.catalog?.operators ?? []} renderVariableButton={p.renderVariableButton ? (ins) => p.renderVariableButton!(ins, f.key) : undefined} />;
    case 'cases':
      return <CasesField label={f.label} help={f.help} rows={Array.isArray(v) ? v : []} onChange={onValue} />;
    case 'timezone': {
      const zones = (Intl as any).supportedValuesOf?.('timeZone') ?? ['Europe/Berlin', 'UTC'];
      return (
        <FieldWrap {...common}>
          <Select id={id} value={v ?? ''} onChange={(e) => onValue(e.target.value || null)}>
            <option value="">Zeitzone der Instanz</option>
            {zones.map((z: string) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </FieldWrap>
      );
    }
    case 'cron':
    case 'url':
    case 'host':
    case 'text':
    default:
      return (
        <FieldWrap {...common}>
          <Input id={id} type={f.type === 'url' ? 'url' : 'text'} mono={f.type === 'cron' || f.type === 'host'} value={v ?? ''} onChange={(e) => onValue(e.target.value)} placeholder={f.placeholder} disabled={p.disabled} invalid={!!err} autoComplete="off" spellCheck={false} />
        </FieldWrap>
      );
  }
}

/* -------------------------------------- Teilfelder ------------------------------------- */

export function VariableInput({ id, label, help, error, required, multiline, value, onValue, placeholder, disabled, renderVariableButton, compact }: { id?: string; label?: string; help?: string; error?: string; required?: boolean; multiline?: boolean; value: string; onValue: (v: string) => void; placeholder?: string; disabled?: boolean; renderVariableButton?: (insert: (text: string) => void) => ReactNode; compact?: boolean; htmlFor?: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onValue(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };
  const btn = renderVariableButton?.(insert);
  const input = multiline ? (
    <Textarea ref={ref} id={id} rows={4} value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder} disabled={disabled} invalid={!!error} spellCheck={false} className="pr-11" />
  ) : (
    <Input ref={ref} id={id} value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder} disabled={disabled} invalid={!!error} spellCheck={false} autoComplete="off" className={cx(!!btn && 'pr-11')} />
  );
  const body = (
    <div className="relative">
      {input}
      {btn && <div className={cx('absolute right-1.5', multiline ? 'top-1.5' : 'top-1/2 -translate-y-1/2')}>{btn}</div>}
    </div>
  );
  if (compact) return body;
  return (
    <FieldWrap label={label} help={help} error={error} required={required} htmlFor={id}>
      {body}
    </FieldWrap>
  );
}

export function ChipChoice({ options, value, onChange, label }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex gap-2 flex-wrap">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <label key={o.value} className={cx('inline-flex items-center gap-2 h-8 px-3 rounded-control border text-sm cursor-pointer select-none', on ? 'border-primary bg-primary-soft' : 'border-line hover:bg-raised')}>
            <input type="checkbox" className="sr-only" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])} />
            {on && <Icon name="Check" size={13} className="text-fg-link" />}
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

export function WpPagesField({ label, help, error, value, onChange, connectionId }: { label: string; help?: string; error?: string; value: string[]; onChange: (v: string[]) => void; connectionId?: string | null }) {
  const pages = useQuery({ queryKey: ['wp-pages', connectionId], queryFn: () => get(`/connections/${connectionId}/wp-pages`), enabled: !!connectionId, staleTime: 300_000 });
  const opts: { value: string; label: string }[] = (pages.data?.pages ?? [{ id: 'front', label: 'Startseite' }, { id: 'all', label: 'Alle Seiten' }]).map((p: any) => ({ value: p.id, label: p.label }));
  for (const v of value) if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: v });
  return (
    <FieldWrap label={label} help={!connectionId ? 'Zuerst eine WordPress-Verbindung wählen, dann erscheinen die Seiten der Website.' : pages.data && !pages.data.online ? `Website gerade nicht erreichbar (${pages.data.error}). Gespeicherte Auswahl bleibt erhalten.` : help} error={error}>
      <ChipChoice options={opts} value={value} onChange={onChange} label={label} />
    </FieldWrap>
  );
}

function ListField({ id, label, help, error, required, value, onChange, placeholder }: { id: string; label: string; help?: string; error?: string; required?: boolean; value: string[]; onChange: (v: string[]) => void; placeholder?: string; htmlFor?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const items = draft
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) onChange([...value, ...items.filter((i) => !value.includes(i))]);
    setDraft('');
  };
  return (
    <FieldWrap label={label} help={help} error={error} required={required} htmlFor={id}>
      {value.length > 0 && (
        <ul className="list-none m-0 p-0 flex gap-1.5 flex-wrap">
          {value.map((x) => (
            <li key={x} className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-chip bg-raised text-sm font-mono">
              {x}
              <button type="button" aria-label={`${x} entfernen`} onClick={() => onChange(value.filter((y) => y !== x))} className="w-5 h-5 inline-flex items-center justify-center rounded text-fg-muted hover:text-fg">
                <Icon name="X" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          placeholder={placeholder ?? 'Eintrag hinzufügen und Enter drücken'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <Button icon="Plus" iconOnly aria-label="Hinzufügen" onClick={add} />
      </div>
    </FieldWrap>
  );
}

function RowsField({ label, help, error, rows, onChange, keyLabel, valueLabel, renderVariableButton }: { label: string; help?: string; error?: string; rows: { key: string; value: string }[]; onChange: (v: any[]) => void; keyLabel: string; valueLabel: string; renderVariableButton?: (insert: (t: string) => void) => ReactNode }) {
  const update = (i: number, patch: Partial<{ key: string; value: string }>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <FieldWrap label={label} help={help} error={error}>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(90px,0.7fr)_1.3fr_auto] gap-2 items-center">
            <Input aria-label={`${keyLabel} ${i + 1}`} value={r.key} placeholder={keyLabel} mono onChange={(e) => update(i, { key: e.target.value })} />
            <VariableInput compact value={r.value ?? ''} onValue={(v) => update(i, { value: v })} placeholder={valueLabel} renderVariableButton={renderVariableButton} />
            <Button iconOnly icon="Trash2" variant="ghost" aria-label={`Zeile ${i + 1} entfernen`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div>
          <Button size="sm" icon="Plus" onClick={() => onChange([...rows, { key: '', value: '' }])}>
            Zeile hinzufügen
          </Button>
        </div>
      </div>
    </FieldWrap>
  );
}

function ConditionsField({ label, error, rows, onChange, operators, renderVariableButton }: { label: string; error?: string; rows: { left: string; op: string; right?: string }[]; onChange: (v: any[]) => void; operators: { id: string; label: string; unary?: boolean }[]; renderVariableButton?: (insert: (t: string) => void) => ReactNode }) {
  const update = (i: number, patch: Record<string, string>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unary = useMemo(() => new Set(operators.filter((o) => o.unary).map((o) => o.id)), [operators]);
  return (
    <FieldWrap label={label} error={error}>
      <div className="flex flex-col gap-2.5">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-2 p-2.5 rounded-node border border-line bg-bg/40">
            <div className="flex items-center justify-between">
              <span className="text-meta text-fg-muted">Bedingung {i + 1}</span>
              <Button size="sm" iconOnly icon="Trash2" variant="ghost" aria-label={`Bedingung ${i + 1} entfernen`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
            </div>
            <VariableInput compact value={r.left ?? ''} onValue={(v) => update(i, { left: v })} placeholder="{{ trigger.feld }}" renderVariableButton={renderVariableButton} />
            <Select aria-label="Vergleich" value={r.op} onChange={(e) => update(i, { op: e.target.value })}>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
            {!unary.has(r.op) && <VariableInput compact value={r.right ?? ''} onValue={(v) => update(i, { right: v })} placeholder="Wert" renderVariableButton={renderVariableButton} />}
          </div>
        ))}
        <div>
          <Button size="sm" icon="Plus" onClick={() => onChange([...rows, { left: '', op: 'eq', right: '' }])}>
            Bedingung hinzufügen
          </Button>
        </div>
      </div>
    </FieldWrap>
  );
}

function CasesField({ label, help, rows, onChange }: { label: string; help?: string; rows: { id: string; label: string; match: string }[]; onChange: (v: any[]) => void }) {
  const update = (i: number, patch: Record<string, string>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <FieldWrap label={label} help={help}>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={r.id} className="grid grid-cols-[0.8fr_1.2fr_auto] gap-2">
            <Input aria-label={`Name Fall ${i + 1}`} value={r.label} placeholder="Name (Ausgang)" onChange={(e) => update(i, { label: e.target.value })} />
            <Input aria-label={`Werte Fall ${i + 1}`} value={r.match} placeholder="B, B1, B2" onChange={(e) => update(i, { match: e.target.value })} />
            <Button iconOnly icon="Trash2" variant="ghost" aria-label={`Fall ${i + 1} entfernen`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div>
          <Button size="sm" icon="Plus" onClick={() => onChange([...rows, { id: `c${Date.now().toString(36)}`, label: `Fall ${rows.length + 1}`, match: '' }])}>
            Fall hinzufügen
          </Button>
        </div>
      </div>
    </FieldWrap>
  );
}

/** Lädt den Katalog (Nodes, Integrationen, Operatoren) einmal pro Sitzung. */
export function useCatalog() {
  return useQuery<Catalog>({ queryKey: ['catalog'], queryFn: () => get('/catalog'), staleTime: Infinity });
}
