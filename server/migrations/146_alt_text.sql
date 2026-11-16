-- Barrierefreiheit (#217): Alternativtext je Bild. Rein additiv.
-- In der Medienverwaltung hinterlegt und wiederverwendbar …
ALTER TABLE media ADD COLUMN IF NOT EXISTS alt_text text NOT NULL DEFAULT '';
-- … und als Teil der Fassung ({ "<media-id>": "Text" }); leer = Text aus der Medienverwaltung (ältere Fassungen).
-- Nur nicht leere Einträge zählen zur Prüfsumme – bestehende Fassungen und Freigaben bleiben gültig.
ALTER TABLE post_revisions ADD COLUMN IF NOT EXISTS media_alt jsonb NOT NULL DEFAULT '{}';
