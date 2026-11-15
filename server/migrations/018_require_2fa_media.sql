-- Zwei-Faktor-Pflicht für Rollen mit „Medien verwalten“ (#140): für neue Installationen Standard „an“
-- (DEFAULT_SETTINGS). Bestehende Installationen (es gibt schon Konten) behalten ihr bisheriges Verhalten, bis die
-- Administration die Einstellung unter Einstellungen → Sicherheit einschaltet.
INSERT INTO settings (key, value)
SELECT 'security.require_2fa_media', 'false'::jsonb
 WHERE EXISTS (SELECT 1 FROM users)
ON CONFLICT (key) DO NOTHING;
