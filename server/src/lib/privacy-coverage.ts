/**
 * Abdeckung der Datenschutzanfragen (#141, #245): Für JEDE Tabelle der Datenbank steht hier, ob und wie
 * Verwaltung → Datenschutzanfragen (routes/privacy.ts) sie durchsucht – oder warum sie bewusst ausgenommen ist.
 *
 * test/privacy.test.ts prüft gegen das echte Schema nach allen Migrationen:
 * - jede Tabelle ist hier eingetragen (neue Tabelle ohne Eintrag ⇒ Test schlägt fehl),
 * - in durchsuchten Tabellen ist jede Spalte, die nach Personenbezug aussieht (PERSON_COLUMN), entweder durchsucht
 *   (`search`) oder mit Begründung als nicht durchsucht vermerkt (`other`),
 * - jede eingetragene Spalte existiert und routes/privacy.ts nennt Tabelle und durchsuchte Spalten.
 *
 * Neue Tabelle oder Spalte mit Personenbezug: in privacySearch aufnehmen (Treffer, ggf. Löschen/Pseudonymisieren,
 * Export) und hier eintragen – oder mit Begründung ausnehmen und die Begründung in docs/datenschutz.md
 * (Abschnitt „Betroffenenrechte“) nachziehen.
 */

/** Spaltennamen, die auf Personenbezug hindeuten (nur bei Text-, Array-, JSON- und Binärspalten geprüft). */
export const PERSON_COLUMN =
  /(^|_)(name|names|email|mail|phone|address|addresses|ip|note|notes|body|text|description|title|subject|location|place|report|recipients?|uploader|contact|user_agent|consent|origin|outlet|label|fields|payload|summary|message|comment|filename|data|details?|answers|headline|purpose)($|_)/;

/** Spaltentypen, die geprüft werden (udt_name in information_schema). */
export const PERSON_COLUMN_TYPES = new Set(['text', 'varchar', 'bpchar', '_text', 'jsonb', 'json', 'bytea', 'inet']);

export type TableCoverage =
  /** Durchsucht: Art des Treffers, durchsuchte Spalten, weitere personenbezogene Spalten mit Begründung */
  | { hit: string; search: string[]; other?: Record<string, string> }
  /** Bewusst nicht Teil der Datenschutzsuche – Begründung (steht auch in docs/datenschutz.md) */
  | { excluded: string };

/**
 * Weitere Texte der Redaktion ohne eigene Löschaktion (Vorlagen, Sammlungen, Banner, Textbausteine …): werden
 * durchsucht und als Treffer „nur Auskunft“ mit Verweis auf die Stelle zum Bearbeiten gezeigt. Spalten: `x[]` =
 * Textliste, `x{}` = JSON (als Text durchsucht). Die SQL-Abfrage entsteht aus genau dieser Liste (routes/privacy.ts).
 */
export interface TextArea {
  table: string;
  area: string;
  columns: string[];
  /** Ausdruck für die Überschrift des Treffers (Spalten der Tabelle als `t.`) */
  titleSql: string;
  /** Ausdruck für den Verweis (Pfad der Oberfläche) */
  linkSql: string;
  note: string;
  other?: Record<string, string>;
}

