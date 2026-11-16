import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { log } from './log.js';

/**
 * Erkennung einer falsch eingestellten Proxy-Kette (#192). Kommt eine Anfrage mit X-Forwarded-For von einer Adresse,
 * die nicht in TRUSTED_PROXIES steht, ignoriert BlaulichtCMS den Header (#92) – alle Personen erscheinen dann mit
 * der Adresse des Proxys. Folge: Ratenbegrenzungen (z. B. 10 Anmeldungen pro Minute) und Sperren je IP treffen alle
 * gemeinsam, Anmeldungen scheitern scheinbar zufällig mit „Zu viele Anfragen“. Der Systemstatus zeigt das an.
 */
interface ProxySeen {
  addr: string;
  at: number;
  count: number;
}
let ignored: ProxySeen | null = null;
let trustedAt = 0;
let warned = false;

const plain = (a: string) => a.replace(/^::ffff:/i, '');

export function observeProxy(req: FastifyRequest) {
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return;
  const addr = plain(req.socket?.remoteAddress ?? '');
  if (!addr) return;
  if (plain(req.ip) !== addr) {
    trustedAt = Date.now();
    return;
  }
  // Header vorhanden, aber nicht ausgewertet (Absender nicht vertrauenswürdig)
  const last = String(Array.isArray(xff) ? xff.join(',') : xff).split(',').pop()!.trim();
  if (plain(last) === addr) return;
  ignored = { addr, at: Date.now(), count: (ignored?.addr === addr ? ignored.count : 0) + 1 };
  if (!warned) {
    warned = true;
    log('warn', 'api', `Anfragen über ${addr} enthalten X-Forwarded-For, die Adresse steht aber nicht in TRUSTED_PROXIES – alle Personen teilen sich dadurch eine IP (Ratenbegrenzung, Sperren). Siehe Systemstatus und docs/reverse-proxy.md.`);
  }
}

const DAY = 24 * 60 * 60_000;

/** Eintrag für die Dienste im Systemstatus. */
export function proxyService(now = Date.now()) {
  const base = { id: 'proxy', name: 'Reverse Proxy', ms: null };
  if (ignored && now - ignored.at < DAY) {
    return {
      ...base,
      state: 'warning',
      detail: `Anfragen kommen über ${ignored.addr} mit X-Forwarded-For, diese Adresse steht aber nicht in TRUSTED_PROXIES. Alle Personen erscheinen deshalb mit derselben IP: Ratenbegrenzungen (z. B. 10 Anmeldungen pro Minute) und Sperren treffen alle gemeinsam. In der .env TRUSTED_PROXIES=${ignored.addr} (oder das Netz des Proxys) setzen und den Container neu starten.`,
    };
  }
  if (trustedAt && now - trustedAt < DAY) return { ...base, state: 'ok', detail: 'Client-IP wird vom vertrauenswürdigen Proxy übernommen' };
  return { ...base, state: 'ok', detail: config.trustedProxies.length ? 'noch keine weitergeleitete Anfrage gesehen' : 'direkter Zugriff (kein Proxy eingetragen)' };
}

/** Nur für Tests. */
export function resetProxyObservation() {
  ignored = null;
  trustedAt = 0;
  warned = false;
}
