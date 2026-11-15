-- Feuersoftware Connect als zweite Einsatzquelle neben FE2 (Abruf statt Eingang).
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('fe2','facebook','instagram','warnfeed','feuersoftware'));

-- Abrufzustand für abfragende Verbindungen: letzter Abruf (auch als Sperre gegen parallele Abrufe), vom Anbieter
-- erbetene Pause (Retry-After) und Zahl der Fehlschläge in Folge (Meldung an die Verwaltung ab einer Schwelle)
ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_poll_at timestamptz;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS retry_after_until timestamptz;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;

-- Herkunft einer Einsatzmeldung (fe2 | feuersoftware); bestehende Meldungen stammen aus FE2
ALTER TABLE fe2_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'fe2';

-- Bereits übernommene Einsätze je Verbindung, nur als Prüfsumme der Einsatz-ID (keine Inhalte). Verhindert, dass ein
-- gelöschter Einsatz (Datenschutz-Anfrage, Löschfrist) beim nächsten Abruf neu angelegt wird. Der Worker entfernt
-- Einträge nach 30 Tagen – die Quelle liefert nur Einsätze der letzten Stunden.
CREATE TABLE IF NOT EXISTS connection_seen_events (
  connection_id  uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  ref_hash       text NOT NULL,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, ref_hash)
);
CREATE INDEX IF NOT EXISTS connection_seen_events_age_idx ON connection_seen_events (seen_at);
