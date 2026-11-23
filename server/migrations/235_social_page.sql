-- Seitenabgleich (Facebook-Seite, Instagram-Konto): alle Beiträge der Seite samt Zahlen, Kennzahlen der Seite je Tag
-- und der freigegebene Social-Feed (RSS, Website-Widget über die Bridge). Rein additiv. Gespeichert werden nur
-- Inhalte der eigenen Seite und zusammengefasste Zahlen – nie Personen, Namen oder Konten derer, die reagiert haben.

CREATE TABLE IF NOT EXISTS social_page_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  remote_id       text NOT NULL,
  -- Beitrag stammt aus BlaulichtCMS (gleiche ID wie die Veröffentlichung): Zahlen kommen dann von dort
  publication_id  uuid REFERENCES social_publications(id) ON DELETE SET NULL,
  posted_at       timestamptz NOT NULL,
  message         text NOT NULL DEFAULT '',
  permalink       text,
  media_type      text,
  -- Vorschaubild, lokal gespeichert (WebP unter <data>/social/<id>.webp); NULL = kein Bild
  image_file      text,
  image_width     integer,
  image_height    integer,
  image_source    text,
  metrics         jsonb,
  metrics_at      timestamptz,
  metrics_error   text,
  -- Nicht im Social-Feed (RSS, Website) zeigen
  hidden          boolean NOT NULL DEFAULT false,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- Auf der Seite nicht mehr vorhanden (gelöscht oder verborgen)
  removed_at      timestamptz,
  UNIQUE (connection_id, remote_id)
);
CREATE INDEX IF NOT EXISTS social_page_posts_posted_idx ON social_page_posts (posted_at DESC);

-- Kennzahlen der Seite je Tag (Follower, Aufrufe, Reichweite, Interaktionen …; je Netzwerk verschieden)
CREATE TABLE IF NOT EXISTS social_page_stats (
  connection_id   uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  day             date NOT NULL,
  metrics         jsonb NOT NULL DEFAULT '{}',
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, day)
);

-- Stand des Abgleichs je Verbindung
CREATE TABLE IF NOT EXISTS social_page_sync (
  connection_id   uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  posts_at        timestamptz,
  stats_day       date,
  ok              boolean,
  message         text,
  at              timestamptz NOT NULL DEFAULT now()
);

-- Freigegebener Social-Feed (eine Zeile)
CREATE TABLE IF NOT EXISTS social_feed_config (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled         boolean NOT NULL DEFAULT false,
  connection_ids  uuid[] NOT NULL DEFAULT '{}',
  max_items       integer NOT NULL DEFAULT 12,
  rss_token_hash  text,
  rss_created_at  timestamptz,
  rss_used_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO social_feed_config (id) VALUES (1) ON CONFLICT DO NOTHING;
