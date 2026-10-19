import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readSchedule } from '../../src/worker/scheduleRead/reader';
import { makeReadTickets } from '../../src/worker/scheduleRead/tickets';
import { applySql, createTestDatabase } from '../helpers/database';

const secret = 'ab'.repeat(32);
const envConfig = { SCHEDULE_READ_MODE: 'enabled' as const, SCHEDULE_READ_KEY: secret,
  SCHEDULE_READ_AUDIENCE: 'synthetic', OAUTH_CLIENT_ID: 'client' };
const workspaces: string[] = [];

function runCleanupCli(args: string[]) {
  const result = spawnSync(process.execPath, [resolve('scripts/prepare-test-data-cleanup.mjs'), ...args], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const fixtureSql = `
INSERT INTO centers (id,name,active) VALUES ('cleanup-center','Synthetic center',1);
INSERT INTO volunteers (id,name,email,lifecycle_status,interview_status,readiness_rank,source)
  VALUES ('cleanup-volunteer','Synthetic test volunteer','cleanup-volunteer@example.invalid','newly-joined','complete',NULL,'synthetic-test');
INSERT INTO volunteers (id,name,email,lifecycle_status,interview_status,readiness_rank,source)
  VALUES ('retained-volunteer','Retained volunteer','retained@example.invalid','active','complete',1,'synthetic-test');
INSERT INTO users (id,email,roles,volunteer_id,center_ids,active)
  VALUES ('cleanup-user','cleanup-volunteer@example.invalid','["volunteer"]','cleanup-volunteer','[]',1);
INSERT INTO users (id,email,roles,volunteer_id,center_ids,active)
  VALUES ('cleanup-admin','cleanup-admin@example.invalid','["administrator"]',NULL,'[]',1);
INSERT INTO candidate_schedules
  (id,center_id,weekday,start_time,end_time,time_zone,requested_staff_count,status,created_by,created_at,updated_at)
  VALUES
  ('cleanup-candidate-confirmed','cleanup-center',1,'10:00','11:00','America/New_York',1,'confirmed','cleanup-admin','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z'),
  ('cleanup-candidate-one','cleanup-center',2,'10:00','11:00','America/New_York',1,'candidate','cleanup-admin','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z'),
  ('cleanup-candidate-two','cleanup-center',3,'10:00','11:00','America/New_York',1,'candidate','cleanup-admin','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z');
INSERT INTO sessions
  (id,kind,center_id,title,date,start_time,end_time,time_zone,required_staff_count,status,source_candidate_id,created_at,updated_at)
  VALUES ('cleanup-session','center','cleanup-center','Synthetic center','2026-10-05','10:00','11:00','America/New_York',1,'locked','cleanup-candidate-confirmed','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z');
INSERT INTO meta (key,value) VALUES ('dataRevision','8'),('schedulingInputRevision','5');
UPDATE meta SET value='41' WHERE key='scheduleViewRevision';
`;

const readTargets = [
  { results: [
    { id: 'cleanup-candidate-confirmed', status: 'confirmed' },
    { id: 'cleanup-candidate-one', status: 'candidate' },
    { id: 'cleanup-candidate-two', status: 'candidate' },
  ], success: true, meta: { changed_db: false, rows_written: 0 } },
  { results: [ { id: 'cleanup-session', status: 'locked', source_candidate_id: 'cleanup-candidate-confirmed' } ], success: true, meta: { changed_db: false, rows_written: 0 } },
  { results: [ { id: 'cleanup-volunteer', lifecycle_status: 'newly-joined' } ], success: true, meta: { changed_db: false, rows_written: 0 } },
  { results: [ { id: 'cleanup-user', active: 1 } ], success: true, meta: { changed_db: false, rows_written: 0 } },
  { results: [
    { key: 'dataRevision', value: '8' },
    { key: 'schedulingInputRevision', value: '5' },
    { key: 'scheduleViewRevision', value: '41' },
  ], success: true, meta: { changed_db: false, rows_written: 0 } },
  { results: [ { active_sync_jobs: 0 } ], success: true, meta: { changed_db: false, rows_written: 0 } },
];

it('prepares an offline cleanup batch that preserves the audit rows and refreshes the public schedule view', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-cleanup-test-'));
  workspaces.push(workspace);
  const schema = await readFile(resolve('schema.sql'), 'utf8');
  const backupPath = join(workspace, 'synthetic.sql');
  const targetsPath = join(workspace, 'targets.json');
  const configPath = join(workspace, 'synthetic-config.json');
  const seedPath = join(workspace, 'synthetic-seed.sql');
  const outputPrefix = join(workspace, 'cleanup-plan');
  const seedOutputPrefix = join(workspace, 'seed-cleanup-plan');
  const seedBeforePath = join(workspace, 'seed-before.sql');
  const seedCleanedPath = join(workspace, 'seed-cleaned.sql');
  const seedSql = fixtureSql.replace("('dataRevision','8'),('schedulingInputRevision','5')", "('dataRevision','0'),('schedulingInputRevision','0')")
    .replace("value='41'", "value='99'");
  await writeFile(backupPath, `${schema}\n${fixtureSql}`, { mode: 0o600 });
  await writeFile(targetsPath, JSON.stringify(readTargets), { mode: 0o600 });
  await writeFile(seedPath, seedSql, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: '11111111-1111-4111-8111-111111111111' }] }), { mode: 0o600 });

  const result = runCleanupCli(['--backup', backupPath, '--targets', targetsPath,
    '--out', outputPrefix, '--config', configPath, '--seed', seedPath, '--seed-out', seedOutputPrefix,
    '--seed-before-out', seedBeforePath, '--seed-cleaned-out', seedCleanedPath]);
  expect(result.status).toBe(0);
  const summary = JSON.parse(result.stdout.trim());
  expect(summary).toMatchObject({ prepared: true, offlineVerified: true, productionContacted: false,
    sourceModified: false, operations: { candidatesCancelled: 3, sessionsCancelled: 1, usersDeactivated: 1, volunteersRemoved: 1 },
    seedPlan: { sourceDataRevision: 0, sourceSchedulingInputRevision: 0, sourceScheduleViewRevision: 99 } });
  expect(await readFile(seedPath, 'utf8')).toBe(seedSql);
  expect(await readFile(seedBeforePath, 'utf8')).toBe(seedSql);
  const cleanedSeedSql = await readFile(seedCleanedPath, 'utf8');
  expect(cleanedSeedSql.startsWith(seedSql)).toBe(true);
  expect(cleanedSeedSql.length).toBeGreaterThan(seedSql.length);

  const manifest = JSON.parse(await readFile(`${outputPrefix}.manifest.json`, 'utf8'));
  const plan = JSON.parse(await readFile(`${outputPrefix}.request.json`, 'utf8')) as { batch: { sql: string; params: unknown[] }[] };
  expect(manifest).toMatchObject({ sourceDataRevision: 8, sourceSchedulingInputRevision: 5,
    sourceScheduleViewRevision: 41, targetDataRevision: 9, targetSchedulingInputRevision: 6,
    targetScheduleViewRevision: 43, operations: { candidatesCancelled: 3, sessionsCancelled: 1,
      usersDeactivated: 1, volunteersRemoved: 1 }, productionContacted: false });
  expect(plan.batch.length).toBe(manifest.statements);
  const seedManifest = JSON.parse(await readFile(`${seedOutputPrefix}.manifest.json`, 'utf8'));
  const seedPlan = JSON.parse(await readFile(`${seedOutputPrefix}.request.json`, 'utf8')) as { batch: { sql: string; params: unknown[] }[] };
  expect(seedManifest).toMatchObject({ kind: 'private-seed-cleanup', databaseId: null, sourceDataRevision: 0,
    sourceSchedulingInputRevision: 0, sourceScheduleViewRevision: 99, targetDataRevision: 1,
    targetSchedulingInputRevision: 1, targetScheduleViewRevision: 101, sourceModified: false,
    seedReplacementStrategy: expect.stringContaining('Original seed bytes'),
    seedSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), seedCandidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(seedPlan.batch.length).toBe(seedManifest.statements);

  const seedLocal = await createTestDatabase({ seed: false, scheduleReads: true });
  try {
    await applySql(seedLocal.db, cleanedSeedSql);
    expect((await seedLocal.db.prepare("SELECT COUNT(*) AS count FROM candidate_schedules WHERE status='cancelled'").first<{ count: number }>())?.count).toBe(3);
    expect((await seedLocal.db.prepare("SELECT status FROM sessions WHERE id='cleanup-session'").first<{ status: string }>())?.status).toBe('cancelled');
    expect(await seedLocal.db.prepare("SELECT active,volunteer_id FROM users WHERE id='cleanup-user'").first()).toMatchObject({ active: 0, volunteer_id: null });
    expect((await seedLocal.db.prepare("SELECT COUNT(*) AS count FROM volunteers WHERE id='cleanup-volunteer'").first<{ count: number }>())?.count).toBe(0);
    expect((await seedLocal.db.prepare('SELECT key,value FROM meta WHERE key IN (\'dataRevision\',\'schedulingInputRevision\',\'scheduleViewRevision\') ORDER BY key').all()).results).toEqual([
      { key: 'dataRevision', value: '1' },
      { key: 'scheduleViewRevision', value: '101' },
      { key: 'schedulingInputRevision', value: '1' },
    ]);
  } finally {
    await seedLocal.dispose();
  }

  const local = await createTestDatabase({ seed: false, scheduleReads: true });
  try {
    await applySql(local.db, fixtureSql);
    const results = await local.db.batch(plan.batch.map(item => local.db.prepare(item.sql).bind(...item.params)));
    expect(results).toHaveLength(plan.batch.length);
    expect(results.every(result => result.success)).toBe(true);
    expect((await local.db.prepare("SELECT COUNT(*) AS count FROM candidate_schedules WHERE status='cancelled'").first<{ count: number }>())?.count).toBe(3);
    expect((await local.db.prepare("SELECT status FROM sessions WHERE id='cleanup-session'").first<{ status: string }>())?.status).toBe('cancelled');
    expect(await local.db.prepare("SELECT active,volunteer_id FROM users WHERE id='cleanup-user'").first()).toMatchObject({ active: 0, volunteer_id: null });
    expect((await local.db.prepare("SELECT COUNT(*) AS count FROM volunteers WHERE id='cleanup-volunteer'").first<{ count: number }>())?.count).toBe(0);
    expect((await local.db.prepare('SELECT key,value FROM meta WHERE key IN (\'dataRevision\',\'schedulingInputRevision\',\'scheduleViewRevision\') ORDER BY key').all()).results).toEqual([
      { key: 'dataRevision', value: '9' },
      { key: 'scheduleViewRevision', value: '43' },
      { key: 'schedulingInputRevision', value: '6' },
    ]);

    const tickets = makeReadTickets({ secret, audience: 'synthetic:client' });
    const readAt = Date.parse('2026-10-04T12:00:00.000Z');
    const { credential } = await tickets.issue({ id: 'cleanup-admin', email: 'cleanup-admin@example.invalid' }, Math.floor(readAt / 1000) + 3600, readAt);
    const response = await readSchedule(new Request('https://app.invalid/api/schedule', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'admin.schedule.read', credential, payload: {} }) }), { ...envConfig, DB: local.db }, readAt);
    const body = await response.json() as { ok: boolean; data?: { sessions: { id: string; status: string }[]; volunteers: { id: string }[]; dataRevision: number; schedulingInputRevision: number } };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, data: { dataRevision: 9, schedulingInputRevision: 6 } });
    expect(body.data?.sessions).toContainEqual(expect.objectContaining({ id: 'cleanup-session', status: 'cancelled' }));
    expect(body.data?.volunteers).not.toContainEqual(expect.objectContaining({ id: 'cleanup-volunteer' }));
    expect(body.data?.volunteers).toContainEqual(expect.objectContaining({ id: 'retained-volunteer' }));
  } finally {
    await local.dispose();
  }
});

