// Offline-only, revision-fenced cleanup preparation for the reviewed test records.
// This script never connects to production and never edits its inputs.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--backup', '--targets', '--out', '--config', '--seed', '--seed-out', '--seed-before-out', '--seed-cleaned-out'].includes(key)
      || !value || Object.hasOwn(options, key)) throw new Error('Invalid cleanup preparation arguments.');
    options[key] = value;
  }
  if (!options['--backup'] || !options['--targets'] || !options['--out'] || !options['--config']
    || Boolean(options['--seed']) !== Boolean(options['--seed-out'])
    || Boolean(options['--seed-before-out']) !== Boolean(options['--seed-cleaned-out'])
    || (options['--seed-before-out'] && !options['--seed'])) {
    throw new Error('Use --backup <private.sql> --targets <private.json> --out <private-prefix> --config <private-config.json> [--seed <private-seed.sql> --seed-out <private-prefix> [--seed-before-out <private-copy.sql> --seed-cleaned-out <private-candidate.sql>]].');
  }
  return options;
}

const sqlSafe = value => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const digest = value => createHash('sha256').update(value).digest('hex');
function placeholderCount(sql) {
  let quoted = false, count = 0;
  for (let index = 0; index < sql.length; index++) {
    if (sql[index] === "'") {
      if (quoted && sql[index + 1] === "'") { index++; continue; }
      quoted = !quoted;
    } else if (sql[index] === '?' && !quoted) count++;
  }
  return count;
}

function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && !value.includes('\0')) return `'${value.replaceAll("'", "''")}'`;
  throw new Error('The prepared cleanup batch contains a value that cannot be represented in the private seed candidate.');
}

function renderBatchAsSql(batch) {
  return batch.map(({ sql, params }) => {
    let quoted = false, parameter = 0, rendered = '';
    for (let index = 0; index < sql.length; index++) {
      const char = sql[index];
      if (char === "'") {
        rendered += char;
        if (quoted && sql[index + 1] === "'") { rendered += sql[++index]; continue; }
        quoted = !quoted;
      } else if (char === '?' && !quoted) {
        if (parameter >= params.length) throw new Error('The prepared cleanup batch has a missing SQL parameter.');
        rendered += sqlLiteral(params[parameter++]);
      } else rendered += char;
    }
    if (quoted || parameter !== params.length) throw new Error('The prepared cleanup batch has an invalid SQL parameter layout.');
    return `${rendered};\n`;
  }).join('');
}

