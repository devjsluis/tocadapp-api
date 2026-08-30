ALTER TABLE bands
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_bands_archived_at
ON bands(archived_at);
