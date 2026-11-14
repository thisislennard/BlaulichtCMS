import mqtt from 'mqtt';
import { classifyStatus, httpRequest } from '../lib/http.js';
import { StepError } from '../lib/errors.js';
import { checkTemplate } from '../lib/template.js';
import type { Connector, NodeType, RuntimeConnection, TestStep } from '../engine/types.js';

/* -------------------------------------- MQTT ---------------------------------------- */

/** MQTT-Topic-Filter (+, #) gegen ein konkretes Topic prüfen. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Ist der (abonnierte) Filter durch die Allowlist abgedeckt? Konservativ: exakter Treffer oder Teilmenge. */
export function topicAllowed(topicOrFilter: string, allowlist: string[]): boolean {
  if (!allowlist.length) return false;
  return allowlist.some((a) => a === topicOrFilter || (!/[+#]/.test(topicOrFilter) && topicMatches(a, topicOrFilter)) || (a.endsWith('/#') && topicOrFilter.startsWith(a.slice(0, -1))));
}

export const mqttConnector: Connector = {
  id: 'mqtt',
  name: 'MQTT',
  kind: 'IoT · MQTT-Broker',
  group: 'IoT',
  description: 'Nachrichten von einem MQTT-Broker empfangen oder dorthin senden – mit Topic-Freigabeliste.',
  monogram: 'MQ',
  color: '#047857',
  needsConnection: true,
  setupMinutes: 2,
  fields: [
    { key: 'host', type: 'host', label: 'Broker', required: true, placeholder: 'broker.beispiel.de' },
    { key: 'tls', type: 'switch', label: 'TLS verwenden', default: true, help: 'Port wird automatisch angepasst (8883 / 1883).' },
    { key: 'port', type: 'port', label: 'Port', default: 8883 },
    { key: 'username', type: 'text', label: 'Benutzername' },
    { key: 'topics', type: 'list', label: 'Erlaubte Topics', required: true, help: 'Nur diese Topics dürfen abonniert/beschrieben werden. Platzhalter: + und # (z. B. feuerwehr/status/#).' },
    { key: 'clientId', type: 'text', label: 'Client-ID', advanced: true, placeholder: 'automatisch' },
    { key: 'qos', type: 'select', label: 'Standard-QoS', default: '1', advanced: true, options: [{ value: '0', label: '0 – höchstens einmal' }, { value: '1', label: '1 – mindestens einmal' }, { value: '2', label: '2 – genau einmal' }] },
  ],
  secretFields: [{ key: 'password', type: 'secret', label: 'Passwort' }],
  securityNotes: ['Eigene Broker-Zugangsdaten nur für LifeLink anlegen und im Broker per ACL begrenzen.', 'LifeLink nutzt nur die hier freigegebenen Topics.'],
  testInfo: ['Broker verbinden (CONNECT)', 'Anmeldung prüfen', 'Verbindung sauber trennen'],
  async test(conn) {
    const t0 = Date.now();
    const steps: TestStep[] = [];
    try {
      const client = await mqttConnect(conn, 8_000);
      steps.push({ label: 'Verbindung und Anmeldung', ok: true, ms: Date.now() - t0 });
      await client.endAsync();
    } catch (e) {
      steps.push({ label: 'Verbindung und Anmeldung', ok: false, ms: Date.now() - t0, message: (e as Error).message });
    }
    return steps;
  },
};

export function mqttConnect(conn: RuntimeConnection, timeoutMs = 10_000): Promise<mqtt.MqttClient> {
  const c = conn.config;
  return new Promise((resolve, reject) => {
    const client = mqtt.connect({
      host: c.host,
      port: Number(c.port) || (c.tls === false ? 1883 : 8883),
      protocol: c.tls === false ? 'mqtt' : 'mqtts',
      username: c.username || undefined,
      password: conn.secrets.password || undefined,
      clientId: c.clientId || `lifelink-${Math.random().toString(16).slice(2, 10)}`,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      client.end(true);
      reject(new StepError('transient', 'Broker antwortet nicht.'));
    }, timeoutMs + 500);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (err: Error & { code?: number }) => {
      clearTimeout(timer);
      client.end(true);
      if (err.code === 4 || err.code === 5 || /not authorized|bad user/i.test(err.message)) reject(new StepError('auth', 'Der Broker hat die Anmeldung abgelehnt.', { technical: err.message }));
      else reject(new StepError('transient', 'Broker nicht erreichbar.', { technical: err.message }));
    });
  });
}

export const mqttTrigger: NodeType = {
  type: 'mqtt.message',
  category: 'trigger',
  title: 'MQTT-Nachricht',
  description: 'Startet einen Lauf für jede Nachricht auf einem freigegebenen Topic.',
  icon: 'RadioTower',
  connector: 'mqtt',
  trigger: 'mqtt',
  fields: [
    { key: 'topic', type: 'text', label: 'Topic', required: true, placeholder: 'feuerwehr/status/+', help: 'Muss in der Freigabeliste der Verbindung stehen.' },
    { key: 'parseJson', type: 'switch', label: 'Inhalt als JSON lesen', default: true },
    { key: 'maxBytes', type: 'number', label: 'Maximale Nachrichtengröße (Bytes)', default: 65536, advanced: true, min: 1, max: 1_048_576 },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'topic', type: 'text', description: 'Topic der Nachricht' },
    { path: 'payload', type: 'object', description: 'Inhalt (JSON oder Text)' },
    { path: 'retained', type: 'boolean', description: 'Gespeicherte Nachricht (retain)?' },
  ],
  sampleOutput: { topic: 'feuerwehr/status/hlf1', payload: { status: 3 }, retained: false },
  validate: (c) => (c.topic?.trim() ? [] : ['Topic angeben.']),
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
};

export const mqttPublishNode: NodeType = {
  type: 'mqtt.publish',
  category: 'action',
  title: 'MQTT veröffentlichen',
  description: 'Sendet eine Nachricht an ein freigegebenes Topic.',
  icon: 'Send',
  connector: 'mqtt',
  sideEffect: true,
  idempotent: true,
  targetFields: ['topic'],
  fields: [
    { key: 'topic', type: 'text', label: 'Topic', required: true, help: 'Keine Variablen – das Ziel steht fest.' },
    { key: 'payload', type: 'variableTextarea', label: 'Inhalt', required: true },
    { key: 'qos', type: 'select', label: 'QoS', default: '1', options: [{ value: '0', label: '0' }, { value: '1', label: '1' }, { value: '2', label: '2' }] },
    { key: 'retain', type: 'switch', label: 'Retain (Broker speichert letzte Nachricht)', default: false, advanced: true },
  ],
  outputs: [{ id: 'out', label: 'Gesendet' }],
  outputFields: [{ path: 'topic', type: 'text', description: 'Topic' }],
  validate(c) {
    const out: string[] = [];
    if (!c.topic?.trim()) out.push('Topic angeben.');
    if (/[+#]|\{\{/.test(c.topic ?? '')) out.push('Topic darf keine Platzhalter oder Variablen enthalten.');
    const p = c.payload ? checkTemplate(c.payload) : 'Inhalt angeben.';
    if (p) out.push(p);
    return out;
  },
  async execute(ctx) {
    const conn = ctx.connection;
    if (!conn) throw new StepError('config', 'Keine MQTT-Verbindung gewählt.');
    const topic = String(ctx.node.config.topic);
    if (!topicAllowed(topic, conn.config.topics ?? [])) throw new StepError('config', `Topic „${topic}“ ist in der Verbindung nicht freigegeben.`);
    const payload = ctx.render(ctx.node.config.payload);
    if (Buffer.byteLength(payload) > 262_144) throw new StepError('invalid_payload', 'Nachricht ist größer als 256 KB.');
    const client = await mqttConnect(conn, Math.min(ctx.timeoutMs, 15_000));
    try {
      await client.publishAsync(topic, payload, { qos: Number(ctx.node.config.qos ?? 1) as 0 | 1 | 2, retain: !!ctx.node.config.retain });
    } finally {
      await client.endAsync().catch(() => {});
    }
    return { output: { topic, bytes: Buffer.byteLength(payload) }, statusText: topic };
  },
  async simulate(ctx) {
    return { output: { simuliert: true, topic: ctx.node.config.topic, payload: ctx.render(ctx.node.config.payload) }, statusText: `Simuliert: ${ctx.node.config.topic}` };
  },
};

/* ---------------------------------- Microsoft Teams --------------------------------- */

export const teamsConnector: Connector = {
  id: 'teams',
  name: 'Microsoft Teams',
  kind: 'Nachrichten · Workflows-Webhook',
  group: 'Nachrichten',
  description: 'Nachrichten in einen Teams-Kanal senden – über einen „Workflows“-Webhook des Kanals.',
  monogram: 'T',
  color: '#4F46E5',
  needsConnection: true,
  setupMinutes: 3,
  fields: [{ key: 'channelName', type: 'text', label: 'Kanal (Anzeige)', placeholder: 'Wehrführung › Allgemein', help: 'Nur zur Orientierung in LifeLink.' }],
  secretFields: [{ key: 'webhookUrl', type: 'secret', label: 'Webhook-Adresse', help: 'In Teams: Kanal → Workflows → „Bei Empfang einer Webhookanforderung in einem Kanal posten“.' }],
  securityNotes: ['Die Webhook-Adresse ist ein Geheimnis: Wer sie kennt, kann in den Kanal schreiben. Sie wird verschlüsselt gespeichert.', 'Der Zielkanal ist fest – niemals aus eingehenden Daten.'],
  testInfo: ['Adresse prüfen (nur Microsoft-Hosts)', 'Testnachricht nur auf Wunsch über „Node testen“'],
  async test(conn) {
    const t0 = Date.now();
    try {
      const url = new URL(conn.secrets.webhookUrl ?? '');
      const ok = url.protocol === 'https:' && /(\.logic\.azure\.com|\.powerplatform\.com|\.webhook\.office\.com|\.environment\.api\.powerplatform\.com)$/i.test(url.hostname);
      return [{ label: 'Webhook-Adresse', ok, ms: Date.now() - t0, message: ok ? url.hostname : 'Keine Microsoft-Webhook-Adresse' }];
    } catch {
      return [{ label: 'Webhook-Adresse', ok: false, ms: Date.now() - t0, message: 'Ungültige Adresse' }];
    }
  },
  help: 'Teams-Kanäle nehmen Nachrichten über die App „Workflows“ an. Die erzeugte Adresse wird als Geheimnis in der Verbindung hinterlegt.',
};

function teamsCard(title: string, text: string, facts: { key: string; value: string }[], style: string) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true, color: style },
            ...(text ? [{ type: 'TextBlock', text, wrap: true }] : []),
            ...(facts.length ? [{ type: 'FactSet', facts: facts.map((f) => ({ title: f.key, value: f.value })) }] : []),
          ],
        },
      },
    ],
  };
}

