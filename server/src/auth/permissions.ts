/**
 * Rechte-Katalog. Jedes Recht gehört zu einem Bereich und steht für genau eine Funktion; der Rollen-Editor in der
 * Oberfläche und die Tabelle in der Hilfe werden daraus erzeugt. Grundsatz: Standard ist verweigern. Rollen sind
 * kombinierbar; Rollen und ihre Rechte liegen in der Datenbank (auth/roles.ts), die Vorgaben der mitgelieferten
 * Rollen stehen hier.
 *
 * Bis Version 0.2 gab es rund 20 grobe Rechte (z. B. „Medien verwalten“). Sie bleiben als Sammelbezeichnungen
 * erhalten (LEGACY_PERMISSIONS): Eine Sammelbezeichnung gilt als vorhanden, wenn ALLE darin enthaltenen feinen
 * Rechte vorhanden sind – ältere Prüfungen und gespeicherte Benachrichtigungen funktionieren so unverändert weiter,
 * ohne dass sie mehr erlauben als früher.
 */
export interface PermissionDef {
  id: string;
  module: string;
  label: string;
  /** read = nur lesen; write = ändern; critical = besonders kritisch (separat auditiert) */
  level: 'read' | 'write' | 'critical';
  description: string;
  /** Voraussetzungen: Diese Rechte werden beim Vergeben automatisch mit vergeben (z. B. Ändern setzt Ansehen voraus). */
  requires?: string[];
  /** Verwaltungsrecht: zählt für `security.require_2fa_admins` und für die Meldung „Verwaltungsrechte vergeben“. */
  admin?: boolean;
}

export interface ModuleDef {
  id: string;
  label: string;
}

export const MODULES: ModuleDef[] = [
  { id: 'media', label: 'Medien' },
  { id: 'editorial', label: 'Redaktion' },
  { id: 'approval', label: 'Freigabe' },
  { id: 'publishing', label: 'Veröffentlichung' },
  { id: 'banners', label: 'Banner' },
  { id: 'calendar', label: 'Kalender' },
  { id: 'incidents', label: 'Einsatzliste' },
  { id: 'warnings', label: 'Warnentwürfe und amtliche Warnungen' },
  { id: 'press', label: 'Presse' },
  { id: 'connections', label: 'Verbindungen' },
  { id: 'automations', label: 'Workflows' },
  { id: 'templates', label: 'Designvorlagen' },
  { id: 'users', label: 'Benutzer und Rollen' },
  { id: 'system', label: 'System und Protokolle' },
  { id: 'settings', label: 'Einstellungen' },
];

const P = (id: string, module: string, level: PermissionDef['level'], label: string, description: string, requires: string[] = [], admin = false): PermissionDef => ({
  id,
  module,
  label,
  level,
  description,
  ...(requires.length ? { requires } : {}),
  ...(admin ? { admin: true } : {}),
});

