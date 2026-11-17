-- Bridge-Aufträge der Einsatzliste (#242): Die Momentaufnahme des Eintrags (Titel, Bericht, Ort, Fahrzeuge …) wird nur
-- gebraucht, solange der Auftrag unterwegs ist. Erledigte, fehlgeschlagene und abgebrochene Aufträge behalten nur die
-- Kennung des Eintrags, die Fassung und die Bild-IDs (Bildabruf der Website, solange der Eintrag dort steht). Der
-- Trigger gilt für jeden Weg, auf dem ein Auftrag abgeschlossen wird.
CREATE OR REPLACE FUNCTION blaulichtcms_incident_job_slim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.payload := jsonb_strip_nulls(jsonb_build_object(
    'id', NEW.payload->'id',
    'revision', NEW.payload->'revision',
    'media_ids', COALESCE(NEW.payload->'media_ids', '[]'::jsonb)));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS incident_jobs_slim ON incident_jobs;
CREATE TRIGGER incident_jobs_slim BEFORE INSERT OR UPDATE ON incident_jobs
  FOR EACH ROW WHEN (NEW.status IN ('done', 'failed', 'canceled')) EXECUTE FUNCTION blaulichtcms_incident_job_slim();

-- Bestand: abgeschlossene Aufträge auf die Kennung reduzieren (der Trigger greift beim Aktualisieren) …
UPDATE incident_jobs SET payload = payload WHERE status IN ('done', 'failed', 'canceled') AND payload ? 'title';
-- … und Aufträge bereits gelöschter Einträge entfernen (seit #242 löscht das Löschen eines Eintrags sie mit)
DELETE FROM incident_jobs WHERE entry_id IS NULL AND status IN ('done', 'failed', 'canceled');
