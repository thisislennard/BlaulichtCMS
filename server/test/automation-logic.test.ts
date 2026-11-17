import { describe, expect, it } from 'vitest';
import { graphHash, graphSchema, inputFields, outputNeeds, topoOrder, validateGraph, type Graph, type InputRef, type OutputRef } from '../src/automations/graph.js';
import { dedupKey, escapeHtml, evaluateGroup, evaluateRule, lastDueSlot, parseWhen, placeholders, redactForLog, renderTemplate } from '../src/automations/logic.js';
import { INPUT_CONFIG, OUTPUT_CONFIG } from '../src/automations/configs.js';
import { buildSnapshot, snapshotHash } from '../src/automations/engine.js';
import { permissionsFor } from '../src/auth/permissions.js';

/* Reine Logik der Automationen (ohne Datenbank): Vorlagen, Bedingungen, Entprellen, Zeitpläne, Prüfung des Ablaufs. */

const IN = '11111111-1111-4111-8111-111111111111';
const OUT = '22222222-2222-4222-8222-222222222222';
const inputs = new Map<string, InputRef>([[IN, { id: IN, name: 'FE2', kind: 'fe2', config: { connectionId: IN, phases: ['neu'] } }]]);
const outputs = new Map<string, OutputRef>([[OUT, { id: OUT, name: 'Entwurf', kind: 'post', config: { kind: 'incident', title: 'Einsatz {{stichwort}} in {{ort}}', body: '{{stichwort_text}}' } }]]);
const ctx = { inputs, outputs };
const node = (id: string, type: string, data: any, x = 0, y = 0) => ({ id, type: type as any, position: { x, y }, data });
const edge = (id: string, source: string, target: string, sourceHandle = 'out') => ({ id, source, target, sourceHandle });

function base(): Graph {
  return {
    nodes: [
      node('in', 'input', { inputId: IN }, 0, 0),
      node('if', 'condition', { combinator: 'and', rules: [{ field: 'stichwort', op: 'starts_with', value: 'B' }] }, 0, 100),
      node('out', 'output', { outputId: OUT }, 0, 200),
    ],
    edges: [edge('e1', 'in', 'if'), edge('e2', 'if', 'out', 'true')],
  };
}

describe('Automationen: Vorlagen', () => {
  it('ersetzt nur {{feld}}, meldet fehlende Felder und führt keinen Code aus', () => {
    const r = renderTemplate('Einsatz {{ stichwort }} in {{ort}} – {{fehlt}} {{constructor}} ${process.exit()} {{__proto__}}', { stichwort: 'B2', ort: 'Musterstadt' });
    expect(r.text).toBe('Einsatz B2 in Musterstadt –   ${process.exit()} {{__proto__}}');
    expect(r.missing).toEqual(['fehlt', 'constructor']);
    expect(placeholders('{{a}} {{ b_2 }} {{a}} {{Gross}} {{1x}}')).toEqual(['a', 'b_2']);
  });
  it('maskiert HTML auf Wunsch, entfernt Steuerzeichen, kürzt und formatiert Zeitpunkte', () => {
    expect(renderTemplate('<b>{{x}}</b>', { x: '<script>alert("x")</script>' }, { escape: 'html' }).text).toBe('<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b>');
    expect(escapeHtml(`'&`)).toBe('&#39;&amp;');
    expect(renderTemplate('{{x}}', { x: 'a\u0000b\u0007c\nd' }).text).toBe('abc\nd');
    // gekürzt an einer Zeichengrenze mit „…“ (#232)
    expect(renderTemplate('{{x}}', { x: 'abcdef' }, { maxLength: 3 }).text).toBe('ab…');
    expect(renderTemplate('{{t}}', { t: '2026-07-01T10:00:00.000Z' }, { timeZone: 'Europe/Berlin' }).text).toMatch(/01\.07\.2026, 12:00/);
    expect(renderTemplate('{{l}}', { l: ['a', 'b'] }).text).toBe('a, b');
  });
});

