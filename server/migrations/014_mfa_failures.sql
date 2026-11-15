-- Fehlversuche beim zweiten Faktor getrennt zählen (#64): eine erfolgreiche Passwortanmeldung setzt sie nicht zurück.
ALTER TABLE users ADD COLUMN mfa_failed integer NOT NULL DEFAULT 0;
