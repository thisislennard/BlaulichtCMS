-- Gesichtsvorschläge (#214): Die automatische Suche (YuNet, im Worker) schlägt Bereiche zum Unkenntlichmachen vor;
-- ein Mensch übernimmt oder verwirft sie. Übernommene Vorschläge werden zu Einträgen in media.redactions.
--   face_proposals   [{id, x, y, w, h, score, status}] – normiert 0..1, bezogen auf das richtig gedrehte Bild;
--                    status open | accepted | rejected. Nur Rechteck und Konfidenz, keine Merkmale, keine Identität.
--   face_status      NULL (nie gesucht) | queued | done | failed | unavailable
--   face_checked_at  Zeitpunkt der letzten Suche, face_model Modellkennung (z. B. yunet-2026may), face_error Grund
-- Die Vorschläge gehören zur Medienzeile und werden mit ihr gelöscht.
ALTER TABLE media ADD COLUMN IF NOT EXISTS face_proposals jsonb NOT NULL DEFAULT '[]';
ALTER TABLE media ADD COLUMN IF NOT EXISTS face_status text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS face_checked_at timestamptz;
ALTER TABLE media ADD COLUMN IF NOT EXISTS face_model text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS face_error text;