export const PERMISSIONS: PermissionDef[] = [
  /* Medien */
  P('media.view', 'media', 'read', 'Medien ansehen', 'Sammlungen, Ordner und geprüfte Medien ansehen, durchsuchen und einzeln in der öffentlichen Fassung (ohne Standort) laden.'),
  P('media.export', 'media', 'read', 'Medien exportieren (ZIP)', 'Sammeldownloads der öffentlichen Fassungen als ZIP erstellen und laden.', ['media.view']),
  P('media.download_original', 'media', 'write', 'Originale herunterladen', 'Originaldateien mit möglichen Standortdaten einzeln oder als Sammeldownload laden; Sammeldownloads anderer Personen laden.', ['media.view']),
  P('media.collections', 'media', 'write', 'Sammlungen anlegen und bearbeiten', 'Sammlungen anlegen, umbenennen, beschreiben und Fristen ändern. Für „Fotos und Videos sammeln“ im Beitrag zusätzlich „Upload-Links verwalten“.', ['media.view']),
  P('media.upload', 'media', 'write', 'Dateien hochladen', 'Eigene Dateien direkt in eine Sammlung hochladen.', ['media.view']),
  P('media.links', 'media', 'write', 'Upload-Links verwalten', 'Upload-Links erstellen, pausieren, verlängern, erneuern und widerrufen; Optionen je Link ändern.', ['media.view']),
  P('media.review', 'media', 'write', 'Medien sichten und auswählen', 'Sichtungsstand setzen (ausgewählt, zurückgestellt, übersprungen); Namen der Einsendenden und Einwilligungen sehen.', ['media.view']),
  P('media.organize', 'media', 'write', 'Medien ordnen', 'Ordner anlegen und umbenennen, Schlagworte vergeben, Dateien beschriften, verschieben, kopieren und sortieren.', ['media.view']),
  P('media.redact', 'media', 'write', 'Medien unkenntlich machen', 'Bereiche in Bildern unkenntlich machen und Standortdaten je Datei entfernen.', ['media.view']),
  P('media.trash', 'media', 'write', 'Medien löschen (Papierkorb)', 'Dateien, Ordner und Sammlungen in den Papierkorb legen, Papierkorb ansehen und daraus wiederherstellen.', ['media.view']),
  P('media.design', 'media', 'write', 'Upload-Seite gestalten', 'Gestaltung einzelner Upload-Links ändern und Bilder dafür hochladen.', ['media.links']),
  P('media.admin', 'media', 'critical', 'Medien administrieren', 'Papierkorb endgültig leeren, gesperrte Dateien erneut prüfen oder trotzdem freigeben, Standard-Gestaltung der Upload-Seiten, Sicherheitsereignisse, Speicherübersicht und fehlgeschlagene Medienaufträge.', ['media.view'], true),

  /* Redaktion */
  P('post.view', 'editorial', 'read', 'Beiträge ansehen', 'Beiträge, Fassungen, Vorlagen und den Veröffentlichungsstand ansehen.'),
  P('post.create', 'editorial', 'write', 'Beiträge anlegen', 'Neue Beiträge anlegen.', ['post.view']),
  P('post.edit', 'editorial', 'write', 'Beiträge bearbeiten', 'Fassungen schreiben und speichern, Medien übernehmen, Art des Beitrags ändern.', ['post.view']),
  P('post.submit', 'editorial', 'write', 'Beiträge einreichen', 'Eine Fassung zur Freigabe einreichen.', ['post.view']),
  P('post.archive', 'editorial', 'write', 'Beiträge archivieren', 'Beiträge archivieren und aus dem Archiv zurückholen.', ['post.view']),
  P('post.templates', 'editorial', 'write', 'Vorlagen verwalten', 'Textvorlagen anlegen, ändern und löschen.', ['post.view']),
  P('source.view', 'editorial', 'read', 'Quellen ansehen', 'Meldungen aus den abonnierten Quellen (RSS) lesen.'),
  P('source.items', 'editorial', 'write', 'Meldungen aus Quellen bearbeiten', 'Meldungen merken oder ausblenden und als Themenidee (Beitragsentwurf) übernehmen.', ['source.view']),
  P('source.manage', 'editorial', 'write', 'Quellen verwalten', 'Quellen (RSS) hinzufügen, ändern, abrufen und löschen.', ['source.view']),

  /* Freigabe */
  P('approval.post', 'approval', 'critical', 'Beiträge freigeben', 'Eine konkrete Fassung eines Beitrags freigeben oder zurückweisen und eine Freigabe zurücknehmen.', ['post.view']),
  P('approval.banner', 'approval', 'critical', 'Banner freigeben', 'Eingereichte Banner freigeben oder zurückweisen.', ['banner.view']),
  P('approval.incident', 'approval', 'critical', 'Einsatzliste freigeben', 'Eingereichte Einträge der Einsatzliste freigeben oder zurückweisen (auch mehrere auf einmal).', ['incident.view']),
  P('approval.automation', 'approval', 'critical', 'Freigaben in Workflows erteilen', 'Wartende Freigabeschritte laufender Workflows freigeben oder ablehnen.'),

  /* Veröffentlichung */
  P('publish.website', 'publishing', 'critical', 'Auf Website veröffentlichen', 'Freigegebene Fassungen an eine gekoppelte Website übergeben, Aufträge abbrechen, klären und wiederholen.', ['post.view', 'channel.view']),
  P('publish.unpublish', 'publishing', 'critical', 'Von Website zurückziehen', 'Veröffentlichte Beiträge von der Website zurückziehen.', ['post.view']),
  P('publish.social', 'publishing', 'critical', 'In sozialen Kanälen veröffentlichen', 'Freigegebene Fassungen auf Facebook, Instagram (auch als Story), Threads, X, Mastodon und Bluesky veröffentlichen, Teilen von Hand vorbereiten und als geteilt markieren oder als Paket exportieren.', ['post.view', 'connection.view']),
  P('insights.view', 'publishing', 'read', 'Reichweite ansehen', 'Aufrufe und Interaktionen veröffentlichter Social-Posts sehen (nur zusammengefasste Zahlen, keine Personen): je Beitrag, Übersicht und Dashboard-Kachel.', ['post.view']),
  P('publish.social_remove', 'publishing', 'critical', 'Aus sozialen Kanälen entfernen', 'Veröffentlichungen in sozialen Kanälen entfernen oder als entfernt bestätigen.', ['post.view']),
  P('channel.view', 'publishing', 'read', 'Websites ansehen', 'Gekoppelte Websites und ihren Zustand sehen.'),
  P('channel.sites', 'publishing', 'critical', 'Websites koppeln und widerrufen', 'Websites mit der BlaulichtCMS Bridge koppeln, Kopplungscodes erzeugen, Schlüssel widerrufen, Plugin laden.', ['channel.view'], true),
  P('channel.updates', 'publishing', 'critical', 'Bridge-Updates freigeben', 'Neue Versionen der BlaulichtCMS Bridge für die Websites freigeben und den Update-Kanal je Website wählen.', ['channel.view'], true),

  /* Banner */
  P('banner.view', 'banners', 'read', 'Banner ansehen', 'Banner und ihren Stand ansehen.'),
  P('banner.edit', 'banners', 'write', 'Banner bearbeiten', 'Banner anlegen, ändern und zur Freigabe einreichen; aus einer amtlichen Warnung einen Bannerentwurf anlegen.', ['banner.view', 'channel.view']),
  P('banner.publish', 'banners', 'critical', 'Banner veröffentlichen', 'Freigegebene Banner auf der Website schalten und beenden.', ['banner.view']),

  /* Kalender (#200) */
  P('calendar.view', 'calendar', 'read', 'Kalender ansehen', 'Termine, Kategorien und eingelesene Kalender ansehen; geplante Beiträge erscheinen zusätzlich mit „Beiträge ansehen“.'),
  P('calendar.manage', 'calendar', 'write', 'Termine verwalten', 'Eigene Termine und Serien anlegen, ändern und löschen; Kategorien mit Farben verwalten.', ['calendar.view']),
  P('calendar.sources', 'calendar', 'write', 'iCal-Kalender einlesen', 'Externe Kalender (iCal-Links) hinzufügen, testen, ändern, abrufen, schalten und löschen; Empfangsprotokoll ansehen. Die Adressen werden verschlüsselt gespeichert und nicht angezeigt.', ['calendar.view']),
  P('calendar.subscribe', 'calendar', 'write', 'Kalender abonnieren', 'Einen eigenen geheimen iCal-Abo-Link (Outlook, Google, iPhone) erzeugen, erneuern, einstellen und widerrufen. Das Abo enthält nur Titel, Zeit und Kategorie, auf Wunsch die Beschreibung.', ['calendar.view']),

  /* Einsatzliste (#213) */
  P('incident.view', 'incidents', 'read', 'Einsatzliste ansehen', 'Einträge der Einsatzliste, ihren Stand auf der Website und die Einstellungen ansehen.'),
  P('incident.edit', 'incidents', 'write', 'Einsatzliste bearbeiten', 'Einträge anlegen, aus Einsatzmeldungen übernehmen, bearbeiten, importieren (CSV), zur Freigabe einreichen und nicht veröffentlichte Einträge löschen.', ['incident.view', 'channel.view']),
  P('incident.publish', 'incidents', 'critical', 'Einsatzliste veröffentlichen', 'Freigegebene Einträge an die Website übergeben und von der Website zurückziehen.', ['incident.view', 'channel.view']),
  P('incident.settings', 'incidents', 'write', 'Einsatzliste einstellen', 'Erlaubte Ortsangaben (Datenschutz: nur Ortsteile) und die Standard-Website der Einsatzliste festlegen.', ['incident.view'], true),

  /* Warnentwürfe */
  P('warning.view', 'warnings', 'read', 'Warnvorgänge ansehen', 'Warnvorgänge, Fassungen, PDF, Stichwörter und Zuständigkeiten ansehen.'),
  P('warning.draft', 'warnings', 'write', 'Warnentwurf erstellen', 'Warnentwürfe erfassen, speichern und zur Freigabe einreichen.', ['warning.view']),
  P('warning.delete', 'warnings', 'write', 'Warnvorgänge löschen', 'Eigene, noch nicht freigegebene Warnvorgänge löschen; zusammen mit „Warnentwurf freigeben“ auch fremde und freigegebene.', ['warning.view']),
  P('warning.delete_sent', 'warnings', 'critical', 'Versandte Warnvorgänge löschen', 'Bereits versandte Warnvorgänge mit Begründung löschen.', ['warning.delete'], true),
  P('warning.level', 'warnings', 'critical', 'Warnstufe bestätigen', 'Den Warnstufen-Vorschlag ausdrücklich bestätigen oder mit Begründung ändern.', ['warning.view']),
  P('warning.approve', 'warnings', 'critical', 'Warnentwurf freigeben', 'Eine erzeugte PDF-Fassung eines Warnentwurfs freigeben; Prüffragen und Regeln fachlich freigeben.', ['warning.view']),
  P('warning.rules', 'warnings', 'critical', 'Stichwörter und Regeln pflegen', 'Stichwörter (auch Stichwortverzeichnis des Landes übernehmen und eigene Liste importieren), Prüffragen, Warnstufen-Regeln, Vorlagen und Zuständigkeiten pflegen.', ['warning.view'], true),
  P('warning.send', 'warnings', 'critical', 'Warnentwurf versenden', 'Freigegebene Warnentwürfe per E-Mail an die zuständige Stelle senden und den Versand klären.', ['warning.view']),
  P('warning.settings', 'warnings', 'critical', 'Versand einstellen', 'Mailserver, Absender und Testmodus für den Versand von Warnentwürfen einstellen und prüfen.', [], true),
  P('official.view', 'warnings', 'read', 'Amtliche Warnungen ansehen', 'Amtliche Warnungen aus den eingerichteten Warnfeeds sehen.'),
  P('official.dismiss', 'warnings', 'write', 'Amtliche Warnungen ausblenden', 'Amtliche Warnungen als erledigt ausblenden.', ['official.view']),

  /* Presse (#204–#207) */
  P('press.view', 'press', 'read', 'Presseanfragen ansehen', 'Presseanfragen mit Kontaktdaten der Anfragenden, Verlauf, Mails und Anhängen ansehen.'),
  P('press.manage', 'press', 'write', 'Presseanfragen bearbeiten', 'Presseanfragen von Hand erfassen, Status, Zuständigkeit und Frist ändern, mit Einsatz und Beitrag verknüpfen, interne Notizen schreiben und Anfragen löschen.', ['press.view']),
  P('press.reply', 'press', 'write', 'Presseanfragen beantworten', 'Antworten per E-Mail schreiben und senden (bei eingeschalteter Freigabe: zur Freigabe einreichen).', ['press.view']),
  P('press.approve', 'press', 'critical', 'Antworten an die Presse freigeben', 'Eingereichte Antworten auf Presseanfragen freigeben oder zurückweisen (nie die eigene).', ['press.view']),
  P('press.snippets', 'press', 'write', 'Textbausteine verwalten', 'Textbausteine für Antworten auf Presseanfragen anlegen, ändern und löschen.', ['press.view']),
  P('press.mailbox', 'press', 'critical', 'Presse-Postfach einrichten', 'Abruf des Presse-Postfachs (IMAP oder Microsoft 365) einrichten, testen, schalten und das Empfangsprotokoll ansehen.', ['press.view'], true),
  P('press.contacts', 'press', 'write', 'Presseverteiler pflegen', 'Kontakte von Redaktionen und Verteilerlisten anlegen, ändern, löschen, importieren und exportieren.'),
  P('press.release', 'press', 'critical', 'Pressemitteilungen versenden', 'Pressemitteilungen entwerfen und an Verteilerlisten senden; Versandprotokoll ansehen.', ['press.contacts']),

  /* Verbindungen */
  P('connection.view', 'connections', 'read', 'Verbindungen ansehen', 'Verfügbare Verbindungen mit Namen, Art und Zustand sehen (ohne Zugangsdaten und Einstellungen).'),
  P('connection.configure', 'connections', 'critical', 'Verbindungen verwalten', 'Verbindungen (FE2, Feuersoftware Connect, soziale Kanäle, amtliche Warnfeeds) einrichten, ändern, testen, aktivieren und widerrufen.', ['connection.view'], true),
  P('connection.delete', 'connections', 'critical', 'Verbindungen löschen', 'Verbindungen löschen und gelöschte Verbindungen zur Nachvollziehbarkeit einsehen.', ['connection.configure'], true),
  P('connection.private_targets', 'connections', 'critical', 'Interne Zieladressen erlauben', 'Den Abruf von Adressen im internen Netz für eine Verbindung ausdrücklich erlauben.', ['connection.configure'], true),
  P('connection.log', 'connections', 'read', 'Empfangsprotokoll ansehen', 'Empfangsprotokoll eingehender Verbindungen (amtliche Warnungen, FE2, Feuersoftware Connect) mit Entscheidungen und Rohdaten ansehen.', ['connection.configure']),

  /* Automationen */
  P('automation.read', 'automations', 'read', 'Workflows ansehen', 'Workflows, Eingänge, Ausgänge und Laufprotokolle ansehen.'),
  P('automation.manage', 'automations', 'write', 'Workflows verwalten', 'Eingänge, Ausgänge und Workflows anlegen, bearbeiten, testen, aktivieren und deaktivieren. Ausgänge legen nur Entwürfe und Benachrichtigungen an; Freigaben bleiben bei den Menschen.', ['automation.read'], true),
  P('automation.publish', 'automations', 'critical', 'Workflows direkt veröffentlichen lassen', 'Einem Workflow erlauben, markierte Ausgänge ohne menschliche Freigabe zu veröffentlichen bzw. zu versenden (mit Passwortbestätigung, Audit und Sicherheitsmeldung).', ['automation.manage'], true),

  /* Designvorlagen (#208–#210) */
  P('templates.view', 'templates', 'read', 'Designvorlagen ansehen', 'Interne Vorlagen-Bibliothek durchsuchen, Vorlagen mit Nutzungshinweisen ansehen und ihre Dateien (auch ältere Versionen) herunterladen.'),
  P('templates.use', 'templates', 'write', 'Bilder aus Vorlagen erzeugen', 'Befüllbare Bildvorlagen ausfüllen und das erzeugte Bild in den Medien ablegen (auch im Beitragseditor).', ['templates.view', 'media.upload']),
  P('templates.manage', 'templates', 'write', 'Designvorlagen verwalten', 'Vorlagen und Kategorien anlegen, ändern und löschen, neue Versionen und Dateien hochladen, Bildvorlagen im Editor gestalten und eigene Schriften hochladen.', ['templates.view']),

  /* Benutzer und Rollen */
  P('user.view', 'users', 'read', 'Benutzer ansehen', 'Benutzerliste, Rollen und deren Rechte ansehen.'),
  P('user.invite', 'users', 'critical', 'Benutzer einladen', 'Konten einladen, Einladungen und Passwort-Links ausstellen und widerrufen.', ['user.view'], true),
  P('user.edit', 'users', 'write', 'Benutzer umbenennen', 'Anzeigenamen von Konten ändern.', ['user.view'], true),
  P('user.assign_roles', 'users', 'critical', 'Rollen zuweisen', 'Rollen von Konten ändern – höchstens Rollen, deren Rechte man selbst vollständig hat.', ['user.view'], true),
  P('user.lock', 'users', 'critical', 'Konten sperren und entsperren', 'Konten deaktivieren und reaktivieren, Sperren nach Fehlversuchen aufheben, Zwei-Faktor-Anmeldung zurücksetzen.', ['user.view'], true),
  P('user.sessions', 'users', 'write', 'Sitzungen beenden', 'Ein Konto auf allen Geräten abmelden und gemerkte Geräte entfernen.', ['user.view'], true),
  P('user.delete', 'users', 'critical', 'Benutzer löschen', 'Konten endgültig löschen.', ['user.view'], true),
  P('role.manage', 'users', 'critical', 'Rollen verwalten', 'Eigene Rollen anlegen, Rechte von Rollen ändern, Rollen löschen – höchstens mit Rechten, die man selbst hat.', ['user.view'], true),

  /* System und Protokolle */
  P('system.status', 'system', 'read', 'Systemstatus ansehen', 'Zustand der Dienste, Warteschlange, Speicher und Version ansehen.'),
  P('system.logs', 'system', 'read', 'Systemprotokoll ansehen', 'Technische Protokolle (Fehler, Warnungen) ansehen.'),
  P('audit.view', 'system', 'read', 'Audit-Protokoll ansehen', 'Wer hat wann was geändert; Unversehrtheit des Protokolls prüfen.'),
  P('backup.manage', 'system', 'critical', 'Sicherungen erstellen', 'Sicherungen ansehen, erstellen und den Zeitplan einstellen.', ['settings.view'], true),
  P('backup.download', 'system', 'critical', 'Sicherungen herunterladen', 'Sicherungsdateien (gesamter Datenbestand) herunterladen.', ['backup.manage'], true),
  P('update.view', 'system', 'read', 'Updates ansehen', 'Installierte und verfügbare Version sowie den Verlauf der Updates ansehen.'),
  P('update.install', 'system', 'critical', 'Updates einstellen und installieren', 'Nach Updates suchen, Update-Einstellungen ändern, Vorabprüfung ausführen und Updates installieren.', ['update.view'], true),
  P('system.maintenance', 'system', 'critical', 'Wartungsmodus schalten', 'Den Wartungsmodus ein- und ausschalten.', ['system.status'], true),
  P('system.retention', 'system', 'critical', 'Löschfristen sofort anwenden', 'Die eingestellten Löschfristen sofort anwenden, statt auf den nächtlichen Lauf zu warten.', ['settings.view'], true),
  P('privacy.manage', 'system', 'critical', 'Datenschutzanfragen bearbeiten', 'Personenbezogene Daten über alle Bereiche suchen, als Auskunft exportieren und je Treffer löschen oder pseudonymisieren (Art. 15/17 DSGVO).', [], true),
  P('dashboard.templates', 'system', 'write', 'Dashboard-Vorlagen speichern', 'Gemeinsame Dashboards für alle oder für einzelne Rollen speichern.', [], true),

  /* Einstellungen */
  P('settings.view', 'settings', 'read', 'Einstellungen ansehen', 'Alle Einstellungen und die Vorschau der Löschfristen ansehen (ohne Passwörter).'),
  P('settings.general', 'settings', 'write', 'Allgemeine Einstellungen ändern', 'Name der Instanz, Organisation, Bundesland (Stichwortverzeichnis), Adresse, Zeitzone.', ['settings.view'], true),
  P('settings.security', 'settings', 'critical', 'Sicherheitseinstellungen ändern', 'Zwei-Faktor-Pflicht, Sitzungen, Kontosperre, Passwortlänge, Sicherheitsmeldungen, Gültigkeit von Einladungen, interne Zieladressen.', ['settings.view'], true),
  P('settings.privacy', 'settings', 'critical', 'Datenschutzeinstellungen ändern', 'Löschfristen, Aufbewahrung der Protokolle, Angaben zu Verantwortlichen, Datenschutzhinweise, Datenschutzerklärung und Impressum.', ['settings.view'], true),
  P('settings.media', 'settings', 'write', 'Medieneinstellungen ändern', 'Dateigrößen, erlaubte Dateitypen, Vorgaben für Upload-Links, Prüftiefe und Speichergrenzen.', ['settings.view'], true),
  P('settings.editorial', 'settings', 'critical', 'Redaktionseinstellungen ändern', 'Vier-Augen-Prinzip und weitere Vorgaben für Redaktion und Freigabe.', ['settings.view'], true),
  P('settings.mail', 'settings', 'critical', 'E-Mail-Versand und Push einstellen', 'Weg für E-Mails wählen (SMTP oder Microsoft 365), Microsoft 365 einrichten und prüfen, Push- und E-Mail-Benachrichtigungen global schalten.', ['settings.view'], true),
  P('settings.system','settings', 'write', 'Systemeinstellungen ändern', 'Parallele Aufträge, Ausführung der Workflows und weitere technische Einstellungen.', ['settings.view'], true),
];

