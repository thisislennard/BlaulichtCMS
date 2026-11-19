import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { navigation } from '../../config/navigation';
import { SETTINGS_INDEX } from '../../config/settingsIndex';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { rank, searchTerms } from '../../lib/searchText';
import { cx, Kbd } from '../ui/core';
import { Icon } from '../ui/Icon';

/**
 * Suche und Befehle (Strg K, #259): Seiten, Aktionen, Inhalte aller Bereiche mit Leserecht (Server: GET /search),
 * Einstellungen (config/settingsIndex.ts) und Hilfe (Volltext der Kapitel, erst beim Suchen geladen). Treffer stehen
 * gruppiert, höchstens fünf je Gruppe; „Alle Treffer in …“ führt in die gefilterte Liste. Vorgangsnummern
 * (P-2026-0001, W-2026-0001) stehen als „Direkt öffnen“ ganz oben – Enter öffnet sie.
 */
interface Entry {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  href: string;
  group: string;
  /** „Alle Treffer in …“ */
  more?: boolean;
}

const MAX = 5;
const TYPE_ICON: Record<string, string> = {
  post: 'FileText',
  collection: 'Images',
  user: 'User',
  press: 'MessageSquareQuote',
  incident: 'ListOrdered',
  event: 'CalendarDays',
  warning: 'Siren',
  design: 'Palette',
  banner: 'Megaphone',
  automation: 'Workflow',
  connection: 'Plug',
  site: 'Globe',
  template: 'LayoutTemplate',
  release: 'Newspaper',
};
const SERVER_GROUPS = ['Beiträge', 'Presse', 'Einsatzliste', 'Kalender', 'Warnentwürfe', 'Medien', 'Designvorlagen', 'Banner', 'Workflows', 'Verbindungen', 'Websites', 'Beitragsvorlagen', 'Pressemitteilungen', 'Personen'];
const ORDER = ['Direkt öffnen', 'Aktionen', 'Seiten', ...SERVER_GROUPS, 'Einstellungen', 'Hilfe'];

