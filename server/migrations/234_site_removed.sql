-- Widerrufene Websites entfernen: Ohne Verlauf wird die Zeile gelöscht. Mit Verlauf (Beiträge, Banner, Einsatzliste)
-- bleibt nur der Name für diesen Verlauf stehen; die Website verschwindet aus der Liste.
ALTER TABLE wp_sites ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE wp_sites ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES users(id) ON DELETE SET NULL;
