-- Additive prepared schedule storage. Never run the destructive schema initializer remotely.
CREATE TABLE IF NOT EXISTS schedule_read_manifest (
  id TEXT PRIMARY KEY CHECK(id='schedule'),
  schema_version INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  input_revision INTEGER,
  part_count INTEGER NOT NULL CHECK(part_count > 0),
  digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_read_parts (
  part INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key,value) VALUES ('scheduleViewRevision','0');
CREATE TRIGGER IF NOT EXISTS schedule_read_volunteers_insert AFTER INSERT ON volunteers
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_volunteers_update AFTER UPDATE ON volunteers
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_volunteers_delete AFTER DELETE ON volunteers
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_sessions_insert AFTER INSERT ON sessions
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_sessions_update AFTER UPDATE ON sessions
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_sessions_delete AFTER DELETE ON sessions
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_scheduling_runs_insert AFTER INSERT ON scheduling_runs
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_scheduling_runs_update AFTER UPDATE ON scheduling_runs
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_scheduling_runs_delete AFTER DELETE ON scheduling_runs
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_assignments_insert AFTER INSERT ON assignments
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_assignments_update AFTER UPDATE ON assignments
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_assignments_delete AFTER DELETE ON assignments
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_backups_insert AFTER INSERT ON backups
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_backups_update AFTER UPDATE ON backups
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS schedule_read_backups_delete AFTER DELETE ON backups
BEGIN
  INSERT INTO meta(key,value) VALUES ('scheduleViewRevision','1')
  ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
END;
