-- Gestaltung der Upload-Seite wie LiFeOS: Bausteine (Titelbild, Logo, Überschrift, Text, Bild mit Unterschrift,
-- Hinweisbox, Trennlinie, Begrüßung, Upload-Bereich) mit Akzentfarbe aus einer festen, kontrastreichen Palette.
-- Standard in den Einstellungen (media.upload_design), je Link überschreibbar. Bilder werden beim Hochladen neu
-- kodiert (ohne Metadaten) und liegen getrennt von den Medien. Der Datenschutzabschnitt ist immer dabei. Rein additiv.
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS design jsonb;
CREATE TABLE IF NOT EXISTS design_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  width       integer NOT NULL,
  height      integer NOT NULL,
  size_bytes  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
