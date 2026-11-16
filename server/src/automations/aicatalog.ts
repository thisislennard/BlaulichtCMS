import { FIELD_KEY, IMAGE_FIELDS, INPUT_KINDS, LIMITS, NODE_TYPES, OPERATORS, OUTPUT_KINDS, SYSTEM_FIELDS, type FieldDef, type InputKind, type NodeType, type OutputKind } from './catalog.js';
import { outputNeeds, type InputRef, type OutputRef } from './graph.js';
import { CATALOG_FILE, nodeHandles, SCHEMA_FILE, SCHEMA_URL_PATH } from './format.js';
import { TRANSFER_FORMAT, TRANSFER_SCHEMA_VERSION } from './transfer.js';

/*
 * „Katalog exportieren“ (#199): alles, was eine KI braucht, um eine Workflow-Datei für genau diese Installation zu
 * entwerfen – und nichts darüber hinaus. Gebaut wird ausschließlich aus einer Positivliste: Art und Name der Ein- und
 * Ausgänge, Feldnamen (beim manuellen Start Name + Bezeichnung, bei Ausgängen die verwendeten Platzhalter), Namen und
 * Textfelder der Bildvorlagen, Namen der Kalender-Kategorien, das aktive Stichwortverzeichnis (Stichwort, Bezeichnung,
 * Kategorie). Keine Kennungen, Einstellungen, Zugangsdaten, Einsatz-/Warndaten, Läufe, Medien, Konten oder Kontakte.
 */

export const CATALOG_FORMAT = 'blaulichtcms.automations.catalog';
export const CATALOG_VERSION = 1;

export interface AiCatalogSource {
  appVersion: string;
  now?: Date;
  inputs: Iterable<InputRef>;
  outputs: Iterable<OutputRef>;
  /** Befüllbare Bildvorlagen (Titel + Layout); nur Textfelder werden übernommen */
  imageTemplates: { title: string; layout: { elements?: { type?: string; id?: string; label?: string; maxLength?: number }[] } | null }[];
  calendarCategories: string[];
  keywords: { state: string; stateName: string; entries: { code: string; label: string; category: string }[] };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const field = (f: FieldDef) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}), ...(f.example ? { example: f.example } : {}) });
const byKindName = <T extends { kind: string; name: string }>(a: T, b: T) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'de');

export function buildAiCatalog(src: AiCatalogSource) {
  const inputs = [...src.inputs]
    .filter((i) => !i.archived && i.kind in INPUT_KINDS)
    .map((i) => {
      const own = i.kind === 'manual' && Array.isArray(i.config?.fields) ? (i.config.fields as unknown[]).flatMap((f) => (f && typeof f === 'object' && typeof (f as any).key === 'string' && FIELD_KEY.test((f as any).key) ? [{ key: (f as any).key as string, label: text((f as any).label, 80) }] : [])) : [];
      return { kind: i.kind, name: text(i.name, 120), ...(own.length ? { fields: own } : {}) };
    })
    .sort(byKindName);
  const outputs = [...src.outputs]
    .filter((o) => !o.archived && o.kind in OUTPUT_KINDS)
    .map((o) => ({ kind: o.kind, name: text(o.name, 120), usesFields: outputNeeds(o).filter((k) => FIELD_KEY.test(k)) }))
    .sort(byKindName);
  const imageTemplates = src.imageTemplates
    .map((t) => ({
      name: text(t.title, 150),
      textFields: (t.layout?.elements ?? []).filter((e) => e?.type === 'text' && typeof e.id === 'string' && FIELD_KEY.test(e.id)).map((e) => ({ id: e.id as string, label: text(e.label, 80), ...(typeof e.maxLength === 'number' ? { maxLength: e.maxLength } : {}) })),
    }))
    .filter((t) => t.name);
  return {
    format: CATALOG_FORMAT,
    catalogVersion: CATALOG_VERSION,
    workflowFile: { format: TRANSFER_FORMAT, schemaVersion: TRANSFER_SCHEMA_VERSION, schema: SCHEMA_FILE, schemaPath: SCHEMA_URL_PATH },
    appVersion: src.appVersion,
    exportedAt: (src.now ?? new Date()).toISOString(),
    notes: [
      'Katalog dieser BlaulichtCMS-Installation zum Entwerfen von Workflow-Dateien. Er enthält keine Zugangsdaten, Kennungen, Einsatz- oder Personendaten.',
      `Die Workflow-Datei muss dem JSON-Schema ${SCHEMA_FILE} entsprechen (Format „${TRANSFER_FORMAT}“, schemaVersion ${TRANSFER_SCHEMA_VERSION}).`,
      'Ein- und Ausgänge der Datei stammen aus „inputs“ bzw. „outputs“: unter references mit kind und genau diesem name eintragen, im Knoten mit inputRef/outputRef darauf verweisen.',
      'Felder eines Auslösers: systemFields plus triggers[kind].fields; beim manuellen Start zusätzlich die fields des Eingangs. Danach kommen Felder aus „Felder setzen“, „Bild aus Vorlage erzeugen“ (imageFields) und vorherigen Ausgängen (actions[kind].producesFields) hinzu.',
      'usesFields eines Ausgangs: Platzhalter, die seine Texte verwenden. Sie müssen an dieser Stelle vorhanden sein – sonst vorher mit „Felder setzen“ anlegen oder einen anderen Ausgang wählen.',
      'Stichwörter (keywords) helfen bei Bedingungen auf stichwort, stichwort_text und stichwort_kategorie; Kalender-Kategorien bei Bedingungen auf kategorie.',
    ],
    nodeTypes: (Object.keys(NODE_TYPES) as NodeType[]).map((t) => ({ type: t, label: NODE_TYPES[t].label, description: NODE_TYPES[t].description, sourceHandles: nodeHandles(t) })),
    systemFields: SYSTEM_FIELDS.map(field),
    triggers: (Object.keys(INPUT_KINDS) as InputKind[]).map((k) => {
      const d = INPUT_KINDS[k];
      return { kind: k, label: d.label, description: d.description, ...(d.phases ? { phases: d.phases } : {}), fields: d.fields.map(field) };
    }),
    actions: (Object.keys(OUTPUT_KINDS) as OutputKind[]).map((k) => ({ kind: k, label: OUTPUT_KINDS[k].label, description: OUTPUT_KINDS[k].description, producesFields: OUTPUT_KINDS[k].produces.map(field) })),
    imageFields: IMAGE_FIELDS.map(field),
    operators: Object.entries(OPERATORS).map(([op, label]) => ({ op, label })),
    limits: LIMITS,
    inputs,
    outputs,
    imageTemplates,
    calendarCategories: [...new Set(src.calendarCategories.map((c) => text(c, 80)).filter(Boolean))],
    keywords: {
      state: src.keywords.state,
      stateName: src.keywords.stateName,
      entries: src.keywords.entries.map((k) => ({ code: text(k.code, 40), label: text(k.label, 200), category: text(k.category, 80) })),
    },
  };
}

export type AiCatalog = ReturnType<typeof buildAiCatalog>;
