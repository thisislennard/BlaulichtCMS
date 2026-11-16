-- Antworten auf Presseanfragen (#206): ausgehende Mails in press_messages (direction = 'out') mit Versand- und
-- Freigabestand; Textbausteine mit Platzhaltern.
ALTER TABLE press_messages ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE press_messages ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE press_messages ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE press_messages ADD COLUMN IF NOT EXISTS decision_note text NOT NULL DEFAULT '';
ALTER TABLE press_messages ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE press_messages ADD COLUMN IF NOT EXISTS error text;
CREATE INDEX IF NOT EXISTS press_messages_pending_idx ON press_messages (created_at) WHERE direction = 'out' AND status = 'pending';

CREATE TABLE IF NOT EXISTS press_snippets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