export const TEXT_AREAS: TextArea[] = [
  { table: 'collections', area: 'Sammlung', columns: ['title', 'purpose', 'note'], titleSql: 't.title', linkSql: `'/medien/' || t.id`, note: 'In der Sammlung unter Medien bearbeiten.' },
  { table: 'collection_folders', area: 'Ordner einer Sammlung', columns: ['name'], titleSql: 't.name', linkSql: `'/medien/' || t.collection_id`, note: 'Ordner in der Sammlung umbenennen.' },
  { table: 'media_tags', area: 'Schlagwort', columns: ['name'], titleSql: 't.name', linkSql: `'/medienverwaltung'`, note: 'Schlagwort unter Verwaltung → Medienverwaltung umbenennen oder löschen.' },
  {
    table: 'upload_links',
    area: 'Upload-Link',
    columns: ['label', 'welcome_text', 'consent_text'],
    titleSql: 't.label',
    linkSql: `'/medien/' || t.collection_id`,
    note: 'Bezeichnung und Texte im Upload-Link der Sammlung ändern.',
    other: { token_enc: 'Link-Token (verschlüsselt), kein Personenbezug', fields: 'Auswahl der abgefragten Felder (Konfiguration)' },
  },
  { table: 'banners', area: 'Banner', columns: ['title', 'text', 'link_text'], titleSql: 't.title', linkSql: `'/banner'`, note: 'Banner bearbeiten bzw. beenden.' },
  {
    table: 'banner_jobs',
    area: 'Banner (Auftrag an die Website)',
    columns: ['payload{}'],
    titleSql: `coalesce(t.payload->>'title', 'Banner')`,
    linkSql: `'/banner'`,
    note: 'Kopie des Banners im Auftrag an die Website; Banner bearbeiten bzw. beenden.',
  },
  { table: 'post_templates', area: 'Beitragsvorlage', columns: ['name', 'title', 'body', 'excerpt'], titleSql: 't.name', linkSql: `'/beitragsvorlagen'`, note: 'Beitragsvorlage unter Einrichtung → Beitragsvorlagen bearbeiten.' },
  {
    table: 'warning_templates',
    area: 'Vorlage für Warnentwürfe',
    columns: ['name', 'pdf_title', 'pdf_footer', 'mail_subject', 'mail_body', 'note'],
    titleSql: 't.name',
    linkSql: `'/stichwoerter-regeln'`,
    note: 'Unter Einrichtung → Stichwörter & Regeln ändern (neue Version).',
    other: { fields: 'Felddefinitionen der Vorlage (Konfiguration)' },
  },
  { table: 'design_templates', area: 'Designvorlage', columns: ['title', 'description', 'usage_note', 'tags[]'], titleSql: 't.title', linkSql: `'/designvorlagen/' || t.id`, note: 'Designvorlage bearbeiten. Bilder in Vorlagen werden nicht inhaltlich durchsucht.' },
  { table: 'design_template_versions', area: 'Designvorlage (Versionshinweis)', columns: ['note'], titleSql: `'Version ' || t.number`, linkSql: `'/designvorlagen/' || t.template_id`, note: 'Versionshinweis der Designvorlage.' },
  { table: 'design_template_files', area: 'Designvorlage (Datei)', columns: ['original_name'], titleSql: 't.original_name', linkSql: `'/designvorlagen/' || t.template_id`, note: 'Datei der Designvorlage.' },
  { table: 'press_snippets', area: 'Textbaustein (Presse)', columns: ['title', 'body'], titleSql: 't.title', linkSql: `'/presse/textbausteine'`, note: 'Textbaustein unter Presse → Textbausteine bearbeiten.' },
  {
    table: 'press_releases',
    area: 'Pressemitteilung',
    columns: ['subject', 'body'],
    titleSql: 't.subject',
    linkSql: `'/presse/mitteilungen?id=' || t.id`,
    note: 'Entwürfe lassen sich unter Presse → Pressemitteilungen bearbeiten oder löschen; versandte Mitteilungen sind bei den Empfängern nicht erreichbar.',
  },
  { table: 'press_lists', area: 'Verteilerliste', columns: ['name', 'description'], titleSql: 't.name', linkSql: `'/presse/verteiler'`, note: 'Liste unter Presse → Presseverteiler umbenennen.' },
  { table: 'calendar_sources', area: 'Kalenderquelle', columns: ['name'], titleSql: 't.name', linkSql: `'/kalender'`, note: 'Bezeichnung der iCal-Quelle ändern.', other: { last_error: 'technische Fehlermeldung des Abrufs' } },
  { table: 'automations', area: 'Workflow', columns: ['name', 'description', 'graph{}'], titleSql: 't.name', linkSql: `'/workflows/' || t.id`, note: 'Texte im Workflow ändern (neue Version).' },
  { table: 'automation_versions', area: 'Workflow (freigegebene Version)', columns: ['graph{}'], titleSql: `'Version ' || t.version`, linkSql: `'/workflows/' || t.automation_id`, note: 'Frühere aktive Version eines Workflows; gilt bis zum Löschen des Workflows.' },
  { table: 'automation_inputs', area: 'Workflow-Auslöser', columns: ['name', 'config{}'], titleSql: 't.name', linkSql: `'/workflows/ausloeser'`, note: 'Auslöser unter Einrichtung → Workflows → Auslöser bearbeiten.' },
  { table: 'automation_outputs', area: 'Workflow-Aktion', columns: ['name', 'config{}'], titleSql: 't.name', linkSql: `'/workflows/aktionen'`, note: 'Aktion unter Einrichtung → Workflows → Aktionen bearbeiten.' },
  {
    table: 'app_logs',
    area: 'Systemprotokoll',
    columns: ['message', 'details{}'],
    titleSql: `t.source || ': ' || left(t.message, 120)`,
    linkSql: `'/protokolle'`,
    note: 'Technische Meldung; wird nach der Frist retention.log_days gelöscht.',
  },
  { table: 'update_history', area: 'Update-Verlauf', columns: ['actor_name', 'message', 'notes'], titleSql: `coalesce(t.from_version, '') || ' → ' || coalesce(t.to_version, '')`, linkSql: `'/system'`, note: 'Nachweis der Updates (handelnde Person wie im Audit).' },
];

