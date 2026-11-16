-- #200: Kalender – Kategorien mit Farben und Termine (einzeln oder wiederkehrend).
-- Wiederholungen als RRULE (RFC 5545) in Ortszeit der Zeitzone `tz`; einzelne Termine einer Serie lassen sich
-- ausnehmen (exdates = Beginn des ausgenommenen Termins) oder ändern (eigene Zeile mit series_id + recurrence_id).
-- until_at = Ende des letzten Termins einer begrenzten Serie (NULL = unbegrenzt); dient nur der Abfrage nach Zeitraum.
CREATE TABLE calendar_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color      text NOT NULL DEFAULT 'blau' CHECK (color IN ('rot','orange','gelb','gruen','tuerkis','blau','violett','grau')),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX calendar_categories_name ON calendar_categories (lower(name));

INSERT INTO calendar_categories (name, color, position) VALUES
  ('Übung', 'orange', 1),
  ('Veranstaltung', 'blau', 2),
  ('Besprechung', 'grau', 3);

CREATE TABLE calendar_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description   text NOT NULL DEFAULT '',
  location      text NOT NULL DEFAULT '',
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  all_day       boolean NOT NULL DEFAULT false,
  tz            text NOT NULL DEFAULT 'Europe/Berlin',
  category_id   uuid REFERENCES calendar_categories(id) ON DELETE SET NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  source        text NOT NULL DEFAULT 'own' CHECK (source IN ('own','ical')),
  source_id     uuid,
  uid           text,
  rrule         text,
  exdates       timestamptz[] NOT NULL DEFAULT '{}',
  until_at      timestamptz,
  series_id     uuid REFERENCES calendar_events(id) ON DELETE CASCADE,
  recurrence_id timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (ends_at >= starts_at),
  CHECK ((series_id IS NULL) = (recurrence_id IS NULL)),
  CHECK (series_id IS NULL OR rrule IS NULL)
);
CREATE INDEX calendar_events_range ON calendar_events (starts_at, ends_at) WHERE rrule IS NULL;
CREATE INDEX calendar_events_series ON calendar_events (starts_at, until_at) WHERE rrule IS NOT NULL;
CREATE INDEX calendar_events_series_id ON calendar_events (series_id) WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX calendar_events_override ON calendar_events (series_id, recurrence_id) WHERE series_id IS NOT NULL;
