-- Zeitpunkt der letzten Bestätigung mit Passwort (und ggf. Code) je Sitzung (#109). Kritische Aktionen verlangen
-- eine Bestätigung, die höchstens wenige Minuten alt ist („Step-up“).
ALTER TABLE sessions ADD COLUMN reauth_at timestamptz;
