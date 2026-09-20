-- Zona horaria preferida del usuario.
-- Se usa como valor por defecto al crear nuevas tocadas.
ALTER TABLE users
ADD COLUMN IF NOT EXISTS timezone VARCHAR(100)
NOT NULL
DEFAULT 'America/Mexico_City';

-- La hora de una tocada pertenece a la zona donde fue programada.
-- Las tocadas existentes se consideran de America/Mexico_City,
-- que era la zona global usada por TocadApp hasta esta migración.
ALTER TABLE gigs
ADD COLUMN IF NOT EXISTS timezone VARCHAR(100)
NOT NULL
DEFAULT 'America/Mexico_City';

-- Evita strings vacíos.
ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_timezone_not_empty;

ALTER TABLE users
ADD CONSTRAINT users_timezone_not_empty
CHECK (BTRIM(timezone) <> '');

ALTER TABLE gigs
DROP CONSTRAINT IF EXISTS gigs_timezone_not_empty;

ALTER TABLE gigs
ADD CONSTRAINT gigs_timezone_not_empty
CHECK (BTRIM(timezone) <> '');
