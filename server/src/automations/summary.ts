import { INPUT_KINDS, NODE_TYPES, OPERATORS, OUTPUT_KINDS, SYSTEM_FIELDS, type InputKind, type NodeType, type Operator, type OutputKind } from './catalog.js';
import { slotKinds, type Graph, type GraphNode, type InputRef, type OutputRef } from './graph.js';
import { isGroup, type Group, type Rule } from './logic.js';

/*
 * Zusammenfassung eines Workflows in einem Satz („Wenn …, …“) für Liste und Editor. Reine Funktion ohne Datenbank;
 * Namen von Websites und Rollen kommen optional als Zuordnung dazu.
 */

export interface SummaryLabels {
  sites?: Map<string, string>;
  roles?: Map<string, string>;
}

const FIELD_LABEL = new Map<string, string>();
for (const f of SYSTEM_FIELDS) FIELD_LABEL.set(f.key, f.label);
for (const k of Object.values(INPUT_KINDS)) for (const f of k.fields) if (!FIELD_LABEL.has(f.key)) FIELD_LABEL.set(f.key, f.label);
for (const k of Object.values(OUTPUT_KINDS)) for (const f of k.produces) if (!FIELD_LABEL.has(f.key)) FIELD_LABEL.set(f.key, f.label);

/** Lesbarer Feldname ohne Klammerzusatz („Stufe (1 gering … 4 extrem)“ → „Stufe“). */
const fieldName = (key: string) => (FIELD_LABEL.get(key) ?? key).replace(/\s*\(.*\)\s*$/, '');

