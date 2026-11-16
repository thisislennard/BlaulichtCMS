import { many, pool, type Queryable } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Systemeinstellungen mit Standardwerten. Neue Einstellungen nur hier ergänzen – und nur, wenn sie auch ausgewertet
 * werden (units.test.ts prüft, dass jeder Schlüssel außerhalb von Katalog/Validierung gelesen wird, #175).
 */
export const DEFAULT_SETTINGS = {
  'general.instance_name': 'BlaulichtCMS',
  'general.organization': '',
  'general.sender_name': '',
  'general.public_url': '',
  'general.timezone': 'Europe/Berlin',
  'general.language': 'de',

  'jobs.concurrency': 4,
  'retention.log_days': 30,
  'retention.audit_days': 365,
  /**
   * IP-Adressen von Audit-Einträgen ohne Benutzerkonto (öffentliche Uploads, Anmeldeversuche mit unbekanntem Konto,
   * Bridge-/FE2-Fehlversuche) werden nach so vielen Tagen entfernt (#115, Art. 5 Abs. 1 lit. c/e DSGVO).
   */
  'privacy.upload_ip_retention_days': 30,
  /**
   * Informationspflichten nach Art. 13 DSGVO auf der öffentlichen Upload-Seite und dem Aushang (#96): verantwortliche
   * Stelle (Name, Anschrift), Kontakt der/des Datenschutzbeauftragten, Link zur Datenschutzerklärung und ein optionaler
   * eigener Text (z. B. Rechtsgrundlage). Leer = Hinweis an die Administration auf der Upload-Seite.
   */
  /**
   * Löschfristen (#97, lib/retention.ts; 0 = nie): abgeschlossene Sammlungen (archiviert oder ohne aktiven Link)
   * samt Dateien so viele Tage nach der letzten Aktivität; Datensätze gelöschter und abgewiesener Dateien.
   */
  'privacy.collection_retention_days': 365,
  'privacy.deleted_media_days': 30,
  /**
   * Weitere Löschfristen (#116; 0 = nie): FE2-Einsatzmeldungen, Warnvorgänge (nach dem letzten Bearbeitungsschritt),
   * amtliche Warnungen (nach Ablauf), abgelaufene/widerrufene Upload-Links samt Import-Weiterleitungen.
   */
  'privacy.fe2_event_days': 90,
  'privacy.warning_days': 365,
  'privacy.official_warning_days': 90,
  'privacy.upload_link_days': 90,
  /**
   * Empfangsprotokoll der eingehenden Verbindungen (connections/receipts.ts): Abrufe und eingehende Meldungen samt
   * Entscheidung und Rohdaten (FE2/Feuersoftware geschwärzt) so viele Tage aufbewahren (1–30).
   */
  'privacy.receipt_days': 7,
  /**
   * Angaben der Hochladenden (Name, E-Mail, Aufnahmeort, Aufnahmedatum – je Link abfragbar) nach so vielen Monaten
   * entfernen; die Dateien bleiben (wie press_uploader_anonymize_months in LiFeOS). 0 = nie.
   */
  'privacy.uploader_months': 12,
  'privacy.controller': '',
  'privacy.dpo_contact': '',
  'privacy.policy_url': '',
  'privacy.upload_notice': '',
  /**
   * Eigene Datenschutzerklärung und eigenes Impressum (#187) als Markdown, öffentlich unter /datenschutz und /impressum
   * (routes/legal.ts). Leer = Seite zeigt „noch kein Text hinterlegt“, Links darauf sind ausgeblendet.
   */
  'legal.privacy_text': '',
  'legal.imprint_text': '',

  'security.require_2fa_admins': true,
  'security.require_2fa_all': false,
  /** Zwei-Faktor-Pflicht für Rollen mit „Medien verwalten“ (Originale mit Standort, ungesichtete Uploads). */
  'security.require_2fa_media': true,
  'security.session_idle_minutes': 60,
  'security.session_max_hours': 12,
  /**
   * „Angemeldet bleiben“ (auth/context.ts): gemerkte Sitzungen ohne Leerlaufabmeldung, gültig `remember_days` seit der
   * letzten Nutzung, an das Gerät gebunden. Abschalten beendet bestehende gemerkte Sitzungen.
   */
  'security.remember_enabled': true,
  'security.remember_days': 30,
  /**
   * „Zwei-Faktor auf diesem Gerät merken“ (auth/devices.ts): nach einem Code aus der App fragt die Anmeldung auf
   * diesem Gerät `mfa_remember_days` lang nur das Passwort ab. Abschalten widerruft alle vertrauenswürdigen Geräte.
   */
  'security.mfa_remember_enabled': true,
  'security.mfa_remember_days': 30,
  'security.lockout_attempts': 5,
  'security.lockout_minutes': 15,
  'security.password_min_length': 12,
  /** Sicherheitsmeldungen (#101, lib/security-alerts.ts): In-App an „System verwalten“ bzw. „Benutzer verwalten“. */
  'security.alert_inapp': true,
  /** Sicherheitsmeldungen zusätzlich per E-Mail an die Administration (nur mit eingerichtetem SMTP). */
  'security.alert_mail_admins': false,
  /** Betroffene Person per E-Mail über Passwort-, Zwei-Faktor- und Sperr-Ereignisse informieren (nur mit SMTP). */
  'security.alert_mail_user': true,
  /** Meldung ab so vielen fehlgeschlagenen Anmeldungen/Codes in 15 Minuten über alle Konten (0 = aus). */
  'security.alert_failed_logins': 20,
  /** Meldung ab so vielen Original-Downloads bzw. exportierten Dateien einer Person pro Stunde (0 = aus). */
  'security.alert_downloads': 200,
  /** Hosts, deren interne Adressen für Abrufe (RSS, Konnektoren) ausdrücklich erlaubt sind. */
  'security.allowed_private_hosts': [] as string[],

  'media.max_file_mb': 2048,
  'media.link_max_files': 100,
  'media.link_default_days': 7,
  /** Höchstdauer eines Upload-Links (auch für „Verlängern“ und „Bis Termin“). */
  'media.link_max_days': 90,
  /**
   * Link und QR-Code nur einmal anzeigen (wie LiFeOS): dann wird nur die Prüfsumme des Tokens gespeichert. Standard aus –
   * Link, QR-Code und Aushang lassen sich jederzeit erneut abrufen (verschlüsselt gespeichert).
   */
  'media.link_show_once': false,
  /** Upload-Seite: Knöpfe „Foto aufnehmen“ und „Video aufnehmen“ auf Touch-Geräten. */
  'media.camera_buttons': true,
  /** Text nach erfolgreichem Upload (leer = Standardtext). */
  'media.done_text': '',
  /** ZIP-Sammeldownloads: so viele Stunden verfügbar, höchstens so groß (GB) – wie press_export_hours/_max_gb. */
  'media.export_hours': 24,
  'media.export_max_gb': 20,
  /** Gesperrte Dateien (Prüfbefund) nach so vielen Tagen samt Datei löschen (0 = nie) – wie press_blocked_days. */
  'media.blocked_days': 30,
  /** Sicherheitsereignisse der öffentlichen Seiten so viele Tage aufbewahren (0 = immer) – wie press_security_log_days. */
  'media.security_log_days': 365,
  /** Standard-Gestaltung der Upload-Seite (media/design.ts; null = eingebauter Standard) – eigene Seite, nicht allgemein änderbar. */
  'media.upload_design': null as null | Record<string, unknown>,
  /** Global erlaubte Dateitypen (Schlüssel aus media/types.ts); je Link weiter einschränkbar. */
  'media.allowed_types': ['jpeg', 'png', 'webp', 'heic', 'avif', 'gif', 'mp4', 'mov', 'webm', '3gp'] as string[],
  /** Benachrichtigungen der Medien (neue Dateien, Link läuft ab, Kontingent, Speicher) – lib/media-notify.ts. */
  'media.notices': true,
  /** Speicherwarnung an „Medien administrieren“, wenn weniger frei ist (GB, 0 = aus). */
  'media.storage_warn_gb': 10,
  'media.collection_max_files': 500,
  'media.collection_max_gb': 10,
  'media.min_free_gb': 2,
  /**
   * Standort-, Seriennummer- und Personenangaben auch aus Originalen entfernen (verlustfrei, nach Erzeugung der
   * öffentlichen Fassung; ältere Originale bereinigt der Worker nach und nach) – media/scrub.ts, #119.
   */
  'media.strip_location': true,
  /** Höchstlänge von Videos (Ressourcenschutz bei der Verarbeitung). */
  'media.max_video_minutes': 30,
  /** Prüftiefe wie LiFeOS: höchstens so viele Megapixel je Bild dekodieren. */
  'media.max_image_mp': 40,
  /** Längere Kante eines Videos höchstens (Pixel). */
  'media.max_video_edge': 7680,
  /** Videos zur Prüfung dekodieren (empfohlen): erste Sekunden Bild für Bild, danach alle Schlüsselbilder. */
  'media.video_full_decode': true,
  /** Bis zu dieser Länge (Sekunden) wird ein Video vollständig Bild für Bild dekodiert. */
  'media.full_decode_seconds': 60,
  /** Zeitlimit je Prüf- bzw. Umwandlungsschritt (Sekunden). */
  'media.check_timeout_s': 1800,
  /** Animierte Bilder (GIF, WebP, PNG, AVIF) zulassen; verarbeitet wird das erste Bild. */
  'media.allow_animated': false,

  'editorial.four_eyes': false,
  /**
   * Automationen (automations/*): globaler Schalter (aus = keine neuen Läufe, offene Läufe werden abgebrochen),
   * Grenze der Läufe je Automation und Minute (Schutz gegen Schleifen und Fluten) und Aufbewahrung der Laufprotokolle.
   */
  'automations.enabled': true,
  'automations.max_runs_per_minute': 20,
  'privacy.automation_run_days': 30,
  'invites.valid_hours': 72,
  /** Gemeinsame Dashboard-Vorlagen je Rolle ({ rolle: layout }) und allgemein ('*'). */
  'dashboard.layouts': {} as Record<string, unknown>,

  /** Wartungsmodus vor Updates: schreibende Vorgänge angehalten ({ since, byName, reason } oder null). */
  'system.maintenance': null as null | { since: string; byName: string; reason: string },

  /** Warnentwürfe: Testmodus sendet ausschließlich an den Testempfänger. Standard: an. */
  'warnings.test_mode': true,
  'warnings.test_recipient': '',
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.security': 'starttls',
  'smtp.user': '',
  'smtp.from': '',
  'smtp.password_secret_id': '',
  /**
   * Letzte erfolgreiche Testmail (routes/warnings.ts): Prüfwert der dabei benutzten Einstellungen (smtpFingerprint) und
   * Zeitpunkt. Testmodus ausschalten bzw. Versandeinstellungen im Echtbetrieb ändern geht nur mit passendem, frischem Wert.
   */
  'smtp.verified': null as null | { fp: string; at: string },

  /**
   * In-App-Updates aus GitHub-Releases (updates/github.ts): Prüfung im Worker alle `check_hours` Stunden, Installation
   * nur von Hand. Token optional (öffentliches Repository braucht keinen), verschlüsselt in `secrets`, nie an die
   * Oberfläche. Zwischenstand der letzten Prüfung in `latest`/`last_check_*`.
   */
  'updates.enabled': true,
  'updates.repo': 'thisislennard/BlaulichtCMS',
  'updates.api_url': 'https://api.github.com',
  'updates.token_secret_id': '',
  'updates.check_hours': 6,
  'updates.latest': null as null | Record<string, unknown>,
  'updates.last_check_at': null as null | string,
  'updates.last_check_error': null as null | string,
  /** Version, zu der die Administration bereits benachrichtigt wurde (eine Meldung je neuer Version). */
  'updates.notified_version': '',

  'backup.enabled': true,
  'backup.hour': 3,
  'backup.keep': 14,

  'setup.completed': false,
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof DEFAULT_SETTINGS)[K] };