it('rejects a stale cleanup plan before changing any target record', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-cleanup-stale-test-'));
  workspaces.push(workspace);
  const schema = await readFile(resolve('schema.sql'), 'utf8');
  const backupPath = join(workspace, 'synthetic.sql');
  const targetsPath = join(workspace, 'targets.json');
  const configPath = join(workspace, 'synthetic-config.json');
  const outputPrefix = join(workspace, 'cleanup-plan');
  await writeFile(backupPath, `${schema}\n${fixtureSql}`, { mode: 0o600 });
  await writeFile(targetsPath, JSON.stringify(readTargets), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: '11111111-1111-4111-8111-111111111111' }] }), { mode: 0o600 });
  expect(runCleanupCli(['--backup', backupPath, '--targets', targetsPath, '--out', outputPrefix, '--config', configPath]).status).toBe(0);
  const plan = JSON.parse(await readFile(`${outputPrefix}.request.json`, 'utf8')) as { batch: { sql: string; params: unknown[] }[] };

  const local = await createTestDatabase({ seed: false, scheduleReads: true });
  try {
    await applySql(local.db, fixtureSql);
    await local.db.prepare("UPDATE meta SET value='9' WHERE key='dataRevision'").run();
    await expect(local.db.batch(plan.batch.map(item => local.db.prepare(item.sql).bind(...item.params)))).rejects.toThrow();
    expect((await local.db.prepare('SELECT id,status FROM candidate_schedules ORDER BY id').all()).results).toMatchObject([
      { id: 'cleanup-candidate-confirmed', status: 'confirmed' },
      { id: 'cleanup-candidate-one', status: 'candidate' },
      { id: 'cleanup-candidate-two', status: 'candidate' },
    ]);
    expect(await local.db.prepare("SELECT active,volunteer_id FROM users WHERE id='cleanup-user'").first()).toMatchObject({ active: 1, volunteer_id: 'cleanup-volunteer' });
    expect((await local.db.prepare("SELECT COUNT(*) AS count FROM volunteers WHERE id='cleanup-volunteer'").first<{ count: number }>())?.count).toBe(1);
    expect((await local.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key='cleanupFence'").first<{ count: number }>())?.count).toBe(0);
    expect((await local.db.prepare("SELECT COUNT(*) AS count FROM schedule_read_manifest WHERE id='schedule'").first<{ count: number }>())?.count).toBe(0);
  } finally {
    await local.dispose();
  }
});

it('preserves an existing private output instead of overwriting or deleting it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'operator-cleanup-existing-output-test-'));
  workspaces.push(workspace);
  const schema = await readFile(resolve('schema.sql'), 'utf8');
  const backupPath = join(workspace, 'synthetic.sql');
  const targetsPath = join(workspace, 'targets.json');
  const configPath = join(workspace, 'synthetic-config.json');
  const outputPrefix = join(workspace, 'cleanup-plan');
  const existingRequest = `${outputPrefix}.request.json`;
  await writeFile(backupPath, `${schema}\n${fixtureSql}`, { mode: 0o600 });
  await writeFile(targetsPath, JSON.stringify(readTargets), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: '11111111-1111-4111-8111-111111111111' }] }), { mode: 0o600 });
  await writeFile(existingRequest, 'preserve this private artifact', { mode: 0o600 });

  expect(runCleanupCli(['--backup', backupPath, '--targets', targetsPath,
    '--out', outputPrefix, '--config', configPath]).status).not.toBe(0);
  expect(await readFile(existingRequest, 'utf8')).toBe('preserve this private artifact');
  await expect(readFile(`${outputPrefix}.manifest.json`, 'utf8')).rejects.toThrow();
});
