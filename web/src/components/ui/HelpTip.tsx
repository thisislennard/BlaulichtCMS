import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from './Icon';
import { Popover } from './overlays';

/**
 * Kleiner Hilfe-Knopf (Fragezeichen) mit Erklärung im Aufklappfenster – für Felder, deren Werte man erst nachschlagen
 * muss. Gedacht für `FieldWrap labelAction={…}`. `more` verweist auf den passenden Abschnitt der Hilfe
 * (z. B. `/hilfe/verbindungen#meta-app-anlegen`).
 */
export function HelpTip({ title, children, width = 340, more }: { title: string; children: ReactNode; width?: number; more?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`Hilfe: ${title}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Hilfe"
        onClick={() => setOpen((o) => !o)}
        className="text-fg-muted hover:text-fg w-6 h-6 inline-flex items-center justify-center rounded-chip hover:bg-raised focus-visible:shadow-ring outline-none"
      >
        <Icon name="CircleHelp" size={15} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} align="end" width={width}>
        <div role="dialog" aria-label={title} className="p-3 text-sm leading-relaxed flex flex-col gap-2">
          <strong className="text-fg">{title}</strong>
          {children}
          {more && (
            <Link to={more} onClick={() => setOpen(false)} className="self-start inline-flex items-center gap-1 pt-1 text-sm font-medium !text-fg underline underline-offset-2 hover:!text-primary">
              <Icon name="BookOpen" size={13} />
              Ausführlich in der Hilfe
            </Link>
          )}
        </div>
      </Popover>
    </>
  );
}

/** Externer Link im Hilfetext (neuer Tab, ohne Weitergabe der Herkunft). */
export function HelpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="!text-fg underline underline-offset-2 hover:!text-primary inline-flex items-center gap-1">
      {children}
      <Icon name="ExternalLink" size={12} />
      <span className="sr-only"> (öffnet in neuem Tab)</span>
    </a>
  );
}
