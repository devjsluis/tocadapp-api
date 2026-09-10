CREATE TABLE IF NOT EXISTS push_notification_receipts (
  ticket_id TEXT PRIMARY KEY,
  push_token_id BIGINT NOT NULL
    REFERENCES user_push_tokens(id)
    ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_notification_receipts_created_at
ON push_notification_receipts(created_at);
