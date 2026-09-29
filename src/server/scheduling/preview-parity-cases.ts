import { Temporal } from '@js-temporal/polyfill';
import { BATCH_READ_PLANS, type BatchReadRows } from '../workbook/batch-read.js';
import { buildFixture, FIXTURE_REVISIONS, type Fixture } from '../../../scripts/staging/fixture.mjs';
import { repositories, schedulingInputRevision, createProductionRuntime, type ScriptProperties } from '../runtime.js';
import { WORKBOOK_TABS, tabDefinition } from '../workbook/schema.js';
import { createWorkbookSnapshot } from '../../worker/workbook/snapshot.js';
import type { Assignment, AvailabilityException, RecurringAvailability, SchedulingRun, Session, Volunteer } from '../../shared/domain.js';
import type { Center } from '../centers/models.js';
import { hydratedVolunteers } from '../workbook/hydration.js';
import { validateCommittedSessionInputs } from './inputs.js';
import type { PreviewComputationInput } from './preview-parity.js';

/**
 * Case builders for the schedule-preview parity suite and profile harness.
 *
 * One source of truth for every differential case: the pinned representative
 * and larger fixtures (regenerated row-for-row against the deployed workbooks'
 * digests), the edge-case workbooks, and the seeded randomized workbooks.
 * Environment-neutral and test-runner-free, so both the Vitest suite and the
 * bundled scripts run the same cases.
 */

export const WORKBOOK_ZONE = 'America/New_York';
export const DISPLAY_ZONE = 'America/New_York';
/** Pinned clocks per the feasibility experiment contract. */
export const REPRESENTATIVE_CLOCK = '2026-10-05T12:00:00.000Z';
export const POST_DST_CLOCK = '2026-11-03T12:00:00.000Z';
/** Recorded in the archived staging manifest for the deployed workbooks. */
export const DEPLOYED_FIXTURE_DIGESTS = {
  representative: 'aedfec2ba60623013a0427df0f084020ab3e84118e0b4f1370e602e0db3372a9',
  larger: 'fc05ff654fff5304b8cf9af200413f2eab03692674182132d4150f2690fcb517'
} as const;

/** ≥10 seeds for the randomized differential suite. */
export const RANDOM_SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31] as const;

type Row = readonly unknown[];
export type FixtureRowList = readonly Row[];

const SHEETS_EPOCH = Temporal.PlainDate.from('1899-12-30');
const DATE_COLUMNS = new Set(['date']);
const CLOCK_COLUMNS = new Set(['start', 'end']);

function dateSerial(date: string): number {
  return Temporal.PlainDate.from(date).since(SHEETS_EPOCH).days;
}

function clockFraction(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return ((hour ?? 0) * 60 + (minute ?? 0)) / (24 * 60);
}

