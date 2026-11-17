import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { t } from '../../i18n';
import { Icon } from '../ui/Icon';
import { Popover } from '../ui/overlays';

/** Hilfe-Adresse zu einem Thema („presse#textbausteine“ → „/hilfe/presse#textbausteine“). */
export function helpHref(topic: string | undefined): string {
  if (!topic) return '/hilfe';
  const [slug, anchor] = topic.split('#');
  return `/hilfe/${slug}${anchor ? `#${anchor}` : ''}`;
}

/**
 * „?“ am Seitentitel (#265): gleiches Aussehen wie `HelpTip`, Aufklappfenster mit der Kurzbeschreibung des Kapitels
 * und dem Weg ins Kapitel bzw. zum Abschnitt. Titel und Kurzbeschreibung stammen aus i18n/de/help.json, damit der
 * App-Rahmen die Hilfetexte selbst nicht laden muss.
 */
export function PageHelp({ topic }: { topic: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [slug, anchor] = topic.split('#');
  const title = t(`help.chapters.${slug}.title`);
  const summary = t(`help.chapters.${slug}.summary`);
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`${t('nav.pageHelp')}: ${title}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('nav.pageHelp')}
        onClick={() => setOpen((o) => !o)}
        className="text-fg-muted hover:text-fg w-7 h-7 inline-flex items-center justify-center rounded-chip hover:bg-raised focus-visible:shadow-ring outline-none shrink-0 align-middle"
      >
        <Icon name="CircleHelp" size={17} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={340}>
        <div role="dialog" aria-label={title} className="p-3 text-sm leading-relaxed flex flex-col gap-2 font-normal tracking-normal">
          <span className="font-mono text-label uppercase text-fg-muted">Hilfe</span>
          <strong className="text-fg text-base">{title}</strong>
          <p className="m-0 text-fg-muted">{summary}</p>
          <Link to={helpHref(topic)} onClick={() => setOpen(false)} className="self-start inline-flex items-center gap-1 pt-1 text-sm font-medium !text-fg underline underline-offset-2 hover:!text-primary">
            <Icon name="BookOpen" size={13} />
            {anchor ? 'Abschnitt in der Hilfe öffnen' : 'Kapitel öffnen'}
            <Icon name="ArrowRight" size={13} />
          </Link>
        </div>
      </Popover>
    </>
  );
}
