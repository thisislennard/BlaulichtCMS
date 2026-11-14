/**
 * Navigation als Registry (Design §3): Neue Module tragen sich hier ein, das Layout bleibt gleich.
 * `perm`: mindestens eines der Rechte nötig, sonst wird der Punkt ausgeblendet.
 */
export interface NavItem {
  id: string;
  path: string;
  label: string; // i18n-Schlüssel
  icon: string;
  perm?: string[];
  badge?: 'notifications' | 'approvals';
  adminOnly?: boolean;
}

export interface NavGroup {
  group: string; // i18n-Schlüssel
  items: NavItem[];
}

export const navigation: NavGroup[] = [
  {
    group: 'nav.overview',
    items: [
      { id: 'dashboard', path: '/', label: 'nav.dashboard', icon: 'LayoutDashboard', perm: ['run.read'] },
      { id: 'activity', path: '/aktivitaeten', label: 'nav.activity', icon: 'Activity', perm: ['audit.read'] },
      { id: 'notifications', path: '/benachrichtigungen', label: 'nav.notifications', icon: 'Bell', badge: 'notifications' },
    ],
  },
  {
    group: 'nav.automation',
    items: [
      { id: 'workflows', path: '/workflows', label: 'nav.workflows', icon: 'Workflow', perm: ['workflow.read'], badge: 'approvals' },
      { id: 'templates', path: '/vorlagen', label: 'nav.templates', icon: 'LayoutTemplate', perm: ['workflow.read'] },
      { id: 'history', path: '/ausfuehrungen', label: 'nav.history', icon: 'History', perm: ['run.read'] },
    ],
  },
  {
    group: 'nav.integrations',
    items: [
      { id: 'interfaces', path: '/schnittstellen', label: 'nav.interfaces', icon: 'Plug', perm: ['connection.read'] },
      { id: 'connections', path: '/verbindungen', label: 'nav.connections', icon: 'Link2', perm: ['connection.read'] },
      { id: 'webhooks', path: '/webhooks', label: 'nav.webhooks', icon: 'Zap', perm: ['connection.read'] },
      { id: 'api', path: '/api-schluessel', label: 'nav.api', icon: 'KeyRound', perm: ['system.manage'] },
    ],
  },
  {
    group: 'nav.content',
    items: [{ id: 'wordpress', path: '/wordpress', label: 'nav.wordpress', icon: 'Megaphone', perm: ['wordpress.read'] }],
  },
  {
    group: 'nav.admin',
    items: [
      { id: 'users', path: '/benutzer', label: 'nav.users', icon: 'Users', perm: ['user.read'] },
      { id: 'status', path: '/system', label: 'nav.status', icon: 'Server', perm: ['system.read'] },
      { id: 'logs', path: '/protokolle', label: 'nav.logs', icon: 'ScrollText', perm: ['system.read'] },
      { id: 'settings', path: '/einstellungen', label: 'nav.settings', icon: 'Settings', perm: ['system.read', 'system.manage'] },
      { id: 'updates', path: '/updates', label: 'nav.updates', icon: 'Download', adminOnly: true },
    ],
  },
];

/** Aktiver Menüpunkt anhand des Pfads (längster Präfix gewinnt). */
export function activeNavId(pathname: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const g of navigation)
    for (const it of g.items) {
      const match = it.path === '/' ? pathname === '/' : pathname === it.path || pathname.startsWith(it.path + '/');
      if (match && (!best || it.path.length > best.len)) best = { id: it.id, len: it.path.length };
    }
  if (!best && pathname.startsWith('/schnittstellen')) return 'interfaces';
  return best?.id ?? null;
}

export function navItem(id: string): NavItem | undefined {
  for (const g of navigation) for (const it of g.items) if (it.id === id) return it;
  return undefined;
}

export function navGroupOf(id: string): string | undefined {
  return navigation.find((g) => g.items.some((i) => i.id === id))?.group;
}
