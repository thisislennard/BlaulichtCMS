import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { activeNavId, navGroupOf, navigation, navItem, PAGE_HELP } from '../../config/navigation';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { Avatar, cx, Kbd } from '../ui/core';
import { Icon } from '../ui/Icon';
import { Popover } from '../ui/overlays';
import { CommandPalette } from './CommandPalette';
import { useLive } from '../../lib/live';
import { usePwaInstall } from '../../lib/pwa';
import { LegalLinks } from '../legal/LegalLinks';
import { FeedbackView } from '../feedback/Feedback';
import { PageInfoCtx, type PageInfo } from './page';
import { helpHref, PageHelp } from './PageHelp';
import { MobileTabBar } from './MobileTabBar';

/**
 * Seitentitel/Brotkrumen (#250, #267): Menüseiten erhalten Titel, Bereich und Hilfe aus der Navigation. Unterseiten und
 * Detailseiten setzen `title` (Objekt- bzw. Reitertitel); Seiten ohne eigenen Menüpunkt ordnen sich mit `navId` einem
 * Bereich zu (z. B. Freigabe-Ansicht → Übersicht/Freigaben) oder setzen eigene `crumbs` (Hilfe). `help` wählt ein
 * anderes Hilfe-Kapitel als das des Menüpunkts.
 */
interface PageMeta {
  title?: string;
  navId?: string;
  crumbs?: { label: string; to?: string }[];
  help?: string;
  fullBleed?: boolean;
  collapseSidebar?: boolean;
}
const PageMetaCtx = createContext<(m: PageMeta) => void>(() => {});
export function usePageMeta(m: PageMeta) {
  const set = useContext(PageMetaCtx);
  const key = JSON.stringify(m);
  useEffect(() => {
    set(m);
    return () => set({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, set]);
}

function useCounts() {
  const { me, can } = useAuth();
  // Mit Live-Verbindung melden Ereignisse jede Änderung an Benachrichtigungen und Dashboard – dann nur selten zur
  // Sicherheit nachfragen (#192: das Dashboard ist die teuerste Abfrage und lief sonst alle 30 s in jedem Tab)
  const fallback = useLive() === 'live' ? 120_000 : 30_000;
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => get('/notifications'), enabled: !!me, refetchInterval: fallback });
  const status = useQuery({ queryKey: ['system-status-mini'], queryFn: () => get('/system/status'), enabled: can('system.status'), refetchInterval: 30_000 });
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/dashboard'), enabled: can('post.view') && (can('approval.post') || can('publish.website')), refetchInterval: fallback });
  const approvals = (can('approval.post') ? (dash.data?.pendingApprovals?.length ?? 0) : 0) + (can('publish.website') ? (dash.data?.readyToPublish?.length ?? 0) : 0);
  return { notif: notif.data, status: status.data, approvals };
}

/** Logo-Marke „Meldung“: Seite mit Signal, Signalrot, abgerundet. */
function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span className="rounded-[9px] bc-signal-bg flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <g transform="translate(-2.75 2)">
          <rect x="13" y="16" width="27" height="36" rx="5" />
          <path d="M20.5 30H32.5M20.5 39H29" />
          <path d="M46 7.5A10.5 10.5 0 0 1 56.5 18" />
          <circle cx="46" cy="18" r="4.5" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </span>
  );
}

/** Sichtbare Navigationsgruppen samt Badge-Zahlen (Rechte werden wie bisher geprüft). */
function useNavGroups() {
  const { canAny, isPlatformAdmin } = useAuth();
  const { notif, approvals } = useCounts();
  return navigation
    .map((g) => {
      const items = g.items
        .filter((it) => (it.adminOnly ? isPlatformAdmin : !it.perm || canAny(...it.perm)))
        .map((it) => ({ ...it, count: it.badge === 'notifications' ? (notif?.unread ?? 0) : it.badge === 'approvals' ? approvals : 0 }));
      return { group: g.group, items, count: items.reduce((n, it) => n + (it.badge === 'approvals' ? it.count : 0), 0) };
    })
    .filter((g) => g.items.length > 0);
}