export const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);
const BY_ID = new Map(PERMISSIONS.map((p) => [p.id, p]));
export const permissionDef = (id: string) => BY_ID.get(id);

/**
 * Grobe Rechte bis Version 0.2 → feine Rechte. Grundlage für die Vorgaben der mitgelieferten Rollen (jede Rolle
 * behält beim Update genau ihre bisherigen Möglichkeiten) und für Sammelbezeichnungen in Prüfungen.
 */
export const LEGACY_PERMISSIONS: Record<string, string[]> = {
  'media.read': ['media.view', 'media.export'],
  'media.manage': ['media.view', 'media.download_original', 'media.collections', 'media.upload', 'media.links', 'media.review', 'media.organize', 'media.redact', 'media.trash', 'media.design'],
  'media.admin': ['media.view', 'media.admin'],
  'post.read': ['post.view', 'source.view', 'banner.view', 'channel.view', 'official.view', 'incident.view'],
  'post.edit': ['post.view', 'post.create', 'post.edit', 'post.submit', 'post.archive', 'post.templates', 'source.view', 'source.items', 'source.manage', 'channel.view', 'banner.view', 'banner.edit', 'official.view', 'official.dismiss', 'connection.view', 'press.view', 'press.manage', 'press.reply', 'press.snippets', 'press.contacts', 'incident.view', 'incident.edit'],
  'post.approve': ['post.view', 'banner.view', 'approval.post', 'approval.banner', 'approval.automation', 'press.view', 'press.approve', 'incident.view', 'approval.incident'],
  'post.publish': ['post.view', 'banner.view', 'channel.view', 'connection.view', 'publish.website', 'publish.unpublish', 'publish.social', 'publish.social_remove', 'banner.publish', 'press.view', 'press.contacts', 'press.release', 'incident.view', 'incident.publish'],
  'channel.manage': ['channel.view', 'channel.sites', 'channel.updates'],
  'warning.draft': ['warning.view', 'warning.draft', 'warning.delete'],
  'warning.level': ['warning.view', 'warning.level'],
  'warning.approve': ['warning.view', 'warning.approve', 'warning.delete'],
  'warning.rules': ['warning.view', 'warning.rules'],
  'warning.send': ['warning.view', 'warning.send'],
  'connection.manage': ['connection.view', 'connection.configure', 'connection.delete', 'connection.log'],
  'automation.read': ['automation.read'],
  'automation.manage': ['automation.read', 'automation.manage'],
  'automation.publish': ['automation.read', 'automation.manage', 'automation.publish'],
  'user.read': ['user.view'],
  'user.manage': ['user.view', 'user.invite', 'user.edit', 'user.assign_roles', 'user.lock', 'user.sessions', 'user.delete'],
  'audit.read': ['audit.view'],
  'system.read': ['system.status', 'system.logs', 'settings.view', 'update.view'],
  'system.manage': ['settings.view', 'settings.general', 'settings.security', 'settings.privacy', 'settings.media', 'settings.editorial', 'settings.system', 'system.status', 'system.maintenance', 'system.retention', 'backup.manage', 'backup.download', 'update.view', 'update.install', 'dashboard.templates', 'warning.settings', 'press.view', 'press.mailbox', 'incident.view', 'incident.settings'],
  'privacy.manage': ['privacy.manage'],
};