describe('Automationen: Bedingungen', () => {
  const d = { stichwort: 'B2 Wohnung', stufe: '3', leer: '', liste: 'x' };
  it('Operatoren auf Text und Zahlen', () => {
    expect(evaluateRule({ field: 'stichwort', op: 'starts_with', value: 'b' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stichwort', op: 'contains', value: 'wohn' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stichwort', op: 'not_contains', value: 'wald' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stichwort', op: 'eq', value: ' b2 wohnung ' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stichwort', op: 'neq', value: 'B2' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stufe', op: 'gte', value: '3' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stufe', op: 'gte', value: '3,5' }, d)).toBe(false);
    expect(evaluateRule({ field: 'stufe', op: 'lte', value: 'drei' }, d)).toBe(false);
    expect(evaluateRule({ field: 'stichwort', op: 'gte', value: '1' }, d)).toBe(false);
    expect(evaluateRule({ field: 'liste', op: 'in', value: 'a, X;c' }, d)).toBe(true);
    expect(evaluateRule({ field: 'leer', op: 'exists' }, d)).toBe(false);
    expect(evaluateRule({ field: 'gibtsnicht', op: 'not_exists' }, d)).toBe(true);
    expect(evaluateRule({ field: 'stichwort', op: 'contains', value: '' }, d)).toBe(false);
  });
  it('Datumsfelder als Zeitpunkt (#233): liegt vor/nach, relative und feste Angaben in Ortszeit', () => {
    const tz = { timeZone: 'Europe/Berlin', now: Date.parse('2026-11-17T10:00:00.000Z') };
    const t = { beginn: '2026-11-21T09:00:00.000Z', alarmzeit: '2026-11-17T09:30:00.000Z', text: 'kein Datum', leer: '' };
    const r = (field: string, op: 'before' | 'after', value: string) => evaluateRule({ field, op, value }, t, tz);
    // Der Textvergleich traf bisher nur zufällig („beginnt mit 21.11.“ geht, „vor dem 22.11.“ ging nicht)
    expect(r('beginn', 'before', '22.11.2026')).toBe(true);
    expect(r('beginn', 'before', '21.11.2026 10:00')).toBe(false); // 09:00 UTC = 10:00 Ortszeit, nicht davor
    expect(r('beginn', 'before', '21.11.2026 10:01')).toBe(true);
    expect(r('beginn', 'after', '2026-11-21')).toBe(true);
    expect(r('beginn', 'after', 'jetzt')).toBe(true);
    expect(r('beginn', 'after', '')).toBe(true);
    expect(r('beginn', 'before', 'jetzt + 3 Tage')).toBe(false);
    expect(r('beginn', 'before', 'jetzt + 5 tage')).toBe(true);
    expect(r('alarmzeit', 'after', 'jetzt - 1 h')).toBe(true);
    expect(r('alarmzeit', 'after', '-20 min')).toBe(false);
    expect(r('alarmzeit', 'after', 'heute')).toBe(true);
    expect(r('alarmzeit', 'before', 'morgen')).toBe(true);
    expect(r('alarmzeit', 'after', 'gestern')).toBe(true);
    // Kein Zeitpunkt → trifft nicht zu (wie Zahlenvergleiche mit Text)
    expect(r('text', 'before', 'morgen')).toBe(false);
    expect(r('leer', 'after', 'gestern')).toBe(false);
    expect(r('beginn', 'before', '31.04.2027')).toBe(false);
    expect(parseWhen('31.04.2027', { relative: true })).toBeNull();
    expect(parseWhen('heute', { ...tz, relative: true })).toBe(Date.parse('2026-11-16T23:00:00.000Z'));
    expect(parseWhen('jetzt + 1 Tag', { timeZone: 'Europe/Berlin', now: Date.parse('2026-10-24T22:30:00.000Z'), relative: true })).toBe(Date.parse('2026-10-25T23:30:00.000Z'));
    // Feldwerte als Text eines Zeitpunkts (z. B. aus „Felder setzen“) werden ebenfalls gelesen
    expect(evaluateRule({ field: 'x', op: 'before', value: '22.11.2026' }, { x: '21.11.2026, 10:00' }, tz)).toBe(true);
    // Textvergleiche sehen Datumsfelder in der Zeitzone der Instanz
    expect(evaluateRule({ field: 'beginn', op: 'starts_with', value: '21.11.2026, 04:00' }, t, { timeZone: 'America/New_York' })).toBe(true);
  });
  it('liegt vor/nach: Prüfung des Ablaufs verlangt einen Zeitpunkt als Wert', () => {
    const g = base();
    const cond = g.nodes.find((n) => n.type === 'condition');
    if (!cond) return;
    cond.data = { combinator: 'and', rules: [{ field: 'alarmzeit', op: 'after', value: 'übermorgen' }] };
    expect(validateGraph(g, ctx).errors.map((e) => e.message).join(' ')).toMatch(/kein Zeitpunkt/);
    cond.data = { combinator: 'and', rules: [{ field: 'alarmzeit', op: 'after', value: 'jetzt - 2 h' }] };
    expect(validateGraph(g, ctx).errors.map((e) => e.message).join(' ')).not.toMatch(/kein Zeitpunkt/);
  });
  it('UND/ODER mit einer Ebene Untergruppen', () => {
    const g = { combinator: 'and' as const, rules: [{ field: 'stichwort', op: 'starts_with' as const, value: 'B' }, { combinator: 'or' as const, rules: [{ field: 'stufe', op: 'gte' as const, value: '4' }, { field: 'liste', op: 'eq' as const, value: 'x' }] }] };
    expect(evaluateGroup(g, d)).toBe(true);
    expect(evaluateGroup({ ...g, rules: [g.rules[0], { combinator: 'or', rules: [{ field: 'stufe', op: 'gte', value: '4' }] }] }, d)).toBe(false);
    expect(evaluateGroup({ combinator: 'or', rules: [] }, d)).toBe(true);
  });
});

