-- M3: Warnentwürfe (MoWaS-Übergabe) mit versionierten Vorlagen, Zuständigkeiten, PDF, Freigabe und Mailversand
-- sowie Stichwort-Umrechner und Warnstufen-Assistent (#41). Ausgeliefert ohne Stichwörter und ohne Regeln.

-- Versionierte Vorlagen: Feldsatz + PDF-Aufbau + Mailtexte. Ein Entwurf behält seine Vorlagenversion.
CREATE TABLE warning_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family        text NOT NULL,              -- Name der Vorlagenfamilie (Versionen gehören zusammen)
  version       integer NOT NULL,
  name          text NOT NULL,
  fields        jsonb NOT NULL,
  level_labels  jsonb NOT NULL,
  pdf_title     text NOT NULL,
  pdf_footer    text NOT NULL,
  mail_subject  text NOT NULL,
  mail_body     text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (family, version)
);

-- Zuständigkeiten mit hinterlegten Empfängern (produktive Empfänger vor Einsatz abstimmen)
CREATE TABLE responsibilities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  area        text NOT NULL DEFAULT '',
  recipients  text[] NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Stichwort-Umrechner (#41): Stichwörter, Aliasnamen, Prüffragen, Regeln – alles lokal gepflegt
CREATE TABLE fire_keywords (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  label       text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE keyword_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id   uuid NOT NULL REFERENCES fire_keywords(id) ON DELETE CASCADE,
  key          text NOT NULL,
  text         text NOT NULL,
  options      text[] NOT NULL DEFAULT '{ja,nein,unbekannt}',
  sort         integer NOT NULL DEFAULT 0,
  approved_at  timestamptz,
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (keyword_id, key)
);

-- Regeln: Bedingungen (Frage → erwartete Antwort) ergeben eine Warnstufe. Versioniert, fachlich freigegeben.
CREATE TABLE warning_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage      uuid NOT NULL,              -- alle Versionen einer Regel
  version      integer NOT NULL,
  keyword_id   uuid NOT NULL REFERENCES fire_keywords(id) ON DELETE CASCADE,
  name         text NOT NULL,
  conditions   jsonb NOT NULL,             -- {"frage_key": ["ja"], …}
  level        integer NOT NULL CHECK (level BETWEEN 1 AND 3),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  approved_at  timestamptz,
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (lineage, version)
);
CREATE INDEX warning_rules_keyword_idx ON warning_rules (keyword_id, status);

-- Optional verknüpfbare FE2-Einsätze (Eingang über die FE2-Verbindung, nur freigegebene Felder)
CREATE TABLE fe2_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key    text NOT NULL UNIQUE,
  keyword      text,
  title        text NOT NULL DEFAULT '',
  fields       jsonb NOT NULL DEFAULT '{}',
  received_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  post_id      uuid REFERENCES posts(id) ON DELETE SET NULL
);

-- Vorgänge
CREATE SEQUENCE warning_case_seq;
CREATE TABLE warnings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no           text NOT NULL UNIQUE,
  kind              text NOT NULL CHECK (kind IN ('initial','update','all_clear')),
  parent_id         uuid REFERENCES warnings(id) ON DELETE SET NULL,
  root_id           uuid REFERENCES warnings(id) ON DELETE SET NULL,
  template_id       uuid NOT NULL REFERENCES warning_templates(id),
  fe2_event_id      uuid REFERENCES fe2_events(id) ON DELETE SET NULL,
  current_revision  integer NOT NULL DEFAULT 1,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warning_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warning_id       uuid NOT NULL REFERENCES warnings(id) ON DELETE CASCADE,
  number           integer NOT NULL,
  data             jsonb NOT NULL,          -- Feldwerte gemäß Vorlage
  responsibility_ids uuid[] NOT NULL DEFAULT '{}',
  keyword          jsonb,                   -- {id, code, label} oder null (ohne Stichwort)
  answers          jsonb NOT NULL DEFAULT '{}',
  suggestion       jsonb,                   -- {level, ruleId, ruleVersion, reason} oder {none:true, reason}
  level_decision   jsonb,                   -- {level, suggested, changed, reason, by, byName, at}
  content_hash     text NOT NULL,
  submitted_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (warning_id, number)
);

