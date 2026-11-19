-- Bannerliste zeigt das tatsächliche Ende (#276): wer ein Banner von Hand beendet hat („Jetzt beenden“ oder
-- „Amtliche Warnung ausblenden“). Automatisch beendete Banner (Entwarnung, Einsatzende, Aktualisierung) bleiben NULL.
ALTER TABLE banners ADD COLUMN IF NOT EXISTS ended_by uuid REFERENCES users(id) ON DELETE SET NULL;