function CountBadge({ n, strong }: { n: number; strong?: boolean }) {
  if (!n) return null;
  return (
    <span className={cx('min-w-[18px] h-[18px] px-[5px] rounded-full text-[11px] font-semibold font-mono inline-flex items-center justify-center', strong ? 'bg-primary-solid text-on-primary' : 'bg-raised text-fg-muted')} aria-label={`${n} neu`}>
      {n}
    </span>
  );
}

/** Mobile Navigation (Schublade, „Mehr“ in der unteren Leiste): vollständige Liste aller Bereiche. */
function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const active = activeNavId(pathname);
  const groups = useNavGroups();
  return (
    <nav aria-label="Hauptnavigation" className="h-full w-[284px] max-w-[86vw] flex flex-col gap-5 px-3 pt-4 pb-5 overflow-y-auto">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-1.5 !text-fg">
        <BrandMark />
        <span className="flex flex-col leading-tight min-w-0">
          <span className="font-semibold text-section">BlaulichtCMS</span>
          <span className="text-meta text-fg-muted truncate">{me?.instance.organization || me?.instance.name}</span>
        </span>
      </Link>
      {groups.map((g) => (
        <div key={g.group} className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1.5 font-mono text-label uppercase text-fg-muted">{t(g.group)}</div>
          {g.items.map((it) => {
            const on = it.id === active;
            return (
              <Link key={it.id} to={it.path} onClick={onNavigate} aria-current={on ? 'page' : undefined} className={cx('flex items-center gap-2.5 h-10 px-2.5 rounded-control font-medium', on ? 'bg-raised !text-fg font-semibold' : '!text-fg-muted hover:bg-raised hover:!text-fg')}>
                <Icon name={it.icon} size={17} className={cx('shrink-0', on && 'text-primary')} strokeWidth={1.8} />
                <span className="flex-1 truncate">{t(it.label)}</span>
                <CountBadge n={it.count} strong={it.badge === 'approvals'} />
              </Link>
            );
          })}
        </div>
      ))}
      <NavLink to="/hilfe" onClick={onNavigate} className={({ isActive }) => cx('mt-auto flex items-center gap-2.5 h-10 px-2.5 rounded-control font-medium', isActive ? 'bg-raised !text-fg font-semibold' : '!text-fg-muted hover:bg-raised hover:!text-fg')}>
        <Icon name="LifeBuoy" size={17} />
        {t('nav.help')}
        <span className="ml-auto font-mono text-[11px] text-fg-muted">v{me?.version}</span>
      </NavLink>
    </nav>
  );
}

/** Hauptnavigation oben: Bereiche als Reiter, darunter die Seiten des aktiven Bereichs. */
function TopNav({ activeGroup }: { activeGroup?: string }) {
  const groups = useNavGroups();
  return (
    <nav aria-label="Hauptnavigation" className="hidden md:flex items-stretch gap-6 self-stretch">
      {groups.map((g) => {
        const on = g.group === activeGroup;
        return (
          <Link key={g.group} to={g.items[0].path} aria-current={on ? 'true' : undefined} className={cx('flex items-center gap-1.5 text-[14px] whitespace-nowrap transition-colors duration-fast', on ? '!text-fg font-semibold shadow-[inset_0_-2px_0_var(--bc-primary)]' : '!text-fg-muted font-medium hover:!text-fg')}>
            {t(g.group)}
            <CountBadge n={g.count} strong />
          </Link>
        );
      })}
    </nav>
  );
}

