-- Migración 003: Bandas + aislamiento por usuario
-- Ejecutar en orden, manualmente en la DB

-- 1. Tabla de bandas (crear ANTES de alterar gigs)
CREATE TABLE IF NOT EXISTS bands (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  invite_code VARCHAR(10) UNIQUE NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 2. Membresía en bandas
CREATE TABLE IF NOT EXISTS band_members (
  id        SERIAL PRIMARY KEY,
  band_id   INTEGER REFERENCES bands(id) ON DELETE CASCADE NOT NULL,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role      VARCHAR(50) NOT NULL DEFAULT 'musician', -- 'leader' | 'musician'
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(band_id, user_id)
);

-- 3. Agregar user_id y band_id a gigs (nullable para no romper datos existentes)
ALTER TABLE gigs
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS band_id INTEGER REFERENCES bands(id) ON DELETE SET NULL;

-- 4. Agregar user_id a musicians
ALTER TABLE musicians
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
