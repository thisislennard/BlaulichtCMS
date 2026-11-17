-- Löschfrist für Presseanfragen, die nie „erledigt“ werden (#243): neu, in Bearbeitung und beantwortet werden nach
-- privacy.press_open_months ohne Aktivität gelöscht – erst nach einer Ankündigung an „Presseanfragen bearbeiten“
-- (press/retention.ts). Hier steht, wann die Löschung angekündigt wurde. Rein additiv.
ALTER TABLE press_requests ADD COLUMN IF NOT EXISTS retention_notified_at timestamptz;
CREATE INDEX IF NOT EXISTS press_requests_not_done_idx ON press_requests (updated_at) WHERE status <> 'done';
