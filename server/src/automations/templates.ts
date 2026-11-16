import type { InputKind, OutputKind, Operator } from './catalog.js';
import { graphSchema, outputNeeds, slotFields, type Graph, type InputRef, type OutputRef } from './graph.js';

/*
 * Vorlagen für neue Workflows: fertige Abläufe nur aus Eingängen, Bedingungen und Ausgängen des Katalogs. Ein- und
 * Ausgänge sind „Plätze“: Gibt es genau einen passenden Ein- bzw. Ausgang, wird er eingesetzt, sonst bleibt der Platz
 * offen (data.want nennt die passenden Arten und Startwerte, um ihn direkt im Workflow anzulegen).
 */

export interface SlotPreset {
  /** Vorschlag für den Namen eines neu angelegten Ein-/Ausgangs */
  name: string;
  /** Startwerte der Einstellungen (werden beim Anlegen serverseitig geprüft) */
  config: Record<string, unknown>;
}

export interface TemplateDef {
  id: string;
  title: string;
  description: string;
  icon: string;
  input?: { kinds: InputKind[]; preset?: SlotPreset };
  rules?: { field: string; op: Operator; value?: string }[];
  outputs: { kind: OutputKind; preset: SlotPreset }[];
}

const ALARM: InputKind[] = ['fe2', 'feuersoftware'];

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'alarm-banner',
    title: 'Alarm → Banner auf der Website',
    description: 'Bei einem neuen Einsatz einen Banner-Entwurf „Einsatz in …“ für die Website vorbereiten.',
    icon: 'Megaphone',
    input: { kinds: ALARM, preset: { name: 'Alarm', config: { phases: ['neu'] } } },
    outputs: [
      {
        kind: 'banner',
        preset: { name: 'Banner „Einsatz“', config: { title: 'Einsatz: {{stichwort_text}}', text: 'Einsatz in {{ort}}. Bitte den Bereich meiden und Rettungswege frei halten.', tone: 'warning', priority: 2, durationHours: 3, submit: true } },
      },
    ],
  },
  {
    id: 'dwd-banner-post',
    title: 'DWD-Warnung → Banner + Beitragsentwurf',
    description: 'Bei einer Warnung des Deutschen Wetterdienstes einen Banner nach Warnstufe und einen Beitragsentwurf anlegen.',
    icon: 'AlertTriangle',
    input: { kinds: ['warnfeed'], preset: { name: 'Amtliche Warnung', config: { phases: ['neu'], onlyInArea: true } } },
    rules: [{ field: 'quelle', op: 'eq', value: 'Deutscher Wetterdienst' }],
    outputs: [
      {
        kind: 'banner',
        preset: { name: 'Banner „Unwetter“', config: { title: '{{ueberschrift}}', text: '{{gebiete}} – Details bei der Originalquelle. Quelle: {{quelle}}', tone: 'auto', priority: 3, endFromField: true, linkUrl: '{{link}}', linkText: 'Zur Warnung', submit: true } },
      },
      {
        kind: 'post',
        preset: { name: 'Beitrag „Unwetter“', config: { kind: 'situation', title: '{{ereignis}}: {{ueberschrift}}', body: '{{beschreibung}}\n\n{{verhalten}}\n\nBetroffene Gebiete: {{gebiete}}\nQuelle: {{quelle}} ({{link}})', submit: false } },
      },
    ],
  },
  {
    id: 'alarm-fire-post',
    title: 'Alarm mit Stichwort-Kategorie Brand → Beitragsentwurf',
    description: 'Nur bei Bränden (Kategorie aus dem Stichwortverzeichnis) einen Beitragsentwurf mit Stichwort und Ort anlegen.',
    icon: 'Siren',
    input: { kinds: ALARM, preset: { name: 'Alarm', config: { phases: ['neu'] } } },
    rules: [{ field: 'stichwort_kategorie', op: 'eq', value: 'Brand' }],
    outputs: [
      {
        kind: 'post',
        preset: { name: 'Beitrag „Einsatz“', config: { kind: 'incident', title: '{{stichwort_text}} in {{ort}}', body: 'Alarm um {{alarmzeit}}. Im Einsatz: {{einheiten}}.', submit: false } },
      },
    ],
  },
  {
    id: 'warning-notify',
    title: 'Warnung → Benachrichtigen',
    description: 'Bei einer neuen amtlichen Warnung im eigenen Gebiet die Redaktion in BlaulichtCMS benachrichtigen.',
    icon: 'Bell',
    input: { kinds: ['warnfeed'], preset: { name: 'Amtliche Warnung', config: { phases: ['neu'], onlyInArea: true } } },
    outputs: [
      {
        kind: 'notify',
        preset: { name: 'Redaktion benachrichtigen', config: { roles: ['editor'], kind: 'warning', title: 'Warnung: {{ereignis}}', body: '{{ueberschrift}} – {{gebiete}}', link: '' } },
      },
    ],
  },
  {
    id: 'calendar-exercise-banner',
    title: 'Übung im Kalender → Banner „Achtung Übung“',
    description: 'Zu Beginn eines Termins der Kategorie „Übung“ einen Banner-Entwurf auf der Website vorbereiten, der bis zum Ende der Übung gilt.',
    icon: 'CalendarDays',
    input: { kinds: ['calendar'], preset: { name: 'Kalender: Beginn eines Termins', config: { timing: 'start' } } },
    rules: [{ field: 'kategorie', op: 'eq', value: 'Übung' }],
    outputs: [
      {
        kind: 'banner',
        preset: { name: 'Banner „Achtung Übung“', config: { title: 'Achtung Übung', text: '{{titel}} – {{ort}}. Es handelt sich um eine Übung, es besteht keine Gefahr.', tone: 'info', priority: 2, durationHours: 4, endFromField: true, submit: true } },
      },
    ],
  },
];

