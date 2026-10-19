-- Additive migration for encrypted personal calendar links. Existing volunteer data is preserved.
CREATE TABLE IF NOT EXISTS calendar_subscriptions (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL UNIQUE REFERENCES volunteers (id),
  token_hash TEXT UNIQUE,
  token_ciphertext TEXT,
  token_iv TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (id = volunteer_id),
  CHECK ((enabled = 1 AND token_hash IS NOT NULL AND token_ciphertext IS NOT NULL AND token_iv IS NOT NULL)
    OR (enabled = 0 AND token_hash IS NULL AND token_ciphertext IS NULL AND token_iv IS NULL))
);
