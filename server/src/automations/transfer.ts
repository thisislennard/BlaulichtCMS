import { z } from 'zod';
import { INPUT_KINDS, LIMITS, NODE_TYPES, OUTPUT_KINDS, type InputKind, type NodeType, type OutputKind } from './catalog.js';
import { graphSchema, NODE_DATA, type Graph, type InputRef, type OutputRef } from './graph.js';

/*
 * Export und Import von Automationen (#196) als JSON-Datei. Die Datei enthält nur den Ablauf (Knoten, Kanten,
 * Verarbeitungsschritte) und für verwendete Ein- und Ausgänge deren Art und Namen – keine Kennungen, keine
 * Konfiguration der Ein-/Ausgänge, keine Zugangsdaten. Beim Import werden die Bezüge vorhandenen Ein- und Ausgängen
 * derselben Art zugeordnet oder bleiben offen; importierte Automationen sind immer Entwürfe (nicht aktiv, nicht
 * getestet, ohne Direktversand).
 */

export const TRANSFER_FORMAT = 'blaulichtcms.automations';
export const TRANSFER_SCHEMA_VERSION = 1;
/** Höchstgröße einer Importdatei (Bytes, als JSON) und Höchstzahl Automationen je Datei. */
export const TRANSFER_MAX_BYTES = 1024 * 1024;
export const TRANSFER_MAX_AUTOMATIONS = 50;

const refKey = z.string().regex(/^(in|out)[0-9]{1,4}$/, 'ungültiger Bezug');
const inputKind = z.enum(Object.keys(INPUT_KINDS) as [InputKind, ...InputKind[]]);
const outputKind = z.enum(Object.keys(OUTPUT_KINDS) as [OutputKind, ...OutputKind[]]);

