-- Synthetic public fixture. This is not the operator's private seed.sql.
INSERT INTO centers (id, name) VALUES
  ('center-1', 'North Center'), ('center-2', 'South Center'), ('center-3', 'West Center');

INSERT INTO volunteers (id, name, email, lifecycle_status, interview_status, readiness_rank) VALUES
  ('volunteer-1', 'Alex Example', 'alex@example.test', 'active', 'complete', 1),
  ('volunteer-2', 'Blair Example', 'blair@example.test', 'active', 'complete', 2),
  ('volunteer-3', 'Casey Example', 'casey@example.test', 'newly-joined', 'complete', 3),
  ('volunteer-4', 'Devon Example', 'devon@example.test', 'inactive', 'complete', 1),
  ('volunteer-5', 'Ellis Example', 'ellis@example.test', 'active', 'incomplete', 1);

INSERT INTO users (id, email, roles, volunteer_id, center_ids, active) VALUES
  ('user-volunteer', 'alex@example.test', '["volunteer"]', 'volunteer-1', '[]', 1),
  ('user-admin', 'admin@example.test', '["administrator"]', NULL, '[]', 1),
  ('user-contact', 'contact@example.test', '["center-contact"]', NULL, '["center-1"]', 1),
  ('user-multi', 'multi@example.test', '["volunteer","center-contact","administrator"]', 'volunteer-2', '["center-1","center-2"]', 1),
  ('user-inactive', 'inactive@example.test', '["administrator"]', NULL, '[]', 0);

INSERT INTO recurring_availability (id, volunteer_id, weekday, start_time, end_time, time_zone, source) VALUES
  ('recurring-1', 'volunteer-1', 1, '09:00', '17:00', 'America/New_York', 'fixture'),
  ('recurring-2', 'volunteer-2', 1, '09:00', '17:00', 'America/New_York', 'fixture'),
  ('recurring-3', 'volunteer-3', 1, '09:00', '17:00', 'America/New_York', 'fixture');

INSERT INTO sessions (id, kind, center_id, title, date, start_time, end_time, time_zone, required_staff_count, status) VALUES
  ('session-1', 'center', 'center-1', 'North mindfulness', '2026-10-05', '10:00', '11:00', 'America/New_York', 1, 'locked');

INSERT INTO meta (key, value) VALUES ('dataRevision', '0'), ('schedulingInputRevision', '0');
