import { classifyStatus, httpRequest, type HttpRequest } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { checkTemplate } from '../lib/template.js';
import type { Connector, ExecContext, NodeType, RuntimeConnection } from '../engine/types.js';

const SAFE_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
/** Diese Header darf ein Workflow nicht selbst setzen (Zugangsdaten gehören in die Verbindung). */
const FORBIDDEN_HEADERS = /^(host|content-length|transfer-encoding|connection|authorization|cookie|proxy-.*)$/i;

export const httpConnector: Connector = {
  id: 'http',
  name: 'REST-API',
  kind: 'Allgemein · HTTP/REST',
  group: 'Allgemein',
  description: 'Beliebige Web-Schnittstellen per HTTP aufrufen – mit hinterlegter Anmeldung, Host-Freigabe und SSRF-Schutz.',
  monogram: 'API',
  color: '#0E7490',
  needsConnection: false,
  setupMinutes: 2,
  fields: [
    { key: 'baseUrl', type: 'url', label: 'Basis-Adresse', placeholder: 'https://api.beispiel.de/v1', required: true, help: 'Nodes können relative Pfade verwenden.' },
    {
      key: 'authType',
      type: 'select',
      label: 'Anmeldung',
      default: 'none',
      options: [
        { value: 'none', label: 'Keine' },
        { value: 'bearer', label: 'Bearer-Token' },
        { value: 'basic', label: 'Benutzername + Passwort (Basic)' },
        { value: 'header', label: 'API-Schlüssel im Header' },
      ],
    },
    { key: 'headerName', type: 'text', label: 'Header-Name', default: 'X-API-Key', showIf: { key: 'authType', equals: 'header' } },
    { key: 'username', type: 'text', label: 'Benutzername', showIf: { key: 'authType', equals: 'basic' } },
    { key: 'allowedHosts', type: 'list', label: 'Erlaubte Hosts', advanced: true, help: 'Leer = nur der Host der Basis-Adresse. Platzhalter: *.beispiel.de' },
    { key: 'allowPrivate', type: 'switch', label: 'Interne Ziele erlauben', default: false, advanced: true, help: 'Nur aktivieren, wenn das Ziel bewusst im internen Netz liegt (z. B. 192.168.x.x).' },
    { key: 'timeoutSec', type: 'number', label: 'Zeitlimit (Sekunden)', default: 30, min: 1, max: 300, advanced: true },
  ],
  secretFields: [
    { key: 'token', type: 'secret', label: 'Token', showIf: { key: 'authType', equals: 'bearer' } },
    { key: 'password', type: 'secret', label: 'Passwort', showIf: { key: 'authType', equals: 'basic' } },
    { key: 'headerValue', type: 'secret', label: 'API-Schlüssel', showIf: { key: 'authType', equals: 'header' } },
  ],
  securityNotes: [
    'Zugangsdaten werden mit AES-256-GCM verschlüsselt gespeichert und nie wieder angezeigt.',
    'Anfragen an interne Netze (Loopback, privat, link-local) sind gesperrt, solange sie nicht ausdrücklich erlaubt sind.',
    'Nur die freigegebenen Hosts können aufgerufen werden; Weiterleitungen werden erneut geprüft.',
  ],
  testInfo: ['Basis-Adresse auflösen und Netzbereich prüfen', 'Verbindung aufbauen (GET auf die Basis-Adresse)', 'Anmeldung prüfen (Status ≠ 401/403)'],
  async test(conn) {
    const steps = [];
    const t0 = Date.now();
    try {
      const res = await httpRequest({ ...requestBase(conn), method: 'GET', url: conn.config.baseUrl, timeoutMs: 10_000 });
      steps.push({ label: 'Adresse erreichbar', ok: true, ms: Date.now() - t0, message: `HTTP ${res.status}` });
      const authOk = res.status !== 401 && res.status !== 403;
      steps.push({ label: 'Anmeldung', ok: authOk, ms: 0, message: authOk ? 'Akzeptiert' : `Abgelehnt (HTTP ${res.status})` });
    } catch (e) {
      steps.push({ label: 'Adresse erreichbar', ok: false, ms: Date.now() - t0, message: (e as Error).message });
    }
    return steps;
  },
  help: 'Für Systeme ohne eigenen Konnektor. Eine Verbindung bündelt Basis-Adresse, Anmeldung und freigegebene Hosts; im Workflow wählt der Node „HTTP-Anfrage“ nur noch Methode, Pfad und Daten.',
};

