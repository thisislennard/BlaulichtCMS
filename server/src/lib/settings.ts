import { many, pool, type Queryable } from '../db/pool.js';

/** Systemeinstellungen mit Standardwerten. Neue Einstellungen nur hier ergänzen. */
export const DEFAULT_SETTINGS = {
  'general.instance_name': 'LifeLink',
  'general.instance_subtitle': 'Produktion',
  'general.timezone': 'Europe/Berlin',
  'general.language': 'de',

  'execution.concurrency': 4,
  'execution.default_timeout_sec': 30,
  'execution.default_retries': 3,
  'execution.max_run_minutes': 15,
  'execution.preview_retention_days': 30,
  'execution.replay_window_days': 7,
  'execution.run_retention_days': 90,
  'execution.event_retention_days': 14,
  'execution.log_retention_days': 30,
  'execution.audit_retention_days': 365,
  'execution.four_eyes': false,

  'security.require_2fa_admins': true,
  'security.require_2fa_all': false,
  'security.session_idle_minutes': 60,
  'security.session_max_hours': 12,
  'security.lockout_attempts': 5,
  'security.lockout_minutes': 15,
  'security.password_min_length': 12,

  'notify.on_failure_inapp': true,
  'notify.on_failure_email': false,
  'notify.email_connection_id': '',
  'notify.email_recipients': [] as string[],
  'notify.on_connection_error': true,
  'notify.on_update_available': true,

  'backup.enabled': true,
  'backup.hour': 3,
  'backup.keep': 14,

  'updates.enabled': true,
  'updates.repo': '',
  'updates.check_hours': 6,
  'updates.token_secret_id': '',
  'updates.latest': null as null | Record<string, unknown>,
  'updates.last_check_at': null as null | string,
  'updates.last_check_error': null as null | string,

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
