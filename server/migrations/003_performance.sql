-- Indizes für häufige Abfragen (Beitragsliste, Dashboard, Sammlungen, Bridge-Abruf).
CREATE INDEX IF NOT EXISTS approvals_revision_idx ON approvals (revision_id, decided_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS publications_revision_idx ON publications (revision_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_status_idx ON media (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS media_link_idx ON media (upload_link_id) WHERE upload_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS collections_created_idx ON collections (created_at DESC);
CREATE INDEX IF NOT EXISTS post_revisions_submitted_idx ON post_revisions (submitted_at) WHERE submitted_at IS NOT NULL;
