-- Banner folgt dem Vorgang (#274): Banner aus Workflows kennen ihre Herkunft und werden bei Aktualisierungen desselben
-- Vorgangs (amtliche Warnung: Wurzel der CAP-Kette; Einsatz: Verbindung + Einsatz-ID) aktualisiert statt neu angelegt
-- und bei Entwarnung bzw. Einsatzende beendet. Vorgang-Schlüssel nur als Prüfsumme.
ALTER TABLE banners ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE banners ADD COLUMN IF NOT EXISTS automation_id uuid REFERENCES automations(id) ON DELETE SET NULL;
ALTER TABLE banners ADD COLUMN IF NOT EXISTS automation_output_id uuid REFERENCES automation_outputs(id) ON DELETE SET NULL;
-- folgt dem Vorgang (Option der Banner-Aktion beim Anlegen bzw. letzten Aktualisieren)
ALTER TABLE banners ADD COLUMN IF NOT EXISTS follows boolean NOT NULL DEFAULT false;
-- Prüfsumme des Inhalts, den der Workflow zuletzt geschrieben hat (weicht sie ab, wurde das Banner von Hand geändert)
ALTER TABLE banners ADD COLUMN IF NOT EXISTS follow_hash text;
-- Zeitpunkt des Ereignisses (Lauf), dessen Inhalt das Banner zeigt – ältere Meldungen überschreiben keinen neueren Stand
ALTER TABLE banners ADD COLUMN IF NOT EXISTS follow_event_at timestamptz;
-- Grund des Endes, wenn der Vorgang es beendet hat (sonst NULL, z. B. „Jetzt beenden“ von Hand)
ALTER TABLE banners ADD COLUMN IF NOT EXISTS ended_reason text CHECK (ended_reason IN ('entwarnung', 'einsatz_beendet'));
CREATE INDEX IF NOT EXISTS banners_source_key_idx ON banners (source_key) WHERE source_key IS NOT NULL;

-- Beendete Vorgänge (Prüfsumme), damit ein noch wartender Lauf der Erstmeldung danach kein Banner mehr anlegt;
-- Einträge älter als 30 Tage entfallen beim nächsten Ende.
CREATE TABLE IF NOT EXISTS banner_follow_ends (
  source_key text PRIMARY KEY,
  reason     text NOT NULL CHECK (reason IN ('entwarnung', 'einsatz_beendet')),
  ended_at   timestamptz NOT NULL DEFAULT now()
);

-- Wurzel der CAP-Kette je Meldung (Kennung der Erstmeldung), beim Empfang gesetzt
ALTER TABLE official_warnings ADD COLUMN IF NOT EXISTS chain_root text;
