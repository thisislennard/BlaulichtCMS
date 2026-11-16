import { z } from 'zod';
import { IMAGE_FIELDS, INPUT_KINDS, LIMITS, NODE_TYPES, OPERATORS, OUTPUT_KINDS, SYSTEM_FIELDS, outputPorts, type FieldDef, type InputKind, type NodeType, type OutputKind } from './catalog.js';
import { NODE_DATA, type InputRef, type OutputRef } from './graph.js';
import { templateById, templateGraph } from './templates.js';
import { buildExport, fileNodeSchema, inputReferenceSchema, outputReferenceSchema, REF_PATTERN, TRANSFER_FORMAT, TRANSFER_MAX_AUTOMATIONS, TRANSFER_SCHEMA_VERSION, transferFileSchema, type TransferFile } from './transfer.js';

/*
 * Formatbeschreibung der Workflow-Datei (#199) für „Workflows mit KI erstellen“: JSON-Schema (Draft 2020-12),
 * Referenz für die Hilfe und die Vorlage für die Anfrage an eine KI. Alles wird aus der echten Prüfung
 * (transfer.ts, graph.ts) und dem Katalog erzeugt – `npx tsx scripts/workflow-format.mjs` schreibt Schema-Datei und
 * Hilfe neu, der Unit-Test „workflow-format“ schlägt fehl, wenn beides veraltet ist.
 */

/** Dateiname des Schemas; die Oberfläche liefert es statisch aus (web/public/schema/…). */
export const SCHEMA_FILE = `blaulichtcms-automations-${TRANSFER_SCHEMA_VERSION}.schema.json`;
export const SCHEMA_URL_PATH = `/schema/${SCHEMA_FILE}`;
/** Dateiname des Katalogs („Katalog exportieren“). */
export const CATALOG_FILE = 'workflow-katalog.json';

type Json = Record<string, any>;

/** JSON-Schema eines Zod-Schemas (Eingabeseite: Standardwerte machen Angaben optional), ohne eigenes `$schema`. */
function js(schema: z.ZodType): Json {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
}

const labelSchema = z.string().trim().max(80);
const code = (s: string) => `\`${s}\``;

/** Ausgänge (sourceHandle) je Knotenart, z. B. „true (trifft zu)“ und „false (trifft nicht zu)“. */
export function nodeHandles(type: NodeType): { id: string; label: string }[] {
  if (type === 'switch') return [{ id: 'case:<id>', label: 'je Fall, id aus cases' }, { id: 'default', label: 'sonst' }];
  return outputPorts({ type, data: {} });
}
const handleText = (type: NodeType) => nodeHandles(type).map((h) => `${h.id} (${h.label})`).join(', ');

/** Hinweise je Knotenart (Zahlen aus den Grenzen des Katalogs). */
const DATA_NOTES: Record<NodeType, string> = {
  input: 'inputRef: Bezug aus references.inputs (z. B. „in1“). Ohne inputRef bleibt der Auslöser offen und wird nach dem Import gewählt.',
  output: 'outputRef: Bezug aus references.outputs (z. B. „out1“). Texte, Empfänger und Gestaltung stehen im Ausgang selbst, nicht in der Datei.',
  condition: `Regeln „Feld – Vergleich – Wert“ (field, op, value), verknüpft mit combinator „and“ oder „or“; höchstens ${LIMITS.maxConditionRules} Regeln und eine Ebene Untergruppen ({ combinator, rules }).`,
  switch: `field: Feld, nach dessen Wert verzweigt wird; cases: 1–${LIMITS.maxCases} Fälle { id, value }.`,
  template: 'fields: 1–20 Einträge { key, template } – legt das Feld key mit dem Text aus template an (Platzhalter {{feld}} erlaubt).',
  delay: `minutes: 1–${LIMITS.maxDelayMinutes}.`,
  dedup: `fields: 1–5 Feldnamen als Schlüssel; windowMinutes: Zeitfenster 1–${LIMITS.maxDedupMinutes}.`,
  approval: `title und summary (mit Platzhaltern); timeoutHours: 1–${LIMITS.maxApprovalHours} – ohne Entscheidung gilt die Anfrage danach als abgelehnt.`,
  merge: 'Keine Einstellungen.',
  image: 'templateName: Name einer Bildvorlage aus dem Katalog; texts: Kennung des Textfelds der Vorlage → Text mit Platzhaltern; altText: Alternativtext. templateId, images und collectionId gehören zur Installation und werden in Dateien nicht verwendet.',
};

