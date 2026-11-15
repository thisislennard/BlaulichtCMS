-- Höchstens eine laufende Sicherung (#62). Verwaiste „running“-Zeilen (Prozess beendet) vorher abschließen.
UPDATE backups SET status = 'failed', finished_at = now(), error = 'Abgebrochen (Prozess beendet)' WHERE status = 'running';
CREATE UNIQUE INDEX backups_one_running ON backups ((true)) WHERE status = 'running';
