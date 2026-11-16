import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx, EmptyState } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { addDays, byDay, dayKey, dayLabel, dayOfMonth, entryColor, entryDays, monthIndex, pad, timeOf, timeText, today, weekdayOf, WEEKDAYS_SHORT, type CalendarEntry } from './model';

/**
 * Ansichten des Kalenders (#200): Monat, Woche (Zeitraster) und Liste. Einträge sind Schaltflächen (Tastatur,
 * Bildschirmleser); Farben kommen aus den Kalender-Tokens und stehen immer neben dem Namen der Kategorie.
 * `wrapEntry`/`wrapDay` erlauben Ziehen und Ablegen (geplante Beiträge, #201), ohne die Ansichten zu ändern.
 */

export interface ViewProps {
  entries: CalendarEntry[];
  from: string;
  to: string;
  month?: number;
  onOpen: (e: CalendarEntry) => void;
  onDay?: (day: string) => void;
  /** Hülle um einen Eintrag (z. B. ziehbar) */
  wrapEntry?: (e: CalendarEntry, node: ReactNode) => ReactNode;
  /** Hülle um einen Tag (z. B. Ablagefläche) */
  wrapDay?: (day: string, node: ReactNode, opts: { hour?: number }) => ReactNode;
}

const ident = (_x: unknown, n: ReactNode) => n;

function statusSuffix(e: CalendarEntry) {
  return e.statusLabel ? ` · ${e.statusLabel}` : '';
}

export function entryAria(e: CalendarEntry, day?: string) {
  return `${e.title}, ${timeText(e, day)}${e.category ? `, Kategorie ${e.category.name}` : ''}${e.sourceName ? `, ${e.sourceName}` : ''}${statusSuffix(e)}${e.overdue ? ', überfällig' : ''}`;
}

/** Kompakter Eintrag (Monat, Ganztägig-Zeile). */
export function EntryChip({ e, day, onOpen }: { e: CalendarEntry; day?: string; onOpen: (e: CalendarEntry) => void }) {
  const color = entryColor(e);
  return (
    <button
      type="button"
      onClick={() => onOpen(e)}
      aria-label={entryAria(e, day)}
      title={entryAria(e, day)}
      className={cx('w-full text-left flex items-center gap-1.5 min-w-0 rounded-chip px-1.5 py-[3px] text-[12.5px] leading-tight hover:brightness-95 focus-visible:shadow-ring', e.overdue && 'ring-1 ring-err')}
      style={{ background: `color-mix(in srgb, ${color} ${e.allDay ? 22 : 12}%, transparent)` }}
    >
      <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      {!e.allDay && <span className="font-mono text-[11px] text-fg-muted shrink-0">{timeText(e, day).replace(/–.*$/, '')}</span>}
      {e.overdue && <Icon name="AlertTriangle" size={12} className="text-err shrink-0" />}
      <span className="truncate">{e.title}</span>
      {e.kind !== 'event' && <Icon name={e.kind === 'post' ? 'FileText' : 'Newspaper'} size={12} className="text-fg-muted shrink-0 ml-auto" />}
    </button>
  );
}

/* ------------------------------------------------------------------ Monat */