function SubNav({ activeGroup, activeId }: { activeGroup?: string; activeId: string | null }) {
  const groups = useNavGroups();
  const g = groups.find((x) => x.group === activeGroup);
  if (!g || g.items.length < 2) return null;
  return (
    <nav aria-label={t(g.group)} className="hidden md:flex items-center gap-1 h-12 px-8 border-t border-line overflow-x-auto">
      {g.items.map((it) => {
        const on = it.id === activeId;
        return (
          // Link statt NavLink: „aktuell“ ist genau der Menüpunkt der Seite (auch für Unterseiten wie /presse/mitteilungen)
          <Link key={it.id} to={it.path} aria-current={on ? 'page' : undefined} className={cx('flex items-center gap-2 h-8 px-3 rounded-control text-sm whitespace-nowrap', on ? 'bg-raised !text-fg font-semibold' : '!text-fg-muted font-medium hover:bg-raised hover:!text-fg')}>
            <Icon name={it.icon} size={15} className={cx('shrink-0', on && 'text-primary')} strokeWidth={1.8} />
            {t(it.label)}
            <CountBadge n={it.count} strong={it.badge === 'approvals'} />
          </Link>
        );
      })}
    </nav>
  );
}

/** Hell/Dunkel-Schalter: speichert die Wahl im Profil (wie die Einstellung unter „Mein Konto“). */
function ThemeToggle() {
  const { me, setPreferences } = useAuth();
  const pref = me?.user.preferences.theme ?? 'light';
  const resolved = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
  if (!me) return null;
  return (
    <div role="group" aria-label="Farbmodus" className="hidden sm:flex p-0.5 border border-line rounded-control">
      {(['light', 'dark'] as const).map((m) => (
        <button key={m} type="button" aria-label={m === 'light' ? 'Heller Modus' : 'Dunkler Modus'} aria-pressed={resolved === m} onClick={() => setPreferences({ theme: m })} className={cx('w-8 h-[30px] rounded-[8px] inline-flex items-center justify-center', resolved === m ? 'bg-fg text-card' : 'text-fg-muted hover:text-fg')}>
          <Icon name={m === 'light' ? 'Sun' : 'Moon'} size={15} />
        </button>
      ))}
    </div>
  );
}

