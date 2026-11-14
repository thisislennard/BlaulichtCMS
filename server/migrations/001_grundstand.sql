-- LifeLink 2.0 – Grundstand
-- Regel für alle künftigen Migrationen: nur additiv/abwärtskompatibel ändern, damit ein
-- automatisches Rollback auf die vorige Programmversion mit dem neuen Schema weiterläuft.

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

-- Geheimnisse und Verbindungen ------------------------------------------------------

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

CREATE TABLE connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector        text NOT NULL,
  connector_version integer NOT NULL DEFAULT 1,
  name             text NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}',
  secret_id        uuid REFERENCES secrets(id),
  status           text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','ok','warning','error','disabled')),
  status_message   text,
  last_test_at     timestamptz,
  last_test_ms     integer,
  last_used_at     timestamptz,
  credentials_expire_at timestamptz,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Workflows ----------------------------------------------------------------------------

CREATE TABLE workflows (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  folder             text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','archived')),
  active_version_id  uuid,
  draft              jsonb NOT NULL,
  draft_revision     integer NOT NULL DEFAULT 1,
  draft_updated_at   timestamptz NOT NULL DEFAULT now(),
  draft_updated_by   uuid,
  sample_event       jsonb,
  listen_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE workflow_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  number         integer NOT NULL,
  graph          jsonb NOT NULL,
  state          text NOT NULL CHECK (state IN ('pending_approval','published','rejected','superseded')),
  change_note    text NOT NULL DEFAULT '',
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  UNIQUE (workflow_id, number)
);
ALTER TABLE workflows ADD CONSTRAINT workflows_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES workflow_versions(id) ON DELETE SET NULL;

-- Trigger-Bindungen werden beim Aktivieren aus der veröffentlichten Version erzeugt.
CREATE TABLE trigger_bindings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_id   uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  node_id      text NOT NULL,
  kind         text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}',
  cursor       jsonb NOT NULL DEFAULT '{}',
  next_run_at  timestamptz,
  last_event_at timestamptz,
  last_error   text,
  UNIQUE (workflow_id, node_id)
);
CREATE INDEX trigger_bindings_next_idx ON trigger_bindings (next_run_at) WHERE next_run_at IS NOT NULL;

-- Webhook-Endpunkte bleiben über Versionen stabil (pro Workflow + Trigger-Node).
CREATE TABLE webhook_endpoints (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id             text NOT NULL,
  token               text NOT NULL UNIQUE,
  auth_mode           text NOT NULL DEFAULT 'hmac' CHECK (auth_mode IN ('hmac','token')),
  secret_id           uuid REFERENCES secrets(id),
  previous_secret_id  uuid REFERENCES secrets(id),
  previous_valid_until timestamptz,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  max_body_kb         integer NOT NULL DEFAULT 256,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_received_at    timestamptz,
  received_count      bigint NOT NULL DEFAULT 0,
  UNIQUE (workflow_id, node_id)
);

-- Eingänge, Läufe, Schritte ------------------------------------------------------------

CREATE TABLE event_receipts (
  id              bigserial PRIMARY KEY,
  received_at     timestamptz NOT NULL DEFAULT now(),
  workflow_id     uuid REFERENCES workflows(id) ON DELETE CASCADE,
  node_id         text,
  source          text NOT NULL,
  dedup_key       text,
  correlation_id  text NOT NULL,
  payload_preview jsonb,
  duplicate       boolean NOT NULL DEFAULT false
);
CREATE INDEX event_receipts_dedup_idx ON event_receipts (workflow_id, node_id, dedup_key, received_at DESC)
  WHERE dedup_key IS NOT NULL AND duplicate = false;

-- Schutz vor wiederverwendeten Webhook-Signaturen (Replay)
CREATE TABLE webhook_nonces (
  signature_hash text PRIMARY KEY,
  expires_at     timestamptz NOT NULL
);
CREATE INDEX event_receipts_received_idx ON event_receipts (received_at DESC);

