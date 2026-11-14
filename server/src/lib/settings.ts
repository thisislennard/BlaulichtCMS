import { many, pool, type Queryable } from '../db/pool.js';

/** Systemeinstellungen mit Standardwerten. Neue Einstellungen nur hier ergänzen. */
export const DEFAULT_SETTINGS = {
  'general.instance_name': 'LifeLink',
  'general.organization': '',
  'general.sender_name': '',
  'general.public_url': '',
  'general.timezone': 'Europe/Berlin',
  'general.language': 'de',

  'jobs.concurrency': 4,
  'retention.log_days': 30,
  'retention.audit_days': 365,

  'security.require_2fa_admins': true,
  'security.require_2fa_all': false,
  'security.session_idle_minutes': 60,
  'security.session_max_hours': 12,
  'security.lockout_attempts': 5,
  'security.lockout_minutes': 15,
  'security.password_min_length': 12,
  /** Hosts, deren interne Adressen für Abrufe (RSS, Konnektoren) ausdrücklich erlaubt sind. */
  'security.allowed_private_hosts': [] as string[],

  'media.max_file_mb': 2048,
  'media.link_max_files': 100,
  'media.link_default_days': 7,
  'media.collection_max_files': 500,
  'media.collection_max_gb': 10,
  'media.min_free_gb': 2,
  'media.strip_location': true,

  'editorial.four_eyes': false,
  'invites.valid_hours': 72,
  /** Gemeinsame Dashboard-Vorlagen je Rolle ({ rolle: layout }) und allgemein ('*'). */
  'dashboard.layouts': {} as Record<string, unknown>,

  'notify.on_connection_error': true,

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
