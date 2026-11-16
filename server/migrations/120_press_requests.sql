-- Presseanfragen (#204): erfassen, Status, Zuständigkeit, Frist, Verknüpfung, Verlauf. Kontaktdaten der anfragenden
-- Person stehen nur in press_requests (Löschfrist privacy.press_request_months nach Erledigung, lib/retention.ts).
CREATE SEQUENCE IF NOT EXISTS press_request_seq;

CREATE TABLE IF NOT EXISTS press_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no              text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','answered','done')),
  channel              text NOT NULL DEFAULT 'phone' CHECK (channel IN ('phone','mail','mailbox','in_person','other')),
  outlet               text NOT NULL DEFAULT '',
  contact_name         text NOT NULL DEFAULT '',
  contact_email        text NOT NULL DEFAULT '',
  contact_phone        text NOT NULL DEFAULT '',
  topic                text NOT NULL,
  body                 text NOT NULL DEFAULT '',
  assignee_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at               timestamptz,
  due_reminded_at      timestamptz,
  overdue_reminded_at  timestamptz,
  post_id              uuid REFERENCES posts(id) ON DELETE SET NULL,
  fe2_event_id         uuid REFERENCES fe2_events(id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  answered_at          timestamptz,
  done_at              timestamptz
);
CREATE INDEX IF NOT EXISTS press_requests_open_idx ON press_requests (due_at) WHERE status IN ('new','in_progress');
CREATE INDEX IF NOT EXISTS press_requests_assignee_idx ON press_requests (assignee_id) WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS press_requests_done_idx ON press_requests (done_at) WHERE status = 'done';
CREATE INDEX IF NOT EXISTS press_requests_created_idx ON press_requests (created_at DESC);

-- Verlauf: Anlage, Statuswechsel, Zuständigkeit, Frist, Verknüpfungen, interne Notizen (kind = 'note'), Mails
CREATE TABLE IF NOT EXISTS press_request_events (
  id          bigserial PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES press_requests(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name  text NOT NULL DEFAULT '',
  kind        text NOT NULL,
  text        text NOT NULL DEFAULT '',
  details     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS press_request_events_request_idx ON press_request_events (request_id, at);

-- Eingänge und Ausgänge der Workflows: Arten prüft der Server (automations/catalog.ts, configs.ts). Die festen Listen
-- der Tabellen fallen weg, damit neue Arten (Presseanfrage, Pressemitteilung, weitere Module) ohne Tabellenänderung
-- hinzukommen können.
ALTER TABLE automation_inputs DROP CONSTRAINT IF EXISTS automation_inputs_kind_check;
ALTER TABLE automation_outputs DROP CONSTRAINT IF EXISTS automation_outputs_kind_check;