export function templateById(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Ablauf einer Vorlage. Jeder Platz bekommt den einzigen passenden vorhandenen Ein-/Ausgang (nicht gelöscht) oder bleibt
 * offen. Ein Ausgang passt nur, wenn alle seine Platzhalter vom Auslöser der Vorlage geliefert werden (ein Banner mit
 * {{stichwort}} passt nicht zu einer amtlichen Warnung). Ohne Bedingung führt der Eingang direkt zu allen Ausgängen, sonst über „trifft zu“.
 */
export function templateGraph(t: TemplateDef, refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }): { graph: Graph; open: number } {
  let open = 0;
  const avail = new Set(slotFields({ type: 'input', data: { want: { kinds: t.input?.kinds ?? [] } } }).map((f) => f.key));
  const only = <T extends { kind: string; archived?: boolean; id: string }>(pool: Iterable<T>, kinds: string[], fits: (x: T) => boolean = () => true) => {
    const c = [...pool].filter((x) => !x.archived && kinds.includes(x.kind) && fits(x));
    return c.length === 1 ? c[0].id : undefined;
  };
  const nodes: Graph['nodes'] = [];
  const edges: Graph['edges'] = [];
  if (t.input) {
    const id = only(refs.inputs.values(), t.input.kinds);
    if (!id) open++;
    nodes.push({ id: 'in1', type: 'input', position: { x: 0, y: 0 }, data: id ? { inputId: id } : { want: { kinds: t.input.kinds, ...(t.input.preset ?? {}) } } });
  }
  if (t.rules?.length) {
    nodes.push({ id: 'if1', type: 'condition', position: { x: 320, y: 0 }, data: { combinator: 'and', rules: t.rules.map((r) => ({ ...r })) } });
    if (t.input) edges.push({ id: 'e_in1_if1', source: 'in1', sourceHandle: 'out', target: 'if1' });
  }
  t.outputs.forEach((o, i) => {
    const nid = `out${i + 1}`;
    const id = only(refs.outputs.values(), [o.kind], (x) => outputNeeds(x).every((k) => avail.has(k)));
    if (!id) open++;
    nodes.push({ id: nid, type: 'output', position: { x: t.rules?.length ? 640 : 320, y: i * 170 }, data: id ? { outputId: id } : { want: { kinds: [o.kind], ...o.preset } } });
    if (t.rules?.length) edges.push({ id: `e_if1_${nid}`, source: 'if1', sourceHandle: 'true', target: nid });
    else if (t.input) edges.push({ id: `e_in1_${nid}`, source: 'in1', sourceHandle: 'out', target: nid });
  });
  return { graph: graphSchema.parse({ nodes, edges }), open };
}
