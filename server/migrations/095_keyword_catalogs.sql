-- Stichwortverzeichnisse der Länder (#195): Kategorie, ausführliches Meldebild und Herkunft je Stichwort.
-- Herkunft: Länderkürzel des übernommenen Verzeichnisses (z. B. 'HE') oder 'eigen' für selbst gepflegte bzw.
-- importierte Einträge. Bestehende Stichwörter sind selbst gepflegt.
ALTER TABLE fire_keywords
  ADD COLUMN category text NOT NULL DEFAULT '',
  ADD COLUMN details  text NOT NULL DEFAULT '',
  ADD COLUMN source   text NOT NULL DEFAULT 'eigen';

CREATE INDEX fire_keywords_source_idx ON fire_keywords (source);
