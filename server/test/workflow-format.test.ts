import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildAiCatalog } from '../src/automations/aicatalog.js';
import { NODE_TYPES } from '../src/automations/catalog.js';
import { AI_PROMPT, CATALOG_FILE, exampleFile, HELP_BLOCKS, SCHEMA_FILE, schemaFileText, transferJsonSchema } from '../src/automations/format.js';
import { graphSchema, validateGraph, type InputRef, type OutputRef } from '../src/automations/graph.js';
import { TEMPLATES } from '../src/automations/templates.js';
import { buildExport, mappedGraph, parseTransferFile, TransferError } from '../src/automations/transfer.js';

/* Workflows mit KI erstellen (#199): JSON-Schema und Hilfe aus der echten Prüfung, Fehlermeldungen mit Ort und
   Erwartung, Katalog nur aus der Positivliste – ohne Datenbank. */

z.config(z.locales.de());
const ROOT = path.join(__dirname, '../..');
const ajv = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true } });
const validate = ajv.compile(transferJsonSchema());
const schemaOk = (f: unknown) => validate(f) || (console.log(JSON.stringify(validate.errors?.slice(0, 3))), false);
const importError = (f: unknown) => {
  try {
    parseTransferFile(JSON.parse(JSON.stringify(f)));
    return null;
  } catch (e) {
    if (e instanceof TransferError) return e;
    throw e;
  }
};

/** Datei, wie eine KI sie nach Schema und Katalog schreiben würde: ohne Positionen, alle Bausteine. */
const aiFile = () => ({
  format: 'blaulichtcms.automations',
  schemaVersion: 1,
  references: {
    inputs: [{ ref: 'in1', kind: 'fe2', name: 'FE2 Leitstelle' }],
    outputs: [
      { ref: 'out1', kind: 'post', name: 'Entwurf' },
      { ref: 'out2', kind: 'notify', name: 'Redaktion informieren' },
    ],
  },
  automations: [
    {
      name: 'Brand: Beitrag mit Bild, Redaktion informieren',
      description: 'Bei Bränden einmal je Ort einen Beitragsentwurf mit Bild anlegen.',
      graph: {
        nodes: [
          { id: 'alarm', type: 'input', data: { inputRef: 'in1', label: 'Alarm' } },
          { id: 'nur_brand', type: 'condition', data: { combinator: 'and', rules: [{ field: 'vorgang', op: 'eq', value: 'neu' }, { combinator: 'or', rules: [{ field: 'stichwort_kategorie', op: 'eq', value: 'Brand' }, { field: 'stichwort', op: 'starts_with', value: 'B' }] }] } },
          { id: 'einmal', type: 'dedup', data: { fields: ['ort', 'stichwort'], windowMinutes: 60 } },
          { id: 'texte', type: 'template', data: { fields: [{ key: 'titel', template: '{{stichwort_text}} in {{ort}}' }] } },
          { id: 'weg', type: 'switch', data: { field: 'ortsteil', cases: [{ id: 'nord', value: 'Nord' }] } },
          { id: 'kurz', type: 'delay', data: { minutes: 5 } },
          { id: 'zusammen', type: 'merge', data: {} },
          { id: 'bild', type: 'image', data: { templateName: 'Story 9:16', texts: { titel: '{{titel}}' }, altText: '{{titel}}' } },
          { id: 'ok', type: 'approval', data: { title: 'Beitrag zu {{titel}}?', timeoutHours: 2 } },
          { id: 'beitrag', type: 'output', data: { outputRef: 'out1' } },
          { id: 'info', type: 'output', data: { outputRef: 'out2' } },
        ],
        edges: [
          { id: 'e1', source: 'alarm', target: 'nur_brand' },
          { id: 'e2', source: 'nur_brand', sourceHandle: 'true', target: 'einmal' },
          { id: 'e3', source: 'einmal', target: 'texte' },
          { id: 'e4', source: 'texte', target: 'weg' },
          { id: 'e5', source: 'weg', sourceHandle: 'case:nord', target: 'kurz' },
          { id: 'e6', source: 'weg', sourceHandle: 'default', target: 'zusammen' },
          { id: 'e7', source: 'kurz', target: 'zusammen' },
          { id: 'e8', source: 'zusammen', target: 'bild' },
          { id: 'e9', source: 'bild', target: 'ok' },
          { id: 'e10', source: 'ok', sourceHandle: 'approved', target: 'beitrag' },
          { id: 'e11', source: 'beitrag', sourceHandle: 'out', target: 'info' },
        ],
      },
    },
  ],
});

