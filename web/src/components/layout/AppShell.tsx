import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { activeNavId, navGroupOf, navigation, navItem } from '../../config/navigation';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { Avatar, cx, Kbd } from '../ui/core';
import { Icon } from '../ui/Icon';
import { Popover } from '../ui/overlays';
import { CommandPalette } from './CommandPalette';

/* Seitentitel/Brotkrumen: Seiten ohne eigenen Menüpunkt (Editor, Details) setzen ihn selbst. */
interface PageMeta {
  title?: string;
  crumb?: string;
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
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => get('/notifications'), enabled: !!me, refetchInterval: 30_000 });
  const status = useQuery({ queryKey: ['system-status-mini'], queryFn: () => get('/system/status'), enabled: can('system.read'), refetchInterval: 30_000 });
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/dashboard'), enabled: can('post.approve') || can('post.publish'), refetchInterval: 30_000 });
  const approvals = (can('post.approve') ? (dash.data?.pendingApprovals?.length ?? 0) : 0) + (can('post.publish') ? (dash.data?.readyToPublish?.length ?? 0) : 0);
  return { notif: notif.data, status: status.data, approvals };
}

function Sidebar({ collapsed, onToggle, mobile, onNavigate }: { collapsed: boolean; onToggle?: () => void; mobile?: boolean; onNavigate?: () => void }) {
  const { me, canAny, isPlatformAdmin } = useAuth();
  const { pathname } = useLocation();
  const active = activeNavId(pathname);
  const { notif, status, approvals } = useCounts();
  const servicesOk = status ? status.services.every((s: any) => s.state !== 'error') : true;
  const expanded = !collapsed || mobile;
  return (
    <nav aria-label="Hauptnavigation" className={cx('h-full flex flex-col gap-[22px] px-3 pt-4 pb-5 overflow-y-auto', expanded ? 'w-sidebar' : 'w-sidebar-collapsed')}>
      <Link to="/" onClick={onNavigate} className={cx('flex items-center gap-2.5 px-1.5 py-0.5 !text-fg', !expanded && 'justify-center')}>
        <span className="w-[30px] h-[30px] rounded-control bg-primary-solid flex items-center justify-center shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="7.5" cy="12" r="3.5" />
            <circle cx="16.5" cy="12" r="3.5" />
            <path d="M11 12h2" />
          </svg>
        </span>
        {expanded && (
          <span className="flex flex-col leading-tight min-w-0">
            <span className="font-semibold text-section tracking-[-0.01em]">LifeLink</span>
            <span className="text-meta text-fg-muted truncate">
              {me?.instance.organization || me?.instance.name}
            </span>
          </span>
        )}
      </Link>
      {navigation.map((g) => {
        const items = g.items.filter((it) => (it.adminOnly ? isPlatformAdmin : !it.perm || canAny(...it.perm)));
        if (!items.length) return null;
        return (
          <div key={g.group} className="flex flex-col gap-0.5">
            {expanded && <div className="px-2.5 pb-1.5 text-label uppercase text-fg-muted">{t(g.group)}</div>}
            {items.map((it) => {
              const on = it.id === active;
              const badge = it.badge === 'notifications' ? notif?.unread : it.badge === 'approvals' ? approvals : 0;
              return (
                <NavLink
                  key={it.id}
                  to={it.path}
                  onClick={onNavigate}
                  aria-current={on ? 'page' : undefined}
                  title={!expanded ? t(it.label) : undefined}
                  className={cx('flex items-center gap-2.5 h-[34px] px-2.5 rounded-control font-medium transition-colors duration-fast', on ? 'bg-primary-soft !text-fg' : '!text-fg-muted hover:bg-raised hover:!text-fg', !expanded && 'justify-center')}
                >
                  <Icon name={it.icon} size={16} className={cx('shrink-0', on && 'text-fg-link')} strokeWidth={1.8} />
                  {expanded && <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{t(it.label)}</span>}
                  {expanded && badge ? (
                    <span className="min-w-[18px] h-[18px] px-[5px] rounded-full bg-primary-soft text-fg-link text-[11px] font-semibold inline-flex items-center justify-center" aria-label={`${badge} neu`}>
                      {badge}
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
        );
      })}
      <div className="mt-auto flex flex-col gap-2">
        {expanded && (
          <Link to={canAny('system.read') ? '/system' : '/hilfe'} onClick={onNavigate} className="p-3 border border-line rounded-node flex flex-col gap-1.5 !text-fg hover:bg-raised">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden="true" className={cx('w-2 h-2 rounded-full', servicesOk ? 'bg-ok' : 'bg-err')} />
              {servicesOk ? t('nav.servicesOk') : t('nav.servicesProblem')}
            </span>
            <span className="font-mono text-[11px] text-fg-muted">Docker · v{me?.version}</span>
          </Link>
        )}
        <NavLink to="/hilfe" onClick={onNavigate} title={!expanded ? t('nav.help') : undefined} className={({ isActive }) => cx('flex items-center gap-2.5 h-[34px] px-2.5 rounded-control font-medium', isActive ? 'bg-primary-soft !text-fg' : '!text-fg-muted hover:bg-raised hover:!text-fg', !expanded && 'justify-center')}>
          <Icon name="LifeBuoy" size={16} />
          {expanded && t('nav.help')}
        </NavLink>
        {!mobile && (
          <button type="button" onClick={onToggle} aria-label={collapsed ? t('nav.expand') : t('nav.collapse')} className={cx('flex items-center gap-2.5 h-[34px] px-2.5 rounded-control text-fg-muted font-medium hover:bg-raised hover:text-fg', !expanded && 'justify-center')}>
            <Icon name={collapsed ? 'PanelLeftOpen' : 'PanelLeftClose'} size={16} />
            {expanded && t('nav.collapse')}
          </button>
        )}
      </div>
    </nav>
  );
}

function NotificationsButton() {
  const { notif } = useCounts();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const unread = notif?.unread ?? 0;
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} aria-label={`Benachrichtigungen${unread ? `, ${unread} neu` : ''}`} aria-expanded={open} className="relative w-9 h-9 rounded-control border border-line bg-card inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-raised">
        <Icon name="Bell" size={16} />
        {unread > 0 && <span aria-hidden="true" className="absolute top-[7px] right-[8px] w-2 h-2 rounded-full bg-err border-2 border-card" />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={360}>
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <strong className="text-sm">Benachrichtigungen</strong>
          {unread > 0 && (
            <button type="button" className="text-meta text-fg-link hover:text-fg" onClick={() => post('/notifications/read', { all: true })}>
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
                post('/notifications/read', { ids: [n.id] });
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
  if (!me) return null;
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} aria-label={`Benutzerprofil von ${me.user.name}`} aria-expanded={open} className="rounded-full">
        <Avatar name={me.user.name} size={34} />
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
          <button type="button" onClick={() => logout().then(() => navigate('/login'))} className="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-chip text-sm hover:bg-raised text-err">
            <Icon name="LogOut" size={15} /> {t('nav.logout')}
          </button>
        </div>
      </Popover>
    </>
  );
}

function StatusPill() {
  const { status } = useCounts();
  const { can } = useAuth();
  if (!status) return null;
  const problems = status.services.filter((s: any) => s.state !== 'ok').length;
  return (
    <Link to={can('system.read') ? '/system' : '/'} className={cx('hidden md:inline-flex items-center gap-2 h-9 px-3 rounded-full border text-sm font-medium !text-fg', problems ? 'border-warn/50 bg-warn-soft' : 'border-line bg-card')}>
      <span aria-hidden="true" className={cx('w-2 h-2 rounded-full', problems ? 'bg-warn' : 'bg-ok')} />
      {problems ? `${problems} ${problems === 1 ? 'Hinweis' : 'Hinweise'}` : 'Alles in Ordnung'}
    </Link>
  );
}

export function AppShell() {
  const { me, setPreferences } = useAuth();
  const { pathname } = useLocation();
  const [meta, setMeta] = useState<PageMeta>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const fn = () => setWidth(window.innerWidth);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isMobile = width < 768;
  const autoCollapsed = width < 1280;
  const collapsed = meta.collapseSidebar || autoCollapsed || !!me?.user.preferences.sidebarCollapsed;
  const activeId = activeNavId(pathname);
  const item = activeId ? navItem(activeId) : undefined;
  const title = meta.title ?? (item ? t(item.label) : '');
  const crumb = meta.crumb ?? (activeId ? t(navGroupOf(activeId) ?? '') : '');
  const setMetaStable = useMemo(() => (m: PageMeta) => setMeta(m), []);

  return (
    <PageMetaCtx.Provider value={setMetaStable}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] bg-card px-3 py-2 rounded-control">
        {t('nav.skip')}
      </a>
      <div className="min-h-screen flex bg-bg text-fg">
        {!isMobile && (
          <aside className="sticky top-0 h-screen shrink-0 bg-sidebar border-r border-line">
            <Sidebar collapsed={collapsed} onToggle={() => setPreferences({ sidebarCollapsed: !me?.user.preferences.sidebarCollapsed })} />
          </aside>
        )}
        {isMobile && mobileOpen && (
          <div className="fixed inset-0 z-[70] flex" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="bg-sidebar border-r border-line h-full shadow-float">
              <Sidebar collapsed={false} mobile onNavigate={() => setMobileOpen(false)} />
            </div>
            <button type="button" aria-label="Menü schließen" className="flex-1 bg-[rgba(2,6,23,.55)]" onClick={() => setMobileOpen(false)} />
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="min-h-16 flex items-center gap-3 px-4 md:px-8 border-b border-line bg-bg/90 backdrop-blur sticky top-0 z-40">
            {isMobile && (
              <button type="button" aria-label={t('nav.menu')} onClick={() => setMobileOpen(true)} className="w-9 h-9 inline-flex items-center justify-center rounded-control border border-line bg-card">
                <Icon name="Menu" size={16} />
              </button>
            )}
            <div className="flex flex-col min-w-0 flex-1">
              {crumb && (
                <nav aria-label="Brotkrumen" className="flex items-center gap-1 text-meta text-fg-muted">
                  <Link to="/" className="!text-fg-muted hover:!text-fg">
                    LifeLink
                  </Link>
                  <Icon name="ChevronRight" size={12} />
                  <span className="truncate">{crumb}</span>
                </nav>
              )}
              <h1 className="m-0 text-topbar font-semibold truncate">{title}</h1>
            </div>
            <button type="button" onClick={() => setPaletteOpen(true)} aria-label={t('nav.searchLabel')} className="hidden lg:flex items-center gap-2 h-9 w-[320px] px-3 rounded-control border border-line bg-card text-fg-muted text-sm hover:bg-raised">
              <Icon name="Search" size={16} />
              <span className="flex-1 text-left truncate">{t('nav.search')}</span>
              <Kbd>Strg K</Kbd>
            </button>
            <button type="button" onClick={() => setPaletteOpen(true)} aria-label={t('nav.searchLabel')} className="lg:hidden w-9 h-9 rounded-control border border-line bg-card inline-flex items-center justify-center text-fg-muted">
              <Icon name="Search" size={16} />
            </button>
            <StatusPill />
            <NotificationsButton />
            <UserMenu />
          </header>
          <main id="main" className={cx('flex-1 min-w-0', meta.fullBleed ? '' : 'w-full max-w-content px-4 md:px-8 pt-7 pb-12 flex flex-col gap-5')}>
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </PageMetaCtx.Provider>
  );
}

export function RequirePerm({ perm, children }: { perm: string[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(...perm)) {
    return (
      <div className="py-20 text-center flex flex-col items-center gap-3">
        <Icon name="Lock" size={28} className="text-fg-muted" />
        <h2 className="m-0 text-title font-semibold">Kein Zugriff</h2>
        <p className="m-0 text-fg-muted">Für diesen Bereich fehlt dir die Berechtigung. Wende dich an eine Person mit Admin-Rechten.</p>
      </div>
    );
  }
  return <>{children}</>;
}
