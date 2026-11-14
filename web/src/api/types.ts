/** Typen der LifeLink-API (Auszug, nur was die Oberfläche nutzt). */

export interface Me {
  stage: 'mfa' | 'mfa_setup' | 'full';
  user: { id: string; email: string; name: string; roles: string[]; totp_enabled: boolean; preferences: Preferences };
  permissions: string[];
  roleLabels: string[];
  instance: { name: string; organization: string; timezone: string; language: string; publicUrl: string | null };
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
}

export type PostState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'publishing' | 'published' | 'failed' | 'unknown';
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
  status: 'quarantine' | 'ready' | 'rejected';
  reject_reason?: string | null;
  has_preview: boolean;
  has_public: boolean;
  had_location?: boolean;
  selection?: 'pending' | 'selected' | 'skipped';
  sort_order?: number;
  uploader_note?: string;
  uploaded_by_name?: string | null;
  via_link?: boolean;
  created_at?: string;
}

export interface UploadLink {
  id: string;
  label: string;
  state: 'active' | 'expired' | 'revoked';
  url: string | null;
  expires_at: string;
  revoked_at: string | null;
  max_files: number;
  max_file_bytes: number;
  upload_count: number;
  last_used_at: string | null;
  created_at: string;
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
  site_name: string;
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
