BEGIN;

CREATE TABLE subscription_payments (
  id SERIAL PRIMARY KEY,

  subscription_id INTEGER NOT NULL
    REFERENCES subscriptions(id)
    ON DELETE CASCADE,

  user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  provider VARCHAR(30) NOT NULL DEFAULT 'MANUAL',

  amount INTEGER NOT NULL
    CHECK (amount >= 0),

  currency VARCHAR(3) NOT NULL DEFAULT 'MXN',

  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  access_from TIMESTAMPTZ NOT NULL,

  access_until TIMESTAMPTZ NOT NULL,

  reference VARCHAR(150),

  notes TEXT,

  registered_by_user_id INTEGER
    REFERENCES users(id)
    ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT subscription_payments_valid_period
    CHECK (access_until > access_from)
);

CREATE INDEX idx_subscription_payments_subscription_id
  ON subscription_payments(subscription_id);

CREATE INDEX idx_subscription_payments_user_id
  ON subscription_payments(user_id);

CREATE INDEX idx_subscription_payments_registered_by
  ON subscription_payments(registered_by_user_id);

CREATE INDEX idx_subscription_payments_paid_at
  ON subscription_payments(paid_at DESC);

COMMIT;