CREATE TABLE warning_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warning_id    uuid NOT NULL REFERENCES warnings(id) ON DELETE CASCADE,
  revision_id   uuid NOT NULL REFERENCES warning_revisions(id) ON DELETE CASCADE,
  content_hash  text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('approved','rejected')),
  note          text NOT NULL DEFAULT '',
  pdf_sha256    text,
  pdf_file      text,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX warning_approvals_rev_idx ON warning_approvals (revision_id, decided_at DESC);

CREATE TABLE warning_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warning_id      uuid NOT NULL REFERENCES warnings(id) ON DELETE CASCADE,
  revision_id     uuid NOT NULL REFERENCES warning_revisions(id) ON DELETE CASCADE,
  approval_id     uuid NOT NULL REFERENCES warning_approvals(id),
  recipients      text[] NOT NULL,
  intended_recipients text[] NOT NULL,
  test_mode       boolean NOT NULL,
  subject         text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','failed','unknown')),
  needs_review    boolean NOT NULL DEFAULT false,
  resolution      text CHECK (resolution IN ('delivered','not_delivered')),
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  message_id      text,
  smtp_response   text,
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ack_note        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at         timestamptz
);
CREATE INDEX warning_sends_warning_idx ON warning_sends (warning_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warnings','warning_revisions','warning_approvals','warning_sends'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION lifelink_notify_change()', t || '_notify', t);
  END LOOP;
END $$;

-- Beispielvorlage (Version 1). Feldsatz, Texte und Empfänger vor dem Einsatz mit der zuständigen Stelle abstimmen.
INSERT INTO warning_templates (family, version, name, fields, level_labels, pdf_title, pdf_footer, mail_subject, mail_body, note) VALUES (
  'mowas-uebergabe', 1, 'MoWaS-Übergabe (Beispiel, nicht abgestimmt)',
  '[
    {"key":"area","label":"Betroffenes Gebiet","type":"textarea","required":true,"help":"Gemeinde, Ortsteile, Straßen"},
    {"key":"starts_at","label":"Beginn","type":"datetime","required":true},
    {"key":"valid_until","label":"Gültig bis","type":"datetime","required":true},
    {"key":"headline","label":"Überschrift","type":"text","required":true},
    {"key":"situation","label":"Lagebeschreibung","type":"textarea","required":true},
    {"key":"advice","label":"Verhaltensempfehlungen","type":"textarea","required":true},
    {"key":"sender","label":"Absender","type":"text","required":true},
    {"key":"callback","label":"Rückrufkontakt","type":"text","required":true,"help":"Name und Telefonnummer für Rückfragen"}
  ]'::jsonb,
  '{"1":"Warnstufe 1 – Extreme Gefahr","2":"Warnstufe 2 – Gefahr","3":"Warnstufe 3 – Gefahreninformation"}'::jsonb,
  'Übergabe eines Warnentwurfs',
  'Übergabe zur Bearbeitung. Die amtliche Auslösung erfolgt ausschließlich durch die zuständige Stelle über deren vorgesehenen Warnweg.',
  '{art} {vorgang} – {ueberschrift}',
  E'Guten Tag,\n\nanbei der freigegebene Warnentwurf {vorgang} (Fassung {fassung}) zur Bearbeitung.\n\nArt: {art}\nWarnstufe: {stufe}\nRückruf: {rueckruf}\n\nDie amtliche Auslösung erfolgt durch Ihre Stelle.\n\n{absender}',
  'Beispiel – Feldsatz, PDF-Aufbau, Freigaberegeln und Empfänger vor dem Einsatz mit der zuständigen Stelle abstimmen.'
);

-- Mailtext je Versand (getrennt, damit Listenabfragen schlank bleiben)
CREATE TABLE warning_sends_body (
  send_id  uuid PRIMARY KEY REFERENCES warning_sends(id) ON DELETE CASCADE,
  body     text NOT NULL
);
