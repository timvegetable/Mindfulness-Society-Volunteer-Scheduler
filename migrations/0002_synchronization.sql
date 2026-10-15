-- Additive migration. Preserves the existing roster and import history.
CREATE TABLE IF NOT EXISTS synchronizations (
  id TEXT PRIMARY KEY CHECK (id = 'whenIsGood'),
  generation INTEGER NOT NULL,
  check_id TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  effective_change_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('never','changed','unchanged','failed')),
  diagnostic TEXT,
  participant_count INTEGER NOT NULL,
  matched_count INTEGER NOT NULL,
  pending_count INTEGER NOT NULL,
  participants TEXT NOT NULL,
  pending TEXT NOT NULL
);