async function writePrivateFile(path, bytes) {
  const directory = dirname(resolve(path));
  const metadata = await stat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new Error('Private seed outputs must be inside an owner-only directory.');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

function readTargets(raw) {
  let responses;
  try { responses = JSON.parse(raw); } catch { throw new Error('The private target file is not valid JSON.'); }
  if (!Array.isArray(responses) || responses.length !== 6) throw new Error('The private target file does not contain the six reviewed reads.');
  for (const response of responses) {
    if (!response || response.success !== true || !Array.isArray(response.results)
      || response.meta?.changed_db !== false || response.meta?.rows_written !== 0) {
      throw new Error('The target inventory was not a successful read-only result.');
    }
  }
  const candidates = responses[0].results;
  if (candidates.length !== 3 || candidates.some(row => typeof row.id !== 'string' || !row.id
    || !['candidate', 'confirmed'].includes(row.status))
    || new Set(candidates.map(row => row.id)).size !== 3
    || candidates.filter(row => row.status === 'candidate').length !== 2
    || candidates.filter(row => row.status === 'confirmed').length !== 1) {
    throw new Error('The proposal target set does not match the reviewed two-candidate/one-confirmed shape.');
  }
  const sessions = responses[1].results;
  if (sessions.length !== 1 || typeof sessions[0].id !== 'string' || sessions[0].status !== 'locked'
    || !candidates.some(row => row.id === sessions[0].source_candidate_id && row.status === 'confirmed')) {
    throw new Error('The linked session target does not match the reviewed locked-session shape.');
  }
  const volunteers = responses[2].results;
  if (volunteers.length !== 1 || typeof volunteers[0].id !== 'string' || volunteers[0].lifecycle_status !== 'newly-joined') {
    throw new Error('The volunteer target does not match the reviewed placeholder shape.');
  }
  const users = responses[3].results;
  if (users.length !== 1 || typeof users[0].id !== 'string' || users[0].active !== 1) {
    throw new Error('The linked user target does not match the reviewed active-account shape.');
  }
  const revisions = new Map(responses[4].results.map(row => [row.key, Number(row.value)]));
  if (responses[4].results.length !== 3 || ['dataRevision', 'schedulingInputRevision', 'scheduleViewRevision']
    .some(key => !Number.isSafeInteger(revisions.get(key)) || revisions.get(key) < 0)) {
    throw new Error('The target revision inventory is incomplete.');
  }
  if (responses[5].results.length !== 1 || responses[5].results[0].active_sync_jobs !== 0) {
    throw new Error('The target inventory does not confirm zero active synchronization jobs.');
  }
  return { candidates: candidates.map(row => ({ id: row.id, status: row.status })),
    session: { id: sessions[0].id, sourceCandidateId: sessions[0].source_candidate_id },
    volunteerId: volunteers[0].id, userId: users[0].id,
    revisions: Object.fromEntries(revisions) };
}

function dbFromSql(sql) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(sql);
  return db;
}

function metaRevision(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  if (!row || !/^\d+$/.test(String(row.value))) throw new Error(`Required stored revision ${key} is missing or invalid.`);
  const value = Number(row.value);
  if (!Number.isSafeInteger(value)) throw new Error('A stored revision is outside the supported range.');
  return value;
}

function validateBase(db, targets, revisionsMustMatch) {
  const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  if (integrity !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The offline source database failed integrity checks.');
  const requiredTriggers = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='trigger' AND name IN ('schedule_read_sessions_update','schedule_read_volunteers_delete')`).get()?.count;
  if (requiredTriggers !== 2) throw new Error('Prepared schedule invalidation triggers are missing.');
  const revisions = { dataRevision: metaRevision(db, 'dataRevision'),
    schedulingInputRevision: metaRevision(db, 'schedulingInputRevision'),
    scheduleViewRevision: metaRevision(db, 'scheduleViewRevision') };
  if (revisionsMustMatch && Object.keys(revisions).some(key => revisions[key] !== targets.revisions[key])) {
    throw new Error('The backup revisions differ from the reviewed target inventory.');
  }

  const expected = new Map(targets.candidates.map(row => [row.id, row.status]));
  const foundCandidates = db.prepare('SELECT id,status FROM candidate_schedules WHERE id IN (SELECT key FROM json_each(?))')
    .all(JSON.stringify(Object.fromEntries(expected)));
  if (foundCandidates.length !== expected.size || foundCandidates.some(row => expected.get(row.id) !== row.status)) {
    throw new Error('The backup proposal rows differ from the reviewed target set or statuses.');
  }
  const session = db.prepare('SELECT id,status,source_candidate_id FROM sessions WHERE id=?').get(targets.session.id);
  if (!session || session.status !== 'locked' || session.source_candidate_id !== targets.session.sourceCandidateId) {
    throw new Error('The backup linked session differs from the reviewed target.');
  }
  const volunteer = db.prepare('SELECT lifecycle_status FROM volunteers WHERE id=?').get(targets.volunteerId);
  if (!volunteer || volunteer.lifecycle_status !== 'newly-joined') throw new Error('The backup volunteer differs from the reviewed target.');
  const user = db.prepare('SELECT active,volunteer_id FROM users WHERE id=?').get(targets.userId);
  if (!user || user.active !== 1 || user.volunteer_id !== targets.volunteerId
    || db.prepare('SELECT COUNT(*) AS count FROM users WHERE volunteer_id=?').get(targets.volunteerId)?.count !== 1) {
    throw new Error('The backup user link differs from the reviewed target.');
  }
  for (const table of ['recurring_availability', 'availability_exceptions', 'assignments', 'backups', 'import_mappings', 'imported_availability']) {
    if (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE volunteer_id=?`).get(targets.volunteerId)?.count !== 0) {
      throw new Error('The backup volunteer still has a related record or audit reference.');
    }
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE session_id=? AND status='assigned'").get(targets.session.id)?.count !== 0
    || db.prepare("SELECT COUNT(*) AS count FROM backups WHERE session_id=? AND status='available'").get(targets.session.id)?.count !== 0) {
    throw new Error('The linked session has active assignments or available backups.');
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM synchronization_jobs WHERE phase NOT IN ('done','failed')").get()?.count !== 0) {
    throw new Error('The offline source has an active synchronization job.');
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key='cleanupFence'").get()?.count !== 0) {
    throw new Error('A previous cleanup fence is present.');
  }
  return revisions;
}

