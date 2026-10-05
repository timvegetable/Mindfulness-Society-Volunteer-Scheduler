-- Additive production migration; schema.sql is destructive and local-only.
CREATE TABLE idempotency (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE INDEX idx_idempotency_created_at
  ON idempotency (created_at);
