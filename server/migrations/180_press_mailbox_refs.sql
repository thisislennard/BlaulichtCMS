-- Presse-Postfach (#237, #239): Abruf je Mail mit gespeichertem Fortschritt. Das Empfangsprotokoll merkt sich Quelle und
-- Kennung der Mail im Postfach (IMAP: UIDVALIDITY:UID, Microsoft 365: Nachrichten-ID), damit übersprungene oder nicht
-- übernommene Mails im Postfach auffindbar sind und beim nächsten Abruf nicht erneut geholt werden. Rein additiv.
ALTER TABLE press_mailbox_log ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE press_mailbox_log ADD COLUMN IF NOT EXISTS external_id text;
CREATE INDEX IF NOT EXISTS press_mailbox_log_external_idx ON press_mailbox_log (source, external_id) WHERE external_id IS NOT NULL;
