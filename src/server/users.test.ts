import { describe, expect, it } from 'vitest';
import { usersFromSheet } from './main.js';
import { applyMigrationPayload } from './workbook/loader.js';
import { InMemoryProperties, InMemorySheet, InMemorySpreadsheet } from './workbook/in-memory-sheet.js';

const volunteer = {
  id: 'vol-abc12345', name: 'Example Volunteer', email: 'volunteer@example.test',
  lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1, recurringAvailability: [],
  revision: 0, source: 'roster.csv', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
};
const center = { id: 'center-a', name: 'Center A', active: true, revision: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' };
const session = {
  id: 'session-center-a-2026-09-18', kind: 'center', centerId: 'center-a', title: 'Center session: Center A',
  date: '2026-09-18', start: '09:00', end: '09:45', timeZone: 'America/New_York', requiredStaffCount: 1,
  status: 'locked', revision: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
};

/** Writes the three Users rows the reviewed migration actually produces. */
function loadedUsersSheet(): InMemorySheet {
  const spreadsheet = new InMemorySpreadsheet();
  applyMigrationPayload(spreadsheet, new InMemoryProperties(), {
    volunteers: [volunteer],
    centers: [center],
    sessions: [session],
    users: [
      { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator', 'center-contact'], centerIds: ['center-a'], active: true, revision: 0 },
      { id: 'second@example.test', email: 'second@example.test', roles: ['administrator'], active: true, revision: 0 },
      { id: 'volunteer@example.test', email: 'volunteer@example.test', roles: ['volunteer'], volunteerId: 'vol-abc12345', active: true, revision: 0 }
    ]
  }, { apply: true });
  const sheet = spreadsheet.getSheetByName('Users');
  if (!sheet) throw new Error('Users tab was not written');
  return sheet;
}

describe('Users authorization table', () => {
  it('loads every row, including users with no linked volunteer record', () => {
    const users = usersFromSheet(loadedUsersSheet());
    expect(users.map((user) => [user.email, user.roles.join('+'), user.volunteerId ?? '-'])).toEqual([
      ['admin@example.test', 'administrator+center-contact', '-'],
      ['second@example.test', 'administrator', '-'],
      ['volunteer@example.test', 'volunteer', 'vol-abc12345']
    ]);
    const contact = users[0];
    expect(contact?.centerIds).toEqual(['center-a']);
    expect(contact && 'volunteerId' in contact).toBe(false);
    expect(users.every((user) => user.active)).toBe(true);
    expect(users.every((user) => user.revision === 0)).toBe(true);
  });

  it('treats hand-edited blank cells as absent rather than invalid', () => {
    const sheet = new InMemorySheet('Users', ['id', 'email', 'roles', 'volunteerId', 'centerIds', 'active', 'revision']);
    sheet.appendRow(['a@example.test', 'a@example.test', 'administrator,center-contact', '', '', 'true', '0']);
    sheet.appendRow(['b@example.test', 'b@example.test', '["volunteer"]', '', '["center-a"]', 'TRUE', '3']);
    sheet.appendRow(['', '', '', '', '', '', '']);
    const users = usersFromSheet(sheet);
    expect(users.map((user) => [user.email, user.roles.join('+'), user.centerIds ?? []])).toEqual([
      ['a@example.test', 'administrator+center-contact', []],
      ['b@example.test', 'volunteer', ['center-a']]
    ]);
    expect(users[1]?.revision).toBe(3);
    expect(users[1]?.active).toBe(true);
  });

  it('defaults to no users when the tab is missing or empty', () => {
    expect(usersFromSheet(new InMemorySheet('Users', ['id', 'email', 'roles', 'volunteerId', 'centerIds', 'active', 'revision']))).toEqual([]);
  });
});
