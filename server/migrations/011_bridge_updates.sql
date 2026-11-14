-- M4: Bridge-Updates über den WordPress-Updateweg.
-- Testwebsites erhalten die im Image enthaltene Version sofort; alle anderen erst nach Freigabe.
ALTER TABLE wp_sites ADD COLUMN update_channel text NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('test','stable'));

CREATE TABLE bridge_releases (
  version       text PRIMARY KEY,
  sha256        text NOT NULL,
  tested_on     uuid REFERENCES wp_sites(id) ON DELETE SET NULL,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz NOT NULL DEFAULT now(),
  note          text NOT NULL DEFAULT ''
);
