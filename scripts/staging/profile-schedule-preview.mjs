#!/usr/bin/env node
// Local profile harness for the schedule preview computation.
//
// Times the four phases of `admin.schedule.preview` — Sheets row decode, the
// `scheduleSessions` calculation, projection assembly, and envelope
// serialization — over the pinned representative and larger fixtures, exactly
// as the staging Durable Object serves them: one fresh snapshot and runtime per
// request, synchronous, no network. Every iteration also runs the real preview
// handler end to end as the cross-check that the phase split accounts for the
// whole request, and asserts envelope equality with the phase-built result.
//
// Read-only and offline: it touches no Sheet, no deployment and no credential.
// `--plan` prints the run plan without measuring; an explicit `--confirm-local`
// runs the (CPU-heavy) measurement. `--parity` runs the differential parity
// cases against the bundled live and frozen (`reference/`) implementations and
// prints a per-case digest report. Output is JSON on stdout.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Pinned fixture digests, from the archived staging manifest. */
const FIXTURE_DIGESTS = {
  representative: 'aedfec2ba60623013a0427df0f084020ab3e84118e0b4f1370e602e0db3372a9',
  larger: 'fc05ff654fff5304b8cf9af200413f2eab03692674182132d4150f2690fcb517'
};

/** Pinned clocks per the feasibility experiment contract. */
const CLOCKS = {
  representative: '2026-10-05T12:00:00.000Z',
  larger: '2026-10-05T12:00:00.000Z',
  largerPostDst: '2026-11-03T12:00:00.000Z'
};

/** Iteration counts: the larger fixture costs seconds per request locally. */
const ITERATIONS = { representative: 25, larger: 12 };

const TAB_REPOSITORIES = [
  ['SchedulingRuns', 'schedulingRuns'],
  ['Volunteers', 'volunteers'],
  ['RecurringAvailability', 'recurringAvailability'],
  ['AvailabilityExceptions', 'exceptions'],
  ['Sessions', 'sessions'],
  ['Assignments', 'assignments'],
  ['Centers', 'centers']
];

