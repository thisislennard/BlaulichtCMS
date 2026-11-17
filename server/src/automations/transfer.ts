import { z } from 'zod';
import { INPUT_KINDS, LIMITS, NODE_TYPES, OUTPUT_KINDS, type InputKind, type NodeType, type OutputKind } from './catalog.js';
import { graphSchema, NODE_DATA, type Graph, type InputRef, type OutputRef } from './graph.js';

/*
 * Export und Import von Automationen (#196) als JSON-Datei. Die Datei enthält nur den Ablauf (Knoten, Kanten,
 * Verarbeitungsschritte) und für verwendete Auslöser und Aktionen deren Art und Namen – keine Kennungen, keine
 * Konfiguration der Auslöser und Aktionen, keine Zugangsdaten. Beim Import werden die Bezüge vorhandenen Auslösern und Aktionen
 * derselben Art zugeordnet oder bleiben offen; importierte Automationen sind immer Entwürfe (nicht aktiv, nicht
 * getestet, ohne Direktversand).
 */

export const TRANSFER_FORMAT = 'blaulichtcms.automations';
export const TRANSFER_SCHEMA_VERSION = 1;
/** Höchstgröße einer Importdatei (Bytes, als JSON) und Höchstzahl Automationen je Datei. */
export const TRANSFER_MAX_BYTES = 1024 * 1024;
export const TRANSFER_MAX_AUTOMATIONS = 50;

/** Bezug auf einen Auslöser oder eine Aktion in der Datei: „in“ bzw. „out“ mit Nummer. */
export const REF_PATTERN = /^(in|out)[0-9]{1,4}$/;
const refKey = z.string().regex(REF_PATTERN, 'ungültiger Bezug – erwartet „in“ bzw. „out“ mit Nummer, z. B. „in1“ oder „out1“');
const inputKind = z.enum(Object.keys(INPUT_KINDS) as [InputKind, ...InputKind[]]);
const outputKind = z.enum(Object.keys(OUTPUT_KINDS) as [OutputKind, ...OutputKind[]]);

/** Auslöser bzw. Aktion als Bezug (Art + Name); Knoten verweisen über `ref` darauf. */
export const inputReferenceSchema = z.object({ ref: refKey, kind: inputKind, name: z.string().trim().min(1).max(120) });
export const outputReferenceSchema = z.object({ ref: refKey, kind: outputKind, name: z.string().trim().min(1).max(120) });

/** Knoten in der Datei; `data` prüft parseTransferFile je Art (Auslöser und Aktionen nur mit Bezug und Bezeichnung). */
export const fileNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'ungültige Kennung – erwartet 1–40 Zeichen aus Buchstaben, Ziffern, _ und -'),
  type: z.enum(Object.keys(NODE_TYPES) as [NodeType, ...NodeType[]]),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
  data: z.record(z.string(), z.any()).default({}),
});

export const transferFileSchema = z.object({
  format: z.literal(TRANSFER_FORMAT, { message: 'Das ist keine Exportdatei für BlaulichtCMS-Workflows.' }),
  schemaVersion: z.number().int().min(1),
  appVersion: z.string().max(40).optional(),
  exportedAt: z.string().max(40).optional(),
  references: z
    .object({
      inputs: z.array(inputReferenceSchema).max(200).default([]),
      outputs: z.array(outputReferenceSchema).max(200).default([]),
    })
    .default({ inputs: [], outputs: [] }),
  automations: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(500).default(''),
        graph: z.object({
          nodes: z.array(fileNodeSchema).max(LIMITS.maxNodes, `höchstens ${LIMITS.maxNodes} Knoten`),
          edges: graphSchema.shape.edges,
        }),
      }),
    )
    .min(1, 'Die Datei enthält keinen Workflow.')
    .max(TRANSFER_MAX_AUTOMATIONS, `höchstens ${TRANSFER_MAX_AUTOMATIONS} Workflows je Datei`),
});

