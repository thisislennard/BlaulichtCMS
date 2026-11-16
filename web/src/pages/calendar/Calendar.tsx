import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, qs } from '../../api/client';
import { Button, cx, ErrorBox, PageHeader, SegmentedControl, Select, SkeletonRows } from '../../components/ui/core';
import { HelpTip } from '../../components/ui/HelpTip';
import { useAuth } from '../../lib/auth';
import { fromLocalInput } from '../../lib/format';
import { CategoriesDialog, EntryDialog, EventDialog, type EditTarget } from './dialogs';
import { SourcesDialog, SubscribeDialog } from './ical';
import { dayStart, shift, today, viewRange, type CalendarCategory, type CalendarEntry, type View } from './model';
import { ListView, MonthView, WeekView } from './views';
import { RescheduleForm, usePlanning, useReschedule } from './planning';
import { DndContext } from '@dnd-kit/core';

/**
 * Kalender (#200): eigene und eingelesene Termine, Kategorien mit Farben, Wiederholungen; Monat, Woche und Liste
 * (am Handy Liste als Standard), Filter nach Kategorie und Quelle.
 */

const VIEW_KEY = 'bc.calendar.view';
function initialView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'month' || v === 'week' || v === 'list') return v;
  } catch {
    /* ohne Speicher */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches ? 'list' : 'month';
}

interface EntriesResponse {
  timeZone: string;
  entries: CalendarEntry[];
  truncated: boolean;
  sources: { id: string; label: string }[];
}

export default function CalendarPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [view, setViewState] = useState<View>(initialView);
  const [anchor, setAnchor] = useState(today());
  const [cats, setCats] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<CalendarEntry | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [dialog, setDialog] = useState<'categories' | 'sources' | 'subscribe' | null>(null);
  const canManage = can('calendar.manage');
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ohne Speicher */
    }
  };

  const range = viewRange(view, anchor);
  const categories = useQuery({ queryKey: ['calendar', 'categories'], queryFn: () => get<CalendarCategory[]>('/calendar/categories') });
  const q = useQuery({
    queryKey: ['calendar', 'entries', range.from, range.to, cats.join(','), source],
    queryFn: () => get<EntriesResponse>(`/calendar/entries${qs({ from: dayStart(range.from), to: dayStart(range.to), categories: cats.join(',') || undefined, sources: source || undefined })}`),
    placeholderData: (prev) => prev,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['calendar'] });
  const entries = q.data?.entries ?? [];
  const month = view === 'month' ? Number(anchor.slice(5, 7)) - 1 : undefined;

  const newAt = (day: string) => {
    if (!canManage) return;
    setEdit({ start: fromLocalInput(`${day}T10:00`)!, end: fromLocalInput(`${day}T11:00`)! });
  };

  const toggleCat = (id: string) => setCats((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const sources = q.data?.sources ?? [{ id: 'own', label: 'Eigene Termine' }];
  const reschedule = useReschedule(refresh);
  const planning = usePlanning(can('post.edit'), reschedule);
  const viewProps = { entries, from: range.from, to: range.to, month, onOpen: setOpen, onDay: canManage ? newAt : undefined, wrapEntry: planning.wrapEntry, wrapDay: planning.wrapDay };

  const catChips = useMemo(() => [...(categories.data ?? []).map((c) => ({ id: c.id, name: c.name, color: `var(--bc-cal-${c.color})` })), { id: 'none', name: 'Ohne Kategorie', color: 'var(--bc-cal-grau)' }], [categories.data]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Kalender
            <HelpTip title="Kalender" more="/hilfe/kalender">
              Eigene Termine und Serien, eingelesene Kalender und geplante Beiträge an einem Ort. Kategorien geben Farben und dienen als Filter – auch für Workflows.
            </HelpTip>
          </span>
        }
        subtitle="Termine, Serien und Planung"
        actions={
          <>
            {can('calendar.subscribe') && (
              <Button icon="Link2" onClick={() => setDialog('subscribe')}>
                Abonnieren
              </Button>
            )}
            {can('calendar.sources') && (
              <Button icon="Download" onClick={() => setDialog('sources')}>
                iCal-Kalender
              </Button>
            )}
            {canManage && (
              <>
                <Button icon="Tags" onClick={() => setDialog('categories')}>
                  Kategorien
                </Button>
                <Button variant="primary" icon="Plus" onClick={() => setEdit({})}>
                  Neuer Termin
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <Button icon="ChevronLeft" iconOnly aria-label="Zurück" onClick={() => setAnchor(shift(view, anchor, -1))} />
          <Button onClick={() => setAnchor(today())}>Heute</Button>
          <Button icon="ChevronRight" iconOnly aria-label="Weiter" onClick={() => setAnchor(shift(view, anchor, 1))} />
          <h3 className="m-0 text-section font-semibold ml-1" aria-live="polite">
            {range.title}
          </h3>
        </div>
        <SegmentedControl<View>
          label="Ansicht"
          value={view}
          onChange={setView}
          options={[
            { value: 'month', label: 'Monat' },
            { value: 'week', label: 'Woche' },
            { value: 'list', label: 'Liste' },
          ]}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div role="group" aria-label="Nach Kategorie filtern" className="flex flex-wrap gap-1.5">
          {catChips.map((c) => {
            const on = cats.includes(c.id);
            return (
              <button key={c.id} type="button" aria-pressed={on} onClick={() => toggleCat(c.id)} className={cx('h-8 px-2.5 rounded-full border text-sm inline-flex items-center gap-1.5', on ? 'bg-raised border-fg text-fg' : 'border-line text-fg-muted hover:text-fg')}>
                <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} />
                {c.name}
              </button>
            );
          })}
          {cats.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setCats([])}>
              Alle Kategorien
            </Button>
          )}
        </div>
        <div className="ml-auto w-[220px]">
          <Select aria-label="Nach Quelle filtern" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Alle Quellen</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {q.error ? (
        <ErrorBox title="Kalender konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>
      ) : !q.data ? (
        <SkeletonRows rows={8} />
      ) : (
        <DndContext {...planning.dnd}>
          {view === 'month' ? <MonthView {...viewProps} /> : view === 'week' ? <WeekView {...viewProps} /> : <ListView {...viewProps} />}
          {planning.overlay}
        </DndContext>
      )}
      {q.data?.truncated && <p className="m-0 text-meta text-fg-muted">Sehr viele Einträge – nicht alle werden angezeigt. Bitte filtern.</p>}

      {open && (
        <EntryDialog
          entry={open}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onEdit={(t) => {
            setOpen(null);
            setEdit(t);
          }}
          onChanged={() => {
            setOpen(null);
            refresh();
          }}
          extra={open.kind === 'post' && open.movable ? <RescheduleForm entry={open} reschedule={reschedule} onDone={() => setOpen(null)} /> : undefined}
        />
      )}
      {edit && (
        <EventDialog
          target={edit}
          categories={categories.data ?? []}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            refresh();
          }}
        />
      )}
      {dialog === 'categories' && <CategoriesDialog categories={categories.data ?? []} onClose={() => setDialog(null)} />}
      {dialog === 'sources' && <SourcesDialog categories={categories.data ?? []} onClose={() => setDialog(null)} />}
      {dialog === 'subscribe' && <SubscribeDialog categories={categories.data ?? []} onClose={() => setDialog(null)} />}
    </div>
  );
}