function restRow(tabDefinition: (name: string) => { columns: readonly string[] }, tab: string, row: Record<string, unknown>): Row {
  const cells = tabDefinition(tab).columns.map((column) => {
    const value = row[column];
    if (value === undefined || value === null || value === '') return '';
    if (DATE_COLUMNS.has(column) && typeof value === 'string') return dateSerial(value);
    if (CLOCK_COLUMNS.has(column) && typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return clockFraction(value);
    return typeof value === 'object' ? JSON.stringify(value) : value;
  });
  // Sheets omits trailing empty cells from every returned row. ISO instants
  // stay strings: USER_ENTERED does not type them, and the codecs decode the
  // string and serial forms to identical canonical values.
  let last = cells.length - 1;
  while (last >= 0 && (cells[last] === '' || cells[last] === undefined)) last -= 1;
  return cells.slice(0, last + 1);
}

/** The workbook digest the loader and the Worker compute for the same rows. */
export async function workbookDigest(rowsByTab: ReadonlyMap<string, FixtureRowList>): Promise<string> {
  const canonical = WORKBOOK_TABS.map((tab) => [tab.name, rowsByTab.get(tab.name) ?? []]);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fixtureRows(fixture: Fixture): Map<string, FixtureRowList> {
  const rows = new Map<string, FixtureRowList>();
  const tabs: ReadonlyArray<{ name: string }> = [
    { name: 'Volunteers' }, { name: 'RecurringAvailability' }, { name: 'AvailabilityExceptions' },
    { name: 'Sessions' }, { name: 'Assignments' }, { name: 'Backups' }, { name: 'SchedulingRuns' },
    { name: 'Users' }, { name: 'Centers' }
  ];
  for (const tab of tabs) {
    const logical = fixture.tabs[tab.name] ?? [];
    rows.set(tab.name, logical.map((row) => restRow(tabDefinition, tab.name, row)));
  }
  return rows;
}

export function fixtureProperties(overrides: Record<string, string> = {}): ScriptProperties {
  const values = new Map<string, string>([
    ['TIME_ZONE', DISPLAY_ZONE],
    ['DISPLAY_INCREMENT_MINUTES', '30'],
    ['OPERATING_HOURS_START', '09:00'],
    ['OPERATING_HOURS_END', '21:00'],
    ['DATA_REVISION', String(FIXTURE_REVISIONS.dataRevision)],
    ['SCHEDULING_INPUT_REVISION', String(FIXTURE_REVISIONS.schedulingInputRevision)],
    ['WRITE_ENABLED', 'false']
  ]);
  for (const tab of ['Volunteers', 'RecurringAvailability', 'AvailabilityExceptions', 'Sessions', 'Assignments', 'Backups', 'SchedulingRuns', 'Imports', 'ImportMappings', 'ImportedAvailability', 'Users', 'Settings', 'AuditLog', 'Centers', 'CandidateSchedules']) {
    values.set(`TAB_REVISION_${tab}`, String(FIXTURE_REVISIONS.tabRevision));
  }
  return {
    getProperty: (name) => values.get(name) ?? null,
    setProperty: (name, value) => { values.set(name, value); }
  };
}

/** The last completed run row, exactly as `latestCompletedRun` picks it. */
export function latestCompletedRun(runs: readonly SchedulingRun[]): SchedulingRun | undefined {
  return [...runs].filter((run) => run.status === 'completed')
    .sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0];
}

const SCHEDULE_PREVIEW_REPOSITORIES = [
  ['SchedulingRuns', 'schedulingRuns'],
  ['Volunteers', 'volunteers'],
  ['RecurringAvailability', 'recurringAvailability'],
  ['AvailabilityExceptions', 'exceptions'],
  ['Sessions', 'sessions'],
  ['Assignments', 'assignments'],
  ['Centers', 'centers']
] as const;

/**
 * Decodes rows the way the Worker does: one snapshot, the schedulePreview
 * batch, and repositories primed with serial-number decoding.
 */
export function decodeRows(rows: Map<string, FixtureRowList>, overrides: Record<string, string> = {}): {
  repo: ReturnType<typeof repositories>;
  properties: ScriptProperties;
  runtime: ReturnType<typeof createProductionRuntime>;
} {
  const snapshot = createWorkbookSnapshot(WORKBOOK_ZONE);
  for (const [tab, tabRows] of rows) snapshot.setTab(tab, tabRows);
  const properties = fixtureProperties(overrides);
  const repo = repositories(snapshot.spreadsheet, properties, { timeZone: WORKBOOK_ZONE });
  for (const [tab, repositoryField] of SCHEDULE_PREVIEW_REPOSITORIES) {
    const tabRows = rows.get(tab);
    if (!tabRows) throw new Error(`fixture is missing ${tab}`);
    (repo[repositoryField] as { primeRows(rows: readonly Row[]): void }).primeRows(tabRows);
  }
  const runtime = createProductionRuntime(snapshot.spreadsheet, properties, {
    batchReader: {
      read: (plan: keyof typeof BATCH_READ_PLANS): BatchReadRows => {
        const output = new Map<string, FixtureRowList>();
        for (const tab of BATCH_READ_PLANS[plan]) {
          const tabRows = rows.get(tab);
          if (!tabRows) throw new Error(`batch plan ${plan} is missing ${tab}`);
          output.set(tab, tabRows);
        }
        return output as BatchReadRows;
      }
    }
  });
  return { repo, properties, runtime };
}

/** The parity input exactly as the preview handler derives it from a snapshot. */
export function parityInputFor(decoded: { repo: ReturnType<typeof repositories>; properties: ScriptProperties }, computedAt: string): PreviewComputationInput {
  const workbookSessions = decoded.repo.sessions.list();
  return {
    volunteers: hydratedVolunteers(decoded.repo),
    sessions: validateCommittedSessionInputs(workbookSessions),
    workbookSessions,
    exceptions: decoded.repo.exceptions.list(),
    assignments: decoded.repo.assignments.list(),
    centers: decoded.repo.centers.list(),
    inputRevision: schedulingInputRevision(decoded.properties),
    previous: latestCompletedRun(decoded.repo.schedulingRuns.list()),
    globalRevision: FIXTURE_REVISIONS.dataRevision,
    schedulingTimeZone: DISPLAY_ZONE,
    requestNow: computedAt
  };
}

export function pinnedCase(size: 'representative' | 'larger', computedAt: string): PreviewComputationInput {
  return parityInputFor(decodeRows(fixtureRows(buildFixture({ size, startDate: '2026-10-05' }))), computedAt);
}

// --- Edge-case and seeded randomized workbooks (domain rows, no decode) ------

const TIMESTAMP = '2026-10-05T12:00:00.000Z';

export function parityVolunteer(id: string, rank: 1 | 2 | 3, availability: RecurringAvailability[], overrides: Partial<Volunteer> = {}): Volunteer {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    lifecycleStatus: 'active',
    interviewStatus: 'complete',
    readinessRank: rank,
    recurringAvailability: availability,
    revision: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  };
}

