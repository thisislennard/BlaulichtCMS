-- Presse-Postfach (#205): eingegangene Mails je Anfrage samt Anhängen und Empfangsprotokoll des Abrufs.
-- Ausgehende Antworten (#206) liegen in derselben Tabelle (direction = 'out').
CREATE TABLE IF NOT EXISTS press_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           uuid NOT NULL REFERENCES press_requests(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('in','out')),
  status               text NOT NULL DEFAULT 'received',
  message_id           text,
  in_reply_to          text,
  refs                 text[] NOT NULL DEFAULT '{}',
  from_address         text NOT NULL DEFAULT '',
  from_name            text NOT NULL DEFAULT '',
  to_addresses         text[] NOT NULL DEFAULT '{}',
  cc_addresses         text[] NOT NULL DEFAULT '{}',
  subject              text NOT NULL DEFAULT '',
  text_body            text NOT NULL DEFAULT '',
  html_body            text,
  blocked_images       integer NOT NULL DEFAULT 0,
  skipped_attachments  jsonb NOT NULL DEFAULT '[]',
  source               text,
  external_id          text,
  received_at          timestamptz,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS press_messages_request_idx ON press_messages (request_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS press_messages_message_id_idx ON press_messages (message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS press_messages_external_idx ON press_messages (source, external_id) WHERE external_id IS NOT NULL;

-- Anhänge (geprüfter Typ, Größenlimit) in der Datenbank: Teil der Sicherung, gelöscht mit der Anfrage
CREATE TABLE IF NOT EXISTS press_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES press_messages(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size          integer NOT NULL,
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS press_attachments_message_idx ON press_attachments (message_id);

-- Empfangsprotokoll des Abrufs (Löschfrist privacy.receipt_days)
CREATE TABLE IF NOT EXISTS press_mailbox_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL,
  subject       text NOT NULL DEFAULT '',
  from_address  text NOT NULL DEFAULT '',
  request_id    uuid REFERENCES press_requests(id) ON DELETE SET NULL,
  detail        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS press_mailbox_log_at_idx ON press_mailbox_log (at DESC);
