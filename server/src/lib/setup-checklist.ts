import { config } from '../config.js';
import { many, one } from '../db/pool.js';
import { stateName } from '../keywords/catalog.js';
import { backupHealth } from '../routes/backup-offsite.js';
import { hostHelperView } from '../updates/host-helper.js';
import { smtpFingerprint, storedSmtpSettings } from '../warnings/mail.js';
import { m365Fingerprint, mailReady, storedM365Settings } from './mail.js';
import { proxyService } from './proxy-check.js';
import { getSettings, privacyInfo, type Settings } from './settings.js';
import { plural } from './text.js';

/**
 * Checkliste „BlaulichtCMS startklar“ (#255): was vor dem Echtbetrieb eingerichtet sein sollte. Jeder Punkt wird aus
 * dem tatsächlichen Stand erkannt (Einstellungen, Tabellen, Dateien des Update-Helfers) – nichts wird von Hand
 * abgehakt. Ausblenden gilt für die ganze Instanz (`setup.checklist_hidden`) und betrifft nur offene Punkte: Wird ein
 * erledigter Punkt wieder offen (z. B. Mailserver geändert, Testmail fehlt), erscheint er von selbst wieder.
 *
 * Die Adressen (`href`) sind Seiten der Oberfläche (Menü und Unterseiten der Einstellungen, wo möglich mit dem Feld als
 * Anker – web/src/config/settingsPages.ts); `permission` ist das Recht, mit dem sich der Punkt erledigen lässt – ohne
 * dieses Recht erscheint der Punkt nicht.
 */
export type ChecklistLevel = 'required' | 'recommended' | 'optional';

export interface ChecklistItem {
  id: string;
  title: string;
  level: ChecklistLevel;
  done: boolean;
  /** Was fehlt bzw. was erkannt wurde – ein Satz */
  detail: string;
  href: string;
  permission: string;
  hidden: boolean;
}

export interface Checklist {
  items: ChecklistItem[];
  /** sichtbare Punkte (nicht ausgeblendet) */
  total: number;
  done: number;
  /** alle Pflichtpunkte erledigt – dann lässt sich der Rest auf einmal ausblenden */
  requiredDone: boolean;
  /** Anzahl ausgeblendeter offener Punkte */
  hidden: number;
  /** Kachel zeigen: es gibt einen offenen, nicht ausgeblendeten Punkt */
  visible: boolean;
}

export const CHECKLIST_IDS = ['organization', 'public_url', 'privacy', 'mail', 'state', 'backup', 'invite', 'update_helper', 'two_factor', 'website', 'test_post'] as const;

const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/** Testmail mit genau den gespeicherten Versandeinstellungen gelungen? (ohne Altersgrenze – es geht um „einmal geprüft“) */
async function mailVerified(s: Settings): Promise<boolean> {
  if (s['mail.transport'] === 'm365') {
    const v = s['m365.verified'];
    return !!v && v.fp === m365Fingerprint(await storedM365Settings(s));
  }
  const v = s['smtp.verified'];
  return !!v && v.fp === smtpFingerprint(await storedSmtpSettings());
}

