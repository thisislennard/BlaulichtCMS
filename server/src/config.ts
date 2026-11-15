import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Programmverzeichnis (enthält VERSION, server/, web/). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(): string {
  try {
    return fs.readFileSync(path.join(APP_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const env = process.env;

/** Schlüsselwörter für Adressbereiche (wie proxy-addr); `private` fasst alle drei zusammen. */
const PROXY_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal'];
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

function validProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.includes(entry)) return true;
  const [ip, bits, ...rest] = entry.split('/');
  if (rest.length) return false;
  const v4 = IPV4.test(ip) && ip.split('.').every((o) => Number(o) <= 255);
  const v6 = !v4 && ip.includes(':') && /^[0-9a-f:.]+$/i.test(ip);
  if (!v4 && !v6) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d{1,3}$/.test(bits) && n >= 0 && n <= (v4 ? 32 : 128);
}

/**
 * Vertrauenswürdige Reverse Proxys (#92). Nur Verbindungen von diesen Adressen dürfen per X-Forwarded-For eine
 * Client-IP angeben; Fastify nimmt dann den rechtesten Eintrag, der nicht selbst ein vertrauenswürdiger Proxy ist.
 * Ein vom Client mitgeschickter Header verschiebt req.ip damit nicht mehr.
 *
 * - TRUSTED_PROXIES: Liste aus IPs, CIDR-Netzen und den Wörtern loopback, linklocal, uniquelocal, private
 *   (private = alle drei, also 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10).
 * - TRUST_PROXY=true (veraltet, ohne TRUSTED_PROXIES): wird wie `private` behandelt, beim Start mit Warnung.
 * - sonst: X-Forwarded-For wird ignoriert.
 */
export function parseTrustedProxies(e: Record<string, string | undefined>): { list: string[]; warning: string | null } {
  const raw = (e.TRUSTED_PROXIES ?? '').trim();
  if (raw) {
    const entries = raw.split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase());
    if (entries.some((x) => ['none', 'false', 'off', '0'].includes(x))) return { list: [], warning: null };
    const list: string[] = [];
    for (const x of entries) {
      if (x === 'private') list.push(...PROXY_KEYWORDS);
      else if (validProxyEntry(x)) list.push(x);
      else throw new Error(`TRUSTED_PROXIES: „${x}“ ist keine IP-Adresse, kein Netz (CIDR) und keines der Wörter loopback, linklocal, uniquelocal, private.`);
    }
    return { list: [...new Set(list)], warning: null };
  }
  if (bool(e.TRUST_PROXY, false)) {
    return {
      list: [...PROXY_KEYWORDS],
      warning: 'TRUST_PROXY=true ist veraltet: vertraut wird nur noch X-Forwarded-For von privaten Adressen (wie TRUSTED_PROXIES=private). Bitte TRUSTED_PROXIES mit der Adresse oder dem Netz des Reverse Proxys setzen (docs/reverse-proxy.md).',
    };
  }
  return { list: [], warning: null };
}
const proxies = parseTrustedProxies(env);
const embedded = bool(env.BLAULICHTCMS_EMBEDDED_DB, false);
const embeddedUrl = (role: string) => `postgresql://${role}@localhost/blaulichtcms?host=${encodeURIComponent(env.BLAULICHTCMS_PG_SOCKET_DIR ?? '/tmp/blaulichtcms-pg')}`;
const dataDir = path.resolve(env.BLAULICHTCMS_DATA_DIR ?? path.join(APP_ROOT, 'data'));

/** Master-Schlüssel: Umgebungsvariable hat Vorrang, sonst die beim ersten Containerstart erzeugte Datei. */
function readMasterKey(): string {
  if (env.BLAULICHTCMS_MASTER_KEY?.trim()) return env.BLAULICHTCMS_MASTER_KEY.trim();
  try {
    return fs.readFileSync(path.join(dataDir, 'secrets', 'master.key'), 'utf8').trim();
  } catch {
    return '';
  }
}

export const config = {
  version: readVersion(),
  env: env.NODE_ENV ?? 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 7310),
  host: env.HOST ?? '0.0.0.0',
  // Im Image (eingebettete Datenbank) ohne DATABASE_URL: Unix-Socket im Container mit der Laufzeitrolle
  // `blaulichtcms_app` (#102) – so funktionieren auch Wartungsbefehle per `docker compose exec blaulichtcms node server/dist/cli.js …`
  databaseUrl: env.DATABASE_URL ?? (embedded ? embeddedUrl('blaulichtcms_app') : 'postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5432/blaulichtcms'),
  /**
   * Verbindung für den Migrationsschritt (`cli.js migrate`): im Image der Superuser `blaulichtcms` (richtet die Rollen
   * ein, Migrationen laufen dann als `blaulichtcms_owner`), sonst `DATABASE_ADMIN_URL` bzw. dieselbe wie `databaseUrl`.
   */
  adminDatabaseUrl: env.DATABASE_ADMIN_URL ?? (embedded ? embeddedUrl('blaulichtcms') : (env.DATABASE_URL ?? 'postgresql://blaulichtcms:blaulichtcms@127.0.0.1:5432/blaulichtcms')),
  /** Getrennte Datenbankrollen einrichten (db/roles.ts); im Image Standard, sonst `BLAULICHTCMS_DB_ROLES=true`. */
  dbRoles: bool(env.BLAULICHTCMS_DB_ROLES, embedded),
  /** 32 Byte, Base64. Verschlüsselt alle gespeicherten Zugangsdaten. Liegt nie in der Datenbank. */
  masterKey: readMasterKey(),
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  /** Vertrauenswürdige Proxys für X-Forwarded-For (leer = Header ignorieren), siehe parseTrustedProxies. */
  trustedProxies: proxies.list,
  trustProxyWarning: proxies.warning,
  cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
  /** Weiterleitung des Audits an eine zentrale Protokollierung (#112, lib/audit-forward.ts). */
  auditForward: {
    mode: (['stdout', 'syslog'].includes(String(env.AUDIT_FORWARD ?? '').toLowerCase()) ? String(env.AUDIT_FORWARD).toLowerCase() : '') as '' | 'stdout' | 'syslog',
    host: env.AUDIT_SYSLOG_HOST ?? '127.0.0.1',
    port: Number(env.AUDIT_SYSLOG_PORT ?? 514) || 514,
    protocol: (String(env.AUDIT_SYSLOG_PROTOCOL ?? 'udp').toLowerCase() === 'tcp' ? 'tcp' : 'udp') as 'udp' | 'tcp',
  },
  /** HSTS (nur mit COOKIE_SECURE): Dauer in Sekunden, Subdomains und Preload-Liste (#132). */
  hsts: {
    maxAge: Math.max(0, Number(env.HSTS_MAX_AGE ?? 31_536_000) || 0),
    includeSubDomains: bool(env.HSTS_INCLUDE_SUBDOMAINS, false),
    preload: bool(env.HSTS_PRELOAD, false),
  },
  /**
   * Optionale Schadsoftwareprüfung mit ClamAV (#133, media/clamav.ts): clamd per TCP (INSTREAM). Ohne CLAMAV_HOST
   * keine Prüfung (Restrisiko dokumentiert in docs/betrieb.md).
   */
  clamav: {
    host: (env.CLAMAV_HOST ?? '').trim(),
    port: Number(env.CLAMAV_PORT ?? 3310) || 3310,
    timeoutMs: Math.max(1_000, Number(env.CLAMAV_TIMEOUT_MS ?? 120_000) || 120_000),
  },
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  webDist: path.join(APP_ROOT, 'web', 'dist'),
  pluginDir: path.join(APP_ROOT, 'wordpress-plugin', 'blaulichtcms-bridge'),
  migrationsDir: path.join(APP_ROOT, 'server', 'migrations'),
  /** Im Container: PostgreSQL wird vom Supervisor unter /data/postgres betrieben. */
  embeddedDb: embedded,
  /** Nur für Tests/Entwicklung: private Ziele ohne Freigabe erlauben. */
  allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
};

export type Config = typeof config;
