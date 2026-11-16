-- Mastodon und Bluesky als soziale Kanäle (#215). Rein additiv: zwei neue Verbindungsarten.
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK (kind IN ('fe2','facebook','instagram','warnfeed','feuersoftware','threads','x','whatsapp','mastodon','bluesky'));
