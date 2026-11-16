import { useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Badge, Chip, cx, FieldWrap, Input, Select, Textarea, type Tone } from '../../components/ui/core';
import { HelpTip } from '../../components/ui/HelpTip';

/* Gemeinsame Typen und Bausteine der Automationen (Eingänge, Ausgänge, Editor). */

export interface FieldDef {
  key: string;
  label: string;
  type: string;
  example: string;
  options?: string[];
}

export interface Catalog {
  enabled: boolean;
  maxRunsPerMinute: number;
  inputKinds: { kind: string; label: string; description: string; icon: string; source?: string; connectionKind?: string; phases?: { value: string; label: string }[]; fields: FieldDef[] }[];
  outputKinds: { kind: string; label: string; description: string; icon: string; directCapable: boolean; produces: FieldDef[] }[];
  nodeTypes: { type: string; label: string; category: 'input' | 'process' | 'output'; description: string; icon: string }[];
  operators: Record<string, string>;
  limits: { maxNodes: number; maxEdges: number; maxDelayMinutes: number; maxDedupMinutes: number; maxApprovalHours: number; minIntervalMinutes: number; maxCases: number };
  roles: { id: string; label: string }[];
  connections: { id: string; kind: string; name: string; status: string }[];
  feeds: { id: string; title: string }[];
  collections: { id: string; title: string }[];
  sites: { id: string; name: string; status: string }[];
  responsibilities: { id: string; name: string; area: string }[];
  warningFields: { key: string; label: string; required: boolean }[];
  users: { id: string; name: string }[];
}

export interface InputDef {
  id: string;
  name: string;
  kind: string;
  config: Record<string, any>;
  fields: FieldDef[];
  used_by: { id: string; name: string }[];
  updated_at: string;
  updated_by_name: string | null;
}

export interface OutputDef {
  id: string;
  name: string;
  kind: string;
  config: Record<string, any>;
  needs: string[];
  used_by: { id: string; name: string }[];
  updated_at: string;
  updated_by_name: string | null;
}

/** Feldname normalisieren (beim Verlassen des Feldes): Kleinbuchstaben, Ziffern, _; beginnt mit Buchstaben. */
export function normKey(v: string): string {
  const k = v
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 40);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 40);
}

export function useCatalog() {
  return useQuery({ queryKey: ['automation-catalog'], queryFn: () => get<Catalog>('/automations/catalog'), staleTime: 30_000 });
}
export function useInputs() {
  return useQuery({ queryKey: ['automation-inputs'], queryFn: () => get<InputDef[]>('/automation-inputs') });
}
export function useOutputs() {
  return useQuery({ queryKey: ['automation-outputs'], queryFn: () => get<OutputDef[]>('/automation-outputs') });
}

export const RUN_STATUS: Record<string, { tone: Tone; label: string; pulse?: boolean }> = {
  queued: { tone: 'neutral', label: 'Wartet', pulse: true },
  running: { tone: 'primary', label: 'Läuft', pulse: true },
  waiting: { tone: 'warning', label: 'Hält an (Warten/Freigabe)' },
  succeeded: { tone: 'success', label: 'Erfolgreich' },
  failed: { tone: 'error', label: 'Fehlgeschlagen' },
  canceled: { tone: 'neutral', label: 'Abgebrochen' },
  limited: { tone: 'warning', label: 'Verworfen (Grenze)' },
};
export const STEP_STATUS: Record<string, { tone: Tone; label: string }> = {
  done: { tone: 'success', label: 'Erledigt' },
  skipped: { tone: 'neutral', label: 'Nicht erreicht' },
  waiting: { tone: 'warning', label: 'Wartet' },
  running: { tone: 'primary', label: 'Läuft' },
  failed: { tone: 'error', label: 'Fehler' },
  unknown: { tone: 'warning', label: 'Ergebnis unbekannt' },
};
export const TRIGGER_LABEL: Record<string, string> = { event: 'Ereignis', schedule: 'Zeitplan', manual: 'Von Hand', test: 'Testlauf' };

