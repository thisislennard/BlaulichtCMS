-- Upload-Links bedienen wie in LiFeOS: pausieren/fortsetzen, verlängern, Ablauf auf einen Termin setzen, Begrüßungstext
-- je Link und „Neu erzeugen“ (neuer Token, alter Link und QR-Code sofort ungültig). Rein additiv.
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS paused_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS welcome_text text NOT NULL DEFAULT '';
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS regenerated_at timestamptz;
-- Einstellung „Link nur einmal anzeigen“ (media.link_show_once): dann bleibt nur die Prüfsumme gespeichert, der
-- verschlüsselte Token entfällt und Link/QR-Code lassen sich später nicht mehr anzeigen.
ALTER TABLE upload_links ALTER COLUMN token_enc DROP NOT NULL;
