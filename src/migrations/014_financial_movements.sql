CREATE TABLE IF NOT EXISTS financial_movements (
  id SERIAL PRIMARY KEY,

  user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  gig_id INTEGER
    REFERENCES gigs(id)
    ON DELETE SET NULL,

  type VARCHAR(20) NOT NULL
    CHECK (type IN ('INCOME', 'EXPENSE')),

  amount NUMERIC(10, 2) NOT NULL
    CHECK (amount > 0),

  category VARCHAR(100) NOT NULL,

  description TEXT,

  date DATE NOT NULL DEFAULT CURRENT_DATE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_movements_user_id
  ON financial_movements(user_id);

CREATE INDEX IF NOT EXISTS idx_financial_movements_gig_id
  ON financial_movements(gig_id);

CREATE INDEX IF NOT EXISTS idx_financial_movements_user_date
  ON financial_movements(user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_financial_movements_user_type
  ON financial_movements(user_id, type);

INSERT INTO financial_movements (
  user_id,
  gig_id,
  type,
  amount,
  category,
  description,
  date,
  created_at
)
SELECT
  user_id,
  NULL,
  'EXPENSE',
  amount,
  category,
  description,
  date,
  created_at
FROM expenses e
WHERE e.user_id IS NOT NULL
  AND e.amount IS NOT NULL
  AND e.amount > 0
  AND NOT EXISTS (
    SELECT 1
    FROM financial_movements fm
    WHERE fm.user_id = e.user_id
      AND fm.type = 'EXPENSE'
      AND fm.amount = e.amount
      AND fm.category = e.category
      AND fm.description IS NOT DISTINCT FROM e.description
      AND fm.date = e.date
      AND fm.created_at = e.created_at
  );
