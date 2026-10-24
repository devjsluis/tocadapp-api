BEGIN;

-- Backfill ownership before enabling the linked-token checks.
-- Keep historical tokens: EXPIRED alone does not mean irreversibly replaced.
CREATE TABLE google_play_purchase_tokens (
  purchase_token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  replaced_by_token TEXT,
  CHECK (replaced_by_token IS NULL OR replaced_by_token <> purchase_token)
);

INSERT INTO google_play_purchase_tokens (purchase_token, user_id)
SELECT provider_subscription_id, user_id
FROM subscriptions
WHERE provider = 'GOOGLE_PLAY' AND provider_subscription_id IS NOT NULL;

COMMIT;
