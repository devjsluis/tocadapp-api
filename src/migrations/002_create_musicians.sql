CREATE TABLE IF NOT EXISTS musicians (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(255) NOT NULL,
  instrument VARCHAR(255),
  phone     VARCHAR(50),
  notes     TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