function NotificationsButton() {
  const { notif } = useCounts();
  const qc = useQueryClient();
  const markRead = (body: object) => post('/notifications/read', body).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const unread = notif?.unread ?? 0;
  // Zahl ungelesener Benachrichtigungen am App-Symbol (Taskleiste/Dock), nur wo der Browser das kann (#197)
  useEffect(() => {
    if (!notif) return;
    const n = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    (unread > 0 ? n.setAppBadge?.(unread) : n.clearAppBadge?.())?.catch(() => {});
  }, [notif, unread]);
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} aria-label={`Benachrichtigungen${unread ? `, ${unread} neu` : ''}`} aria-expanded={open} className="relative w-9 h-9 max-md:w-10 max-md:h-10 rounded-control border border-line bg-transparent inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-raised">
        <Icon name="Bell" size={16} />
        {unread > 0 && <span aria-hidden="true" className="absolute top-[7px] right-[8px] w-2 h-2 rounded-full bg-primary border-2 border-card" />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={360}>
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <strong className="text-sm">Benachrichtigungen</strong>
          {unread > 0 && (
            <button type="button" className="text-meta text-fg-link hover:text-fg" onClick={() => markRead({ all: true })}>
              Alle als gelesen markieren
            </button>
          )}
        </div>
        <div className="max-h-[360px] overflow-y-auto px-1.5 pb-1.5">
          {(notif?.notifications ?? []).slice(0, 8).map((n: any) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                markRead({ ids: [n.id] });
                setOpen(false);
                if (n.link) navigate(n.link);
              }}
              className="w-full text-left flex gap-2.5 p-2.5 rounded-control hover:bg-raised"
            >
              <Icon name={n.kind === 'error' ? 'XCircle' : n.kind === 'warning' ? 'AlertTriangle' : n.kind === 'success' ? 'CheckCircle2' : 'Info'} size={15} className={cx('mt-0.5 shrink-0', n.kind === 'error' ? 'text-err' : n.kind === 'warning' ? 'text-warn' : n.kind === 'success' ? 'text-ok' : 'text-fg-link')} />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className={cx('text-sm', !n.read && 'font-semibold')}>{n.title}</span>
                {n.body && <span className="text-meta text-fg-muted line-clamp-2">{n.body}</span>}
                <span className="text-meta text-fg-muted">{fmtRelative(n.created_at)}</span>
              </span>
            </button>
          ))}
          {!notif?.notifications?.length && <p className="text-sm text-fg-muted px-3 py-4 m-0">Keine Benachrichtigungen.</p>}
        </div>
        <div className="border-t border-line px-4 py-2.5">
          <Link to="/benachrichtigungen" onClick={() => setOpen(false)} className="text-sm">
            Alle anzeigen
          </Link>
        </div>
      </Popover>
    </>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const pwa = usePwaInstall();
  if (!me) return null;
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} aria-label={`Benutzerprofil von ${me.user.name}`} aria-expanded={open} className="rounded-full inline-flex items-center justify-center min-w-10 min-h-10">
        <Avatar name={me.user.name} size={36} strong />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={260}>
        <div className="px-4 py-3 border-b border-line">
          <div className="font-semibold text-sm truncate">{me.user.name}</div>
          <div className="text-meta text-fg-muted truncate">{me.user.email}</div>
          <div className="text-meta text-fg-muted mt-1">{me.roleLabels.join(', ')}</div>
        </div>
        <div className="p-1.5">
          {[
            { icon: 'User', label: t('nav.profile'), to: '/profil' },
            { icon: 'LifeBuoy', label: t('nav.help'), to: '/hilfe' },
          ].map((i) => (
            <button key={i.to} type="button" onClick={() => (setOpen(false), navigate(i.to))} className="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-chip text-sm hover:bg-raised">
              <Icon name={i.icon} size={15} /> {i.label}
            </button>
          ))}
          {!pwa.installed && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                // Chrome/Edge: Installationsdialog direkt; sonst Anleitung für diesen Browser
                if (pwa.canPrompt) void pwa.promptInstall();
                else navigate('/app');
              }}
              className="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-chip text-sm hover:bg-raised"
            >
              <Icon name="Download" size={15} /> App installieren
            </button>
          )}
          <button type="button" onClick={() => logout().then(() => navigate('/login'))} className="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-chip text-sm hover:bg-raised text-err">
            <Icon name="LogOut" size={15} /> {t('nav.logout')}
          </button>
        </div>
      </Popover>
    </>
  );
}

/** Statuszeile unter der Navigation: Brotkrumen links, Betriebszustand rechts (Monospace). */
function StatusStrip({ crumbs, title }: { crumbs: { label: string; to?: string }[]; title: string }) {
  const { status } = useCounts();
  const { me, can } = useAuth();
  const live = useLive();
  const problems = status ? status.services.filter((s: any) => s.state !== 'ok').length : 0;
  const dot = (c: string) => <span aria-hidden="true" className={cx('w-[7px] h-[7px] rounded-full shrink-0', c)} />;
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-2 px-4 md:px-8 py-2.5 border-b border-line font-mono text-[12px] tracking-[0.02em]">
      {/* Reine Navigation – die h1 steht im Seitenkopf (#267) */}
      <nav aria-label="Brotkrumen" className="flex-1 min-w-0">
        <ol className="m-0 p-0 list-none flex items-center gap-1.5 min-w-0 uppercase">
          <li className="hidden sm:flex items-center">
            <Link to="/" className="!text-fg-muted hover:!text-fg">
              BlaulichtCMS
            </Link>
          </li>
          {crumbs.map((c) => (
            <li key={c.label} className="hidden sm:flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="text-fg-muted">/</span>
              {c.to ? (
                <Link to={c.to} className="!text-fg-muted hover:!text-fg truncate">
                  {c.label}
                </Link>
              ) : (
                <span className="text-fg-muted truncate">{c.label}</span>
              )}
            </li>
          ))}
          {title && (
            <li className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="hidden sm:inline text-fg-muted">/</span>
              <span aria-current="page" className="font-medium text-fg truncate">
                {title}
              </span>
            </li>
          )}
        </ol>
      </nav>
      {status && (
        <Link to={can('system.status') ? '/system' : '/'} className="hidden sm:inline-flex items-center gap-2 !text-fg whitespace-nowrap">
          {dot(problems ? 'bg-warn' : 'bg-ok')}
          <span className="text-fg-muted">DIENSTE</span>
          {problems ? `${problems} ${problems === 1 ? 'Hinweis' : 'Hinweise'}` : 'alle laufen'}
        </Link>
      )}
      {live !== 'off' && (
        <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap">
          {dot(live === 'live' ? 'bg-ok' : 'bg-warn bc-pulse')}
          <span className="text-fg-muted">LIVE</span>
          {live === 'live' ? 'verbunden' : live === 'reconnecting' ? 'unterbrochen' : 'verbinde …'}
        </span>
      )}
      {me?.version && <span className="hidden lg:inline text-fg-muted whitespace-nowrap">v{me.version}</span>}
    </div>
  );
}