export const teamsMessageNode: NodeType = {
  type: 'teams.message',
  category: 'action',
  title: 'Teams-Nachricht',
  description: 'Postet eine Nachricht (Adaptive Card) in den verbundenen Teams-Kanal.',
  icon: 'MessagesSquare',
  connector: 'teams',
  sideEffect: true,
  idempotent: false,
  fields: [
    { key: 'title', type: 'variableText', label: 'Titel', required: true },
    { key: 'text', type: 'variableTextarea', label: 'Text' },
    { key: 'facts', type: 'keyvalue', label: 'Details (Tabelle)', advanced: true },
    { key: 'style', type: 'select', label: 'Hervorhebung', default: 'Default', options: [{ value: 'Default', label: 'Normal' }, { value: 'Attention', label: 'Wichtig (rot)' }, { value: 'Warning', label: 'Warnung (gelb)' }, { value: 'Good', label: 'Positiv (grün)' }] },
  ],
  outputs: [{ id: 'out', label: 'Gesendet' }],
  outputFields: [{ path: 'status', type: 'number', description: 'HTTP-Status' }],
  validate: (c) => (c.title?.trim() ? [checkTemplate(c.title)].filter(Boolean) as string[] : ['Titel angeben.']),
  async execute(ctx) {
    const url = ctx.connection?.secrets.webhookUrl;
    if (!url) throw new StepError('config', 'In der Teams-Verbindung fehlt die Webhook-Adresse.');
    const c = ctx.node.config;
    const card = teamsCard(ctx.render(c.title), ctx.render(c.text), (c.facts ?? []).map((f: any) => ({ key: f.key, value: ctx.render(f.value) })), c.style ?? 'Default');
    const res = await httpRequest({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body: JSON.stringify(card), timeoutMs: ctx.timeoutMs, maxRedirects: 0 });
    const err = classifyStatus(res, 'Teams');
    if (err) throw err;
    return { output: { status: res.status }, statusText: `${res.status} · ${res.durationMs} ms` };
  },
  async simulate(ctx) {
    return { output: { simuliert: true, titel: ctx.render(ctx.node.config.title), text: ctx.render(ctx.node.config.text) }, statusText: 'Simuliert: Teams-Nachricht' };
  },
};

