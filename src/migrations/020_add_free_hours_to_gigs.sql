ALTER TABLE gigs
ADD COLUMN IF NOT EXISTS free_hours NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE gigs
DROP CONSTRAINT IF EXISTS gigs_free_hours_check;

ALTER TABLE gigs
ADD CONSTRAINT gigs_free_hours_check
CHECK (
  free_hours >= 0
  AND free_hours <= hours
);