export type TransferFile = z.infer<typeof transferFileSchema>;

export interface ExportSource {
  name: string;
  description: string;
  graph: Graph;
}

/** Exportdatei aus Automationen bauen: Auslöser und Aktionen werden zu Bezügen (Art + Name), Direktversand entfällt. */
export function buildExport(list: ExportSource[], refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }, appVersion: string, now = new Date(), templates: Map<string, string> = new Map()): TransferFile {
  const inputs = new Map<string, { ref: string; kind: InputKind; name: string }>();
  const outputs = new Map<string, { ref: string; kind: OutputKind; name: string }>();
  const automations = list.map((a) => ({
    name: a.name,
    description: a.description ?? '',
    graph: {
      nodes: a.graph.nodes.map((n) => {
        const label = typeof n.data?.label === 'string' ? n.data.label : undefined;
        if (n.type === 'input') {
          const inp = refs.inputs.get(n.data?.inputId);
          let ref: string | undefined;
          if (inp) {
            if (!inputs.has(inp.id)) inputs.set(inp.id, { ref: `in${inputs.size + 1}`, kind: inp.kind, name: inp.name });
            ref = inputs.get(inp.id)!.ref;
          }
          return { id: n.id, type: n.type, position: n.position, data: { ...(ref ? { inputRef: ref } : {}), ...(label ? { label } : {}) } };
        }
        if (n.type === 'output') {
          const out = refs.outputs.get(n.data?.outputId);
          let ref: string | undefined;
          if (out) {
            if (!outputs.has(out.id)) outputs.set(out.id, { ref: `out${outputs.size + 1}`, kind: out.kind, name: out.name });
            ref = outputs.get(out.id)!.ref;
          }
          return { id: n.id, type: n.type, position: n.position, data: { ...(ref ? { outputRef: ref } : {}), ...(label ? { label } : {}) } };
        }
        if (n.type === 'image') {
          // Bildvorlage nur als Bezug nach Name (#210); feste Bilder und Zielsammlung gehören zur Installation
          const { templateId, templateName, images: _images, collectionId: _collection, ...rest } = n.data ?? {};
          const name = (templateId && templates.get(templateId)) || templateName;
          return { id: n.id, type: n.type, position: n.position, data: { ...rest, ...(name ? { templateName: name } : {}) } };
        }
        return { id: n.id, type: n.type, position: n.position, data: n.data ?? {} };
      }),
      edges: a.graph.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}) })),
    },
  }));
  return {
    format: TRANSFER_FORMAT,
    schemaVersion: TRANSFER_SCHEMA_VERSION,
    appVersion,
    exportedAt: now.toISOString(),
    references: { inputs: [...inputs.values()], outputs: [...outputs.values()] },
    automations,
  };
}