let cache: { at: number; values: Settings } | null = null;
const TTL_MS = 5_000;

export async function getSettings(fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await many<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  const values = { ...DEFAULT_SETTINGS } as Settings;
  for (const r of rows) if (r.key in values) (values as any)[r.key] = r.value;
  cache = { at: Date.now(), values };
  return values;
}

export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  return (await getSettings())[key];
}

export async function setSettings(patch: Partial<Settings>, userId: string | null = null, db: Queryable = pool) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    await db.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), userId],
    );
  }
  cache = null;
}

/** Höchstlänge von Text-Einstellungen (Standard 200 Zeichen). */
export const SETTING_TEXT_MAX: Record<string, number> = {
  'privacy.controller': 400,
  'privacy.dpo_contact': 300,
  'privacy.policy_url': 500,
  'privacy.upload_notice': 2000,
  'media.done_text': 1000,
  'legal.privacy_text': 50_000,
  'legal.imprint_text': 20_000,
};

/** Datenschutzangaben für öffentliche Seiten (Upload-Seite, Aushang) – #96. */
export function privacyInfo(s: Settings) {
  return {
    controller: String(s['privacy.controller'] ?? '').trim(),
    dpo_contact: String(s['privacy.dpo_contact'] ?? '').trim(),
    // Ohne eigene Adresse, aber mit eigener Datenschutzerklärung (#187): die öffentliche Seite /datenschutz
    policy_url: String(s['privacy.policy_url'] ?? '').trim() || (String(s['legal.privacy_text'] ?? '').trim() ? legalUrl(s, '/datenschutz') : ''),
    notice: String(s['privacy.upload_notice'] ?? '').trim(),
    ip_retention_days: s['privacy.upload_ip_retention_days'],
    collection_retention_days: s['privacy.collection_retention_days'],
  };
}