const fileNode = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'ungültige Kennung'),
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
      inputs: z.array(z.object({ ref: refKey, kind: inputKind, name: z.string().trim().min(1).max(120) })).max(200).default([]),
      outputs: z.array(z.object({ ref: refKey, kind: outputKind, name: z.string().trim().min(1).max(120) })).max(200).default([]),
    })
    .default({ inputs: [], outputs: [] }),
  automations: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(500).default(''),
        graph: z.object({
          nodes: z.array(fileNode).max(LIMITS.maxNodes, `höchstens ${LIMITS.maxNodes} Knoten`),
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

/** Exportdatei aus Automationen bauen: Ein-/Ausgänge werden zu Bezügen (Art + Name), Direktversand entfällt. */
export function buildExport(list: ExportSource[], refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }, appVersion: string, now = new Date()): TransferFile {
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

const PATH_WORDS: Record<string, string> = { name: 'Name', description: 'Beschreibung', graph: 'Ablauf', nodes: 'Knoten', edges: 'Verbindung', data: 'Einstellungen', references: 'Bezüge', inputs: 'Eingang', outputs: 'Ausgang', automations: 'Workflow', schemaVersion: 'Formatversion', kind: 'Art', type: 'Typ' };
/** Lesbarer Ort eines Prüffehlers, z. B. „Automation 1 › Knoten 2 › Einstellungen“. */
function pathLabel(p: PropertyKey[]): string {
  const out: string[] = [];
  for (const k of p) {
    if (typeof k === 'number' && out.length) out[out.length - 1] += ` ${k + 1}`;
    else if (typeof k === 'string') out.push(PATH_WORDS[k] ?? k);
  }
  return out.filter((x) => x !== 'Ablauf').join(' › ');
}

/** Datei prüfen (Format, Version, Aufbau, Daten je Knoten, Bezüge). Wirft TransferError mit verständlichen Meldungen. */
export function parseTransferFile(raw: unknown): TransferFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TransferError('Die Datei enthält kein gültiges JSON-Objekt.');
  const r = raw as Record<string, unknown>;
  if (r.format !== TRANSFER_FORMAT) throw new TransferError('Das ist keine Exportdatei für BlaulichtCMS-Workflows.');
  if (typeof r.schemaVersion === 'number' && r.schemaVersion > TRANSFER_SCHEMA_VERSION) {
    throw new TransferError(`Die Datei stammt aus einer neueren BlaulichtCMS-Version (Format ${r.schemaVersion}${typeof r.appVersion === 'string' ? `, Version ${r.appVersion.slice(0, 40)}` : ''}). Bitte BlaulichtCMS zuerst aktualisieren.`);
  }
  const parsed = transferFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.path.length ? `${pathLabel(i.path)}: ${i.message}` : i.message }));
    throw new TransferError('Die Datei ist unvollständig oder beschädigt.', details);
  }
  const file = parsed.data;
  const inRefs = new Set(file.references.inputs.map((x) => x.ref));
  const outRefs = new Set(file.references.outputs.map((x) => x.ref));
  if (inRefs.size !== file.references.inputs.length || outRefs.size !== file.references.outputs.length) throw new TransferError('Die Datei enthält doppelte Bezüge.');
  const problems: { path: string; message: string }[] = [];
  file.automations.forEach((a, ai) => {
    const ids = new Set<string>();
    a.graph.nodes.forEach((n, ni) => {
      const at = `automations.${ai}.graph.nodes.${ni}`;
      if (ids.has(n.id)) problems.push({ path: at, message: `„${a.name}“: doppelte Knoten-Kennung „${n.id}“.` });
      ids.add(n.id);
      if (n.type === 'input') {
        const ref = n.data.inputRef;
        if (ref !== undefined && (typeof ref !== 'string' || !inRefs.has(ref))) problems.push({ path: at, message: `„${a.name}“: Eingang verweist auf einen unbekannten Bezug.` });
        if (Object.keys(n.data).some((k) => k !== 'inputRef' && k !== 'label')) problems.push({ path: at, message: `„${a.name}“: Eingangs-Knoten mit unerwarteten Angaben.` });
      } else if (n.type === 'output') {
        const ref = n.data.outputRef;
        if (ref !== undefined && (typeof ref !== 'string' || !outRefs.has(ref))) problems.push({ path: at, message: `„${a.name}“: Ausgang verweist auf einen unbekannten Bezug.` });
        if (Object.keys(n.data).some((k) => k !== 'outputRef' && k !== 'label')) problems.push({ path: at, message: `„${a.name}“: Ausgangs-Knoten mit unerwarteten Angaben.` });
      } else {
        const d = NODE_DATA[n.type].safeParse(n.data);
        if (!d.success) problems.push({ path: at, message: `„${a.name}“: Schritt „${NODE_TYPES[n.type].label}“ hat ungültige Einstellungen (${d.error.issues[0]?.path.join('.') || 'Angaben'}: ${d.error.issues[0]?.message}).` });
      }
      if (n.data.label !== undefined && (typeof n.data.label !== 'string' || n.data.label.length > 80)) problems.push({ path: at, message: `„${a.name}“: Bezeichnung eines Knotens zu lang.` });
    });
    a.graph.edges.forEach((e, ei) => {
      if (!ids.has(e.source) || !ids.has(e.target)) problems.push({ path: `automations.${ai}.graph.edges.${ei}`, message: `„${a.name}“: Verbindung zu einem unbekannten Knoten.` });
    });
  });
  if (problems.length) throw new TransferError('Die Datei enthält ungültige Abläufe.', problems.slice(0, 20));
  return file;
}

export interface TransferMapping {
  inputs: Record<string, string | null>;
  outputs: Record<string, string | null>;
}

/**
 * Ablauf einer importierten Automation mit Zuordnung: Bezüge werden zu Kennungen vorhandener Ein-/Ausgänge (gleiche Art,
 * nicht gelöscht) oder bleiben offen. Unbekannte Zuordnungen bleiben ebenfalls offen. Daten der übrigen Knoten wurden
 * in parseTransferFile geprüft; hier wird nur über das Schema normalisiert.
 */
export function mappedGraph(a: TransferFile['automations'][number], file: TransferFile, mapping: TransferMapping, refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }): { graph: Graph; open: number } {
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
    return { ...n, data: NODE_DATA[n.type].parse(n.data) };
  });
  return { graph: graphSchema.parse({ nodes, edges: a.graph.edges }), open };
}

/** Vorschlag je Bezug: vorhandene Ein-/Ausgänge derselben Art, gleicher Name (ohne Groß-/Kleinschreibung) zuerst. */
export function suggestions<T extends { id: string; name: string; kind: string; archived?: boolean }>(ref: { kind: string; name: string }, pool: Iterable<T>) {
  const candidates = [...pool].filter((x) => !x.archived && x.kind === ref.kind).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const same = candidates.find((x) => x.name.trim().toLocaleLowerCase('de') === ref.name.trim().toLocaleLowerCase('de'));
  return { candidates: candidates.map((x) => ({ id: x.id, name: x.name })), suggested: same?.id ?? null };
}
