import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { plural } from '../../lib/format';
import { useIsPhone } from '../../lib/media';
import { Button, cx, FieldWrap, Input, SegmentedControl, Select, Table, Td, Th } from './core';
import { Icon } from './Icon';

/* ------------------------------------------------------------------------------------------------------------------
 * Listen (#260, #264): eine Werkzeugleiste für alle Listenseiten und Tabellen, die am Handy zu Karten werden.
 * Zustand der Werkzeugleiste in der Adresse: `useListState` (lib/listState.ts). Regeln: docs/design-leitstand.md §6.
 * ------------------------------------------------------------------------------------------------------------------ */

export interface ToolbarTab<T extends string = string> {
  value: T;
  label: string;
  count?: number;
}

export interface ToolbarFilter {
  key: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Auswahlfeld (Standard) mit „Alle“ als leerem Wert; `date` = Datumsfeld, `text` = freies Feld */
  type?: 'select' | 'date' | 'text';
  options?: { value: string; label: string }[];
  /** Beschriftung des leeren Werts im Auswahlfeld (Standard „Alle“) */
  allLabel?: string;
  placeholder?: string;
}

/**
 * Suchfeld der Werkzeugleiste. Hält den getippten Text selbst (kein Springen des Cursors, wenn die Adresse erst nach
 * dem Tastendruck nachzieht) und übernimmt Änderungen von außen (Zurück, „Zurücksetzen“, Link aus der Suche), solange
 * das Feld nicht bearbeitet wird.
 */
export function ListSearch({ value, onChange, placeholder, label, id, className }: { value: string; onChange: (v: string) => void; placeholder: string; label?: string; id?: string; className?: string }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(value);
  }, [value]);
  return (
    <div role="search" className={cx('relative w-full sm:w-72', className)}>
      <Icon name="Search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
      <Input
        ref={ref}
        id={id}
        type="search"
        aria-label={label ?? placeholder}
        placeholder={placeholder}
        value={text}
        maxLength={100}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        className="pl-9"
      />
    </div>
  );
}

/** Reiter einer Liste: als Segmente; am Handy ab vier Reitern als Auswahlfeld „Filter: Offen ▾“ (kein Überlaufen). */
export function ListTabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: ToolbarTab<T>[]; label: string }) {
  const phone = useIsPhone();
  const id = useId();
  if (phone && options.length > 3)
    return (
      <div className="flex items-center gap-2 w-full">
        <label htmlFor={id} className="text-sm font-medium text-fg-muted shrink-0">
          {label}
        </label>
        <div className="flex-1 min-w-0">
          <Select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
                {o.count != null ? ` (${o.count})` : ''}
              </option>
            ))}
          </Select>
        </div>
      </div>
    );
  return <SegmentedControl<T> label={label} value={value} onChange={onChange} options={options} />;
}

/**
 * Werkzeugleiste aller Listenseiten: Suche links („Suchen in …“), Reiter, Knopf „Filter“ (weitere Kriterien,
 * gesetzte als Chips), Trefferzahl rechts. Alle Teile sind optional; `children` nimmt weitere Bedienelemente auf
 * (z. B. Ansicht Kacheln/Liste), `actions` steht rechts neben der Trefferzahl.
 */