function revisionAdvance(key, expected) {
  return { sql: `INSERT INTO meta(key,value) VALUES (?,CASE WHEN
      COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key=?),0)=?
      THEN CAST(CAST(? AS INTEGER)+1 AS TEXT) ELSE NULL END)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, params: [key, key, expected, expected] };
}

function mutationStatements(targets, revisions, timestamp) {
  const statuses = JSON.stringify(Object.fromEntries(targets.candidates.map(row => [row.id, row.status])));
  const candidateIds = JSON.stringify(targets.candidates.map(row => row.id));
  const guard = `INSERT INTO meta(key,value) VALUES ('cleanupFence',CASE WHEN
      COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='dataRevision'),0)=?
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='schedulingInputRevision'),0)=?
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='scheduleViewRevision'),0)=?
      AND NOT EXISTS (SELECT 1 FROM meta WHERE key='cleanupFence')
      AND (SELECT COUNT(*) FROM candidate_schedules c JOIN json_each(?) t ON t.key=c.id AND t.value=c.status)=?
      AND (SELECT COUNT(*) FROM candidate_schedules WHERE id IN (SELECT value FROM json_each(?)))=?
      AND (SELECT COUNT(*) FROM sessions WHERE id=? AND status='locked' AND source_candidate_id=?)=1
      AND (SELECT COUNT(*) FROM volunteers WHERE id=? AND lifecycle_status='newly-joined')=1
      AND (SELECT COUNT(*) FROM users WHERE id=? AND active=1 AND volunteer_id=?)=1
      AND (SELECT COUNT(*) FROM users WHERE volunteer_id=?)=1
      AND (SELECT COUNT(*) FROM recurring_availability WHERE volunteer_id=?)=0
      AND (SELECT COUNT(*) FROM availability_exceptions WHERE volunteer_id=?)=0
      AND (SELECT COUNT(*) FROM assignments WHERE volunteer_id=?)=0
      AND (SELECT COUNT(*) FROM backups WHERE volunteer_id=?)=0
      AND (SELECT COUNT(*) FROM import_mappings WHERE volunteer_id=?)=0
      AND (SELECT COUNT(*) FROM imported_availability WHERE volunteer_id=?)=0
      AND (SELECT COUNT(*) FROM assignments WHERE session_id=? AND status='assigned')=0
      AND (SELECT COUNT(*) FROM backups WHERE session_id=? AND status='available')=0
      AND (SELECT COUNT(*) FROM synchronization_jobs WHERE phase NOT IN ('done','failed'))=0
      AND (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'
        AND name IN ('schedule_read_sessions_update','schedule_read_volunteers_delete'))=2
      THEN 'ok' ELSE NULL END)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  return [
    { sql: guard, params: [revisions.dataRevision, revisions.schedulingInputRevision, revisions.scheduleViewRevision,
      statuses, targets.candidates.length, candidateIds, targets.candidates.length,
      targets.session.id, targets.session.sourceCandidateId, targets.volunteerId,
      targets.userId, targets.volunteerId, targets.volunteerId,
      targets.volunteerId, targets.volunteerId, targets.volunteerId, targets.volunteerId, targets.volunteerId, targets.volunteerId,
      targets.session.id, targets.session.id] },
    { sql: `UPDATE candidate_schedules SET status='cancelled',updated_at=? WHERE EXISTS
      (SELECT 1 FROM json_each(?) t WHERE t.key=candidate_schedules.id AND t.value=candidate_schedules.status)`,
      params: [timestamp, statuses] },
    { sql: `UPDATE sessions SET status='cancelled',updated_at=? WHERE id=? AND status='locked' AND source_candidate_id=?`,
      params: [timestamp, targets.session.id, targets.session.sourceCandidateId] },
    { sql: `UPDATE users SET active=0,volunteer_id=NULL WHERE id=? AND active=1 AND volunteer_id=?`,
      params: [targets.userId, targets.volunteerId] },
    { sql: `DELETE FROM volunteers WHERE id=? AND lifecycle_status='newly-joined'
      AND NOT EXISTS (SELECT 1 FROM users WHERE volunteer_id=?)
      AND NOT EXISTS (SELECT 1 FROM recurring_availability WHERE volunteer_id=?)
      AND NOT EXISTS (SELECT 1 FROM availability_exceptions WHERE volunteer_id=?)
      AND NOT EXISTS (SELECT 1 FROM assignments WHERE volunteer_id=?)
      AND NOT EXISTS (SELECT 1 FROM backups WHERE volunteer_id=?)
      AND NOT EXISTS (SELECT 1 FROM import_mappings WHERE volunteer_id=?)
      AND NOT EXISTS (SELECT 1 FROM imported_availability WHERE volunteer_id=?)`,
      params: [targets.volunteerId, targets.volunteerId, targets.volunteerId, targets.volunteerId,
        targets.volunteerId, targets.volunteerId, targets.volunteerId, targets.volunteerId] },
    revisionAdvance('dataRevision', revisions.dataRevision),
    revisionAdvance('schedulingInputRevision', revisions.schedulingInputRevision),
  ];
}

