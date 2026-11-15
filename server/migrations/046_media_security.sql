-- Admin-Sicherheit wie LiFeOS: abgewiesene Dateien werden gesperrt statt sofort gelöscht (bleiben in der Quarantäne,
-- „Erneut prüfen“, bei Videos mit reinem Dekodierfehler „Trotzdem freigeben“); Schadsoftware bleibt „rejected“
-- (Datei sofort gelöscht, nie freigebbar). Dazu ein Protokoll der Sicherheitsereignisse der öffentlichen Seiten
-- (ohne Klar-IP, nur gekürzter HMAC). Rein additiv.
ALTER TABLE media DROP CONSTRAINT IF EXISTS media_status_check;
ALTER TABLE media ADD CONSTRAINT media_status_check CHECK (status IN ('quarantine', 'ready', 'rejected', 'blocked'));
ALTER TABLE media ADD COLUMN IF NOT EXISTS reject_step text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS skip_decode boolean NOT NULL DEFAULT false;
ALTER TABLE media ADD COLUMN IF NOT EXISTS released_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS released_at timestamptz;
CREATE INDEX IF NOT EXISTS media_blocked_idx ON media (processed_at) WHERE status = 'blocked';

CREATE TABLE IF NOT EXISTS public_security_events (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  event     text NOT NULL,
  link_id   uuid REFERENCES upload_links(id) ON DELETE SET NULL,
  media_id  uuid REFERENCES media(id) ON DELETE SET NULL,
  ip_hash   text NOT NULL DEFAULT '',
  detail    text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS public_security_events_at_idx ON public_security_events (at DESC);
CREATE INDEX IF NOT EXISTS public_security_events_event_idx ON public_security_events (event, at DESC);
