import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../../api/client';
import { Badge, Button, cx, FieldWrap, Input, Notice, Select, Spinner, Switch, Textarea } from '../../components/ui/core';
import { Dialog, useConfirm, useErrorToast, useToast } from '../../components/ui/overlays';
import { HelpTip } from '../../components/ui/HelpTip';
import { Icon } from '../../components/ui/Icon';
import { fromLocalInput, toLocalInput } from '../../lib/format';
import { COLORS, dayKey, dayOfMonth, entryColor, rangeText, weekdayOf, WEEKDAYS_LONG, WEEKDAYS_SHORT, type CalendarCategory, type CalendarEntry, type EventDetail, type Recurrence } from './model';

/* ------------------------------------------------------------------ Termin anlegen/bearbeiten */

export interface EditTarget {
  /** vorhandener Termin (Hauptzeile oder geänderter Einzeltermin) */
  id?: string;
  /** nur diesen Termin einer Serie ändern (ursprünglicher Beginn) */
  instance?: string;
  /** Vorgaben für einen neuen Termin bzw. den einzelnen Termin */
  start?: string;
  end?: string;
  allDay?: boolean;
  /** Daten des geöffneten Termins (für „nur diesen Termin“) */
  entry?: CalendarEntry;
}

const ORDINALS: { value: Recurrence['ordinal']; label: string }[] = [
  { value: 1, label: '1.' },
  { value: 2, label: '2.' },
  { value: 3, label: '3.' },
  { value: 4, label: '4.' },
  { value: -1, label: 'letzten' },
];

interface Form {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string; // datetime-local
  end: string;
  startDate: string;
  endDate: string;
  categoryId: string;
  tags: string;
  repeat: '' | Recurrence['freq'];
  interval: number;
  weekdays: number[];
  monthly: Recurrence['monthly'];
  /** null = aus dem Beginn ableiten (z. B. 7. → 1. Samstag) */
  ordinal: NonNullable<Recurrence['ordinal']> | null;
  ends: Recurrence['ends'];
  until: string;
  count: number;
}

function initialForm(detail: EventDetail | null, t: EditTarget): Form {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const s = t.start ?? detail?.start ?? new Date(now.getTime() + 3600_000).toISOString();
  const e = t.end ?? detail?.end ?? new Date(Date.parse(s) + 3600_000).toISOString();
  const allDay = t.allDay ?? detail?.allDay ?? false;
  const src = t.entry ?? detail;
  const startDate = dayKey(s);
  const lastDay = allDay ? dayKey(Math.max(Date.parse(s), Date.parse(e) - 1)) : startDate;
  const rec = t.instance ? null : detail?.recurrence ?? null;
  return {
    title: src?.title ?? '',
    description: src?.description ?? '',
    location: src?.location ?? '',
    allDay,
    start: toLocalInput(s),
    end: toLocalInput(e),
    startDate,
    endDate: lastDay,
    categoryId: src?.category?.id ?? '',
    tags: (src?.tags ?? []).join(', '),
    repeat: rec?.freq ?? '',
    interval: rec?.interval ?? 1,
    weekdays: rec?.weekdays?.length ? rec.weekdays : [weekdayOf(startDate)],
    monthly: rec?.monthly ?? 'day',
    ordinal: rec?.ordinal ?? null,
    ends: rec?.ends ?? 'never',
    until: rec?.until ?? '',
    count: rec?.count ?? 10,
  };
}

export function EventDialog({ target, categories, onClose, onSaved }: { target: EditTarget; categories: CalendarCategory[]; onClose: () => void; onSaved: () => void }) {
  const detail = useQuery({ queryKey: ['calendar', 'event', target.id], queryFn: () => get<EventDetail>(`/calendar/events/${target.id}`), enabled: !!target.id && !target.instance });
  if (target.id && !target.instance && !detail.data) {
    return (
      <Dialog open onClose={onClose} title="Termin bearbeiten">
        {detail.error ? <Notice tone="error">Der Termin konnte nicht geladen werden.</Notice> : <Spinner />}
      </Dialog>
    );
  }
  return <EventForm target={target} detail={detail.data ?? null} categories={categories} onClose={onClose} onSaved={onSaved} />;
}

