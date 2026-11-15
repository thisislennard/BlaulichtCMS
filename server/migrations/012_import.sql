-- M4: Einmaliger Medienimport (z. B. aus LiFeOS) über ein dokumentiertes Austauschformat.
CREATE TABLE import_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL,
  manifest_sha256  text NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('dry_run','commit')),
  status           text NOT NULL CHECK (status IN ('ok','failed')),
  report           jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Alte, noch gültige Upload-Links: befristete Weiterleitung auf den neuen BlaulichtCMS-Link
CREATE TABLE legacy_links (
  old_token_hash   text PRIMARY KEY,
  link_id          uuid NOT NULL REFERENCES upload_links(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  run_id           uuid REFERENCES import_runs(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
