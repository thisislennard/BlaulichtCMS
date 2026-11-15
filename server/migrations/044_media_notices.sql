-- Benachrichtigungen der Medien wie LiFeOS: Art (zum Stummschalten je Person), Bündelung gleicher Hinweise innerhalb
-- einer Stunde mit Zähler, und je Link bzw. Sammlung „schon gemeldet“ (läuft bald ab, Kontingent erreicht). Rein additiv.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE INDEX IF NOT EXISTS notifications_group_idx ON notifications (group_key, id DESC) WHERE group_key IS NOT NULL;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS expiring_notified_at timestamptz;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS quota_notified_at timestamptz;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS quota_notified_at timestamptz;