CREATE TABLE runs (
  id              bigserial PRIMARY KEY,
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_id      uuid REFERENCES workflow_versions(id) ON DELETE SET NULL,
  version_number  integer,
  graph           jsonb,
  mode            text NOT NULL CHECK (mode IN ('production','test')),
  simulate        boolean NOT NULL DEFAULT false,
  trigger_kind    text NOT NULL,
  trigger_label   text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','waiting','success','error','canceled','dead','needs_review')),
  event_id        bigint REFERENCES event_receipts(id) ON DELETE SET NULL,
  correlation_id  text NOT NULL,
  parent_run_id   bigint REFERENCES runs(id) ON DELETE SET NULL,
  replay_kind     text CHECK (replay_kind IN ('full','from_failed')),
  started_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     integer,
  error_code      text,
  error_message   text,
  error_node_id   text,
  retryable       boolean NOT NULL DEFAULT false,
  retry_blocked_reason text,
  input_preview   jsonb,
  context_enc     text,
  context_expires_at timestamptz,
  summary         text NOT NULL DEFAULT ''
);
CREATE INDEX runs_workflow_idx ON runs (workflow_id, created_at DESC);
CREATE INDEX runs_created_idx ON runs (created_at DESC);
CREATE INDEX runs_status_idx ON runs (status);

CREATE TABLE step_runs (
  id            bigserial PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id       text NOT NULL,
  node_type     text NOT NULL,
  node_name     text NOT NULL,
  category      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('running','success','error','skipped','waiting','simulated')),
  attempt       integer NOT NULL DEFAULT 1,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  output_port   text,
  input_preview  jsonb,
  output_preview jsonb,
  error         jsonb,
  external_ref  text,
  status_text   text
);
CREATE INDEX step_runs_run_idx ON step_runs (run_id, id);

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

-- WordPress-Inhalte ---------------------------------------------------------------------

CREATE TABLE banners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  revision       integer NOT NULL DEFAULT 1,
  title          text NOT NULL,
  text           text NOT NULL DEFAULT '',
  label          text NOT NULL DEFAULT '',
  color          text NOT NULL DEFAULT 'neutral' CHECK (color IN ('rot','orange','gelb','blau','gruen','neutral')),
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('niedrig','normal','hoch')),
  starts_at      timestamptz,
  ends_at        timestamptz,
  pages          text[] NOT NULL DEFAULT '{front}',
  link_url       text,
  link_text      text,
  state          text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','deactivated')),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','workflow')),
  source_run_id  bigint REFERENCES runs(id) ON DELETE SET NULL,
  source_label   text NOT NULL DEFAULT '',
  source_key     text,
  sync_status    text NOT NULL DEFAULT 'none' CHECK (sync_status IN ('none','pending','synced','error')),
  sync_error     text,
  synced_revision integer,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX banners_conn_idx ON banners (connection_id, updated_at DESC);
CREATE UNIQUE INDEX banners_source_key_uq ON banners (connection_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE content_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  revision       integer NOT NULL DEFAULT 1,
  title          text NOT NULL,
  content        text NOT NULL DEFAULT '',
  excerpt        text NOT NULL DEFAULT '',
  category       text NOT NULL DEFAULT '',
  tags           text[] NOT NULL DEFAULT '{}',
  wp_status      text NOT NULL DEFAULT 'draft' CHECK (wp_status IN ('draft','pending','future')),
  publish_at     timestamptz,
  state          text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','sent')),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','workflow')),
  source_run_id  bigint REFERENCES runs(id) ON DELETE SET NULL,
  source_label   text NOT NULL DEFAULT '',
  source_key     text,
  wp_post_id     bigint,
  wp_edit_url    text,
  wp_result_status text,
  sync_status    text NOT NULL DEFAULT 'none' CHECK (sync_status IN ('none','pending','synced','error')),
  sync_error     text,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX content_posts_source_key_uq ON content_posts (connection_id, source_key) WHERE source_key IS NOT NULL;

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

CREATE TABLE update_history (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  from_version text NOT NULL,
  to_version   text,
  source       text NOT NULL CHECK (source IN ('github','upload','image')),
  sha256       text,
  status       text NOT NULL CHECK (status IN ('installed','failed','activated','rolled_back')),
  message      text NOT NULL DEFAULT '',
  notes        text NOT NULL DEFAULT '',
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL
);
