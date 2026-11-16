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
      { id: 'dashboard', path: '/', label: 'nav.dashboard', icon: 'LayoutDashboard' },
      { id: 'notifications', path: '/benachrichtigungen', label: 'nav.notifications', icon: 'Bell', badge: 'notifications' },
      { id: 'activity', path: '/aktivitaeten', label: 'nav.activity', icon: 'Activity', perm: ['audit.read'] },
    ],
  },
  {
    group: 'nav.editorial',
    items: [
      { id: 'posts', path: '/beitraege', label: 'nav.posts', icon: 'FileText', perm: ['post.read'] },
      { id: 'approvals', path: '/freigaben', label: 'nav.approvals', icon: 'ListChecks', perm: ['post.approve', 'post.publish'], badge: 'approvals' },
      { id: 'media', path: '/medien', label: 'nav.media', icon: 'Images', perm: ['media.read'] },
      { id: 'sources', path: '/quellen', label: 'nav.sources', icon: 'Newspaper', perm: ['post.read'] },
      { id: 'templates', path: '/vorlagen', label: 'nav.templates', icon: 'LayoutTemplate', perm: ['post.edit'] },
    ],
  },
  {
    group: 'nav.channels',
    items: [
      { id: 'banners', path: '/banner', label: 'nav.banners', icon: 'Megaphone', perm: ['post.read'] },
      { id: 'sites', path: '/kanaele', label: 'nav.sites', icon: 'Globe', perm: ['post.read', 'channel.manage'] },
      { id: 'connections', path: '/verbindungen', label: 'nav.connections', icon: 'Plug', perm: ['connection.manage'] },
    ],
  },
  {
    group: 'nav.automations',
    items: [
      { id: 'automations', path: '/automationen', label: 'nav.automationList', icon: 'Workflow', perm: ['automation.read', 'automation.manage'] },
      { id: 'automationInputs', path: '/automationen/eingaenge', label: 'nav.automationInputs', icon: 'Zap', perm: ['automation.read', 'automation.manage'] },
      { id: 'automationOutputs', path: '/automationen/ausgaenge', label: 'nav.automationOutputs', icon: 'Send', perm: ['automation.read', 'automation.manage'] },
    ],
  },
  {
    group: 'nav.warnings',
    items: [
      { id: 'warnings', path: '/warnungen', label: 'nav.warningCases', icon: 'Siren', perm: ['warning.draft', 'warning.level', 'warning.approve', 'warning.send', 'warning.rules'] },
      { id: 'officialWarnings', path: '/amtliche-warnungen', label: 'nav.officialWarnings', icon: 'AlertTriangle', perm: ['post.read'] },
      { id: 'warningConfig', path: '/warnungen/pflege', label: 'nav.warningConfig', icon: 'ListChecks', perm: ['warning.rules', 'warning.approve', 'system.manage'] },
    ],
  },
  {
    group: 'nav.admin',
    items: [
      { id: 'users', path: '/benutzer', label: 'nav.users', icon: 'Users', perm: ['user.read'] },
      { id: 'status', path: '/system', label: 'nav.status', icon: 'Server', perm: ['system.read'] },
      { id: 'logs', path: '/protokolle', label: 'nav.logs', icon: 'ScrollText', perm: ['system.read'] },
      { id: 'privacy', path: '/datenschutz-anfragen', label: 'nav.privacy', icon: 'ShieldCheck', perm: ['privacy.manage'] },
      { id: 'settings', path: '/einstellungen', label: 'nav.settings', icon: 'Settings', perm: ['system.read', 'system.manage'] },
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
  return best?.id ?? null;
}

export function navItem(id: string): NavItem | undefined {
  for (const g of navigation) for (const it of g.items) if (it.id === id) return it;
  return undefined;
}

export function navGroupOf(id: string): string | undefined {
  return navigation.find((g) => g.items.some((i) => i.id === id))?.group;
}
