-- Begrüßung neuer Konten (#255): Das Dashboard zeigt neu angelegten Konten einmal eine Karte mit den ersten Schritten
-- ihrer Rolle (Merker preferences.welcomeDone, gesetzt mit „Verstanden“). Konten, die es vor diesem Update schon gab,
-- kennen BlaulichtCMS – sie bekommen die Karte nicht.
UPDATE users SET preferences = preferences || '{"welcomeDone": true}'::jsonb WHERE NOT (preferences ? 'welcomeDone');
