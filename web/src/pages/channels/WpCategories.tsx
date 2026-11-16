import type { ReactNode } from 'react';
import type { WpCategory } from '../../api/types';
import { cx } from '../../components/ui/core';

/** Kategorien in Baumreihenfolge (Unterkategorien eingerückt unter ihrer Oberkategorie). */
function ordered(cats: WpCategory[]): { cat: WpCategory; depth: number }[] {
  const byParent = new Map<number, WpCategory[]>();
  const ids = new Set(cats.map((c) => c.id));
  for (const c of cats) {
    const p = c.parent && ids.has(c.parent) ? c.parent : 0;
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  const out: { cat: WpCategory; depth: number }[] = [];
  const walk = (parent: number, depth: number) => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      if (out.some((o) => o.cat.id === c.id)) continue;
      out.push({ cat: c, depth });
      if (depth < 6) walk(c.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

/**
 * Auswahl der WordPress-Kategorien einer Website (#186). Die Liste meldet die Bridge ab Version 0.8.0; ohne Auswahl gilt
 * die Standardkategorie aus den Bridge-Einstellungen.
 */
export function WpCategoryPicker({ categories, value, onChange, disabled, legend = 'Kategorie auf der Website', help }: { categories: WpCategory[] | null | undefined; value: number[]; onChange: (v: number[]) => void; disabled?: boolean; legend?: ReactNode; help?: ReactNode }) {
  const list = ordered(categories ?? []);
  // Gespeicherte Kategorien, die die Website (noch) nicht meldet, bleiben sichtbar und abwählbar
  const unknown = value.filter((id) => !list.some((o) => o.cat.id === id));
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5 min-w-0">
      <legend className="text-sm font-medium mb-1.5">{legend}</legend>
      {list.length === 0 && unknown.length === 0 && <p className="m-0 text-meta text-fg-muted">Die Website hat noch keine Kategorien gemeldet (ab BlaulichtCMS Bridge 0.8.0). Es gilt die Standardkategorie der Website.</p>}
      <div className="flex flex-col gap-y-0.5 max-h-[240px] overflow-y-auto">
        {list.map(({ cat, depth }) => (
          <label key={cat.id} className="flex items-center gap-2 text-sm min-h-[32px] cursor-pointer" style={{ paddingLeft: `${depth * 16}px` }}>
            <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary)]" disabled={disabled} checked={value.includes(cat.id)} onChange={(e) => onChange(e.target.checked ? [...value, cat.id].slice(0, 20) : value.filter((x) => x !== cat.id))} />
            <span>{cat.name}</span>
          </label>
        ))}
        {unknown.map((id) => (
          <label key={id} className={cx('flex items-center gap-2 text-sm min-h-[32px] cursor-pointer text-fg-muted')}>
            <input type="checkbox" className="w-4 h-4 accent-[var(--bc-primary)]" disabled={disabled} checked onChange={() => onChange(value.filter((x) => x !== id))} />
            <span>Kategorie {id} (auf der Website nicht mehr vorhanden)</span>
          </label>
        ))}
      </div>
      <p className="m-0 text-meta text-fg-muted">{help ?? 'Ohne Auswahl gilt die Standardkategorie aus den Bridge-Einstellungen der Website.'}</p>
    </fieldset>
  );
}
