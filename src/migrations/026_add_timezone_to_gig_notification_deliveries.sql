ALTER TABLE gig_notification_deliveries
ADD COLUMN IF NOT EXISTS gig_timezone VARCHAR(100)
NOT NULL
DEFAULT 'America/Mexico_City';

ALTER TABLE gig_notification_deliveries
DROP CONSTRAINT IF EXISTS gig_notification_timezone_not_empty;

ALTER TABLE gig_notification_deliveries
ADD CONSTRAINT gig_notification_timezone_not_empty
CHECK (BTRIM(gig_timezone) <> '');

ALTER TABLE gig_notification_deliveries
DROP CONSTRAINT IF EXISTS uq_gig_notification_delivery;

ALTER TABLE gig_notification_deliveries
ADD CONSTRAINT uq_gig_notification_delivery
UNIQUE (
  gig_id,
  user_id,
  notification_type,
  gig_date,
  gig_time,
  gig_timezone
);
