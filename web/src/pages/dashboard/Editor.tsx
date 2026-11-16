import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Card, cx, Select } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import {
  addColumn,
  addWidget,
  BADGE_TITLES,
  columnOf,
  columnStyle,
  isBadge,
  isPanel,
  MAX_COLUMNS,
  move,
  PANEL_TITLES,
  placeWidget,
  removeColumn,
  removeWidget,
  setWeight,
  titleOf,
  WEIGHTS,
  type ColumnWeight,
  type EditColumn,
  type EditLayout,
} from './model';
import { BadgeTile, PanelTile } from './widgets';

type Kind = 'badge' | 'widget' | 'column' | 'slot';
const kindOf = (data: { current?: Record<string, any> } | undefined): Kind | undefined => data?.current?.type;
const slotId = (columnKey: string) => `slot:${columnKey}`;

/**
 * Trefferermittlung: Kennzahlen und Spalten bleiben unter sich (nächstes Ziel zum Zeiger). Kacheln suchen erst die
 * Spalte unter dem Zeiger (auch eine leere), dann darin die nächste Kachel – gemessen am Zeiger, nicht an der Mitte
 * der oft hohen Kachel.
 */
const collision: CollisionDetection = (args) => {
  const type = kindOf(args.active.data);
  const only = (...kinds: Kind[]) => args.droppableContainers.filter((c) => kinds.includes(kindOf(c.data) as Kind));
  const p = args.pointerCoordinates;
  // Mit Zeiger zählt dessen Position (der Griff sitzt am Rand, nicht in der Mitte); mit Tastatur das bewegte Rechteck
  const atPointer = p ? { ...args, collisionRect: { top: p.y, bottom: p.y, left: p.x, right: p.x, width: 0, height: 0 } } : args;
  if (type !== 'widget') return closestCenter({ ...atPointer, droppableContainers: only(type ?? 'badge') });
  if (!p) {
    // Tastatur: nächste Kachel oder leere Spalte am Zielpunkt
    return closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((c) => kindOf(c.data) === 'widget' || (kindOf(c.data) === 'slot' && c.data.current?.empty)) });
  }
  const slot = pointerWithin({ ...args, droppableContainers: only('slot') })[0] ?? closestCenter({ ...atPointer, droppableContainers: only('slot') })[0];
  if (!slot) return [];
  const column = String(slot.id).slice('slot:'.length);
  const tiles = args.droppableContainers.filter((c) => kindOf(c.data) === 'widget' && c.data.current?.column === column);
  if (!tiles.length) return [slot];
  const direct = pointerWithin({ ...args, droppableContainers: tiles });
  return direct.length ? direct : closestCenter({ ...atPointer, droppableContainers: tiles });
};

/** Pfeiltasten springen nur zu Zielen der eigenen Art (Kennzahl → Kennzahl, Spalte → Spalte, Kachel → Kachel/leere Spalte). */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const type = kindOf(args.context.active?.data);
  const all = args.context.droppableContainers;
  const fits = (c: { data: { current?: Record<string, any> } }) => (type === 'widget' ? kindOf(c.data) === 'widget' || (kindOf(c.data) === 'slot' && !!c.data.current?.empty) : kindOf(c.data) === type);
  const filtered = { get: (id: UniqueIdentifier) => all.get(id), getEnabled: () => all.getEnabled().filter(fits) };
  return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: filtered as unknown as typeof all } });
};

const INSTRUCTIONS = 'Zum Verschieben Leertaste oder Eingabetaste drücken, mit den Pfeiltasten bewegen, mit Leertaste oder Eingabetaste ablegen, mit Escape abbrechen.';

/** Griff: der einzige Bereich, der ein Ziehen startet – Schaltflächen und Links in der Kachel bleiben bedienbar. */
function Handle({ sortable, label }: { sortable: ReturnType<typeof useSortable>; label: string }) {
  return (
    <button
      type="button"
      ref={sortable.setActivatorNodeRef}
      {...sortable.attributes}
      {...sortable.listeners}
      aria-label={label}
      title={label}
      data-dash-handle=""
      className="inline-flex items-center justify-center shrink-0 w-10 h-10 rounded-control text-fg-muted bg-transparent border border-transparent hover:bg-raised hover:text-fg cursor-grab active:cursor-grabbing touch-none select-none"
    >
      <Icon name="GripVertical" size={18} />
    </button>
  );
}