/** Feine Rechte samt Voraussetzungen (transitiv), in Katalogreihenfolge. Unbekannte Bezeichnungen entfallen. */
export function withRequirements(ids: Iterable<string>): string[] {
  const set = new Set<string>();
  const add = (id: string) => {
    const def = BY_ID.get(id);
    if (!def || set.has(id)) return;
    set.add(id);
    for (const r of def.requires ?? []) add(r);
  };
  for (const id of ids) add(id);
  return PERMISSION_IDS.filter((id) => set.has(id));
}

/** Grobe Rechte (alter Stand) → feine Rechte; nur für die Vorgaben der mitgelieferten Rollen und Tests. */
export function expandLegacy(ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of ids) out.push(...(LEGACY_PERMISSIONS[id] ?? []));
  return withRequirements(out);
}

/** Sammelbezeichnungen, die mit diesen feinen Rechten vollständig abgedeckt sind. */
export function legacyHeld(fine: Set<string>): string[] {
  return Object.entries(LEGACY_PERMISSIONS)
    .filter(([id, parts]) => !BY_ID.has(id) && parts.every((p) => fine.has(p)))
    .map(([id]) => id);
}

export interface RoleDef {
  id: string;
  label: string;
  description: string;
  permissions: string[];
}

export const ADMIN_ROLE = 'platform_admin';

