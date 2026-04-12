CREATE TABLE IF NOT EXISTS gig_attendance (
  gig_id  INTEGER REFERENCES gigs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  attending BOOLEAN NOT NULL,
  PRIMARY KEY (gig_id, user_id)
);
