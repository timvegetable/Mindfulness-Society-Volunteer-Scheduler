// Synthetic staging fixture generator.
//
// Pure and deterministic: the same options always produce the same rows, so the
// fixture digest recorded with a measurement can be reproduced. Rows are emitted
// as column-name objects and mapped to sheet order by the loader, which reads the
// workbook schema from `src/server/workbook/schema.ts`, so the column order has
// exactly one source of truth.
//
// Dimensions and semantics follow evidence/experiment-contract.md: the pinned
// volunteer eligibility mix, a two-staff session every fifth id, a leftover
// population large enough to produce a non-empty insights grid, and session
// dates placed after the measurement start so the cutoff keeps them.

/** Pinned dimensions per the experiment contract. */
export const FIXTURE_SIZES = {
  representative: {
    label: 'representative',
    centers: 4,
    volunteers: 40,
    availabilityWeekdays: [1, 2, 3, 4, 5],
    exceptions: 12,
    sessions: 20,
    assignments: 20,
    backups: 4,
    completedRuns: 1,
    assignedVolunteers: 15
  },
  larger: {
    label: 'larger',
    centers: 10,
    volunteers: 200,
    availabilityWeekdays: [1, 2, 3, 4, 5],
    exceptions: 60,
    sessions: 400,
    assignments: 400,
    backups: 80,
    completedRuns: 4,
    assignedVolunteers: 120
  }
};

export const FIXTURE_REVISIONS = {
  dataRevision: 42,
  schedulingInputRevision: 5,
  schedulingOutputRevision: 7,
  tabRevision: 1
};

/** Roles are the authorization surface; the denial variants are produced separately. */
export const DEFAULT_ACCOUNTS = {
  administrator: 'tcai5958@terpmail.umd.edu',
  multi: 'timothyc2371@gmail.com',
  volunteer: 'manbob928@gmail.com',
  centerContact: '101dimensional@gmail.com'
};

const UTC = (value) => new Date(`${value}T12:00:00.000Z`).toISOString();

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** Monday on or after the given date, so sessions start in a known week. */
export function nextMonday(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay();
  return addDays(date, day === 1 ? 7 : (8 - day) % 7);
}

