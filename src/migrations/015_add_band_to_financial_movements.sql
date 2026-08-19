ALTER TABLE financial_movements
ADD COLUMN IF NOT EXISTS band_id INTEGER
REFERENCES bands(id)
ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_financial_movements_band_id
ON financial_movements(band_id);