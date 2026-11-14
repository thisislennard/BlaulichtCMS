import { log } from '../lib/log.js';
import { checkTemplate, OPERATORS, testConditions, type Condition } from '../lib/template.js';
import { StepError } from '../lib/errors.js';
import type { NodeType } from '../engine/types.js';

const operatorOptions = OPERATORS.map((o) => ({ value: o.id, label: o.label }));

function conditionProblems(conditions: Condition[] | undefined): string[] {
  const out: string[] = [];
  if (!Array.isArray(conditions) || conditions.length === 0) return ['Mindestens eine Bedingung angeben.'];
  conditions.forEach((c, i) => {
    if (!c.left?.trim()) out.push(`Bedingung ${i + 1}: linker Wert fehlt.`);
    if (!OPERATORS.some((o) => o.id === c.op)) out.push(`Bedingung ${i + 1}: unbekannter Vergleich.`);
    const lp = c.left ? checkTemplate(c.left) : null;
    if (lp) out.push(`Bedingung ${i + 1}: ${lp}`);
    const rp = c.right ? checkTemplate(c.right) : null;
    if (rp) out.push(`Bedingung ${i + 1}: ${rp}`);
  });
  return out;
}

/* ------------------------------------ Trigger --------------------------------------- */

export const webhookTrigger: NodeType = {
  type: 'trigger.webhook',
  category: 'trigger',
  title: 'Webhook',
  description: 'Startet den Workflow, wenn ein anderes System Daten an eine LifeLink-Adresse sendet.',
  icon: 'Webhook',
  trigger: 'webhook',
  fields: [
    {
      key: 'authMode',
      type: 'select',
      label: 'Absicherung',
      default: 'hmac',
      options: [
        { value: 'hmac', label: 'HMAC-Signatur (empfohlen)', hint: 'Absender signiert jede Anfrage mit dem Geheimnis' },
        { value: 'token', label: 'Geheimer Schlüssel im Header', hint: 'Für Systeme, die nicht signieren können' },
      ],
      help: 'Die Adresse und das Geheimnis erscheinen nach dem Veröffentlichen unter Integrationen → Webhooks.',
    },
    {
      key: 'dedupPath',
      type: 'text',
      label: 'Feld für Duplikaterkennung',
      placeholder: 'body.id',
      help: 'Kommt dasselbe Ereignis zweimal (gleicher Wert), startet nur ein Lauf. Leer = Header „Idempotency-Key“ bzw. „X-Event-Id“.',
      advanced: true,
    },
    { key: 'maxBodyKb', type: 'number', label: 'Maximale Größe (KB)', default: 256, min: 1, max: 5120, advanced: true },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'body', type: 'object', description: 'Gesendete Daten (JSON oder Formular)' },
    { path: 'query', type: 'object', description: 'URL-Parameter' },
    { path: 'headers', type: 'object', description: 'Ausgewählte Header (ohne Zugangsdaten)' },
    { path: 'received_at', type: 'date', description: 'Empfangszeit (UTC)' },
  ],
  sampleOutput: { body: { titel: 'Beispiel', text: 'Hallo aus dem Webhook' }, query: {}, headers: { 'content-type': 'application/json' }, received_at: '2026-10-29T17:08:00.000Z' },
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
  help: `Ein Webhook ist eine Adresse, an die ein anderes System per HTTP-POST Daten schickt. LifeLink nimmt die Anfrage an, prüft die Absicherung, speichert das Ereignis und startet den Workflow im Hintergrund. Die Antwort kommt sofort (202), unabhängig davon, wie lange der Workflow läuft.`,
};

