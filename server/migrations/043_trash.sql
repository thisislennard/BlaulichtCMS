-- Papierkorb wie LiFeOS: gelöschte Dateien, Ordner und Sammlungen bleiben bis zur Frist privacy.deleted_media_days
-- (Standard 30 Tage) wiederherstellbar; danach entfernt die Löschfrist Dateien und Datensätze. Was zusammen in den
-- Papierkorb kam (Ordner samt Inhalt), trägt dieselbe trash_batch und wird zusammen wiederhergestellt. Rein additiv.
ALTER TABLE media ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS trash_batch uuid;
ALTER TABLE collection_folders ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE collection_folders ADD COLUMN IF NOT EXISTS trash_batch uuid;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS media_trash_idx ON media (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS collections_trash_idx ON collections (deleted_at) WHERE deleted_at IS NOT NULL;
