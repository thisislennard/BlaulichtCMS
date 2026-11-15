-- Amtliche Warnungen: zuletzt in der Quelle gesehen (#180). Die Löschfrist läuft erst, wenn eine Warnung abgelaufen ist
-- UND die Quelle sie nicht mehr liefert – sonst würde eine noch gelieferte Warnung beim nächsten Abruf erneut angelegt
-- (erneute Benachrichtigung, erneutes Auto-Banner).
ALTER TABLE official_warnings ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
