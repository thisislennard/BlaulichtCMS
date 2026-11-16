-- Einsatzliste auf der Website (#213): Einträge mit Freigabe genau dieser Fassung, Aufträge an die Bridge und
-- Einstellungen (Ortsangaben-Allowlist, Standard-Website). Bewusst keine Adressen, keine Namen: der Ort steht nur auf
-- Ortsteil-Ebene, eingehende Alarme liefern ohnehin nur die Felder der Allowlist der Verbindung.

CREATE TABLE IF NOT EXISTS incident_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid REFERENCES wp_sites(id) ON DELETE SET NULL,
  revision        integer NOT NULL DEFAULT 1,
  content_hash    text NOT NULL,
  alarm_at        timestamptz NOT NULL,
  -- Laufende Nummer im Jahr (optional; ohne Angabe zählt die Website nach Alarmzeit)
  number          integer CHECK (number IS NULL OR number BETWEEN 1 AND 99999),
  keyword         text NOT NULL DEFAULT '',
  keyword_label   text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT '',
  title           text NOT NULL,
  location        text NOT NULL DEFAULT '',
  report          text NOT NULL DEFAULT '',
  vehicles        text NOT NULL DEFAULT '',
  units           text NOT NULL DEFAULT '',
  link_url        text,
  featured        boolean NOT NULL DEFAULT false,
  false_alarm     boolean NOT NULL DEFAULT false,
  media_ids       uuid[] NOT NULL DEFAULT '{}',
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','alarm','workflow','import')),
  -- Herkunft für das Entprellen (Einsatzmeldung bzw. Workflow-Schlüssel); keine Inhalte
  source_ref      text,
  fe2_event_id    uuid REFERENCES fe2_events(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at    timestamptz,
  submitted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_hash   text,
  approved_at     timestamptz,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  rejected_note   text,
  withdrawn_at    timestamptz
);
CREATE INDEX IF NOT EXISTS incident_entries_alarm_idx ON incident_entries (alarm_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS incident_entries_source_ref_idx ON incident_entries (source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS incident_entries_event_idx ON incident_entries (fe2_event_id) WHERE fe2_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS incident_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid REFERENCES incident_entries(id) ON DELETE SET NULL,
  site_id     uuid NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('upsert','delete')),
  revision    integer NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','done','failed','canceled')),
  attempts    integer NOT NULL DEFAULT 0,
  error       text,
  remote_id   text,
  remote_url  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  fetched_at  timestamptz,
  result_at   timestamptz
);
CREATE INDEX IF NOT EXISTS incident_jobs_site_idx ON incident_jobs (site_id, status, created_at);
CREATE INDEX IF NOT EXISTS incident_jobs_entry_idx ON incident_jobs (entry_id, created_at DESC);

-- Eine Zeile: Allowlist der Ortsangaben (leer = Freitext mit Adressprüfung) und Standard-Website
CREATE TABLE IF NOT EXISTS incident_list_config (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  locations        text[] NOT NULL DEFAULT '{}',
  default_site_id  uuid REFERENCES wp_sites(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO incident_list_config (id) VALUES (true) ON CONFLICT DO NOTHING;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incident_entries','incident_jobs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_notify') THEN
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION blaulichtcms_notify_change()', t || '_notify', t);
    END IF;
  END LOOP;
END $$;

-- Neuer Workflow-Ausgang „Einsatz in Einsatzliste“. Die erlaubten Arten werden aus der bestehenden Prüfung gelesen und
-- nur um diese Art ergänzt – so bleiben Arten erhalten, die andere Migrationen ergänzt haben (Reihenfolge egal).
DO $$
DECLARE
  con text;
  def text;
  kinds text[];
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO con, def
    FROM pg_constraint c
   WHERE c.conrelid = 'automation_outputs'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%kind%'
   LIMIT 1;
  IF con IS NULL THEN
    RETURN;
  END IF;
  IF def ILIKE '%''incident_entry''%' THEN
    RETURN;
  END IF;
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(def, '''([a-z_]+)''', 'g') AS m;
  kinds := array_append(kinds, 'incident_entry');
  EXECUTE format('ALTER TABLE automation_outputs DROP CONSTRAINT %I', con);
  EXECUTE format('ALTER TABLE automation_outputs ADD CONSTRAINT %I CHECK (kind IN (%s))', con, (SELECT string_agg(quote_literal(k), ',') FROM unnest(kinds) AS k));
END $$;