/** Stand bis Version 0.2: mitgelieferte Rollen mit ihren groben Rechten (Grundlage der Vorgaben, nicht ändern). */
export const LEGACY_ROLE_PERMISSIONS: Record<string, string[]> = {
  media_manager: ['media.read', 'media.manage', 'post.read'],
  editor: ['media.read', 'media.manage', 'post.read', 'post.edit', 'automation.read'],
  approver: ['media.read', 'post.read', 'post.approve', 'audit.read', 'automation.read'],
  publisher: ['media.read', 'post.read', 'post.publish'],
  warning_author: ['warning.draft'],
  warning_approver: ['warning.draft', 'warning.level', 'warning.approve'],
  warning_sender: ['warning.send'],
  viewer: ['media.read', 'post.read'],
};

/**
 * Rechte, die es erst nach Version 0.2 gibt und die mitgelieferte Rollen ohne eigene Anpassung zusätzlich als Vorgabe
 * bekommen (die Sammelbezeichnungen bleiben davon unberührt). Angepasste Rollen erhalten sie nicht automatisch.
 */
export const ROLE_DEFAULT_ADDITIONS: Record<string, string[]> = {
  media_manager: ['templates.view', 'templates.use', 'templates.manage', 'calendar.view', 'calendar.subscribe'],
  editor: ['templates.view', 'templates.use', 'templates.manage', 'calendar.view', 'calendar.manage', 'calendar.sources', 'calendar.subscribe', 'insights.view'],
  approver: ['templates.view', 'calendar.view', 'calendar.subscribe', 'insights.view'],
  publisher: ['templates.view', 'calendar.view', 'calendar.subscribe', 'insights.view'],
  viewer: ['templates.view', 'calendar.view', 'calendar.subscribe', 'insights.view'],
};

