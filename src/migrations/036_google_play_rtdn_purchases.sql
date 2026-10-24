BEGIN;

-- 035 must be applied first: ownership remains in google_play_purchase_tokens.
-- This inbox stores work, not entitlement or proof of ownership.
CREATE TABLE google_play_rtdn_purchases (
  purchase_token TEXT PRIMARY KEY,
  notification_type INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'DEFERRED', 'RETRY', 'PROCESSED')),
  version BIGINT NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  reason TEXT,
  google_snapshot JSONB,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX ix_google_play_rtdn_pending
  ON google_play_rtdn_purchases (last_attempt_at, purchase_token)
  WHERE status <> 'PROCESSED';

COMMIT;
