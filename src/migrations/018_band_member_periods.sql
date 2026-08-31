-- Migración 018: Historial de periodos de membresía en bandas

CREATE TABLE IF NOT EXISTS band_member_periods (
  id SERIAL PRIMARY KEY,
  band_id INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT band_member_periods_valid_dates
    CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE INDEX IF NOT EXISTS idx_band_member_periods_band_user
  ON band_member_periods (band_id, user_id);

CREATE INDEX IF NOT EXISTS idx_band_member_periods_user_dates
  ON band_member_periods (user_id, joined_at, left_at);

-- Los miembros que existen actualmente deben tener un periodo abierto.
-- Conservamos el joined_at original de band_members.
INSERT INTO band_member_periods (
  band_id,
  user_id,
  joined_at,
  left_at
)
SELECT
  bm.band_id,
  bm.user_id,
  COALESCE(bm.joined_at, NOW()),
  NULL
FROM band_members bm
WHERE NOT EXISTS (
  SELECT 1
  FROM band_member_periods bmp
  WHERE bmp.band_id = bm.band_id
    AND bmp.user_id = bm.user_id
    AND bmp.left_at IS NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_band_member_periods_one_open
  ON band_member_periods (band_id, user_id)
  WHERE left_at IS NULL;