import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import ipaddr from 'ipaddr.js';
import { config } from '../config.js';
import { StepError } from './errors.js';
import { log } from './log.js';

/**
 * Ausgehende HTTP-Anfragen mit SSRF-Schutz:
 * - Zieladresse wird selbst aufgelöst; private, Loopback-, Link-local-, Multicast- und
 *   reservierte Netze (IPv4/IPv6) sind gesperrt, sofern der Host nicht ausdrücklich in der
 *   Verbindung als „internes Ziel“ freigegeben ist.
 * - Die geprüfte IP wird für die Verbindung festgenagelt (kein DNS-Rebinding).
 * - Redirects nur begrenzt und jeder Sprung wird erneut geprüft; kein Wechsel von https auf http.
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
  /** false: Weiterleitungen nicht folgen, sondern die 3xx-Antwort liefern (Aufrufer prüft das Ziel selbst). */
  followRedirects?: boolean;
  /** Inhalt gestreamt aus dieser Datei senden (statt `body`, z. B. große Sicherungen); nur mit followRedirects: false. */
  bodyFile?: string;
  /** Inhalt aus diesem Strom senden (Länge setzt der Aufrufer als content-length); nur mit followRedirects: false. */
  bodyStream?: NodeJS.ReadableStream;
  /**
   * Antwort mit Status 2xx nicht puffern, sondern in diesen Strom schreiben (große Downloads). Die Größenbegrenzung
   * gilt dann nicht; der Aufrufer begrenzt selbst. Andere Status werden wie üblich gepuffert (Fehlertext).
   */
  sink?: NodeJS.WritableStream;
  /**
   * Fest hinterlegter SHA-256-Fingerabdruck des Server-Zertifikats (z. B. selbst signiertes Zertifikat eines NAS im
   * eigenen Netz): Statt der Zertifikatskette zählt dann genau dieser Fingerabdruck. Geprüft wird nach dem
   * TLS-Handshake und bevor irgendetwas (auch keine Zugangsdaten) gesendet wird.
   */
  tlsFingerprint256?: string;
}

/** Fingerabdruck vergleichbar machen: Großbuchstaben, nur Hex, mit Doppelpunkten wie in Node (`AB:CD:…`). */
export function normalizeFingerprint(v: string): string {
  const hex = v.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.match(/.{2}/g)?.join(':') ?? '';
}

/** Zertifikatsangaben eines TLS-Servers (für den Verbindungstest: Fingerabdruck zum Vergleichen anzeigen). */
export interface PeerCertificate {
  fingerprint256: string;
  subject: string;
  issuer: string;
  validTo: string;
  /** von einer vertrauenswürdigen Stelle ausgestellt und zum Namen passend */
  trusted: boolean;
  error: string | null;
}

/** Verbindet sich per TLS (geprüfte Adresse, festgenagelt) und liefert das Zertifikat – sendet keine Daten. */
export async function peekCertificate(urlStr: string, opts: { allowPrivateHosts?: string[]; timeoutMs?: number } = {}): Promise<PeerCertificate> {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:') throw new StepError('config', 'Nur https-Adressen haben ein Zertifikat.');
  const target = await resolveSafe(url.hostname, hostMatches(url.hostname, opts.allowPrivateHosts ?? []));
  const sock = await tlsConnect(url, target, opts.timeoutMs ?? 10_000);
  try {
    const c = sock.getPeerCertificate();
    const name = (o: any) => (o ? Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ') : '');
    let trusted = false;
    let error: string | null = null;
    // Kette und Name wie bei einer normalen Verbindung prüfen
    if (sock.authorized) {
      const idErr = tls.checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ''), c);
      trusted = !idErr;
      error = idErr ? idErr.message : null;
    } else error = String(sock.authorizationError ?? 'Zertifikat nicht vertrauenswürdig');
    return { fingerprint256: normalizeFingerprint(c.fingerprint256 ?? ''), subject: name(c.subject), issuer: name(c.issuer), validTo: c.valid_to ?? '', trusted, error };
  } finally {
    sock.destroy();
  }
}

