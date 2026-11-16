import { useState, type ReactNode } from 'react';
import { DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { post } from '../../api/client';
import { Button, cx, FieldWrap, Input } from '../../components/ui/core';
import { useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { fmtDateTime, fromLocalInput, toLocalInput } from '../../lib/format';
import { pad, timeOf, type CalendarEntry } from './model';
import { EntryChip } from './views';

/**
 * Geplante Beiträge verschieben (#201): Ziehen und Ablegen in Monat und Woche (Maus und Finger) sowie als
 * tastaturbedienbare Alternative „Termin ändern“ im Eintrag. Der Termin gehört zur Fassung eines Beitrags – ist er
 * Teil einer freigegebenen oder eingereichten Fassung, fragt der Kalender vorher nach (neue Fassung, neue Freigabe).
 */

interface ScheduleResult {
  changed: boolean;
  number: number;
  approvalInvalidated: boolean;
  wasSubmitted: boolean;
}

export function useReschedule(onDone: () => void) {
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  return async (e: CalendarEntry, publishAt: string) => {
    if (Date.parse(publishAt) === Date.parse(e.start)) return false;
    if (Date.parse(publishAt) < Date.now()) {
      toast({ tone: 'warning', title: 'Termin liegt in der Vergangenheit', text: 'Bitte einen Zeitpunkt in der Zukunft wählen.' });
      return false;
    }
    const approved = !!e.meta?.approved;
    const submitted = !!e.meta?.submitted;
    if (approved || submitted) {
      const ok = await confirm({
        title: 'Termin der Fassung ändern?',
        text: (
          <>
            Neuer Termin: <strong>{fmtDateTime(publishAt)}</strong>. Der Termin ist Teil der {approved ? 'freigegebenen' : 'zur Freigabe eingereichten'} Fassung. Es entsteht eine neue Fassung – sie muss erneut eingereicht und freigegeben werden, bevor sie veröffentlicht werden kann.
          </>
        ),
        confirmLabel: 'Termin ändern',
        danger: false,
      });
      if (!ok) return false;
    }
    try {
      const r = await post<ScheduleResult>(`/calendar/posts/${e.id}/schedule`, { revision: e.meta?.revision, publishAt });
      if (r.approvalInvalidated || r.wasSubmitted) toast({ tone: 'warning', title: `Termin geändert – Fassung ${r.number}`, text: 'Die bisherige Freigabe gilt nicht mehr. Bitte im Beitrag erneut einreichen.' });
      else toast({ tone: 'success', title: 'Termin geändert', text: fmtDateTime(publishAt) });
      onDone();
      return true;
    } catch (err) {
      toastError(err);
      onDone();
      return false;
    }
  };
}

function Draggable({ e, children }: { e: CalendarEntry; children: ReactNode }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: e.key, data: e, disabled: !e.movable });
  // Nur Zeiger-Ereignisse: die Schaltfläche im Inneren bleibt per Tastatur bedienbar (Alternative im Eintrag)
  return (
    <div ref={setNodeRef} {...(e.movable ? listeners : {})} className={cx(e.movable && 'cursor-grab touch-none', isDragging && 'opacity-40', 'h-full')}>
      {children}
    </div>
  );
}

function Droppable({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cx('flex-1 flex flex-col h-full w-full rounded-chip transition-colors duration-fast', isOver && 'bg-primary-soft')}>
      {children}
    </div>
  );
}

/** Hüllen für die Ansichten (wrapEntry/wrapDay) und der Ziehen-Rahmen. */
export function usePlanning(enabled: boolean, reschedule: (e: CalendarEntry, at: string) => Promise<boolean>) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [active, setActive] = useState<CalendarEntry | null>(null);
  const wrapEntry = (e: CalendarEntry, node: ReactNode) => (enabled && e.movable ? <Draggable e={e}>{node}</Draggable> : node);
  const wrapDay = (day: string, node: ReactNode, opts: { hour?: number }) => (enabled ? <Droppable id={`${day}|${opts.hour ?? ''}`}>{node}</Droppable> : node);
  const onStart = (ev: DragStartEvent) => setActive((ev.active.data.current as CalendarEntry) ?? null);
  const onEnd = async (ev: DragEndEvent) => {
    setActive(null);
    const e = ev.active.data.current as CalendarEntry | undefined;
    if (!e || !ev.over) return;
    const [day, hour] = String(ev.over.id).split('|');
    const time = timeOf(e.start);
    const hm = hour ? `${pad(Number(hour))}:${time.slice(3, 5)}` : time;
    const at = fromLocalInput(`${day}T${hm}`);
    if (at) await reschedule(e, at);
  };
  const overlay = <DragOverlay dropAnimation={null}>{active ? <div className="shadow-float rounded-chip border border-primary bg-card max-w-[240px]"><EntryChip e={active} onOpen={() => {}} /></div> : null}</DragOverlay>;
  const dnd = { sensors, collisionDetection: pointerWithin, onDragStart: onStart, onDragEnd: onEnd, onDragCancel: () => setActive(null) };
  return { wrapEntry, wrapDay, dnd, overlay };
}

/** Tastaturbedienbare Alternative zum Ziehen: Datum und Uhrzeit direkt ändern. */
export function RescheduleForm({ entry, reschedule, onDone }: { entry: CalendarEntry; reschedule: (e: CalendarEntry, at: string) => Promise<boolean>; onDone: () => void }) {
  const [v, setV] = useState(toLocalInput(entry.start));
  const [busy, setBusy] = useState(false);
  const at = fromLocalInput(v);
  return (
    <div className="flex items-end gap-2 flex-wrap border-t border-line pt-3">
      <FieldWrap label="Termin ändern" htmlFor="post-at" help="Alternative zum Ziehen im Kalender." className="flex-1 min-w-[200px]">
        <Input id="post-at" type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} />
      </FieldWrap>
      <Button
        loading={busy}
        disabled={!at || Date.parse(at) === Date.parse(entry.start)}
        onClick={async () => {
          setBusy(true);
          const ok = await reschedule(entry, at!);
          setBusy(false);
          if (ok) onDone();
        }}
      >
        Termin speichern
      </Button>
    </div>
  );
}