export function ListToolbar<T extends string>({
  search,
  tabs,
  filters = [],
  count,
  onReset,
  children,
  actions,
  label = 'Liste filtern',
}: {
  search?: { value: string; onChange: (v: string) => void; placeholder: string; label?: string };
  tabs?: { value: T; onChange: (v: T) => void; options: ToolbarTab<T>[]; label: string };
  filters?: ToolbarFilter[];
  /** Trefferzahl, z. B. `{ n: 12, one: 'Beitrag', many: 'Beiträge' }` */
  count?: { n: number; one: string; many: string; total?: number };
  /** „Zurücksetzen“ – erscheint, sobald Suche oder Filter gesetzt sind */
  onReset?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  label?: string;
}) {
  const panelId = useId();
  const active = filters.filter((f) => f.value !== '');
  const [open, setOpen] = useState(false);
  const filtered = active.length > 0 || !!search?.value.trim();
  const shownLabel = (f: ToolbarFilter) => (f.type === 'date' ? new Date(`${f.value}T00:00:00`).toLocaleDateString('de-DE') : (f.options?.find((o) => o.value === f.value)?.label ?? f.value));
  return (
    <div className="flex flex-col gap-2.5" aria-label={label} role="group">
      <div className="flex flex-wrap items-center gap-2">
        {search && <ListSearch {...search} />}
        {tabs && <ListTabs {...tabs} />}
        {filters.length > 0 && (
          <Button icon="ListFilter" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
            Filter
            {active.length > 0 && <span className="min-w-[18px] h-[18px] px-[5px] rounded-full bg-raised text-[11px] font-mono inline-flex items-center justify-center">{active.length}</span>}
          </Button>
        )}
        {children}
        {(count || actions) && (
          <div className="ml-auto flex items-center gap-2">
            {count && (
              <span role="status" className="text-meta text-fg-muted whitespace-nowrap tabular">
                {count.total != null && count.total !== count.n ? `${count.n} von ${plural(count.total, count.one, count.many)}` : plural(count.n, count.one, count.many)}
              </span>
            )}
            {actions}
          </div>
        )}
      </div>
      {filters.length > 0 && open && (
        <div id={panelId} className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 items-end rounded-node border border-line bg-card p-3">
          {filters.map((f) => (
            <FilterField key={f.key} f={f} />
          ))}
        </div>
      )}
      {(active.length > 0 || (filtered && onReset)) && (
        <div className="flex flex-wrap items-center gap-2">
          {active.map((f) => (
            <span key={f.key} className="inline-flex items-center gap-1 h-7 max-md:h-10 pl-2.5 pr-1 rounded-chip bg-raised text-meta text-fg">
              <span className="text-fg-muted">{f.label}:</span> {shownLabel(f)}
              <button type="button" aria-label={`Filter „${f.label}“ entfernen`} onClick={() => f.onChange('')} className="w-6 h-6 max-md:w-9 max-md:h-9 inline-flex items-center justify-center rounded-chip text-fg-muted hover:text-fg hover:bg-card">
                <Icon name="X" size={13} />
              </button>
            </span>
          ))}
          {filtered && onReset && (
            <Button size="sm" variant="ghost" icon="RotateCcw" onClick={onReset}>
              Zurücksetzen
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterField({ f }: { f: ToolbarFilter }) {
  const id = useId();
  return (
    <FieldWrap label={f.label} htmlFor={id}>
      {f.type === 'date' || f.type === 'text' ? (
        <Input id={id} type={f.type} value={f.value} placeholder={f.placeholder} onChange={(e) => f.onChange(e.target.value)} />
      ) : (
        <Select id={id} value={f.value} onChange={(e) => f.onChange(e.target.value)}>
          <option value="">{f.allLabel ?? 'Alle'}</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </FieldWrap>
  );
}

/** Gefilterte Liste ohne Treffer (#266): eine leise Zeile mit „Filter zurücksetzen“. */
export function FilterEmpty({ onReset, text = 'Kein Eintrag passt zum Filter.' }: { onReset?: () => void; text?: ReactNode }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4 text-sm text-fg-muted">
      <span>{text}</span>
      {onReset && (
        <Button size="sm" icon="RotateCcw" onClick={onReset}>
          Filter zurücksetzen
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------- Tabelle / Karten --------------------------------------------- */

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Klassen für Kopf- und Datenzelle der Tabelle */
  className?: string;
  align?: 'right';
  /** Tabelle: Spalte erst ab dieser Breite zeigen (schmale Laptops) */
  from?: 'lg' | 'xl';
  /**
   * Rolle in der Karte am Handy: `title` (Kopf; der erste Link darin macht die ganze Karte antippbar), `status`
   * (rechts neben dem Titel), `meta` (leise Zeile unter dem Titel), `field` (Beschriftung + Wert, Standard),
   * `footer` (unten, z. B. Aktionen), `hide` (nur in der Tabelle).
   */
  card?: 'title' | 'status' | 'meta' | 'field' | 'footer' | 'hide';
  /** `false`: nur in der Karte (z. B. zusammengefasste Meta-Zeile) */
  table?: false;
  /** Beschriftung in der Karte, falls `header` kein Text ist */
  cardLabel?: string;
}

/**
 * Tabelle ab 768 px, darunter Karten (#264) – alle Kernangaben ohne waagerechtes Scrollen. Die Spalten beschreiben
 * beides: `cell` liefert den Inhalt, `card` die Rolle in der Karte.
 */
export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  rowId,
  rowClassName,
  onRowClick,
  label,
  className,
  dense,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** `id` der Zeile bzw. Karte (Verweise auf einen Eintrag, `useLinkedItem`) */
  rowId?: (row: T) => string | undefined;
  rowClassName?: (row: T) => string | false | undefined;
  /** ganze Zeile anklickbar (Tabelle); in der Karte übernimmt das der Link im Titel */
  onRowClick?: (row: T) => void;
  /** Name der Liste für Bildschirmleser (Karten) */
  label: string;
  className?: string;
  /** engere Zeilen (lange Listen wie die Einsatzliste: eine Zeile ≤ 52 px) */
  dense?: boolean;
}) {
  const phone = useIsPhone();
  if (phone) {
    const by = (role: Column<T>['card']) => columns.filter((c) => (c.card ?? 'field') === role);
    return (
      <ul aria-label={label} className={cx('m-0 p-0 list-none flex flex-col gap-2', className)}>
        {rows.map((r) => (
          <li key={rowKey(r)} id={rowId?.(r)} className={cx('bc-list-card bg-card border border-line rounded-card p-3.5 flex flex-col gap-2 min-w-0', rowClassName?.(r))}>
            <div className="flex items-start justify-between gap-3 min-w-0">
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                {by('title').map((c) => (
                  <div key={c.key} className="bc-card-title font-medium min-w-0 break-words">
                    {c.cell(r)}
                  </div>
                ))}
                {by('meta').map((c) => (
                  <div key={c.key} className="text-meta text-fg-muted min-w-0 break-words">
                    {c.cell(r)}
                  </div>
                ))}
              </div>
              {by('status').map((c) => (
                <div key={c.key} className="shrink-0">
                  {c.cell(r)}
                </div>
              ))}
            </div>
            {by('field').length > 0 && (
              <dl className="m-0 grid grid-cols-[minmax(84px,auto)_1fr] gap-x-3 gap-y-1 text-sm">
                {by('field').map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-fg-muted">{c.cardLabel ?? c.header}</dt>
                    <dd className="m-0 min-w-0 break-words">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {by('footer').map((c) => (
              <div key={c.key} className="flex flex-wrap gap-2">
                {c.cell(r)}
              </div>
            ))}
          </li>
        ))}
      </ul>
    );
  }
  const hide = (c: Column<T>) => (c.from === 'lg' ? 'hidden lg:table-cell' : c.from === 'xl' ? 'hidden xl:table-cell' : undefined);
  const cols = columns.filter((c) => c.table !== false);
  return (
    <Table className={className}>
      <thead>
        <tr>
          {cols.map((c) => (
            <Th key={c.key} align={c.align} className={cx(hide(c), c.className)}>
              {c.header}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={rowKey(r)} id={rowId?.(r)} className={cx(onRowClick && 'cursor-pointer hover:bg-raised', rowClassName?.(r))} onClick={onRowClick ? (e) => !(e.target as HTMLElement).closest('a, button, input, select, label') && onRowClick(r) : undefined}>
            {cols.map((c) => (
              <Td key={c.key} align={c.align} className={cx(hide(c), dense && '!py-2', c.className)}>
                {c.cell(r)}
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