describe('Automationen: Entprellen, Zeitplan, Protokoll', () => {
  it('Schlüssel hängt an Automation, Knoten und Feldwerten (ohne Groß-/Kleinschreibung)', () => {
    const a = dedupKey('A', 'n1', ['ort', 'stichwort'], { ort: 'Nord ', stichwort: 'B2' });
    expect(dedupKey('A', 'n1', ['ort', 'stichwort'], { ort: 'nord', stichwort: 'b2' })).toBe(a);
    expect(dedupKey('A', 'n2', ['ort', 'stichwort'], { ort: 'nord', stichwort: 'b2' })).not.toBe(a);
    expect(dedupKey('A', 'n1', ['ort', 'stichwort'], { ort: 'Süd', stichwort: 'B2' })).not.toBe(a);
  });
  it('täglich um 7 Uhr Ortszeit (Sommer- und Winterzeit), Wochentage, Intervall mit Mindestabstand', () => {
    const winter = Date.parse('2026-01-15T06:30:00Z'); // 07:30 MEZ, Donnerstag
    expect(lastDueSlot({ mode: 'daily', time: '07:00' }, winter)?.toISOString()).toBe('2026-01-15T06:00:00.000Z');
    const summer = Date.parse('2026-07-15T05:30:00Z'); // 07:30 MESZ
    expect(lastDueSlot({ mode: 'daily', time: '07:00' }, summer)?.toISOString()).toBe('2026-07-15T05:00:00.000Z');
    expect(lastDueSlot({ mode: 'daily', time: '07:00' }, Date.parse('2026-01-15T05:30:00Z'))?.toISOString()).toBe('2026-01-14T06:00:00.000Z');
    // nur montags (1): letzter Montag vor Donnerstag, 15.01.2026, ist der 12.01.
    expect(lastDueSlot({ mode: 'daily', time: '07:00', weekdays: [1] }, winter)?.toISOString()).toBe('2026-01-12T06:00:00.000Z');
    expect(lastDueSlot({ mode: 'interval', minutes: 30 }, Date.parse('2026-01-15T06:44:00Z'))?.toISOString()).toBe('2026-01-15T06:30:00.000Z');
    expect(lastDueSlot({ mode: 'interval', minutes: 1 }, Date.parse('2026-01-15T06:44:00Z'))?.toISOString()).toBe('2026-01-15T06:30:00.000Z');
    expect(INPUT_CONFIG.schedule.safeParse({ mode: 'interval', minutes: 5 }).success).toBe(false);
    expect(INPUT_CONFIG.schedule.safeParse({ mode: 'daily', time: '25:00' }).success).toBe(false);
  });
  it('Protokoll kürzt E-Mail-Adressen und blendet Geheimnisse aus', () => {
    expect(redactForLog({ empfaenger: ['max.mustermann@example.org'], token: 'abc', text: 'x'.repeat(600) })).toEqual({ empfaenger: ['m…@example.org'], token: '***', text: 'x'.repeat(500) });
  });
});

