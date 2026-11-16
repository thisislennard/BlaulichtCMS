import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get } from '../../api/client';
import { cx } from '../ui/core';

/* Datenschutzerklärung und Impressum (#187): Links nur, wenn unter Einstellungen → Datenschutz ein Text hinterlegt ist. */

export interface LegalState {
  privacy: boolean;
  imprint: boolean;
}

export function useLegal() {
  return useQuery({ queryKey: ['public-legal'], queryFn: () => get<LegalState>('/public/legal'), staleTime: 5 * 60_000, retry: false });
}

/** „Datenschutz · Impressum“ als leise Fußzeile; ohne hinterlegte Texte nichts. */
export function LegalLinks({ className, newTab }: { className?: string; newTab?: boolean }) {
  const q = useLegal();
  const links = [q.data?.privacy && { to: '/datenschutz', label: 'Datenschutz' }, q.data?.imprint && { to: '/impressum', label: 'Impressum' }].filter(Boolean) as { to: string; label: string }[];
  if (!links.length) return null;
  return (
    <nav aria-label="Rechtliches" className={cx('flex items-center justify-center gap-2 text-meta text-fg-muted', className)}>
      {links.map((l, i) => (
        <span key={l.to} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden="true">·</span>}
          {newTab ? (
            <a href={l.to} target="_blank" rel="noopener" className="!text-fg-muted hover:!text-fg">
              {l.label}
            </a>
          ) : (
            <Link to={l.to} className="!text-fg-muted hover:!text-fg">
              {l.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
