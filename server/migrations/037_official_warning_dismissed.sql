-- Amtliche Warnungen ausblenden: aus der Liste genommen und von späteren Abrufen nie neu angelegt (die Zeile bleibt
-- als Merker bis zur Löschfrist, last_seen_at läuft weiter). Ein daraus entstandenes automatisches Banner wird beendet.
ALTER TABLE official_warnings ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE official_warnings ADD COLUMN IF NOT EXISTS dismissed_by uuid REFERENCES users(id) ON DELETE SET NULL;
