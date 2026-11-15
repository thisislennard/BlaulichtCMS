-- Ordnen wie LiFeOS: Ordner (beliebig tief) innerhalb einer Sammlung, Zielordner je Upload-Link, Schlagworte für
-- Medien, Veranstaltungsdatum und frei gewähltes Titelbild je Sammlung, sammlungsübergreifende ZIP-Exporte mit
-- Ordnerstruktur und optionaler metadaten.csv. Rein additiv; Medien behalten ihre ID (Beiträge bleiben stabil).
CREATE TABLE IF NOT EXISTS collection_folders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES collection_folders(id) ON DELETE CASCADE,
  name           text NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  archived_at    timestamptz,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS collection_folders_collection_idx ON collection_folders (collection_id, parent_id);

ALTER TABLE media ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES collection_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS media_folder_idx ON media (folder_id) WHERE folder_id IS NOT NULL;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES collection_folders(id) ON DELETE SET NULL;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES collection_folders(id) ON DELETE SET NULL;

-- Schlagworte (Medien) – bewusst getrennt von den Stichwörtern der Warnentwürfe
CREATE TABLE IF NOT EXISTS media_tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS media_tags_name_uq ON media_tags (lower(name));
CREATE TABLE IF NOT EXISTS media_tag_links (
  media_id  uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_id    uuid NOT NULL REFERENCES media_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);
CREATE INDEX IF NOT EXISTS media_tag_links_tag_idx ON media_tag_links (tag_id);

ALTER TABLE collections ADD COLUMN IF NOT EXISTS event_date date;
-- Papierkorb für Sammlungen (Paket 4); hier schon angelegt, damit Suche und Listen ihn von Anfang an beachten
ALTER TABLE collections ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS cover_media_id uuid REFERENCES media(id) ON DELETE SET NULL;

-- Exporte: auch sammlungsübergreifend (Auswahl aus der Mediensuche), mit Ordnerstruktur und metadaten.csv
ALTER TABLE exports ALTER COLUMN collection_id DROP NOT NULL;
ALTER TABLE exports ADD COLUMN IF NOT EXISTS with_folders boolean NOT NULL DEFAULT true;
ALTER TABLE exports ADD COLUMN IF NOT EXISTS with_csv boolean NOT NULL DEFAULT false;
ALTER TABLE exports ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
