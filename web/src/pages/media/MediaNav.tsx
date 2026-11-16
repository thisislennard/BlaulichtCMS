import { NavLink } from 'react-router';
import { cx } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { useAuth } from '../../lib/auth';

/** Bereichsnavigation „Medien“: Sammlungen, alle Dateien, Papierkorb und Verwaltung (je nach Recht). */
export function MediaNav() {
  const { can } = useAuth();
  const items = [
    { to: '/medien', label: 'Sammlungen', icon: 'Images', end: true, show: true },
    { to: '/medien/dateien', label: 'Alle Dateien', icon: 'Search', end: false, show: true },
    { to: '/medien/gestaltung', label: 'Gestaltung', icon: 'Palette', end: false, show: can('media.design') },
    { to: '/medien/papierkorb', label: 'Papierkorb', icon: 'Trash2', end: false, show: can('media.trash') },
    { to: '/medien/verwaltung', label: 'Verwaltung', icon: 'ShieldCheck', end: false, show: can('media.admin') },
  ].filter((i) => i.show);
  return (
    <nav aria-label="Medien" className="flex flex-wrap gap-1.5 -mt-1">
      {items.map((i) => (
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