export function paritySession(id: string, date: string, start: string, end: string, requiredStaffCount = 1, overrides: Partial<Session> = {}): Session {
  return {
    id,
    kind: 'center',
    centerId: 'center-1',
    date,
    start,
    end,
    timeZone: DISPLAY_ZONE,
    requiredStaffCount,
    status: 'locked',
    revision: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  };
}

export function parityException(id: string, volunteerId: string, date: string, kind: 'available' | 'unavailable', start = '09:00', end = '17:00'): AvailabilityException {
  return {
    id,
    volunteerId,
    date,
    kind,
    interval: { start, end, timeZone: DISPLAY_ZONE },
    revision: 1
  };
}

export function parityAssignment(id: string, sessionId: string, volunteerId: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id,
    sessionId,
    volunteerId,
    scheduleRevision: FIXTURE_REVISIONS.schedulingOutputRevision,
    status: 'assigned',
    createdAt: TIMESTAMP,
    ...overrides
  };
}

export function parityPreviousRun(inputRevision = FIXTURE_REVISIONS.schedulingInputRevision, outputRevision = FIXTURE_REVISIONS.schedulingOutputRevision): SchedulingRun {
  return {
    id: 'run-previous',
    inputRevision,
    outputRevision,
    status: 'completed',
    startedAt: '2026-09-28T10:00:00.000Z',
    completedAt: '2026-09-28T10:05:00.000Z',
    assignmentIds: [],
    backupIds: [],
    shortfalls: []
  };
}

export function domainCase(computation: Omit<PreviewComputationInput, 'globalRevision' | 'schedulingTimeZone'>): PreviewComputationInput {
  return {
    globalRevision: FIXTURE_REVISIONS.dataRevision,
    schedulingTimeZone: DISPLAY_ZONE,
    ...computation
  };
}

/** One availability interval on a 30-minute grid inside the operating day. */
function intervalOn(weekday: RecurringAvailability['weekday'], startHour: number, hours: number): RecurringAvailability {
  const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  return { weekday, start: clock(startHour), end: clock(Math.min(startHour + hours, 21)), timeZone: DISPLAY_ZONE };
}

