-- Erweiterte Optionen je Upload-Link wie LiFeOS: Grenzen (Uploads, Dateien je Upload, Gesamtgröße, „schließen bei
-- Grenze“), erlaubte Dateitypen, abgefragte Angaben der Hochladenden (je aus/optional/Pflicht), Bestätigung vor dem
-- Upload und optionales Passwort. Angaben der Hochladenden werden nach privacy.uploader_months entfernt. Rein additiv.
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS max_uploads integer NOT NULL DEFAULT 0;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS max_files_per_upload integer NOT NULL DEFAULT 0;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS max_total_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS close_when_full boolean NOT NULL DEFAULT false;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS allowed_types text[];
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS fields jsonb;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS consent_required boolean NOT NULL DEFAULT false;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS consent_text text NOT NULL DEFAULT '';
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS uploader jsonb;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE media ADD COLUMN IF NOT EXISTS uploader jsonb;
ALTER TABLE media ADD COLUMN IF NOT EXISTS consent_at timestamptz;
CREATE INDEX IF NOT EXISTS media_uploader_idx ON media (created_at) WHERE uploader IS NOT NULL;
