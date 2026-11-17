-- Presseverteiler (#244): Nachweis der Rechtsgrundlage, Wiedervorlage, Frist für Versandprotokolle, Sperrvermerk.
--
-- Rechtsgrundlage je Kontakt (public = öffentliche Redaktionsadresse/Öffentlichkeitsarbeit, Art. 6 Abs. 1 lit. e;
-- consent = Einwilligung, Art. 6 Abs. 1 lit. a, mit Datum; other = andere, im Nachweis beschrieben). Bestehende Kontakte
-- bleiben ohne Angabe und erscheinen in der Wiedervorlage („Zu prüfen“).
ALTER TABLE press_contacts ADD COLUMN IF NOT EXISTS legal_basis text CHECK (legal_basis IN ('public','consent','other'));
ALTER TABLE press_contacts ADD COLUMN IF NOT EXISTS consent_at date;
-- „Geprüft“ in der Wiedervorlage (Kontakte ohne Versand/Änderung seit privacy.press_contact_review_months)
ALTER TABLE press_contacts ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS press_release_recipients_contact_idx ON press_release_recipients (contact_id) WHERE contact_id IS NOT NULL;

-- Versandprotokolle nach privacy.press_release_log_months: Empfängerzeilen werden gelöscht, die Zähler bleiben hier
ALTER TABLE press_releases ADD COLUMN IF NOT EXISTS recipients_total integer;
ALTER TABLE press_releases ADD COLUMN IF NOT EXISTS recipients_sent integer;
ALTER TABLE press_releases ADD COLUMN IF NOT EXISTS recipients_failed integer;
ALTER TABLE press_releases ADD COLUMN IF NOT EXISTS log_purged_at timestamptz;

-- Sperrvermerk abgemeldeter Kontakte auf das Nötige reduzieren (ab jetzt geschieht das bei der Abmeldung selbst):
-- Adresse, Abmeldezeitpunkt und vermerkte Rechtsgrundlage bleiben, Name, Medium, Telefon, Notiz, Herkunft, Freitext
-- und Listen entfallen.
UPDATE press_contacts SET name = '', outlet = '', phone = '', note = '', origin = '', consent = ''
 WHERE unsubscribed_at IS NOT NULL AND (name <> '' OR outlet <> '' OR phone <> '' OR note <> '' OR origin <> '' OR consent <> '');
DELETE FROM press_list_members m USING press_contacts c WHERE c.id = m.contact_id AND c.unsubscribed_at IS NOT NULL;
