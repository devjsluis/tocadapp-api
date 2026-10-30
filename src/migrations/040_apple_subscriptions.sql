BEGIN;

CREATE TABLE apple_billing_identities (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  app_account_token UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep sandbox and production chains separate and preserve ownership forever.
CREATE TABLE apple_subscription_chains (
  environment TEXT NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
  original_transaction_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status INTEGER NOT NULL CHECK (status IN (1, 2, 3, 4, 5)),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, original_transaction_id)
);

COMMIT;
