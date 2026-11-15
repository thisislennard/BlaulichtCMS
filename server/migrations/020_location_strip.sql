-- Standortdaten aus Originalen entfernen (media.strip_location, #119): Zeitpunkt der Bereinigung bzw. Fehlergrund.
-- Ältere Originale ohne Zeitstempel bereinigt der Worker nach und nach, solange die Einstellung an ist.
ALTER TABLE media ADD COLUMN IF NOT EXISTS location_stripped_at timestamptz;
ALTER TABLE media ADD COLUMN IF NOT EXISTS location_strip_error text;
