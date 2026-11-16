-- Empfangsprotokoll der eingehenden Verbindungen (Warnfeeds, FE2, Feuersoftware Connect): je Abruf bzw. eingehender
-- Meldung ein Eintrag (Auslöser, Ergebnis, Dauer, HTTP-Status, Anzahl empfangen/übernommen), je gelieferter Meldung
-- die Entscheidung mit Begründung – auch für herausgefilterte. Rohdaten liegen inhaltsgleich nur einmal vor
-- (Prüfsumme), bei FE2 und Feuersoftware nur geschwärzt (ohne Straße, Hausnummer, Koordinaten, Namen, Telefonnummern,
-- Freitext). Löschfrist `privacy.receipt_days` (Standard 7 Tage), höchstens 500 Einträge je Verbindung. Rein additiv.
CREATE TABLE IF NOT EXISTS connection_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  trigger        text NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'inbound', 'test')),
  ok             boolean NOT NULL,
  error          text,
  http_status    integer,
  duration_ms    integer,
  received       integer NOT NULL DEFAULT 0,
  accepted       integer NOT NULL DEFAULT 0,
  filtered       integer NOT NULL DEFAULT 0,
  errors         integer NOT NULL DEFAULT 0,
  summary        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_receipts_conn_idx ON connection_receipts (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connection_receipts_created_idx ON connection_receipts (created_at);

CREATE TABLE IF NOT EXISTS connection_receipt_raws (
  hash          text PRIMARY KEY,
  body          text NOT NULL,
  truncated     boolean NOT NULL DEFAULT false,
  bytes         integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connection_receipt_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id  uuid NOT NULL REFERENCES connection_receipts(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  decision    text NOT NULL CHECK (decision IN ('accepted', 'updated', 'known', 'filtered', 'dismissed', 'suppressed', 'error', 'test')),
  reason      text NOT NULL,
  info        jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_hash    text
);
CREATE INDEX IF NOT EXISTS connection_receipt_items_receipt_idx ON connection_receipt_items (receipt_id, position);
CREATE INDEX IF NOT EXISTS connection_receipt_items_raw_idx ON connection_receipt_items (raw_hash);