const dragStyle = (s: ReturnType<typeof useSortable>, extra?: CSSProperties): CSSProperties => ({ ...extra, transform: CSS.Translate.toString(s.transform), transition: s.transition, opacity: s.isDragging ? 0.4 : undefined });

function SortableBadge({ id, d, onHide }: { id: string; d: any; onHide: () => void }) {
  const s = useSortable({ id, data: { type: 'badge' }, attributes: { roleDescription: 'verschiebbare Kennzahl' } });
  const title = BADGE_TITLES[id];
  return (
    <div ref={s.setNodeRef} style={dragStyle(s)} data-dash-badge={id} className="flex-1 min-w-[200px] flex items-stretch gap-0.5 rounded-node border border-dashed border-line bg-card p-1">
      <div className="flex items-center">
        <Handle sortable={s} label={`Kennzahl „${title}“ verschieben`} />
      </div>
      <BadgeTile id={id} d={d} className="flex-1 !border-transparent !px-2 !py-1.5" />
      <div className="flex items-center">
        <Button variant="ghost" iconOnly icon="EyeOff" className="!w-10 !h-10" aria-label={`Kennzahl „${title}“ ausblenden`} title="Ausblenden" onClick={onHide} />
      </div>
    </div>
  );
}

function SortablePanel({ id, column, d, onHide }: { id: string; column: string; d: any; onHide: () => void }) {
  const s = useSortable({ id, data: { type: 'widget', column }, attributes: { roleDescription: 'verschiebbare Kachel' } });
  const title = PANEL_TITLES[id];
  return (
    <div ref={s.setNodeRef} style={dragStyle(s)} data-dash-widget={id} className="rounded-card border border-dashed border-line bg-bg min-w-0">
      <div className="flex items-center gap-1 px-1 py-1">
        <Handle sortable={s} label={`Kachel „${title}“ verschieben`} />
        <span className="flex-1 min-w-0 truncate font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{title}</span>
        <Button variant="ghost" iconOnly icon="EyeOff" className="!w-10 !h-10" aria-label={`Kachel „${title}“ ausblenden`} title="Ausblenden" onClick={onHide} />
      </div>
      <div className="p-2 pt-0">
        <PanelTile id={id} d={d} />
      </div>
    </div>
  );
}

