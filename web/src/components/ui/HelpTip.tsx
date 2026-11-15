import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Popover } from './overlays';

/**
 * Kleiner Hilfe-Knopf (Fragezeichen) mit Erklärung im Aufklappfenster – für Felder, deren Werte man erst nachschlagen
 * muss. Gedacht für `FieldWrap labelAction={…}`.
 */
export function HelpTip({ title, children, width = 340 }: { title: string; children: ReactNode; width?: number }) {
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
        </div>
      </Popover>
    </>
  );
}

/** Externer Link im Hilfetext (neuer Tab, ohne Weitergabe der Herkunft). */
export function HelpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 inline-flex items-center gap-1">
      {children}
      <Icon name="ExternalLink" size={12} />
    </a>
  );
}
