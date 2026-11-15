import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { config } from '../config.js';

/**
 * Weiterleitung des Audits an eine zentrale Protokollierung (#112), eingestellt über .env:
 *
 * - `AUDIT_FORWARD=stdout`: jede Zeile als JSON auf stdout (`"source":"audit"`) – Docker-Logging-Treiber (journald,
 *   gelf, syslog, fluentd) oder ein Log-Sammler übernehmen sie.
 * - `AUDIT_FORWARD=syslog`: RFC 5424 an `AUDIT_SYSLOG_HOST:AUDIT_SYSLOG_PORT` (Standard 514) über UDP oder TCP
 *   (`AUDIT_SYSLOG_PROTOCOL`, TCP mit Längenpräfix nach RFC 6587), Facility authpriv.
 *
 * Fehler beim Weiterleiten blockieren nie die Anwendung. Weitergeleitet werden Einträge (mit IP) und die
 * Kontrollpunkte der Hash-Kette (`audit_seal`). Bei einem Vorgang, der danach abgebrochen wird, kann ein
 * weitergeleiteter Eintrag in der Datenbank fehlen.
 */

const FACILITY_AUTHPRIV = 10;
let udp: dgram.Socket | null = null;
let tcp: net.Socket | null = null;
let tcpReady = false;
/** Zeilen, die während des (Wieder-)Verbindens anfallen – begrenzt, ältere fallen zuerst heraus. */
const pending: string[] = [];
let lastWarn = 0;

function warn(msg: string) {
  if (Date.now() - lastWarn < 60_000) return;
  lastWarn = Date.now();
  console.warn(JSON.stringify({ t: new Date().toISOString(), level: 'warn', source: 'audit-forward', message: msg }));
}

function tcpSend(frame: string) {
  if (tcp && !tcp.destroyed && tcpReady) {
    tcp.write(frame);
    return;
  }
  pending.push(frame);
  if (pending.length > 1000) pending.shift();
  if (tcp && !tcp.destroyed) return;
  tcpReady = false;
  tcp = net.connect({ host: config.auditForward.host, port: config.auditForward.port });
  tcp.setKeepAlive(true);
  tcp.unref();
  tcp.on('connect', () => {
    tcpReady = true;
    while (pending.length) tcp!.write(pending.shift()!);
  });
  tcp.on('error', (e) => {
    warn(`Syslog (TCP) nicht erreichbar: ${e.message}`);
    tcp?.destroy();
  });
  tcp.on('close', () => (tcpReady = false));
}

export function syslogLine(severity: number, json: string, at = new Date()): string {
  const host = (os.hostname() || '-').replace(/\s/g, '').slice(0, 255) || '-';
  return `<${FACILITY_AUTHPRIV * 8 + severity}>1 ${at.toISOString()} ${host} blaulichtcms ${process.pid} audit - ${json}`;
}

export function forwardAudit(event: Record<string, unknown>) {
  const mode = config.auditForward.mode;
  if (!mode) return;
  const json = JSON.stringify({ t: new Date().toISOString(), level: 'info', source: 'audit', ...event });
  try {
    if (mode === 'stdout') {
      process.stdout.write(json + '\n');
      return;
    }
    const severity = event.result === 'failed' || event.result === 'denied' ? 4 : 5; // warning / notice
    const line = syslogLine(severity, json);
    if (config.auditForward.protocol === 'tcp') {
      tcpSend(`${Buffer.byteLength(line)} ${line}`);
    } else {
      if (!udp) {
        udp = dgram.createSocket(net.isIPv6(config.auditForward.host) ? 'udp6' : 'udp4');
        udp.unref();
        udp.on('error', (e) => warn(`Syslog (UDP): ${e.message}`));
      }
      udp.send(line, config.auditForward.port, config.auditForward.host);
    }
  } catch (e) {
    warn(`Weiterleitung fehlgeschlagen: ${(e as Error).message}`);
  }
}
