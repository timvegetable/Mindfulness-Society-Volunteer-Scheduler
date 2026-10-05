-- Destructive local-development/test reset. Never execute against production.
DROP TABLE IF EXISTS idempotency;
DROP TABLE IF EXISTS imported_availability;
DROP TABLE IF EXISTS import_mappings;
DROP TABLE IF EXISTS imports;
DROP TABLE IF EXISTS backups;
DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS scheduling_runs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS candidate_schedules;
DROP TABLE IF EXISTS availability_exceptions;
DROP TABLE IF EXISTS recurring_availability;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS volunteers;
DROP TABLE IF EXISTS centers;
DROP TABLE IF EXISTS meta;

CREATE TABLE centers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE volunteers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  interview_status TEXT NOT NULL,
  readiness_rank INTEGER,
  source TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  roles TEXT NOT NULL,
  volunteer_id TEXT REFERENCES volunteers (id),
  center_ids TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE recurring_availability (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  source TEXT,
  updated_at TEXT
);

CREATE TABLE availability_exceptions (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unavailable', 'available')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT
);

CREATE TABLE candidate_schedules (
  id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers (id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 5),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  requested_staff_count INTEGER NOT NULL DEFAULT 1
    CHECK (requested_staff_count BETWEEN 0 AND 2),
  status TEXT NOT NULL
    CHECK (status IN ('candidate', 'confirmed', 'cancelled')),
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('center', 'univ100')),
  center_id TEXT REFERENCES centers (id),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  required_staff_count INTEGER NOT NULL DEFAULT 1
    CHECK (required_staff_count BETWEEN 0 AND 2),
  status TEXT NOT NULL
    CHECK (status IN ('locked', 'proposed', 'confirmed', 'cancelled')),
  source_candidate_id TEXT REFERENCES candidate_schedules (id),
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE scheduling_runs (
  id TEXT PRIMARY KEY,
  input_revision INTEGER NOT NULL,
  output_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'completed', 'failed')),
  started_at TEXT,
  completed_at TEXT,
  assignment_ids TEXT NOT NULL DEFAULT '[]',
  backup_ids TEXT NOT NULL DEFAULT '[]',
  shortfalls TEXT NOT NULL DEFAULT '[]',
  diagnostic TEXT
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  schedule_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assigned', 'cancelled')),
  created_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  schedule_revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'promoted', 'skipped'))
);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'completed', 'failed')),
  started_at TEXT,
  completed_at TEXT,
  actor_id TEXT,
  result_id TEXT,
  participant_count INTEGER,
  matched_count INTEGER,
  unmatched TEXT,
  staged_availability TEXT,
  diagnostic TEXT,
  promoted_at TEXT,
  promoted_by TEXT
);

CREATE TABLE import_mappings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_participant_id TEXT,
  source_email TEXT,
  source_name TEXT,
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  created_at TEXT,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE imported_availability (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL REFERENCES volunteers (id),
  source_participant_id TEXT,
  source TEXT,
  weekday INTEGER CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT,
  end_time TEXT,
  time_zone TEXT,
  imported_at TEXT,
  import_run_id TEXT
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE idempotency (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE INDEX idx_recurring_availability_volunteer
  ON recurring_availability (volunteer_id);

CREATE INDEX idx_availability_exceptions_volunteer
  ON availability_exceptions (volunteer_id, date);

CREATE INDEX idx_sessions_center_date
  ON sessions (center_id, date);

CREATE INDEX idx_assignments_session
  ON assignments (session_id);

CREATE INDEX idx_assignments_volunteer
  ON assignments (volunteer_id);

CREATE INDEX idx_backups_session
  ON backups (session_id);

CREATE INDEX idx_candidate_schedules_center
  ON candidate_schedules (center_id);

CREATE INDEX idx_imported_availability_volunteer
  ON imported_availability (volunteer_id);

CREATE INDEX idx_idempotency_created_at
  ON idempotency (created_at);
