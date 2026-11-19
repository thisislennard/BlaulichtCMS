-- Sicherung außer Haus auch auf eine SMB-Freigabe (Windows-Server, DFS, NAS) über smbclient – neben WebDAV.
-- Bei SMB steht in url der UNC-Pfad (\server\freigabe\ordner); dazu die Domäne des Kontos (leer = ohne).
ALTER TABLE backup_offsite DROP CONSTRAINT IF EXISTS backup_offsite_kind_check;
ALTER TABLE backup_offsite ADD CONSTRAINT backup_offsite_kind_check CHECK (kind IN ('webdav', 'smb'));
ALTER TABLE backup_offsite ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT '';