/** Schema für `data` je Knotenart, wie parseTransferFile es prüft. */
function dataSchema(type: NodeType): Json {
  const description = `${NODE_TYPES[type].label}: ${NODE_TYPES[type].description} ${DATA_NOTES[type]}`;
  if (type === 'input' || type === 'output') {
    const key = type === 'input' ? 'inputRef' : 'outputRef';
    return {
      description,
      type: 'object',
      properties: { [key]: { type: 'string', pattern: REF_PATTERN.source, description: `Bezug aus references.${type === 'input' ? 'inputs' : 'outputs'}` }, label: { ...js(labelSchema), description: 'Bezeichnung des Knotens (optional)' } },
      additionalProperties: false,
    };
  }
  return { description, ...js(NODE_DATA[type]) };
}

/** Braucht die Knotenart Angaben in `data` (sonst darf `data` fehlen)? */
const needsData = (type: NodeType) => !NODE_DATA[type].safeParse({}).success && type !== 'input' && type !== 'output';

const kindList = (rec: Record<string, { label: string }>) => Object.entries(rec).map(([k, d]) => `${k} = ${d.label}`).join('; ');

/**
 * JSON-Schema der Workflow-Datei. Erzeugt aus den Zod-Schemas der Importprüfung; Umschlag, Bezüge, Knoten und
 * Verbindungen sind streng (keine unbekannten Schlüssel), `data` je Knotenart entspricht genau der Prüfung beim Import.
 */
