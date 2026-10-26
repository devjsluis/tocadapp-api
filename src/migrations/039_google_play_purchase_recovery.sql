BEGIN;

-- Work journal only: possession/submission of a token never proves ownership.
CREATE TABLE google_play_purchase_recovery (
  purchase_token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'RETRY'
    CHECK (status IN ('RETRY', 'DEFERRED', 'PENDING', 'PROCESSED')),
  purchase_state TEXT,
  reason TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_google_play_purchase_recovery_pending
ON google_play_purchase_recovery(last_attempt_at, purchase_token)
WHERE status <> 'PROCESSED';

COMMIT;
