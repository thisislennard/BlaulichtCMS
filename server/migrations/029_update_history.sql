-- In-App-Updates aus GitHub-Releases: Protokoll jeder Installation (abgebrochen, aktiviert, zurückgerollt).
-- Aktivierung und Rückweg schreibt der Supervisor in <data>/releases/activation.json; die API übernimmt das Ergebnis
-- beim Start hierher (updates/installer.ts, recordActivationResult).
CREATE TABLE IF NOT EXISTS update_history (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  from_version  text NOT NULL,
  to_version    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('activated', 'rolled_back', 'failed')),
  message       text NOT NULL DEFAULT '',
  sha256        text,
  backup_file   text,
  restored      boolean NOT NULL DEFAULT false,
  notes         text,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name    text
);
CREATE INDEX IF NOT EXISTS update_history_at ON update_history (at DESC);