const IN = '11111111-1111-4111-8111-111111111111';
const OUT = '22222222-2222-4222-8222-222222222222';
const OUT2 = '33333333-3333-4333-8333-333333333333';
const TPL = '44444444-4444-4444-8444-444444444444';
const refs = {
  inputs: new Map<string, InputRef>([[IN, { id: IN, name: 'FE2 Leitstelle', kind: 'fe2', config: { connectionId: '55555555-5555-4555-8555-555555555555', phases: ['neu'] } }]]),
  outputs: new Map<string, OutputRef>([
    [OUT, { id: OUT, name: 'Entwurf', kind: 'post', config: { kind: 'incident', title: '{{titel}}', body: 'Alarm um {{alarmzeit}}', submit: false } }],
    [OUT2, { id: OUT2, name: 'Redaktion informieren', kind: 'notify', config: { roles: ['editor'], title: 'Neuer Entwurf', body: '{{beitrag_titel}}', link: '{{beitrag_link}}' } }],
  ]),
};

describe('Workflows mit KI: Formatbeschreibung (#199)', () => {
  it('Schema-Datei und generierte Hilfe sind aktuell (sonst `npx tsx scripts/workflow-format.mjs`)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'web/public/schema', SCHEMA_FILE), 'utf8')).toBe(schemaFileText());
    for (const b of HELP_BLOCKS) {
      const doc = fs.readFileSync(path.join(ROOT, b.file), 'utf8');
      const a = doc.indexOf(b.start);
      const e = doc.indexOf(b.end);
      expect(a, `Markierung ${b.start} fehlt`).toBeGreaterThan(-1);
      expect(doc.slice(a + b.start.length, e).trim(), b.start).toBe(b.content().trim());
    }
  });

  it('ist ein gültiges JSON-Schema (Draft 2020-12, strenger Modus) mit Beispielen, die es selbst erfüllen', () => {
    const s = transferJsonSchema();
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(s.$defs)).toEqual(expect.arrayContaining(Object.keys(NODE_TYPES).map((t) => `data_${t}`)));
    expect(s.examples.length).toBeGreaterThan(0);
    for (const ex of s.examples) {
      expect(schemaOk(ex)).toBe(true);
      expect(importError(ex)).toBeNull();
    }
    // Stabil: keine Versionsnummer oder Uhrzeit im Schema (sonst ändert sich die Datei mit jedem Release)
    expect(JSON.stringify(s)).not.toMatch(/"appVersion":"|"exportedAt":"/);
  });

  it('alle Vorlagen der Galerie – als Datei exportiert, mit und ohne passende Ein-/Ausgänge – erfüllen Schema und Import', () => {
    expect(TEMPLATES.length).toBeGreaterThan(3);
    for (const t of TEMPLATES) {
      for (const open of [false, true]) {
        const file = exampleFile(t.id, { open });
        expect(schemaOk(file), `${t.id} open=${open}`).toBe(true);
        expect(importError(file), `${t.id} open=${open}`).toBeNull();
      }
    }
  });

  it('jede Workflow-Vorlage nennt alle Voraussetzungen, die ihr Ablauf braucht (#263)', () => {
    // Abgeleitet aus dem Ablauf: Auslöser mit Verbindung, Banner (Website), Bild aus Vorlage, Filter auf Kategorien
    const derived = (t: (typeof TEMPLATES)[number]) => {
      const out: string[] = [];
      const conn = (t.input?.kinds ?? []).filter((k) => ['fe2', 'feuersoftware', 'warnfeed'].includes(k));
      if (conn.length) out.push(`connection:${conn.join('+')}`);
      if (t.outputs.some((o) => o.kind === 'banner' || o.kind === 'incident_entry')) out.push('website');
      if (t.image) out.push('image_template');
      for (const r of t.rules ?? []) {
        if (r.field === 'stichwort_kategorie') out.push(`keyword_category:${r.value}`);
        if (r.field === 'kategorie' && t.input?.kinds.includes('calendar')) out.push(`calendar_category:${r.value}`);
      }
      return out.sort();
    };
    const declared = (t: (typeof TEMPLATES)[number]) =>
      t.requires.map((r) => (r.kind === 'connection' ? `connection:${r.connectionKinds.join('+')}` : r.kind === 'calendar_category' || r.kind === 'keyword_category' ? `${r.kind}:${r.name}` : r.kind)).sort();
    for (const t of TEMPLATES) expect(declared(t), t.id).toEqual(derived(t));
    // Stichprobe aus dem Issue: Alarm → Banner braucht FE2/Feuersoftware und eine Website
    expect(declared(TEMPLATES.find((t) => t.id === 'alarm-banner')!)).toEqual(['connection:fe2+feuersoftware', 'website']);
  });

  it('ein Export mit allen Knotenarten (wie ihn BlaulichtCMS schreibt) erfüllt das Schema', () => {
    const parsed = parseTransferFile(aiFile());
    const { graph } = mappedGraph(parsed.automations[0], parsed, { inputs: { in1: IN }, outputs: { out1: OUT, out2: OUT2 } }, refs, new Map([['story 9:16', TPL]]));
    const g = graphSchema.parse({ ...graph, nodes: graph.nodes.map((n) => (n.type === 'output' && n.id === 'beitrag' ? { ...n, data: { ...n.data, direct: true } } : n)) });
    const file = buildExport([{ name: 'Alles', description: '', graph: g }], refs, '9.9.9', new Date(), new Map([[TPL, 'Story 9:16']]));
    expect(new Set(file.automations[0].graph.nodes.map((n) => n.type))).toEqual(new Set(Object.keys(NODE_TYPES)));
    expect(schemaOk(file)).toBe(true);
    expect(JSON.stringify(file)).not.toContain('"direct"');
  });

  it('eine KI-Datei nach Schema (ohne Positionen) lässt sich importieren und ist nach der Zuordnung ohne Fehler', () => {
    const f = aiFile();
    expect(schemaOk(f)).toBe(true);
    const parsed = parseTransferFile(f);
    const { graph, open } = mappedGraph(parsed.automations[0], parsed, { inputs: { in1: IN }, outputs: { out1: OUT, out2: OUT2 } }, refs, new Map([['story 9:16', TPL]]));
    expect(open).toBe(0);
    const v = validateGraph(graph, refs);
    expect(v.errors).toEqual([]);
  });

  it('lehnt die beschädigten Dateien der Import-Tests ab – Schema und Import gleich; Querbezüge prüft nur der Import', () => {
    const tamper = (fn: (c: any) => void) => {
      const c = structuredClone(aiFile()) as any;
      fn(c);
      return c;
    };
    const both: [string, unknown][] = [
      ['fremde Datei', { hallo: 'welt' }],
      ['Liste statt Objekt', [1, 2, 3]],
      ['neuere Formatversion', { ...aiFile(), schemaVersion: 99, appVersion: '9.0.0' }],
      ['kein Workflow', { ...aiFile(), automations: [] }],
      ['zu viele Workflows', tamper((c) => (c.automations = Array.from({ length: 51 }, () => c.automations[0])))],
      ['Eingang mit Kennung statt Bezug', tamper((c) => (c.automations[0].graph.nodes[0].data = { inputId: IN }))],
      ['Ausgang mit Direktversand', tamper((c) => (c.automations[0].graph.nodes[9].data.direct = true))],
      ['Bedingung mit falscher Verknüpfung', tamper((c) => (c.automations[0].graph.nodes[1].data = { combinator: 'xor', rules: [] }))],
      ['unbekannter Vergleich', tamper((c) => (c.automations[0].graph.nodes[1].data.rules[0].op = 'equals'))],
      ['Feldname mit Großbuchstaben', tamper((c) => (c.automations[0].graph.nodes[1].data.rules[0].field = 'Stichwort'))],
      ['unbekannte Knotenart', tamper((c) => (c.automations[0].graph.nodes[2].type = 'loop'))],
      ['Warten ohne Zahl', tamper((c) => (c.automations[0].graph.nodes[5].data = { minutes: 'fünf' }))],
      ['Warten zu lang', tamper((c) => (c.automations[0].graph.nodes[5].data = { minutes: 99999 }))],
      ['Bedingung ohne Einstellungen', tamper((c) => delete c.automations[0].graph.nodes[1].data)],
      ['ungültige Knoten-Kennung', tamper((c) => (c.automations[0].graph.nodes[0].id = 'mit Leerzeichen'))],
      ['ungültiger Bezug', tamper((c) => (c.references.inputs[0].ref = 'eingang1'))],
      ['unbekannte Art', tamper((c) => (c.references.outputs[0].kind = 'tweet'))],
      ['Name zu kurz', tamper((c) => (c.automations[0].name = 'x'))],
    ];
    for (const [name, f] of both) {
      expect(schemaOk(f) ? `${name}: Schema nimmt an` : null).toBeNull();
      expect(importError(f), name).not.toBeNull();
    }
    // Querbezüge kann ein JSON-Schema nicht ausdrücken – das Schema beschreibt sie, der Import lehnt ab
    const crossRef: [string, unknown][] = [
      ['unbekannter Bezug', tamper((c) => (c.automations[0].graph.nodes[0].data.inputRef = 'in7'))],
      ['Verbindung ins Leere', tamper((c) => (c.automations[0].graph.edges[0].target = 'gibtsnicht'))],
      ['doppelte Knoten-Kennung', tamper((c) => (c.automations[0].graph.nodes[2].id = 'alarm'))],
      ['doppelter Bezug', tamper((c) => (c.references.outputs[1].ref = 'out1'))],
    ];
    for (const [name, f] of crossRef) {
      expect(schemaOk(f), name).toBe(true);
      expect(importError(f), name).not.toBeNull();
    }
    expect(transferJsonSchema().description).toMatch(/inputRef\/outputRef verweisen auf einen Eintrag in references/);
  });

  it('Importfehler nennen den Ort als JSON-Pfad und Erwartung samt Fund (für Korrekturen durch die KI)', () => {
    const f = aiFile() as any;
    f.automations[0].graph.nodes[1].data.rules[0].op = 'equals';
    f.automations[0].graph.nodes[1].data.rules[1].rules[0].field = 'Stichwort-Kategorie';
    f.automations[0].graph.nodes[9].data.outputRef = 'out9';
    f.automations[0].graph.nodes[5].data = {};
    f.automations[0].graph.edges[0].target = 'nirgends';
    const e = importError(f)!;
    const byPath = Object.fromEntries(e.details.map((d) => [d.path, d.message]));
    expect(byPath['automations[0].graph.nodes[1].data.rules[0].op']).toMatch(/"eq".*gefunden „equals“/);
    expect(byPath['automations[0].graph.nodes[1].data.rules[1].rules[0].field']).toMatch(/Kleinbuchstaben.*gefunden „Stichwort-Kategorie“/);
    expect(byPath['automations[0].graph.nodes[9].data.outputRef']).toMatch(/unbekannten Bezug „out9“.*out1, out2/);
    expect(byPath['automations[0].graph.nodes[5].data.minutes']).toMatch(/Warten.*minutes: fehlt \(erwartet Zahl\)/);
    expect(byPath['automations[0].graph.edges[0].target']).toMatch(/unbekannten Knoten „nirgends“ – vorhanden: alarm, nur_brand/);
    // Aufbaufehler ebenfalls mit Pfad
    const bad = importError({ ...aiFile(), references: { inputs: [{ ref: 'in1', kind: 'alarm' }] } })!;
    expect(bad.details.map((d) => d.path)).toEqual(expect.arrayContaining(['references.inputs[0].kind', 'references.inputs[0].name']));
    expect(bad.details.find((d) => d.path === 'references.inputs[0].kind')!.message).toMatch(/"fe2".*gefunden „alarm“/);
    expect(importError({ format: 'json' })!.details[0]).toEqual({ path: 'format', message: expect.stringMatching(/blaulichtcms\.automations.*gefunden „json“/) });
  });

  it('Vorlage für die Anfrage ist anbieterneutral und nennt beide Dateien', () => {
    expect(AI_PROMPT).toContain(SCHEMA_FILE);
    expect(AI_PROMPT).toContain(CATALOG_FILE);
    expect(AI_PROMPT).toMatch(/Der Workflow soll: …$/);
    expect(AI_PROMPT).not.toMatch(/claude|chatgpt|openai|gemini|copilot|anthropic|mistral/i);
  });
});

