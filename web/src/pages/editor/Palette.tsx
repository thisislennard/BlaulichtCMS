import { forwardRef, useMemo, useState } from 'react';
import type { Catalog, Category, NodeTypeInfo } from '../../api/types';
import { cx, Kbd } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { CATEGORY_COLOR, CategoryDot } from '../../components/ui/data';
import { T } from './lib';

export const DND_TYPE = 'application/x-lifelink-node';

interface Props {
  catalog: Catalog;
  hasTrigger: boolean;
  onAdd: (info: NodeTypeInfo) => void;
}

/** Node-Palette: Einträge kommen vollständig aus dem Katalog (neue Integrationen erscheinen automatisch). */
export const Palette = forwardRef<HTMLInputElement, Props>(function Palette({ catalog, hasTrigger, onAdd }, searchRef) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ trigger: !hasTrigger, condition: true, data: false, action: true, control: false });
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog.categories.map((c) => ({
      ...c,
      items: catalog.nodes.filter((n) => n.category === c.id && (!needle || `${n.title} ${n.description} ${n.type}`.toLowerCase().includes(needle))),
    }));
  }, [catalog, q]);
  const searching = q.trim().length > 0;
  return (
    <aside aria-label={T('palette.aria')} className="w-palette shrink-0 border-r border-line bg-sidebar px-3 py-3.5 box-border flex flex-col gap-3 overflow-y-auto">
      <label className="flex items-center gap-2 h-ctl-sm px-2.5 rounded-control border border-line bg-bg text-fg-muted focus-within:border-primary focus-within:shadow-ring">
        <Icon name="Search" size={15} />
        <input ref={searchRef} type="search" aria-label={T('palette.search')} placeholder={T('palette.search')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), (e.target as HTMLInputElement).blur())} className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-fg focus-visible:!shadow-none" />
        <Kbd>/</Kbd>
      </label>
      {groups.map((g) => {
        const isOpen = searching ? g.items.length > 0 : !!open[g.id];
        if (searching && !g.items.length) return null;
        return (
          <div key={g.id} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))}
              className="flex items-center gap-2 h-[30px] px-1.5 rounded-chip text-meta font-semibold text-left hover:bg-raised"
            >
              <CategoryDot category={g.id as Category} />
              <span className="flex-1">{g.label}</span>
              <span className="text-meta font-normal text-fg-muted tabular">{g.items.length}</span>
              <Icon name="ChevronDown" size={14} className={cx('text-fg-muted transition-transform duration-fast', !isOpen && '-rotate-90')} />
            </button>
            {isOpen &&
              g.items.map((it) => {
                const blocked = it.category === 'trigger' && hasTrigger;
                return (
                  <button
                    key={it.type}
                    type="button"
                    draggable={!blocked}
                    disabled={blocked}
                    title={blocked ? T('palette.oneTrigger') : it.description}
                    aria-label={blocked ? `${it.title} – ${T('palette.oneTrigger')}` : T('palette.addAria', { name: it.title })}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DND_TYPE, it.type);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => onAdd(it)}
                    className={cx('flex items-center gap-2.5 h-8 px-2 rounded-[7px] text-sm text-left text-fg hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent', !blocked && 'cursor-grab active:cursor-grabbing')}
                  >
                    <span
                      aria-hidden="true"
                      className="w-[22px] h-[22px] rounded-chip inline-flex items-center justify-center shrink-0"
                      style={{ color: CATEGORY_COLOR[it.category], background: `color-mix(in srgb, ${CATEGORY_COLOR[it.category]} 16%, transparent)` }}
                    >
                      <Icon name={it.icon} size={13} />
                    </span>
                    <span className="truncate">{it.title}</span>
                  </button>
                );
              })}
            {isOpen && g.id === 'trigger' && hasTrigger && <p className="m-0 px-2 pt-1 text-meta text-fg-muted">{T('palette.oneTrigger')}</p>}
          </div>
        );
      })}
      {searching && groups.every((g) => !g.items.length) && <p className="m-0 px-1 text-sm text-fg-muted">{T('palette.noResults')}</p>}
      <p className="m-0 mt-auto px-1 text-meta text-fg-muted">{T('palette.hint')}</p>
    </aside>
  );
});
