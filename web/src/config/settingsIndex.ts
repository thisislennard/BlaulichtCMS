import { settingsFieldId, settingsPage } from './settingsPages';

/**
 * Einstellungen in der Suche (Strg K, #259) und unter „Einstellung finden“ (#256): Begriffe, unter denen man eine
 * Einstellung sucht, mit Ziel – Unterseite (`/einstellungen/<seite>`) und, wo es geht, das Feld selbst (`#s-<schlüssel>`,
 * die Seite springt hin und setzt den Fokus). server/test/search.test.ts prüft, dass Seite und Anker existieren.
 */
export interface SettingsEntry {
  /** Anzeige in der Trefferliste */
  title: string;
  /** Ort in Menübezeichnungen */
  where: string;
  href: string;
  /** Suchbegriffe (Feldbeschriftungen, Synonyme) */
  keywords: string;
  /** mindestens eines der Rechte nötig */
  perm: string[];
}

const where = (page: string) => `Einstellungen → ${settingsPage(page)?.label ?? page}`;
/** ganze Unterseite bzw. Abschnitt darauf */
const P = (page: string, title: string, keywords: string, perm: string[] = ['settings.view'], anchor?: string): SettingsEntry => ({ title, where: where(page), href: `/einstellungen/${page}${anchor ? `#${anchor}` : ''}`, keywords, perm });
/** einzelne Einstellung (Feld mit id `s-<schlüssel>`) */
const F = (page: string, key: string, title: string, keywords = '', perm: string[] = ['settings.view']): SettingsEntry => ({ title, where: where(page), href: `/einstellungen/${page}#${settingsFieldId(key)}`, keywords, perm });

export const SETTINGS_INDEX: SettingsEntry[] = [
  // Unterseiten
  P('organisation', 'Organisation', 'Instanzname Organisation Absendername Namen Öffentliche Adresse URL Zeitzone Bundesland Stichwortverzeichnis Sprache Allgemein'),
  P('organisation', 'Checkliste „BlaulichtCMS startklar“', 'Checkliste startklar Ersteinrichtung ausgeblendet einblenden Echtbetrieb', ['settings.general'], 'startklar'),
  P('datenschutz', 'Datenschutz & Recht', 'Verantwortliche Stelle Datenschutzbeauftragte DSB Datenschutzerklärung Impressum DSGVO Hinweis Upload-Seite Art. 13'),
  P('loeschfristen', 'Löschfristen', 'Löschfrist Aufbewahrung aufbewahren löschen Papierkorb Sammlungen Upload-Links Presseanfragen Warnvorgänge Einsatzmeldungen Empfangsprotokoll Versandprotokolle Wiedervorlage Systemprotokoll Audit-Protokoll IP-Adressen Laufprotokolle'),
  P('medien', 'Medien & Upload', 'Dateigröße Dateitypen Video Inhaltsprüfung Schadsoftware Gesichtsvorschläge Speicher Warnschwelle Upload-Link Gültigkeit Kontingent Hochladen ZIP Standortdaten Kamera Medien'),
  P('redaktion', 'Redaktion & Freigabe', 'Vier-Augen Freigabe Alternativtext Pflicht Einladung gültig Presse Erinnerung Frist Antworten freigeben Redaktion'),
  P('e-mail', 'E-Mail & Push', 'Push E-Mail Mail Versandweg Microsoft 365 Graph SMTP Mailserver Testmail Absender Push-Schlüssel VAPID Einzelheiten Benachrichtigungen'),
  P('sicherheit', 'Sicherheit', 'Zwei-Faktor 2FA Pflicht Sitzung Leerlauf angemeldet bleiben gemerkte Geräte Kontosperre Fehlversuche Sicherheitsmeldungen interne Ziele private Adressen Passwort'),
  P('sicherung', 'Sicherung', 'Sicherung Backup Datensicherung Zeitplan Uhrzeit Wiederherstellung Wiederherstellen Restore Generalschlüssel'),
  P('sicherung', 'Sicherung außer Haus', 'Sicherung außer Haus NAS Synology WebDAV SMB Offsite Probe-Wiederherstellung Aufbewahrung Ziel', ['backup.manage'], 'ausser-haus'),
  P('updates', 'Updates & Wartung', 'Update Version aktualisieren Wartungsmodus Signatur Update-Token Update vorbereiten Release', ['update.view']),
  P('workflows', 'Workflows ausführen', 'Workflows abschalten einschalten global Läufe je Minute Schleifen Automationen'),
  P('system', 'System', 'Hintergrundaufträge parallel Version Systeminfo Datenverzeichnis Proxy Worker Warteschlange Laufzeit Datenbank Über BlaulichtCMS'),
  // Einzelne Einstellungen
  F('organisation', 'general.timezone', 'Zeitzone', 'Zeitzone Uhrzeit Sommerzeit Winterzeit'),
  F('organisation', 'general.public_url', 'Öffentliche Adresse', 'URL Adresse Domain QR-Code Einladung'),
  F('organisation', 'general.state', 'Bundesland', 'Bundesland Land Stichwortverzeichnis'),
  F('organisation', 'general.sender_name', 'Absendername', 'Absender Name E-Mail'),
  F('datenschutz', 'privacy.controller', 'Verantwortliche Stelle', 'Verantwortlicher Anschrift Art. 13'),
  F('datenschutz', 'legal.privacy_text', 'Datenschutzerklärung', 'Datenschutzerklärung Datenschutzhinweise eigene Seite'),
  F('datenschutz', 'legal.imprint_text', 'Impressum', 'Impressum Anbieterkennzeichnung'),
  F('loeschfristen', 'privacy.deleted_media_days', 'Papierkorb leeren nach', 'Papierkorb gelöschte Dateien endgültig'),
  F('loeschfristen', 'retention.audit_days', 'Audit-Protokoll aufbewahren', 'Audit Protokoll Aufbewahrung'),
  F('loeschfristen', 'retention.log_days', 'Systemprotokoll aufbewahren', 'Systemprotokoll Logs Aufbewahrung'),
  F('loeschfristen', 'privacy.upload_ip_retention_days', 'IP-Adressen ohne Konto', 'IP-Adresse Anmeldeversuche Uploads'),
  P('loeschfristen', 'Was würde gelöscht?', 'Probelauf Löschlauf jetzt anwenden fällig', ['settings.view'], 'probelauf'),
  F('medien', 'media.max_file_mb', 'Maximale Dateigröße', 'Dateigröße Upload Grenze MB'),
  F('medien', 'media.allowed_types', 'Erlaubte Dateitypen', 'Dateitypen JPEG PNG HEIC MP4 Video'),
  F('medien', 'media.face_detect', 'Gesichtsvorschläge', 'Gesichter unkenntlich Datenschutz'),
  F('redaktion', 'editorial.four_eyes', 'Vier-Augen-Prinzip', 'Vier-Augen Freigabe selbst freigeben'),
  F('redaktion', 'editorial.alt_text_required', 'Alternativtext ist Pflicht', 'Alternativtext Barrierefreiheit Bildbeschreibung'),
  F('redaktion', 'invites.valid_hours', 'Einladungen gültig', 'Einladung Link Gültigkeit Passwort zurücksetzen'),
  P('e-mail', 'SMTP-Server und Testmail', 'SMTP Mailserver Mail E-Mail Versand Testmail Server Port Zugangsdaten Absender Warnversand', ['settings.view'], 'versandweg'),
  P('e-mail', 'Microsoft 365', 'Microsoft 365 Graph Entra Tenant Client-ID Geheimnis Funktionspostfach Mail', ['settings.view'], 'versandweg'),
  P('e-mail', 'Push-Benachrichtigungen', 'Push Benachrichtigungen E-Mail-Benachrichtigungen Einzelheiten Sperrbildschirm', ['settings.view'], 'benachrichtigungen'),
  F('sicherheit', 'security.require_2fa_all', 'Zwei-Faktor-Pflicht', 'Zwei-Faktor 2FA Pflicht alle'),
  F('sicherheit', 'security.lockout_attempts', 'Kontosperre', 'Sperre Fehlversuche gesperrt'),
  F('sicherheit', 'security.allowed_private_hosts', 'Interne Ziele freigeben', 'interne Ziele private Adressen Intranet Mailserver Netz'),
  F('sicherheit', 'security.alert_inapp', 'Sicherheitsmeldungen', 'Sicherheitsmeldung Alarm Admin'),
  F('sicherung', 'backup.hour', 'Uhrzeit der Sicherung', 'Sicherung Zeitplan nachts'),
  P('updates', 'Update vorbereiten', 'Vorabprüfung Wartungsmodus Update am Host', ['update.install'], 'vorbereiten'),
  F('system', 'jobs.concurrency', 'Parallele Hintergrundaufträge', 'Hintergrundaufträge parallel Worker'),
  // Außerhalb der Einstellungen
  { title: 'Wartungsmodus schalten', where: 'Verwaltung → Systemstatus', href: '/system#wartungsmodus', keywords: 'Wartungsmodus Wartung einschalten ausschalten pausieren', perm: ['system.maintenance'] },
  { title: 'Testmodus des Warnversands', where: 'Einrichtung → Stichwörter & Regeln → Testmodus', href: '/stichwoerter-regeln?tab=testmodus', keywords: 'Testmodus Testpostfach Warnversand Echtbetrieb Testmail', perm: ['warning.settings'] },
  { title: 'Persönliche Darstellung', where: 'Mein Konto → Darstellung', href: '/profil#darstellung', keywords: 'Darstellung Farbschema hell dunkel Dark Mode Animationen kompakte Tabellen', perm: [] },
  { title: 'Persönliche Benachrichtigungen', where: 'Mein Konto → Benachrichtigungen', href: '/profil#benachrichtigungen', keywords: 'Push E-Mail Mail Benachrichtigungen Gerät Testnachricht', perm: [] },
  { title: 'Passwort und Zwei-Faktor', where: 'Mein Konto', href: '/profil', keywords: 'Passwort ändern Zwei-Faktor 2FA Wiederherstellungscodes Sitzungen abmelden', perm: [] },
];
