-- Zurückziehen auf sozialen Kanälen (#114):
--   removal_status  removed (gelöscht bzw. Löschung bestätigt), manual (von Hand im Kanal löschen, z. B. Instagram),
--                   failed (Löschen per Schnittstelle fehlgeschlagen)
--   removed_at/-by  wann und von wem gelöscht bzw. bestätigt
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS removal_status text CHECK (removal_status IN ('removed','manual','failed'));
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS removal_reason text;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS removal_error text;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS removal_requested_at timestamptz;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES users(id) ON DELETE SET NULL;
