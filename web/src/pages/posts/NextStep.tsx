import type { ReactNode } from 'react';
import type { MediaItem } from '../../api/types';
import { Card, cx, Rev, StatusBadge } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { plural } from '../../lib/format';

/*
 * „Nächster Schritt“ im Beitrag (#262): der Weg Text → Medien (Sammlung → Sichtung → Übernahme) → Alternativtexte →
 * Ziele → Einreichen als kurze Liste, der erste offene Punkt hervorgehoben. Die Schritte sind reine Zustandsanzeige aus
 * dem Entwurf; was beim Einreichen geprüft wird, kommt vom Server (Prüfliste, SubmitCheck.tsx).
 */

export type StepKey = 'text' | 'medien' | 'alt' | 'ziele' | 'einreichen';
export type StepState = 'done' | 'todo' | 'open';
export interface Step {
  key: StepKey;
  state: StepState;
  label: string;
  detail?: string;
  /** Abschnitt im Beitrag (Anker) bzw. Sprung in die Sichtung / Übernahme */
  target?: { section: 'text' | 'medien' | 'website' } | { review: string } | { pick: string };
}

export interface StepInput {
  title: string;
  body: string;
  mediaIds: string[];
  media: Record<string, MediaItem | undefined>;
  mediaAlt: Record<string, string>;
  coverId: string | null;
  collections: { id: string; title: string; pending_count?: number; selected_ids?: string[] }[];
  /** Namen der gewählten Ziele (Website, soziale Netzwerke) */
  targets: string[];
}

export function draftSteps(x: StepInput): Step[] {
  const steps: Step[] = [];
  const paras = x.body.split(/\n\s*\n/).filter((p) => p.trim()).length;
  steps.push(x.title.trim().length >= 2 && x.body.trim() ? { key: 'text', state: 'done', label: 'Text', detail: `Titel, ${plural(paras, 'Absatz', 'Absätze')}` } : { key: 'text', state: 'todo', label: 'Text', detail: 'Titel und Text schreiben', target: { section: 'text' } });

  const pending = x.collections.filter((c) => (c.pending_count ?? 0) > 0);
  const pendingN = pending.reduce((n, c) => n + (c.pending_count ?? 0), 0);
  const notTaken = x.collections.map((c) => ({ c, n: (c.selected_ids ?? []).filter((id) => !x.mediaIds.includes(id)).length })).filter((e) => e.n > 0);
  if (pendingN) steps.push({ key: 'medien', state: 'todo', label: 'Medien', detail: `${plural(pendingN, 'Datei wartet', 'Dateien warten')} auf Sichtung`, target: { review: pending[0].id } });
  else if (notTaken.length) steps.push({ key: 'medien', state: 'todo', label: 'Medien', detail: `${plural(notTaken.reduce((n, e) => n + e.n, 0), 'ausgewählte Datei', 'ausgewählte Dateien')} noch nicht übernommen`, target: { pick: notTaken[0].c.id } });
  else if (x.mediaIds.length) steps.push({ key: 'medien', state: 'done', label: 'Medien', detail: `${plural(x.mediaIds.length, 'Datei', 'Dateien')}${x.coverId ? ' · Titelbild gesetzt' : ''}` });
  else steps.push({ key: 'medien', state: 'open', label: 'Medien', detail: 'noch keine (optional)', target: { section: 'medien' } });

  const images = x.mediaIds.filter((id) => x.media[id]?.kind === 'image');
  const withAlt = images.filter((id) => (x.mediaAlt[id] ?? x.media[id]?.alt_text ?? '').trim()).length;
  steps.push(images.length ? { key: 'alt', state: withAlt === images.length ? 'done' : 'todo', label: `Alternativtexte (${withAlt} von ${images.length})`, target: withAlt === images.length ? undefined : { section: 'medien' } } : { key: 'alt', state: 'open', label: 'Alternativtexte (0 von 0)', detail: 'keine Bilder' });

  steps.push(x.targets.length ? { key: 'ziele', state: 'done', label: 'Ziele', detail: x.targets.join(', ') } : { key: 'ziele', state: 'todo', label: 'Ziele', detail: 'nur intern – Website oder Netzwerk wählen', target: { section: 'website' } });
  return steps;
}

const ICON: Record<StepState, { name: string; cls: string; sr: string }> = {
  done: { name: 'CircleCheck', cls: 'text-ok', sr: 'erledigt' },
  todo: { name: 'AlertTriangle', cls: 'text-warn', sr: 'offen' },
  open: { name: 'CircleDashed', cls: 'text-fg-muted', sr: 'noch nicht begonnen' },
};

/** Liste der Schritte; `action` je Schritt (Sprung, Übernehmen …), `submit` als letzter Schritt. */
export function NextStepCard({ id, state, revision, notice, steps, actionFor, submit }: { id?: string; state: string; revision: number; notice?: ReactNode; steps: Step[]; actionFor: (s: Step) => ReactNode; submit: { detail?: ReactNode; action?: ReactNode } }) {
  const next = steps.find((s) => s.state === 'todo')?.key ?? 'einreichen';
  return (
    <Card
      id={id}
      title="Nächster Schritt"
      action={
        <span className="flex items-center gap-2">
          <StatusBadge status={state} />
          <Rev n={revision} className="text-fg-muted" />
        </span>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {notice}
        <ol className="m-0 p-0 list-none flex flex-col">
          {[...steps, { key: 'einreichen' as const, state: 'open' as const, label: 'Einreichen' }].map((s) => {
            const ic = ICON[s.state];
            const isNext = s.key === next;
            const action = s.key === 'einreichen' ? submit.action : actionFor(s);
            return (
              <li key={s.key} aria-current={isNext ? 'step' : undefined} className={cx('flex flex-col gap-1.5 px-2 py-2 rounded-control', isNext && 'bg-raised')}>
                <div className="flex items-start gap-2">
                  <Icon name={s.key === 'einreichen' && isNext ? 'Send' : ic.name} size={16} className={cx('mt-0.5 shrink-0', s.key === 'einreichen' ? 'text-fg-muted' : ic.cls)} />
                  <span className="min-w-0 flex-1">
                    <span className="sr-only">{s.key === 'einreichen' ? '' : `${ic.sr}: `}</span>
                    <span className={cx(isNext ? 'font-semibold' : 'font-medium')}>{s.label}</span>
                    {s.key === 'einreichen' ? submit.detail && <span className="block text-meta text-fg-muted">{submit.detail}</span> : s.detail && <span className="block text-meta text-fg-muted break-words">{s.detail}</span>}
                  </span>
                  {s.key !== 'einreichen' && action}
                </div>
                {s.key === 'einreichen' && action}
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}