/* ------------------------------- Microsoft 365 (Graph) ------------------------------ */

export const m365Connector: Connector = {
  id: 'm365',
  name: 'Microsoft 365',
  kind: 'E-Mail · Microsoft Graph',
  group: 'E-Mail',
  description: 'E-Mails aus einem Microsoft-365-Postfach senden – mit App-Registrierung (Mail.Send).',
  monogram: 'M',
  color: '#2563EB',
  needsConnection: true,
  setupMinutes: 10,
  fields: [
    { key: 'tenantId', type: 'text', label: 'Verzeichnis-ID (Tenant)', required: true },
    { key: 'clientId', type: 'text', label: 'Anwendungs-ID (Client)', required: true },
    { key: 'mailbox', type: 'text', label: 'Absender-Postfach', required: true, placeholder: 'lifelink@feuerwehr.de' },
  ],
  secretFields: [{ key: 'clientSecret', type: 'secret', label: 'Geheimer Clientschlüssel' }],
  securityNotes: [
    'Anwendungsberechtigung Mail.Send per „Application Access Policy“ auf das eine Absender-Postfach begrenzen.',
    'Clientschlüssel laufen ab – das Ablaufdatum in der Verbindung pflegen, LifeLink warnt rechtzeitig.',
  ],
  testInfo: ['Token bei Microsoft Entra ID anfordern', 'Postfach prüfen'],
  async test(conn) {
    const t0 = Date.now();
    try {
      await graphToken(conn);
      return [{ label: 'Anmeldung bei Microsoft', ok: true, ms: Date.now() - t0 }];
    } catch (e) {
      return [{ label: 'Anmeldung bei Microsoft', ok: false, ms: Date.now() - t0, message: (e as Error).message }];
    }
  },
};