/** TLS-Verbindung zur geprüften Adresse ohne Kettenprüfung aufbauen (Prüfung macht der Aufrufer). */
function tlsConnect(url: URL, target: { address: string; family: number }, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: target.address,
      port: Number(url.port || 443),
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => sock.destroy(Object.assign(new Error('Zeitüberschreitung'), { code: 'ETIMEDOUT' })), timeoutMs);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code ?? '')) reject(new StepError('transient', 'Das Zielsystem ist nicht erreichbar.', { technical: `${err.code}: ${err.message}` }));
      else reject(err);
    });
  });
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

/** Ziel selbst auflösen und interne Adressen sperren (auch für Nicht-HTTP-Verbindungen wie IMAP, press/imap.ts). */
export async function resolveSafe(host: string, allowPrivate: boolean): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(bare) ? [{ address: bare, family: net.isIP(bare) }] : await dns.lookup(bare, { all: true, verbatim: true });
  if (!addrs.length) throw new StepError('transient', `Der Name „${host}“ konnte nicht aufgelöst werden.`);
  if (!allowPrivate && !config.allowPrivateTargets) {
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) {
      // Die aufgelöste Adresse nur ins Systemprotokoll: in der Antwort würde sie internen Namen ihre IP zuordnen
      // (Netz-Erkundung über RSS-Vorschau oder Verbindungstest, #148)
      log('warn', 'http', `Abruf gesperrt: „${host}“ zeigt auf eine interne Adresse (${bad.address}).`);
      throw new StepError('config', `Die Adresse „${host}“ zeigt auf ein internes Netz und ist gesperrt.`, {
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
      // Zertifikat fest hinterlegt: erst verbinden und den Fingerabdruck prüfen, dann die Anfrage über genau diese
      // Verbindung schicken – vorher verlässt nichts den Server
      let pinned: tls.TLSSocket | null = null;
      if (req.tlsFingerprint256 && url.protocol === 'https:') {
        pinned = await tlsConnect(url, target, Math.min(remaining, 30_000));
        const got = normalizeFingerprint(pinned.getPeerCertificate().fingerprint256 ?? '');
        if (got !== normalizeFingerprint(req.tlsFingerprint256)) {
          pinned.destroy();
          throw new StepError('config', 'Das Zertifikat des Zielsystems passt nicht zum hinterlegten Fingerabdruck.', {
            technical: `erhalten ${got}`,
            hint: 'Hat das Zielsystem ein neues Zertifikat bekommen, den Fingerabdruck im Verbindungstest vergleichen und neu übernehmen.',
          });
        }
      }
      const fileSize = req.bodyFile ? fs.statSync(req.bodyFile).size : 0;
      const r = lib.request(
        {
          method: req.method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers: { 'user-agent': `BlaulichtCMS/${config.version}`, ...(req.headers ?? {}), ...(req.bodyFile ? { 'content-length': String(fileSize) } : {}) },
          servername: net.isIP(url.hostname) ? undefined : url.hostname,
          ...(pinned ? { createConnection: () => pinned } : {}),
          // IP festnageln: keine zweite DNS-Auflösung durch Node
          lookup: (_h: string, opts: any, cb: any) => {
            if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
            else cb(null, target.address, target.family);
          },
          timeout: remaining,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (req.sink && status >= 200 && status < 300) {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
            const sink = req.sink;
            res.on('error', reject);
            res.on('aborted', () => reject(new StepError('transient', 'Übertragung vom Zielsystem abgebrochen.')));
            sink.on('error', (e: Error) => (res.destroy(), reject(e)));
            sink.on('finish', () => resolve({ status, headers, body: Buffer.alloc(0), url: url.toString(), durationMs: Date.now() - started, text: () => '', json: () => null }));
            res.pipe(sink);
            return;
          }
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
      if (req.bodyFile || req.bodyStream) {
        const rs: NodeJS.ReadableStream = req.bodyStream ?? fs.createReadStream(req.bodyFile!);
        rs.on('error', (e: Error) => r.destroy(e));
        rs.pipe(r);
        return;
      }
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
    if (req.followRedirects === false) return res;
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= maxRedirects) throw new StepError('config', `Zu viele Weiterleitungen (mehr als ${maxRedirects}).`);
      const next = new URL(res.location, url);
      // Kein Wechsel von HTTPS auf unverschlüsseltes HTTP (#108): sonst könnte eine Weiterleitung Antworten
      // (z. B. Warnmeldungen) über einen ungeschützten Weg holen lassen
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new StepError('config', 'Weiterleitung von HTTPS auf eine unverschlüsselte Adresse wurde abgewiesen.');
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