export const manualTrigger: NodeType = {
  type: 'trigger.manual',
  category: 'trigger',
  title: 'Manuell starten',
  description: 'Workflow per Knopfdruck in LifeLink oder über die API starten.',
  icon: 'MousePointerClick',
  trigger: 'manual',
  fields: [
    { key: 'sample', type: 'json', label: 'Beispieldaten', help: 'Werden beim Start vorgeschlagen und im Testlauf verwendet.', default: '{\n  "nachricht": "Hallo"\n}' },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [{ path: 'data', type: 'object', description: 'Beim Start übergebene Daten' }],
  sampleOutput: { data: { nachricht: 'Hallo' }, started_by: 'Lennard' },
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
};

export const scheduleTrigger: NodeType = {
  type: 'trigger.schedule',
  category: 'trigger',
  title: 'Zeitplan',
  description: 'Startet den Workflow regelmäßig – z. B. alle 15 Minuten oder jeden Montag um 7 Uhr.',
  icon: 'CalendarClock',
  trigger: 'schedule',
  fields: [
    {
      key: 'mode',
      type: 'select',
      label: 'Rhythmus',
      default: 'daily',
      options: [
        { value: 'interval', label: 'Alle X Minuten' },
        { value: 'daily', label: 'Täglich zu einer Uhrzeit' },
        { value: 'weekly', label: 'Wöchentlich' },
        { value: 'cron', label: 'Cron-Ausdruck (Experten)' },
      ],
    },
    { key: 'intervalMinutes', type: 'number', label: 'Minuten', default: 15, min: 1, max: 1440, showIf: { key: 'mode', equals: 'interval' } },
    { key: 'time', type: 'text', label: 'Uhrzeit', default: '07:00', placeholder: 'HH:MM', showIf: { key: 'mode', equals: ['daily', 'weekly'] } },
    {
      key: 'weekdays',
      type: 'multiselect',
      label: 'Wochentage',
      default: ['1'],
      showIf: { key: 'mode', equals: 'weekly' },
      options: [
        { value: '1', label: 'Mo' },
        { value: '2', label: 'Di' },
        { value: '3', label: 'Mi' },
        { value: '4', label: 'Do' },
        { value: '5', label: 'Fr' },
        { value: '6', label: 'Sa' },
        { value: '0', label: 'So' },
      ],
    },
    { key: 'cron', type: 'cron', label: 'Cron-Ausdruck', placeholder: '0 7 * * 1', showIf: { key: 'mode', equals: 'cron' } },
    { key: 'timezone', type: 'timezone', label: 'Zeitzone', help: 'Leer = Zeitzone der Instanz. Sommer-/Winterzeit wird berücksichtigt.', advanced: true },
    {
      key: 'missed',
      type: 'select',
      label: 'Verpasste Termine',
      default: 'once',
      advanced: true,
      help: 'Was passiert, wenn LifeLink zum geplanten Zeitpunkt nicht lief?',
      options: [
        { value: 'once', label: 'Einmal nachholen' },
        { value: 'skip', label: 'Überspringen' },
      ],
    },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'scheduled_at', type: 'date', description: 'Geplanter Zeitpunkt' },
    { path: 'fired_at', type: 'date', description: 'Tatsächlicher Start' },
    { path: 'catch_up', type: 'boolean', description: 'Nachgeholter Termin?' },
  ],
  sampleOutput: { scheduled_at: '2026-10-29T06:00:00.000Z', fired_at: '2026-10-29T06:00:01.000Z', catch_up: false },
  validate(config) {
    const out: string[] = [];
    if (['daily', 'weekly'].includes(config.mode) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.time ?? '')) out.push('Uhrzeit im Format HH:MM angeben.');
    if (config.mode === 'weekly' && !(config.weekdays ?? []).length) out.push('Mindestens einen Wochentag wählen.');
    if (config.mode === 'cron' && !(config.cron ?? '').trim()) out.push('Cron-Ausdruck angeben.');
    return out;
  },
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
};

/* ---------------------------------- Bedingungen ------------------------------------- */

const conditionFields = [
  { key: 'conditions', type: 'conditions' as const, label: 'Bedingungen', required: true, default: [{ left: '', op: 'eq', right: '' }] },
  {
    key: 'combinator',
    type: 'select' as const,
    label: 'Verknüpfung',
    default: 'all',
    options: [
      { value: 'all', label: 'Alle Bedingungen müssen zutreffen (UND)' },
      { value: 'any', label: 'Mindestens eine muss zutreffen (ODER)' },
    ],
  },
];

export const ifNode: NodeType = {
  type: 'logic.if',
  category: 'condition',
  title: 'Wenn / Sonst',
  description: 'Verzweigt je nach Bedingung in „Wahr“ oder „Falsch“.',
  icon: 'GitBranch',
  fields: conditionFields,
  outputs: [
    { id: 'true', label: 'Wahr' },
    { id: 'false', label: 'Falsch' },
  ],
  outputFields: [{ path: 'result', type: 'boolean', description: 'Ergebnis der Prüfung' }],
  sampleOutput: { result: true },
  validate: (c) => conditionProblems(c.conditions),
  async execute(ctx) {
    const result = testConditions(ctx.node.config.conditions ?? [], ctx.node.config.combinator ?? 'all', ctx.data);
    return { output: { result }, port: result ? 'true' : 'false', statusText: result ? 'Wahr' : 'Falsch' };
  },
};

export const filterNode: NodeType = {
  type: 'logic.filter',
  category: 'condition',
  title: 'Filter',
  description: 'Lässt den Lauf nur weiterlaufen, wenn die Bedingung zutrifft.',
  icon: 'Filter',
  fields: conditionFields,
  outputs: [{ id: 'out', label: 'Passt' }],
  outputFields: [{ path: 'passed', type: 'boolean', description: 'Bedingung erfüllt?' }],
  sampleOutput: { passed: true },
  validate: (c) => conditionProblems(c.conditions),
  async execute(ctx) {
    const passed = testConditions(ctx.node.config.conditions ?? [], ctx.node.config.combinator ?? 'all', ctx.data);
    return { output: { passed }, port: passed ? 'out' : '__none', statusText: passed ? 'Passt' : 'Gefiltert – Lauf endet hier' };
  },
};

