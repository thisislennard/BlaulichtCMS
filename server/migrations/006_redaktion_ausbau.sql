-- M2: Vorlagen, Texte je Kanal, geplante Veröffentlichung, Deaktivierung.

CREATE TABLE post_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'news' CHECK (kind IN ('news','incident','event','situation')),
  title       text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  excerpt     text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Abweichende Texte je Zielkanal (z. B. {"wordpress": {"title": "…", "body": "…"}}) und geplanter Termin.
ALTER TABLE post_revisions ADD COLUMN variants jsonb NOT NULL DEFAULT '{}';
ALTER TABLE post_revisions ADD COLUMN publish_at timestamptz;

-- Aufträge: Veröffentlichen oder Deaktivieren, frühester Abholzeitpunkt.
ALTER TABLE publications ADD COLUMN action text NOT NULL DEFAULT 'publish' CHECK (action IN ('publish','unpublish'));
ALTER TABLE publications ADD COLUMN run_at timestamptz NOT NULL DEFAULT now();
DROP INDEX publications_once_uq;
CREATE UNIQUE INDEX publications_once_uq ON publications (revision_id, site_id, action) WHERE status IN ('queued','sent','published','unknown');
CREATE INDEX publications_due_idx ON publications (site_id, run_at) WHERE status IN ('queued','unknown','sent');
