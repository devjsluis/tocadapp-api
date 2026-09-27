BEGIN;

-- Precio definitivo del plan mensual: $79 MXN.
UPDATE plans
SET
  name = 'TocadApp mensual',
  description = 'Acceso completo a TocadApp mediante suscripción mensual.',
  price_amount = 7900,
  currency = 'MXN',
  billing_interval = 'MONTH',
  interval_count = 1,
  active = TRUE
WHERE code = 'TOCADAPP_MONTHLY';

-- Plan anual: $699 MXN.
INSERT INTO plans (
  code,
  name,
  description,
  price_amount,
  currency,
  billing_interval,
  interval_count,
  active
)
VALUES (
  'TOCADAPP_YEARLY',
  'TocadApp anual',
  'Acceso completo a TocadApp mediante suscripción anual.',
  69900,
  'MXN',
  'YEAR',
  1,
  TRUE
)
ON CONFLICT (code)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_amount = EXCLUDED.price_amount,
  currency = EXCLUDED.currency,
  billing_interval = EXCLUDED.billing_interval,
  interval_count = EXCLUDED.interval_count,
  active = EXCLUDED.active;

COMMIT;
