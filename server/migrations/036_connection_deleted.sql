-- Verbindungen löschen: nie benutzte Verbindungen werden endgültig gelöscht; benutzte (Veröffentlichungen,
-- Einsatzmeldungen, amtliche Warnungen, Zielkanal in einer Fassung) werden widerrufen, ihre Geheimnisse gelöscht und
-- sie als gelöscht markiert – Bezüge (z. B. Veröffentlichungsverlauf) bleiben nachvollziehbar.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
