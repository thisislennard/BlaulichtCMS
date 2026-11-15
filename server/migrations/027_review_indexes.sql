-- Fehlende Indizes aus dem Datenmodell-Review (#170). Rein additiv.
-- Sperr- und Prüfabfragen nach Freigabe (Freigabe-Widerruf #145, inFlight-Prüfungen, Löschen von Freigaben über FK)
CREATE INDEX IF NOT EXISTS publications_approval_idx ON publications (approval_id);
CREATE INDEX IF NOT EXISTS social_publications_approval_idx ON social_publications (approval_id);
CREATE INDEX IF NOT EXISTS warning_sends_approval_idx ON warning_sends (approval_id);
-- „Wird die Datei in einer Fassung verwendet?“ (Löschsperre, Löschfristen, Datenschutzanfragen, Bridge):
-- Abfragen nutzen media_ids @> ARRAY[id] (GIN) bzw. cover_id = id
CREATE INDEX IF NOT EXISTS post_revisions_media_gin ON post_revisions USING gin (media_ids);
CREATE INDEX IF NOT EXISTS post_revisions_cover_idx ON post_revisions (cover_id) WHERE cover_id IS NOT NULL;
-- Sammeldownloads mit einer bestimmten Datei verwerfen (#163) und Upload-Sitzungen einer Datei entkoppeln (#176)
CREATE INDEX IF NOT EXISTS exports_media_gin ON exports USING gin (media_ids);
CREATE INDEX IF NOT EXISTS upload_sessions_media_idx ON upload_sessions (media_id) WHERE media_id IS NOT NULL;