export class TransferError extends Error {
  constructor(
    message: string,
    public details: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const PATH_WORDS: Record<string, string> = { name: 'Name', description: 'Beschreibung', graph: 'Ablauf', nodes: 'Knoten', edges: 'Verbindung', data: 'Einstellungen', references: 'Bezüge', inputs: 'Auslöser', outputs: 'Aktionen', automations: 'Workflow', schemaVersion: 'Formatversion', kind: 'Art', type: 'Typ' };
/** Lesbarer Ort eines Prüffehlers, z. B. „Workflow 1 › Knoten 2 › Einstellungen“. */
function pathLabel(p: PropertyKey[]): string {
  const out: string[] = [];
  for (const k of p) {
    if (typeof k === 'number' && out.length) out[out.length - 1] += ` ${k + 1}`;
    else if (typeof k === 'string') out.push(PATH_WORDS[k] ?? k);
  }
  return out.filter((x) => x !== 'Ablauf').join(' › ');
}

/** Ort in der Datei als JSON-Pfad, z. B. `automations[0].graph.nodes[2].data.rules[0].op` (für KI-erzeugte Dateien). */
export function jsonPath(p: readonly PropertyKey[]): string {
  let out = '';
  for (const k of p) {
    if (typeof k === 'number') out += `[${k}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(k))) out += `${out ? '.' : ''}${String(k)}`;
    else out += `[${JSON.stringify(String(k))}]`;
  }
  return out;
}

const TYPE_WORDS: Record<string, string> = { string: 'Text', number: 'Zahl', int: 'ganze Zahl', array: 'Liste', object: 'Objekt', boolean: 'true oder false', record: 'Objekt' };

/** Gefundener Wert, gekürzt (für „gefunden …“). */
function shown(v: unknown): string {
  if (typeof v === 'string') return `„${v.length > 60 ? `${v.slice(0, 60)}…` : v}“`;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return Array.isArray(v) ? 'eine Liste' : 'ein Objekt';
}

type Issue = z.core.$ZodIssue;

/**
 * Prüffehler flach und verständlich: Bei Alternativen (Regel oder Untergruppe einer Bedingung) zählt die am besten
 * passende (wenigste fehlende Angaben); fehlende Angaben heißen „fehlt“, falsche Werte nennen Erwartung und Fund.
 */
function flatIssues(issues: readonly Issue[], base: PropertyKey[] = []): { path: PropertyKey[]; message: string }[] {
  const out: { path: PropertyKey[]; message: string }[] = [];
  const score = (l: readonly Issue[]) => l.filter((x) => (x as { input?: unknown }).input === undefined).length * 100 + l.length;
  for (const i of issues) {
    const path = [...base, ...i.path];
    const input = (i as { input?: unknown }).input;
    if (i.code === 'invalid_union' && i.errors.length) {
      const best = [...i.errors].sort((a, b) => score(a) - score(b))[0];
      if (best.length) {
        out.push(...flatIssues(best, path));
        continue;
      }
    }
    if (i.code === 'invalid_key' && i.issues.length) out.push({ path, message: `Schlüssel ${shown(input)}: ${i.issues[0].message}` });
    else if (i.code === 'invalid_type' && input === undefined) out.push({ path, message: `fehlt (erwartet ${TYPE_WORDS[i.expected] ?? i.expected})` });
    else if ((i.code === 'invalid_value' || i.code === 'invalid_format') && input !== undefined) out.push({ path, message: `${i.message} – gefunden ${shown(input)}` });
    else out.push({ path, message: i.message });
  }
  return out;
}

const MAX_PROBLEMS = 30;
const names = (xs: string[], max = 10) => (xs.length ? xs.slice(0, max).join(', ') + (xs.length > max ? ', …' : '') : 'keine');

/**
 * Datei prüfen (Format, Version, Aufbau, Daten je Knoten, Bezüge). Wirft TransferError mit verständlichen Meldungen:
 * jede nennt den Ort als JSON-Pfad (`path`) und, wo möglich, Erwartung und Fund – so lassen sich auch Dateien aus
 * einer KI gezielt korrigieren.
 */
export function parseTransferFile(raw: unknown): TransferFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TransferError('Die Datei enthält kein gültiges JSON-Objekt.', [{ path: '', message: `Erwartet ein Objekt { "format": "${TRANSFER_FORMAT}", "schemaVersion": ${TRANSFER_SCHEMA_VERSION}, "automations": [ … ] } – gefunden ${raw == null ? 'nichts' : shown(raw)}.` }]);
  }
  const r = raw as Record<string, unknown>;
  if (r.format !== TRANSFER_FORMAT) {
    throw new TransferError('Das ist keine Exportdatei für BlaulichtCMS-Workflows.', [{ path: 'format', message: `Erwartet "format": "${TRANSFER_FORMAT}" – ${r.format === undefined ? 'fehlt' : `gefunden ${shown(r.format)}`}.` }]);
  }
  if (typeof r.schemaVersion === 'number' && r.schemaVersion > TRANSFER_SCHEMA_VERSION) {
    throw new TransferError(`Die Datei stammt aus einer neueren BlaulichtCMS-Version (Format ${r.schemaVersion}${typeof r.appVersion === 'string' ? `, Version ${r.appVersion.slice(0, 40)}` : ''}). Bitte BlaulichtCMS zuerst aktualisieren.`, [{ path: 'schemaVersion', message: `Diese Installation liest "schemaVersion": ${TRANSFER_SCHEMA_VERSION}.` }]);
  }
  const parsed = transferFileSchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) {
    const details = flatIssues(parsed.error.issues)
      .slice(0, MAX_PROBLEMS)
      .map((i) => ({ path: jsonPath(i.path), message: i.path.length ? `${pathLabel(i.path)}: ${i.message}` : i.message }));
    throw new TransferError('Die Datei ist unvollständig oder beschädigt.', details);
  }
  const file = parsed.data;
  const problems: { path: string; message: string }[] = [];
  for (const what of ['inputs', 'outputs'] as const) {
    const refs = file.references[what].map((x) => x.ref);
    refs.forEach((ref, i) => {
      if (refs.indexOf(ref) !== i) problems.push({ path: `references.${what}[${i}].ref`, message: `Doppelter Bezug „${ref}“ – jeder Bezug darf nur einmal vorkommen.` });
    });
  }
  if (problems.length) throw new TransferError('Die Datei enthält doppelte Bezüge.', problems.slice(0, MAX_PROBLEMS));
  const inRefs = file.references.inputs.map((x) => x.ref);
  const outRefs = file.references.outputs.map((x) => x.ref);
  file.automations.forEach((a, ai) => {
    const ids = new Set<string>();
    a.graph.nodes.forEach((n, ni) => {
      const at: PropertyKey[] = ['automations', ai, 'graph', 'nodes', ni];
      const who = `„${a.name}“, Knoten „${n.id}“`;
      if (ids.has(n.id)) problems.push({ path: jsonPath([...at, 'id']), message: `„${a.name}“: doppelte Knoten-Kennung „${n.id}“ – jede Kennung nur einmal je Workflow.` });
      ids.add(n.id);
      if (n.type === 'input' || n.type === 'output') {
        const key = n.type === 'input' ? 'inputRef' : 'outputRef';
        const known = n.type === 'input' ? inRefs : outRefs;
        const ref = n.data[key];
        if (ref !== undefined && (typeof ref !== 'string' || !known.includes(ref))) {
          problems.push({ path: jsonPath([...at, 'data', key]), message: `${who}: ${n.type === 'input' ? 'Auslöser' : 'Aktion'} verweist auf einen unbekannten Bezug ${shown(ref)} – erwartet ein „ref“ aus references.${n.type === 'input' ? 'inputs' : 'outputs'} (${names(known)}).` });
        }
        const extra = Object.keys(n.data).filter((k) => k !== key && k !== 'label');
        if (extra.length) problems.push({ path: jsonPath([...at, 'data']), message: `${who}: ${n.type === 'input' ? 'Auslöser' : 'Aktions'}-Knoten mit unerwarteten Angaben (${names(extra)}) – erlaubt sind nur „${key}“ und „label“.` });
      } else {
        const d = NODE_DATA[n.type].safeParse(n.data, { reportInput: true });
        if (!d.success) {
          for (const i of flatIssues(d.error.issues).slice(0, 5)) {
            problems.push({ path: jsonPath([...at, 'data', ...i.path]), message: `${who}: Schritt „${NODE_TYPES[n.type].label}“ hat ungültige Einstellungen – ${jsonPath(i.path) || 'data'}: ${i.message}` });
          }
        }
      }
      if (n.data.label !== undefined && (typeof n.data.label !== 'string' || n.data.label.length > 80)) problems.push({ path: jsonPath([...at, 'data', 'label']), message: `${who}: Bezeichnung zu lang (höchstens 80 Zeichen).` });
    });
    a.graph.edges.forEach((e, ei) => {
      for (const end of ['source', 'target'] as const) {
        if (!ids.has(e[end])) problems.push({ path: jsonPath(['automations', ai, 'graph', 'edges', ei, end]), message: `„${a.name}“: Verbindung „${e.id}“ führt ${end === 'source' ? 'von' : 'zu'} einem unbekannten Knoten „${e[end]}“ – vorhanden: ${names([...ids])}.` });
      }
    });
  });
  if (problems.length) throw new TransferError('Die Datei enthält ungültige Abläufe.', problems.slice(0, MAX_PROBLEMS));
  return file;
}


export interface TransferMapping {
  inputs: Record<string, string | null>;
  outputs: Record<string, string | null>;
}

/**
 * Ablauf einer importierten Automation mit Zuordnung: Bezüge werden zu Kennungen vorhandener Auslöser und Aktionen (gleiche Art,
 * nicht gelöscht) oder bleiben offen. Unbekannte Zuordnungen bleiben ebenfalls offen. Daten der übrigen Knoten wurden
 * in parseTransferFile geprüft; hier wird nur über das Schema normalisiert.
 */
export function mappedGraph(a: TransferFile['automations'][number], file: TransferFile, mapping: TransferMapping, refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }, imageTemplates: Map<string, string> = new Map()): { graph: Graph; open: number } {
  const inKind = new Map(file.references.inputs.map((x) => [x.ref, x.kind]));
  const outKind = new Map(file.references.outputs.map((x) => [x.ref, x.kind]));
  let open = 0;
  const nodes = a.graph.nodes.map((n) => {
    const label = typeof n.data.label === 'string' && n.data.label ? { label: n.data.label } : {};
    if (n.type === 'input') {
      const id = n.data.inputRef ? mapping.inputs[n.data.inputRef] : null;
      const target = id ? refs.inputs.get(id) : undefined;
      const ok = target && !target.archived && target.kind === inKind.get(n.data.inputRef);
      if (!ok) open++;
      return { ...n, data: { ...(ok ? { inputId: target!.id } : {}), ...label } };
    }
    if (n.type === 'output') {
      const id = n.data.outputRef ? mapping.outputs[n.data.outputRef] : null;
      const target = id ? refs.outputs.get(id) : undefined;
      const ok = target && !target.archived && target.kind === outKind.get(n.data.outputRef);
      if (!ok) open++;
      return { ...n, data: { ...(ok ? { outputId: target!.id } : {}), ...label } };
    }
    if (n.type === 'image') {
      // Bildvorlage nach Name zuordnen (ohne Groß-/Kleinschreibung); sonst offener Platz mit Hinweis auf den Namen
      const { templateId: _ignored, ...d } = NODE_DATA.image.parse(n.data);
      const id = d.templateName ? imageTemplates.get(d.templateName.trim().toLocaleLowerCase('de')) : undefined;
      if (!id) open++;
      return { ...n, data: id ? { ...d, templateId: id, templateName: undefined } : d };
    }
    return { ...n, data: NODE_DATA[n.type].parse(n.data) };
  });
  return { graph: graphSchema.parse({ nodes, edges: a.graph.edges }), open };
}

/** Vorschlag je Bezug: vorhandene Auslöser und Aktionen derselben Art, gleicher Name (ohne Groß-/Kleinschreibung) zuerst. */
export function suggestions<T extends { id: string; name: string; kind: string; archived?: boolean }>(ref: { kind: string; name: string }, pool: Iterable<T>) {
  const candidates = [...pool].filter((x) => !x.archived && x.kind === ref.kind).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const same = candidates.find((x) => x.name.trim().toLocaleLowerCase('de') === ref.name.trim().toLocaleLowerCase('de'));
  return { candidates: candidates.map((x) => ({ id: x.id, name: x.name })), suggested: same?.id ?? null };
}
