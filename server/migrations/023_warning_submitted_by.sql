-- Vier-Augen-Prinzip für Warnentwürfe (#153): wer eine Fassung eingereicht hat, darf sie nicht selbst freigeben.
ALTER TABLE warning_revisions ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id) ON DELETE SET NULL;