describe('Workflows mit KI: Katalog exportieren (#199)', () => {
  const secret = 'geheimes-passwort-123';
  const catalog = buildAiCatalog({
    appVersion: '0.4.1',
    now: new Date('2026-11-16T08:00:00Z'),
    inputs: [
      ...refs.inputs.values(),
      { id: '66666666-6666-4666-8666-666666666666', name: 'Termin von Hand', kind: 'manual', config: { fields: [{ key: 'titel', label: 'Titel', example: 'Max Mustermann, 0171 1234567' }, { key: 'Böse Taste', label: 'x' }] } },
      { id: '77777777-7777-4777-8777-777777777777', name: 'Gelöschter Eingang', kind: 'rss', config: { feedId: null }, archived: true },
    ],
    outputs: [
      ...refs.outputs.values(),
      { id: '88888888-8888-4888-8888-888888888888', name: 'Mail an Leitung', kind: 'mail', config: { roles: [], responsibilityIds: ['99999999-9999-4999-8999-999999999999'], subject: 'Alarm {{stichwort}}', body: `Kontakt: leitung@example.org, Token ${secret}` } },
    ],
    imageTemplates: [{ title: 'Story 9:16', layout: { elements: [{ type: 'text', id: 'titel', label: 'Titel', maxLength: 80 }, { type: 'image', id: 'foto', label: 'Foto' }, { type: 'text', id: 'Falsch!', label: 'x' }] } }],
    calendarCategories: ['Übung', 'Übung', 'Dienstabend'],
    keywords: { state: 'BY', stateName: 'Bayern', entries: [{ code: 'B 3', label: 'Brand Wohnhaus', category: 'Brand', id: 'aaaa', details: 'intern', aliases: ['B3'] } as any] },
  });
  const text = JSON.stringify(catalog);

  it('enthält Ein-/Ausgänge (Art + Name), Felder, Vergleiche, Bildvorlagen und Stichwörter', () => {
    expect(catalog.format).toBe('blaulichtcms.automations.catalog');
    expect(catalog.workflowFile).toMatchObject({ format: 'blaulichtcms.automations', schemaVersion: 1, schema: SCHEMA_FILE });
    expect(catalog.inputs).toEqual([
      { kind: 'fe2', name: 'FE2 Leitstelle' },
      { kind: 'manual', name: 'Termin von Hand', fields: [{ key: 'titel', label: 'Titel' }] },
    ]);
    expect(catalog.outputs).toEqual([
      { kind: 'mail', name: 'Mail an Leitung', usesFields: ['stichwort'] },
      { kind: 'notify', name: 'Redaktion informieren', usesFields: ['beitrag_titel', 'beitrag_link'] },
      { kind: 'post', name: 'Entwurf', usesFields: ['titel', 'alarmzeit'] },
    ]);
    expect(catalog.triggers.find((t) => t.kind === 'fe2')!.fields.map((f) => f.key)).toContain('stichwort_kategorie');
    expect(catalog.operators.map((o) => o.op)).toContain('starts_with');
    expect(catalog.nodeTypes.find((n) => n.type === 'condition')!.sourceHandles.map((h) => h.id)).toEqual(['true', 'false']);
    expect(catalog.imageTemplates).toEqual([{ name: 'Story 9:16', textFields: [{ id: 'titel', label: 'Titel', maxLength: 80 }] }]);
    expect(catalog.calendarCategories).toEqual(['Übung', 'Dienstabend']);
    expect(catalog.keywords).toEqual({ state: 'BY', stateName: 'Bayern', entries: [{ code: 'B 3', label: 'Brand Wohnhaus', category: 'Brand' }] });
  });

  it('enthält keine Kennungen, Einstellungen, Zugangsdaten oder Personendaten', () => {
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toMatch(/@example\.org|Mustermann|0171|geheimes|Gelöschter Eingang|intern|aliases|"B3"/);
    expect(text).not.toMatch(/"(config|connectionId|responsibilityIds|roles|userIds|siteIds?|listIds|feedId|collectionId|password|secret|token|subject|body|email)":/i);
  });
});
