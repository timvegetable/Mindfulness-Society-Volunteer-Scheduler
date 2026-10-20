-- Additive migration for the append-only volunteer change history. Existing data is preserved.
CREATE TABLE IF NOT EXISTS volunteer_changes (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  volunteer_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'updated', 'removed')),
  fields TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS volunteer_changes_occurred_at ON volunteer_changes (occurred_at DESC);
