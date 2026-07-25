BEGIN;

-- Catálogo de planes disponibles.
-- El precio representa centavos: 4900 = $49.00 MXN.
CREATE TABLE IF NOT EXISTS plans (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,

  price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'MXN',

  billing_interval VARCHAR(20) NOT NULL
    CHECK (billing_interval IN ('MONTH', 'YEAR')),

  interval_count SMALLINT NOT NULL DEFAULT 1
    CHECK (interval_count > 0),

  active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Plan inicial de TocadApp.
INSERT INTO plans (
  code,
  name,
  description,
  price_amount,
  currency,
  billing_interval,
  interval_count
)
VALUES (
  'TOCADAPP_MONTHLY',
  'TocadApp mensual',
  'Acceso completo a TocadApp mediante suscripción mensual.',
  4900,
  'MXN',
  'MONTH',
  1
)
ON CONFLICT (code) DO NOTHING;

-- Historial de suscripciones.
-- No se elimina una suscripción cuando termina.
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,

  user_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,

  plan_id BIGINT NOT NULL
    REFERENCES plans(id) ON DELETE RESTRICT,

  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (
      status IN (
        'PENDING',
        'ACTIVE',
        'PAST_DUE',
        'CANCELED',
        'EXPIRED'
      )
    ),

  -- MANUAL servirá durante el desarrollo.
  -- Después podrá ser STRIPE, MERCADO_PAGO, APPLE o GOOGLE.
  provider VARCHAR(30) NOT NULL DEFAULT 'MANUAL',

  provider_customer_id VARCHAR(255),
  provider_subscription_id VARCHAR(255),

  -- Copia histórica del precio contratado.
  -- No depende de que el precio del plan cambie después.
  price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'MXN',

  started_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,

  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (
    current_period_end IS NULL
    OR current_period_start IS NULL
    OR current_period_end > current_period_start
  ),

  CHECK (
    ended_at IS NULL
    OR started_at IS NULL
    OR ended_at >= started_at
  )
);

-- Un usuario solo puede tener una suscripción abierta a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_open_user
  ON subscriptions (user_id)
  WHERE status IN ('PENDING', 'ACTIVE', 'PAST_DUE');

-- Evita duplicar suscripciones recibidas desde un proveedor.
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_provider_subscription
  ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_subscriptions_user_id
  ON subscriptions (user_id);

CREATE INDEX IF NOT EXISTS ix_subscriptions_status
  ON subscriptions (status);

CREATE INDEX IF NOT EXISTS ix_subscriptions_current_period_end
  ON subscriptions (current_period_end);

-- Actualiza updated_at automáticamente.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plans_updated_at ON plans;

CREATE TRIGGER trg_plans_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;

CREATE TRIGGER trg_subscriptions_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