const SEARCHED: Record<string, TableCoverage> = {
  users: {
    hit: 'user',
    search: ['name', 'email'],
    other: { preferences: 'Einstellungen der Person (Benachrichtigungen, Ansicht) – mit dem Konto gelöscht' },
  },
  sessions: { hit: 'session', search: ['ip'], other: { user_agent: 'mit der Sitzung angezeigt' } },
  trusted_devices: { hit: 'user', search: [], other: { user_agent: 'als Anzahl beim Konto angezeigt; mit dem Konto gelöscht' } },
  push_subscriptions: { hit: 'user', search: [], other: { label: 'Gerätebezeichnung beim Konto angezeigt' } },
  calendar_feeds: { hit: 'user', search: [] },
  invitations: { hit: 'user', search: [] },
  media: {
    hit: 'media',
    search: ['uploader_note', 'original_name', 'display_name', 'description', 'internal_note', 'alt_text', 'uploader', 'upload_ref'],
    other: { client_key: 'technische Kennung des Uploads', location_strip_error: 'technische Fehlermeldung der Standortbereinigung' },
  },
  upload_sessions: { hit: 'upload_session', search: ['note', 'file_name', 'uploader', 'upload_ref'] },
  public_security_events: { hit: 'security_event', search: ['ip_hash'], other: { detail: 'technische Angabe zum Ereignis, keine Namen' } },
  warnings: { hit: 'warning', search: [] },
  warning_revisions: { hit: 'warning', search: ['data', 'level_decision'], other: { answers: 'Antworten auf Fragen zum Stichwort (Auswahlwerte)' } },
  warning_approvals: { hit: 'warning', search: ['note'] },
  warning_sends: { hit: 'warning', search: ['recipients', 'intended_recipients', 'ack_note', 'smtp_response', 'subject'], other: { message_id: 'Message-ID der Mail (technische Kennung)' } },
  warning_sends_body: { hit: 'warning', search: ['body'] },
  responsibilities: { hit: 'responsibility', search: ['name', 'area', 'recipients'] },
  fe2_events: { hit: 'fe2_event', search: ['title', 'fields'], other: { payload_hash: 'Prüfsumme der Meldung' } },
  posts: { hit: 'post', search: [], other: { title: 'Titel der aktuellen Fassung (in post_revisions durchsucht)' } },
  post_revisions: { hit: 'post', search: ['title', 'body', 'excerpt', 'variants', 'change_note', 'media_alt'] },
  approvals: { hit: 'post', search: ['note'] },
  audit_events: { hit: 'audit', search: ['actor_name', 'object_label', 'details', 'ip'] },
  notifications: { hit: 'notification', search: ['title', 'body'] },
  press_requests: { hit: 'press_request', search: ['contact_name', 'contact_email', 'contact_phone', 'outlet', 'topic', 'body'] },
  press_request_events: { hit: 'press_request', search: ['text'], other: { actor_name: 'Name der handelnden Person aus der Redaktion', details: 'Stand und Frist (keine Kontaktdaten)' } },
  press_messages: {
    hit: 'press_request',
    search: ['from_address', 'from_name', 'to_addresses', 'cc_addresses', 'subject', 'text_body', 'skipped_attachments', 'decision_note'],
    other: {
      html_body: 'gleicher Inhalt wie text_body (Textteil der Mail bzw. daraus abgeleitet); mit der Anfrage gelöscht',
      message_id: 'Message-ID der Mail (technische Kennung)',
    },
  },
  press_attachments: { hit: 'press_request', search: ['filename'], other: { data: 'Inhalt der Anhänge (nicht durchsuchbar); mit der Anfrage exportiert und gelöscht' } },
  press_mailbox_log: { hit: 'press_mailbox_log', search: ['subject', 'from_address', 'detail'] },
  press_contacts: { hit: 'press_contact', search: ['name', 'email', 'phone', 'note', 'outlet'], other: { origin: 'Herkunft (mit dem Kontakt angezeigt)', consent: 'Einwilligung/Rechtsgrundlage (mit dem Kontakt angezeigt)' } },
  press_list_members: { hit: 'press_contact', search: [] },
  press_release_recipients: {
    hit: 'press_recipient',
    search: ['email', 'name'],
    other: { error: 'Fehlermeldung des Mailservers – beim Pseudonymisieren entfernt', message_id: 'Message-ID der Mail (technische Kennung)' },
  },
  calendar_events: { hit: 'calendar_event', search: ['title', 'description', 'location', 'tags'] },
  incident_entries: { hit: 'incident_entry', search: ['title', 'location', 'report', 'keyword_label', 'vehicles', 'units', 'rejected_note'] },
  incident_jobs: { hit: 'incident_entry', search: ['payload', 'error'] },
};

