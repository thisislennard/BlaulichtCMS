-- Meilenstein 4: optionale Verbindungen (FE2, Facebook, Instagram, amtliche Warnfeeds)
-- Einheitlicher Ablauf: Verbinden → Testen → Vorschau → Aktivieren.

CREATE TABLE connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('fe2','facebook','instagram','warnfeed')),
  name               text NOT NULL,
  -- draft: angelegt · tested: Test bestanden · active: in Betrieb · disabled: angehalten · revoked: Zugang widerrufen
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','tested','active','disabled','revoked')),
  config             jsonb NOT NULL DEFAULT '{}',      -- nicht geheime Einstellungen
  secret_id          uuid REFERENCES secrets(id) ON DELETE SET NULL,
  account            jsonb NOT NULL DEFAULT '{}',      -- erkanntes Konto (Name, ID) – ohne Tokens
  capabilities       jsonb NOT NULL DEFAULT '{}',      -- tatsächlich verfügbare Funktionen
  last_test          jsonb,                            -- { at, ok, steps: [{ name, ok, message }] }
  preview            jsonb,
  private_target     text,                             -- privater Zielhost (z. B. FE2 im LAN)
  private_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  private_approved_at timestamptz,
  activated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  activated_at       timestamptz,
  last_event_at      timestamptz,
  last_error         text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- FE2-Ereignisse: stabile Zuordnung je Verbindung und Einsatz-ID, Folgeereignisse zählen hoch
ALTER TABLE fe2_events ADD COLUMN connection_id uuid REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE fe2_events ADD COLUMN sequence integer NOT NULL DEFAULT 1;
ALTER TABLE fe2_events ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'));
ALTER TABLE fe2_events ADD COLUMN payload_hash text;

-- Soziale Kanäle als Teil der Fassung (Änderung → neue Freigabe)
ALTER TABLE post_revisions ADD COLUMN social_targets uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE social_publications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  revision_id    uuid NOT NULL REFERENCES post_revisions(id) ON DELETE CASCADE,
  approval_id    uuid NOT NULL REFERENCES approvals(id),
  connection_id  uuid NOT NULL REFERENCES connections(id),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','publishing','published','failed','unknown','canceled')),
  marker         text NOT NULL,                       -- eindeutige Kennung im Beitrag zur Wiedererkennung
  container_id   text,                                -- Instagram-Mediencontainer
  remote_id      text,
  remote_url     text,
  error          text,
  error_class    text,
  attempts       integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX social_publications_post_idx ON social_publications (post_id, created_at DESC);
CREATE UNIQUE INDEX social_publications_once ON social_publications (revision_id, connection_id) WHERE status IN ('queued','publishing','published','unknown');

-- Zeitlich begrenzte öffentliche Adressen für freigegebene Dateien (Abruf durch Meta)
CREATE TABLE media_tokens (
  token_hash   text PRIMARY KEY,
  media_id     uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_tokens_expiry_idx ON media_tokens (expires_at);

-- Amtliche Warnungen (CAP), getrennt von eigenen Warnentwürfen
CREATE TABLE official_warnings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  identifier     text NOT NULL,
  sender         text NOT NULL DEFAULT '',
  sent_at        timestamptz,
  msg_type       text NOT NULL DEFAULT 'Alert',      -- Alert | Update | Cancel
  references_ids text[] NOT NULL DEFAULT '{}',
  severity       text NOT NULL DEFAULT '',
  urgency        text NOT NULL DEFAULT '',
  event          text NOT NULL DEFAULT '',
  headline       text NOT NULL DEFAULT '',
  description    text NOT NULL DEFAULT '',
  instruction    text NOT NULL DEFAULT '',
  areas          text[] NOT NULL DEFAULT '{}',
  geocodes       text[] NOT NULL DEFAULT '{}',
  effective_at   timestamptz,
  expires_at     timestamptz,
  web_url        text,
  in_area        boolean NOT NULL DEFAULT false,
  superseded_by  uuid REFERENCES official_warnings(id) ON DELETE SET NULL,
  cancelled      boolean NOT NULL DEFAULT false,
  banner_id      uuid REFERENCES banners(id) ON DELETE SET NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, identifier)
);
CREATE INDEX official_warnings_recent_idx ON official_warnings (received_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connections','social_publications','official_warnings','fe2_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION blaulichtcms_notify_change()', t || '_notify', t);
  END LOOP;
END $$;
