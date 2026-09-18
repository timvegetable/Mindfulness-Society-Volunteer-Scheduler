import { describe, expect, it } from 'vitest';
import { applyMigrationPayload } from './loader.js';
import { InMemoryProperties, InMemorySpreadsheet } from './in-memory-sheet.js';

const volunteer = {
  id: 'volunteer@example.test', name: 'Example Volunteer', email: 'volunteer@example.test',
  lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1, recurringAvailability: [],
  revision: 0, source: 'roster.csv', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
};
const center = { id: 'center-a', name: 'Center A', active: true, revision: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' };
const session = {
  id: 'session-center-a-2026-09-18', kind: 'center', centerId: 'center-a', title: 'Center session: Center A',
  date: '2026-09-18', start: '09:00', end: '09:45', timeZone: 'America/New_York', requiredStaffCount: 1,
  status: 'locked', revision: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
};
const user = { id: 'volunteer@example.test', email: 'volunteer@example.test', roles: ['volunteer'], volunteerId: 'volunteer@example.test', active: true, revision: 0 };
const admin = { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator', 'center-contact'], centerIds: ['center-a'], active: true, revision: 0 };
const load = (payload: unknown, apply: boolean) => {
  const spreadsheet = new InMemorySpreadsheet();
  const report = applyMigrationPayload(spreadsheet, new InMemoryProperties(), payload, { apply });
  return { spreadsheet, report };
};
const dataRows = (spreadsheet: InMemorySpreadsheet, tab: string) => (spreadsheet.getSheetByName(tab)?.values.length ?? 0) - 1;

describe('migration loader', () => {
  it('writes every tab, records an audit entry, and re-runs without duplicating rows', () => {
    const spreadsheet = new InMemorySpreadsheet();
    const properties = new InMemoryProperties();
    const payload = { volunteers: [volunteer], centers: [center], sessions: [session], users: [user, admin] };

    const first = applyMigrationPayload(spreadsheet, properties, payload, { apply: true, actorId: 'admin@example.test' });
    expect(first.rejected).toEqual([]);
    expect(first.applied).toBe(true);
    expect(first.tables).toEqual([
      { tab: 'Volunteers', accepted: 1, written: 1, revision: 1 },
      { tab: 'Centers', accepted: 1, written: 1, revision: 1 },
      { tab: 'Sessions', accepted: 1, written: 1, revision: 1 },
      { tab: 'Users', accepted: 2, written: 2, revision: 1 }
    ]);
    expect(dataRows(spreadsheet, 'Volunteers')).toBe(1);
    expect(dataRows(spreadsheet, 'Sessions')).toBe(1);
    expect(dataRows(spreadsheet, 'Users')).toBe(2);
    expect(dataRows(spreadsheet, 'AuditLog')).toBe(4);
    expect(spreadsheet.getSheetByName('Volunteers')?.values[1]?.[0]).toBe('volunteer@example.test');
    expect(spreadsheet.getSheetByName('Sessions')?.values[1]?.[4]).toBe('2026-09-18');
    expect(JSON.parse(String(spreadsheet.getSheetByName('Users')?.values[2]?.[2]))).toEqual(['administrator', 'center-contact']);

    const second = applyMigrationPayload(spreadsheet, properties, payload, { apply: true, actorId: 'admin@example.test' });
    expect(second.applied).toBe(true);
    expect(dataRows(spreadsheet, 'Volunteers')).toBe(1);
    expect(dataRows(spreadsheet, 'Sessions')).toBe(1);
    expect(dataRows(spreadsheet, 'Users')).toBe(2);
    expect(second.tables.map((table) => table.revision)).toEqual([2, 2, 2, 2]);
  });

  it('refuses the whole load when one row is invalid, leaving the workbook untouched', () => {
    const spreadsheet = new InMemorySpreadsheet();
    const properties = new InMemoryProperties();
    const good = applyMigrationPayload(spreadsheet, properties, { volunteers: [volunteer], centers: [center], sessions: [session], users: [user] }, { apply: true });
    expect(good.applied).toBe(true);

    const bad = applyMigrationPayload(spreadsheet, properties, {
      volunteers: [volunteer, { ...volunteer, email: 'not-an-email' }],
      centers: [center],
      sessions: [session],
      users: [user]
    }, { apply: true });
    expect(bad.applied).toBe(false);
    expect(bad.rejected).toHaveLength(1);
    expect(bad.rejected[0]).toMatchObject({ tab: 'Volunteers', index: 1 });
    expect(bad.outcome).toContain('nothing was written');
    expect(dataRows(spreadsheet, 'Volunteers')).toBe(1);
    expect(dataRows(spreadsheet, 'AuditLog')).toBe(4);
  });

  it('rejects a center session that references an unknown center', () => {
    const { report } = load({ volunteers: [volunteer], centers: [center], sessions: [{ ...session, centerId: 'center-missing' }], users: [user] }, true);
    expect(report.applied).toBe(false);
    expect(report.rejected[0]?.issues[0]).toContain('unknown center center-missing');
  });

  it('rejects user rows whose record links do not resolve', () => {
    const unlinked = load({ volunteers: [volunteer], centers: [center], sessions: [session], users: [{ ...user, volunteerId: undefined }] }, true).report;
    expect(unlinked.applied).toBe(false);
    expect(unlinked.rejected[0]?.issues[0]).toContain('needs a linked volunteer record');

    const orphan = load({ volunteers: [volunteer], centers: [center], sessions: [session], users: [{ ...user, volunteerId: 'vol-missing' }] }, true).report;
    expect(orphan.rejected[0]?.issues[0]).toContain('unknown volunteer vol-missing');

    const wrongCenter = load({ volunteers: [volunteer], centers: [center], sessions: [session], users: [{ ...admin, centerIds: ['center-missing'] }] }, true).report;
    expect(wrongCenter.rejected[0]?.issues[0]).toContain('unknown center center-missing');
  });

  it('validates without writing when apply is false', () => {
    const { spreadsheet, report } = load({ volunteers: [volunteer], centers: [center], sessions: [session], users: [user] }, false);
    expect(report.applied).toBe(false);
    expect(report.tables.map((table) => [table.tab, table.written])).toEqual([['Volunteers', 0], ['Centers', 0], ['Sessions', 0], ['Users', 0]]);
    expect(dataRows(spreadsheet, 'Volunteers')).toBe(0);
  });

  it('refuses a payload with no users, since nobody could sign in', () => {
    const { report } = load({ volunteers: [volunteer], centers: [center], sessions: [session] }, true);
    expect(report.applied).toBe(false);
    expect(report.problems.join(' ')).toContain('no users');
  });

  it('rejects a payload that is not an object with row arrays', () => {
    const { report } = load('not-a-payload', true);
    expect(report.applied).toBe(false);
    expect(report.problems.join(' ')).toContain('payload');
  });
});
