-- #202: iCal-Kalender einlesen und den Kalender als iCal-Abo anbieten.
-- Die Adresse einer Quelle kann einen Zugangstoken enthalten – sie liegt ausschließlich verschlüsselt in `secrets`
-- (url_secret_id); gespeichert wird hier nur der Hostname zur Anzeige.
CREATE TABLE calendar_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  url_secret_id   uuid NOT NULL,
  url_host        text NOT NULL,
  category_id     uuid REFERENCES calendar_categories(id) ON DELETE SET NULL,
  interval_min    integer NOT NULL DEFAULT 60 CHECK (interval_min BETWEEN 15 AND 1440),
  active          boolean NOT NULL DEFAULT true,
  etag            text,
  last_modified   text,
  last_fetch_at   timestamptz,
  last_success_at timestamptz,
  last_error      text,
  last_count      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Eingelesene Termine gehören zu ihrer Quelle; je Quelle eindeutig über UID (+ RECURRENCE-ID bei geänderten Terminen)
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_source_fk FOREIGN KEY (source_id) REFERENCES calendar_sources(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX calendar_events_ical_uid ON calendar_events (source_id, uid, recurrence_id) NULLS NOT DISTINCT WHERE source = 'ical';

-- Empfangsprotokoll je Abruf (ohne Inhalte der Termine)
CREATE TABLE calendar_source_log (
  id          bigserial PRIMARY KEY,
  source_id   uuid NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  trigger     text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual','test')),
  ok          boolean NOT NULL,
  http_status integer,
  not_modified boolean NOT NULL DEFAULT false,
  events      integer NOT NULL DEFAULT 0,
  added       integer NOT NULL DEFAULT 0,
  changed     integer NOT NULL DEFAULT 0,
  removed     integer NOT NULL DEFAULT 0,
  bytes       integer,
  duration_ms integer,
  message     text,
  warnings    jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX calendar_source_log_source ON calendar_source_log (source_id, at DESC);

-- iCal-Abo je Person: nur die Prüfsumme des geheimen Links wird gespeichert
CREATE TABLE calendar_feeds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token_hash          text NOT NULL UNIQUE,
  categories          uuid[] NOT NULL DEFAULT '{}',
  include_description boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz
);
