-- Leistung (#192): Indizes für die Sammlungsübersicht.
-- Zähler je Sammlung (bereit, Quarantäne, ausgewählt, offen) als Index-Only-Scan ohne Tabellenzugriff
CREATE INDEX IF NOT EXISTS media_collection_state_idx ON media (collection_id) INCLUDE (status, selection) WHERE deleted_at IS NULL;
-- Titelbild einer Sammlung: erstes ausgewähltes, sonst erstes Bild mit Vorschau – direkt aus dem Index statt Sortieren
CREATE INDEX IF NOT EXISTS media_cover_pick_idx ON media (collection_id, (selection = 'selected') DESC, sort_order)
  WHERE deleted_at IS NULL AND status = 'ready' AND has_preview;
