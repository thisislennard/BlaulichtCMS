import { forwardRef, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import { MOBILE_TABS, QUICK_ACTIONS, type NavItem, type QuickAction } from '../../config/navigation';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { cx, Spinner } from '../ui/core';
import { Icon } from '../ui/Icon';
import { useErrorToast } from '../ui/overlays';

// Dialoge der Schnellaktionen erst beim Öffnen laden (gehören zu den jeweiligen Seiten)
const NewCollectionDialog = lazy(() => import('../../pages/media/Collections').then((m) => ({ default: m.NewCollectionDialog })));
const NewPostDialog = lazy(() => import('../../pages/posts/Posts').then((m) => ({ default: m.NewPostDialog })));
const RequestDialog = lazy(() => import('../../pages/press/shared').then((m) => ({ default: m.RequestDialog })));

type VisibleItem = NavItem & { count: number };

/** Sind gerade Texteingaben offen? Dann tritt die Leiste zurück (Bildschirmtastatur, kein verdecktes Feld). */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const check = () => {
      const el = document.activeElement as HTMLElement | null;
      const field = !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color'].includes((el as HTMLInputElement).type)));
      setTyping(field);
    };
    const later = () => setTimeout(check, 0);
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', check);
      document.removeEventListener('focusout', later);
    };
  }, []);
  return typing;
}

const TabButton = forwardRef<HTMLButtonElement, { icon: string; label: string; expanded: boolean; onClick: () => void; strong?: boolean }>(function TabButton({ icon, label, expanded, onClick, strong }, ref) {
  return (
    <button ref={ref} type="button" aria-haspopup="dialog" aria-expanded={expanded} onClick={onClick} className="w-full h-full flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-fg-muted hover:text-fg">
      {strong ? (
        // Neutral umrandet: Rot bleibt der Hauptaktion der jeweiligen Seite vorbehalten (Design §1)
        <span className="w-10 h-8 rounded-control bg-raised border border-line text-fg inline-flex items-center justify-center">
          <Icon name={icon} size={20} />
        </span>
      ) : (
        <Icon name={icon} size={20} strokeWidth={1.8} />
      )}
      {label}
    </button>
  );
});

/**
 * Untere Leiste am Handy (< 768 px, #264): drei Ziele aus der Navigation (`MOBILE_TABS`, nach Rechten), in der Mitte
 * die Schnellaktionen (`QUICK_ACTIONS`), rechts „Mehr“ = die Schublade mit allen Bereichen. Freigaben tragen ihren
 * Zähler. Solange ein Textfeld bearbeitet wird, ist die Leiste ausgeblendet. Feste Elemente unten (Speicherleisten)
 * rechnen mit `var(--bc-bottom-bar)`.
 */
export function MobileTabBar({ items, activeId, moreOpen, onMore, moreRef }: { items: VisibleItem[]; activeId: string | null; moreOpen: boolean; onMore: () => void; moreRef: React.RefObject<HTMLButtonElement | null> }) {
  const { canAny } = useAuth();
  const typing = useTyping();
  const [sheet, setSheet] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const byId = new Map(items.map((i) => [i.id, i]));
  const tabs = MOBILE_TABS.map((id) => byId.get(id)).filter((x): x is VisibleItem => !!x).slice(0, 3);
  const actions = QUICK_ACTIONS.filter((a) => canAny(...a.perm));
  const link = (it: VisibleItem) => {
    const on = it.id === activeId;
    return (
      <Link to={it.path} aria-current={on ? 'page' : undefined} className={cx('w-full h-full flex flex-col items-center justify-center gap-0.5 text-[11px]', on ? '!text-fg font-semibold' : '!text-fg-muted font-medium hover:!text-fg')}>
        <span className="relative">
          <Icon name={it.icon} size={20} strokeWidth={1.8} className={cx(on && 'text-primary')} />
          {it.count > 0 && (
            <span className={cx('absolute -top-1.5 -right-3 min-w-[18px] h-[18px] px-[5px] rounded-full text-[11px] font-semibold font-mono inline-flex items-center justify-center', it.badge === 'approvals' ? 'bg-primary-solid text-on-primary' : 'bg-raised text-fg-muted')} aria-label={`${it.count} neu`}>
              {it.count}
            </span>
          )}
        </span>
        <span className="max-w-full truncate px-0.5">{t(it.label)}</span>
      </Link>
    );
  };
  const cells = [tabs[0], tabs[1], 'plus', tabs[2], 'more'] as const;
  return (
    <>
      <nav aria-label="Schnellzugriff" data-visible={!typing} className={cx('bc-tabbar md:hidden fixed bottom-0 inset-x-0 z-[60] bg-card border-t border-line pb-[env(safe-area-inset-bottom)] print:hidden', typing && 'hidden')}>
        <ul className="m-0 p-0 list-none grid grid-cols-5 h-[60px]">
          {cells.map((c, i) => (
            <li key={i} className="min-w-0">
              {c === 'plus' ? (
                actions.length > 0 ? <TabButton ref={plusRef} icon="Plus" label="Aktionen" strong expanded={sheet} onClick={() => setSheet(true)} /> : null
              ) : c === 'more' ? (
                <TabButton ref={moreRef} icon="Menu" label="Mehr" expanded={moreOpen} onClick={onMore} />
              ) : c ? (
                link(c)
              ) : null}
            </li>
          ))}
        </ul>
      </nav>
      {sheet && <QuickSheet actions={actions} onClose={() => (setSheet(false), plusRef.current?.focus())} />}
    </>
  );
}

