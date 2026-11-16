-- Designvorlagen (#208): interne Bibliothek mit Kategorien, Vorschaubild, mehreren Formaten je Vorlage, Versionen
-- (ältere bleiben abrufbar), Nutzungshinweisen und Download-Zähler. Dateien liegen in der privaten Medienablage unter
-- /data/media/templates (nie im Webroot), ausgeliefert nur über geprüfte API-Routen. Rein additiv.
CREATE TABLE IF NOT EXISTS template_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS template_categories_name_idx ON template_categories (lower(name));

CREATE TABLE IF NOT EXISTS design_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  usage_note       text NOT NULL DEFAULT '',
  category_id      uuid REFERENCES template_categories(id) ON DELETE SET NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  kind             text NOT NULL DEFAULT 'files' CHECK (kind IN ('files', 'image')),
  -- Vorschaubild: 'none', aus einer Datei der Vorlage erzeugt ('auto') oder eigens hochgeladen ('upload')
  preview          text NOT NULL DEFAULT 'none' CHECK (preview IN ('none', 'auto', 'upload')),
  preview_rev      integer NOT NULL DEFAULT 0,
  current_version  integer NOT NULL DEFAULT 1,
  download_count   integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS design_templates_category_idx ON design_templates (category_id);

CREATE TABLE IF NOT EXISTS design_template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES design_templates(id) ON DELETE CASCADE,
  number       integer NOT NULL,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (template_id, number)
);

CREATE TABLE IF NOT EXISTS design_template_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES design_templates(id) ON DELETE CASCADE,
  version_id      uuid NOT NULL REFERENCES design_template_versions(id) ON DELETE CASCADE,
  original_name   text NOT NULL,
  format          text NOT NULL,
  mime            text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  download_count  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS design_template_files_version_idx ON design_template_files (version_id);
CREATE INDEX IF NOT EXISTS design_template_files_template_idx ON design_template_files (template_id);
