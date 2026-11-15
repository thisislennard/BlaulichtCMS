-- Standort „unbekannt“ (NULL) für Formate, die nicht ausgewertet werden können, z. B. HEIC (#74).
ALTER TABLE media ALTER COLUMN had_location DROP NOT NULL;
