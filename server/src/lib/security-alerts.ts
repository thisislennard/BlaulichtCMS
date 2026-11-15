import { many, one } from '../db/pool.js';
import { permissionsFor } from '../auth/permissions.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { getSettings } from './settings.js';

/**
 * Meldungen bei sicherheitsrelevanten Ereignissen (#101, BSI DER.1, Art. 33 DSGVO).
 *
 * - In-App-Benachrichtigung an alle mit dem passenden Recht (Standard „System verwalten“), abschaltbar über
 *   `security.alert_inapp`.
 * - Zusätzlich per E-Mail an dieselben Personen, wenn `security.alert_mail_admins` an ist und SMTP eingerichtet ist.
 * - Die betroffene Person bekommt bei Änderungen an ihrem Konto (Passwort, Zwei-Faktor, Wiederherstellungscode,
 *   Sperre) immer eine In-App-Meldung und – mit `security.alert_mail_user` und eingerichtetem SMTP – eine E-Mail.
 * - Jede Meldung steht außerdem im Systemprotokoll (Quelle „security“).
 *
 * Serien werden je `throttleKey` gedrosselt (Standard: eine Meldung pro Stunde). Fehler beim Melden blockieren nie
 * die auslösende Aktion.
 */

export type SecurityEvent =
  | 'account_locked'
  | 'recovery_code_used'
  | 'admin_granted'
  | 'admin_removed'
  | 'mfa_reset'
  | 'mfa_disabled'
  | 'security_settings'
  | 'failed_logins'
  | 'bridge_auth'
  | 'fe2_auth'
  | 'api_key_auth'
  | 'site_paired'
  | 'mass_download'
  | 'audit_integrity'
  | 'malware_found'
  | 'malware_scanner'
  | 'media_force_released'
  | 'master_key_rotated'
  | 'update_settings'
  | 'update_install'
  | 'update_rolled_back';

const throttle = new Map<string, number>();

function throttled(key: string, ms: number): boolean {
  const now = Date.now();
  const until = throttle.get(key);
  if (until && until > now) return true;
  if (throttle.size > 2000) throttle.clear();
  throttle.set(key, now + ms);
  return false;
}

/** Nur für Tests. */
export function resetSecurityAlertThrottle() {
  throttle.clear();
}

async function sendMail(to: string[], subject: string, text: string) {
  if (!to.length) return;
  const { smtpTransport } = await import('../warnings/mail.js');
  const s = await getSettings();
  const base = s['general.public_url'] || '';
  const { transport, from } = await smtpTransport();
  try {
    // Einzeln senden: Empfänger sehen einander nicht
    for (const addr of to) {
      await transport.sendMail({
        from,
        to: addr,
        subject: `[${s['general.instance_name'] || 'BlaulichtCMS'}] ${subject}`,
        text: `${text}\n\n${base ? `${base}\n` : ''}Diese Nachricht wurde automatisch von BlaulichtCMS erzeugt.`,
      });
    }
  } finally {
    transport.close();
  }
}

const smtpReady = (s: Awaited<ReturnType<typeof getSettings>>) => !!(s['smtp.host'] && s['smtp.from']);

/** Meldung an die Administration (Recht `permission`). Gibt false zurück, wenn gedrosselt oder abgeschaltet. */
export async function securityAlert(
  event: SecurityEvent,
  msg: { title: string; body?: string; link?: string; permission?: string; kind?: 'warning' | 'error' | 'info'; throttleKey?: string; throttleMs?: number },
): Promise<boolean> {
  try {
    if (msg.throttleKey && throttled(`${event}:${msg.throttleKey}`, msg.throttleMs ?? 60 * 60_000)) return false;
    const s = await getSettings();
    const permission = msg.permission ?? 'system.manage';
    log('warn', 'security', msg.title, { ereignis: event, ...(msg.body ? { text: msg.body.slice(0, 500) } : {}) });
    if (s['security.alert_inapp']) {
      await notify({ kind: msg.kind ?? 'warning', title: msg.title, body: msg.body, link: msg.link ?? '/protokolle', permission });
    }
    if (s['security.alert_mail_admins'] && smtpReady(s)) {
      const users = await many<{ email: string; roles: string[] }>(`SELECT email, roles FROM users WHERE status = 'active'`);
      const to = users.filter((u) => permissionsFor(u.roles).has(permission)).map((u) => u.email);
      sendMail(to, msg.title, msg.body ?? '').catch((e) => log('warn', 'security', `Sicherheitsmeldung per E-Mail fehlgeschlagen: ${e.message}`));
    }
    return true;
  } catch (e) {
    log('warn', 'security', `Sicherheitsmeldung fehlgeschlagen: ${(e as Error).message}`);
    return false;
  }
}

