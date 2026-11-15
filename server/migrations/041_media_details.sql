-- Galerie wie LiFeOS: Anzeigename, Beschreibung und interne Notiz je Datei, Duplikat-Hinweis über die Prüfsumme,
-- „Zurückgestellt“ als vierter Sichtungsstand und ein Versionszähler gegen gleichzeitiges Sichten. Rein additiv.
ALTER TABLE media ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN IF NOT EXISTS internal_note text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN IF NOT EXISTS duplicate_of uuid REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS selection_version integer NOT NULL DEFAULT 0;
ALTER TABLE media DROP CONSTRAINT IF EXISTS media_selection_check;
ALTER TABLE media ADD CONSTRAINT media_selection_check CHECK (selection IN ('pending', 'selected', 'skipped', 'on_hold'));
CREATE INDEX IF NOT EXISTS media_sha256_idx ON media (sha256);