const sys = (id: string, label: string, description: string): RoleDef => ({
  id,
  label,
  description,
  permissions: id === ADMIN_ROLE ? [...PERMISSION_IDS] : withRequirements([...expandLegacy(LEGACY_ROLE_PERMISSIONS[id]), ...(ROLE_DEFAULT_ADDITIONS[id] ?? [])]),
});

/** Mitgelieferte Rollen mit ihren Vorgaben. „Administration“ hat immer alle Rechte, auch künftige. */
export const SYSTEM_ROLES: RoleDef[] = [
  sys('platform_admin', 'Administration', 'Vollzugriff: Konten, Rechte, Kanäle, Systemzustand, Sicherungen. Hat immer alle Rechte und lässt sich nicht ändern.'),
  sys('media_manager', 'Medienverwaltung', 'Pflegt Sammlungen und Upload-Links, sichtet und wählt Medien aus.'),
  sys('editor', 'Redaktion', 'Erstellt Beiträge, übernimmt Medien und reicht Fassungen zur Freigabe ein.'),
  sys('approver', 'Freigabe', 'Gibt geprüfte Fassungen frei.'),
  sys('publisher', 'Veröffentlichung', 'Übergibt freigegebene Fassungen an die Zielkanäle.'),
  sys('warning_author', 'Warnentwurf', 'Erfasst Warnentwürfe (Erstmeldung, Aktualisierung, Entwarnung).'),
  sys('warning_approver', 'Warnfreigabe', 'Bestätigt Warnstufen, gibt Warnentwürfe und Regeln fachlich frei.'),
  sys('warning_sender', 'Warnversand', 'Versendet freigegebene Warnentwürfe an die zuständige Stelle.'),
  // Ohne Systemprotokolle (Stacktraces, Pfade) und Einstellungen (Mailserver): Sache der Administration
  sys('viewer', 'Lesezugriff', 'Sieht Beiträge, Medien und deren Status, ändert nichts.'),
];

