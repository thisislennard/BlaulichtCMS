-- LifeLink – Grundstand: Konten, Sitzungen, Audit, Geheimnisse, Aufträge, Betrieb.
-- Herkunft: Grundstand des bisherigen LifeLink (Workflow-Tabellen entfernt).
-- Regel für künftige Migrationen: möglichst additiv. Inkompatible Änderungen brauchen einen
-- eigenen, getesteten Migrations- und Wiederherstellungsweg (siehe docs/betrieb.md).

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

-- Benutzer und Identität -------------------------------------------------------------

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  name             text NOT NULL,
  password_hash    text,
  roles            text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  totp_secret_enc  text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  totp_last_counter bigint,
  recovery_codes   text[] NOT NULL DEFAULT '{}',
  preferences      jsonb NOT NULL DEFAULT '{}',
  failed_logins    integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  last_active_at   timestamptz,
  password_changed_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage         text NOT NULL DEFAULT 'full' CHECK (stage IN ('mfa','mfa_setup','full')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  prefix        text NOT NULL UNIQUE,
  key_hash      text NOT NULL,
  roles         text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid,
  actor_name    text NOT NULL,
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','api_key','system')),
  action        text NOT NULL,
  object_type   text,
  object_id     text,
  object_label  text,
  result        text NOT NULL DEFAULT 'ok' CHECK (result IN ('ok','failed','denied')),
  details       jsonb NOT NULL DEFAULT '{}',
  ip            text,
  correlation_id text
);
CREATE INDEX audit_at_idx ON audit_events (at DESC);
CREATE INDEX audit_object_idx ON audit_events (object_type, object_id);

CREATE TABLE app_logs (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  level          text NOT NULL CHECK (level IN ('debug','info','warn','error')),
  source         text NOT NULL,
  message        text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}',
  correlation_id text
);
CREATE INDEX app_logs_at_idx ON app_logs (at DESC);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  permission  text,
  kind        text NOT NULL CHECK (kind IN ('error','warning','info','success')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text
);
CREATE INDEX notifications_created_idx ON notifications (created_at DESC);

CREATE TABLE notification_reads (
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- Geheimnisse ------------------------------------------------------

CREATE TABLE secrets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    text NOT NULL,
  owner_id      uuid NOT NULL,
  version       integer NOT NULL,
  ciphertext    text NOT NULL,
  key_version   integer NOT NULL DEFAULT 1,
  fingerprint   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  revoked_at    timestamptz,
  UNIQUE (owner_type, owner_id, version)
);

-- Ergebnisse nicht-idempotenter Aktionen, damit ein Wiederholen keinen Doppeleffekt erzeugt.
CREATE TABLE idempotency_records (
  key          text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  state        text NOT NULL CHECK (state IN ('started','done','unknown')),
  result       jsonb
);

-- Persistente Warteschlange -----------------------------------------------------------

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  lease_until   timestamptz,
  locked_by     text,
  last_error    text,
  dedup_key     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (lease_until) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_dedup_uq ON jobs (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('queued','running');

CREATE TABLE worker_heartbeats (
  worker_id     text PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  version       text NOT NULL,
  jobs_running  integer NOT NULL DEFAULT 0,
  info          jsonb NOT NULL DEFAULT '{}'
);

-- Betrieb ---------------------------------------------------------------------------------

CREATE TABLE backups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name    text NOT NULL,
  size_bytes   bigint,
  sha256       text,
  status       text NOT NULL CHECK (status IN ('running','ok','failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  error        text,
  trigger      text NOT NULL DEFAULT 'schedule',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
