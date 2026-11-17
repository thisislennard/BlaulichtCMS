-- Datenschutz-Prüfung auch für die Einsatzliste und für Bilder aus Vorlagen (#241). Rein additiv.
--
-- Einsatzliste: IDs der Bilder, deren Befund (Markierung bzw. offene Gesichtsvorschläge) bei der Freigabe bzw. beim
-- Veröffentlichen ausdrücklich geprüft wurde. Kommt danach ein Befund hinzu (oder wurde ein Eintrag vor dieser Prüfung
-- freigegeben), verlangt das Veröffentlichen die Bestätigung erneut.
ALTER TABLE incident_entries ADD COLUMN IF NOT EXISTS privacy_confirmed_ids uuid[] NOT NULL DEFAULT '{}';

-- Bilder aus Vorlagen: aus welchen Dateien ein Bild erzeugt wurde. Die Markierungen der Quellbilder gehen beim Erzeugen
-- auf das neue Bild über; später ergänzte Markierungen eines Quellbilds ebenfalls.
ALTER TABLE media ADD COLUMN IF NOT EXISTS derived_from uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS media_derived_from_idx ON media USING gin (derived_from) WHERE cardinality(derived_from) > 0;