function EventForm({ target, detail, categories, onClose, onSaved }: { target: EditTarget; detail: EventDetail | null; categories: CalendarCategory[]; onClose: () => void; onSaved: () => void }) {
  const toastError = useErrorToast();
  const [f, setF] = useState<Form>(() => initialForm(detail, target));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const isOverride = !!detail?.seriesId;
  const canRepeat = !target.instance && !isOverride;
  const startDay = f.allDay ? f.startDate : f.start.slice(0, 10);
  const wd = startDay ? weekdayOf(startDay) : 1;
  const dom = startDay ? dayOfMonth(startDay) : 1;
  const ordinal = f.ordinal ?? ((Math.ceil(dom / 7) > 4 ? -1 : Math.ceil(dom / 7)) as NonNullable<Form['ordinal']>);

  const save = async () => {
    const recurrence =
      canRepeat && f.repeat
        ? { freq: f.repeat, interval: Math.max(1, Number(f.interval) || 1), weekdays: f.repeat === 'weekly' ? f.weekdays : [], monthly: f.monthly, ...(f.monthly === 'weekday' ? { ordinal } : {}), ends: f.ends, until: f.ends === 'until' ? f.until || null : null, count: f.ends === 'count' ? Math.max(1, Number(f.count) || 1) : null }
        : null;
    const body: Record<string, unknown> = {
      title: f.title.trim(),
      description: f.description,
      location: f.location.trim(),
      allDay: f.allDay,
      ...(f.allDay ? { startDate: f.startDate, endDate: f.endDate || f.startDate } : { start: fromLocalInput(f.start), end: fromLocalInput(f.end) }),
      categoryId: f.categoryId || null,
      tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean),
      recurrence,
    };
    setBusy(true);
    try {
      if (target.instance && target.id) await put(`/calendar/events/${target.id}`, { ...body, scope: 'instance', instance: target.instance });
      else if (target.id) await put(`/calendar/events/${target.id}`, { ...body, scope: 'series' });
      else await post('/calendar/events', body);
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const invalidTimes = f.allDay ? !f.startDate || (!!f.endDate && f.endDate < f.startDate) : !f.start || !f.end || f.end < f.start;
  const title = target.instance ? 'Diesen Termin der Serie bearbeiten' : target.id ? (detail?.rrule ? 'Serie bearbeiten' : 'Termin bearbeiten') : 'Neuer Termin';
  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!f.title.trim() || invalidTimes || (f.repeat === 'weekly' && !f.weekdays.length) || (f.ends === 'until' && !!f.repeat && !f.until)} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {target.instance && <Notice>Die Änderung gilt nur für den Termin am {rangeText(target.entry!)}. Die übrigen Termine der Serie bleiben unverändert.</Notice>}
        {detail?.rrule && !target.instance && (
          <Notice>
            Änderungen gelten für alle Termine der Serie. Beginn und Ende beziehen sich auf den ersten Termin.
            {(detail.exdates?.length ?? 0) + (detail.overrideCount ?? 0) > 0 && ' Gelöschte und einzeln geänderte Termine wandern mit, wenn sich Beginn, Uhrzeit oder Wiederholung ändern; was danach zu keinem Termin der Serie mehr passt, entfällt.'}
          </Notice>
        )}
        <FieldWrap label="Titel" htmlFor="ev-title" required>
          <Input id="ev-title" value={f.title} maxLength={300} onChange={(e) => set({ title: e.target.value })} />
        </FieldWrap>
        <Switch checked={f.allDay} onChange={(v) => set({ allDay: v })} label="Ganztägig" description="Ohne Uhrzeit, auch über mehrere Tage." />
        {f.allDay ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldWrap label="Von" htmlFor="ev-sd" required>
              <Input id="ev-sd" type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value, endDate: f.endDate && f.endDate >= e.target.value ? f.endDate : e.target.value })} />
            </FieldWrap>
            <FieldWrap label="Bis (einschließlich)" htmlFor="ev-ed" error={f.endDate && f.endDate < f.startDate ? 'Das Ende liegt vor dem Beginn.' : null}>
              <Input id="ev-ed" type="date" value={f.endDate} min={f.startDate} onChange={(e) => set({ endDate: e.target.value })} />
            </FieldWrap>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldWrap label="Beginn" htmlFor="ev-s" required>
              <Input
                id="ev-s"
                type="datetime-local"
                value={f.start}
                onChange={(e) => {
                  // Dauer beibehalten
                  const dur = Date.parse(fromLocalInput(f.end) ?? '') - Date.parse(fromLocalInput(f.start) ?? '');
                  const s = fromLocalInput(e.target.value);
                  set({ start: e.target.value, ...(s && dur >= 0 ? { end: toLocalInput(new Date(Date.parse(s) + dur)) } : {}) });
                }}
              />
            </FieldWrap>
            <FieldWrap label="Ende" htmlFor="ev-e" required error={f.end && f.start && f.end < f.start ? 'Das Ende liegt vor dem Beginn.' : null}>
              <Input id="ev-e" type="datetime-local" value={f.end} min={f.start} onChange={(e) => set({ end: e.target.value })} />
            </FieldWrap>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FieldWrap label="Kategorie" htmlFor="ev-cat">
            <Select id="ev-cat" value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
              <option value="">Ohne Kategorie</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap label="Ort" htmlFor="ev-loc">
            <Input id="ev-loc" value={f.location} maxLength={300} onChange={(e) => set({ location: e.target.value })} />
          </FieldWrap>
        </div>
        <FieldWrap label="Schlagwörter" htmlFor="ev-tags" help="Mehrere mit Komma trennen. Workflows können nach Schlagwörtern filtern.">
          <Input id="ev-tags" value={f.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="z. B. Atemschutz, Jugendfeuerwehr" />
        </FieldWrap>
        <FieldWrap label="Beschreibung" htmlFor="ev-desc">
          <Textarea id="ev-desc" rows={3} value={f.description} maxLength={5000} onChange={(e) => set({ description: e.target.value })} />
        </FieldWrap>

        {canRepeat && (
          <fieldset className="border border-line rounded-node p-3 flex flex-col gap-3 m-0">
            <legend className="px-1 text-sm font-medium flex items-center gap-1.5">
              Wiederholung
              <HelpTip title="Wiederholung" more="/hilfe/kalender#wiederholungen">
                Serien gelten in Ortszeit – „jeden 1. Samstag um 10:00“ bleibt auch nach der Zeitumstellung um 10:00. Einzelne Termine einer Serie lassen sich später ändern oder löschen.
              </HelpTip>
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FieldWrap label="Wiederholen" htmlFor="ev-rep">
                <Select id="ev-rep" value={f.repeat} onChange={(e) => set({ repeat: e.target.value as Form['repeat'] })}>
                  <option value="">Nicht wiederholen</option>
                  <option value="daily">Täglich</option>
                  <option value="weekly">Wöchentlich</option>
                  <option value="monthly">Monatlich</option>
                  <option value="yearly">Jährlich</option>
                </Select>
              </FieldWrap>
              {f.repeat && (
                <FieldWrap label={`Alle … ${{ daily: 'Tage', weekly: 'Wochen', monthly: 'Monate', yearly: 'Jahre' }[f.repeat]}`} htmlFor="ev-int">
                  <Input id="ev-int" type="number" min={1} max={99} value={f.interval} onChange={(e) => set({ interval: Number(e.target.value) })} />
                </FieldWrap>
              )}
            </div>
            {f.repeat === 'weekly' && (
              <div role="group" aria-label="Wochentage" className="flex flex-wrap gap-1.5">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                  const on = f.weekdays.includes(d);
                  return (
                    <button key={d} type="button" aria-pressed={on} aria-label={WEEKDAYS_LONG[d]} onClick={() => set({ weekdays: on ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] })} className={cx('w-10 h-10 rounded-control border text-sm font-medium', on ? 'bg-raised border-fg' : 'border-line text-fg-muted hover:text-fg')}>
                      {WEEKDAYS_SHORT[d]}
                    </button>
                  );
                })}
              </div>
            )}
            {(f.repeat === 'monthly' || f.repeat === 'yearly') && (
              <div role="radiogroup" aria-label="Tag" className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="ev-monthly" checked={f.monthly === 'day'} onChange={() => set({ monthly: 'day' })} />
                  am {dom}. {f.repeat === 'yearly' ? 'dieses Monats' : 'des Monats'}
                </label>
                <label className="flex items-center gap-2 text-sm flex-wrap">
                  <input type="radio" name="ev-monthly" checked={f.monthly === 'weekday'} onChange={() => set({ monthly: 'weekday' })} />
                  am
                  <select aria-label="Welcher Wochentag im Monat" className="h-9 bg-bg border border-line rounded-control px-2" value={ordinal} onChange={(e) => set({ ordinal: Number(e.target.value) as Form['ordinal'], monthly: 'weekday' })}>
                    {ORDINALS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {WEEKDAYS_LONG[wd]} {f.repeat === 'yearly' ? 'dieses Monats' : 'im Monat'}
                </label>
              </div>
            )}
            {f.repeat && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FieldWrap label="Endet" htmlFor="ev-ends">
                  <Select id="ev-ends" value={f.ends} onChange={(e) => set({ ends: e.target.value as Form['ends'] })}>
                    <option value="never">Nie</option>
                    <option value="until">Am Datum</option>
                    <option value="count">Nach Anzahl Terminen</option>
                  </Select>
                </FieldWrap>
                {f.ends === 'until' && (
                  <FieldWrap label="Letzter möglicher Tag" htmlFor="ev-until" required>
                    <Input id="ev-until" type="date" value={f.until} min={startDay} onChange={(e) => set({ until: e.target.value })} />
                  </FieldWrap>
                )}
                {f.ends === 'count' && (
                  <FieldWrap label="Anzahl Termine" htmlFor="ev-count">
                    <Input id="ev-count" type="number" min={1} max={500} value={f.count} onChange={(e) => set({ count: Number(e.target.value) })} />
                  </FieldWrap>
                )}
              </div>
            )}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Eintrag ansehen */

