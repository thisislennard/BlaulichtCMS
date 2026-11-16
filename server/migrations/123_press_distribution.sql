-- Presseverteiler und Pressemitteilungen (#207): Kontakte von Redaktionen mit Herkunft/Einwilligung und Abmeldung,
-- Verteilerlisten, Pressemitteilungen und Versandprotokoll je Empfänger (jede Mail einzeln adressiert).
CREATE TABLE IF NOT EXISTS press_contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL DEFAULT '',
  outlet           text NOT NULL DEFAULT '',
  email            text NOT NULL,
  phone            text NOT NULL DEFAULT '',
  note             text NOT NULL DEFAULT '',
  origin           text NOT NULL DEFAULT '',
  consent          text NOT NULL DEFAULT '',
  unsubscribed_at  timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS press_contacts_email_idx ON press_contacts (lower(email));

CREATE TABLE IF NOT EXISTS press_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS press_lists_name_idx ON press_lists (lower(name));

CREATE TABLE IF NOT EXISTS press_list_members (
  list_id     uuid NOT NULL REFERENCES press_lists(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES press_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX IF NOT EXISTS press_list_members_contact_idx ON press_list_members (contact_id);

CREATE TABLE IF NOT EXISTS press_releases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  body        text NOT NULL DEFAULT '',
  post_id     uuid REFERENCES posts(id) ON DELETE SET NULL,
  list_ids    uuid[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','partial')),
  source      text NOT NULL DEFAULT 'manual',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  sent_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS press_releases_created_idx ON press_releases (created_at DESC);

CREATE TABLE IF NOT EXISTS press_release_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id  uuid NOT NULL REFERENCES press_releases(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES press_contacts(id) ON DELETE SET NULL,
  email       text NOT NULL,
  name        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','unknown')),
  error       text,
  message_id  text,
  sent_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS press_release_recipients_unique_idx ON press_release_recipients (release_id, lower(email));