export function transferJsonSchema(): Json {
  const file = js(transferFileSchema);
  const automation = file.properties.automations.items;
  const types = Object.keys(NODE_TYPES) as NodeType[];
  const node = js(fileNodeSchema);
  node.additionalProperties = false;
  node.required = ['id', 'type'];
  node.properties.id.description = 'Kennung des Knotens, eindeutig im Workflow (z. B. „in1“, „if1“, „out1“).';
  node.properties.type.description = `Knotenart: ${types.map((t) => `${t} = ${NODE_TYPES[t].label}`).join('; ')}.`;
  node.properties.position.description = 'Lage auf der Fläche des Editors (optional; z. B. x in Schritten von 320 nach rechts, y in Schritten von 170 je Zweig).';
  node.properties.position.additionalProperties = false;
  node.properties.data = { type: 'object', description: 'Einstellungen je Knotenart, siehe $defs/data_<type>.', default: {} };
  node.allOf = types.map((t) => ({
    if: { properties: { type: { const: t } }, required: ['type'] },
    then: { properties: { data: { $ref: `#/$defs/data_${t}` } }, ...(needsData(t) ? { required: ['data'] } : {}) },
  }));
  const edge: Json = { ...automation.properties.graph.properties.edges.items, additionalProperties: false };
  edge.description = 'Verbindung von einem Ausgang (sourceHandle) eines Knotens zum nächsten Knoten.';
  edge.properties.source.description = 'Kennung des Knotens, von dem die Verbindung ausgeht.';
  edge.properties.target.description = 'Kennung des Knotens, zu dem die Verbindung führt (nie ein Eingang).';
  edge.properties.sourceHandle.description = `Ausgang des Quellknotens je Knotenart – ${types.map((t) => `${t}: ${handleText(t)}`).join('; ')}.`;
  edge.properties.targetHandle.description = 'Optional, immer „in“.';
  const inputRef: Json = { ...js(inputReferenceSchema), additionalProperties: false, description: 'Eingang (Auslöser) als Bezug: Art und genauer Name eines vorhandenen Eingangs aus dem Katalog.' };
  inputRef.properties.kind.description = `Art des Eingangs: ${kindList(INPUT_KINDS)}.`;
  const outputRef: Json = { ...js(outputReferenceSchema), additionalProperties: false, description: 'Ausgang (Aktion) als Bezug: Art und genauer Name eines vorhandenen Ausgangs aus dem Katalog.' };
  outputRef.properties.kind.description = `Art des Ausgangs: ${kindList(OUTPUT_KINDS)}.`;
  for (const r of [inputRef, outputRef]) {
    r.properties.ref.description = 'Kennung des Bezugs in dieser Datei: „in1“, „in2“ … für Eingänge, „out1“, „out2“ … für Ausgänge.';
    r.properties.name.description = 'Name genau wie im Katalog (inputs bzw. outputs); beim Import wird der gleichnamige Ein- bzw. Ausgang derselben Art vorgeschlagen.';
  }
  automation.additionalProperties = false;
  automation.properties.name.description = 'Name des Workflows.';
  automation.properties.description.description = 'Kurze Beschreibung (optional).';
  automation.properties.graph.additionalProperties = false;
  automation.properties.graph.properties.nodes.items = { $ref: '#/$defs/node' };
  automation.properties.graph.properties.edges.items = { $ref: '#/$defs/edge' };
  file.properties.automations.items = { $ref: '#/$defs/automation' };
  file.properties.references.additionalProperties = false;
  file.properties.references.description = 'Die im Ablauf verwendeten Ein- und Ausgänge als Bezug (Art + Name) – ohne Kennungen, Einstellungen oder Zugangsdaten.';
  file.properties.references.properties.inputs.items = { $ref: '#/$defs/inputReference' };
  file.properties.references.properties.outputs.items = { $ref: '#/$defs/outputReference' };
  file.properties.format.description = `Immer „${TRANSFER_FORMAT}“.`;
  file.properties.schemaVersion = { ...file.properties.schemaVersion, maximum: TRANSFER_SCHEMA_VERSION, description: `Formatversion, derzeit ${TRANSFER_SCHEMA_VERSION}.` };
  file.properties.appVersion.description = 'BlaulichtCMS-Version beim Export (nur zur Information, optional).';
  file.properties.exportedAt.description = 'Zeitpunkt des Exports (nur zur Information, optional).';
  file.properties.automations.description = `1–${TRANSFER_MAX_AUTOMATIONS} Workflows.`;
  file.additionalProperties = false;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `BlaulichtCMS-Workflows (Format ${TRANSFER_FORMAT}, schemaVersion ${TRANSFER_SCHEMA_VERSION})`,
    description: [
      'Datei mit einem oder mehreren Workflows für BlaulichtCMS (Import unter Workflows → Importieren; importierte Workflows sind immer inaktive Entwürfe).',
      'Ein Workflow ist ein Ablauf aus Knoten (nodes) und Verbindungen (edges): Eingang (Auslöser) → Verarbeitung → Ausgang (Aktion).',
      'Platzhalter in Texten: {{feldname}} – nur Felder, die an dieser Stelle vorhanden sind (Felder des Auslösers, Systemfelder, Felder aus „Felder setzen“, „Bild aus Vorlage erzeugen“ und vorherigen Ausgängen).',
      'Zusätzlich prüft der Import: Knoten-Kennungen eindeutig je Workflow; inputRef/outputRef verweisen auf einen Eintrag in references; Verbindungen nur zwischen vorhandenen Knoten.',
      'Nach dem Import prüft der Editor außerdem: mindestens ein Eingang und ein Ausgang, jeder Knoten angeschlossen, sourceHandle passend zur Knotenart, keine Kreise, Felder und Platzhalter an der Stelle vorhanden.',
    ].join(' '),
    ...file,
    $defs: {
      automation,
      node,
      edge,
      inputReference: inputRef,
      outputReference: outputRef,
      ...Object.fromEntries(types.map((t) => [`data_${t}`, dataSchema(t)])),
    },
    examples: [exampleFile('alarm-fire-post'), exampleFile('calendar-exercise-story-banner')],
  };
}

/* ------------------------------------------------------------------ Beispiele aus den Vorlagen */

const FAKE_ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Vorlage der Galerie als Exportdatei, wie BlaulichtCMS sie schreiben würde: mit je einem passenden Ein- und Ausgang
 * (Name aus der Vorlage) oder – `open` – mit offenen Plätzen. Ohne appVersion/exportedAt (Beispiel bleibt stabil).
 */
