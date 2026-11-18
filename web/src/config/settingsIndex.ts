/**
 * Einstellungen in der Suche (Strg K, #259): Begriffe, unter denen man eine Einstellung sucht, mit Ziel (Seite und
 * Abschnitt). Abschnitte entsprechen den Ankern in web/src/pages/admin/Settings.tsx (server/test/search.test.ts prüft,
 * dass jeder Anker existiert). Wer Einstellungen verschiebt (z. B. auf eigene Unterseiten), passt hier das Ziel an.
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

const S = (anchor: string, title: string, keywords: string, perm: string[] = ['settings.view']): SettingsEntry => ({ title, where: `Einstellungen → ${title}`, href: `/einstellungen#${anchor}`, keywords, perm });

export const SETTINGS_INDEX: SettingsEntry[] = [
  S('allgemein', 'Allgemein', 'Instanzname Organisation Untertitel Öffentliche Adresse URL Zeitzone Bundesland Stichwortverzeichnis Sprache Absendername'),
  S('darstellung', 'Darstellung', 'Farbschema hell dunkel Dark Mode Animationen kompakte Tabellen'),
  S('redaktion', 'Redaktion', 'Vier-Augen Freigabe Alternativtext Pflicht Einladung gültig Presse Erinnerung Frist Hintergrundaufträge parallel Aufbewahrung Systemprotokoll Audit-Protokoll IP-Adressen Workflows abschalten Läufe je Minute Antworten freigeben'),
  S('datenschutz', 'Datenschutz', 'Verantwortliche Stelle Datenschutzbeauftragte DSB Datenschutzerklärung Impressum Löschfristen Löschfrist Aufbewahrung Wiedervorlage Empfangsprotokoll Versandprotokolle DSGVO'),
  S('medien', 'Medien und Upload-Links', 'Dateigröße Dateitypen Video Inhaltsprüfung ClamAV Schadsoftware Gesichtsvorschläge Speicher Warnschwelle Upload-Link Gültigkeit Kontingent Hochladen'),
  S('betrieb', 'Betrieb', 'Worker Warteschlange Laufzeit Datenbank', ['system.status']),
  S('sicherheit', 'Sicherheit', 'Zwei-Faktor 2FA Pflicht Sitzung Leerlauf angemeldet bleiben gemerkte Geräte Kontosperre Fehlversuche Sicherheitsmeldungen interne Ziele private Adressen Passwort'),
  S('benachrichtigungen', 'Benachrichtigungen und E-Mail', 'Push E-Mail Mail Versandweg Microsoft 365 Graph SMTP Testmail Absender Push-Schlüssel VAPID Einzelheiten'),
  S('sicherung', 'Sicherung', 'Sicherung Backup Datensicherung Zeitplan Uhrzeit Wiederherstellung Wiederherstellen Restore Update vorbereiten'),
  S('sicherung-ausser-haus', 'Sicherung außer Haus', 'Sicherung außer Haus NAS Synology WebDAV SMB Offsite Probe-Wiederherstellung Aufbewahrung', ['backup.manage']),
  S('updates', 'Updates', 'Update Version aktualisieren Wartungsmodus Signatur Update-Token', ['update.view']),
  S('ueber', 'Über BlaulichtCMS', 'Version Lizenz Systeminfo'),
  {
    title: 'SMTP-Server und Testmail',
    where: 'Einrichtung → Stichwörter & Regeln → E-Mail-Versand',
    href: '/stichwoerter-regeln',
    keywords: 'SMTP Mailserver Mail E-Mail Versand Testmail Server Port Zugangsdaten Warnversand Testmodus',
    perm: ['warning.settings'],
  },
  { title: 'Persönliche Benachrichtigungen', where: 'Mein Konto → Benachrichtigungen', href: '/profil#benachrichtigungen', keywords: 'Push E-Mail Mail Benachrichtigungen Gerät Testnachricht', perm: [] },
  { title: 'Passwort und Zwei-Faktor', where: 'Mein Konto', href: '/profil', keywords: 'Passwort ändern Zwei-Faktor 2FA Wiederherstellungscodes Sitzungen abmelden', perm: [] },
];