function SortableColumn({ col, index, count, d, available, onWeight, onDelete, onHide }: { col: EditColumn; index: number; count: number; d: any; available: string[]; onWeight: (w: ColumnWeight) => void; onDelete: () => void; onHide: (id: string) => void }) {
  const s = useSortable({ id: col.key, data: { type: 'column' }, attributes: { roleDescription: 'verschiebbare Spalte' } });
  const widgets = col.widgets.filter((w) => available.includes(w));
  const slot = useDroppable({ id: slotId(col.key), data: { type: 'slot', column: col.key, empty: widgets.length === 0 } });
  const n = index + 1;
  const deletable = col.widgets.length === 0 && count > 1;
  return (
    <div ref={s.setNodeRef} style={dragStyle(s, columnStyle(col.weight))} data-dash-column={col.key} className="flex flex-col gap-2 rounded-card border border-line bg-raised p-2 min-w-0">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Handle sortable={s} label={`Spalte ${n} verschieben`} />
        <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted mr-auto">Spalte {n}</span>
        <Select value={col.weight} onChange={(e) => onWeight(Number(e.target.value) as ColumnWeight)} aria-label={`Breite von Spalte ${n}`} className="!w-[112px] !h-10 !bg-card">
          {WEIGHTS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
        <Button iconOnly icon="Trash2" className="!w-10 !h-10" aria-label={`Spalte ${n} löschen`} title={deletable ? 'Leere Spalte löschen' : count <= 1 ? 'Die letzte Spalte bleibt' : 'Nur leere Spalten lassen sich löschen'} disabled={!deletable} onClick={onDelete} />
      </div>
      <SortableContext items={widgets} strategy={verticalListSortingStrategy}>
        <div ref={slot.setNodeRef} data-dash-slot={col.key} className={cx('flex flex-col gap-3 flex-1 min-h-[112px] rounded-node', slot.isOver && widgets.length === 0 && 'shadow-ring')}>
          {widgets.map((id) => (
            <SortablePanel key={id} id={id} column={col.key} d={d} onHide={() => onHide(id)} />
          ))}
          {widgets.length === 0 && <p className="m-0 flex-1 flex items-center justify-center min-h-[112px] rounded-node border border-dashed border-line text-meta text-fg-muted text-center px-3">Kacheln hierher ziehen</p>}
        </div>
      </SortableContext>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <span className="font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{title}</span>
      {children}
    </div>
  );
}

export interface EditorProps {
  draft: EditLayout;
  onChange: (fn: (l: EditLayout) => EditLayout) => void;
  /** Widgets, die diese Person sehen darf (vom Server) */
  available: string[];
  d: any;
  /** Nur für die Administration: Rollen für gemeinsame Vorlagen und vorhandene Vorlagen */
  templates?: { roles: { id: string; label: string }[]; existing: string[]; busy: boolean; onSave: (target: string) => void; onRemove: (target: string) => void };
}

export default function DashboardEditor({ draft, onChange, available, d, templates }: EditorProps) {
  const [active, setActive] = useState<{ id: string; type: Kind } | null>(null);
  const [target, setTarget] = useState('');
  const beforeDrag = useRef<EditLayout | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }));

  const badges = draft.badges.filter((id) => available.includes(id));
  const hiddenBadges = available.filter((id) => isBadge(id) && !draft.badges.includes(id));
  const hiddenPanels = available.filter((id) => isPanel(id) && !columnOf(draft, id));
  const mobile = draft.mobile.filter((id) => available.includes(id));
  const mobileRest = available.filter((id) => isPanel(id) && !draft.mobile.includes(id));

  const label = (id: UniqueIdentifier) => {
    const s = String(id);
    const col = draft.columns.findIndex((c) => c.key === s || slotId(c.key) === s);
    return col >= 0 ? `Spalte ${col + 1}` : `„${titleOf(s)}“`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `${label(a.id)} aufgenommen.`,
    onDragOver: ({ active: a, over }) => (over ? `${label(a.id)} liegt jetzt bei ${label(over.id)}.` : `${label(a.id)} liegt über keinem Ziel.`),
    onDragEnd: ({ active: a, over }) => (over ? `${label(a.id)} bei ${label(over.id)} abgelegt.` : `${label(a.id)} abgelegt.`),
    onDragCancel: ({ active: a }) => `Verschieben abgebrochen. ${label(a.id)} liegt wieder am alten Platz.`,
  };

  const onDragStart = ({ active: a }: DragStartEvent) => {
    beforeDrag.current = draft;
    setActive({ id: String(a.id), type: kindOf(a.data) ?? 'widget' });
  };

  /** Kachel wechselt die Spalte, sobald sie über einer anderen Spalte liegt; die Reihenfolge in der Spalte folgt beim Ablegen. */
  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    if (!over || kindOf(a.data) !== 'widget') return;
    const id = String(a.id);
    const overKind = kindOf(over.data);
    const overId = String(over.id);
    const pointerBelow = !!a.rect.current.translated && a.rect.current.translated.top > over.rect.top + over.rect.height / 2;
    onChange((l) => {
      const from = columnOf(l, id);
      const to = overKind === 'slot' ? overId.slice('slot:'.length) : columnOf(l, overId);
      if (!from || !to || from === to) return l;
      if (overKind === 'slot') return placeWidget(l, id, to);
      const idx = l.columns.find((c) => c.key === to)!.widgets.indexOf(overId);
      return placeWidget(l, id, to, idx + (pointerBelow ? 1 : 0));
    });
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    setActive(null);
    beforeDrag.current = null;
    if (!over || a.id === over.id) return;
    const id = String(a.id);
    const overId = String(over.id);
    const type = kindOf(a.data);
    onChange((l) => {
      if (type === 'badge') {
        const from = l.badges.indexOf(id);
        const to = l.badges.indexOf(overId);
        return from < 0 || to < 0 ? l : { ...l, badges: move(l.badges, from, to) };
      }
      if (type === 'column') {
        const from = l.columns.findIndex((c) => c.key === id);
        const to = l.columns.findIndex((c) => c.key === overId);
        return from < 0 || to < 0 ? l : { ...l, columns: move(l.columns, from, to) };
      }
      const key = columnOf(l, id);
      if (!key || key !== columnOf(l, overId)) return l;
      return { ...l, columns: l.columns.map((c) => (c.key === key ? { ...c, widgets: move(c.widgets, c.widgets.indexOf(id), c.widgets.indexOf(overId)) } : c)) };
    });
  };

  const onDragCancel = () => {
    const before = beforeDrag.current;
    if (before) onChange(() => before);
    beforeDrag.current = null;
    setActive(null);
  };

  const swapMobile = (i: number, j: number) => onChange((l) => ({ ...l, mobile: move(l.mobile, l.mobile.indexOf(mobile[i]), l.mobile.indexOf(mobile[j])) }));

  return (
    <div className="flex flex-col gap-5">
      <Card title="Dashboard anpassen" subtitle="Am Griff ziehen (Maus, Finger oder Tastatur), Spaltenbreite wählen, Widgets ein- und ausblenden. Gespeichert wird erst mit „Für mich speichern“.">
        <div className="flex flex-col gap-5 text-sm">
          <Section title="Widgets hinzufügen">
            {hiddenBadges.length + hiddenPanels.length === 0 ? (
              <p className="m-0 text-fg-muted">Alle verfügbaren Widgets sind eingeblendet.</p>
            ) : (
              <div className="flex flex-wrap gap-2 items-center">
                {hiddenBadges.map((id) => (
                  <Button key={id} size="sm" icon="Plus" className="!h-10" aria-label={`Kennzahl „${BADGE_TITLES[id]}“ hinzufügen`} onClick={() => onChange((l) => addWidget(l, id))}>
                    Kennzahl: {BADGE_TITLES[id]}
                  </Button>
                ))}
                {hiddenPanels.map((id) => (
                  <Button key={id} size="sm" icon="Plus" className="!h-10" aria-label={`Kachel „${PANEL_TITLES[id]}“ hinzufügen`} onClick={() => onChange((l) => addWidget(l, id))}>
                    {PANEL_TITLES[id]}
                  </Button>
                ))}
              </div>
            )}
          </Section>
          <Section title="Reihenfolge auf dem Handy">
            <p className="m-0 text-fg-muted">Auf schmalen Bildschirmen stehen die Kennzahlen oben, darunter diese Kacheln untereinander.</p>
            {mobile.length > 0 && (
              <ol className="m-0 p-0 list-none flex flex-col gap-1 max-w-[520px]">
                {mobile.map((id, i) => (
                  <li key={id} className="flex items-center gap-1.5">
                    <span className="font-mono text-meta text-fg-muted w-5 text-right tabular">{i + 1}</span>
                    <span className="flex-1 min-w-0 truncate">{PANEL_TITLES[id]}</span>
                    <Button iconOnly icon="ArrowUp" className="!w-10 !h-10" aria-label={`${PANEL_TITLES[id]} auf dem Handy nach oben`} disabled={i === 0} onClick={() => swapMobile(i, i - 1)} />
                    <Button iconOnly icon="ArrowDown" className="!w-10 !h-10" aria-label={`${PANEL_TITLES[id]} auf dem Handy nach unten`} disabled={i === mobile.length - 1} onClick={() => swapMobile(i, i + 1)} />
                    <Button iconOnly icon="X" className="!w-10 !h-10" aria-label={`${PANEL_TITLES[id]} auf dem Handy nicht zeigen`} onClick={() => onChange((l) => ({ ...l, mobile: l.mobile.filter((w) => w !== id) }))} />
                  </li>
                ))}
              </ol>
            )}
            {mobileRest.length > 0 && (
              <div className="flex flex-wrap gap-2 items-center">
                {mobileRest.map((id) => (
                  <Button key={id} size="sm" icon="Smartphone" className="!h-10" aria-label={`${PANEL_TITLES[id]} auf dem Handy zeigen`} onClick={() => onChange((l) => ({ ...l, mobile: [...l.mobile, id] }))}>
                    {PANEL_TITLES[id]}
                  </Button>
                ))}
              </div>
            )}
          </Section>
          {templates && (
            <Section title="Gemeinsame Vorlage">
              <div className="flex flex-wrap gap-2 items-center">
                <label htmlFor="dash-template-target" className="text-fg-muted">
                  Als Vorlage speichern für
                </label>
                <Select id="dash-template-target" value={target} onChange={(e) => setTarget(e.target.value)} className="!w-[220px] !h-10">
                  <option value="">– wählen –</option>
                  <option value="*">alle{templates.existing.includes('*') ? ' (Vorlage vorhanden)' : ''}</option>
                  {templates.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      Rolle {r.label}
                      {templates.existing.includes(r.id) ? ' (Vorlage vorhanden)' : ''}
                    </option>
                  ))}
                </Select>
                <Button className="!h-10" icon="LayoutTemplate" disabled={!target || templates.busy} onClick={() => templates.onSave(target)}>
                  Als Vorlage speichern
                </Button>
                {target && templates.existing.includes(target) && (
                  <Button className="!h-10" variant="ghost" icon="Trash2" disabled={templates.busy} onClick={() => templates.onRemove(target)}>
                    Vorlage entfernen
                  </Button>
                )}
              </div>
              <p className="m-0 text-fg-muted">Eine Vorlage gilt für alle, die ihr Dashboard nicht selbst angepasst haben. Jede Person sieht daraus nur die Widgets, für die sie das Recht hat.</p>
            </Section>
          )}
        </div>
      </Card>

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{ announcements, screenReaderInstructions: { draggable: INSTRUCTIONS } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <section aria-label="Kennzahlen" className="flex flex-col gap-2">
          <SortableContext items={badges} strategy={rectSortingStrategy}>
            <div className="flex flex-wrap gap-3" data-dash-badges="">
              {badges.map((id) => (
                <SortableBadge key={id} id={id} d={d} onHide={() => onChange((l) => removeWidget(l, id))} />
              ))}
              {badges.length === 0 && <p className="m-0 flex-1 rounded-node border border-dashed border-line px-3 py-4 text-meta text-fg-muted text-center">Keine Kennzahl eingeblendet.</p>}
            </div>
          </SortableContext>
        </section>

        <section aria-label="Spalten" className="flex flex-col gap-3">
          <SortableContext items={draft.columns.map((c) => c.key)} strategy={rectSortingStrategy}>
            <div className="flex flex-wrap items-stretch gap-4" data-dash-columns="">
              {draft.columns.map((col, i) => (
                <SortableColumn
                  key={col.key}
                  col={col}
                  index={i}
                  count={draft.columns.length}
                  d={d}
                  available={available}
                  onWeight={(w) => onChange((l) => setWeight(l, col.key, w))}
                  onDelete={() => onChange((l) => removeColumn(l, col.key))}
                  onHide={(id) => onChange((l) => removeWidget(l, id))}
                />
              ))}
            </div>
          </SortableContext>
          <div className="flex items-center gap-3 flex-wrap">
            <Button icon="Plus" className="!h-10" disabled={draft.columns.length >= MAX_COLUMNS} onClick={() => onChange(addColumn)}>
              Spalte hinzufügen
            </Button>
            <span className="text-meta text-fg-muted">
              {draft.columns.length} von {MAX_COLUMNS} Spalten · auf schmalen Bildschirmen stehen die Spalten untereinander
            </span>
          </div>
        </section>

        <DragOverlay dropAnimation={null}>
          {active ? (
            <div className="inline-flex items-center gap-2 max-w-[280px] px-3 h-10 rounded-node bg-card border border-primary shadow-float text-sm font-medium cursor-grabbing">
              <Icon name="GripVertical" size={16} className="text-fg-muted" />
              <span className="truncate">{active.type === 'column' ? label(active.id) : titleOf(active.id)}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
