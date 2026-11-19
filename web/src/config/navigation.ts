/**
 * Navigation als Registry (Design §5): Neue Module tragen sich hier ein, das Layout bleibt gleich.
 *
 * Gliederung nach Aufgaben (#250): tägliche Arbeit (Übersicht, Redaktion, Presse, Warnungen) getrennt von der
 * einmaligen Einrichtung (Einrichtung) und dem Betrieb (Verwaltung). Höchstens sechs Bereiche mit je höchstens sieben
 * Punkten; Bausteinseiten sind Reiter ihrer Seite (Medien, Workflows), keine eigenen Menüpunkte.
 *
 * `perm`: mindestens eines der Rechte nötig, sonst wird der Punkt ausgeblendet; eine Gruppe ohne sichtbaren Punkt
 * entfällt ganz. Es gelten die feinen Rechte aus dem Rechte-Katalog (server/src/auth/permissions.ts).
 * `help`: Hilfe-Kapitel (Slug unter web/src/pages/help/content, optional mit #Anker) für das „?“ am Seitentitel und in
 * der Kopfzeile (#265); Unterseiten und Detailseiten erben es (server/test/navigation.test.ts prüft die Zuordnung).
 *
 * Das Label ist zugleich Seitentitel (`PageHeader`), letzter Brotkrumen und Fenstertitel – Hinweise im Text verweisen
 * mit `navTrail(id)` darauf, damit „unter X → Y“ immer der tatsächlichen Menübezeichnung entspricht.
 */
export interface NavItem {
  id: string;
  path: string;
  label: string; // i18n-Schlüssel
  icon: string;
  perm?: string[];
  badge?: 'notifications' | 'approvals';
  adminOnly?: boolean;
  help: string;
}

export interface NavGroup {
  group: string; // i18n-Schlüssel
  items: NavItem[];
}

export const navigation: NavGroup[] = [
  {
    group: 'nav.overview',
    items: [
      { id: 'dashboard', path: '/', label: 'nav.dashboard', icon: 'LayoutDashboard', help: 'dashboard' },
      // Freigaben über alle Arten (#251) – Rechte wie APPROVAL_PAGE_PERMS (pages/approvals/model.ts)
      { id: 'approvals', path: '/freigaben', label: 'nav.approvals', icon: 'ListChecks', perm: ['approval.post', 'approval.banner', 'approval.incident', 'approval.automation', 'warning.approve', 'press.approve', 'publish.website', 'publish.social', 'banner.publish', 'incident.publish', 'warning.send'], badge: 'approvals', help: 'freigabe#freigaben-liste' },
      { id: 'notifications', path: '/benachrichtigungen', label: 'nav.notifications', icon: 'Bell', badge: 'notifications', help: 'benachrichtigungen' },
      { id: 'insights', path: '/reichweite', label: 'nav.insights', icon: 'ChartColumn', perm: ['insights.view'], help: 'verbindungen#reichweite' },
      { id: 'activity', path: '/aktivitaeten', label: 'nav.activity', icon: 'Activity', perm: ['audit.view'], help: 'system#aktivitaeten' },
    ],
  },
  {
    group: 'nav.editorial',
    items: [
      { id: 'posts', path: '/beitraege', label: 'nav.posts', icon: 'FileText', perm: ['post.view'], help: 'beitraege' },
      { id: 'media', path: '/medien', label: 'nav.media', icon: 'Images', perm: ['media.view'], help: 'foto-link' },
      { id: 'calendar', path: '/kalender', label: 'nav.calendar', icon: 'CalendarDays', perm: ['calendar.view'], help: 'kalender' },
      { id: 'incidents', path: '/einsatzliste', label: 'nav.incidents', icon: 'ListOrdered', perm: ['incident.view'], help: 'einsatzliste' },
      { id: 'banners', path: '/banner', label: 'nav.banners', icon: 'Megaphone', perm: ['banner.view'], help: 'banner' },
      { id: 'designTemplates', path: '/designvorlagen', label: 'nav.designTemplates', icon: 'Palette', perm: ['templates.view'], help: 'designvorlagen' },
      { id: 'sources', path: '/quellen', label: 'nav.sources', icon: 'Newspaper', perm: ['source.view'], help: 'quellen' },
    ],
  },
  {
    group: 'nav.press',
    items: [
      { id: 'pressRequests', path: '/presse', label: 'nav.pressRequests', icon: 'MessageSquareQuote', perm: ['press.view'], help: 'presse' },
      { id: 'pressReleases', path: '/presse/mitteilungen', label: 'nav.pressReleases', icon: 'Newspaper', perm: ['press.release'], help: 'presse#pressemitteilungen' },
      { id: 'pressDistribution', path: '/presse/verteiler', label: 'nav.pressDistribution', icon: 'BookUser', perm: ['press.contacts'], help: 'presse#presseverteiler' },
      { id: 'pressSnippets', path: '/presse/textbausteine', label: 'nav.pressSnippets', icon: 'TextCursorInput', perm: ['press.snippets'], help: 'presse#textbausteine' },
    ],
  },
  {
    group: 'nav.warnings',
    items: [
      { id: 'warnings', path: '/warnungen', label: 'nav.warningCases', icon: 'Siren', perm: ['warning.view'], help: 'warnentwurf' },
      { id: 'officialWarnings', path: '/amtliche-warnungen', label: 'nav.officialWarnings', icon: 'AlertTriangle', perm: ['official.view'], help: 'verbindungen#amtliche-warnungen' },
    ],
  },
  {
    group: 'nav.setup',
    items: [
      { id: 'connections', path: '/verbindungen', label: 'nav.connections', icon: 'Plug', perm: ['connection.configure', 'channel.view'], help: 'verbindungen' },
      { id: 'automations', path: '/workflows', label: 'nav.automations', icon: 'Workflow', perm: ['automation.read'], help: 'workflows' },
      { id: 'templates', path: '/beitragsvorlagen', label: 'nav.templates', icon: 'LayoutTemplate', perm: ['post.templates'], help: 'beitraege#beitragsvorlagen' },
      { id: 'warningConfig', path: '/stichwoerter-regeln', label: 'nav.warningConfig', icon: 'ListChecks', perm: ['warning.rules', 'warning.approve', 'warning.settings'], help: 'stichwoerter-regeln' },
      { id: 'pressMailbox', path: '/presse-postfach', label: 'nav.pressMailbox', icon: 'Inbox', perm: ['press.mailbox'], help: 'presse#presse-postfach-abrufen' },
      { id: 'uploadPage', path: '/upload-seite', label: 'nav.uploadPage', icon: 'PanelTop', perm: ['media.design'], help: 'foto-link#upload-seite-gestalten' },
    ],
  },
  {
    group: 'nav.admin',
    items: [
      { id: 'users', path: '/benutzer', label: 'nav.users', icon: 'Users', perm: ['user.view'], help: 'benutzer-rollen' },
      { id: 'status', path: '/system', label: 'nav.status', icon: 'Server', perm: ['system.status'], help: 'system#systemstatus' },
      { id: 'mediaAdmin', path: '/medienverwaltung', label: 'nav.mediaAdmin', icon: 'HardDrive', perm: ['media.admin'], help: 'foto-link#gesperrte-dateien' },
      { id: 'logs', path: '/protokolle', label: 'nav.logs', icon: 'ScrollText', perm: ['system.logs', 'audit.view'], help: 'system#protokolle' },
      { id: 'privacy', path: '/datenschutz-anfragen', label: 'nav.privacy', icon: 'ShieldCheck', perm: ['privacy.manage'], help: 'sicherheit#datenschutzanfragen-auskunft-und-loeschung' },
      { id: 'settings', path: '/einstellungen', label: 'nav.settings', icon: 'Settings', perm: ['settings.view'], help: 'einrichtung#einstellungen-im-ueberblick' },
    ],
  },
];

