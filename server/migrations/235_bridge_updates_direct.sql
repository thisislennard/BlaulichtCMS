-- Bridge-Updates ohne Stufen und Freigabe: Jede gekoppelte Website erhält die Bridge-Version, die im laufenden
-- BlaulichtCMS steckt. Update-Stufe je Website und Freigabeliste entfallen.
DROP TABLE IF EXISTS bridge_releases;
ALTER TABLE wp_sites DROP COLUMN IF EXISTS update_channel;
