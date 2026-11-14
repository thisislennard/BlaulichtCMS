import { CORE_NODES } from './core.js';
import { httpConnector, httpRequestNode, webhookConnector } from '../connectors/http.js';
import { imapConnector, imapTrigger, sendMailNode, smtpConnector } from '../connectors/email.js';
import { m365Connector, m365MailNode, mqttConnector, mqttPublishNode, mqttTrigger, teamsConnector, teamsMessageNode } from '../connectors/messaging.js';
import { alamosAlarmTrigger, alamosCalendarTrigger, alamosConnector } from '../connectors/alamos.js';
import { BANNER_COLORS, wordpressConnector, wpBannerEndNode, wpBannerNode, wpPostNode } from '../connectors/wordpress.js';
import { endWorkflowBanner, upsertWorkflowBanner, upsertWorkflowPost } from '../content/banners.js';
import { sha256Hex } from '../lib/crypto.js';
import { StepError } from '../lib/errors.js';
import { CATEGORY_LABELS, type Connector, type ExecContext, type NodeType, type PortDef } from '../engine/types.js';
import { FILTER_DOCS, OPERATORS } from '../lib/template.js';

/* WordPress-Nodes arbeiten über die Banner-/Beitragsdatensätze in LifeLink. */
function sourceKey(ctx: ExecContext, tpl: string | undefined): string {
  const key = ctx.render(tpl).trim() || `lauf-${ctx.run.id}`;
  return sha256Hex(`${ctx.run.workflowId}:${key}`).slice(0, 40);
}

function requireConn(ctx: ExecContext) {
  if (!ctx.connection) throw new StepError('config', 'Keine WordPress-Verbindung gewählt.');
  return ctx.connection;
}

wpBannerNode.execute = async (ctx) => {
  const c = ctx.node.config;
  const conn = requireConn(ctx);
  const color = BANNER_COLORS.some((x) => x.value === c.color) ? c.color : 'neutral';
  const res = await upsertWorkflowBanner({
    connectionId: conn.id,
    sourceKey: sourceKey(ctx, c.bannerKey),
    runId: ctx.run.id,
    workflowName: ctx.run.workflowName,
    title: ctx.render(c.title).slice(0, 120),
    text: ctx.render(c.text).slice(0, 600),
    label: ctx.render(c.label).slice(0, 30),
    color,
    priority: ['niedrig', 'normal', 'hoch'].includes(c.priority) ? c.priority : 'normal',
    durationMinutes: Math.max(0, Number(c.durationMinutes ?? 60)),
    pages: (c.pages ?? ['front']).map(String),
    linkUrl: ctx.render(c.linkUrl).trim() || null,
    linkText: c.linkText || null,
    requireApproval: !!c.requireApproval,
  });
  return { output: res, externalRef: res.banner_id, statusText: res.state === 'entwurf' ? 'Entwurf – wartet auf Freigabe' : 'Banner veröffentlicht' };
};
wpBannerNode.simulate = async (ctx) => ({
  output: { simuliert: true, titel: ctx.render(ctx.node.config.title), text: ctx.render(ctx.node.config.text), farbe: ctx.node.config.color, seiten: ctx.node.config.pages },
  statusText: 'Simuliert: Banner',
});

wpBannerEndNode.execute = async (ctx) => {
  const conn = requireConn(ctx);
  const res = await endWorkflowBanner(conn.id, sourceKey(ctx, ctx.node.config.bannerKey));
  return { output: res, statusText: res.deactivated ? 'Banner beendet' : 'Kein aktives Banner' };
};
wpBannerEndNode.simulate = async () => ({ output: { simuliert: true }, statusText: 'Simuliert: Banner beenden' });