export function MonthView({ entries, from, to, month, onOpen, onDay, wrapEntry = ident, wrapDay = ident }: ViewProps) {
  const map = byDay(entries, from, to);
  const days: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const t = today();
  const [more, setMore] = useState<string | null>(null);
  return (
    <div className="border border-line rounded-card overflow-hidden bg-card">
      <div className="grid grid-cols-7 border-b border-line bg-raised" aria-hidden="true">
        {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
          <div key={wd} className="px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted">
            {WEEKDAYS_SHORT[wd]}
          </div>
        ))}
      </div>
      {weeks.map((w) => (
        <div key={w[0]} className="grid grid-cols-7 border-b border-line last:border-b-0">
          {w.map((d) => {
            const list = map.get(d) ?? [];
            const outside = month != null && monthIndex(d) !== month;
            const open = more === d;
            const shown = open ? list : list.slice(0, 3);
            return (
              <div key={d} className={cx('min-h-[112px] border-r border-line last:border-r-0 p-1 flex flex-col gap-0.5 min-w-0', outside && 'bg-bg')}>
                {wrapDay(
                  d,
                  <div className="flex flex-col gap-0.5 min-w-0 h-full">
                    <div className="flex items-center justify-between">
                      {onDay ? (
                        <button type="button" onClick={() => onDay(d)} aria-label={`${dayLabel(d)}: neuer Termin`} title="Neuer Termin an diesem Tag" className={cx('w-7 h-7 rounded-full text-[12px] font-mono inline-flex items-center justify-center hover:bg-raised', d === t && 'bg-primary-solid text-on-primary hover:bg-primary-hover', outside && d !== t && 'text-fg-muted')}>
                          {dayOfMonth(d)}
                        </button>
                      ) : (
                        <span className={cx('w-7 h-7 rounded-full text-[12px] font-mono inline-flex items-center justify-center', d === t && 'bg-primary-solid text-on-primary', outside && d !== t && 'text-fg-muted')} aria-label={dayLabel(d)}>
                          {dayOfMonth(d)}
                        </span>
                      )}
                    </div>
                    {shown.map((e) => (
                      <div key={e.key}>{wrapEntry(e, <EntryChip e={e} day={d} onOpen={onOpen} />)}</div>
                    ))}
                    {list.length > 3 && (
                      <button type="button" onClick={() => setMore(open ? null : d)} className="text-left text-[12px] text-fg-muted hover:text-fg px-1.5" aria-expanded={open}>
                        {open ? 'weniger' : `+ ${list.length - 3} weitere`}
                      </button>
                    )}
                  </div>,
                  {},
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Woche */

const HOUR = 44;

interface Placed {
  e: CalendarEntry;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** Termine eines Tages im Zeitraster nebeneinander anordnen, wenn sie sich überschneiden. */
function place(list: CalendarEntry[], day: string): Placed[] {
  const mins = (iso: string, clampEnd: boolean) => {
    const k = dayKey(iso);
    if (k < day) return 0;
    if (k > day) return 24 * 60;
    const [h, m] = timeOf(iso).split(':').map(Number);
    const v = h * 60 + m;
    return clampEnd && v === 0 ? 24 * 60 : v;
  };
  const items = list
    .map((e) => {
      const s = mins(e.start, false);
      const en = Math.max(s + 20, mins(e.end, true));
      return { e, s, en };
    })
    .sort((a, b) => a.s - b.s || b.en - a.en);
  const out: Placed[] = [];
  let cluster: { e: CalendarEntry; s: number; en: number; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.push({ e: c.e, top: (c.s / 60) * HOUR, height: Math.max(22, ((c.en - c.s) / 60) * HOUR - 2), col: c.col, cols });
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.en > it.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ ...it, col });
    clusterEnd = Math.max(clusterEnd, it.en);
  }
  if (cluster.length) flush();
  return out;
}

export function WeekView({ entries, from, to, onOpen, onDay, wrapEntry = ident, wrapDay = ident }: ViewProps) {
  const days: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const map = byDay(entries, from, to);
  const scroller = useRef<HTMLDivElement>(null);
  const t = today();
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR;
  }, [from]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);
  const nowTop = (() => {
    const [h, m] = timeOf(new Date(now).toISOString()).split(':').map(Number);
    return ((h * 60 + m) / 60) * HOUR;
  })();
  return (
    <div className="border border-line rounded-card overflow-hidden bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid border-b border-line bg-raised" style={{ gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))' }}>
            <div />
            {days.map((d) => (
              <div key={d} className="px-2 py-1.5 border-l border-line">
                {onDay ? (
                  <button type="button" onClick={() => onDay(d)} className="text-left hover:text-fg" aria-label={`${dayLabel(d)}: neuer Termin`} title="Neuer Termin an diesem Tag">
                    <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted">{WEEKDAYS_SHORT[weekdayOf(d)]}</span>{' '}
                    <span className={cx('font-mono text-[13px] px-1.5 rounded-full', d === t && 'bg-primary-solid text-on-primary')}>{dayOfMonth(d)}</span>
                  </button>
                ) : (
                  <span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted">{WEEKDAYS_SHORT[weekdayOf(d)]}</span>{' '}
                    <span className={cx('font-mono text-[13px] px-1.5 rounded-full', d === t && 'bg-primary-solid text-on-primary')}>{dayOfMonth(d)}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
          {/* Ganztägige und mehrtägige Einträge */}
          <div className="grid border-b border-line" style={{ gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))' }}>
            <div className="text-[11px] text-fg-muted px-1 py-1 font-mono">ganzt.</div>
            {days.map((d) => {
              const list = (map.get(d) ?? []).filter((e) => e.allDay || entryDays(e).first !== entryDays(e).last);
              return (
                <div key={d} className="border-l border-line p-1 flex flex-col gap-0.5 min-h-[30px] min-w-0">
                  {wrapDay(
                    d,
                    <div className="flex flex-col gap-0.5 min-h-[22px]">
                      {list.map((e) => (
                        <div key={e.key}>{wrapEntry(e, <EntryChip e={e} day={d} onOpen={onOpen} />)}</div>
                      ))}
                    </div>,
                    {},
                  )}
                </div>
              );
            })}
          </div>
          <div ref={scroller} className="overflow-y-auto" style={{ maxHeight: 560 }}>
            <div className="grid relative" style={{ gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))', height: 24 * HOUR }}>
              <div className="relative">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute right-1 text-[11px] font-mono text-fg-muted -translate-y-1/2" style={{ top: h * HOUR }}>
                    {h ? `${pad(h)}:00` : ''}
                  </div>
                ))}
              </div>
              {days.map((d) => {
                const timed = (map.get(d) ?? []).filter((e) => !e.allDay && entryDays(e).first === entryDays(e).last);
                return (
                  <div key={d} className="relative border-l border-line">
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="absolute left-0 right-0 border-t border-line/60" style={{ top: h * HOUR, height: HOUR }}>
                        {wrapDay(d, <div className="w-full h-full" />, { hour: h })}
                      </div>
                    ))}
                    {d === t && <div aria-hidden="true" className="absolute left-0 right-0 h-0.5 bg-primary z-10" style={{ top: nowTop }} />}
                    {place(timed, d).map((p) => {
                      const color = entryColor(p.e);
                      return (
                        <div key={p.e.key} className="absolute px-0.5 z-[5]" style={{ top: p.top, height: p.height, left: `${(p.col / p.cols) * 100}%`, width: `${100 / p.cols}%` }}>
                          {wrapEntry(
                            p.e,
                            <button
                              type="button"
                              onClick={() => onOpen(p.e)}
                              aria-label={entryAria(p.e, d)}
                              title={entryAria(p.e, d)}
                              className={cx('w-full h-full flex flex-col items-start justify-start text-left rounded-chip px-1.5 py-1 overflow-hidden text-[12px] leading-tight border hover:brightness-95 focus-visible:shadow-ring', p.e.overdue && 'ring-1 ring-err')}
                              style={{ background: `color-mix(in srgb, ${color} 16%, var(--bc-card))`, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
                            >
                              <span className="font-mono text-[11px] text-fg-muted block">{timeText(p.e, d)}</span>
                              <span className="font-medium">{p.e.title}</span>
                            </button>,
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Liste */

export function ListView({ entries, from, to, onOpen, wrapEntry = ident }: ViewProps) {
  const map = byDay(entries, from, to);
  const days = [...map.keys()].sort();
  const t = today();
  if (!days.length) return <EmptyState icon="CalendarDays" title="Keine Einträge in diesem Zeitraum" text="Filter prüfen oder einen anderen Zeitraum wählen." />;
  return (
    <div className="flex flex-col gap-4">
      {days.map((d) => (
        <section key={d} aria-label={dayLabel(d)} className="flex flex-col gap-1">
          <h3 className={cx('m-0 pb-1.5 border-b border-line font-mono text-[12px] font-medium uppercase tracking-[0.08em]', d === t ? 'text-primary' : 'text-fg-muted')}>
            {dayLabel(d)}
            {d === t && ' · heute'}
          </h3>
          <ul className="m-0 p-0 list-none flex flex-col">
            {(map.get(d) ?? []).map((e) => {
              const color = entryColor(e);
              return (
                <li key={e.key}>
                  {wrapEntry(
                    e,
                    <button type="button" onClick={() => onOpen(e)} aria-label={entryAria(e, d)} className="w-full text-left flex items-start gap-3 py-2.5 px-2 rounded-control hover:bg-raised focus-visible:shadow-ring min-h-[48px]">
                      <span className="font-mono text-[12px] text-fg-muted w-[92px] shrink-0 pt-0.5">{timeText(e, d)}</span>
                      <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0 mt-1.5" style={{ background: color }} />
                      <span className="flex flex-col min-w-0 gap-0.5">
                        <span className="font-medium flex items-center gap-1.5">
                          {e.overdue && <Icon name="AlertTriangle" size={14} className="text-err" />}
                          {e.title}
                          {e.recurring && <Icon name="RefreshCw" size={12} className="text-fg-muted" />}
                        </span>
                        <span className="text-meta text-fg-muted">
                          {[e.category?.name, e.sourceName, e.statusLabel, e.overdue ? 'überfällig' : null, e.location].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>,
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
