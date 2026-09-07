CREATE TABLE IF NOT EXISTS gig_notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  gig_id INTEGER NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  gig_date DATE NOT NULL,
  gig_time TIME NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_gig_notification_delivery
    UNIQUE (
      gig_id,
      user_id,
      notification_type,
      gig_date,
      gig_time
    )
);

CREATE INDEX IF NOT EXISTS idx_gig_notification_deliveries_gig
ON gig_notification_deliveries(gig_id);

CREATE INDEX IF NOT EXISTS idx_gig_notification_deliveries_user
ON gig_notification_deliveries(user_id);