function dateAfter(days: number): string {
  return Temporal.PlainDate.from('2026-10-12').add({ days }).toString();
}

/** Deterministic PRNG (mulberry32), so a seed always produces the same workbook. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)] as T;
}

/** Builds a seeded randomized workbook with mixed eligibility, ranks and rows. */
export function randomCase(seed: number): PreviewComputationInput {
  const rng = mulberry32(seed);
  const suffix = String(seed).padStart(3, '0');
  const volunteerCount = 20 + Math.floor(rng() * 25);
  const sessionCount = 10 + Math.floor(rng() * 20);
  const volunteers: Volunteer[] = [];
  for (let index = 1; index <= volunteerCount; index += 1) {
    const id = `volunteer-${suffix}-${String(index).padStart(3, '0')}`;
    const eligible = rng() < 0.7;
    const rank = (1 + Math.floor(rng() * 3)) as 1 | 2 | 3;
    const availability: RecurringAvailability[] = [];
    if (eligible) {
      const intervalCount = 1 + Math.floor(rng() * 3);
      for (let position = 0; position < intervalCount; position += 1) {
        availability.push(intervalOn(pick(rng, [1, 2, 3, 4, 5, 6, 7]) as RecurringAvailability['weekday'], 9 + Math.floor(rng() * 9), 2 + Math.floor(rng() * 4)));
      }
    }
    volunteers.push(parityVolunteer(id, rank, availability, {
      lifecycleStatus: eligible ? 'active' : pick(rng, ['graduated', 'inactive', 'newly-joined'] as const),
      interviewStatus: eligible ? 'complete' : pick(rng, ['incomplete', 'complete'] as const),
      readinessRank: eligible ? rank : rng() < 0.5 ? null : rank
    }));
  }
  const sessions: Session[] = [];
  for (let index = 1; index <= sessionCount; index += 1) {
    const id = `session-${suffix}-${String(index).padStart(3, '0')}`;
    const proposed = rng() < 0.08;
    const univ100 = proposed || rng() < 0.15;
    const startHour = 9 + Math.floor(rng() * 9);
    const hours = 1 + Math.floor(rng() * 3);
    sessions.push(paritySession(id, dateAfter(Math.floor(rng() * 70)), `${String(startHour).padStart(2, '0')}:00`, `${String(Math.min(startHour + hours, 21)).padStart(2, '0')}:00`, pick(rng, [0, 1, 1, 2, 2]) as number, {
      kind: univ100 ? 'univ100' : 'center',
      status: univ100 ? (proposed ? 'proposed' : 'confirmed') : 'locked',
      centerId: univ100 ? undefined : 'center-1'
    }));
  }
  const exceptions: AvailabilityException[] = [];
  const exceptionCount = Math.floor(rng() * 9);
  for (let index = 1; index <= exceptionCount; index += 1) {
    exceptions.push(parityException(`exception-${suffix}-${index}`, pick(rng, volunteers).id, dateAfter(Math.floor(rng() * 70)), rng() < 0.7 ? 'unavailable' : 'available'));
  }
  const assignments: Assignment[] = [];
  for (const candidate of sessions.filter((entry) => entry.status !== 'proposed')) {
    if (rng() < 0.35) assignments.push(parityAssignment(`assignment-${candidate.id}-a`, candidate.id, pick(rng, volunteers).id));
    if (rng() < 0.15) assignments.push(parityAssignment(`assignment-${candidate.id}-c`, candidate.id, pick(rng, volunteers).id, { status: 'cancelled' }));
  }
  const centers: Center[] = [{ id: 'center-1', name: 'Parity Center', active: true, revision: 1, createdAt: TIMESTAMP, updatedAt: TIMESTAMP }];
  return domainCase({
    volunteers,
    sessions: validateCommittedSessionInputs(sessions),
    workbookSessions: sessions,
    exceptions,
    assignments,
    centers,
    inputRevision: FIXTURE_REVISIONS.schedulingInputRevision,
    previous: parityPreviousRun(),
    requestNow: REPRESENTATIVE_CLOCK
  });
}