const list = (parts: string[], word = 'und') => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} ${word} ${parts[parts.length - 1]}`);

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** „ein neuer Einsatz über „FE2 Leitstelle“ eingeht“ – Nebensatz nach „Wenn“. */
function inputPhrase(n: GraphNode, inputs: Map<string, InputRef>): string {
  const inp = inputs.get(n.data?.inputId);
  const kind = (inp?.kind ?? slotKinds(n)[0]) as InputKind | undefined;
  const via = inp ? ` über „${inp.name}“` : '';
  const c = inp?.config ?? {};
  const phases: string[] = Array.isArray(c.phases) ? c.phases : ['neu'];
  switch (kind) {
    case 'fe2':
    case 'feuersoftware': {
      const what = phases.length === 1 && phases[0] === 'neu' ? 'ein neuer Alarm' : phases.length === 1 && phases[0] === 'beendet' ? 'ein Einsatz als beendet' : 'ein Alarm oder eine Einsatzänderung';
      return `${what}${via} eingeht`;
    }
    case 'warnfeed': {
      const what = phases.length === 1 && phases[0] === 'entwarnung' ? 'eine Entwarnung' : phases.length === 1 && phases[0] === 'neu' ? 'eine neue amtliche Warnung' : 'eine amtliche Warnung oder deren Änderung';
      return `${what}${inp && c.onlyInArea === false ? '' : ' für das eigene Gebiet'}${via} eingeht`;
    }
    case 'rss':
      return `ein neuer RSS-Eintrag${via} erscheint`;
    case 'upload':
      return `neue Dateien über einen Upload-Link${inp ? ` (${inp.name})` : ''} eingehen`;
    case 'schedule':
      if (!inp) return 'der Zeitplan fällig ist';
      return c.mode === 'interval' ? `alle ${c.minutes} Minuten der Zeitplan „${inp.name}“ fällig ist` : `es ${c.time} Uhr ist${Array.isArray(c.weekdays) && c.weekdays.length ? ` (${c.weekdays.map((d: number) => WEEKDAYS[d - 1]).join(', ')})` : ''}`;
    case 'press':
      return `eine neue Presseanfrage${via} eingeht`;
    case 'calendar': {
      const units: Record<string, [string, string]> = { minutes: ['Minute', 'Minuten'], hours: ['Stunde', 'Stunden'], days: ['Tag', 'Tagen'] };
      const n = Number(c.beforeValue) || 0;
      const u = units[c.beforeUnit ?? 'minutes'] ?? units.minutes;
      const filters = [Array.isArray(c.categoryIds) && c.categoryIds.length ? 'der gewählten Kategorie' : '', Array.isArray(c.tags) && c.tags.length ? `mit Schlagwort ${c.tags.join('/')}` : '', c.textContains ? `mit „${c.textContains}“` : ''].filter(Boolean).join(' ');
      const what = `ein Kalendertermin${filters ? ` ${filters}` : ''}${via}`;
      if (c.timing === 'end') return `${what} endet`;
      if (c.timing === 'before') return `${what} in ${n} ${n === 1 ? u[0] : u[1]} beginnt`;
      return `${what} beginnt`;
    }
    case 'manual':
      return `jemand den Workflow${inp ? ` über „${inp.name}“` : ''} von Hand startet`;
    default:
      return 'der Auslöser eintritt (noch nicht gewählt)';
  }
}

function rulePhrase(r: Rule): string {
  const f = fieldName(r.field);
  const v = r.value ?? '';
  switch (r.op as Operator) {
    case 'exists':
      return `${f} ausgefüllt ist`;
    case 'not_exists':
      return `${f} leer ist`;
    case 'eq':
      return `${f} „${v}“ ist`;
    case 'neq':
      return `${f} nicht „${v}“ ist`;
    case 'contains':
      return `${f} „${v}“ enthält`;
    case 'not_contains':
      return `${f} „${v}“ nicht enthält`;
    case 'starts_with':
      return `${f} mit „${v}“ beginnt`;
    case 'in':
      return `${f} eines von „${v}“ ist`;
    case 'gte':
      return `${f} mindestens ${v} ist`;
    case 'lte':
      return `${f} höchstens ${v} ist`;
    default:
      return `${f} ${OPERATORS[r.op as Operator] ?? r.op} „${v}“`;
  }
}

function groupPhrase(g: Group): string {
  const parts = g.rules.map((r) => (isGroup(r) ? `(${groupPhrase(r)})` : rulePhrase(r)));
  return list(parts, g.combinator === 'or' ? 'oder' : 'und');
}

const TONE: Record<string, string> = { info: 'Hinweis', warning: 'Warnung', danger: 'Gefahr' };

/** Hauptsatz einer Aktion („erscheint nach Freigabe auf der Website ein Banner der Stufe „Warnung““). */
function outputPhrase(n: GraphNode, outputs: Map<string, OutputRef>, labels: SummaryLabels, directAllowed: boolean): string {
  const o = outputs.get(n.data?.outputId);
  const kind = (o?.kind ?? slotKinds(n)[0]) as OutputKind | undefined;
  const c = o?.config ?? {};
  const direct = !!n.data?.direct && directAllowed;
  const roles = (ids: unknown) => (Array.isArray(ids) ? ids.map((r) => `Rolle „${labels.roles?.get(r) ?? r}“`) : []);
  switch (kind) {
    case 'banner': {
      const ids: string[] = Array.isArray(c.siteIds) ? c.siteIds : [];
      const names = ids.map((s) => labels.sites?.get(s)).filter(Boolean) as string[];
      const where = names.length ? `auf ${list(names.map((x) => `„${x}“`))}` : ids.length > 1 ? 'auf den Websites' : 'auf der Website';
      const tone = c.tone === 'auto' ? ' mit Stufe nach Warnstufe' : TONE[c.tone] ? ` der Stufe „${TONE[c.tone]}“` : '';
      return direct ? `erscheint sofort ${where} ein Banner${tone}` : `erscheint ${c.submit === false ? 'nach Prüfung und Freigabe' : 'nach Freigabe'} ${where} ein Banner${tone}`;
    }
    case 'post':
      return direct ? 'wird ein Beitrag direkt auf der Website veröffentlicht' : c.submit ? 'entsteht ein Beitragsentwurf, der zur Freigabe eingereicht wird' : 'entsteht ein Beitragsentwurf';
    case 'mail': {
      const to = [...roles(c.roles), ...(Array.isArray(c.responsibilityIds) && c.responsibilityIds.length ? ['hinterlegte Zuständigkeiten'] : [])];
      return `geht eine E-Mail${to.length ? ` an ${list(to)}` : ''} hinaus`;
    }
    case 'notify': {
      const to = [...roles(c.roles), ...(Array.isArray(c.userIds) && c.userIds.length ? [`${c.userIds.length === 1 ? 'eine Person' : `${c.userIds.length} Personen`}`] : [])];
      return `geht eine Benachrichtigung in BlaulichtCMS${to.length ? ` an ${list(to)}` : ''} hinaus`;
    }
    case 'warning_draft':
      return 'wird ein Warnentwurf vorbereitet';
    case 'incident_entry':
      return c.submit === false ? 'entsteht ein Eintrag für die Einsatzliste' : 'entsteht ein Eintrag für die Einsatzliste, der zur Freigabe eingereicht wird';
    default:
      return 'passiert die gewählte Aktion (noch nicht gewählt)';
  }
}

/**
 * Ein Satz für den ganzen Workflow. Einfache Abläufe (Eingänge → höchstens eine Bedingung → Ausgänge) werden vollständig
 * beschrieben; bei Verzweigungen und weiteren Schritten nennt der Satz Auslöser, Zahl der Zwischenschritte und Aktionen.
 */
export function summarizeGraph(g: Pick<Graph, 'nodes' | 'edges'>, refs: { inputs: Map<string, InputRef>; outputs: Map<string, OutputRef> }, labels: SummaryLabels = {}, directAllowed = false): string {
  const ins = g.nodes.filter((n) => n.type === 'input');
  const outs = g.nodes.filter((n) => n.type === 'output');
  const middle = g.nodes.filter((n) => n.type !== 'input' && n.type !== 'output');
  if (!ins.length && !outs.length) return middle.length ? 'Noch kein Auslöser und keine Aktion gewählt.' : 'Noch leer: zuerst einen Auslöser und eine Aktion wählen.';
  const when = ins.length ? `Wenn ${list(ins.map((n) => inputPhrase(n, refs.inputs)), 'oder')}` : 'Ohne Auslöser';
  const then = outs.length ? list(outs.map((n) => outputPhrase(n, refs.outputs, labels, directAllowed))) : 'passiert noch nichts (keine Aktion gewählt)';
  const cond = middle.length === 1 && middle[0].type === 'condition' ? (middle[0].data as Group) : null;
  if (cond && Array.isArray(cond.rules) && cond.rules.length) {
    // Nur „trifft zu“ führt zu Aktionen? Dann „und …“, sonst allgemeiner Satz
    const onlyTrue = g.edges.filter((e) => e.source === middle[0].id).every((e) => (e.sourceHandle ?? 'out') === 'true');
    if (onlyTrue) return `${when} und ${groupPhrase(cond)}, ${then}.`;
  }
  if (!middle.length || (cond && !cond.rules?.length)) return `${when}, ${then}.`;
  const kinds = [...new Set(middle.map((n) => NODE_TYPES[n.type as NodeType]?.label).filter(Boolean))];
  return `${when}, ${then} – über ${middle.length === 1 ? 'einen Zwischenschritt' : `${middle.length} Zwischenschritte`} (${kinds.join(', ')}).`;
}
