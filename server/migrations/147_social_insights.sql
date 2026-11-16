-- Reichweite der Social-Posts (#218). Rein additiv. Gespeichert werden nur zusammengefasste Zahlen je Beitrag und
-- Kanal (Aufrufe, Reichweite, Interaktionen) – nie Personen, Namen oder Konten derer, die reagiert haben.

-- Abrufstufe: 0 = noch keiner, 1 = nach 1 Stunde, 2 = nach 24 Stunden, 3 = nach 7 Tagen (letzter Abruf)
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS insights_stage smallint NOT NULL DEFAULT 0;
-- Letzter Stand der Zahlen (für Listen und Übersicht) und Zeitpunkt bzw. Fehler des letzten Abrufs
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS insights jsonb;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS insights_at timestamptz;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS insights_error text;
CREATE INDEX IF NOT EXISTS social_publications_insights_due ON social_publications (insights_stage, published_at) WHERE status = 'published' AND insights_stage < 3;

-- Verlauf je Abruf (Stufe), damit sich die Entwicklung nach 1 h, 24 h und 7 Tagen zeigen lässt
CREATE TABLE IF NOT EXISTS social_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id  uuid NOT NULL REFERENCES social_publications(id) ON DELETE CASCADE,
  stage           smallint NOT NULL,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  metrics         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS social_insights_publication_idx ON social_insights (publication_id, fetched_at);