export const switchNode: NodeType = {
  type: 'logic.switch',
  category: 'condition',
  title: 'Switch',
  description: 'Verzweigt je nach Wert in mehrere Ausgänge, z. B. nach Einsatzart.',
  icon: 'Split',
  fields: [
    { key: 'value', type: 'variableText', label: 'Wert', required: true, placeholder: '{{ alamos.stichwort }}' },
    { key: 'cases', type: 'cases', label: 'Fälle', required: true, default: [{ id: 'c1', label: 'Fall 1', match: '' }], help: 'Mehrere Werte je Fall mit Komma trennen. Groß-/Kleinschreibung egal.' },
    { key: 'matchMode', type: 'select', label: 'Vergleich', default: 'eq', options: [{ value: 'eq', label: 'ist gleich' }, { value: 'starts_with', label: 'beginnt mit' }, { value: 'contains', label: 'enthält' }] },
  ],
  outputs: (config) => [
    ...((config.cases ?? []) as { id: string; label: string }[]).map((c) => ({ id: `case:${c.id}`, label: c.label || c.id })),
    { id: 'default', label: 'Sonst' },
  ],
  outputFields: [
    { path: 'value', type: 'text', description: 'Geprüfter Wert' },
    { path: 'case', type: 'text', description: 'Getroffener Fall' },
  ],
  sampleOutput: { value: 'B3', case: 'Brand' },
  validate(c) {
    const out: string[] = [];
    if (!c.value?.trim()) out.push('Wert angeben.');
    if (!(c.cases ?? []).length) out.push('Mindestens einen Fall anlegen.');
    return out;
  },
  async execute(ctx) {
    const raw = ctx.render(ctx.node.config.value).trim().toLowerCase();
    const mode = ctx.node.config.matchMode ?? 'eq';
    for (const c of (ctx.node.config.cases ?? []) as { id: string; label: string; match: string }[]) {
      const values = String(c.match ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      const hit = values.some((v) => (mode === 'eq' ? raw === v : mode === 'starts_with' ? raw.startsWith(v) : raw.includes(v)));
      if (hit) return { output: { value: raw, case: c.label }, port: `case:${c.id}`, statusText: c.label };
    }
    return { output: { value: raw, case: null }, port: 'default', statusText: 'Sonst' };
  },
};

/* -------------------------------- Datenverarbeitung --------------------------------- */

export const setNode: NodeType = {
  type: 'data.set',
  category: 'data',
  title: 'Felder zuordnen',
  description: 'Stellt neue Felder aus vorhandenen Daten zusammen (Mapping).',
  icon: 'ArrowRightLeft',
  fields: [
    { key: 'mappings', type: 'mappings', label: 'Felder', required: true, default: [{ key: 'titel', value: '' }], help: 'Links der neue Feldname, rechts der Wert oder eine Variable.' },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  sampleOutput: { titel: 'Beispiel' },
  validate(c) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of c.mappings ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.key ?? '')) out.push(`Feldname „${m.key ?? ''}“ ist ungültig (Buchstaben, Ziffern, _).`);
      if (seen.has(m.key)) out.push(`Feldname „${m.key}“ doppelt.`);
      seen.add(m.key);
      const p = m.value ? checkTemplate(m.value) : null;
      if (p) out.push(`${m.key}: ${p}`);
    }
    if (!(c.mappings ?? []).length) out.push('Mindestens ein Feld anlegen.');
    return out;
  },
  async execute(ctx) {
    const out: Record<string, unknown> = {};
    for (const m of ctx.node.config.mappings ?? []) out[m.key] = ctx.renderValue(m.value);
    return { output: out };
  },
};

export const textNode: NodeType = {
  type: 'data.text',
  category: 'data',
  title: 'Text zusammensetzen',
  description: 'Erzeugt einen Text aus einer Vorlage mit Variablen.',
  icon: 'TextCursorInput',
  fields: [{ key: 'template', type: 'variableTextarea', label: 'Vorlage', required: true, placeholder: 'Einsatz {{ alamos.stichwort }} in {{ alamos.ort }}' }],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [{ path: 'text', type: 'text', description: 'Fertiger Text' }],
  sampleOutput: { text: 'Einsatz B3 in Musterstadt' },
  validate: (c) => (c.template?.trim() ? [checkTemplate(c.template)].filter(Boolean) as string[] : ['Vorlage angeben.']),
  async execute(ctx) {
    return { output: { text: ctx.render(ctx.node.config.template) } };
  },
};

