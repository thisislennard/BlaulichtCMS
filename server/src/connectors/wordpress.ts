import crypto from 'node:crypto';
import { classifyStatus, httpRequest } from '../lib/http.js';
import { hmacHex, sha256Hex } from '../lib/crypto.js';
import { StepError } from '../lib/errors.js';
import { checkTemplate } from '../lib/template.js';
import type { Connector, NodeType, RuntimeConnection, TestStep } from '../engine/types.js';

/** Vertrag: docs/wordpress-schnittstelle.md */
export const BANNER_COLORS = [
  { value: 'rot', label: 'Rot', hex: '#DC2626' },
  { value: 'orange', label: 'Orange', hex: '#C2410C' },
  { value: 'gelb', label: 'Gelb', hex: '#A16207' },
  { value: 'blau', label: 'Blau', hex: '#2563EB' },
  { value: 'gruen', label: 'Grün', hex: '#047857' },
  { value: 'neutral', label: 'Neutral', hex: '#475569' },
];

export function canonicalString(method: string, route: string, timestamp: number, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${route}\n${timestamp}\n${nonce}\n${sha256Hex(body)}`;
}

export function signWordPress(secret: string, method: string, route: string, timestamp: number, nonce: string, body: string): string {
  return 'v1=' + hmacHex(secret, canonicalString(method, route, timestamp, nonce, body));
}

export async function wpRequest(conn: RuntimeConnection, method: string, route: string, payload?: unknown, timeoutMs = 20_000) {
  const site = String(conn.config.siteUrl ?? '').replace(/\/+$/, '');
  if (!site) throw new StepError('config', 'In der WordPress-Verbindung fehlt die Website-Adresse.');
  if (!conn.secrets.secret || !conn.config.keyId) throw new StepError('config', 'In der WordPress-Verbindung fehlen Schlüssel-ID oder Geheimnis.');
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const fullRoute = `/lifelink/v1${route}`;
  const res = await httpRequest({
    method,
    url: `${site}/wp-json${fullRoute}`,
    headers: {
      'content-type': 'application/json',
      'x-lifelink-key': conn.config.keyId,
      'x-lifelink-timestamp': String(ts),
      'x-lifelink-nonce': nonce,
      'x-lifelink-signature': signWordPress(conn.secrets.secret, method, fullRoute, ts, nonce, body),
    },
    body: body || undefined,
    timeoutMs,
    allowPrivateHosts: conn.config.allowPrivate ? [new URL(site).hostname] : [],
  });
  if (res.status === 404 && /rest_no_route/.test(res.text())) {
    throw new StepError('config', 'Das LifeLink-Plugin ist auf der Website nicht aktiv (Route nicht gefunden).', { hint: 'Plugin in WordPress installieren und aktivieren.' });
  }
  const err = classifyStatus(res, 'WordPress');
  if (err) {
    try {
      const j = res.json() as { message?: string };
      if (j?.message) err.message = `WordPress: ${j.message}`;
    } catch {
      /* Rohtext bleibt technisch */
    }
    throw err;
  }
  return res.json() as any;
}

export const wordpressConnector: Connector = {
  id: 'wordpress',
  name: 'WordPress',
  kind: 'Website · LifeLink-Plugin',
  group: 'Website',
  description: 'Banner und Beitragsentwürfe auf der Vereins- oder Wehr-Website – über das LifeLink-Plugin mit signierten Anfragen.',
  monogram: 'W',
  color: '#21759B',
  needsConnection: true,
  setupMinutes: 3,
  fields: [
    { key: 'siteUrl', type: 'url', label: 'Website-Adresse', required: true, placeholder: 'https://www.feuerwehr-musterstadt.de' },
    { key: 'keyId', type: 'text', label: 'Schlüssel-ID', required: true, placeholder: 'll_…', help: 'Aus WordPress → Einstellungen → LifeLink → „Schlüssel erzeugen“.' },
    { key: 'allowPrivate', type: 'switch', label: 'Interne Ziele erlauben', default: false, advanced: true, help: 'Nur für Websites im eigenen Netz.' },
  ],
  secretFields: [{ key: 'secret', type: 'secret', label: 'Geheimnis', help: 'Wird in WordPress nur einmal angezeigt.' }],
  securityNotes: [
    'Jede Anfrage ist mit HMAC-SHA256, Zeitstempel und Einmalwert signiert – abgefangene Anfragen sind nicht wiederverwendbar.',
    'Der Schlüssel kann in WordPress jederzeit rotiert oder widerrufen werden.',
    'Das Plugin darf nur Banner verwalten und Beitragsentwürfe anlegen – keine Veröffentlichung ohne WordPress-Freigabe.',
  ],
  testInfo: ['Website erreichen', 'Plugin-Version und Signatur prüfen', 'Zielseiten abrufen'],
  async test(conn) {
    const steps: TestStep[] = [];
    let t = Date.now();
    try {
      const st = await wpRequest(conn, 'GET', '/status', undefined, 10_000);
      steps.push({ label: 'Plugin erreichbar und Signatur gültig', ok: true, ms: Date.now() - t, message: `${st.site_name} · Plugin ${st.plugin_version}` });
      t = Date.now();
      const pages = await wpRequest(conn, 'GET', '/pages', undefined, 10_000);
      steps.push({ label: 'Zielseiten abrufen', ok: true, ms: Date.now() - t, message: `${pages.pages?.length ?? 0} Seiten` });
    } catch (e) {
      steps.push({ label: steps.length ? 'Zielseiten abrufen' : 'Plugin erreichbar und Signatur gültig', ok: false, ms: Date.now() - t, message: (e as Error).message });
    }
    return steps;
  },
  help: 'Das Plugin gibt es in LifeLink unter WordPress → „Plugin & Darstellung“ zum Download.',
};

const bannerFields = [
  { key: 'bannerKey', type: 'variableText' as const, label: 'Banner-Schlüssel', default: '{{ trigger.einsatz_id }}', help: 'Gleicher Schlüssel = gleiches Banner wird aktualisiert statt doppelt angelegt (z. B. Einsatznummer).' },
  { key: 'title', type: 'variableText' as const, label: 'Titel', required: true },
  { key: 'text', type: 'variableTextarea' as const, label: 'Text' },
  { key: 'label', type: 'variableText' as const, label: 'Kennzeichnung', placeholder: 'Einsatz', help: 'Kurzer sichtbarer Text vor dem Titel, max. 30 Zeichen.' },
  { key: 'color', type: 'color' as const, label: 'Farbe', default: 'rot', options: BANNER_COLORS.map((c) => ({ value: c.value, label: c.label, hint: c.hex })) },
  { key: 'priority', type: 'select' as const, label: 'Priorität', default: 'normal', options: [{ value: 'niedrig', label: 'Niedrig' }, { value: 'normal', label: 'Normal' }, { value: 'hoch', label: 'Hoch' }] },
  { key: 'durationMinutes', type: 'duration' as const, label: 'Anzeigedauer', default: 60, unit: 'minutes' as const, help: '0 = ohne Ende (manuell deaktivieren).' },
  { key: 'pages', type: 'wpPages' as const, label: 'Zielseiten', default: ['front'] },
  { key: 'linkUrl', type: 'variableText' as const, label: 'Link', advanced: true },
  { key: 'linkText', type: 'text' as const, label: 'Linktext', advanced: true },
  { key: 'requireApproval', type: 'switch' as const, label: 'Vor Veröffentlichung freigeben lassen', default: false, help: 'Banner wird nur als Entwurf in LifeLink angelegt; ein Redakteur veröffentlicht es.' },
];

export const wpBannerNode: NodeType = {
  type: 'wordpress.banner',
  category: 'action',
  title: 'WordPress-Banner',
  description: 'Zeigt ein farbiges, zeitlich begrenztes Banner auf der Website an oder aktualisiert es.',
  icon: 'Megaphone',
  connector: 'wordpress',
  sideEffect: true,
  idempotent: true,
  targetFields: ['pages'],
  fields: bannerFields,
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'banner_id', type: 'text', description: 'Banner-ID in LifeLink' },
    { path: 'state', type: 'text', description: 'veroeffentlicht oder entwurf' },
    { path: 'ends_at', type: 'date', description: 'Ende der Anzeige' },
  ],
  sampleOutput: { banner_id: '9b2f…', state: 'veroeffentlicht', ends_at: '2026-10-29T17:08:00.000Z' },
  validate(c) {
    const out: string[] = [];
    if (!c.title?.trim()) out.push('Titel angeben.');
    for (const k of ['title', 'text', 'label', 'bannerKey', 'linkUrl']) {
      const p = c[k] ? checkTemplate(c[k]) : null;
      if (p) out.push(p);
    }
    if (!(c.pages ?? []).length) out.push('Mindestens eine Zielseite wählen.');
    return out;
  },
  // Ausführung übernimmt content/banners.ts (Datensatz in LifeLink + Synchronisation)
  async execute() {
    throw new Error('wird in nodes/registry.ts verdrahtet');
  },
};

export const wpBannerEndNode: NodeType = {
  type: 'wordpress.banner_end',
  category: 'action',
  title: 'Banner beenden',
  description: 'Deaktiviert ein zuvor angelegtes Banner sofort (gleicher Banner-Schlüssel).',
  icon: 'MegaphoneOff',
  connector: 'wordpress',
  sideEffect: true,
  idempotent: true,
  fields: [{ key: 'bannerKey', type: 'variableText', label: 'Banner-Schlüssel', required: true, default: '{{ trigger.einsatz_id }}' }],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [{ path: 'deactivated', type: 'boolean', description: 'Wurde ein Banner beendet?' }],
  async execute() {
    throw new Error('wird in nodes/registry.ts verdrahtet');
  },
};

export const wpPostNode: NodeType = {
  type: 'wordpress.post',
  category: 'action',
  title: 'WordPress-Beitrag',
  description: 'Legt einen Beitragsentwurf an oder reicht ihn zur Freigabe in WordPress ein.',
  icon: 'Newspaper',
  connector: 'wordpress',
  sideEffect: true,
  idempotent: true,
  fields: [
    { key: 'postKey', type: 'variableText', label: 'Beitrags-Schlüssel', default: '{{ trigger.einsatz_id }}', help: 'Gleicher Schlüssel aktualisiert denselben Entwurf.' },
    { key: 'title', type: 'variableText', label: 'Titel', required: true },
    { key: 'content', type: 'variableTextarea', label: 'Inhalt', required: true, help: 'Absätze werden automatisch erzeugt. Variablen werden HTML-maskiert.' },
    { key: 'category', type: 'text', label: 'Kategorie', placeholder: 'Einsätze' },
    { key: 'tags', type: 'list', label: 'Schlagwörter', advanced: true },
    {
      key: 'status',
      type: 'select',
      label: 'In WordPress',
      default: 'draft',
      options: [
        { value: 'draft', label: 'Als Entwurf anlegen' },
        { value: 'pending', label: 'Zur Freigabe einreichen' },
        { value: 'future', label: 'Geplant veröffentlichen (wenn im Plugin erlaubt)' },
      ],
    },
    { key: 'publishDelayMinutes', type: 'duration', label: 'Veröffentlichen nach', unit: 'minutes', default: 60, showIf: { key: 'status', equals: 'future' } },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'post_id', type: 'number', description: 'WordPress-Beitrags-ID' },
    { path: 'status', type: 'text', description: 'Status in WordPress' },
    { path: 'edit_url', type: 'text', description: 'Link zum Bearbeiten' },
  ],
  validate(c) {
    const out: string[] = [];
    if (!c.title?.trim()) out.push('Titel angeben.');
    if (!c.content?.trim()) out.push('Inhalt angeben.');
    return out;
  },
  async execute() {
    throw new Error('wird in nodes/registry.ts verdrahtet');
  },
};
