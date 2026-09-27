BEGIN;

CREATE TABLE payment_provider_events (
  id BIGSERIAL PRIMARY KEY,

  provider VARCHAR(30) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,

  event_type VARCHAR(100) NOT NULL,

  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_payment_provider_events_provider_event
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX ix_payment_provider_events_processed_at
  ON payment_provider_events(processed_at DESC);

COMMIT;
