-- Migración 004: Ganancias personales por tocada de banda
-- Permite que cada músico registre cuánto ganó en un gig de banda

CREATE TABLE IF NOT EXISTS gig_earnings (
  id      SERIAL PRIMARY KEY,
  gig_id  INTEGER REFERENCES gigs(id) ON DELETE CASCADE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  amount  NUMERIC(10, 2) NOT NULL,
  UNIQUE(gig_id, user_id)
);