export const SYSTEM_ROLE_IDS = SYSTEM_ROLES.map((r) => r.id);

/* ------------------------------------------------------------------------------------------------------------------
 * Aktueller Rollenstand im Arbeitsspeicher. Vorbelegt mit den Vorgaben; auth/roles.ts lädt den Stand der Datenbank
 * und ersetzt ihn bei jeder Änderung. Die Rechteprüfung selbst bleibt dadurch synchron und ohne Datenbankzugriff.
 * ---------------------------------------------------------------------------------------------------------------- */

export interface ActiveRole extends RoleDef {
  system: boolean;
  /** Mitgelieferte Rolle mit geänderten Rechten (weicht von der Vorgabe ab). */
  customized: boolean;
}

let active = new Map<string, ActiveRole>(SYSTEM_ROLES.map((r) => [r.id, { ...r, system: true, customized: false }]));

export function setActiveRoles(roles: ActiveRole[]) {
  const next = new Map<string, ActiveRole>();
  for (const r of roles) next.set(r.id, r.id === ADMIN_ROLE ? { ...r, permissions: [...PERMISSION_IDS], customized: false } : { ...r, permissions: withRequirements(r.permissions) });
  // Die Administration gibt es immer – auch wenn die Tabelle (noch) leer ist
  if (!next.has(ADMIN_ROLE)) next.set(ADMIN_ROLE, { ...SYSTEM_ROLES[0], system: true, customized: false });
  active = next;
}

