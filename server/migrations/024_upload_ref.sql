-- Vorgangsnummer je Upload-Vorgang (#141, Art. 15/17 DSGVO): Die Upload-Seite zeigt sie an; über sie lassen sich
-- Anfragen auf Auskunft oder Löschung den Dateien eines Vorgangs zuordnen (Verwaltung → Datenschutzanfragen).
ALTER TABLE media ADD COLUMN upload_ref text;
ALTER TABLE upload_sessions ADD COLUMN upload_ref text;
CREATE INDEX media_upload_ref_idx ON media (upload_ref) WHERE upload_ref IS NOT NULL;
