-- Sicherung außer Haus (#212): Ziel per WebDAV (z. B. NAS), Aufbewahrung auf dem Ziel, Probe-Wiederherstellung.

-- Genau ein Ziel; Passwort verschlüsselt in `secrets` (owner_type 'setting').
CREATE TABLE IF NOT EXISTS backup_offsite (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled          boolean NOT NULL DEFAULT false,
  kind             text NOT NULL DEFAULT 'webdav' CHECK (kind IN ('webdav')),
  url              text NOT NULL DEFAULT '',
  username         text NOT NULL DEFAULT '',
  secret_id        uuid REFERENCES secrets(id) ON DELETE SET NULL,
  -- SHA-256-Fingerabdruck eines selbst signierten Zertifikats (leer = normale Zertifikatsprüfung)
  tls_fingerprint  text NOT NULL DEFAULT '',
  keep_daily       integer NOT NULL DEFAULT 7 CHECK (keep_daily BETWEEN 1 AND 365),
  keep_weekly      integer NOT NULL DEFAULT 4 CHECK (keep_weekly BETWEEN 0 AND 260),
  keep_monthly     integer NOT NULL DEFAULT 6 CHECK (keep_monthly BETWEEN 0 AND 120),
  -- Probe-Wiederherstellung nach Zeitplan
  drill_interval   text NOT NULL DEFAULT 'weekly' CHECK (drill_interval IN ('off','weekly','monthly')),
  tested_at        timestamptz,
  last_ok_at       timestamptz,
  last_ok_file     text,
  last_error       text,
  last_error_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO backup_offsite (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Stand der Übertragung je Sicherung
ALTER TABLE backups ADD COLUMN IF NOT EXISTS offsite_status text CHECK (offsite_status IN ('pending','ok','failed'));
ALTER TABLE backups ADD COLUMN IF NOT EXISTS offsite_at timestamptz;
ALTER TABLE backups ADD COLUMN IF NOT EXISTS offsite_error text;

-- Probe-Wiederherstellungen mit Ergebnisprotokoll
CREATE TABLE IF NOT EXISTS restore_drills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL CHECK (source IN ('local','offsite')),
  file_name    text NOT NULL,
  trigger      text NOT NULL CHECK (trigger IN ('manual','schedule')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ok','failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb NOT NULL DEFAULT '{}',
  error        text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS restore_drills_created_idx ON restore_drills (created_at DESC);
-- Höchstens eine Probe gleichzeitig (eine Probe braucht so viel Platz wie die Datenbank)
CREATE UNIQUE INDEX IF NOT EXISTS restore_drills_one_active ON restore_drills ((true)) WHERE status IN ('queued','running');
