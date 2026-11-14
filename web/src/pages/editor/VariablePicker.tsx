import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Category } from '../../api/types';
import { cx } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { CategoryDot } from '../../components/ui/data';
import { T } from './lib';

export interface VarItem {
  /** Einzufügender Pfad, z. B. webhook.body.titel */
  insert: string;
  /** Anzeige (Pfad ohne Gruppenschlüssel) */
  key: string;
  type: string;
  value: string;
}
export interface VarGroup {
  id: string;
  label: string;
  category: Category;
  items: VarItem[];
}

interface Props {
  anchor: HTMLElement;
  panel: HTMLElement | null;
  groups: VarGroup[];
  filters: { name: string; args: string; description: string }[];
  source: string;
  onInsert: (text: string) => void;
  onClose: () => void;
}

const WIDTH = 330;

export function VariablePicker({ anchor, panel, groups, filters, source, onInsert, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number }>({ top: 0, left: 0, maxH: 420 });

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = panel?.getBoundingClientRect();
      let left = p ? p.left - WIDTH - 12 : a.left - WIDTH - 8;
      if (left < 8) left = Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8));
      const overlaps = left + WIDTH > a.left - 4 && left < a.right;
      const maxH = Math.min(440, window.innerHeight - 16);
      let top = overlaps ? a.bottom + 6 : a.top - 8;
      top = Math.max(8, Math.min(top, window.innerHeight - maxH - 8));
      setPos({ top, left, maxH });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, panel]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const gs = groups.map((g) => ({ ...g, items: g.items.filter((i) => !n || `${i.insert} ${i.value}`.toLowerCase().includes(n) || g.label.toLowerCase().includes(n)) })).filter((g) => g.items.length);
    const fs = filters.filter((f) => !n || `${f.name} ${f.description}`.toLowerCase().includes(n));
    return { gs, fs };
  }, [groups, filters, q]);

  const flat = useMemo(() => [...filtered.gs.flatMap((g) => g.items.map((i) => `{{ ${i.insert} }}`)), ...filtered.fs.map((f) => ` | ${f.name}`)], [filtered]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const pick = (text: string) => {
    onInsert(text);
    onClose();
  };

  let idx = -1;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={T('picker.aria')}
      className="fixed z-[85] bg-card border border-line rounded-card shadow-float flex flex-col overflow-hidden"
      style={{ top: pos.top, left: pos.left, width: Math.min(WIDTH, window.innerWidth - 16), maxHeight: pos.maxH }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          onClose();
          anchor.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(flat.length - 1, a + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === 'Enter' && flat[active]) {
          e.preventDefault();
          pick(flat[active]);
        }
      }}
    >
      <div className="p-2.5 border-b border-line">
        <label className="flex items-center gap-2 h-ctl-sm px-2.5 rounded-control border border-line bg-bg text-fg-muted focus-within:border-primary">
          <Icon name="Search" size={14} />
          <input
            autoFocus
            type="search"
            aria-label={T('picker.search')}
            placeholder={T('picker.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="ll-var-list"
            aria-activedescendant={flat.length ? `ll-var-${active}` : undefined}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-fg focus-visible:!shadow-none"
          />
        </label>
      </div>
      <div ref={listRef} id="ll-var-list" role="listbox" aria-label={T('picker.aria')} className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1">
        {!filtered.gs.length && !filtered.fs.length && <p className="m-0 px-2 py-4 text-sm text-fg-muted text-center">{T('picker.empty')}</p>}
        {filtered.gs.map((g) => (
          <div key={g.id} role="group" aria-label={g.label} className="flex flex-col">
            <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-muted">
              <CategoryDot category={g.category} size={7} />
              <span className="truncate">{g.label}</span>
            </div>
            {g.items.map((it) => {
              idx++;
              const i = idx;
              return (
                <button
                  key={it.insert}
                  id={`ll-var-${i}`}
                  data-idx={i}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(`{{ ${it.insert} }}`)}
                  className={cx('grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 px-2 py-1.5 rounded-chip text-left', i === active && 'bg-primary-soft')}
                >
                  <span className="font-mono text-meta text-fg truncate">{it.key}</span>
                  <span className="text-[11px] text-fg-muted whitespace-nowrap">{it.type}</span>
                  <span className="col-span-2 text-meta text-fg-muted truncate">{it.value || '–'}</span>
                </button>
              );
            })}
          </div>
        ))}
        {filtered.fs.length > 0 && (
          <div role="group" aria-label={T('picker.filters')} className="flex flex-col">
            <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-muted">
              <Icon name="Filter" size={11} />
              {T('picker.filters')}
            </div>
            {filtered.fs.map((f) => {
              idx++;
              const i = idx;
              return (
                <button
                  key={f.name}
                  id={`ll-var-${i}`}
                  data-idx={i}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(` | ${f.name}`)}
                  className={cx('flex flex-col px-2 py-1.5 rounded-chip text-left', i === active && 'bg-primary-soft')}
                >
                  <span className="font-mono text-meta text-fg">
                    | {f.name}
                    {f.args && <span className="text-fg-muted">:{f.args}</span>}
                  </span>
                  <span className="text-meta text-fg-muted">{f.description}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-line text-[11px] text-fg-muted">
        <span>{T('picker.footer')}</span>
        <span className="truncate">{source}</span>
      </div>
    </div>,
    document.body,
  );
}