export function exampleFile(templateId: string, opts: { open?: boolean } = {}): TransferFile {
  const t = templateById(templateId);
  if (!t) throw new Error(`Unbekannte Vorlage ${templateId}`);
  const inputs = new Map<string, InputRef>();
  const outputs = new Map<string, OutputRef>();
  if (!opts.open) {
    if (t.input) inputs.set(FAKE_ID(1), { id: FAKE_ID(1), kind: t.input.kinds[0], name: t.input.preset?.name ?? INPUT_KINDS[t.input.kinds[0]].label, config: t.input.preset?.config ?? {} });
    t.outputs.forEach((o, i) => outputs.set(FAKE_ID(10 + i), { id: FAKE_ID(10 + i), kind: o.kind, name: o.preset.name, config: o.preset.config }));
  }
  const refs = { inputs, outputs };
  const { graph } = templateGraph(t, refs);
  const images = new Map<string, string>();
  if (!opts.open) {
    for (const n of graph.nodes) {
      if (n.type === 'image') {
        n.data.templateId = FAKE_ID(99);
        images.set(FAKE_ID(99), 'Story 9:16');
      }
    }
  }
  const file = buildExport([{ name: t.title, description: t.description, graph }], refs, '', new Date(0), images);
  const { appVersion: _v, exportedAt: _e, ...rest } = file;
  return rest as TransferFile;
}

/* ------------------------------------------------------------------ Anfrage an die KI */

/** Vorlage für die Anfrage an eine KI (anbieterneutral); „…“ ersetzt man durch den eigenen Wunsch. */
export const AI_PROMPT = `Ich möchte in BlaulichtCMS einen Workflow anlegen. Im Anhang sind zwei Dateien:
1. die Formatbeschreibung als JSON-Schema (${SCHEMA_FILE}),
2. der Katalog meiner Installation (${CATALOG_FILE}) mit den vorhandenen Eingängen und Ausgängen, den Feldern je Auslöser, den Vergleichen für Bedingungen, den Bildvorlagen und dem Stichwortverzeichnis.

Erstelle eine Workflow-Datei im Format „${TRANSFER_FORMAT}“ (schemaVersion ${TRANSFER_SCHEMA_VERSION}), die genau dem Schema entspricht:
- Verwende nur Knotenarten, Felder, Vergleiche, Ein- und Ausgänge, Bildvorlagen und Stichwörter aus dem Katalog. Erfinde nichts dazu.
- Trage Ein- und Ausgänge unter „references“ mit Art („kind“) und genauem Namen aus dem Katalog ein; die Knoten verweisen darauf mit „inputRef“ (in1, in2 …) bzw. „outputRef“ (out1, out2 …).
- Schreibe Platzhalter als {{feldname}} und verwende nur Felder, die an dieser Stelle vorhanden sind. Braucht ein Ausgang Felder („usesFields“ im Katalog), die der Auslöser nicht liefert, lege sie vorher mit „Felder setzen“ an.
- Verbinde die Knoten über „edges“ mit dem passenden Ausgang („sourceHandle“, z. B. „true“ bei einer zutreffenden Bedingung).
- Gib nur das JSON aus, ohne Erklärungen davor oder danach.

Der Workflow soll: …`;

/* ------------------------------------------------------------------ Referenz für die Hilfe */

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fieldRows = (fields: FieldDef[]) => fields.map((f) => `| ${code(f.key)} | ${esc(f.label)} | ${f.type}${f.options ? `: ${f.options.map(code).join(', ')}` : ''} | ${f.example ? esc(f.example) : '–'} |`);
const FIELD_HEAD = ['| Feld | Bedeutung | Art | Beispiel |', '| --- | --- | --- | --- |'];

/** Pflicht- und optionale Schlüssel eines Objekt-Schemas, z. B. „Pflicht: combinator, rules · optional: label“. */
function keysText(s: Json): string {
  const keys = Object.keys(s.properties ?? {});
  const req = new Set<string>(s.required ?? []);
  const must = keys.filter((k) => req.has(k));
  const opt = keys.filter((k) => !req.has(k));
  return [must.length ? `Pflicht: ${must.map(code).join(', ')}` : '', opt.length ? `optional: ${opt.map(code).join(', ')}` : ''].filter(Boolean).join(' · ') || '–';
}

/**
 * Formatbeschreibung als Markdown für die Hilfe (Abschnitt „Formatbeschreibung“ in workflows-ki.md, zwischen
 * `<!-- ki-format:start -->` und `<!-- ki-format:ende -->`). Unterabschnitte mit `###`.
 */
