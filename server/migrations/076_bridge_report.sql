-- #186: Die Bridge meldet Kategorien, Abrufweg, automatische Updates und Darstellung der Hinweise (Anzeige und Auswahl in
-- BlaulichtCMS). Je Website wählbar, ob der Name der verfassenden Person für die Autorenangabe in WordPress übertragen wird.
ALTER TABLE wp_sites ADD COLUMN bridge_report jsonb;
ALTER TABLE wp_sites ADD COLUMN bridge_report_at timestamptz;
ALTER TABLE wp_sites ADD COLUMN send_author boolean NOT NULL DEFAULT false;
