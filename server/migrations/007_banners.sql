-- M2: Hinweis-Banner auf der Website (mehrere gleichzeitig, Priorität, Start, Ablauf, optionaler Link).
CREATE TABLE banners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
  revision         integer NOT NULL DEFAULT 1,
  title            text NOT NULL,
  text             text NOT NULL DEFAULT '',
  tone             text NOT NULL DEFAULT 'info' CHECK (tone IN ('info','warning','danger')),
  priority         integer NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz NOT NULL,
  link_url         text,
  link_text        text,
  content_hash     text NOT NULL,
  submitted_at     timestamptz,
  approved_hash    text,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX banners_site_idx ON banners (site_id, ends_at DESC);

CREATE TABLE banner_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  banner_id   uuid NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
  site_id     uuid NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('upsert','delete')),
  revision    integer NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','done','failed','canceled')),
  attempts    integer NOT NULL DEFAULT 0,
  fetched_at  timestamptz,
  result_at   timestamptz,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX banner_jobs_site_idx ON banner_jobs (site_id, status, created_at);