export const jsonNode: NodeType = {
  type: 'data.json',
  category: 'data',
  title: 'JSON lesen',
  description: 'Wandelt einen JSON-Text in Felder um.',
  icon: 'Braces',
  fields: [{ key: 'source', type: 'variableText', label: 'JSON-Text', required: true, placeholder: '{{ webhook.body.daten }}' }],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [{ path: 'data', type: 'object', description: 'Gelesene Daten' }],
  sampleOutput: { data: { feld: 'wert' } },
  async execute(ctx) {
    const v = ctx.renderValue(ctx.node.config.source);
    if (v && typeof v === 'object') return { output: { data: v } };
    try {
      return { output: { data: JSON.parse(String(v ?? '')) } };
    } catch (e) {
      throw new StepError('invalid_payload', 'Der Text ist kein gültiges JSON.', { technical: (e as Error).message });
    }
  },
};

/* ------------------------------------ Steuerung ------------------------------------- */

export const waitNode: NodeType = {
  type: 'control.wait',
  category: 'control',
  title: 'Warten',
  description: 'Pausiert den Lauf für eine Zeit, z. B. bevor ein Banner wieder entfernt wird.',
  icon: 'Hourglass',
  fields: [
    { key: 'amount', type: 'number', label: 'Dauer', default: 5, min: 1, max: 100_000, required: true },
    { key: 'unit', type: 'select', label: 'Einheit', default: 'minutes', options: [{ value: 'seconds', label: 'Sekunden' }, { value: 'minutes', label: 'Minuten' }, { value: 'hours', label: 'Stunden' }, { value: 'days', label: 'Tage' }] },
  ],
  outputs: [{ id: 'out', label: 'Danach' }],
  outputFields: [{ path: 'waited_until', type: 'date', description: 'Ende der Pause' }],
  sampleOutput: { waited_until: '2026-10-29T17:13:00.000Z' },
  validate(c) {
    const ms = waitMs(c);
    if (!(ms > 0)) return ['Dauer angeben.'];
    if (ms > 30 * 86_400_000) return ['Höchstens 30 Tage warten.'];
    return [];
  },
  async execute(ctx) {
    const until = Date.now() + waitMs(ctx.node.config);
    return { output: { waited_until: new Date(until).toISOString() }, waitUntil: until, statusText: 'Wartet' };
  },
  async simulate(ctx) {
    return { output: { waited_until: new Date(Date.now() + waitMs(ctx.node.config)).toISOString() }, statusText: 'Testlauf: Pause übersprungen' };
  },
};

export function waitMs(c: Record<string, any>): number {
  const n = Number(c.amount ?? 0);
  const f = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[c.unit as string] ?? 60_000;
  return n * f;
}

export const logNode: NodeType = {
  type: 'control.log',
  category: 'control',
  title: 'Protokoll',
  description: 'Schreibt eine Meldung ins Systemprotokoll (maskiert).',
  icon: 'NotebookPen',
  fields: [
    { key: 'message', type: 'variableText', label: 'Meldung', required: true },
    { key: 'level', type: 'select', label: 'Stufe', default: 'info', options: [{ value: 'info', label: 'Info' }, { value: 'warn', label: 'Warnung' }, { value: 'error', label: 'Fehler' }] },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [{ path: 'message', type: 'text', description: 'Geschriebene Meldung' }],
  async execute(ctx) {
    const message = ctx.render(ctx.node.config.message).slice(0, 1000);
    log(ctx.node.config.level ?? 'info', 'workflow', message, { lauf: ctx.run.id, workflow: ctx.run.workflowName }, ctx.run.correlationId);
    return { output: { message } };
  },
};

export const stopNode: NodeType = {
  type: 'control.stop',
  category: 'control',
  title: 'Lauf beenden',
  description: 'Beendet den Lauf mit Erfolg oder als Fehler (z. B. für Plausibilitätsprüfungen).',
  icon: 'CircleStop',
  fields: [
    { key: 'status', type: 'select', label: 'Ergebnis', default: 'success', options: [{ value: 'success', label: 'Erfolgreich beenden' }, { value: 'error', label: 'Als Fehler beenden' }] },
    { key: 'message', type: 'variableText', label: 'Begründung', placeholder: 'Einsatzart nicht relevant' },
  ],
  outputs: [],
  async execute(ctx) {
    const message = ctx.render(ctx.node.config.message);
    return { output: { message }, stopRun: ctx.node.config.status === 'error' ? 'error' : 'success', statusText: message || 'Beendet' };
  },
};

export const CORE_NODES: NodeType[] = [
  webhookTrigger,
  manualTrigger,
  scheduleTrigger,
  ifNode,
  filterNode,
  switchNode,
  setNode,
  textNode,
  jsonNode,
  waitNode,
  logNode,
  stopNode,
];

export { operatorOptions };