/** The exact-cutoff edge case: a session starting exactly at the request clock. */
export function exactCutoffCase(): PreviewComputationInput {
  const only = parityVolunteer('only', 1, [intervalOn(1, 9, 12)]);
  const atCutoff = paritySession('at-cutoff', '2026-10-05', '08:00', '10:00'); // 08:00 EDT == 12:00Z
  const later = paritySession('later', '2026-10-05', '09:00', '11:00');
  return domainCase({
    volunteers: [only],
    sessions: validateCommittedSessionInputs([atCutoff, later]),
    workbookSessions: [atCutoff, later],
    exceptions: [],
    assignments: [],
    centers: [],
    inputRevision: 1,
    previous: undefined,
    requestNow: REPRESENTATIVE_CLOCK
  });
}

/** Duplicate volunteer rows and a blank readiness rank. */
export function duplicatesCase(): PreviewComputationInput {
  const first = parityVolunteer('dup', 1, [intervalOn(1, 9, 3)]);
  const second = parityVolunteer('dup', 3, [intervalOn(1, 9, 3)]);
  const blank = parityVolunteer('blank', 1, [], { readinessRank: null });
  const weekly = paritySession('weekly', '2026-10-05', '10:00', '11:00');
  return domainCase({
    volunteers: [first, second, blank],
    sessions: validateCommittedSessionInputs([weekly]),
    workbookSessions: [weekly],
    exceptions: [],
    assignments: [],
    centers: [],
    inputRevision: 1,
    previous: undefined,
    requestNow: REPRESENTATIVE_CLOCK
  });
}

/** An available-kind exception widening availability; an unavailable one cutting it. */
export function exceptionOverlayCase(): PreviewComputationInput {
  const covered = parityVolunteer('covered', 1, [intervalOn(1, 9, 12)]);
  const blocked = parityVolunteer('blocked', 1, [intervalOn(1, 9, 12)]);
  const weekly = paritySession('weekly', '2026-10-05', '10:00', '12:00');
  const second = paritySession('second', '2026-10-05', '13:00', '15:00');
  return domainCase({
    volunteers: [covered, blocked],
    sessions: validateCommittedSessionInputs([weekly, second]),
    workbookSessions: [weekly, second],
    exceptions: [
      parityException('make-available', covered.id, '2026-10-05', 'available', '09:30', '10:30'),
      parityException('make-unavailable', blocked.id, '2026-10-05', 'unavailable', '09:00', '17:00')
    ],
    assignments: [parityAssignment('existing', 'second', covered.id)],
    centers: [],
    inputRevision: 1,
    previous: parityPreviousRun(1, 3),
    requestNow: REPRESENTATIVE_CLOCK
  });
}

/** A session start inside the 2026-11-01 ambiguous DST hour. */
export function dstAmbiguousCase(): PreviewComputationInput {
  const only = parityVolunteer('only', 1, [intervalOn(7, 1, 4)]);
  const ambiguous = paritySession('ambiguous', '2026-11-01', '01:30', '03:30');
  return domainCase({
    volunteers: [only],
    sessions: validateCommittedSessionInputs([ambiguous]),
    workbookSessions: [ambiguous],
    exceptions: [],
    assignments: [],
    centers: [],
    inputRevision: 1,
    previous: undefined,
    requestNow: REPRESENTATIVE_CLOCK
  });
}

/** All edge cases as differential parity cases. */
export const EDGE_CASES: ReadonlyArray<{ name: string; computation: PreviewComputationInput }> = [
  { name: 'exact-cutoff', computation: exactCutoffCase() },
  { name: 'duplicates-and-blank-rank', computation: duplicatesCase() },
  { name: 'exception-overlay', computation: exceptionOverlayCase() },
  { name: 'dst-ambiguous', computation: dstAmbiguousCase() }
];
