import { NavLink } from 'react-router';
import { cx } from '../ui/core';
import { Icon } from '../ui/Icon';

export interface PageTab {
  to: string;
  label: string;
  icon: string;
  /** nur exakt diese Adresse markieren (Startreiter) */
  end?: boolean;
}

/**
 * Reiter einer Seite mit eigener Adresse (z. B. Medien: Sammlungen | Alle Dateien | Papierkorb, Workflows: Workflows |
 * Auslöser | Aktionen). Statt einer dritten Menüebene (#250): jede Unterseite hat eine eigene Adresse und einen eigenen
 * Titel (`usePageMeta({ title })`), der Menüpunkt bleibt markiert. Reiter ohne Recht vorher herausfiltern.
 */
export function PageTabs({ label, tabs }: { label: string; tabs: PageTab[] }) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1.5 -mt-1">
      {tabs.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          className={({ isActive }) => cx('inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-sm no-underline !text-fg', isActive ? 'bg-raised font-semibold' : 'hover:bg-raised')}
        >
          {({ isActive }) => (
            <>
              <Icon name={i.icon} size={14} className={isActive ? 'text-primary-solid' : 'text-fg-muted'} />
              {i.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
