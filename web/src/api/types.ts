/** Typen der BlaulichtCMS-API (Auszug, nur was die Oberfläche nutzt). */

export interface Me {
  stage: 'mfa' | 'mfa_setup' | 'full';
  user: { id: string; email: string; name: string; roles: string[]; totp_enabled: boolean; preferences: Preferences };
  permissions: string[];
  roleLabels: string[];
  instance: { name: string; organization: string; timezone: string; language: string; publicUrl: string | null; privacy?: { controller: string; policy_url: string; incomplete: boolean } };
  version: string;
  recoveryCodesLeft: number;
  mfaRequired: boolean;
  passwordMinLength: number;
}

export interface Preferences {
  theme?: 'dark' | 'light' | 'system';
  reducedMotion?: boolean;
  compactTables?: boolean;
  sidebarCollapsed?: boolean;
  language?: 'de' | 'en';
  /** stummgeschaltete Benachrichtigungsarten (Medien) */
  mutedNotifications?: string[];
}

export type PostState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'unknown' | 'deactivated';
export type PostKind = 'news' | 'incident' | 'event' | 'situation';

export interface PostListItem {
  id: string;
  kind: PostKind;
  title: string;
  current_revision: number;
  updated_at: string;
  updated_by_name: string | null;
  site_name: string | null;
  collection_count: number;
  state: PostState;
  published_url: string | null;
  archived: boolean;
}

export interface MediaItem {
  id: string;
  collection_id?: string;
  original_name: string;
  mime: string | null;
  kind: 'image' | 'video' | null;
  size_bytes?: number;
  width: number | null;
  height: number | null;
  status: 'quarantine' | 'ready' | 'rejected' | 'blocked';
  reject_reason?: string | null;
  has_preview: boolean;
  has_public: boolean;
  had_location?: boolean | null;
  /** Original wurde von Standort- und Gerätedaten bereinigt (media.strip_location, #119). */
  location_stripped?: boolean;
  selection?: 'pending' | 'selected' | 'skipped' | 'on_hold';
  /** Zähler gegen gleichzeitiges Sichten (409 bei Konflikt) */
  selection_version?: number;
  sort_order?: number;
  /** Anzeigename, Beschreibung, interne Notiz (nur intern) */
  display_name?: string;
  description?: string;
  internal_note?: string;
  /** gleiche Prüfsumme wie diese ältere Datei */
  duplicate_of?: string | null;
  folder_id?: string | null;
  tags?: string[];
  /** nur in der Mediensuche */
  collection_title?: string;
  upload_ref?: string | null;
  uploader_note?: string;
  uploaded_by_name?: string | null;
  via_link?: boolean;
  created_at?: string;
  /** Markierungen aus der Sichtung (#118): persons, health, plates, sensitive. */
  sensitive_flags?: SensitiveFlag[];
  /** Unkenntlich gemachte Bereiche der öffentlichen Fassung (0..1, bezogen auf das gedrehte Bild). */
  redactions?: Redaction[];
  crop?: Region | null;
  strip_audio?: boolean;
  /** Zähler der öffentlichen Fassung – als ?v= an die URL, damit der Browser-Cache die neue Fassung lädt. */
  public_rev?: number;
  /** Nur in Beitragsmedien: öffentliche Fassung bearbeitet (Bereiche/Zuschnitt). */
  redacted?: boolean;
}

export type SensitiveFlag = 'persons' | 'health' | 'plates' | 'sensitive';
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Redaction extends Region {
  mode: 'pixelate' | 'blur' | 'box';
}

export interface UploadLink {
  id: string;
  label: string;
  state: 'active' | 'paused' | 'expired' | 'revoked';
  url: string | null;
  /** Link wurde nur einmal angezeigt (Einstellung „Link nur einmal anzeigen“) und ist nicht mehr abrufbar. */
  url_hidden?: boolean;
  /** Diese Antwort enthält den Link zum einzigen Mal. */
  shown_once?: boolean;
  expires_at: string;
  revoked_at: string | null;
  paused_at?: string | null;
  welcome_text?: string;
  folder_id?: string | null;
  regenerated_at?: string | null;
  max_files: number;
  max_file_bytes: number;
  upload_count: number;
  last_used_at: string | null;
  created_at: string;
  created_by_name?: string | null;
  bytes?: number | null;
}

export interface Site {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'revoked';
  site_url: string | null;
  wp_version: string | null;
  plugin_version: string | null;
  paired_at: string | null;
  last_seen_at: string | null;
  pairing_expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  open_jobs: number;
  published_count: number;
}

export interface Publication {
  id: string;
  action: 'publish' | 'unpublish';
  run_at: string;
  site_name: string;
  /** false: Kopplung widerrufen – offene Ergebnisse werden von Hand abgeschlossen (#162) */
  site_active?: boolean;
  revision_number: number;
  status: 'queued' | 'sent' | 'published' | 'failed' | 'unknown' | 'canceled';
  remote_url: string | null;
  remote_id: string | null;
  error: string | null;
  created_at: string;
  fetched_at: string | null;
  result_at: string | null;
  created_by_name?: string | null;
}