export async function setupChecklist(perms: ReadonlySet<string>): Promise<Checklist> {
  const s = await getSettings(true);
  const hiddenIds = new Set(Array.isArray(s['setup.checklist_hidden']) ? (s['setup.checklist_hidden'] as string[]) : []);
  const counts = (await one<any>(
    `SELECT (SELECT count(*)::int FROM users WHERE status <> 'disabled') AS accounts,
            (SELECT count(*)::int FROM users WHERE status = 'active' AND NOT totp_enabled) AS without_2fa,
            (SELECT count(*)::int FROM users WHERE status = 'active') AS active,
            EXISTS (SELECT 1 FROM approvals WHERE decision = 'approved') AS approved_post`,
  ))!;
  const sites = await many<{ name: string; status: string; last_seen_at: Date | null }>(`SELECT name, status, last_seen_at FROM wp_sites WHERE status <> 'revoked' ORDER BY status = 'active' DESC, name`);
  const backup = await backupHealth().catch(() => null);
  const drillOk = !!(await one(`SELECT 1 FROM restore_drills WHERE status = 'ok' LIMIT 1`));
  const helper = await hostHelperView().catch(() => null);

  const items: Omit<ChecklistItem, 'hidden'>[] = [];
  const add = (i: Omit<ChecklistItem, 'hidden'>) => items.push(i);

  /* Organisation und Zeitzone */
  const org = String(s['general.organization'] ?? '').trim();
  add({
    id: 'organization',
    title: 'Organisation und Zeitzone',
    level: 'required',
    done: !!org,
    detail: org ? `${org} · Zeitzone ${s['general.timezone']}` : 'Der Name der Organisation fehlt (erscheint auf Upload-Seiten, im Aushang und in E-Mails).',
    href: '/einstellungen/organisation#s-general-organization',
    permission: 'settings.general',
  });

  /* Öffentliche Adresse mit HTTPS, Proxy-Kette */
  const publicUrl = String(s['general.public_url'] || config.publicUrl || '').trim();
  let url: URL | null = null;
  try {
    url = publicUrl ? new URL(publicUrl) : null;
  } catch {
    url = null;
  }
  const proxy = proxyService();
  const urlProblem = !url
    ? 'Die öffentliche Adresse fehlt – ohne sie stimmen Links in E-Mails, QR-Codes und Upload-Links nicht.'
    : url.protocol !== 'https:' && !isLocal(url.hostname)
      ? `Die öffentliche Adresse ${url.origin} nutzt kein HTTPS – Anmeldung und Upload-Links brauchen eine verschlüsselte Verbindung (Reverse Proxy mit Zertifikat).`
      : proxy.state !== 'ok'
        ? 'Der Reverse Proxy steht nicht in TRUSTED_PROXIES – alle Personen teilen sich eine IP-Adresse (Sperren und Ratenbegrenzung treffen alle). Einzelheiten unter Verwaltung → Systemstatus.'
        : '';
  add({
    id: 'public_url',
    title: 'Öffentliche Adresse (HTTPS) und Reverse Proxy',
    level: 'required',
    done: !urlProblem,
    detail: urlProblem || `${url!.origin} · ${proxy.detail}`,
    href: proxy.state !== 'ok' && url ? '/system' : '/einstellungen/organisation#s-general-public_url',
    permission: proxy.state !== 'ok' && url ? 'system.status' : 'settings.general',
  });

  /* Datenschutz und Impressum (Art. 13 DSGVO, Anbieterkennzeichnung) */
  const p = privacyInfo(s);
  const missingLegal = [!p.controller && 'verantwortliche Stelle', !p.policy_url && 'Datenschutzerklärung', !String(s['legal.imprint_text'] ?? '').trim() && 'Impressum'].filter(Boolean) as string[];
  add({
    id: 'privacy',
    title: 'Verantwortliche Stelle, Datenschutzerklärung und Impressum',
    level: 'required',
    done: !missingLegal.length,
    detail: missingLegal.length ? `Es fehlt: ${missingLegal.join(', ')} – die öffentlichen Upload-Seiten zeigen sonst einen Hinweis statt der Pflichtangaben.` : 'Upload-Seiten und Aushang zeigen die Pflichtangaben.',
    href: '/einstellungen/datenschutz',
    permission: 'settings.privacy',
  });

  /* E-Mail-Versand */
  const ready = mailReady(s);
  const verified = ready && (await mailVerified(s).catch(() => false));
  const route = s['mail.transport'] === 'm365' ? 'Microsoft 365' : 'SMTP';
  add({
    id: 'mail',
    title: 'E-Mail-Versand einrichten und Testmail senden',
    level: 'required',
    done: verified,
    detail: !ready
      ? 'Ohne E-Mail-Versand gibt es keine Benachrichtigungen per E-Mail, keine Sicherheitsmeldungen und keine Presse- und Warn-Mails.'
      : verified
        ? `${route} eingerichtet, Testmail erfolgreich.`
        : `${route} ist eingetragen, aber mit diesen Angaben wurde noch keine Testmail erfolgreich gesendet.`,
    href: '/einstellungen/e-mail#versandweg',
    permission: 'settings.mail',
  });

  /* Bundesland / Stichwortverzeichnis */
  const state = String(s['general.state'] ?? '');
  add({
    id: 'state',
    title: 'Bundesland für das Stichwortverzeichnis wählen',
    level: 'required',
    done: !!state,
    detail: state ? `${stateName(state) || state} – Stichwörter für Einsatzliste, Einsatzentwürfe und Warnentwürfe.` : 'Ohne Bundesland fehlen die Einsatzstichwörter (Einsatzliste, Einsatzentwürfe, Warnentwürfe); „Eigene Liste“ ist auch möglich.',
    href: '/einstellungen/organisation#s-general-state',
    permission: 'settings.general',
  });

  /* Sicherung außer Haus und Probe-Wiederherstellung */
  const offsiteOk = !!backup?.offsite.enabled && !!backup.offsite.last_ok_at;
  const missingBackup = [!backup?.offsite.enabled ? 'Ziel außer Haus einrichten' : !backup.offsite.last_ok_at ? 'erste Übertragung abwarten bzw. starten' : '', !drillOk ? 'eine Probe-Wiederherstellung bestehen' : ''].filter(Boolean);
  add({
    id: 'backup',
    title: 'Sicherung außer Haus und erste Probe-Wiederherstellung',
    level: 'required',
    done: offsiteOk && drillOk,
    detail: missingBackup.length ? `Noch offen: ${missingBackup.join(', ')}. Eine Sicherung nur auf demselben Server hilft bei einem Hardwareschaden nicht.` : 'Sicherungen werden außer Haus übertragen, die Wiederherstellung ist geprobt.',
    href: '/einstellungen/sicherung#ausser-haus',
    permission: 'backup.manage',
  });

  /* Kolleginnen und Kollegen */
  add({
    id: 'invite',
    title: 'Kolleginnen und Kollegen einladen',
    level: 'recommended',
    done: counts.accounts >= 2,
    detail: counts.accounts >= 2 ? `${plural(counts.accounts, 'Konto', 'Konten')} angelegt.` : 'Bisher gibt es nur ein Konto. Freigaben brauchen eine zweite Person (Vier-Augen-Prinzip).',
    href: '/benutzer',
    permission: 'user.invite',
  });

  /* Update-Helfer am Host (#226) */
  add({
    id: 'update_helper',
    title: 'Update-Helfer am Host einrichten',
    level: 'recommended',
    done: !!helper?.installed,
    detail: helper?.installed
      ? `Eingerichtet${helper.helperVersion ? ` (Version ${helper.helperVersion})` : ''} – Updates mit neuem Image lassen sich in der App anstoßen.`
      : 'Damit lassen sich auch Updates mit neuem Image aus der App anstoßen: am Host das Installationsskript erneut ausführen und den Update-Helfer bejahen.',
    href: '/einstellungen/updates',
    permission: 'update.install',
  });

  /* Zwei-Faktor für alle */
  const all2fa = !!s['security.require_2fa_all'] || counts.without_2fa === 0;
  add({
    id: 'two_factor',
    title: 'Zwei-Faktor-Anmeldung für alle',
    level: 'recommended',
    done: all2fa,
    detail: s['security.require_2fa_all'] ? 'Für alle Konten vorgeschrieben.' : all2fa ? 'Alle aktiven Konten nutzen Zwei-Faktor.' : `${plural(counts.without_2fa, 'aktives Konto', 'aktive Konten')} von ${counts.active} ohne Zwei-Faktor – unter Sicherheit für alle vorschreiben.`,
    href: '/einstellungen/sicherheit#s-security-require_2fa_all',
    permission: 'settings.security',
  });

  /* Website koppeln (optional) */
  const live = sites.find((x) => x.status === 'active' && x.last_seen_at);
  add({
    id: 'website',
    title: 'Website koppeln (BlaulichtCMS Bridge)',
    level: 'optional',
    done: !!live,
    detail: live
      ? `${live.name} ist gekoppelt und meldet sich.`
      : sites.length
        ? `${sites[0].name}: Kopplung begonnen, die Website hat sich noch nicht gemeldet.`
        : 'Ohne Website funktioniert der interne Ablauf genauso; veröffentlicht wird dann nicht automatisch.',
    href: '/websites',
    permission: 'channel.sites',
  });

  /* Testbeitrag (optional) */
  add({
    id: 'test_post',
    title: 'Einen Testbeitrag einmal komplett durchspielen',
    level: 'optional',
    done: !!counts.approved_post,
    detail: counts.approved_post ? 'Mindestens ein Beitrag wurde freigegeben.' : 'Fotos sammeln, sichten, Beitrag schreiben, einreichen, freigeben – so lernt das Team den Ablauf kennen.',
    href: '/hilfe/erste-schritte',
    permission: 'post.view',
  });

  const visibleItems = items.filter((i) => perms.has(i.permission)).map((i) => ({ ...i, hidden: !i.done && hiddenIds.has(i.id) }));
  const shown = visibleItems.filter((i) => !i.hidden);
  return {
    items: visibleItems,
    total: shown.length,
    done: shown.filter((i) => i.done).length,
    requiredDone: visibleItems.every((i) => i.level !== 'required' || i.done),
    hidden: visibleItems.filter((i) => i.hidden).length,
    visible: shown.some((i) => !i.done),
  };
}
