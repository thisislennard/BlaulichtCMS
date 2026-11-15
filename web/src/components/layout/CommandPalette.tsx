import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { navigation } from '../../config/navigation';
import { t } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { cx, Kbd } from '../ui/core';
import { Icon } from '../ui/Icon';

interface Entry {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  href: string;
}

const TYPE_ICON: Record<string, string> = { post: 'FileText', collection: 'Images', user: 'User' };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { canAny, can, isPlatformAdmin } = useAuth();
  const input = useRef<HTMLInputElement>(null);

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

  const search = useQuery({ queryKey: ['search', debounced], queryFn: () => get(`/search?q=${encodeURIComponent(debounced)}`), enabled: open && debounced.length > 0 });

  const entries = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const pages: Entry[] = [];
    for (const g of navigation)
      for (const it of g.items) {
        if (it.adminOnly ? !isPlatformAdmin : it.perm && !canAny(...it.perm)) continue;
        pages.push({ id: `nav-${it.id}`, title: t(it.label), subtitle: t(g.group), icon: it.icon, href: it.path });
      }
    pages.push({ id: 'nav-help', title: t('nav.help'), subtitle: 'Anleitungen und Nachschlagewerk', icon: 'LifeBuoy', href: '/hilfe' });
    pages.push({ id: 'nav-profile', title: t('nav.profile'), subtitle: 'Passwort, Zwei-Faktor, Darstellung', icon: 'User', href: '/profil' });
    const actions: Entry[] = [];
    if (can('post.edit')) actions.push({ id: 'act-new', title: 'Neuer Beitrag', subtitle: 'Aktion', icon: 'Plus', href: '/?aktion=beitrag' });
    if (can('media.manage')) actions.push({ id: 'act-media', title: 'Medien sammeln', subtitle: 'Aktion', icon: 'Camera', href: '/?aktion=medien' });
    if (can('channel.manage')) actions.push({ id: 'act-site', title: 'Website koppeln', subtitle: 'Aktion', icon: 'Globe', href: '/kanaele' });
    const local = [...actions, ...pages].filter((e) => !ql || e.title.toLowerCase().includes(ql) || e.subtitle.toLowerCase().includes(ql));
    const remote: Entry[] = (search.data?.results ?? []).map((r: any) => ({ id: `${r.type}-${r.id}`, title: r.title, subtitle: r.subtitle, icon: TYPE_ICON[r.type] ?? 'Box', href: r.href }));
    return [...remote, ...local].slice(0, 30);
  }, [q, search.data, canAny, can, isPlatformAdmin]);

  useEffect(() => setActive(0), [debounced]);

  if (!open) return null;
  const go = (e: Entry) => {
    onClose();
    navigate(e.href);
  };
  return createPortal(
    <div className="fixed inset-0 z-[95] bg-scrim flex items-start justify-center pt-[12vh] px-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Suche und Befehle" className="w-full max-w-[600px] bg-card border border-line rounded-card shadow-float overflow-hidden">
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
        <ul id="cmd-list" role="listbox" className="list-none m-0 p-1.5 max-h-[420px] overflow-y-auto">
          {entries.map((e, i) => (
            <li key={e.id} role="option" aria-selected={i === active}>
              <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(e)} className={cx('w-full flex items-center gap-3 px-3 h-11 rounded-control text-left', i === active && 'bg-raised')}>
                <Icon name={e.icon} size={16} className="text-fg-muted shrink-0" />
                <span className="flex-1 min-w-0 truncate text-sm">{e.title}</span>
                <span className="text-meta text-fg-muted truncate max-w-[45%]">{e.subtitle}</span>
              </button>
            </li>
          ))}
          {!entries.length && <li className="px-3 py-6 text-sm text-fg-muted text-center">Keine Treffer.</li>}
        </ul>
        <div className="flex gap-4 px-4 py-2 border-t border-line text-meta text-fg-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> wählen
          </span>
          <span>
            <Kbd>Enter</Kbd> öffnen
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