/**
 * Untere Leiste am Handy (#264, Design §5): drei Ziele aus der Navigation in dieser Reihenfolge – nur sichtbare
 * (Rechte wie oben); fehlt eines, rückt das nächste nach. In der Mitte stehen die Schnellaktionen, rechts „Mehr“
 * (die Schublade mit allen Bereichen).
 */
export const MOBILE_TABS: string[] = ['dashboard', 'posts', 'approvals', 'pressRequests', 'warnings', 'media', 'calendar', 'incidents', 'notifications'];

/**
 * Schnellaktionen der unteren Leiste (Knopf „＋“), je nach Recht. `sichten` listet zusätzlich die Sammlungen mit
 * offenen Dateien (ein Tipp öffnet die Sichtung); höchstens zwei Tipps von jeder Seite aus.
 */
export interface QuickAction {
  id: 'collect' | 'review' | 'post' | 'warning' | 'press';
  label: string;
  hint: string;
  icon: string;
  perm: string[];
}
export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'collect', label: 'Fotos sammeln', hint: 'Sammlung mit Upload-Link und QR-Code', icon: 'Camera', perm: ['media.collections'] },
  { id: 'review', label: 'Sichten', hint: 'Offene Fotos und Videos', icon: 'CheckSquare', perm: ['media.review'] },
  { id: 'post', label: 'Neuer Beitrag', hint: 'Entwurf anlegen', icon: 'FileText', perm: ['post.create'] },
  { id: 'warning', label: 'Neue Erstmeldung', hint: 'Warnentwurf anlegen', icon: 'Siren', perm: ['warning.draft'] },
  { id: 'press', label: 'Anfrage erfassen', hint: 'Presseanfrage von Hand', icon: 'MessageSquareQuote', perm: ['press.manage'] },
];

/** Seiten ohne Menüpunkt mit eigener Hilfe (Mein Konto, Hilfe selbst). */
export const PAGE_HELP: Record<string, string> = { '/profil': 'anmeldung', '/hilfe': 'erste-schritte' };

/**
 * Frühere Adressen → neue Adressen (#250). Lesezeichen, Benachrichtigungen, Audit- und Hilfe-Links bleiben gültig;
 * Unterpfade, Suche und Anker werden übernommen. `/presse/einstellungen` wählt je nach Recht Postfach oder Textbausteine
 * (siehe App.tsx).
 */
export const LEGACY_PATHS: Record<string, string> = {
  '/kanaele': '/verbindungen/websites',
  '/websites': '/verbindungen/websites',
  '/vorlagen': '/beitragsvorlagen',
  '/warnungen/pflege': '/stichwoerter-regeln',
  '/medien/gestaltung': '/upload-seite',
  '/medien/verwaltung': '/medienverwaltung',
  '/workflows/eingaenge': '/workflows/ausloeser',
  '/workflows/ausgaenge': '/workflows/aktionen',
};

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

/** Pfad eines Menüpunkts (für Links in Hinweisen statt fest geschriebener Adressen). */
export function navPath(id: string): string {
  const it = navItem(id);
  if (!it) throw new Error(`Unbekannter Menüpunkt: ${id}`);
  return it.path;
}
