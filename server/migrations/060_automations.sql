-- Automationen (0.3.0): wiederverwendbare Eingänge und Ausgänge, versionierte Abläufe (Entwurf → Test → aktive Version),
-- Läufe mit Schrittprotokoll, Entprellen und Freigaben. Abläufe sind reine Daten (Knoten und Kanten), kein Code.

CREATE TABLE IF NOT EXISTS automation_inputs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('fe2','feuersoftware','warnfeed','rss','upload','schedule','manual')),
  config       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at  timestamptz
);
CREATE INDEX IF NOT EXISTS automation_inputs_kind_idx ON automation_inputs (kind) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS automation_outputs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('banner','post','mail','notify','warning_draft')),
  config       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at  timestamptz
);

-- Entwurf (graph) und aktive Version (automation_versions) sind getrennt. Aktivieren nur, wenn der Entwurf mit genau
-- dieser Prüfsumme einen erfolgreichen Testlauf hatte (tested_hash = graph_hash).
CREATE TABLE IF NOT EXISTS automations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled')),
  graph              jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  graph_hash         text NOT NULL,
  tested_hash        text,
  tested_at          timestamptz,
  tested_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  active_version     integer,
  -- Darf direkt veröffentlichen/versenden (nur mit Recht automation.publish und frischer Bestätigung)
  direct_publish     boolean NOT NULL DEFAULT false,
  direct_publish_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  direct_publish_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at         timestamptz
);

CREATE TABLE IF NOT EXISTS automation_versions (
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  graph           jsonb NOT NULL,
  graph_hash      text NOT NULL,
  direct_publish  boolean NOT NULL DEFAULT false,
  test_run_id     uuid,
  activated_at    timestamptz NOT NULL DEFAULT now(),
  activated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (automation_id, version)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version         integer,
  mode            text NOT NULL CHECK (mode IN ('live','test')),
  trigger         text NOT NULL CHECK (trigger IN ('event','schedule','manual','test')),
  input_node      text NOT NULL,
  event_key       text,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','succeeded','failed','canceled','limited')),
  graph           jsonb NOT NULL,
  graph_hash      text NOT NULL,
  direct_allowed  boolean NOT NULL DEFAULT false,
  payload         jsonb NOT NULL DEFAULT '{}',
  error           text,
  resume_at       timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
-- Ein Ereignis startet je Automation genau einen Lauf
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_event_uq ON automation_runs (automation_id, event_key) WHERE event_key IS NOT NULL AND mode = 'live';
CREATE INDEX IF NOT EXISTS automation_runs_list_idx ON automation_runs (automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_open_idx ON automation_runs (status) WHERE status IN ('queued','running','waiting');

-- Schrittprotokoll: je Lauf und Knoten genau eine Zeile (Wiederholung und Fortsetzung überspringen erledigte Schritte)
CREATE TABLE IF NOT EXISTS automation_steps (
  id           bigserial PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_id      text NOT NULL,
  node_type    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running','waiting','done','skipped','failed','unknown')),
  ports        text[] NOT NULL DEFAULT '{}',
  input        jsonb,
  output       jsonb,
  info         text,
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  integer,
  UNIQUE (run_id, node_id)
);

-- „Einmal je Vorgang“: Schlüssel aus Feldern, gültig bis expires_at
CREATE TABLE IF NOT EXISTS automation_dedup (
  automation_id  uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  node_id        text NOT NULL,
  key_hash       text NOT NULL,
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (automation_id, node_id, key_hash)
);

-- Freigaben aus Abläufen („Freigabe anfordern“, Versand an externe Empfänger ohne Direktversand)
CREATE TABLE IF NOT EXISTS automation_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_id        text NOT NULL,
  kind           text NOT NULL DEFAULT 'approval' CHECK (kind IN ('approval','mail')),
  title          text NOT NULL,
  summary        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','canceled')),
  expires_at     timestamptz NOT NULL,
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  note           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id)
);
CREATE INDEX IF NOT EXISTS automation_approvals_pending_idx ON automation_approvals (created_at DESC) WHERE status = 'pending';