export function resetActiveRoles() {
  active = new Map(SYSTEM_ROLES.map((r) => [r.id, { ...r, system: true, customized: false }]));
}

export const activeRoles = (): ActiveRole[] => [...active.values()];
export const activeRole = (id: string): ActiveRole | undefined => active.get(id);
export const roleExists = (id: string): boolean => active.has(id);
export const roleLabel = (id: string): string => active.get(id)?.label ?? id;

/** Feine Rechte einer Rollenkombination (ohne Sammelbezeichnungen) – Grundlage für Vergleiche und die Vergabe. */
export function finePermissionsFor(roles: string[]): Set<string> {
  if (roles.includes(ADMIN_ROLE) && active.has(ADMIN_ROLE)) return new Set(PERMISSION_IDS);
  const set = new Set<string>();
  for (const r of roles) for (const p of active.get(r)?.permissions ?? []) set.add(p);
  return set;
}

/** Wirksame Rechte: feine Rechte plus die damit vollständig abgedeckten Sammelbezeichnungen. */
export function permissionsFor(roles: string[]): Set<string> {
  const set = finePermissionsFor(roles);
  for (const l of legacyHeld(set)) set.add(l);
  return set;
}

export function isAdminRoleSet(roles: string[]): boolean {
  return roles.includes(ADMIN_ROLE);
}

const ADMIN_PERMISSIONS = new Set(PERMISSIONS.filter((p) => p.admin).map((p) => p.id));
const CRITICAL_PERMISSIONS = new Set(PERMISSIONS.filter((p) => p.level === 'critical').map((p) => p.id));

/** Hat die Rollenkombination Verwaltungsrechte (Konten, Rollen, Einstellungen, Sicherungen, Verbindungen …)? */
export function hasAdminPermissions(roles: string[]): boolean {
  if (isAdminRoleSet(roles)) return true;
  for (const p of finePermissionsFor(roles)) if (ADMIN_PERMISSIONS.has(p)) return true;
  return false;
}

export const isAdminPermission = (id: string) => ADMIN_PERMISSIONS.has(id);
export const isCriticalPermission = (id: string) => CRITICAL_PERMISSIONS.has(id);

/** Recht für das Ändern einer Einstellung, abgeleitet aus dem Schlüssel (`bereich.name`). */
export function settingPermission(key: string): string {
  const area = key.split('.')[0];
  switch (area) {
    case 'general':
      return 'settings.general';
    case 'privacy':
    case 'retention':
    case 'legal':
      return 'settings.privacy';
    case 'media':
      return 'settings.media';
    case 'editorial':
    case 'press':
      return 'settings.editorial';
    case 'jobs':
    case 'automations':
      return 'settings.system';
    case 'backup':
      return 'backup.manage';
    case 'mail':
    case 'm365':
    case 'notify':
    case 'push':
      return 'settings.mail';
    // Sicherheit, Einladungen und alles Unbekannte: das strengste Recht
    default:
      return 'settings.security';
  }
}

const LEVEL_LABEL: Record<PermissionDef['level'], string> = { read: 'lesen', write: 'ändern', critical: 'kritisch' };

/** Tabelle aller Rechte für die Hilfe (docs/hilfe/benutzer-rollen.md, zwischen den Markierungen `rechte:start/ende`). */
export function permissionTableMarkdown(): string {
  const out: string[] = [];
  for (const m of MODULES) {
    out.push(`**${m.label}**`, '', '| Recht | Stufe | Erlaubt | Setzt voraus |', '| --- | --- | --- | --- |');
    for (const p of PERMISSIONS.filter((x) => x.module === m.id)) {
      const req = (p.requires ?? []).map((r) => BY_ID.get(r)!.label).join(', ') || '–';
      out.push(`| ${p.label} | ${LEVEL_LABEL[p.level]} | ${p.description} | ${req} |`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/**
 * @deprecated Nur noch die mitgelieferten Rollen. Für Auswahllisten und Prüfungen `activeRoles()` bzw.
 * `roleExists()` verwenden – sie kennen auch selbst angelegte Rollen.
 */
export const ROLES: RoleDef[] = SYSTEM_ROLES;
/** @deprecated siehe ROLES */
export const ROLE_IDS: string[] = SYSTEM_ROLE_IDS;
