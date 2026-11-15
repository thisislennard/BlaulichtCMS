-- Fehlversuche je bekanntem Gerät (#110): bekannte Geräte sind von der Kontosperre ausgenommen und haben einen
-- eigenen Zähler. key = sha256(Konto + Gerätekennung aus dem signierten Geräte-Cookie).
CREATE TABLE auth_throttle (
  key          text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  failures     integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_throttle_user_idx ON auth_throttle (user_id);
