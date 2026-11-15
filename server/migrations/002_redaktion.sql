-- BlaulichtCMS – Meilenstein 1: Sammlungen, Upload-Links, Medien, Beiträge, Fassungen, Freigaben,
-- gekoppelte WordPress-Websites (BlaulichtCMS Bridge) und Veröffentlichungen.

ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;
ALTER TABLE invitations ADD COLUMN revoked_by uuid;

-- Beiträge ------------------------------------------------------------------------------

CREATE TABLE posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL DEFAULT 'news' CHECK (kind IN ('news','incident','event','situation')),
  title            text NOT NULL,
  current_revision integer NOT NULL DEFAULT 1,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX posts_updated_idx ON posts (updated_at DESC);

-- Jede inhaltliche Änderung erzeugt eine neue, unveränderliche Fassung.
CREATE TABLE post_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  number        integer NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  excerpt       text NOT NULL DEFAULT '',
  media_ids     uuid[] NOT NULL DEFAULT '{}',
  cover_id      uuid,
  site_id       uuid,
  content_hash  text NOT NULL,
  change_note   text NOT NULL DEFAULT '',
  submitted_at  timestamptz,
  submitted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (post_id, number)
);

-- Eine Freigabe gilt genau für eine Fassung (inkl. Prüfsumme über Text, Medien und Zielkanal).
CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  revision_id   uuid NOT NULL REFERENCES post_revisions(id) ON DELETE CASCADE,
  content_hash  text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('approved','rejected')),
  note          text NOT NULL DEFAULT '',
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX approvals_post_idx ON approvals (post_id, decided_at DESC);
CREATE UNIQUE INDEX approvals_active_uq ON approvals (revision_id) WHERE decision = 'approved' AND revoked_at IS NULL;

-- Sammlungen und Upload-Links -------------------------------------------------------------

CREATE TABLE collections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  purpose       text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',
  post_id       uuid REFERENCES posts(id) ON DELETE SET NULL,
  max_files     integer NOT NULL DEFAULT 500,
  max_bytes     bigint NOT NULL DEFAULT 10737418240,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX collections_post_idx ON collections (post_id);

CREATE TABLE upload_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id   uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  -- Verschlüsselter Token, damit Link und QR-Code später erneut angezeigt werden können.
  token_enc       text NOT NULL,
  label           text NOT NULL DEFAULT '',
  expires_at      timestamptz NOT NULL,
  max_file_bytes  bigint NOT NULL DEFAULT 2147483648,
  max_files       integer NOT NULL DEFAULT 100,
  upload_count    integer NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX upload_links_collection_idx ON upload_links (collection_id);

-- Medien ------------------------------------------------------------------------------------

CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id   uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  upload_link_id  uuid REFERENCES upload_links(id) ON DELETE SET NULL,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  uploader_note   text NOT NULL DEFAULT '',
  client_key      text,
  original_name   text NOT NULL,
  declared_type   text NOT NULL DEFAULT '',
  mime            text,
  kind            text CHECK (kind IN ('image','video')),
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  width           integer,
  height          integer,
  taken_at        timestamptz,
  had_location    boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','ready','rejected')),
  reject_reason   text,
  has_preview     boolean NOT NULL DEFAULT false,
  has_public      boolean NOT NULL DEFAULT false,
  selection       text NOT NULL DEFAULT 'pending' CHECK (selection IN ('pending','selected','skipped')),
  selection_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  selection_at    timestamptz,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX media_collection_idx ON media (collection_id, sort_order, created_at);
-- Wiederholter Upload derselben Datei (gleicher Client-Schlüssel) erzeugt keinen zweiten Eintrag.
CREATE UNIQUE INDEX media_client_key_uq ON media (collection_id, client_key) WHERE client_key IS NOT NULL AND deleted_at IS NULL;

-- Kanäle: WordPress-Websites (BlaulichtCMS Bridge) ------------------------------------------------

CREATE TABLE wp_sites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  pairing_code_hash   text,
  pairing_expires_at  timestamptz,
  key_prefix          text UNIQUE,
  key_hash            text,
  site_url            text,
  wp_version          text,
  plugin_version      text,
  paired_at           timestamptz,
  last_seen_at        timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE post_revisions ADD CONSTRAINT post_revisions_site_fk FOREIGN KEY (site_id) REFERENCES wp_sites(id) ON DELETE SET NULL;

-- Eine Veröffentlichung ist ein Auftrag an genau einen Kanal für genau eine freigegebene Fassung.
CREATE TABLE publications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  revision_id     uuid NOT NULL REFERENCES post_revisions(id) ON DELETE CASCADE,
  approval_id     uuid NOT NULL REFERENCES approvals(id),
  site_id         uuid NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','published','failed','unknown','canceled')),
  attempts        integer NOT NULL DEFAULT 0,
  fetched_at      timestamptz,
  result_at       timestamptz,
  remote_id       text,
  remote_url      text,
  remote_status   text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX publications_site_idx ON publications (site_id, status, created_at);
CREATE INDEX publications_post_idx ON publications (post_id, created_at DESC);
-- Je Fassung und Website höchstens ein offener oder erfolgreicher Auftrag.
CREATE UNIQUE INDEX publications_once_uq ON publications (revision_id, site_id) WHERE status IN ('queued','sent','published','unknown');
