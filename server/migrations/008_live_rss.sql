-- M2: Live-Ereignisse (für Server-Sent Events) und RSS/Atom-Quellen.

-- Jede Änderung an statusrelevanten Tabellen meldet den Tabellennamen über NOTIFY.
-- Die Oberfläche lädt daraufhin den bestätigten Stand neu (keine Inhalte im Ereignis).
CREATE OR REPLACE FUNCTION blaulichtcms_notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('blaulichtcms_events', TG_TABLE_NAME);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['posts','post_revisions','approvals','publications','media','collections','banners','banner_jobs','wp_sites','notifications'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION blaulichtcms_notify_change()', t || '_notify', t);
  END LOOP;
END $$;

CREATE TABLE rss_feeds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url             text NOT NULL UNIQUE,
  title           text NOT NULL,
  site_url        text,
  interval_min    integer NOT NULL DEFAULT 30 CHECK (interval_min BETWEEN 5 AND 1440),
  etag            text,
  last_modified   text,
  last_fetch_at   timestamptz,
  last_success_at timestamptz,
  last_error      text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE rss_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id       uuid NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
  dedup_key     text NOT NULL,
  title         text NOT NULL,
  link          text,
  summary       text NOT NULL DEFAULT '',
  published_at  timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  starred_at    timestamptz,
  starred_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  hidden_at     timestamptz,
  hidden_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  idea_post_id  uuid REFERENCES posts(id) ON DELETE SET NULL,
  UNIQUE (feed_id, dedup_key)
);
CREATE INDEX rss_items_feed_idx ON rss_items (feed_id, published_at DESC NULLS LAST);
CREATE INDEX rss_items_recent_idx ON rss_items (published_at DESC NULLS LAST) WHERE hidden_at IS NULL;

CREATE TRIGGER rss_items_notify AFTER INSERT OR UPDATE OR DELETE ON rss_items FOR EACH STATEMENT EXECUTE FUNCTION blaulichtcms_notify_change();