/** Loads the shared case builders and server modules through an esbuild bundle. */
async function loadServerModules() {
  const result = await build({
    stdin: {
      contents: `
export { createProductionRuntime, repositories, schedulingInputRevision, scheduleProjection } from './src/server/runtime.js';
export { createWorkbookSnapshot, createSnapshotBatchReader } from './src/worker/workbook/snapshot.js';
export { WORKBOOK_TABS, tabDefinition } from './src/server/workbook/schema.js';
export { hydratedVolunteers } from './src/server/workbook/hydration.js';
export { validateCommittedSessionInputs } from './src/server/scheduling/inputs.js';
export { SchedulingStore, runScheduling } from './src/server/scheduling/publication.js';
export { scheduleSessions } from './src/server/scheduling/scheduler.js';
export { INTEGRATION_OPERATIONS } from './src/server/integration/request-policy.js';
export {
  REPRESENTATIVE_CLOCK, POST_DST_CLOCK, DEPLOYED_FIXTURE_DIGESTS,
  fixtureRows, decodeRows, parityInputFor, pinnedCase, randomCase, RANDOM_SEEDS, EDGE_CASES,
  workbookDigest
} from './src/server/scheduling/preview-parity-cases.js';
export { computePreview, computeReferencePreview, runParityCase, digestOf } from './src/server/scheduling/preview-parity.js';
export { buildFixture } from './scripts/staging/fixture.mjs';
export { stableJson } from './src/server/integration/projection-diff.js';
`,
      resolveDir: REPOSITORY_ROOT,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent'
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error('The server modules could not be bundled.');
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function latestCompletedRun(modules, runs) {
  return [...runs].filter((run) => run.status === 'completed')
    .sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0];
}

/** One fresh decode: snapshot, repositories primed like the Worker request. */
function decodePhase(modules, rows, properties) {
  const snapshot = modules.createWorkbookSnapshot('America/New_York');
  for (const [tab, tabRows] of rows) snapshot.setTab(tab, tabRows);
  const repo = modules.repositories(snapshot.spreadsheet, properties, { timeZone: 'America/New_York' });
  for (const [tab, field] of TAB_REPOSITORIES) repo[field].primeRows(rows.get(tab));
  return {
    repo,
    previous: latestCompletedRun(modules, repo.schedulingRuns.list()),
    volunteers: modules.hydratedVolunteers(repo),
    sessions: modules.validateCommittedSessionInputs(repo.sessions.list()),
    exceptions: repo.exceptions.list(),
    assignments: repo.assignments.list(),
    centers: repo.centers.list(),
    inputRevision: modules.schedulingInputRevision(properties)
  };
}

function scheduleInput(decoded, clock) {
  return {
    volunteers: decoded.volunteers,
    sessions: decoded.sessions,
    asOf: clock,
    schedulingTimeZone: 'America/New_York',
    exceptions: decoded.exceptions,
    assignments: decoded.assignments,
    scheduleRevision: (decoded.previous?.outputRevision ?? 0) + 1,
    createdAt: clock
  };
}

function propertiesFor(fixture) {
  const values = new Map([
    ['TIME_ZONE', 'America/New_York'],
    ['DISPLAY_INCREMENT_MINUTES', '30'],
    ['OPERATING_HOURS_START', '09:00'],
    ['OPERATING_HOURS_END', '21:00'],
    ['DATA_REVISION', String(fixture.revisions.dataRevision)],
    ['SCHEDULING_INPUT_REVISION', String(fixture.revisions.schedulingInputRevision)],
    ['WRITE_ENABLED', 'false']
  ]);
  for (const tab of ['Volunteers', 'RecurringAvailability', 'AvailabilityExceptions', 'Sessions', 'Assignments', 'Backups', 'SchedulingRuns', 'Imports', 'ImportMappings', 'ImportedAvailability', 'Users', 'Settings', 'AuditLog', 'Centers', 'CandidateSchedules']) {
    values.set(`TAB_REVISION_${tab}`, String(fixture.revisions.tabRevision));
  }
  return {
    getProperty: (name) => values.get(name) ?? null,
    setProperty: (name, value) => { values.set(name, value); }
  };
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(samples) {
  return {
    medianMs: quantile(samples, 0.5),
    p99Ms: quantile(samples, 0.99),
    maxMs: samples.length ? Math.max(...samples) : null,
    minMs: samples.length ? Math.min(...samples) : null
  };
}

/** Profiles one fixture at its pinned clock and, for the larger one, post-DST. */
function profileFixture(modules, size, options) {
  const fixture = modules.buildFixture({ size, startDate: '2026-10-05' });
  const rows = modules.fixtureRows(fixture);
  const digest = createHash('sha256').update(JSON.stringify(modules.WORKBOOK_TABS.map((tab) => [tab.name, rows.get(tab.name) ?? []]))).digest('hex');
  if (digest !== FIXTURE_DIGESTS[fixture.size]) {
    throw new Error(`The regenerated ${fixture.size} fixture digest ${digest} does not match the staged workbook (${FIXTURE_DIGESTS[fixture.size]}); refusing to profile a different workbook.`);
  }
  const properties = propertiesFor(fixture);
  const clock = size === 'larger' ? CLOCKS.larger : CLOCKS.representative;
  const runs = [];

  for (let iteration = 0; iteration < options.iterations + options.warmup; iteration += 1) {
    const measured = iteration >= options.warmup;
    const phases = {};

    let started = process.hrtime.bigint();
    const decoded = decodePhase(modules, rows, properties);
    phases.decode = process.hrtime.bigint() - started;

    started = process.hrtime.bigint();
    const calculation = modules.scheduleSessions(scheduleInput(decoded, clock));
    phases.scheduler = process.hrtime.bigint() - started;

    started = process.hrtime.bigint();
    const store = new modules.SchedulingStore({ inputRevision: decoded.inputRevision, currentRevision: decoded.previous?.outputRevision ?? 0 });
    const run = modules.runScheduling(store, {
      inputRevision: decoded.inputRevision,
      actorId: 'profile',
      volunteers: decoded.volunteers,
      sessions: decoded.sessions,
      schedulingTimeZone: 'America/New_York',
      exceptions: decoded.exceptions,
      assignments: decoded.assignments,
      runId: `profile-${iteration}`,
      startedAt: clock
    });
    phases.publication = process.hrtime.bigint() - started;

    started = process.hrtime.bigint();
    const envelope = modules.scheduleProjection(decoded.repo, { assignments: run.schedule.assignments, backups: run.schedule.backups, outputRevision: run.schedule.revision }, {
      globalRevision: fixture.revisions.dataRevision,
      schedulingInput: decoded.inputRevision,
      run: decoded.previous,
      preview: true,
      computedAt: clock,
      schedulingTimeZone: 'America/New_York'
    });
    phases.assembly = process.hrtime.bigint() - started;

    started = process.hrtime.bigint();
    const serialized = JSON.stringify(envelope);
    phases.serialization = process.hrtime.bigint() - started;

    started = process.hrtime.bigint();
    const runtime = modules.createProductionRuntime(spreadsheetWithRows(modules, rows), properties, { batchReader: modules.createSnapshotBatchReader(rows) });
    const handler = runtime.handlers[modules.INTEGRATION_OPERATIONS.adminSchedulePreview];
    const endToEnd = handler({
      actor: { claims: { iss: 'https://accounts.google.com', aud: 'staging', sub: 'profile', email: 'profile@example.test', exp: 0 }, user: { id: 'profile', email: 'profile@example.test', roles: ['administrator'], active: true, revision: 0 }, email: 'profile@example.test' },
      operation: modules.INTEGRATION_OPERATIONS.adminSchedulePreview,
      idempotencyKey: `profile-${iteration}`,
      now: clock
    }, {});
    phases.endToEnd = process.hrtime.bigint() - started;

    // Envelope parity: the end-to-end handler must return what the phases built.
    if (JSON.stringify(endToEnd) !== serialized) {
      throw new Error(`Iteration ${iteration}: the end-to-end handler envelope differs from the phase-assembled envelope; the phase split does not describe the real request.`);
    }

    if (measured) {
      runs.push({
        iteration: iteration - options.warmup,
        bytes: serialized.length,
        assignments: calculation.assignments.length,
        backups: calculation.backups.length,
        shortfalls: calculation.shortfalls.length,
        excludedCutoff: calculation.excludedCutoffSessionIds.length,
        ...Object.fromEntries(Object.entries(phases).map(([phase, value]) => [phase, Number(value) / 1e6]))
      });
    }
  }

  const measured = {};
  for (const phase of ['decode', 'scheduler', 'publication', 'assembly', 'serialization', 'endToEnd']) {
    measured[phase] = summarize(runs.map((run) => run[phase]));
  }
  const phaseSummaries = runs.map((run) => run.decode + run.scheduler + run.assembly + run.serialization);
  const phaseSum = summarize(phaseSummaries);
  const medianSum = phaseSum.medianMs ?? 0;
  const shares = {
    decode: measured.decode.medianMs,
    scheduler: measured.scheduler.medianMs,
    assembly: measured.assembly.medianMs,
    serialization: measured.serialization.medianMs
  };
  const report = {
    fixture: size,
    clock,
    iterations: runs.length,
    envelopeBytes: runs[0].bytes,
    calculationShape: {
      assignments: runs[0].assignments,
      backups: runs[0].backups,
      shortfalls: runs[0].shortfalls,
      excludedCutoff: runs[0].excludedCutoff
    },
    phasesMs: measured,
    phaseSumMs: phaseSum,
    endToEndMs: measured.endToEnd,
    sharesAtMedian: Object.fromEntries(Object.entries(shares).map(([phase, value]) => [phase, medianSum > 0 ? Math.round((value / medianSum) * 1000) / 10 : null]))
  };
  if (size === 'larger') {
    report.postDst = profilePostDst(modules, fixture, rows, properties, options);
  }
  return report;
}

function spreadsheetWithRows(modules, rows) {
  const snapshot = modules.createWorkbookSnapshot('America/New_York');
  for (const [tab, tabRows] of rows) snapshot.setTab(tab, tabRows);
  return snapshot.spreadsheet;
}

function profilePostDst(modules, fixture, rows, properties, options) {
  const clock = CLOCKS.largerPostDst;
  const runs = [];
  for (let iteration = 0; iteration < options.postDstIterations; iteration += 1) {
    const started = process.hrtime.bigint();
    const decoded = decodePhase(modules, rows, properties);
    const calculation = modules.scheduleSessions(scheduleInput(decoded, clock));
    runs.push({
      iteration,
      schedulerMs: Number(process.hrtime.bigint() - started) / 1e6,
      assignments: calculation.assignments.length,
      excludedCutoff: calculation.excludedCutoffSessionIds.length
    });
  }
  return {
    clock,
    schedulerMs: summarize(runs.map((run) => run.schedulerMs)),
    assignments: runs[0].assignments,
    excludedCutoff: runs[0].excludedCutoff,
    note: 'Scheduler + decode only; the post-DST clock excludes started occurrences and exercises cutoff handling.'
  };
}

function parseArguments(argv) {
  const options = { plan: false, confirm: false, parity: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') options.plan = true;
    else if (argument === '--parity') options.parity = true;
    else if (argument === '--confirm-local') options.confirm = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

/** Runs the differential parity cases against the bundled implementations. */
async function runParityReport(modules) {
  const cases = [];
  for (const size of ['representative', 'larger']) {
    cases.push({ name: `${size}@${CLOCKS.representative}`, computation: modules.pinnedCase(size, CLOCKS.representative) });
    cases.push({ name: `${size}@${CLOCKS.largerPostDst}`, computation: modules.pinnedCase(size, CLOCKS.largerPostDst) });
  }
  for (const edge of modules.EDGE_CASES) cases.push({ name: edge.name, computation: edge.computation });
  for (const seed of modules.RANDOM_SEEDS) cases.push({ name: `seed-${seed}`, computation: modules.randomCase(seed) });
  const outcomes = [];
  for (const { name, computation } of cases) {
    outcomes.push(await modules.runParityCase(name, computation));
  }
  const allEqual = outcomes.every((outcome) => outcome.equal);
  return {
    cases: outcomes,
    equal: allEqualOrEmpty(outcomes),
    note: 'Digests are over the canonical live envelope; equality compares live vs frozen reference per case.'
  };

  function allEqualOrEmpty(list) {
    return list.every((outcome) => outcome.equal);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = {
    fixtures: ['representative', 'larger'],
    clocks: CLOCKS,
    iterations: ITERATIONS,
    warmup: 3,
    phases: ['decode', 'scheduler', 'publication', 'assembly', 'serialization', 'endToEnd'],
    readsSheets: false,
    writesSheets: false,
    note: 'Local CPU timing only; thresholds come from the campaign record, never from local runs.'
  };
  const modules = await loadServerModules();
  if (options.parity) {
    if (!options.confirm) {
      console.log(JSON.stringify({ ...plan, mode: 'parity' }, null, 2));
      console.error('Refusing to run: pass --confirm-local to spend the CPU time.');
      return;
    }
    console.log(JSON.stringify(await runParityReport(modules), null, 2));
    return;
  }
  if (options.plan || !options.confirm) {
    console.log(JSON.stringify(plan, null, 2));
    if (!options.confirm) console.error('Refusing to run: pass --confirm-local to spend the CPU time.');
    return;
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    representative: profileFixture(modules, 'representative', { iterations: ITERATIONS.representative, warmup: options.warmup ?? 3, postDstIterations: 5 }),
    larger: profileFixture(modules, 'larger', { iterations: ITERATIONS.larger, warmup: options.warmup ?? 3, postDstIterations: 5 })
  }, null, 2));
}

await main();
