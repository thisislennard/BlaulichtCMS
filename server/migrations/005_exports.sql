-- Sammeldownloads (ZIP) werden im Hintergrund erzeugt und laufen ab.
CREATE TABLE exports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_ids      uuid[] NOT NULL,
  variant        text NOT NULL CHECK (variant IN ('public','original')),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  file_count     integer NOT NULL DEFAULT 0,
  size_bytes     bigint,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  finished_at    timestamptz,
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX exports_collection_idx ON exports (collection_id, created_at DESC);
