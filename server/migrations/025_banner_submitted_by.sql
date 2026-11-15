-- Vier-Augen-Prinzip für Banner wie bei Beiträgen und Warnentwürfen (#169): wer eine Fassung eingereicht hat, darf sie
-- nicht selbst freigeben.
ALTER TABLE banners ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id) ON DELETE SET NULL;