export function RunBadge({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return (
    <Badge tone={s.tone} pulse={s.pulse}>
      {s.label}
    </Badge>
  );
}

export const AUTOMATION_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Entwurf' },
  active: { tone: 'success', label: 'Aktiv' },
  disabled: { tone: 'neutral', label: 'Deaktiviert' },
};

export function AutomationBadge({ status }: { status: string }) {
  const s = AUTOMATION_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Kennzeichnung „Darf direkt veröffentlichen“ – immer mit Text. */
export function DirectBadge({ title }: { title?: string }) {
  return (
    <Badge tone="warning" title={title ?? 'Markierte Ausgänge veröffentlichen bzw. versenden ohne menschliche Freigabe.'}>
      Direktversand
    </Badge>
  );
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Kurzbeschreibung der Einstellungen eines Eingangs. */
export function inputSummary(i: Pick<InputDef, 'kind' | 'config'>, cat?: Catalog): string {
  const c = i.config ?? {};
  const kind = cat?.inputKinds.find((k) => k.kind === i.kind);
  const phases = (c.phases ?? []).map((p: string) => kind?.phases?.find((x) => x.value === p)?.label ?? p).join(', ');
  switch (i.kind) {
    case 'fe2':
    case 'feuersoftware':
    case 'warnfeed':
      return `${cat?.connections.find((x) => x.id === c.connectionId)?.name ?? 'Verbindung'} · ${phases}${i.kind === 'warnfeed' && c.onlyInArea !== false ? ' · nur eigenes Gebiet' : ''}`;
    case 'rss':
      return c.feedId ? (cat?.feeds.find((f) => f.id === c.feedId)?.title ?? 'Quelle') : 'Alle Quellen';
    case 'upload':
      return `${c.collectionId ? (cat?.collections.find((x) => x.id === c.collectionId)?.title ?? 'Sammlung') : 'Alle Sammlungen'} · gebündelt je ${c.windowMinutes ?? 30} min`;
    case 'schedule':
      return c.mode === 'interval' ? `alle ${c.minutes} Minuten` : `täglich ${c.time} Uhr${c.weekdays?.length ? ` (${c.weekdays.map((d: number) => WEEKDAYS[d - 1]).join(', ')})` : ''}`;
    case 'manual':
      return c.fields?.length ? `Felder: ${c.fields.map((f: any) => f.label).join(', ')}` : 'ohne eigene Felder';
    default:
      return '';
  }
}

export function outputSummary(o: Pick<OutputDef, 'kind' | 'config'>, cat?: Catalog): string {
  const c = o.config ?? {};
  const tone: Record<string, string> = { info: 'Hinweis', warning: 'Warnung', danger: 'Gefahr', auto: 'nach Stufe' };
  const roles = (ids: string[] = []) => ids.map((r) => cat?.roles.find((x) => x.id === r)?.label ?? r).join(', ');
  switch (o.kind) {
    case 'banner':
      return `${tone[c.tone] ?? c.tone} · Priorität ${c.priority ?? 2} · ${(c.siteIds ?? []).map((s: string) => cat?.sites.find((x) => x.id === s)?.name ?? 'Website').join(', ')}`;
    case 'post':
      return `${c.submit ? 'zur Freigabe einreichen' : 'als Entwurf'}${c.siteId ? ` · ${cat?.sites.find((x) => x.id === c.siteId)?.name ?? 'Website'}` : ''}`;
    case 'mail':
      return [roles(c.roles), (c.responsibilityIds ?? []).map((r: string) => cat?.responsibilities.find((x) => x.id === r)?.name ?? 'Zuständigkeit').join(', ')].filter(Boolean).join(' · ');
    case 'notify':
      return [roles(c.roles), c.userIds?.length ? `${c.userIds.length} Person(en)` : ''].filter(Boolean).join(' · ');
    case 'warning_draft':
      return `${Object.keys(c.data ?? {}).length} vorausgefüllte Felder`;
    default:
      return '';
  }
}

/**
 * Textvorlage mit {{platzhaltern}}: Feld einfügen an der Cursorposition. Werte werden beim Lauf nur als Text eingesetzt –
 * keine Ausdrücke, kein Code.
 */
export function TemplateField({ id, label, value, onChange, fields, rows = 1, max, help, required, disabled }: { id: string; label: ReactNode; value: string; onChange: (v: string) => void; fields: { key: string; label: string }[]; rows?: number; max?: number; help?: ReactNode; required?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (key: string) => {
    if (!key) return;
    const el = ref.current;
    const token = `{{${key}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(max ? next.slice(0, max) : next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const unknown = [...value.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g)].map((m) => m[1]).filter((k) => fields.length && !fields.some((f) => f.key === k));
  return (
    <FieldWrap
      label={label}
      htmlFor={id}
      required={required}
      help={unknown.length ? undefined : help}
      error={unknown.length ? `Unbekannte Felder: ${[...new Set(unknown)].join(', ')}` : null}
      labelAction={
        fields.length > 0 && !disabled ? (
          <select aria-label={`Feld in „${typeof label === 'string' ? label : id}“ einfügen`} className="h-7 text-meta bg-bg border border-line rounded-chip px-1.5 max-w-[150px]" value="" onChange={(e) => insert(e.target.value)}>
            <option value="">Feld einfügen …</option>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label} ({f.key})
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      {rows > 1 ? (
        <Textarea ref={ref} id={id} rows={rows} value={value} maxLength={max} disabled={disabled} invalid={unknown.length > 0} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input ref={ref} id={id} value={value} maxLength={max} disabled={disabled} invalid={unknown.length > 0} onChange={(e) => onChange(e.target.value)} />
      )}
    </FieldWrap>
  );
}

/** Mehrfachauswahl als Kästchenliste (Rollen, Zuständigkeiten, Websites, Wochentage). */
export function CheckList<T extends string | number>({ legend, options, value, onChange, disabled, columns = 2 }: { legend: ReactNode; options: { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void; disabled?: boolean; columns?: 1 | 2 | 4 | 7 }) {
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5 min-w-0">
      <legend className="text-sm font-medium mb-1.5">{legend}</legend>
      {options.length === 0 && <p className="m-0 text-meta text-fg-muted">Keine Einträge vorhanden.</p>}
      <div className={cx('grid gap-x-4 gap-y-1', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'sm:grid-cols-2' : columns === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-4 sm:grid-cols-7')}>
        {options.map((o) => (
          <label key={String(o.value)} className="flex items-center gap-2 text-sm min-h-[32px] cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary)]" disabled={disabled} checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Liste der Felder eines Eingangs (mit {{schlüssel}} zum Kopieren). */
export function FieldList({ fields }: { fields: FieldDef[] }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1">
      {fields.map((f) => (
        <li key={f.key} className="flex items-baseline justify-between gap-3 text-sm">
          <span>{f.label}</span>
          <Chip mono>{`{{${f.key}}}`}</Chip>
        </li>
      ))}
    </ul>
  );
}

export function NumberField({ id, label, value, onChange, min, max, unit, help, disabled }: { id: string; label: ReactNode; value: number; onChange: (v: number) => void; min: number; max: number; unit?: string; help?: ReactNode; disabled?: boolean }) {
  const invalid = !Number.isInteger(value) || value < min || value > max;
  return (
    <FieldWrap label={label} htmlFor={id} help={help ?? `${min} bis ${max}${unit ? ` ${unit}` : ''}`} error={invalid ? `Bitte eine ganze Zahl von ${min} bis ${max}.` : null}>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={Number.isFinite(value) ? value : ''} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className="max-w-[140px]" />
        {unit && <span className="text-sm text-fg-muted">{unit}</span>}
      </div>
    </FieldWrap>
  );
}

export function SelectField({ id, label, value, onChange, options, help, disabled, placeholder, labelAction }: { id: string; label: ReactNode; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; help?: ReactNode; disabled?: boolean; placeholder?: string; labelAction?: ReactNode }) {
  return (
    <FieldWrap label={label} htmlFor={id} help={help} labelAction={labelAction}>
      <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </FieldWrap>
  );
}

export function Help({ title, children, anchor }: { title: string; children: ReactNode; anchor?: string }) {
  return (
    <HelpTip title={title} more={`/hilfe/automationen${anchor ? `#${anchor}` : ''}`}>
      {children}
    </HelpTip>
  );
}