/** Hilfe-Knopf in der Kopfzeile (#265): öffnet das Kapitel der aktuellen Seite bzw. die Startseite der Hilfe. */
function HelpButton({ topic }: { topic?: string }) {
  return (
    <Link to={helpHref(topic)} aria-label={t('nav.pageHelp')} title={`${t('nav.pageHelp')} (?)`} className="w-9 h-9 max-md:w-10 max-md:h-10 rounded-control border border-line inline-flex items-center justify-center !text-fg-muted hover:!text-fg hover:bg-raised">
      <Icon name="CircleHelp" size={16} />
    </Link>
  );
}

/** Bereich, Brotkrumen, Titel und Hilfe der aktuellen Seite – eine Quelle für Kopf, Brotkrumen und Fenstertitel. */
function usePageFrame(pathname: string, meta: PageMeta) {
  const { me } = useAuth();
  const activeId = meta.navId ?? activeNavId(pathname);
  const activeGroup = activeId ? navGroupOf(activeId) : undefined;
  const item = activeId ? navItem(activeId) : undefined;
  const itemLabel = item ? t(item.label) : '';
  const title = meta.title ?? itemLabel;
  // Menüseiten: „Bereich / Seite“; Unter- und Detailseiten: „Bereich / Menüpunkt / Titel“ (Menüpunkt als Link)
  const crumbs = meta.crumbs ?? [...(activeGroup ? [{ label: t(activeGroup) }] : []), ...(item && meta.title && meta.title !== itemLabel ? [{ label: itemLabel, to: item.path }] : [])];
  const help = meta.help ?? item?.help ?? PAGE_HELP[pathname];
  // Fenstertitel (WCAG 2.4.2): „Seite – Bereich · Organisation“, z. B. „Übung am Wochenende – Beiträge · Musterwehr“
  const org = me?.instance.organization || (me?.instance.name && me.instance.name !== 'BlaulichtCMS' ? me.instance.name : '') || 'BlaulichtCMS';
  const parent = crumbs.length ? crumbs[crumbs.length - 1].label : '';
  const docTitle = title ? `${title}${parent && parent !== title ? ` – ${parent}` : ''} · ${org}` : org;
  return { activeId, activeGroup, title, crumbs, help, docTitle };
}