/** Meldung an die betroffene Person (In-App immer, E-Mail nach Einstellung). */
export async function notifyAffectedUser(userId: string, title: string, body: string) {
  try {
    await notify({ kind: 'warning', title, body, userId });
    const s = await getSettings();
    if (s['security.alert_mail_user'] && smtpReady(s)) {
      const u = await one<{ email: string; status: string }>('SELECT email, status FROM users WHERE id = $1', [userId]);
      if (u && u.status !== 'disabled') sendMail([u.email], title, body).catch((e) => log('warn', 'security', `Kontomeldung per E-Mail fehlgeschlagen: ${e.message}`));
    }
  } catch (e) {
    log('warn', 'security', `Kontomeldung fehlgeschlagen: ${(e as Error).message}`);
  }
}

/**
 * Gehäufte fehlgeschlagene Anmeldungen (Passwort, Code, Bestätigung) über alle Konten im 15-Minuten-Fenster –
 * Anzeichen für Passwort-Spraying oder einen gezielten Angriff. Schwelle `security.alert_failed_logins` (0 = aus).
 */
export async function checkFailedLoginRate() {
  try {
    const s = await getSettings();
    const limit = s['security.alert_failed_logins'];
    if (!limit) return;
    const r = await one<{ n: number; ips: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT ip)::int AS ips FROM audit_events
        WHERE at > now() - interval '15 minutes' AND result = 'failed' AND action IN ('auth.login', 'auth.mfa', 'auth.confirm')`,
    );
    if (!r || r.n < limit) return;
    await securityAlert('failed_logins', {
      title: `Gehäufte fehlgeschlagene Anmeldungen (${r.n} in 15 Minuten)`,
      body: `${r.n} fehlgeschlagene Anmeldungen bzw. Codes von ${r.ips} Adresse(n) in den letzten 15 Minuten. Bitte das Audit-Protokoll (Ergebnis „Fehlgeschlagen“) prüfen.`,
      throttleKey: 'global',
    });
  } catch (e) {
    log('warn', 'security', `Prüfung der Fehlversuche fehlgeschlagen: ${(e as Error).message}`);
  }
}

/**
 * Ungewöhnlich viele Original-Downloads bzw. Exporte einer Person in einer Stunde (möglicher Datenabfluss).
 * Schwelle `security.alert_downloads` (0 = aus).
 */
export async function checkDownloadRate(actor: { id: string | null; name: string }) {
  try {
    if (!actor.id) return;
    const s = await getSettings();
    const limit = s['security.alert_downloads'];
    if (!limit) return;
    const r = await one<{ n: number }>(
      `SELECT coalesce(sum(CASE WHEN action = 'media.export_requested' THEN coalesce((details->>'dateien')::int, 1) ELSE 1 END), 0)::int AS n
         FROM audit_events WHERE actor_id = $1 AND at > now() - interval '1 hour' AND action IN ('media.downloaded', 'media.export_requested')`,
      [actor.id],
    );
    if (!r || r.n < limit) return;
    await securityAlert('mass_download', {
      title: `Viele Downloads durch ${actor.name}`,
      body: `${r.n} Originale bzw. Dateien in Exporten innerhalb einer Stunde (Schwelle ${limit}). Falls das nicht abgesprochen ist: Sitzungen der Person beenden und das Audit-Protokoll prüfen.`,
      throttleKey: actor.id,
    });
  } catch (e) {
    log('warn', 'security', `Prüfung der Downloads fehlgeschlagen: ${(e as Error).message}`);
  }
}
