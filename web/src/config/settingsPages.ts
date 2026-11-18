/**
 * Unterseiten der Einstellungen (#256): `/einstellungen/<id>` statt einer langen Seite. Jede Unterseite hat genau ein
 * Speichermodell (Speichern-Leiste) und eigene Rechte: sichtbar mit `settings.view` (bzw. `view`), änderbar je Feld mit
 * dem Recht des Schlüssels (settingPermission) – `edit` nennt die Rechte, mit denen sich auf der Seite etwas ändern lässt.
 *
 * Frühere Anker der einen Seite (`/einstellungen#datenschutz` …) leiten über LEGACY_SETTINGS_ANCHORS weiter – Links in
 * alten Benachrichtigungen, Lesezeichen und Hilfe bleiben gültig.
 */
export interface SettingsPageDef {
  id: string;
  label: string;
  icon: string;
  /** eine Zeile für die Übersicht */
  description: string;
  /** Hilfe-Kapitel (#Anker) für das „?“ am Seitentitel */
  help: string;
  /** zusätzlich nötiges Leserecht (mindestens eines), sonst nur settings.view */
  view?: string[];
  /** Rechte, mit denen sich auf der Seite etwas ändern lässt (mindestens eines) */
  edit: string[];
}

export const SETTINGS_PAGES: SettingsPageDef[] = [
  { id: 'organisation', label: 'Organisation', icon: 'Building2', description: 'Namen und wo sie erscheinen, öffentliche Adresse, Zeitzone, Bundesland, Sprache', help: 'einrichtung#organisation', edit: ['settings.general'] },
  { id: 'datenschutz', label: 'Datenschutz & Recht', icon: 'ShieldCheck', description: 'Verantwortliche Stelle, Datenschutzbeauftragte/r, Datenschutzerklärung, Impressum', help: 'foto-link#datenschutz-auf-der-upload-seite', edit: ['settings.privacy'] },
  { id: 'loeschfristen', label: 'Löschfristen', icon: 'TimerOff', description: 'Alle Fristen an einem Ort – mit „Was würde gelöscht?“', help: 'sicherheit#loeschfristen', edit: ['settings.privacy', 'settings.media'] },
  { id: 'medien', label: 'Medien & Upload', icon: 'Images', description: 'Grenzen, Dateitypen, Inhaltsprüfung, Gesichtsvorschläge, Upload-Links', help: 'foto-link#grenzen', edit: ['settings.media'] },
  { id: 'redaktion', label: 'Redaktion & Freigabe', icon: 'ListChecks', description: 'Vier-Augen-Prinzip, Alternativtext, Presseantworten, Einladungen', help: 'freigabe#vier-augen-prinzip', edit: ['settings.editorial', 'settings.security'] },
  { id: 'e-mail', label: 'E-Mail & Push', icon: 'Mail', description: 'Versandweg SMTP oder Microsoft 365 mit Testmail, Push-Benachrichtigungen', help: 'benachrichtigungen#e-mail-und-push-einrichten', edit: ['settings.mail'] },
  { id: 'sicherheit', label: 'Sicherheit', icon: 'Lock', description: 'Zwei-Faktor-Pflicht, Sitzungen, Kontosperre, Sicherheitsmeldungen', help: 'sicherheit', edit: ['settings.security'] },
  { id: 'sicherung', label: 'Sicherung', icon: 'HardDrive', description: 'Tägliche Sicherung, Sicherung außer Haus, Probe-Wiederherstellung', help: 'sicherung', edit: ['backup.manage'] },
  { id: 'updates', label: 'Updates & Wartung', icon: 'Download', description: 'Neue Versionen, Update vorbereiten, Wartungsmodus', help: 'updates', view: ['update.view'], edit: ['update.install', 'system.maintenance'] },
  { id: 'workflows', label: 'Workflows', icon: 'Workflow', description: 'Workflows global ein- und ausschalten, Schutz gegen Schleifen', help: 'workflows#testen-aktivieren-abschalten', edit: ['settings.system'] },
  { id: 'system', label: 'System', icon: 'Server', description: 'Hintergrundaufträge, Version und Systeminformationen', help: 'system#systemstatus', edit: ['settings.system'] },
];

export const settingsPage = (id: string | undefined) => SETTINGS_PAGES.find((p) => p.id === id);
export const settingsPath = (id: string, anchor?: string) => `/einstellungen/${id}${anchor ? `#${anchor}` : ''}`;

/** Anker der früheren Einstellungsseite → neue Adresse (Weiterleitung beim Aufruf von `/einstellungen#…`). */
export const LEGACY_SETTINGS_ANCHORS: Record<string, string> = {
  allgemein: '/einstellungen/organisation',
  darstellung: '/profil#darstellung',
  redaktion: '/einstellungen/redaktion',
  datenschutz: '/einstellungen/datenschutz',
  medien: '/einstellungen/medien',
  betrieb: '/einstellungen/system',
  sicherheit: '/einstellungen/sicherheit',
  benachrichtigungen: '/einstellungen/e-mail',
  sicherung: '/einstellungen/sicherung',
  'sicherung-ausser-haus': '/einstellungen/sicherung#ausser-haus',
  updates: '/einstellungen/updates',
  ueber: '/einstellungen/system',
};

/** ID des Eingabefelds einer Einstellung (Anker für die Suche): `general.timezone` → `s-general-timezone`. */
export const settingsFieldId = (key: string) => `s-${key.replace(/\W/g, '-')}`;