/** Adresse einer öffentlichen Seite von BlaulichtCMS (vollständig, wenn die öffentliche Adresse bekannt ist). */
export function legalUrl(s: Settings, pathname: '/datenschutz' | '/impressum'): string {
  const base = String(s['general.public_url'] || config.publicUrl || '').replace(/\/+$/, '');
  return `${base}${pathname}`;
}

/** Pflichtangaben fehlen: weder verantwortliche Stelle noch Datenschutzerklärung eingetragen. */
export function privacyIncomplete(s: Settings) {
  const p = privacyInfo(s);
  return !p.controller || !p.policy_url;
}

/** Erlaubte Bereiche der Zahlen-Einstellungen (ganze Zahlen). Die Oberfläche spiegelt sie in admin/Settings.tsx. */
export const SETTING_RANGES: Record<string, [number, number]> = {
  'security.session_idle_minutes': [5, 1440],
  'security.session_max_hours': [1, 720],
  'security.remember_days': [1, 180],
  'security.mfa_remember_days': [1, 90],
  'security.lockout_attempts': [3, 20],
  'security.lockout_minutes': [1, 1440],
  'security.password_min_length': [10, 128],
  'security.alert_failed_logins': [0, 10000],
  'security.alert_downloads': [0, 100000],
  'invites.valid_hours': [1, 720],
  'jobs.concurrency': [1, 32],
  'retention.log_days': [1, 3650],
  'retention.audit_days': [30, 3650],
  'privacy.upload_ip_retention_days': [1, 365],
  'privacy.collection_retention_days': [0, 3650],
  'privacy.deleted_media_days': [0, 3650],
  'privacy.fe2_event_days': [0, 3650],
  'privacy.warning_days': [0, 3650],
  'privacy.official_warning_days': [0, 3650],
  'privacy.upload_link_days': [0, 3650],
  'privacy.receipt_days': [1, 30],
  'privacy.uploader_months': [0, 120],
  'privacy.automation_run_days': [1, 3650],
  'automations.max_runs_per_minute': [1, 600],
  'media.max_file_mb': [1, 20000],
  'media.link_max_files': [1, 1000],
  'media.link_default_days': [1, 90],
  'media.link_max_days': [1, 365],
  'media.storage_warn_gb': [0, 100000],
  'media.blocked_days': [0, 3650],
  'media.export_hours': [1, 336],
  'media.export_max_gb': [1, 500],
  'media.security_log_days': [0, 3650],
  'media.collection_max_files': [1, 100000],
  'media.collection_max_gb': [1, 10000],
  'media.min_free_gb': [1, 10000],
  'media.max_video_minutes': [1, 600],
  'media.max_image_mp': [1, 500],
  'media.max_video_edge': [320, 8192],
  'media.full_decode_seconds': [10, 36000],
  'media.check_timeout_s': [60, 14400],
  'smtp.port': [1, 65535],
  'backup.hour': [0, 23],
  'backup.keep': [1, 365],
  'updates.check_hours': [1, 168],
};
