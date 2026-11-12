BEGIN;

-- Business accounting access is deliberately separate from musician accounts.
CREATE TABLE accounting_accounts (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
  display_name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE accounting_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounting_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX accounting_sessions_account ON accounting_sessions(account_id);
CREATE INDEX accounting_sessions_expiry ON accounting_sessions(expires_at);

CREATE TABLE accounting_documents (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('CFDI','BANK','APPLE','GOOGLE_PLAY','STRIPE_FEES','OTHER')),
  filename VARCHAR(180) NOT NULL,
  content_type VARCHAR(64) NOT NULL,
  content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 10485760),
  sha256 CHAR(64) NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(month, sha256)
);
CREATE INDEX accounting_documents_month ON accounting_documents(month);

CREATE TABLE accounting_settlements (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('APPLE','GOOGLE_PLAY')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor BIGINT NOT NULL CHECK (gross_minor >= 0),
  fees_minor BIGINT NOT NULL CHECK (fees_minor >= 0),
  refunds_minor BIGINT NOT NULL CHECK (refunds_minor >= 0),
  withheld_minor BIGINT NOT NULL CHECK (withheld_minor >= 0),
  net_minor BIGINT NOT NULL,
  deposits_minor BIGINT NOT NULL CHECK (deposits_minor >= 0),
  document_id INTEGER NOT NULL REFERENCES accounting_documents(id) ON DELETE RESTRICT,
  notes VARCHAR(1000) NOT NULL DEFAULT '',
  confirmed_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (net_minor = gross_minor - fees_minor - refunds_minor - withheld_minor),
  UNIQUE(month, provider, currency)
);
CREATE TABLE accounting_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_kind VARCHAR(12) NOT NULL CHECK (actor_kind IN ('ADMIN','ACCOUNTANT','ANONYMOUS')),
  actor_id INTEGER,
  action VARCHAR(40) NOT NULL,
  month DATE,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX accounting_audit_created ON accounting_audit_log(created_at DESC);
COMMIT;