function requestBase(conn: RuntimeConnection | null): Pick<HttpRequest, 'headers' | 'allowPrivateHosts' | 'allowedHosts' | 'timeoutMs'> {
  const headers: Record<string, string> = {};
  if (!conn) return { headers };
  const c = conn.config;
  if (c.authType === 'bearer' && conn.secrets.token) headers.authorization = `Bearer ${conn.secrets.token}`;
  if (c.authType === 'basic') headers.authorization = 'Basic ' + Buffer.from(`${c.username ?? ''}:${conn.secrets.password ?? ''}`).toString('base64');
  if (c.authType === 'header' && c.headerName && conn.secrets.headerValue) headers[String(c.headerName).toLowerCase()] = conn.secrets.headerValue;
  const baseHost = c.baseUrl ? new URL(c.baseUrl).hostname : '';
  const allowed = (c.allowedHosts ?? []).filter(Boolean);
  return {
    headers,
    allowedHosts: allowed.length ? [...allowed, baseHost] : baseHost ? [baseHost] : [],
    allowPrivateHosts: c.allowPrivate ? (allowed.length ? [...allowed, baseHost] : [baseHost]) : [],
    timeoutMs: (Number(c.timeoutSec) || 30) * 1000,
  };
}

function buildRequest(ctx: ExecContext): HttpRequest {
  const cfg = ctx.node.config;
  const method = String(cfg.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) throw new StepError('config', `Methode ${method} ist nicht erlaubt.`);
  const base = requestBase(ctx.connection);
  const rawUrl = ctx.render(cfg.url, 'none').trim();
  let url: URL;
  try {
    url = ctx.connection?.config.baseUrl && !/^https?:\/\//i.test(rawUrl) ? new URL(rawUrl.replace(/^\//, ''), ctx.connection.config.baseUrl.replace(/\/?$/, '/')) : new URL(rawUrl);
  } catch {
    throw new StepError('config', `Ungültige Adresse: „${rawUrl}“.`);
  }
  for (const q of cfg.query ?? []) if (q.key) url.searchParams.set(q.key, ctx.render(q.value));
  const headers: Record<string, string> = { ...base.headers };
  for (const h of cfg.headers ?? []) {
    if (!h.key) continue;
    if (FORBIDDEN_HEADERS.test(h.key)) throw new StepError('config', `Header „${h.key}“ darf nicht im Workflow gesetzt werden – Zugangsdaten gehören in die Verbindung.`);
    headers[h.key.toLowerCase()] = ctx.render(h.value);
  }
  let body: string | undefined;
  const bodyType = cfg.bodyType ?? 'none';
  if (method !== 'GET' && method !== 'HEAD' && bodyType !== 'none') {
    if (bodyType === 'json') {
      const text = ctx.render(cfg.body, 'json');
      try {
        JSON.parse(text);
      } catch (e) {
        throw new StepError('config', 'Der JSON-Inhalt ist nach dem Einsetzen der Variablen ungültig.', { technical: (e as Error).message });
      }
      body = text;
      headers['content-type'] ??= 'application/json';
    } else if (bodyType === 'form') {
      const p = new URLSearchParams();
      for (const f of cfg.form ?? []) if (f.key) p.set(f.key, ctx.render(f.value));
      body = p.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else {
      body = ctx.render(cfg.body);
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    }
  }
  if (cfg.sendIdempotencyKey !== false && !SAFE_METHODS.includes(method)) headers['idempotency-key'] = ctx.idempotencyKey;
  headers['x-correlation-id'] = ctx.run.correlationId;
  return { ...base, method, url: url.toString(), headers, body, timeoutMs: Math.min(base.timeoutMs ?? 30_000, ctx.timeoutMs) };
}

export const httpRequestNode: NodeType = {
  type: 'http.request',
  category: 'action',
  title: 'HTTP-Anfrage',
  description: 'Ruft eine REST-Schnittstelle auf und liefert die Antwort weiter.',
  icon: 'Globe',
  connector: 'http',
  connectionOptional: true,
  sideEffect: true,
  idempotent: (c) => SAFE_METHODS.includes(String(c.method ?? 'GET').toUpperCase()) || c.sendIdempotencyKey !== false,
  targetFields: ['url'],
  fields: [
    { key: 'method', type: 'select', label: 'Methode', default: 'POST', options: ALLOWED_METHODS.map((m) => ({ value: m, label: m })) },
    { key: 'url', type: 'variableText', label: 'Adresse oder Pfad', required: true, placeholder: '/einsaetze oder https://…' },
    { key: 'query', type: 'keyvalue', label: 'URL-Parameter', advanced: true },
    { key: 'headers', type: 'keyvalue', label: 'Header', advanced: true, help: 'Authorization und Cookies gehören in die Verbindung.' },
    {
      key: 'bodyType',
      type: 'select',
      label: 'Inhalt',
      default: 'json',
      options: [
        { value: 'none', label: 'Kein Inhalt' },
        { value: 'json', label: 'JSON' },
        { value: 'form', label: 'Formular' },
        { value: 'text', label: 'Text' },
      ],
    },
    { key: 'body', type: 'variableTextarea', label: 'JSON', placeholder: '{ "titel": "{{ webhook.body.titel }}" }', showIf: { key: 'bodyType', equals: 'json' } },
    { key: 'body', type: 'variableTextarea', label: 'Text', showIf: { key: 'bodyType', equals: 'text' } },
    { key: 'form', type: 'keyvalue', label: 'Formularfelder', showIf: { key: 'bodyType', equals: 'form' } },
    { key: 'sendIdempotencyKey', type: 'switch', label: 'Idempotency-Key mitsenden', default: true, advanced: true, help: 'Erlaubt dem Ziel, doppelte Anfragen bei Wiederholungen zu erkennen. Ohne diesen Schlüssel wird POST/PATCH nicht automatisch wiederholt.' },
    { key: 'failOnStatus', type: 'switch', label: 'Fehler bei Status ≥ 400', default: true, advanced: true },
  ],
  outputs: [{ id: 'out', label: 'Antwort' }],
  outputFields: [
    { path: 'status', type: 'number', description: 'HTTP-Status' },
    { path: 'body', type: 'object', description: 'Antwort (JSON wenn möglich, sonst Text)' },
    { path: 'headers', type: 'object', description: 'Antwort-Header' },
  ],
  sampleOutput: { status: 201, body: { id: 'abc123' }, headers: { 'content-type': 'application/json' } },
  validate(c) {
    const out: string[] = [];
    if (!c.url?.trim()) out.push('Adresse angeben.');
    for (const k of ['url', 'body']) {
      const p = c[k] ? checkTemplate(c[k]) : null;
      if (p) out.push(p);
    }
    for (const h of c.headers ?? []) if (h.key && FORBIDDEN_HEADERS.test(h.key)) out.push(`Header „${h.key}“ ist nicht erlaubt.`);
    return out;
  },
  async execute(ctx) {
    const req = buildRequest(ctx);
    const res = await httpRequest(req);
    if (ctx.node.config.failOnStatus !== false) {
      const err = classifyStatus(res);
      if (err) throw err;
    }
    let body: unknown = res.text();
    if ((res.headers['content-type'] ?? '').includes('json')) {
      try {
        body = res.json();
      } catch {
        /* Text behalten */
      }
    }
    const keep = ['content-type', 'location', 'etag', 'x-request-id', 'request-id', 'retry-after'];
    const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => keep.includes(k)));
    return {
      output: { status: res.status, body, headers },
      externalRef: res.headers['x-request-id'] ?? res.headers['request-id'],
      statusText: `${res.status} · ${res.durationMs} ms`,
    };
  },
  async simulate(ctx) {
    const req = buildRequest(ctx);
    return {
      output: { simuliert: true, anfrage: { method: req.method, url: req.url, headers: req.headers, body: req.body } },
      statusText: `Simuliert: ${req.method} ${new URL(req.url).host}`,
    };
  },
};

export const webhookConnector: Connector = {
  id: 'webhook',
  name: 'Webhooks',
  kind: 'Allgemein · Eingang',
  group: 'Allgemein',
  description: 'Daten von beliebigen Systemen empfangen – abgesichert mit HMAC-Signatur, Zeitstempel und Duplikatschutz.',
  monogram: 'WH',
  color: '#4F46E5',
  needsConnection: false,
  setupMinutes: 1,
  fields: [],
  secretFields: [],
  securityNotes: ['Jeder Webhook hat ein eigenes Geheimnis, das rotiert und widerrufen werden kann.', 'Signaturen mit Zeitstempel verhindern das Wiedereinspielen alter Anfragen.'],
  testInfo: [],
  help: 'Webhooks brauchen keine Verbindung: Der Trigger „Webhook“ im Workflow erzeugt beim Veröffentlichen eine eigene Adresse.',
};