const EXCLUDED: Record<string, string> = {
  schema_migrations: 'Technik: Liste der angewendeten Migrationen.',
  settings: 'Konfiguration der Instanz (Angaben der Organisation wie Verantwortliche Stelle); keine Daten Betroffener.',
  secrets: 'Zugangsdaten (verschlüsselt) für Verbindungen, Postfach, Sicherung; keine Daten Betroffener.',
  roles: 'Rollen und Rechte.',
  api_keys: 'API-Schlüssel der Organisation: Bezeichnung, Prüfsumme, Rollen.',
  auth_throttle: 'Sperrzähler nach Fehlversuchen: Prüfsumme aus Konto und Gerät, nach einem Tag gelöscht.',
  idempotency_records: 'Wiederholschutz für Anfragen (zwischengespeicherte Antwort), nach 30 Tagen gelöscht.',
  jobs: 'Auftragswarteschlange: nur Kennungen der Objekte; erledigte Aufträge nach 7, abgebrochene nach 30 Tagen gelöscht.',
  worker_heartbeats: 'Technik: Lebenszeichen der Hintergrunddienste.',
  media_tokens: 'Kurzlebige Download-Token (Prüfsumme).',
  legacy_links: 'Prüfsummen früherer Link-Token.',
  media_tag_links: 'Zuordnung Datei ↔ Schlagwort (nur Kennungen).',
  exports: 'Sammeldownloads: Kennungen der Dateien und Bezeichnung; verfallen nach media.export_hours; das Löschen einer Datei verwirft sie.',
  backups: 'Sicherungsläufe: Dateiname, Größe, Stand. Die Sicherungen selbst sind Kopien (Fristen in docs/datenschutz.md).',
  backup_offsite: 'Konfiguration der Sicherung außer Haus (Ziel, Benutzername; Passwort verschlüsselt).',
  restore_drills: 'Probe-Wiederherstellungen: Stand und Zähler.',
  bridge_releases: 'Freigegebene Versionen der BlaulichtCMS Bridge.',
  import_runs: 'Importläufe: Prüfsumme und Zähler.',
  wp_sites: 'Gekoppelte Websites (Name, Adresse, Prüfsummen).',
  connections: 'Verbindungen: Konfiguration und Konto der Organisation beim Dienst; Zugangsdaten verschlüsselt.',
  connection_receipts: 'Empfangsprotokoll der Verbindungen: nur geschwärzte Einsatzdaten, kurze Frist (privacy.receipt_days) – bewusst ausgenommen.',
  connection_receipt_items: 'Empfangsprotokoll der Verbindungen (je Meldung) – bewusst ausgenommen, siehe connection_receipts.',
  connection_receipt_raws: 'Rohdaten des Empfangsprotokolls, nur geschwärzt – bewusst ausgenommen, siehe connection_receipts.',
  connection_seen_events: 'Nur Prüfsummen bereits übernommener Einsätze.',
  official_warnings: 'Amtliche Warnungen: öffentlich, keine personenbezogenen Daten.',
  rss_feeds: 'Öffentliche Nachrichtenquellen (RSS).',
  rss_items: 'Öffentliche Meldungen aus RSS-Quellen.',
  automation_runs: 'Workflow-Laufprotokolle: Eingangsdaten nur über die Allowlist, gekürzt, kurze Frist (privacy.automation_run_days) – bewusst ausgenommen.',
  automation_steps: 'Workflow-Laufprotokolle (je Schritt) – bewusst ausgenommen, siehe automation_runs.',
  automation_approvals: 'Freigaben in Workflow-Läufen – bewusst ausgenommen, siehe automation_runs.',
  automation_dedup: 'Nur Prüfsummen für „Einmal je Vorgang“.',
  publications: 'Veröffentlichungsstand je Website (Kennungen, Status, Fehlermeldung); Inhalte stehen in der Fassung des Beitrags.',
  social_publications: 'Veröffentlichungsstand je sozialem Netzwerk (Kennungen, Status, Summen der Statistik); Inhalte stehen in der Fassung des Beitrags.',
  social_insights: 'Statistik: nur Summen je eigenem Beitrag, keine Personen.',
  calendar_categories: 'Kategorien des Kalenders (Name, Farbe).',
  calendar_source_log: 'Abrufprotokoll der iCal-Quellen: Zähler und technische Meldungen, keine Termininhalte.',
  incident_list_config: 'Ortsliste (Gemeinden/Ortsteile) und Standard-Website der Einsatzliste.',
  design_images: 'Bilder der Upload-Seite (Gestaltung): Binärdaten ohne Text, werden nicht inhaltlich durchsucht.',
  design_template_assets: 'Bilder der Designvorlagen: Binärdaten ohne Text, werden nicht inhaltlich durchsucht.',
  design_fonts: 'Schriften (Name, Lizenz).',
  template_categories: 'Kategorien der Designvorlagen.',
  fire_keywords: 'Stichwortverzeichnis (Katalog).',
  keyword_questions: 'Fragen zu Stichwörtern (Katalog).',
  warning_rules: 'Regeln für Warnstufen (Katalog).',
  notification_reads: 'Lesestatus von Benachrichtigungen je Konto; mit dem Konto bzw. der Benachrichtigung gelöscht.',
};

export const PRIVACY_COVERAGE: Record<string, TableCoverage> = {
  ...Object.fromEntries(Object.entries(EXCLUDED).map(([t, excluded]) => [t, { excluded }])),
  ...SEARCHED,
  ...Object.fromEntries(TEXT_AREAS.map((a) => [a.table, { hit: 'text', search: a.columns.map((c) => c.replace(/(\[\]|\{\})$/, '')), other: a.other }])),
};
