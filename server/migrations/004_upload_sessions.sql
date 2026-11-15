-- Fortsetzbare Uploads: eine Sitzung je Datei, Teile werden in Reihenfolge angehängt.
CREATE TABLE upload_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id   uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  upload_link_id  uuid REFERENCES upload_links(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  client_key      text NOT NULL,
  file_name       text NOT NULL,
  declared_type   text NOT NULL DEFAULT '',
  note            text NOT NULL DEFAULT '',
  size_bytes      bigint NOT NULL,
  received_bytes  bigint NOT NULL DEFAULT 0,
  media_id        uuid REFERENCES media(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE UNIQUE INDEX upload_sessions_key_uq ON upload_sessions (collection_id, client_key);
