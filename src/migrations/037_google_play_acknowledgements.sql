BEGIN;

-- Apply after 035 and 036. This queue never grants entitlements.
CREATE TABLE google_play_acknowledgements (
  purchase_token TEXT PRIMARY KEY REFERENCES google_play_purchase_tokens(purchase_token) ON DELETE RESTRICT,
  -- Expected-owner snapshot, validated against the authoritative token row.
  -- Its user FK already prevents deletion. A second user FK here would acquire
  -- user locks after token locks during discovery, inverting the writer order.
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RETRY', 'DEFERRED', 'COMPLETED', 'SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  reason TEXT,
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE INDEX ix_google_play_acknowledgements_pending
  ON google_play_acknowledgements (last_attempt_at, purchase_token)
  WHERE status IN ('PENDING', 'RETRY', 'DEFERRED');

-- Historical candidates, including locally expired rows. Only Google decides
-- whether acknowledgement is still needed; no subscription is changed here.
INSERT INTO google_play_acknowledgements (purchase_token, user_id)
SELECT t.purchase_token, t.user_id
FROM google_play_purchase_tokens t
WHERE EXISTS (
  SELECT 1 FROM subscriptions s
  WHERE s.provider = 'GOOGLE_PLAY'
    AND s.provider_subscription_id = t.purchase_token AND s.user_id = t.user_id
);

COMMIT;
