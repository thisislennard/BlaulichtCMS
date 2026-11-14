import type { Graph, GraphNode } from '../engine/types.js';

/** Mitgelieferte Workflow-Vorlagen. Verbindungen wählt der Nutzer nach dem Anlegen. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  connectors: string[];
  graph: Graph;
}

let n = 0;
function node(type: string, key: string, name: string, x: number, y: number, config: Record<string, any> = {}, extra: Partial<GraphNode> = {}): GraphNode {
  n++;
  return { id: `n${n}`, type, key, name, position: { x, y }, config, ...extra };
}
function edge(source: GraphNode, target: GraphNode, sourcePort = 'out') {
  return { id: `e_${source.id}_${sourcePort}_${target.id}`, source: source.id, sourcePort, target: target.id };
}

function bannerTemplate(): WorkflowTemplate {
  n = 0;
  const t = node('alamos.alarm', 'alamos', 'Alamos-Einsatz', 0, 120, { kind: 'alarm', dedupMinutes: 30 });
  const f = node('logic.filter', 'relevant', 'Nur öffentliche Einsatzarten', 280, 120, {
    conditions: [{ left: '{{ alamos.stichwort }}', op: 'starts_with', right: 'B' }],
    combinator: 'any',
  });
  const b = node('wordpress.banner', 'banner', 'Website-Banner', 560, 120, {
    bannerKey: '{{ alamos.einsatz_id }}',
    title: 'Einsatz: {{ alamos.stichwort }} – {{ alamos.stichwort_text }}',
    text: 'Unsere Einsatzkräfte sind in {{ alamos.ortsteil | default:alamos.stadt }} im Einsatz. Bitte Rettungswege freihalten.',
    label: 'Einsatz',
    color: 'rot',
    priority: 'hoch',
    durationMinutes: 60,
    pages: ['front'],
    requireApproval: false,
  });
  return {
    id: 'einsatz-banner',
    name: 'Einsatz → Website-Banner',
    description: 'Zeigt bei einem Einsatz für eine Stunde ein rotes Banner auf der Website. Keine Adressen oder Personendaten.',
    category: 'Website',
    connectors: ['alamos', 'wordpress'],
    graph: { nodes: [t, f, b], edges: [edge(t, f), edge(f, b)] },
  };
}

function postTemplate(): WorkflowTemplate {
  n = 0;
  const t = node('alamos.alarm', 'alamos', 'Alamos-Einsatz', 0, 120, { kind: 'alarm' });
  const p = node('wordpress.post', 'beitrag', 'Beitragsentwurf', 280, 120, {
    postKey: '{{ alamos.einsatz_id }}',
    title: 'Einsatz: {{ alamos.stichwort_text | default:alamos.stichwort }}',
    content: 'Am {{ alamos.alarmzeit | date:"dd.MM.yyyy" }} um {{ alamos.alarmzeit | date:"HH:mm" }} Uhr wurden wir alarmiert.\n\n(Bericht ergänzen)',
    category: 'Einsätze',
    status: 'draft',
  });
  return {
    id: 'einsatz-beitrag',
    name: 'Einsatz → Beitragsentwurf',
    description: 'Legt zu jedem Einsatz einen Beitragsentwurf in WordPress an, den die Redaktion vervollständigt.',
    category: 'Website',
    connectors: ['alamos', 'wordpress'],
    graph: { nodes: [t, p], edges: [edge(t, p)] },
  };
}

function calendarMailTemplate(): WorkflowTemplate {
  n = 0;
  const t = node('alamos.calendar', 'termin', 'FE2-Kalender', 0, 120, { intervalMinutes: 15, events: ['new', 'changed', 'deleted'], horizonDays: 60 });
  const m = node('email.send', 'mail', 'E-Mail an Verteiler', 280, 120, {
    to: [],
    subject: 'Termin {{ termin.aenderung }}: {{ termin.titel }}',
    text: '{{ termin.titel }}\nBeginn: {{ termin.beginn | date:"dd.MM.yyyy HH:mm" }}\nOrt: {{ termin.ort | default:"–" }}\n\n{{ termin.beschreibung }}',
    format: 'text',
  });
  return {
    id: 'termin-mail',
    name: 'Kalendertermin → E-Mail',
    description: 'Informiert einen festen Verteiler, wenn im FE2-Kalender Termine neu angelegt, geändert oder abgesagt werden.',
    category: 'E-Mail',
    connectors: ['alamos', 'smtp'],
    graph: { nodes: [t, m], edges: [edge(t, m)] },
  };
}

function webhookTeamsTemplate(): WorkflowTemplate {
  n = 0;
  const t = node('trigger.webhook', 'webhook', 'Webhook', 0, 120, { authMode: 'hmac' });
  const i = node('logic.if', 'pruefung', 'Wichtig?', 280, 120, { conditions: [{ left: '{{ webhook.body.prioritaet }}', op: 'eq', right: 'hoch' }], combinator: 'all' });
  const a = node('teams.message', 'teams_wichtig', 'Teams (wichtig)', 560, 40, { title: '{{ webhook.body.titel }}', text: '{{ webhook.body.text }}', style: 'Attention' });
  const b = node('control.log', 'protokoll', 'Nur protokollieren', 560, 220, { message: 'Meldung ohne Priorität: {{ webhook.body.titel }}', level: 'info' });
  return {
    id: 'webhook-teams',
    name: 'Webhook → Teams',
    description: 'Nimmt signierte Meldungen an und postet wichtige davon in einen Teams-Kanal.',
    category: 'Nachrichten',
    connectors: ['webhook', 'teams'],
    graph: { nodes: [t, i, a, b], edges: [edge(t, i), edge(i, a, 'true'), edge(i, b, 'false')] },
  };
}

function webhookMailTemplate(): WorkflowTemplate {
  n = 0;
  const t = node('trigger.webhook', 'webhook', 'Webhook', 0, 120, { authMode: 'hmac' });
  const m = node('email.send', 'mail', 'E-Mail senden', 280, 120, { to: [], subject: '{{ webhook.body.betreff | default:"Neue Meldung" }}', text: '{{ webhook.body.text }}', format: 'text' });
  return {
    id: 'webhook-mail',
    name: 'Webhook → E-Mail',
    description: 'Leitet eingehende Meldungen per E-Mail an einen festen Empfängerkreis weiter.',
    category: 'E-Mail',
    connectors: ['webhook', 'smtp'],
    graph: { nodes: [t, m], edges: [edge(t, m)] },
  };
}

function healthCheckTemplate(): WorkflowTemplate {
  n = 0;
  const t = node('trigger.schedule', 'zeitplan', 'Alle 15 Minuten', 0, 120, { mode: 'interval', intervalMinutes: 15 });
  const h = node('http.request', 'pruefung', 'Website prüfen', 280, 120, { method: 'GET', url: 'https://', bodyType: 'none', failOnStatus: false }, { settings: { retries: 2, onError: 'continue' } });
  const i = node('logic.if', 'ok', 'Antwort OK?', 560, 120, { conditions: [{ left: '{{ pruefung.status }}', op: 'lt', right: '400' }], combinator: 'all' });
  const a = node('teams.message', 'alarm', 'Teams-Hinweis', 840, 200, { title: 'Website antwortet nicht', text: 'Status: {{ pruefung.status | default:"keine Antwort" }}', style: 'Warning' });
  return {
    id: 'website-check',
    name: 'Erreichbarkeit prüfen',
    description: 'Prüft regelmäßig eine Adresse und meldet Ausfälle in Teams.',
    category: 'Betrieb',
    connectors: ['http', 'teams'],
    graph: { nodes: [t, h, i, a], edges: [edge(t, h), edge(h, i), edge(h, i, 'error'), edge(i, a, 'false')] },
  };
}

export const TEMPLATES: WorkflowTemplate[] = [bannerTemplate(), postTemplate(), calendarMailTemplate(), webhookTeamsTemplate(), webhookMailTemplate(), healthCheckTemplate()];
