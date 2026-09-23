-- Migración 027: solicitudes para unirse a bandas

CREATE TABLE IF NOT EXISTS band_join_requests (
  id SERIAL PRIMARY KEY,

  band_id INTEGER NOT NULL
    REFERENCES bands(id) ON DELETE CASCADE,

  user_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,

  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by INTEGER NULL
    REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT band_join_requests_valid_status
    CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_band_join_requests_one_pending
  ON band_join_requests (band_id, user_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_band_join_requests_band_status
  ON band_join_requests (band_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_band_join_requests_user
  ON band_join_requests (user_id, created_at DESC);
