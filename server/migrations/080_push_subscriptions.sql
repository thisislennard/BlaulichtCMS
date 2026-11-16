-- Push-Benachrichtigungen (#191): ein Abo je Browser/Gerät und Konto (Web Push, RFC 8030/8291/8292).
-- endpoint ist die Adresse beim Push-Dienst des Browsers; p256dh/auth sind die öffentlichen Schlüssel des Geräts zum
-- Verschlüsseln der Inhalte (keine Zugangsdaten zu einer Schnittstelle – ohne den privaten VAPID-Schlüssel des Servers,
-- der verschlüsselt in `secrets` liegt, lässt sich damit nichts zustellen).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint         text NOT NULL UNIQUE,
  p256dh           text NOT NULL,
  auth             text NOT NULL,
  label            text NOT NULL DEFAULT '',
  -- öffentlicher VAPID-Schlüssel, mit dem das Abo angelegt wurde (nach Schlüsselwechsel ungültig)
  vapid_key        text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  failures         integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