function assertPostState(db, targets, revisions) {
  if (metaRevision(db, 'dataRevision') !== revisions.dataRevision + 1
    || metaRevision(db, 'schedulingInputRevision') !== revisions.schedulingInputRevision + 1
    || metaRevision(db, 'scheduleViewRevision') !== revisions.scheduleViewRevision + 2) {
    throw new Error('The offline cleanup produced unexpected revision changes.');
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM candidate_schedules WHERE id IN (SELECT value FROM json_each(?)) AND status='cancelled'")
    .get(JSON.stringify(targets.candidates.map(row => row.id)))?.count !== targets.candidates.length
    || db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id=? AND status='cancelled' AND source_candidate_id=?")
      .get(targets.session.id, targets.session.sourceCandidateId)?.count !== 1
    || db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=? AND active=0 AND volunteer_id IS NULL')
      .get(targets.userId)?.count !== 1
    || db.prepare('SELECT COUNT(*) AS count FROM volunteers WHERE id=?').get(targets.volunteerId)?.count !== 0
    || db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key='cleanupFence'").get()?.count !== 0) {
    throw new Error('The offline cleanup did not produce the reviewed target state.');
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM synchronization_jobs WHERE phase NOT IN ('done','failed')").get()?.count !== 0) {
    throw new Error('An active synchronization job appeared in the offline cleanup.');
  }
  const manifest = db.prepare("SELECT schema_version,source_version,input_revision,part_count,digest FROM schedule_read_manifest WHERE id='schedule'").get();
  const parts = db.prepare('SELECT part,body FROM schedule_read_parts ORDER BY part').all();
  if (!manifest || manifest.source_version !== revisions.scheduleViewRevision + 2
    || manifest.part_count !== parts.length || !parts.length
    || parts.some((row, index) => row.part !== index)) throw new Error('The prepared schedule was not refreshed consistently.');
  const core = parts.map(row => row.body).join('');
  let view;
  try { view = JSON.parse(core); } catch { throw new Error('The prepared schedule is not valid JSON.'); }
  if (!view.sessions?.some(row => row.id === targets.session.id && row.status === 'cancelled')
    || view.volunteers?.some(row => row.id === targets.volunteerId)) throw new Error('The prepared schedule does not reflect the cleanup.');
}

