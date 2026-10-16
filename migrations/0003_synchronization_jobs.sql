CREATE TABLE IF NOT EXISTS synchronization_jobs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('system', 'administrator')),
  operation TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  started_check_id TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('fetch','parse','prepare','commit','done','failed')),
  version INTEGER NOT NULL DEFAULT 0,
  prepare_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  diagnostic TEXT,
  UNIQUE(actor_id, operation, intent_key)
);
CREATE TABLE IF NOT EXISTS synchronization_artifacts (
  job_id TEXT NOT NULL REFERENCES synchronization_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  part INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(job_id, kind, part)
);
CREATE TABLE IF NOT EXISTS synchronization_outbox (
  job_id TEXT PRIMARY KEY REFERENCES synchronization_jobs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  phase TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_synchronization_jobs_created ON synchronization_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_synchronization_jobs_updated ON synchronization_jobs(updated_at);