export function formatReferenceMarkdown(): string {
  const schema = transferJsonSchema();
  const types = Object.keys(NODE_TYPES) as NodeType[];
  const out: string[] = [];
  out.push('### Aufbau der Datei', '');
  out.push('| Schlüssel | Pflicht | Inhalt |', '| --- | --- | --- |');
  out.push(`| ${code('format')} | ja | immer ${code(`"${TRANSFER_FORMAT}"`)} |`);
  out.push(`| ${code('schemaVersion')} | ja | ${code(String(TRANSFER_SCHEMA_VERSION))} |`);
  out.push(`| ${code('references')} | nein | ${code('inputs')} und ${code('outputs')}: je Eintrag ${code('ref')} (${code('in1')}, ${code('in2')} … bzw. ${code('out1')} …), ${code('kind')} (Art) und ${code('name')} (Name aus dem Katalog) |`);
  out.push(`| ${code('automations')} | ja | 1–${TRANSFER_MAX_AUTOMATIONS} Workflows: ${code('name')} (2–120 Zeichen), ${code('description')} (optional, bis 500) und ${code('graph')} mit ${code('nodes')} (bis ${LIMITS.maxNodes}) und ${code('edges')} (bis ${LIMITS.maxEdges}) |`);
  out.push(`| ${code('appVersion')}, ${code('exportedAt')} | nein | nur zur Information |`);
  out.push('');
  out.push(`Ein **Knoten** hat ${code('id')} (1–40 Zeichen aus Buchstaben, Ziffern, ${code('_')} und ${code('-')}; eindeutig im Workflow), ${code('type')}, ${code('data')} und optional ${code('position')} (${code('x')}, ${code('y')}). Eine **Verbindung** hat ${code('id')}, ${code('source')}, ${code('sourceHandle')} (Ausgang des Quellknotens) und ${code('target')}. Andere Schlüssel sind nicht vorgesehen.`);
  out.push('');
  out.push('### Knotenarten', '');
  out.push('| `type` | Baustein | Angaben in `data` | Ausgänge (`sourceHandle`) |', '| --- | --- | --- | --- |');
  for (const t of types) {
    const def = schema.$defs[`data_${t}`];
    out.push(`| ${code(t)} | **${esc(NODE_TYPES[t].label)}** – ${esc(NODE_TYPES[t].description)} | ${keysText(def)}. ${esc(DATA_NOTES[t])} | ${nodeHandles(t).map((h) => `${code(h.id)} (${esc(h.label)})`).join(', ')} |`);
  }
  out.push('');
  out.push('### Auslöser und ihre Felder', '');
  out.push(`Ein Eingang liefert die Felder seiner Art. Zusätzlich steht in jedem Lauf zur Verfügung:`, '');
  out.push(...FIELD_HEAD, ...fieldRows(SYSTEM_FIELDS), '');
  const seen: { kind: InputKind; keys: string }[] = [];
  for (const [kind, d] of Object.entries(INPUT_KINDS) as [InputKind, (typeof INPUT_KINDS)[InputKind]][]) {
    out.push(`**${d.label}** (${code(kind)}) – ${d.description}${d.phases ? ` Vorgänge: ${d.phases.map((p) => `${code(p.value)} (${p.label})`).join(', ')}.` : ''}`, '');
    const keys = d.fields.map((f) => f.key).join(',');
    const same = seen.find((x) => x.keys === keys);
    if (same) out.push(`Felder wie bei ${INPUT_KINDS[same.kind].label} (${code(same.kind)}).`, '');
    else out.push(...FIELD_HEAD, ...fieldRows(d.fields), '');
    if (kind === 'manual') out.push('Dazu kommen die eigenen Felder des jeweiligen Eingangs (im Katalog unter `inputs` → `fields`).', '');
    seen.push({ kind, keys });
  }
  out.push('### Aktionen und Felder danach', '');
  out.push('Ein Ausgang führt die Aktion mit seinen eigenen, in BlaulichtCMS eingerichteten Texten aus; im Katalog steht je Ausgang, welche Felder er verwendet (`usesFields`). Danach stehen die gelieferten Felder bereit (z. B. für eine Benachrichtigung mit Link).', '');
  out.push('| `kind` | Aktion | Liefert danach |', '| --- | --- | --- |');
  for (const [kind, d] of Object.entries(OUTPUT_KINDS) as [OutputKind, (typeof OUTPUT_KINDS)[OutputKind]][]) {
    out.push(`| ${code(kind)} | **${esc(d.label)}** – ${esc(d.description)} | ${d.produces.length ? d.produces.map((f) => `${code(f.key)} (${esc(f.label)})`).join(', ') : '–'} |`);
  }
  out.push('');
  out.push(`**Bild aus Vorlage erzeugen** liefert ${IMAGE_FIELDS.map((f) => `${code(f.key)} (${esc(f.label)})`).join(', ')}; ein Beitrags-Ausgang danach übernimmt die Bilder. **Felder setzen** liefert die dort angelegten Felder.`, '');
  out.push('### Bedingungen', '');
  out.push(`Eine Regel ist ${code('{ "field": "stichwort", "op": "starts_with", "value": "B" }')}. ${code('combinator')} ${code('"and"')} verlangt alle Regeln, ${code('"or"')} mindestens eine; eine Untergruppe ${code('{ "combinator": "or", "rules": [ … ] }')} darf eine Ebene tief stehen. Vergleiche ignorieren Groß- und Kleinschreibung. Ausgänge der Bedingung: ${code('true')} (trifft zu) und ${code('false')} (trifft nicht zu).`, '');
  out.push('| `op` | Vergleich |', '| --- | --- |');
  for (const [op, label] of Object.entries(OPERATORS)) out.push(`| ${code(op)} | ${esc(label)}${op === 'in' ? ` – Werte mit Komma getrennt` : ''}${op === 'exists' || op === 'not_exists' ? ` – ohne ${code('value')}` : ''} |`);
  out.push('');
  out.push('### Platzhalter', '');
  out.push(`In Texten steht ein Feld als ${code('{{feldname}}')} (Kleinbuchstaben, Ziffern und ${code('_')}, beginnend mit einem Buchstaben, höchstens 40 Zeichen). Es gibt keine Formeln oder Ausdrücke. Ein Platzhalter muss an seiner Stelle vorhanden sein: Felder des Auslösers, Systemfelder und Felder, die vorherige Schritte liefern. Nach einem Zusammenführen bleiben nur Felder, die auf allen eingehenden Wegen vorhanden sind. Zeitpunkte erscheinen lesbar in der Zeitzone der Installation.`, '');
  out.push('### Grenzen', '');
  out.push('| Grenze | Wert |', '| --- | --- |');
  const limitText: [string, string][] = [
    ['Workflows je Datei', String(TRANSFER_MAX_AUTOMATIONS)],
    ['Knoten je Workflow', String(LIMITS.maxNodes)],
    ['Verbindungen je Workflow', String(LIMITS.maxEdges)],
    ['Regeln je Bedingung', String(LIMITS.maxConditionRules)],
    ['Fälle je Verzweigung', String(LIMITS.maxCases)],
    ['Warten', `1–${LIMITS.maxDelayMinutes} Minuten`],
    ['Zeitfenster „Einmal je Vorgang“', `1–${LIMITS.maxDedupMinutes} Minuten`],
    ['Frist „Freigabe anfordern“', `1–${LIMITS.maxApprovalHours} Stunden`],
    ['Länge einer Textvorlage', `${LIMITS.maxTemplateLength} Zeichen`],
    ['Dateigröße', '1 MB'],
  ];
  for (const [k, v] of limitText) out.push(`| ${k} | ${v} |`);
  out.push('');
  out.push('### Beispiel', '');
  out.push('Die Vorlage „Alarm mit Stichwort-Kategorie Brand → Beitragsentwurf“ als Datei:', '');
  out.push('```json', JSON.stringify(exampleFile('alarm-fire-post'), null, 2), '```');
  return out.join('\n');
}

/** Vorlage für die Anfrage als Markdown-Codeblock (Hilfe, zwischen `<!-- ki-anfrage:start -->` und `<!-- ki-anfrage:ende -->`). */
export function promptMarkdown(): string {
  return ['```text', AI_PROMPT, '```'].join('\n');
}

/** Generierte Blöcke der Hilfe: Markierung → Inhalt. */
export const HELP_BLOCKS: { file: string; start: string; end: string; content: () => string }[] = [
  { file: 'web/src/pages/help/content/workflows-ki.md', start: '<!-- ki-anfrage:start -->', end: '<!-- ki-anfrage:ende -->', content: promptMarkdown },
  { file: 'web/src/pages/help/content/workflows-ki.md', start: '<!-- ki-format:start -->', end: '<!-- ki-format:ende -->', content: formatReferenceMarkdown },
];

/** Inhalt der Schema-Datei (web/public/schema/…), wie er im Repository stehen muss. */
export function schemaFileText(): string {
  return `${JSON.stringify(transferJsonSchema(), null, 2)}\n`;
}