function executeBatch(db, batch) {
  db.exec('BEGIN');
  try {
    for (const item of batch) {
      if (!Array.isArray(item.params) || item.params.some(value => !sqlSafe(value))) throw new Error('Invalid generated SQL parameters.');
      db.prepare(item.sql).run(...item.params);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readOnlyAdapter(db) {
  return {
    prepare(sql) {
      if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Schedule preparation attempted a write.');
      return { sql, params: [], bind(...params) { return { sql, params }; } };
    },
    async batch(statements) {
      return statements.map(({ sql, params }) => ({ results: db.prepare(sql).all(...params), success: true }));
    },
  };
}

async function preparePlan(sourceSql, targets, prepareScheduleBackfill, { revisionsMustMatch, type, databaseId = null }) {
  const source = dbFromSql(sourceSql);
  try {
    const revisions = validateBase(source, targets, revisionsMustMatch);
    const timestamp = new Date().toISOString();
    const mutations = mutationStatements(targets, revisions, timestamp);
    const staging = dbFromSql(sourceSql);
    let scheduleStatements;
    try {
      executeBatch(staging, mutations);
      scheduleStatements = await prepareScheduleBackfill(readOnlyAdapter(staging));
    } finally { staging.close(); }
    const backfill = scheduleStatements.map(({ sql, values }) => ({ sql, params: values }));
    const postcondition = `UPDATE meta SET value=CASE WHEN
        (SELECT CAST(value AS INTEGER) FROM meta WHERE key='dataRevision')=?
        AND (SELECT CAST(value AS INTEGER) FROM meta WHERE key='schedulingInputRevision')=?
        AND (SELECT CAST(value AS INTEGER) FROM meta WHERE key='scheduleViewRevision')=?
        AND (SELECT COUNT(*) FROM candidate_schedules WHERE id IN (SELECT value FROM json_each(?)) AND status='cancelled')=?
        AND (SELECT COUNT(*) FROM sessions WHERE id=? AND status='cancelled' AND source_candidate_id=?)=1
        AND (SELECT COUNT(*) FROM users WHERE id=? AND active=0 AND volunteer_id IS NULL)=1
        AND (SELECT COUNT(*) FROM volunteers WHERE id=?)=0
        AND (SELECT COUNT(*) FROM schedule_read_manifest WHERE id='schedule'
          AND source_version=? AND part_count=(SELECT COUNT(*) FROM schedule_read_parts))=1
        AND NOT EXISTS (SELECT 1 FROM synchronization_jobs WHERE phase NOT IN ('done','failed'))
        THEN value ELSE NULL END WHERE key='cleanupFence'`;
    const batch = [...mutations, ...backfill,
      { sql: postcondition, params: [revisions.dataRevision + 1, revisions.schedulingInputRevision + 1,
        revisions.scheduleViewRevision + 2, JSON.stringify(targets.candidates.map(row => row.id)), targets.candidates.length,
        targets.session.id, targets.session.sourceCandidateId, targets.userId, targets.volunteerId,
        revisions.scheduleViewRevision + 2] },
      { sql: "DELETE FROM meta WHERE key='cleanupFence'", params: [] }];
    if (batch.some(item => !Array.isArray(item.params) || item.params.length !== placeholderCount(item.sql)
      || item.params.some(value => !sqlSafe(value)))) throw new Error('The generated batch contains invalid parameters.');

    const verification = dbFromSql(sourceSql);
    try {
      executeBatch(verification, batch);
      assertPostState(verification, targets, revisions);
      if (verification.prepare('PRAGMA foreign_key_check').all().length
        || verification.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('The offline result failed database integrity checks.');
    } finally { verification.close(); }
    const request = JSON.stringify({ batch });
    const manifest = { format: 1, kind: type, databaseId, sourceSha256: digest(sourceSql),
      requestSha256: digest(request), statements: batch.length, sourceDataRevision: revisions.dataRevision,
      sourceSchedulingInputRevision: revisions.schedulingInputRevision, sourceScheduleViewRevision: revisions.scheduleViewRevision,
      targetDataRevision: revisions.dataRevision + 1, targetSchedulingInputRevision: revisions.schedulingInputRevision + 1,
      targetScheduleViewRevision: revisions.scheduleViewRevision + 2, updatedAt: timestamp,
      operations: { candidatesCancelled: targets.candidates.length, sessionsCancelled: 1, usersDeactivated: 1, volunteersRemoved: 1 },
      targetSet: { proposals: targets.candidates.map(row => ({ id: row.id, from: row.status, to: 'cancelled' })),
        session: { id: targets.session.id, sourceCandidateId: targets.session.sourceCandidateId, from: 'locked', to: 'cancelled' },
        user: { id: targets.userId, fromActive: true, toActive: false, volunteerLink: 'cleared' },
        volunteer: { id: targets.volunteerId, fromLifecycleStatus: 'newly-joined', to: 'deleted' } },
      preconditions: { activeSyncJobs: 0, volunteerReferences: 0, sessionActiveAssignments: 0, sessionAvailableBackups: 0 },
      offlineVerified: true, productionContacted: false, sourceModified: false };
    return { request, manifest };
  } finally { source.close(); }
}

async function writePlan(prefix, request, manifest) {
  const paths = [`${prefix}.request.json`, `${prefix}.manifest.json`];
  const directory = dirname(resolve(prefix));
  const metadata = await stat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new Error('Plan output must be inside an owner-only directory.');
  const handles = [], created = [];
  try {
    for (const path of paths) {
      handles.push(await open(path, 'wx', 0o600));
      created.push(path);
    }
    await handles[0].writeFile(request, 'utf8');
    await handles[1].writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (error) {
    await Promise.all(created.map(path => rm(path, { force: true })));
    throw error;
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

async function runCleanupPreparation(args) {
  const options = parseOptions(args);
  const temp = await mkdtemp(join(tmpdir(), 'test-data-cleanup-'));
  try {
  const [backupSql, targetsRaw, configRaw] = await Promise.all([
    readFile(resolve(options['--backup']), 'utf8'), readFile(resolve(options['--targets']), 'utf8'), readFile(resolve(options['--config']), 'utf8'),
  ]);
  const targets = readTargets(targetsRaw);
  const config = JSON.parse(configRaw);
  const bindings = config.d1_databases?.filter(binding => binding.binding === 'DB') ?? [];
  const databaseId = bindings.length === 1 ? bindings[0].database_id : null;
  if (typeof databaseId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(databaseId)) {
    throw new Error('The private config does not identify exactly one valid DB target.');
  }
  const entry = join(temp, 'prepare.mjs');
  await build({ stdin: { contents: `export {prepareScheduleBackfill} from ${JSON.stringify(join(root, 'src/worker/repositories/database.ts'))};`,
    resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: entry, logLevel: 'silent' });
  const { prepareScheduleBackfill } = await import(pathToFileURL(entry).href);
  const production = await preparePlan(backupSql, targets, prepareScheduleBackfill,
    { revisionsMustMatch: true, type: 'production-cleanup', databaseId });

  let seedSummary, seedPlan, seedBytes, seedCandidate;
  if (options['--seed']) {
    seedBytes = await readFile(resolve(options['--seed']));
    const seedSql = seedBytes.toString('utf8');
    if (!Buffer.from(seedSql, 'utf8').equals(seedBytes)) throw new Error('The private seed is not valid UTF-8 SQL text.');
    const schema = await readFile(join(root, 'schema.sql'), 'utf8');
    seedPlan = await preparePlan(`${schema}\n${seedSql}`, targets, prepareScheduleBackfill,
      { revisionsMustMatch: false, type: 'private-seed-cleanup' });
    if (options['--seed-cleaned-out']) {
      const preparedBatch = JSON.parse(seedPlan.request).batch;
      const separator = seedSql.endsWith('\n') ? '\n-- Offline cleanup candidate: append only after separate approval.\n' : '\n\n-- Offline cleanup candidate: append only after separate approval.\n';
      seedCandidate = Buffer.concat([seedBytes, Buffer.from(`${separator}${renderBatchAsSql(preparedBatch)}`, 'utf8')]);
      const verifiedCandidate = dbFromSql(`${schema}\n${seedCandidate.toString('utf8')}`);
      try {
        assertPostState(verifiedCandidate, targets, { dataRevision: seedPlan.manifest.sourceDataRevision,
          schedulingInputRevision: seedPlan.manifest.sourceSchedulingInputRevision,
          scheduleViewRevision: seedPlan.manifest.sourceScheduleViewRevision });
        if (verifiedCandidate.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
          || verifiedCandidate.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error('The private seed replacement failed offline integrity checks.');
        }
      } finally { verifiedCandidate.close(); }
      seedPlan.manifest.seedSourceSha256 = digest(seedBytes);
      seedPlan.manifest.seedCandidateSha256 = digest(seedCandidate);
      seedPlan.manifest.seedReplacementStrategy = 'Original seed bytes followed by the prepared cleanup statements; source file remains unchanged until separately approved.';
    }
    seedSummary = { statements: seedPlan.manifest.statements, sourceDataRevision: seedPlan.manifest.sourceDataRevision,
      sourceSchedulingInputRevision: seedPlan.manifest.sourceSchedulingInputRevision,
      sourceScheduleViewRevision: seedPlan.manifest.sourceScheduleViewRevision, requestSha256: seedPlan.manifest.requestSha256,
      ...(seedPlan.manifest.seedSourceSha256 ? { sourceSeedSha256: seedPlan.manifest.seedSourceSha256,
        candidateSeedSha256: seedPlan.manifest.seedCandidateSha256 } : {}) };
  }
  await writePlan(resolve(options['--out']), production.request, production.manifest);
  if (seedPlan) await writePlan(resolve(options['--seed-out']), seedPlan.request, seedPlan.manifest);
  if (seedBytes && options['--seed-before-out']) await writePrivateFile(resolve(options['--seed-before-out']), seedBytes);
  if (seedCandidate && options['--seed-cleaned-out']) await writePrivateFile(resolve(options['--seed-cleaned-out']), seedCandidate);
  return { prepared: true, offlineVerified: true, productionContacted: false, sourceModified: false,
    statements: production.manifest.statements, requestSha256: production.manifest.requestSha256,
    sourceDataRevision: production.manifest.sourceDataRevision,
    sourceSchedulingInputRevision: production.manifest.sourceSchedulingInputRevision,
    sourceScheduleViewRevision: production.manifest.sourceScheduleViewRevision,
    targetDataRevision: production.manifest.targetDataRevision,
    targetSchedulingInputRevision: production.manifest.targetSchedulingInputRevision,
    targetScheduleViewRevision: production.manifest.targetScheduleViewRevision,
    operations: production.manifest.operations, ...(seedSummary ? { seedPlan: seedSummary } : {}) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCleanupPreparation(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Cleanup preparation failed. No private rows or SQL were printed; no production or seed source was modified. Check the local target set, revisions, dependencies and output paths.\n');
    process.exitCode = 1;
  }
}
