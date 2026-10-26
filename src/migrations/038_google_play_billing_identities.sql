BEGIN;

-- Opaque account identifiers are permanent, including for soft-deleted users.
-- gen_random_uuid is built into supported PostgreSQL versions (13+).
CREATE TABLE google_play_billing_identities (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  obfuscated_account_id TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (obfuscated_account_id ~ '^[0-9a-f]{32}$')
);

CREATE FUNCTION protect_google_play_billing_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Google Play billing identities are immutable and cannot be reused';
END;
$$;

CREATE TRIGGER google_play_billing_identity_immutable
BEFORE UPDATE OR DELETE ON google_play_billing_identities
FOR EACH ROW EXECUTE FUNCTION protect_google_play_billing_identity();
CREATE TRIGGER google_play_billing_identity_no_truncate
BEFORE TRUNCATE ON google_play_billing_identities
FOR EACH STATEMENT EXECUTE FUNCTION protect_google_play_billing_identity();

CREATE FUNCTION create_google_play_billing_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO google_play_billing_identities(user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_google_play_billing_identity
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION create_google_play_billing_identity();

-- Populate only the new table. Existing users/subscriptions/tokens are untouched.
INSERT INTO google_play_billing_identities(user_id) SELECT id FROM users;

COMMIT;
