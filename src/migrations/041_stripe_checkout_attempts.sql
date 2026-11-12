BEGIN;

-- Persist before calling Stripe so a timeout/restart retries the exact same request.
CREATE TABLE stripe_checkout_attempts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(100) NOT NULL UNIQUE,
  request JSONB NOT NULL,
  session_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
