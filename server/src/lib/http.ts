import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from '../config.js';
import { StepError } from './errors.js';

/**
 * Ausgehende HTTP-Anfragen mit SSRF-Schutz:
 * - Zieladresse wird selbst aufgelöst; private, Loopback-, Link-local-, Multicast- und
 *   reservierte Netze (IPv4/IPv6) sind gesperrt, sofern der Host nicht ausdrücklich in der
 *   Verbindung als „internes Ziel“ freigegeben ist.
 * - Die geprüfte IP wird für die Verbindung festgenagelt (kein DNS-Rebinding).
 * - Redirects nur begrenzt und jeder Sprung wird erneut geprüft.
 * - Antwortgröße und Laufzeit begrenzt.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  /** Hosts (exakt oder *.domain), deren private Adressen erlaubt sind. */
  allowPrivateHosts?: string[];
  /** Nur diese Hosts sind erlaubt (leer = alle öffentlichen). */
  allowedHosts?: string[];
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  durationMs: number;
  text(): string;
  json(): unknown;
}

const BLOCKED_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'reserved',
  'carrierGradeNat',
  'uniqueLocal',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
  'benchmarking',
  'amt',
  'as112',
  'deprecated',
  'orchid2',
  'droneRemoteIdProtocolEntityTags',
]);

export function isPrivateAddress(ip: string): boolean {
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  const range = addr.range();
  return BLOCKED_RANGES.has(range);
}

export function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const q = p.trim().toLowerCase();
    if (!q) return false;
    if (q.startsWith('*.')) return h.endsWith(q.slice(1)) || h === q.slice(2);
    return h === q;
  });
}

async function resolveSafe(host: string, allowPrivate: boolean): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(bare) ? [{ address: bare, family: net.isIP(bare) }] : await dns.lookup(bare, { all: true, verbatim: true });
  if (!addrs.length) throw new StepError('transient', `Der Name „${host}“ konnte nicht aufgelöst werden.`);
  if (!allowPrivate && !config.allowPrivateTargets) {
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) {
      throw new StepError('config', `Ziel „${host}“ zeigt auf eine interne Adresse (${bad.address}) und ist gesperrt.`, {
        hint: 'Interne Ziele müssen in der Verbindung unter „Erweiterte Optionen → Interne Ziele erlauben“ ausdrücklich freigegeben werden.',
      });
    }
  }
  return addrs[0];
}

function once(req: HttpRequest, url: URL, deadline: number): Promise<HttpResponse & { location?: string }> {
  return new Promise(async (resolve, reject) => {
    const started = Date.now();
    try {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new StepError('config', `Protokoll ${url.protocol} ist nicht erlaubt (nur http/https).`);
      }
      if (url.username || url.password) throw new StepError('config', 'Zugangsdaten in der URL sind nicht erlaubt – bitte in der Verbindung hinterlegen.');
      if (req.allowedHosts?.length && !hostMatches(url.hostname, req.allowedHosts)) {
        throw new StepError('config', `Host „${url.hostname}“ ist in dieser Verbindung nicht freigegeben.`);
      }
      const allowPrivate = hostMatches(url.hostname, req.allowPrivateHosts ?? []);
      const target = await resolveSafe(url.hostname, allowPrivate);
      const lib = url.protocol === 'https:' ? https : http;
      const remaining = Math.max(1, deadline - Date.now());
      const r = lib.request(
        {
          method: req.method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers: { 'user-agent': `LifeLink/${config.version}`, ...(req.headers ?? {}) },
          servername: net.isIP(url.hostname) ? undefined : url.hostname,
          // IP festnageln: keine zweite DNS-Auflösung durch Node
          lookup: (_h: string, opts: any, cb: any) => {
            if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
            else cb(null, target.address, target.family);
          },
          timeout: remaining,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const max = req.maxResponseBytes ?? 1_000_000;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > max) {
              res.destroy();
              reject(new StepError('invalid_payload', `Antwort ist größer als ${Math.round(max / 1024)} KB und wurde abgebrochen.`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body,
              url: url.toString(),
              durationMs: Date.now() - started,
              location: res.headers.location,
              text: () => body.toString('utf8'),
              json: () => JSON.parse(body.toString('utf8') || 'null'),
            });
          });
          res.on('error', reject);
        },
      );
      r.on('timeout', () => {
        r.destroy(Object.assign(new Error('Zeitüberschreitung'), { name: 'TimeoutError' }));
      });
      r.on('error', (err: NodeJS.ErrnoException) => {
        // Ob die Anfrage das Ziel schon erreicht hat, wissen wir nach dem Senden nicht.
        if (err.name === 'TimeoutError') {
          reject(
            new StepError(r.writableFinished ? 'timeout_unknown' : 'transient', 'Zeitüberschreitung beim Zielsystem.', {
              sideEffectUnknown: r.writableFinished,
              technical: err.message,
            }),
          );
        } else if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code ?? '')) {
          reject(new StepError('transient', 'Das Zielsystem ist nicht erreichbar.', { technical: `${err.code}: ${err.message}` }));
        } else if (err.code === 'ECONNRESET') {
          reject(new StepError(r.writableFinished ? 'timeout_unknown' : 'transient', 'Verbindung wurde vom Zielsystem getrennt.', { technical: err.message, sideEffectUnknown: r.writableFinished }));
        } else if (/certificate|SSL|TLS/i.test(err.message)) {
          reject(new StepError('config', 'TLS-Zertifikat des Zielsystems ist ungültig.', { technical: err.message }));
        } else reject(err);
      });
      if (req.body != null) r.write(req.body);
      r.end();
    } catch (err) {
      reject(err);
    }
  });
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const deadline = Date.now() + (req.timeoutMs ?? 30_000);
  let url = new URL(req.url);
  let method = req.method.toUpperCase();
  let body = req.body;
  const maxRedirects = req.maxRedirects ?? 3;
  for (let hop = 0; ; hop++) {
    const res = await once({ ...req, method, body }, url, deadline);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= maxRedirects) throw new StepError('config', `Zu viele Weiterleitungen (mehr als ${maxRedirects}).`);
      const next = new URL(res.location, url);
      // Zugangsdaten nie an fremde Hosts mitschicken
      if (next.host !== url.host && req.headers) {
        req = { ...req, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k))) };
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
      continue;
    }
    return res;
  }
}

/** HTTP-Status in Fehlerklasse übersetzen. */
export function classifyStatus(res: HttpResponse, what = 'Zielsystem'): StepError | null {
  const s = res.status;
  if (s >= 200 && s < 300) return null;
  const snippet = res.text().slice(0, 300);
  if (s === 401) return new StepError('auth', `${what} hat die Anmeldung abgelehnt (401).`, { technical: snippet, hint: 'Zugangsdaten der Verbindung prüfen oder ersetzen.' });
  if (s === 403) return new StepError('permission', `${what} verweigert den Zugriff (403).`, { technical: snippet, hint: 'Berechtigungen des verwendeten Kontos prüfen.' });
  if (s === 429) {
    const ra = Number(res.headers['retry-after']);
    return new StepError('rate_limit', `${what} meldet zu viele Anfragen (429).`, { technical: snippet, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : undefined });
  }
  if (s === 409 || s === 412) return new StepError('conflict', `${what} meldet einen Konflikt (${s}).`, { technical: snippet });
  if (s >= 400 && s < 500) return new StepError('invalid_payload', `${what} hat die Anfrage abgelehnt (${s}).`, { technical: snippet });
  return new StepError('transient', `${what} meldet einen Serverfehler (${s}).`, { technical: snippet });
}