const tokenCache = new Map<string, { token: string; until: number }>();

async function graphToken(conn: RuntimeConnection): Promise<string> {
  const cached = tokenCache.get(conn.id);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const c = conn.config;
  if (!/^[0-9a-f-]{36}$/i.test(c.tenantId ?? '')) throw new StepError('config', 'Tenant-ID ist keine gültige GUID.');
  const res = await httpRequest({
    method: 'POST',
    url: `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: conn.secrets.clientSecret ?? '', scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
    timeoutMs: 15_000,
  });
  if (res.status !== 200) throw new StepError('auth', 'Microsoft hat die Anmeldung abgelehnt.', { technical: res.text().slice(0, 300), hint: 'Client-ID, Geheimnis und Ablaufdatum prüfen.' });
  const data = res.json() as { access_token: string; expires_in: number };
  tokenCache.set(conn.id, { token: data.access_token, until: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export const m365MailNode: NodeType = {
  type: 'm365.mail',
  category: 'action',
  title: 'E-Mail senden (M365)',
  description: 'Sendet eine E-Mail aus dem Microsoft-365-Postfach an fest hinterlegte Empfänger.',
  icon: 'MailCheck',
  connector: 'm365',
  sideEffect: true,
  idempotent: false,
  targetFields: ['to'],
  fields: [
    { key: 'to', type: 'list', label: 'Empfänger', required: true, help: 'Feste Adressen – keine Variablen.' },
    { key: 'subject', type: 'variableText', label: 'Betreff', required: true },
    { key: 'text', type: 'variableTextarea', label: 'Nachricht', required: true },
  ],
  outputs: [{ id: 'out', label: 'Gesendet' }],
  validate(c) {
    const out: string[] = [];
    const to = (c.to ?? []).filter(Boolean);
    if (!to.length) out.push('Mindestens einen Empfänger angeben.');
    for (const r of to) if (String(r).includes('{{')) out.push('Variablen sind bei Empfängern nicht erlaubt.');
    return out;
  },
  async execute(ctx) {
    const conn = ctx.connection;
    if (!conn) throw new StepError('config', 'Keine Microsoft-365-Verbindung gewählt.');
    const token = await graphToken(conn);
    const c = ctx.node.config;
    const res = await httpRequest({
      method: 'POST',
      url: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(conn.config.mailbox)}/sendMail`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: ctx.render(c.subject).slice(0, 250),
          body: { contentType: 'Text', content: ctx.render(c.text) },
          toRecipients: (c.to ?? []).filter(Boolean).map((a: string) => ({ emailAddress: { address: a } })),
        },
        saveToSentItems: true,
      }),
      timeoutMs: ctx.timeoutMs,
    });
    const err = classifyStatus(res, 'Microsoft Graph');
    if (err) throw err;
    return { output: { status: res.status }, externalRef: res.headers['request-id'], statusText: `${res.status} · ${res.durationMs} ms` };
  },
  async simulate(ctx) {
    return { output: { simuliert: true, an: ctx.node.config.to, betreff: ctx.render(ctx.node.config.subject) }, statusText: 'Simuliert: E-Mail über Microsoft 365' };
  },
};
