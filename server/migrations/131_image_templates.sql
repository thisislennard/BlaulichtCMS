-- Befüllbare Bildvorlagen (#209): Layout je Vorlage (Hintergrund, Textfelder, Bild-Platzhalter, Logo, Flächen),
-- Bilder der Vorlage (Hintergrund, Logos), eigene Schriften mit Lizenzhinweis und eine Systemsammlung
-- „Bilder aus Vorlagen“ für erzeugte Bilder ohne gewählte Sammlung. Rein additiv.
ALTER TABLE design_templates ADD COLUMN IF NOT EXISTS layout jsonb;

CREATE TABLE IF NOT EXISTS design_template_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES design_templates(id) ON DELETE CASCADE,
  mime         text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/svg+xml')),
  width        integer,
  height       integer,
  size_bytes   bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS design_template_assets_template_idx ON design_template_assets (template_id);

CREATE TABLE IF NOT EXISTS design_fonts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family      text NOT NULL,
  subfamily   text NOT NULL DEFAULT '',
  full_name   text NOT NULL DEFAULT '',
  weight      integer NOT NULL DEFAULT 400,
  italic      boolean NOT NULL DEFAULT false,
  format      text NOT NULL CHECK (format IN ('ttf', 'otf')),
  license     text NOT NULL,
  size_bytes  bigint NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE collections ADD COLUMN IF NOT EXISTS system_key text;
CREATE UNIQUE INDEX IF NOT EXISTS collections_system_key_idx ON collections (system_key) WHERE system_key IS NOT NULL;
