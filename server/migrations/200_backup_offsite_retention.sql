-- Sicherung außer Haus (#246): Aufbewahrung auf dem Ziel passend zur dokumentierten Frist für Sicherungen
-- (docs/datenschutz.md: rund 4 Monate) und Hinweis auf frühere Ziele, auf denen noch Sicherungen liegen können.

-- Obergrenzen deutlich niedriger (vorher 365 Tage / 260 Wochen / 120 Monate); höhere Werte auf die neue Grenze setzen
UPDATE backup_offsite SET keep_daily = LEAST(keep_daily, 90), keep_weekly = LEAST(keep_weekly, 52), keep_monthly = LEAST(keep_monthly, 24);
ALTER TABLE backup_offsite DROP CONSTRAINT IF EXISTS backup_offsite_keep_daily_check;
ALTER TABLE backup_offsite DROP CONSTRAINT IF EXISTS backup_offsite_keep_weekly_check;
ALTER TABLE backup_offsite DROP CONSTRAINT IF EXISTS backup_offsite_keep_monthly_check;
ALTER TABLE backup_offsite ADD CONSTRAINT backup_offsite_keep_daily_check CHECK (keep_daily BETWEEN 1 AND 90);
ALTER TABLE backup_offsite ADD CONSTRAINT backup_offsite_keep_weekly_check CHECK (keep_weekly BETWEEN 0 AND 52);
ALTER TABLE backup_offsite ADD CONSTRAINT backup_offsite_keep_monthly_check CHECK (keep_monthly BETWEEN 0 AND 24);

-- Standard 3 statt 6 Monate; unveränderte bisherige Standardwerte (7/4/6) gehen mit
ALTER TABLE backup_offsite ALTER COLUMN keep_monthly SET DEFAULT 3;
UPDATE backup_offsite SET keep_monthly = 3 WHERE keep_daily = 7 AND keep_weekly = 4 AND keep_monthly = 6;

-- Frühere Ziele (Ausschalten oder Wechsel mit „Sicherungen behalten“): [{ "url": "...", "since": "..." }] – Hinweis im
-- Systemstatus, bis die Dateien gelöscht sind oder der Hinweis entfernt wird
ALTER TABLE backup_offsite ADD COLUMN IF NOT EXISTS leftovers jsonb NOT NULL DEFAULT '[]';