type HelpModule = { search: typeof import('../../pages/help/search').search; docs: ReturnType<typeof import('../../pages/help/search').markdownDocs>; chapterTitle: (slug: string) => string };
let helpModule: Promise<HelpModule> | null = null;
/** Hilfe-Index nur bei Bedarf laden (eigener Teil des Pakets, wie die Hilfe-Seite). */
function loadHelp(): Promise<HelpModule> {
  helpModule ??= Promise.all([import('../../pages/help/search'), import('../../pages/help/chapters')]).then(([s, c]) => ({ search: s.search, docs: s.markdownDocs(), chapterTitle: c.chapterTitle }));
  return helpModule;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [help, setHelp] = useState<HelpModule | null>(null);
  const navigate = useNavigate();
  const { canAny, can, isPlatformAdmin } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (open && q.trim().length >= 2 && !help) void loadHelp().then(setHelp);
  }, [open, q, help]);

  const search = useQuery({ queryKey: ['search', debounced], queryFn: () => get<{ results: any[]; more?: Record<string, string> }>(`/search?q=${encodeURIComponent(debounced)}`), enabled: open && debounced.length > 0 });

  const entries = useMemo(() => {
    const query = q.trim();
    const terms = searchTerms(query);
    const out: Entry[] = [];
    // Seiten und Aktionen (lokal, nach Rechten)
    const pages: (Entry & { extra: string })[] = [];
    for (const g of navigation)
      for (const it of g.items) {
        if (it.adminOnly ? !isPlatformAdmin : it.perm && !canAny(...it.perm)) continue;
        pages.push({ id: `nav-${it.id}`, title: t(it.label), subtitle: t(g.group), icon: it.icon, href: it.path, group: 'Seiten', extra: t(g.group) });
      }
    // Websites sind eine Unterseite von Verbindungen (kein eigener Menüpunkt), bleiben aber per Suche erreichbar
    if (can('channel.view')) pages.push({ id: 'nav-sites', title: 'Websites', subtitle: 'Einrichtung · Verbindungen', icon: 'Globe', href: '/verbindungen/websites', group: 'Seiten', extra: 'WordPress Bridge Kopplung Plugin' });
    pages.push({ id: 'nav-help', title: t('nav.help'), subtitle: 'Anleitungen und Nachschlagewerk', icon: 'LifeBuoy', href: '/hilfe', group: 'Seiten', extra: 'Anleitung Handbuch' });
    pages.push({ id: 'nav-profile', title: t('nav.profile'), subtitle: 'Passwort, Zwei-Faktor, Benachrichtigungen', icon: 'User', href: '/profil', group: 'Seiten', extra: 'Profil Passwort' });
    const actions: (Entry & { extra: string })[] = [];
    if (can('post.create')) actions.push({ id: 'act-new', title: 'Neuer Beitrag', subtitle: 'Aktion', icon: 'Plus', href: '/?aktion=beitrag', group: 'Aktionen', extra: 'Beitrag schreiben' });
    if (can('media.collections')) actions.push({ id: 'act-media', title: 'Fotos sammeln', subtitle: 'Aktion · Sammlung mit Upload-Link', icon: 'Camera', href: '/?aktion=medien', group: 'Aktionen', extra: 'Upload-Link Sammlung Medien QR-Code' });
    if (can('channel.sites')) actions.push({ id: 'act-site', title: 'Website koppeln', subtitle: 'Aktion', icon: 'Globe', href: '/verbindungen/websites', group: 'Aktionen', extra: 'WordPress Bridge' });
    const local = (list: (Entry & { extra: string })[]) =>
      !terms.length
        ? list
        : list
            .map((e) => ({ e, r: rank(terms, e.title, e.extra) }))
            .filter((x) => x.r !== null)
            .sort((a, b) => a.r! - b.r!)
            .map((x) => x.e);
    // Vorgangsnummern zuerst
    const remote: any[] = query ? (search.data?.results ?? []) : [];
    for (const r of remote.filter((x) => x.exact)) out.push({ id: `exact-${r.type}-${r.id}`, title: r.title, subtitle: r.subtitle, icon: TYPE_ICON[r.type] ?? 'Box', href: r.href, group: 'Direkt öffnen' });
    out.push(...local(actions).slice(0, terms.length ? MAX : undefined));
    out.push(...local(pages).slice(0, terms.length ? MAX : undefined));
    if (terms.length) {
      // Inhalte vom Server, gruppiert
      for (const r of remote.filter((x) => !x.exact)) out.push({ id: `${r.type}-${r.id}`, title: r.title, subtitle: r.subtitle, icon: TYPE_ICON[r.type] ?? 'Box', href: r.href, group: r.group });
      for (const [group, href] of Object.entries(search.data?.more ?? {})) out.push({ id: `more-${group}`, title: `Alle Treffer in ${group}`, subtitle: '', icon: 'ArrowRight', href, group, more: true });
      // Einstellungen
      const settings = SETTINGS_INDEX.filter((s) => !s.perm.length || canAny(...s.perm))
        .map((s) => ({ s, r: rank(terms, s.title, `${s.keywords} ${s.where}`) }))
        .filter((x) => x.r !== null)
        .sort((a, b) => a.r! - b.r!)
        .slice(0, MAX);
      for (const { s } of settings) out.push({ id: `set-${s.href}-${s.title}`, title: s.title, subtitle: s.where, icon: 'Settings', href: s.href, group: 'Einstellungen' });
      // Hilfe (Volltext)
      if (help && query.length >= 2) {
        const hits = help.search(query, help.docs, MAX + 1);
        for (const h of hits.slice(0, MAX))
          out.push({ id: `help-${h.doc.chapter}-${h.doc.anchor}`, title: h.doc.anchor ? h.doc.heading : help.chapterTitle(h.doc.chapter), subtitle: h.doc.anchor ? `Hilfe › ${help.chapterTitle(h.doc.chapter)}` : 'Hilfe', icon: 'BookOpen', href: `/hilfe/${h.doc.chapter}${h.doc.anchor ? `#${h.doc.anchor}` : ''}`, group: 'Hilfe' });
        if (hits.length > MAX) out.push({ id: 'more-help', title: 'Alle Treffer in der Hilfe', subtitle: '', icon: 'ArrowRight', href: `/hilfe?suche=${encodeURIComponent(query)}`, group: 'Hilfe', more: true });
      }
    }
    // Gruppen in fester Reihenfolge, „Alle Treffer“ am Ende der Gruppe
    const rankOf = (g: string) => (ORDER.indexOf(g) < 0 ? ORDER.length : ORDER.indexOf(g));
    return out.map((e, i) => ({ e, i })).sort((a, b) => rankOf(a.e.group) - rankOf(b.e.group) || Number(!!a.e.more) - Number(!!b.e.more) || a.i - b.i).map((x) => x.e);
  }, [q, search.data, canAny, can, isPlatformAdmin, help]);

  useEffect(() => setActive(0), [debounced, entries.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const go = (e: Entry) => {
    onClose();
    navigate(e.href);
  };
  const loading = q.trim().length > 0 && (q.trim() !== debounced || search.isFetching);
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[95] bg-scrim flex items-start justify-center pt-[12vh] px-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Suche und Befehle" className="w-full max-w-[640px] bg-card border border-line rounded-card shadow-float overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 h-[52px] border-b border-line">
          <Icon name="Search" size={18} className="text-fg-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('nav.search')}
            aria-label={t('nav.searchLabel')}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={entries[active] ? `cmd-opt-${active}` : undefined}
            className="flex-1 bg-transparent outline-none text-base"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(entries.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && entries[active]) go(entries[active]);
              else if (e.key === 'Escape') onClose();
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul ref={listRef} id="cmd-list" role="listbox" aria-label="Treffer" className="list-none m-0 p-1.5 max-h-[min(460px,60vh)] overflow-y-auto">
          {entries.map((e, i) => {
            const header = e.group !== lastGroup;
            lastGroup = e.group;
            return [
              header && (
                <li key={`h-${e.group}`} role="presentation" className="px-3 pt-2.5 pb-1 font-mono text-label uppercase text-fg-muted">
                  {e.group}
                </li>
              ),
              <li key={e.id} id={`cmd-opt-${i}`} data-index={i} role="option" aria-selected={i === active}>
                <button type="button" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => go(e)} className={cx('w-full flex items-center gap-3 px-3 h-11 rounded-control text-left', i === active && 'bg-raised')}>
                  <Icon name={e.icon} size={16} className="text-fg-muted shrink-0" />
                  <span className={cx('flex-1 min-w-0 truncate text-sm', e.more && 'text-fg-link')}>{e.title}</span>
                  {e.subtitle && <span className="text-meta text-fg-muted truncate max-w-[45%]">{e.subtitle}</span>}
                </button>
              </li>,
            ];
          })}
          {!entries.length && !loading && <li className="px-3 py-6 text-sm text-fg-muted text-center">Keine Treffer.</li>}
          {!entries.length && loading && <li className="px-3 py-6 text-sm text-fg-muted text-center">Suche läuft …</li>}
        </ul>
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 border-t border-line text-meta text-fg-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> wählen
          </span>
          <span>
            <Kbd>Enter</Kbd> öffnen
          </span>
          <span className="ml-auto">Seiten, Inhalte, Einstellungen und Hilfe</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
