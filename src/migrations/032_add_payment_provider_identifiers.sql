BEGIN;

ALTER TABLE subscription_payments
  ADD COLUMN provider_payment_id VARCHAR(255),
  ADD COLUMN provider_event_id VARCHAR(255);

CREATE UNIQUE INDEX ux_subscription_payments_provider_payment
  ON subscription_payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX ux_subscription_payments_provider_event
  ON subscription_payments (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

COMMIT;