/** Schnellaktionen als Blatt über der Leiste (Dialog: Escape schließt, Fokus bleibt darin). */
function QuickSheet({ actions, onClose }: { actions: QuickAction[]; onClose: () => void }) {
  const nav = useNavigate();
  const toastError = useErrorToast();
  const { can } = useAuth();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<QuickAction['id'] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useQuery({ queryKey: ['collections', 'pending'], queryFn: () => get<{ items: { id: string; title: string; pending_count: number }[] }>(`/collections${qs({ paged: 1, status: 'active', pending: 1, perPage: 6 })}`), enabled: can('media.review') });
  useEffect(() => {
    if (open) return;
    const el = box.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) (e.preventDefault(), f[f.length - 1].focus());
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) (e.preventDefault(), f[0].focus());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const go = (to: string) => {
    onClose();
    nav(to);
  };
  const run = async (a: QuickAction) => {
    if (a.id === 'warning') {
      setBusy(true);
      try {
        const r = await post<{ id: string }>('/warnings', { kind: 'initial' });
        go(`/warnungen/${r.id}`);
      } catch (e) {
        toastError(e);
        setBusy(false);
      }
      return;
    }
    // Eine Sammlung offen: direkt in die Sichtung; mehrere stehen darunter zur Wahl, sonst alle offenen Dateien
    if (a.id === 'review') return go(pend.length === 1 ? `/medien/${pend[0].id}?sichten=1` : '/medien/dateien?sichtung=pending');
    setOpen(a.id);
  };
  const itemCls = 'w-full flex items-center gap-3 min-h-14 px-3 rounded-control text-left hover:bg-raised !text-fg';
  const pend = (pending.data?.items ?? []).filter((c) => c.pending_count > 0);
  if (open === 'collect') return <Suspense fallback={null}><NewCollectionDialog open title="Fotos sammeln" onClose={onClose} /></Suspense>;
  if (open === 'post') return <Suspense fallback={null}><NewPostDialog onClose={onClose} /></Suspense>;
  if (open === 'press') return <Suspense fallback={null}><RequestDialog onClose={(id) => (id ? go(`/presse/${id}`) : onClose())} /></Suspense>;
  return (
    <div className="fixed inset-0 z-[80] md:hidden flex flex-col justify-end bg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="quick-sheet-title" className="bg-card border-t border-line rounded-t-card shadow-float px-3 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-2 pb-2">
          <h2 id="quick-sheet-title" className="m-0 text-section font-semibold">
            Schnellaktionen
          </h2>
          <button type="button" aria-label="Schließen" onClick={onClose} className="w-10 h-10 inline-flex items-center justify-center rounded-chip text-fg-muted hover:text-fg hover:bg-raised">
            <Icon name="X" size={18} />
          </button>
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {actions.map((a) => (
            <li key={a.id}>
              <button type="button" disabled={busy} className={itemCls} onClick={() => void run(a)}>
                <span className="w-10 h-10 rounded-control bg-raised inline-flex items-center justify-center shrink-0">{busy && a.id === 'warning' ? <Spinner /> : <Icon name={a.icon} size={18} />}</span>
                <span className="flex flex-col min-w-0">
                  <span className="font-medium">{a.label}</span>
                  <span className="text-meta text-fg-muted">{a.id === 'review' && pending.data ? (pend.length ? `${pend.reduce((n, c) => n + c.pending_count, 0)} offen in ${pend.length === 1 ? 'einer Sammlung' : `${pend.length} Sammlungen`}` : 'Nichts zu sichten') : a.hint}</span>
                </span>
              </button>
              {a.id === 'review' && pend.length > 0 && (
                <ul className="m-0 p-0 pl-[52px] list-none flex flex-col">
                  {pend.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="w-full flex items-center justify-between gap-3 min-h-11 px-3 rounded-control text-left text-sm hover:bg-raised" onClick={() => go(`/medien/${c.id}?sichten=1`)}>
                        <span className="truncate">{c.title}</span>
                        <span className="font-mono text-meta text-fg-muted shrink-0">{c.pending_count} offen</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