export function AppShell() {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [meta, setMeta] = useState<PageMeta>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);
  // Schublade als echter Dialog: Escape schließt, Fokus wandert hinein und bleibt darin, danach zurück zum Menü-Button
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const box = drawerRef.current;
    const focusables = () => Array.from(box?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    const btn = menuBtnRef.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      btn?.focus();
    };
  }, [mobileOpen]);
  const { activeId, activeGroup, title, crumbs, help, docTitle } = usePageFrame(pathname, meta);
  const navGroups = useNavGroups();
  useEffect(() => {
    document.title = docTitle;
  }, [docTitle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // „?“ außerhalb von Eingabefeldern: Hilfe zur aktuellen Seite (#265)
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('[role=dialog][aria-modal=true]')) {
        e.preventDefault();
        navigate(helpHref(help));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, navigate]);

  const setMetaStable = useMemo(() => (m: PageMeta) => setMeta(m), []);
  const pageInfo = useMemo<PageInfo>(() => ({ title, renderHelp: (topic) => (topic === false || !(topic ?? help) ? null : <PageHelp topic={(topic ?? help)!} />) }), [title, help]);

  return (
    <PageMetaCtx.Provider value={setMetaStable}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] bg-card px-3 py-2 rounded-control">
        {t('nav.skip')}
      </a>
      <div className="min-h-screen flex flex-col bg-bg text-fg">
        {mobileOpen && (
          <div ref={drawerRef} className="fixed inset-0 z-[70] flex md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="bc-sidebar bg-card border-r border-line h-full shadow-float">
              <MobileNav onNavigate={() => setMobileOpen(false)} />
            </div>
            <button type="button" aria-label="Menü schließen" className="flex-1 bg-scrim" onClick={() => setMobileOpen(false)} />
          </div>
        )}
        <header className="sticky top-0 z-40 bg-card border-b border-line">
          <div className="h-14 flex items-center gap-3 md:gap-8 px-4 md:px-8">
            <Link to="/" className="flex items-center gap-2.5 !text-fg min-w-0 min-h-10">
              <BrandMark />
              <span className="font-semibold text-section tracking-[-0.01em]">BlaulichtCMS</span>
              <span className="hidden xl:inline text-fg-muted">/</span>
              <span className="hidden xl:inline text-sm text-fg-muted truncate max-w-[200px]">{me?.instance.organization || me?.instance.name}</span>
            </Link>
            <TopNav activeGroup={activeGroup} />
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => setPaletteOpen(true)} aria-label={t('nav.searchLabel')} className="hidden lg:flex items-center gap-2 h-9 w-[240px] px-3 rounded-control border border-line bg-bg text-fg-muted text-sm hover:bg-raised">
                <Icon name="Search" size={15} />
                <span className="flex-1 text-left truncate">Suchen</span>
                <Kbd>Strg K</Kbd>
              </button>
              <button type="button" onClick={() => setPaletteOpen(true)} aria-label={t('nav.searchLabel')} className="lg:hidden w-9 h-9 max-md:w-10 max-md:h-10 rounded-control border border-line inline-flex items-center justify-center text-fg-muted">
                <Icon name="Search" size={16} />
              </button>
              <HelpButton topic={help} />
              <ThemeToggle />
              <NotificationsButton />
              <UserMenu />
            </div>
          </div>
          <SubNav activeGroup={activeGroup} activeId={activeId} />
        </header>
        <StatusStrip crumbs={crumbs} title={title} />
        <main id="main" className={cx('flex-1 min-w-0', meta.fullBleed ? '' : 'w-full max-w-content mx-auto px-4 md:px-8 pt-8 pb-14 flex flex-col gap-6')}>
          <PageInfoCtx.Provider value={pageInfo}>
            <Outlet />
          </PageInfoCtx.Provider>
        </main>
        {!meta.fullBleed && <LegalLinks className="pb-6 print:hidden" />}
        {/* Platz für die untere Leiste am Handy (#264) */}
        <div aria-hidden="true" className="md:hidden shrink-0 h-[var(--bc-bottom-bar)]" />
      </div>
      <MobileTabBar items={navGroups.flatMap((g) => g.items)} activeId={activeId} moreOpen={mobileOpen} onMore={() => setMobileOpen(true)} moreRef={menuBtnRef} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </PageMetaCtx.Provider>
  );
}

export function RequirePerm({ perm, children }: { perm: string[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(...perm)) {
    return (
      <FeedbackView
        kind="forbidden"
        actions={
          <Link to="/" className="inline-flex items-center gap-2 h-ctl px-3.5 rounded-control border border-line bg-card text-sm font-medium !text-fg hover:bg-raised">
            <Icon name="LayoutDashboard" size={16} /> Zur Übersicht
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}
