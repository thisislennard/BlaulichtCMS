-- „Angemeldet bleiben“ und „Zwei-Faktor auf diesem Gerät merken“.
--
-- sessions.remember: bei vollen Sitzungen = gemerkte Sitzung (keine Leerlaufabmeldung, gleitender Ablauf nach
-- `security.remember_days` seit der letzten Nutzung); bei Zwischenstufen (mfa, mfa_setup) = Wunsch von der
-- Anmeldeseite, der beim Übergang zur vollen Sitzung angewendet wird.
-- sessions.device_hash: Bindung einer gemerkten Sitzung an das Gerät (sha256 aus Konto und Kennung des signierten
-- Geräte-Cookies). Ohne passendes Geräte-Cookie wird die Sitzung abgewiesen und beendet.
ALTER TABLE sessions ADD COLUMN remember boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN device_hash text;

-- Vertrauenswürdige Geräte: auf diesem Gerät für eine begrenzte Zeit keinen Zwei-Faktor-Code abfragen. Nur
-- serverseitig gültig (kein Merker im Browser allein); gespeichert wird nur ein Hash der Gerätekennung.
CREATE TABLE trusted_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash  text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id);
CREATE UNIQUE INDEX trusted_devices_active_uq ON trusted_devices (user_id, device_hash) WHERE revoked_at IS NULL;
