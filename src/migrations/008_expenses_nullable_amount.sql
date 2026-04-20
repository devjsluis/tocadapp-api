-- Monto de tocada ahora es opcional
ALTER TABLE gigs ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE gigs ALTER COLUMN amount SET DEFAULT NULL;

-- Tabla de gastos del músico
CREATE TABLE IF NOT EXISTS expenses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL,
  category    VARCHAR(100) NOT NULL,
  description TEXT,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMP DEFAULT NOW()
);
