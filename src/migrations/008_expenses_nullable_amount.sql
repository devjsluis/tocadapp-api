-- Monto de tocada ahora es opcional
ALTER TABLE gigs ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE gigs ALTER COLUMN amount SET DEFAULT NULL;

-- collected_amount en gigs (por si migración 007 no corrió)
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS collected_amount NUMERIC DEFAULT NULL;

-- gig_earnings: amount ahora es opcional (tocadas gratis o solo cobro)
ALTER TABLE gig_earnings ALTER COLUMN amount DROP NOT NULL;
-- collected_amount en gig_earnings (por si migración 007 no corrió)
ALTER TABLE gig_earnings ADD COLUMN IF NOT EXISTS collected_amount NUMERIC DEFAULT NULL;

-- Adaptar tabla expenses existente a gastos del músico
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'Otro';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE expenses ALTER COLUMN description DROP NOT NULL;
