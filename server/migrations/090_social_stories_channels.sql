-- Storys für Facebook und Instagram, weitere Kanäle (Threads, X, WhatsApp-Kanal) und „Teilen von Hand“ (#188, #189).
-- Rein additiv: neue Verbindungsarten, Format je Kanal in der Fassung, Format und Status „zum Teilen bereit“ je Auftrag.

ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('fe2','facebook','instagram','warnfeed','feuersoftware','threads','x','whatsapp'));

-- Format je sozialem Kanal: { "<connection-id>": "feed" | "story" | "both" } – fehlt ein Eintrag, gilt „feed“.
-- Teil der Fassung (Änderung → neue Freigabe).
ALTER TABLE post_revisions ADD COLUMN IF NOT EXISTS social_formats jsonb NOT NULL DEFAULT '{}';

-- Format des Auftrags (Beitrag oder Story) und „zum Teilen bereit“ (ready) für Kanäle ohne Schnittstelle:
-- BlaulichtCMS bereitet Text und Dateien vor, eine Person teilt von Hand und markiert den Auftrag als geteilt.
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'feed';
ALTER TABLE social_publications DROP CONSTRAINT IF EXISTS social_publications_format_check;
ALTER TABLE social_publications ADD CONSTRAINT social_publications_format_check CHECK (format IN ('feed','story'));
ALTER TABLE social_publications DROP CONSTRAINT IF EXISTS social_publications_status_check;
ALTER TABLE social_publications ADD CONSTRAINT social_publications_status_check CHECK (status IN ('queued','publishing','published','failed','unknown','canceled','ready'));
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS shared_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS shared_at timestamptz;
-- Link zur Website, der beim Beauftragen an Threads/X/WhatsApp-Texte angehängt wurde (für die Wiedererkennung)
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS link text;

DROP INDEX IF EXISTS social_publications_once;
CREATE UNIQUE INDEX IF NOT EXISTS social_publications_once ON social_publications (revision_id, connection_id, format) WHERE status IN ('queued','publishing','published','unknown','ready');
CREATE INDEX IF NOT EXISTS social_publications_ready_idx ON social_publications (created_at DESC) WHERE status = 'ready';

-- Zeitlich begrenzte Medien-Adresse in einer bestimmten Fassung (story = Bild auf 9:16 gebracht)
ALTER TABLE media_tokens ADD COLUMN IF NOT EXISTS variant text;