wpPostNode.execute = async (ctx) => {
  const c = ctx.node.config;
  const conn = requireConn(ctx);
  const status = (['draft', 'pending', 'future'].includes(c.status) ? c.status : 'draft') as 'draft' | 'pending' | 'future';
  const res = await upsertWorkflowPost({
    connectionId: conn.id,
    sourceKey: sourceKey(ctx, c.postKey),
    runId: ctx.run.id,
    workflowName: ctx.run.workflowName,
    title: ctx.render(c.title).slice(0, 200),
    content: ctx.render(c.content, 'html'),
    category: c.category ?? '',
    tags: (c.tags ?? []).filter(Boolean),
    status,
    publishAt: status === 'future' ? new Date(Date.now() + Math.max(1, Number(c.publishDelayMinutes ?? 60)) * 60_000) : null,
  });
  return { output: res, externalRef: res.post_id ? String(res.post_id) : undefined, statusText: `Beitrag: ${res.status}` };
};
wpPostNode.simulate = async (ctx) => ({ output: { simuliert: true, titel: ctx.render(ctx.node.config.title) }, statusText: 'Simuliert: Beitrag' });

export const NODE_TYPES: NodeType[] = [
  ...CORE_NODES.filter((n) => n.category === 'trigger'),
  alamosAlarmTrigger,
  alamosCalendarTrigger,
  mqttTrigger,
  imapTrigger,
  ...CORE_NODES.filter((n) => n.category !== 'trigger'),
  httpRequestNode,
  sendMailNode,
  m365MailNode,
  teamsMessageNode,
  mqttPublishNode,
  wpBannerNode,
  wpBannerEndNode,
  wpPostNode,
];

export const CONNECTORS: Connector[] = [alamosConnector, wordpressConnector, smtpConnector, imapConnector, m365Connector, teamsConnector, mqttConnector, httpConnector, webhookConnector];

const byType = new Map(NODE_TYPES.map((n) => [n.type, n]));
const byConnector = new Map(CONNECTORS.map((c) => [c.id, c]));

export function nodeType(type: string): NodeType | undefined {
  return byType.get(type);
}

export function connector(id: string): Connector | undefined {
  return byConnector.get(id);
}

export function outputsOf(t: NodeType, config: Record<string, any>): PortDef[] {
  return typeof t.outputs === 'function' ? t.outputs(config ?? {}) : t.outputs;
}

export function isIdempotent(t: NodeType, config: Record<string, any>): boolean {
  if (!t.sideEffect) return true;
  return typeof t.idempotent === 'function' ? t.idempotent(config ?? {}) : !!t.idempotent;
}

/** Katalog für die Oberfläche (ohne Funktionen). */
export function catalog() {
  return {
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
    nodes: NODE_TYPES.map((n) => ({
      type: n.type,
      category: n.category,
      title: n.title,
      description: n.description,
      icon: n.icon,
      connector: n.connector ?? null,
      connectionOptional: !!n.connectionOptional,
      fields: n.fields,
      outputs: typeof n.outputs === 'function' ? null : n.outputs,
      dynamicOutputs: typeof n.outputs === 'function',
      outputFields: n.outputFields ?? [],
      sampleOutput: n.sampleOutput ?? null,
      sideEffect: !!n.sideEffect,
      idempotent: typeof n.idempotent === 'function' ? null : !!n.idempotent || !n.sideEffect,
      trigger: n.trigger ?? null,
      help: n.help ?? null,
    })),
    connectors: CONNECTORS.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      group: c.group,
      description: c.description,
      monogram: c.monogram,
      color: c.color,
      fields: c.fields,
      secretFields: c.secretFields,
      needsConnection: c.needsConnection,
      setupMinutes: c.setupMinutes,
      securityNotes: c.securityNotes,
      testInfo: c.testInfo,
      testable: !!c.test,
      help: c.help ?? null,
      nodes: NODE_TYPES.filter((n) => n.connector === c.id || (c.id === 'alamos' && n.type === 'alamos.alarm') || (c.id === 'webhook' && n.type === 'trigger.webhook')).map((n) => n.type),
    })),
    operators: OPERATORS,
    filters: FILTER_DOCS,
    bannerColors: BANNER_COLORS,
  };
}
