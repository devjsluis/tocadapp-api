ALTER TABLE gigs
ADD COLUMN IF NOT EXISTS location_address TEXT,
ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 7),
ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 7),
ADD COLUMN IF NOT EXISTS google_place_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gigs_location_coordinates_check'
  ) THEN
    ALTER TABLE gigs
    ADD CONSTRAINT gigs_location_coordinates_check
    CHECK (
      (
        latitude IS NULL
        AND longitude IS NULL
      )
      OR
      (
        latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND latitude BETWEEN -90 AND 90
        AND longitude BETWEEN -180 AND 180
      )
    );
  END IF;
END $$;
