import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENIAL_VARIANTS, FIXTURE_REVISIONS, buildFixture, nextMonday } from '../../../scripts/staging/fixture.mjs';

/**
 * The staging fixture generator must match the pinned dimensions in
 * evidence/experiment-contract.md exactly. These assertions are what stop the
 * deployed fixture from quietly diverging from the predeclared contract after
 * someone edits the generator.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const LOADER = join(ROOT, 'scripts/staging/load-fixture.mjs');

const CONTRACT_COUNTS = {
  representative: { Centers: 4, Volunteers: 40, RecurringAvailability: 200, AvailabilityExceptions: 12, Sessions: 20, Assignments: 20, Backups: 4, SchedulingRuns: 1, Users: 4 },
  larger: { Centers: 10, Volunteers: 200, RecurringAvailability: 1000, AvailabilityExceptions: 60, Sessions: 400, Assignments: 400, Backups: 80, SchedulingRuns: 4, Users: 4 }
} as const;

function runLoader(args: string[]) {
  const result = spawnSync(process.execPath, [LOADER, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('staging fixture generator', () => {
  it('produces exactly the pinned dimensions for both sizes', () => {
    for (const [size, expected] of Object.entries(CONTRACT_COUNTS)) {
      const fixture = buildFixture({ size: size as 'representative', startDate: '2026-10-05' });
      expect(fixture.counts, size).toEqual(expected);
    }
  });

  it('pins the eligibility mix the contract records', () => {
    const fixture = buildFixture({ size: 'representative', startDate: '2026-10-05' });
    const volunteers = fixture.tabs.Volunteers ?? [];
    const eligible = volunteers.filter((row) => row.lifecycleStatus === 'active' && row.interviewStatus === 'complete' && row.readinessRank !== '');
    expect(eligible).toHaveLength(30);
    expect(volunteers.filter((row) => row.lifecycleStatus === 'graduated')).toHaveLength(4);
    expect(volunteers.filter((row) => row.lifecycleStatus === 'inactive')).toHaveLength(3);
    expect(volunteers.filter((row) => row.interviewStatus === 'incomplete')).toHaveLength(2);
    expect(volunteers.filter((row) => row.readinessRank === '')).toHaveLength(1);
    // Every pinned value is a member of the domain schema.
    for (const row of volunteers) {
      expect(['active', 'newly-joined', 'inactive', 'graduated']).toContain(row.lifecycleStatus);
      expect(['incomplete', 'complete']).toContain(row.interviewStatus);
    }
  });

  it('leaves a non-empty leftover population so the insights grid is not vacuous', () => {
    for (const size of ['representative', 'larger'] as const) {
      const fixture = buildFixture({ size, startDate: '2026-10-05' });
      const assigned = new Set((fixture.tabs.Assignments ?? []).map((row) => row.volunteerId));
      const eligibleIds = (fixture.tabs.Volunteers ?? [])
        .filter((row) => row.lifecycleStatus === 'active' && row.interviewStatus === 'complete' && row.readinessRank !== '')
        .map((row) => row.id);
      expect(eligibleIds.filter((id) => !assigned.has(id)).length, size).toBeGreaterThan(0);
    }
  });

  it('places every session after the measurement start and gives every fifth id two staff', () => {
    const fixture = buildFixture({ size: 'representative', startDate: '2026-10-05' });
    const sessions = fixture.tabs.Sessions ?? [];
    expect(nextMonday('2026-10-05')).toBe('2026-10-12');
    expect(fixture.sessionStart).toBe('2026-10-12');
    for (const session of sessions) expect(String(session.date) >= fixture.sessionStart, String(session.id)).toBe(true);
    const twoStaff = sessions.filter((session) => session.requiredStaffCount === 2);
    expect(twoStaff.map((session) => session.id)).toEqual(['session-005', 'session-010', 'session-015', 'session-020']);
  });

  it('gives every row a unique id within its tab and one short volunteer row', () => {
    const fixture = buildFixture({ size: 'representative', startDate: '2026-10-05' });
    for (const [tab, rows] of Object.entries(fixture.tabs)) {
      if (tab === 'SchedulingRuns' || tab === 'Users') continue;
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size, tab).toBe(ids.length);
    }
    // The read path's padding case: one volunteer with genuinely blank trailing cells.
    const short = (fixture.tabs.Volunteers ?? []).filter((row) => row.source === '' && row.updatedAt === '');
    expect(short).toHaveLength(1);
  });

  it('is deterministic for the same options', () => {
    const first = buildFixture({ size: 'representative', startDate: '2026-10-05' });
    const second = buildFixture({ size: 'representative', startDate: '2026-10-05' });
    expect(JSON.stringify(second.tabs)).toBe(JSON.stringify(first.tabs));
    expect(FIXTURE_REVISIONS).toEqual({ dataRevision: 42, schedulingInputRevision: 5, schedulingOutputRevision: 7, tabRevision: 1 });
  });

  it('records the four supplied accounts and the denial variants', () => {
    const fixture = buildFixture({ size: 'representative', startDate: '2026-10-05' });
    expect(Object.values(fixture.accounts).sort()).toEqual([
      '101dimensional@gmail.com',
      'manbob928@gmail.com',
      'tcai5958@terpmail.umd.edu',
      'timothyc2371@gmail.com'
    ].sort());
    const users = fixture.tabs.Users ?? [];
    expect(users).toHaveLength(4);
    expect(users.find((row) => row.id === 'synthetic-user-admin')?.email).toBe('tcai5958@terpmail.umd.edu');
    expect(users.find((row) => row.id === 'synthetic-user-multi')?.roles).toEqual(['administrator', 'volunteer', 'center-contact']);
    expect(DENIAL_VARIANTS.map((variant) => variant.name)).toEqual(['blank-active', 'inactive', 'no-row']);
  });
});

describe('staging fixture loader', () => {
  it('refuses to write without an explicit confirmation', () => {
    const result = runLoader(['--spreadsheet', '1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w', '--size', 'representative', '--start-date', '2026-10-05']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to write');
    expect(result.stdout).toContain('"expectedCounts"');
  });

  it('prints the plan without writing when asked', () => {
    const result = runLoader(['--spreadsheet', '1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w', '--size', 'representative', '--start-date', '2026-10-05', '--plan']);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { size: string; writes: boolean; expectedCounts: Record<string, number> };
    expect(plan.size).toBe('representative');
    expect(plan.writes).toBe(true);
    expect(plan.expectedCounts.Volunteers).toBe(40);
  });

  it('refuses an implausible spreadsheet id, an unknown size and an unknown argument', () => {
    expect(runLoader(['--spreadsheet', 'short', '--size', 'representative']).stderr).toContain('spreadsheet id');
    expect(runLoader(['--spreadsheet', '1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w', '--size', 'huge']).stderr).toContain('--size must be');
    expect(runLoader(['--target', 'x']).stderr).toContain('Unknown argument');
  });

  it('reports a missing or malformed loader key instead of attempting a write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'staging-loader-'));
    try {
      const malformed = join(directory, 'key.json');
      await writeFile(malformed, '{"client_email":"x@example.test"}', 'utf8');
      const result = runLoader(['--spreadsheet', '1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w', '--size', 'representative', '--start-date', '2026-10-05', '--key', malformed, '--confirm-staging']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('client_email or private_key');
      const absent = runLoader(['--spreadsheet', '1QPRWcAhsyy1s032Sj4_kS4hVra9rajph21AKkNu_D0w', '--size', 'representative', '--start-date', '2026-10-05', '--key', join(directory, 'nope.json'), '--confirm-staging']);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain('could not be read');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