function secondsToClock(seconds) {
  const hour = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const minute = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * Builds the fixture. `accounts` supplies the four authorized Google addresses;
 * the denial variants (blank active, inactive, no row) are applied later by the
 * denial-variant pass rather than being extra rows here.
 */
export function buildFixture(options) {
  const size = typeof options?.size === 'string' ? FIXTURE_SIZES[options.size] : options?.size;
  if (!size) throw new Error(`Unknown fixture size; expected one of ${Object.keys(FIXTURE_SIZES).join(', ')}.`);
  const accounts = { ...DEFAULT_ACCOUNTS, ...(options?.accounts ?? {}) };
  const startDate = options?.startDate ?? new Date().toISOString().slice(0, 10);
  const timeZone = options?.schedulingTimeZone ?? 'America/Chicago';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('startDate must be YYYY-MM-DD.');

  const tabs = new Map();
  const add = (tab, row) => {
    const rows = tabs.get(tab) ?? [];
    rows.push(row);
    tabs.set(tab, rows);
  };
  const timestamp = UTC(startDate);

  for (let index = 1; index <= size.centers; index += 1) {
    add('Centers', { id: `center-${index}`, name: `Synthetic Center ${index}`, active: true, revision: FIXTURE_REVISIONS.tabRevision, createdAt: timestamp, updatedAt: timestamp });
  }

  // The eligibility mix the contract pins, exactly: 30 eligible volunteers then
  // four ineligible categories and one blank readiness rank for the
  // representative fixture, and 150 eligible followed by five repetitions of the
  // same four ineligible categories for the larger one. `cancelled` is not a
  // domain value, so the cancelled-volunteer case is pinned as `inactive`.
  const eligibility = (index) => {
    const representative = size.label === 'representative';
    const eligibleThrough = representative ? 30 : 150;
    if (index <= eligibleThrough) return { lifecycleStatus: 'active', interviewStatus: 'complete', blankRank: false };
    const offset = (index - eligibleThrough - 1) % 10;
    if (offset <= 3) return { lifecycleStatus: 'graduated', interviewStatus: 'complete', blankRank: false };
    if (offset <= 6) return { lifecycleStatus: 'inactive', interviewStatus: 'complete', blankRank: false };
    if (offset <= 8) return { lifecycleStatus: 'active', interviewStatus: 'incomplete', blankRank: false };
    return { lifecycleStatus: 'active', interviewStatus: 'complete', blankRank: true };
  };
  const volunteerCount = size.volunteers;
  for (let index = 1; index <= volunteerCount; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const status = eligibility(index, volunteerCount);
    add('Volunteers', {
      id: `volunteer-${suffix}`,
      name: `Synthetic Volunteer ${suffix}`,
      email: `synthetic-volunteer-${suffix}@example.test`,
      lifecycleStatus: status.lifecycleStatus,
      interviewStatus: status.interviewStatus,
      readinessRank: status.blankRank ? '' : (index % 3) + 1,
      revision: FIXTURE_REVISIONS.tabRevision,
      // One volunteer row omits its trailing cells, so the read path exercises
      // the padding the shared validator performs.
      source: index === 8 ? '' : 'staging-fixture',
      createdAt: timestamp,
      updatedAt: index === 8 ? '' : timestamp
    });
    size.availabilityWeekdays.forEach((weekday, position) => {
      const startSeconds = (9 + ((index + weekday) % 5)) * 3600 + position * 1800;
      add('RecurringAvailability', {
        id: `availability-${suffix}-${weekday}`,
        volunteerId: `volunteer-${suffix}`,
        weekday,
        start: secondsToClock(startSeconds),
        end: secondsToClock(Math.min(startSeconds + 4 * 3600, 21 * 3600)),
        timeZone,
        revision: FIXTURE_REVISIONS.tabRevision,
        source: 'staging-fixture',
        updatedAt: timestamp
      });
    });
  }

  for (let index = 0; index < size.exceptions; index += 1) {
    const volunteer = String((index % Math.max(1, size.assignedVolunteers)) + 1).padStart(3, '0');
    add('AvailabilityExceptions', {
      id: `exception-${String(index + 1).padStart(3, '0')}`,
      volunteerId: `volunteer-${volunteer}`,
      date: addDays(startDate, 3 + (index % 14)),
      kind: 'unavailable',
      start: '09:00',
      end: '17:00',
      timeZone,
      reason: 'synthetic exception',
      revision: FIXTURE_REVISIONS.tabRevision,
      updatedAt: timestamp
    });
  }

  const sessionStart = nextMonday(startDate);
  for (let index = 0; index < size.sessions; index += 1) {
    const suffix = String(index + 1).padStart(3, '0');
    const date = addDays(sessionStart, Math.floor(index / 4) * 7 + [0, 2, 4, 6][index % 4]);
    const morning = index % 2 === 0;
    add('Sessions', {
      id: `session-${suffix}`,
      kind: 'center',
      centerId: `center-${(index % size.centers) + 1}`,
      title: `Synthetic Session ${index + 1}`,
      date,
      start: morning ? '10:00' : '14:00',
      end: morning ? '12:00' : '16:00',
      timeZone,
      // Every fifth session needs two staff, so the shortfall invariant is not vacuous.
      requiredStaffCount: index % 5 === 4 ? 2 : 1,
      status: 'locked',
      revision: FIXTURE_REVISIONS.tabRevision,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    if (index < size.assignments) {
      add('Assignments', {
        id: `assignment-${suffix}`,
        sessionId: `session-${suffix}`,
        volunteerId: `volunteer-${String((index % size.assignedVolunteers) + 1).padStart(3, '0')}`,
        scheduleRevision: FIXTURE_REVISIONS.schedulingOutputRevision,
        status: 'assigned',
        createdAt: timestamp
      });
    }
    if (index < size.backups) {
      add('Backups', {
        id: `backup-${suffix}`,
        sessionId: `session-${suffix}`,
        volunteerId: `volunteer-${String(size.assignedVolunteers + index + 1).padStart(3, '0')}`,
        scheduleRevision: FIXTURE_REVISIONS.schedulingOutputRevision,
        position: 1,
        status: 'available'
      });
    }
  }

  // One completed run plus older ones, so latestCompletedRun has to pick by time.
  for (let index = size.completedRuns; index >= 1; index -= 1) {
    const current = index === size.completedRuns;
    add('SchedulingRuns', {
      id: current ? 'run-current' : `run-older-${index}`,
      inputRevision: current ? FIXTURE_REVISIONS.schedulingInputRevision : index,
      outputRevision: current ? FIXTURE_REVISIONS.schedulingOutputRevision : index,
      status: 'completed',
      startedAt: UTC(addDays(startDate, -20 + index)),
      completedAt: UTC(addDays(startDate, -20 + index)),
      assignmentIds: [],
      backupIds: [],
      shortfalls: []
    });
  }

  add('Users', { id: 'synthetic-user-admin', email: accounts.administrator, roles: ['administrator'], active: true, revision: FIXTURE_REVISIONS.tabRevision });
  add('Users', { id: 'synthetic-user-multi', email: accounts.multi, roles: ['administrator', 'volunteer', 'center-contact'], volunteerId: 'volunteer-001', centerIds: ['center-1'], active: true, revision: FIXTURE_REVISIONS.tabRevision });
  add('Users', { id: 'synthetic-user-volunteer', email: accounts.volunteer, roles: ['volunteer'], volunteerId: 'volunteer-002', active: true, revision: FIXTURE_REVISIONS.tabRevision });
  add('Users', { id: 'synthetic-user-contact', email: accounts.centerContact, roles: ['center-contact'], centerIds: ['center-2'], active: true, revision: FIXTURE_REVISIONS.tabRevision });

  const counts = Object.fromEntries([...tabs.entries()].map(([tab, rows]) => [tab, rows.length]).sort(([left], [right]) => left.localeCompare(right)));
  return {
    size: size.label,
    startDate,
    sessionStart,
    schedulingTimeZone: timeZone,
    accounts,
    revisions: FIXTURE_REVISIONS,
    counts,
    tabs: Object.fromEntries([...tabs.entries()].sort(([left], [right]) => left.localeCompare(right)))
  };
}

/** The denial-variant plan the loader applies after the main measurement. */
export const DENIAL_VARIANTS = [
  { name: 'blank-active', edit: { active: '' }, expected: 'UNAUTHORIZED' },
  { name: 'inactive', edit: { active: false }, expected: 'UNAUTHORIZED' },
  { name: 'no-row', edit: null, expected: 'UNAUTHORIZED' }
];