describe('Automationen: Prüfung des Ablaufs', () => {
  it('ein gültiger Ablauf mit Feldern je Knoten', () => {
    const v = validateGraph(base(), ctx);
    expect(v.errors).toEqual([]);
    expect(v.order).toEqual(['in', 'if', 'out']);
    expect(v.fields.out).toContain('stichwort');
    expect(outputNeeds(outputs.get(OUT)!)).toEqual(['stichwort', 'ort', 'stichwort_text']);
  });
  it('erkennt Kreise, fehlende Anschlüsse, unbekannte Ports und Selbstbezüge', () => {
    const g = base();
    g.edges.push(edge('e3', 'out', 'if'));
    expect(topoOrder(g)).toBeNull();
    expect(validateGraph(g, ctx).errors.map((e) => e.message).join(' ')).toMatch(/Kreis/);
    const h = base();
    h.edges = [edge('e1', 'in', 'if')];
    const v = validateGraph(h, ctx);
    expect(v.errors.some((e) => e.nodeId === 'out' && /nicht angeschlossen/.test(e.message))).toBe(true);
    expect(v.errors.some((e) => e.nodeId === 'if' && /keinen ausgehenden/.test(e.message))).toBe(true);
    const k = base();
    k.edges[1].sourceHandle = 'vielleicht';
    expect(validateGraph(k, ctx).errors.some((e) => /unbekannter Ausgang/.test(e.message))).toBe(true);
    const s = base();
    s.edges.push(edge('e9', 'if', 'if', 'false'));
    expect(validateGraph(s, ctx).errors.some((e) => /sich selbst/.test(e.message))).toBe(true);
  });
  it('Platzhalter und Bedingungsfelder müssen an dieser Stelle verfügbar sein; Felder setzen ergänzt sie', () => {
    const g = base();
    g.nodes[1].data.rules[0].field = 'gibtsnicht';
    expect(validateGraph(g, ctx).errors.some((e) => e.nodeId === 'if' && /„gibtsnicht“/.test(e.message))).toBe(true);
    const out2: OutputRef = { id: OUT, name: 'Entwurf', kind: 'post', config: { title: '{{titel_neu}}', body: '' } };
    const c2 = { inputs, outputs: new Map([[OUT, out2]]) };
    expect(validateGraph(base(), c2).errors.some((e) => /„titel_neu“/.test(e.message))).toBe(true);
    const g2 = base();
    g2.nodes.splice(2, 0, node('tpl', 'template', { fields: [{ key: 'titel_neu', template: '{{stichwort}} – {{ort}}' }] }, 0, 150));
    g2.edges = [edge('e1', 'in', 'if'), edge('e2', 'if', 'tpl', 'true'), edge('e3', 'tpl', 'out')];
    expect(validateGraph(g2, c2).errors).toEqual([]);
  });
  it('Zusammenführen: nur Felder, die auf allen Wegen vorhanden sind', () => {
    const g = base();
    g.nodes.push(node('t1', 'template', { fields: [{ key: 'nur_hier', template: 'x' }] }, 100, 150), node('m', 'merge', {}, 0, 180));
    g.nodes[2] = node('out', 'output', { outputId: OUT }, 0, 300);
    g.edges = [edge('e1', 'in', 'if'), edge('e2', 'if', 't1', 'true'), edge('e3', 'if', 'm', 'false'), edge('e4', 't1', 'm'), edge('e5', 'm', 'out')];
    const v = validateGraph(g, ctx);
    expect(v.errors).toEqual([]);
    expect(v.fields.m).not.toContain('nur_hier');
  });
  it('Grenzen und Einstellungen je Knoten (Warten höchstens 24 h, Direktversand nur bei geeigneten Ausgängen)', () => {
    const g = base();
    g.nodes.splice(1, 0, node('w', 'delay', { minutes: 24 * 60 + 1 }));
    g.edges = [edge('e1', 'in', 'w'), edge('e0', 'w', 'if'), edge('e2', 'if', 'out', 'true')];
    expect(validateGraph(g, ctx).errors.some((e) => e.nodeId === 'w')).toBe(true);
    const tooMany = { nodes: Array.from({ length: 61 }, (_, i) => node(`n${i}`, 'merge', {})), edges: [] };
    expect(graphSchema.safeParse(tooMany).success).toBe(false);
    const notifyOut: OutputRef = { id: OUT, name: 'App', kind: 'notify', config: { roles: ['editor'], title: 'x' } };
    const d = base();
    d.nodes[2].data.direct = true;
    expect(validateGraph(d, { inputs, outputs: new Map([[OUT, notifyOut]]) }).errors.some((e) => /Direktversand/.test(e.message))).toBe(true);
    expect(validateGraph(d, ctx).directNodes).toEqual(['out']);
  });
  it('Prüfsumme ohne Positionen, aber mit den Einstellungen der Ein- und Ausgänge', () => {
    const g = base();
    const moved = base();
    moved.nodes[0].position = { x: 500, y: 500 };
    expect(graphHash(moved)).toBe(graphHash(g));
    const s1 = snapshotHash(buildSnapshot(g, ctx));
    const changed = new Map([[OUT, { ...outputs.get(OUT)!, config: { ...outputs.get(OUT)!.config, title: 'Anders {{ort}}' } }]]);
    expect(snapshotHash(buildSnapshot(g, { inputs, outputs: changed }))).not.toBe(s1);
    expect(snapshotHash(buildSnapshot(moved, ctx))).toBe(s1);
  });
  it('Eingangsfelder: FE2 nur aus der Allowlist; Einstellungen der Ausgänge werden geprüft', () => {
    const keys = inputFields({ kind: 'fe2', config: {} }).map((f) => f.key);
    expect(keys).toContain('stichwort');
    expect(keys.some((k) => /strasse|adresse|melder|patient|name/.test(k))).toBe(false);
    expect(OUTPUT_CONFIG.mail.safeParse({ subject: 'Hallo', body: 'x' }).success).toBe(false);
    expect(OUTPUT_CONFIG.banner.safeParse({ siteIds: [], title: 'x' }).success).toBe(false);
    expect(OUTPUT_CONFIG.notify.safeParse({ roles: ['gibtsnicht'], title: 'Hallo' }).success).toBe(false);
  });
  it('Rechte: Administration alles, Redaktion und Freigabe nur lesen, Direktversand nur Administration', () => {
    expect(permissionsFor(['platform_admin']).has('automation.publish')).toBe(true);
    expect(permissionsFor(['editor']).has('automation.read')).toBe(true);
    expect(permissionsFor(['editor', 'approver', 'publisher', 'media_manager']).has('automation.manage')).toBe(false);
    expect(permissionsFor(['editor', 'approver', 'publisher', 'warning_approver']).has('automation.publish')).toBe(false);
  });
});