export function EntryDialog({ entry, canManage, onClose, onEdit, onChanged, extra }: { entry: CalendarEntry; canManage: boolean; onClose: () => void; onEdit: (t: EditTarget) => void; onChanged: () => void; extra?: React.ReactNode }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const confirm = useConfirm();
  const detail = useQuery({ queryKey: ['calendar', 'event', entry.seriesId ?? entry.id], queryFn: () => get<EventDetail>(`/calendar/events/${entry.seriesId ?? entry.id}`), enabled: entry.kind === 'event' && entry.recurring });
  const editable = entry.kind === 'event' && !entry.readOnly && canManage;
  const isOverride = entry.kind === 'event' && !!entry.seriesId && entry.seriesId !== entry.id;
  const remove = async (scope: 'series' | 'instance') => {
    const ok = await confirm({
      title: scope === 'instance' ? 'Diesen Termin löschen?' : entry.recurring ? 'Ganze Serie löschen?' : 'Termin löschen?',
      text: scope === 'instance' ? `Nur der Termin am ${rangeText(entry)} entfällt; die Serie bleibt bestehen.` : entry.recurring ? 'Alle Termine der Serie werden gelöscht, auch einzeln geänderte.' : `„${entry.title}“ wird gelöscht.`,
      confirmLabel: 'Löschen',
    });
    if (!ok) return;
    try {
      const id = scope === 'series' && entry.seriesId ? entry.seriesId : entry.id;
      await del(`/calendar/events/${id}?scope=${scope}${scope === 'instance' && !isOverride && entry.instance ? `&instance=${encodeURIComponent(entry.instance)}` : ''}`);
      toast({ tone: 'success', title: 'Gelöscht' });
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const color = entryColor(entry);
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
          {entry.title}
        </span>
      }
      footer={
        <>
          {editable && entry.recurring && (
            <>
              <Button variant="danger" icon="Trash2" onClick={() => remove('instance')}>
                Diesen Termin löschen
              </Button>
              <Button variant="danger" onClick={() => remove('series')}>
                Serie löschen
              </Button>
              <Button icon="Pencil" onClick={() => onEdit(isOverride ? { id: entry.id } : { id: entry.seriesId ?? entry.id, instance: entry.instance!, start: entry.start, end: entry.end, allDay: entry.allDay, entry })}>
                Diesen Termin bearbeiten
              </Button>
              <Button variant="primary" icon="Pencil" onClick={() => onEdit({ id: entry.seriesId ?? entry.id })}>
                Serie bearbeiten
              </Button>
            </>
          )}
          {editable && !entry.recurring && (
            <>
              <Button variant="danger" icon="Trash2" onClick={() => remove('series')}>
                Löschen
              </Button>
              <Button variant="primary" icon="Pencil" onClick={() => onEdit({ id: entry.id })}>
                Bearbeiten
              </Button>
            </>
          )}
          {!editable && <Button onClick={onClose}>Schließen</Button>}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 font-mono text-[13px]">{rangeText(entry)}</p>
        <div className="flex flex-wrap gap-1.5">
          {entry.category && <Badge>{entry.category.name}</Badge>}
          {entry.sourceName && <Badge>{entry.sourceName}</Badge>}
          {entry.statusLabel && <Badge tone={entry.status === 'published' ? 'success' : entry.status === 'in_review' ? 'warning' : 'neutral'}>{entry.statusLabel}</Badge>}
          {entry.overdue && <Badge tone="error">überfällig</Badge>}
          {entry.recurring && <Badge>{detail.data?.rruleText ?? 'Serie'}</Badge>}
          {entry.tags.map((t) => (
            <Badge key={t} dot={false}>
              #{t}
            </Badge>
          ))}
        </div>
        {entry.location && (
          <p className="m-0 text-sm flex items-center gap-1.5">
            <Icon name="Globe" size={14} className="text-fg-muted" /> {entry.location}
          </p>
        )}
        {entry.description && <p className="m-0 text-sm whitespace-pre-wrap">{entry.description}</p>}
        {entry.readOnly && entry.source === 'ical' && <Notice>Eingelesen aus „{entry.sourceName}“ – schreibgeschützt. Änderungen bitte im Ursprungskalender vornehmen.</Notice>}
        {entry.link && (
          <p className="m-0">
            <Link to={entry.link} className="font-medium">
              Öffnen →
            </Link>
          </p>
        )}
        {extra}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Kategorien */

export function CategoriesDialog({ categories, onClose }: { categories: CalendarCategory[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [color, setColor] = useState('blau');
  const [edit, setEdit] = useState<Record<string, { name: string; color: string }>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['calendar'] });
  const add = async () => {
    try {
      await post('/calendar/categories', { name: name.trim(), color });
      setName('');
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const save = async (id: string) => {
    try {
      await put(`/calendar/categories/${id}`, edit[id]);
      setEdit(({ [id]: _, ...rest }) => rest);
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async (c: CalendarCategory) => {
    if (!(await confirm({ title: `Kategorie „${c.name}“ löschen?`, text: c.event_count ? `${c.event_count} Termin(e) bleiben erhalten und sind danach ohne Kategorie.` : 'Es sind keine Termine zugeordnet.', confirmLabel: 'Löschen' }))) return;
    try {
      await del(`/calendar/categories/${c.id}`);
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Kategorien" width={600} footer={<Button onClick={onClose}>Fertig</Button>}>
      <div className="flex flex-col gap-4">
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {categories.map((c) => {
            const e = edit[c.id];
            return (
              <li key={c.id} className="flex items-center gap-2 flex-wrap">
                <span aria-hidden="true" className="w-3 h-3 rounded-full shrink-0" style={{ background: `var(--bc-cal-${e?.color ?? c.color})` }} />
                {e ? (
                  <>
                    <Input aria-label="Name" className="!w-auto flex-1 min-w-[140px]" value={e.name} maxLength={60} onChange={(x) => setEdit({ ...edit, [c.id]: { ...e, name: x.target.value } })} />
                    <ColorSelect value={e.color} onChange={(v) => setEdit({ ...edit, [c.id]: { ...e, color: v } })} />
                    <Button size="sm" variant="primary" disabled={!e.name.trim()} onClick={() => save(c.id)}>
                      Speichern
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 min-w-0">
                      {c.name} <span className="text-meta text-fg-muted">· {COLORS.find((x) => x.value === c.color)?.label} · {c.event_count ?? 0} Termin(e)</span>
                    </span>
                    <Button size="sm" icon="Pencil" iconOnly aria-label={`${c.name} bearbeiten`} onClick={() => setEdit({ ...edit, [c.id]: { name: c.name, color: c.color } })} />
                    <Button size="sm" variant="ghost" icon="Trash2" iconOnly aria-label={`${c.name} löschen`} onClick={() => remove(c)} />
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex items-end gap-2 flex-wrap border-t border-line pt-4">
          <FieldWrap label="Neue Kategorie" htmlFor="cat-new" className="flex-1 min-w-[160px]">
            <Input id="cat-new" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="z. B. Jugendfeuerwehr" />
          </FieldWrap>
          <ColorSelect value={color} onChange={setColor} />
          <Button icon="Plus" disabled={!name.trim()} onClick={add}>
            Hinzufügen
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ColorSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="w-[140px]">
      <Select aria-label="Farbe" value={value} onChange={(e) => onChange(e.target.value)}>
        {COLORS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

