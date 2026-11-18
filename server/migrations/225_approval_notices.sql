-- Freigaben und Benachrichtigungen (#251, #253): Benachrichtigungen bekommen einen Objektbezug und einen Erledigt-Stand.
-- Freigabe-Anfragen werden je Art gebündelt (group_key 'approval:<art>'); nach der Entscheidung, dem Zurückziehen oder
-- Löschen gelten sie als erledigt und zählen bei niemandem mehr als ungelesen.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS object_type text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS object_id text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_note text;
CREATE INDEX IF NOT EXISTS notifications_open_object_idx ON notifications (object_type, object_id) WHERE resolved_at IS NULL AND object_type IS NOT NULL;

-- Bestehende Freigabe-Anfragen: Art und – wo der Link es hergibt – Objekt nachtragen, damit der Abgleich im Worker
-- längst entschiedene Anfragen als erledigt markieren kann (z. B. Einträge der Einsatzliste, die schon veröffentlicht sind).
UPDATE notifications SET object_type = CASE permission
    WHEN 'approval.post' THEN 'post'
    WHEN 'approval.banner' THEN 'banner'
    WHEN 'approval.incident' THEN 'incident'
    WHEN 'warning.approve' THEN 'warning'
    WHEN 'press.approve' THEN 'press'
    WHEN 'approval.automation' THEN 'automation'
  END
 WHERE object_type IS NULL AND user_id IS NULL
   AND permission IN ('approval.post', 'approval.banner', 'approval.incident', 'warning.approve', 'press.approve', 'approval.automation');
UPDATE notifications SET object_id = substring(link FROM '^/(?:freigabe/beitrag|beitraege)/([0-9a-f-]{36})')
 WHERE object_type = 'post' AND object_id IS NULL AND link ~ '^/(freigabe/beitrag|beitraege)/[0-9a-f-]{36}';
UPDATE notifications SET object_id = substring(link FROM '[?&]banner=([0-9a-f-]{36})')
 WHERE object_type = 'banner' AND object_id IS NULL AND link ~ '[?&]banner=[0-9a-f-]{36}';
UPDATE notifications SET object_id = substring(link FROM '[?&]eintrag=([0-9a-f-]{36})')
 WHERE object_type = 'incident' AND object_id IS NULL AND link ~ '[?&]eintrag=[0-9a-f-]{36}';
UPDATE notifications SET object_id = substring(link FROM '^/warnungen/([0-9a-f-]{36})')
 WHERE object_type = 'warning' AND object_id IS NULL AND link ~ '^/warnungen/[0-9a-f-]{36}';

-- Live-Ereignisse auch für Antworten an die Presse und Freigaben aus Workflows: Zähler und Freigaben-Liste laden neu
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['press_messages', 'automation_approvals'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_notify') THEN
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION blaulichtcms_notify_change()', t || '_notify', t);
    END IF;
  END LOOP;
END $$;
