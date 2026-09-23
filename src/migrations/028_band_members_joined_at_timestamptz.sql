-- Migración 028: normalizar fecha de ingreso de membresías a TIMESTAMPTZ

ALTER TABLE band_members
  ALTER COLUMN joined_at TYPE TIMESTAMPTZ
    USING joined_at AT TIME ZONE 'UTC';
