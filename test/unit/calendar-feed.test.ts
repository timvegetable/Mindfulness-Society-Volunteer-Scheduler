import { it, expect } from 'vitest';
import { emptySnapshot } from '../../src/shared/domain/models';
import { serializeCalendarFeed } from '../../src/shared/domain/calendar-feed';

it('publishes only this volunteer’s current future assignments at the correct local time', async () => {
  const snapshot = emptySnapshot();
  snapshot.centers = [{ id: 'center-1', name: 'North Center', active: true }];
  snapshot.sessions = [
    { id: 'session-current', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-11-01', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' },
    { id: 'session-other', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-11-02', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' },
    { id: 'session-cancelled', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-11-03', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'cancelled' },
    { id: 'session-past', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-10-30', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' },
  ];
  snapshot.schedulingRuns = [
    { id: 'published', inputRevision: 1, outputRevision: 4, status: 'completed', assignmentIds: [], backupIds: [], shortfalls: [] },
    { id: 'preview', inputRevision: 2, outputRevision: 5, status: 'staged', assignmentIds: [], backupIds: [], shortfalls: [] },
  ];
  snapshot.assignments = [
    { id: 'current-owner', sessionId: 'session-current', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'assigned' },
    { id: 'other-owner', sessionId: 'session-other', volunteerId: 'volunteer-2', scheduleRevision: 4, status: 'assigned' },
    { id: 'cancelled-session', sessionId: 'session-cancelled', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'assigned' },
    { id: 'past-assignment', sessionId: 'session-past', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'assigned' },
    { id: 'preview-only', sessionId: 'session-other', volunteerId: 'volunteer-1', scheduleRevision: 5, status: 'assigned' },
    { id: 'cancelled-assignment', sessionId: 'session-other', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'cancelled', cancellationReason: 'private reason' },
  ];
  snapshot.backups = [{ id: 'backup-only', sessionId: 'session-current', volunteerId: 'volunteer-1', scheduleRevision: 4, position: 1, status: 'available' }];
  snapshot.dataRevision = 8;

  const feed = await serializeCalendarFeed(snapshot, 'volunteer-1', new Date('2026-10-31T12:00:00.000Z'));

  expect(feed).toContain('SUMMARY:North Center\r\n');
  expect(feed).not.toContain('METHOD:PUBLISH');
  expect(feed).toContain('DTSTART:20261101T150000Z\r\n');
  expect(feed).toContain('DTEND:20261101T160000Z\r\n');
  expect(feed).toContain('X-WR-TIMEZONE:America/New_York\r\n');
  expect(feed).not.toContain('session-other');
  expect(feed).not.toContain('private reason');
  expect(feed).not.toContain('volunteer-2');
  expect(feed).not.toContain('session-cancelled');
  expect(feed).not.toContain('session-past');
});

it('does not expose a backup position until the backup is promoted', async () => {
  const snapshot = emptySnapshot();
  snapshot.centers = [{ id: 'center-1', name: 'North Center', active: true }];
  snapshot.sessions = [{ id: 'session-1', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-11-01', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' }];
  snapshot.schedulingRuns = [{ id: 'published', inputRevision: 1, outputRevision: 4, status: 'completed', assignmentIds: [], backupIds: ['backup-1'], shortfalls: [] }];
  snapshot.backups = [{ id: 'backup-1', sessionId: 'session-1', volunteerId: 'volunteer-2', scheduleRevision: 4, position: 1, status: 'available' }];
  const now = new Date('2026-10-31T12:00:00.000Z');

  const beforePromotion = await serializeCalendarFeed(snapshot, 'volunteer-2', now);
  expect(beforePromotion).not.toContain('STATUS:CONFIRMED');

  snapshot.backups[0]!.status = 'promoted';
  snapshot.assignments.push({ id: 'promoted-assignment', sessionId: 'session-1', volunteerId: 'volunteer-2', scheduleRevision: 4, status: 'assigned' });
  const afterPromotion = await serializeCalendarFeed(snapshot, 'volunteer-2', now);
  expect(afterPromotion).toContain('STATUS:CONFIRMED\r\n');
  expect(afterPromotion).toContain('SUMMARY:North Center\r\n');
});

it('cancels the old volunteer event after cancellation and reassignment', async () => {
  const snapshot = emptySnapshot();
  snapshot.centers = [{ id: 'center-1', name: 'North Center', active: true }];
  snapshot.sessions = [{ id: 'session-1', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-11-01', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' }];
  snapshot.schedulingRuns = [{ id: 'published', inputRevision: 1, outputRevision: 4, status: 'completed', assignmentIds: ['assignment-1'], backupIds: [], shortfalls: [] }];
  snapshot.assignments = [{ id: 'assignment-1', sessionId: 'session-1', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'assigned' }];
  snapshot.dataRevision = 8;
  const now = new Date('2026-10-31T12:00:00.000Z');
  const before = await serializeCalendarFeed(snapshot, 'volunteer-1', now);
  const oldUid = before.match(/UID:([^\r\n]+)/)?.[1];

  snapshot.assignments[0]!.status = 'cancelled';
  snapshot.assignments.push({ id: 'assignment-2', sessionId: 'session-1', volunteerId: 'volunteer-2', scheduleRevision: 4, status: 'assigned' });
  snapshot.dataRevision++;
  const oldVolunteerFeed = await serializeCalendarFeed(snapshot, 'volunteer-1', now);
  const newVolunteerFeed = await serializeCalendarFeed(snapshot, 'volunteer-2', now);

  expect(oldUid).toBeTruthy();
  expect(oldVolunteerFeed).toContain(`UID:${oldUid}\r\n`);
  expect(oldVolunteerFeed).toContain('STATUS:CANCELLED\r\n');
  expect(oldVolunteerFeed).toContain('DTSTART:20261101T150000Z\r\n');
  expect(oldVolunteerFeed).toContain('DTEND:20261101T160000Z\r\n');
  expect(oldVolunteerFeed).toContain('SUMMARY:North Center\r\n');
  expect(oldVolunteerFeed).toContain('SEQUENCE:9\r\n');
  expect(newVolunteerFeed).toContain('STATUS:CONFIRMED\r\n');
  expect(newVolunteerFeed).not.toContain(`UID:${oldUid}\r\n`);
});

it('keeps the same event identifier when a republication changes session details', async () => {
  const snapshot = emptySnapshot();
  snapshot.centers = [{ id: 'center-1', name: 'North Center', active: true }];
  snapshot.sessions = [{ id: 'session-1', kind: 'center', centerId: 'center-1', title: 'North Center', date: '2026-11-01', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' }];
  snapshot.schedulingRuns = [{ id: 'published-1', inputRevision: 1, outputRevision: 4, status: 'completed', assignmentIds: ['assignment-1'], backupIds: [], shortfalls: [] }];
  snapshot.assignments = [{ id: 'assignment-1', sessionId: 'session-1', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'assigned' }];
  snapshot.dataRevision = 4;
  const before = await serializeCalendarFeed(snapshot, 'volunteer-1', new Date('2026-10-31T12:00:00.000Z'));
  const uid = before.match(/UID:([^\r\n]+)/)?.[1];

  snapshot.sessions[0]!.date = '2026-11-02';
  snapshot.sessions[0]!.start = '12:00';
  snapshot.sessions[0]!.end = '13:00';
  snapshot.centers[0]!.name = 'North Center Annex';
  snapshot.schedulingRuns.push({ id: 'published-2', inputRevision: 2, outputRevision: 8, status: 'completed', assignmentIds: ['assignment-1'], backupIds: [], shortfalls: [] });
  snapshot.assignments[0]!.scheduleRevision = 8;
  snapshot.dataRevision = 8;
  const after = await serializeCalendarFeed(snapshot, 'volunteer-1', new Date('2026-10-31T12:00:00.000Z'));

  expect(uid).toBeTruthy();
  expect(after).toContain(`UID:${uid}\r\n`);
  expect(after).toContain('SEQUENCE:8\r\n');
  expect(after).toContain('SUMMARY:North Center Annex\r\n');
  expect(after).toContain('DTSTART:20261102T170000Z\r\n');
  expect(after).toContain('DTEND:20261102T180000Z\r\n');
});

it('escapes calendar text and folds content lines at UTF-8 octet boundaries', async () => {
  const snapshot = emptySnapshot();
  snapshot.centers = [{ id: 'center-1', name: `East, Hall; Wing\\ Back\n${'Mindful café '.repeat(8)}`, active: true }];
  snapshot.sessions = [{ id: 'session-1', kind: 'center', centerId: 'center-1', title: 'unused', date: '2026-11-01', start: '10:00', end: '11:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked' }];
  snapshot.schedulingRuns = [{ id: 'published', inputRevision: 1, outputRevision: 4, status: 'completed', assignmentIds: [], backupIds: [], shortfalls: [] }];
  snapshot.assignments = [{ id: 'assignment-1', sessionId: 'session-1', volunteerId: 'volunteer-1', scheduleRevision: 4, status: 'assigned' }];
  const feed = await serializeCalendarFeed(snapshot, 'volunteer-1', new Date('2026-10-31T12:00:00.000Z'));
  const physicalLines = feed.split('\r\n');
  const unfolded = physicalLines.reduce<string[]>((lines, line) => {
    if (line.startsWith(' ') && lines.length) lines[lines.length - 1] += line.slice(1);
    else if (line) lines.push(line);
    return lines;
  }, []);

  expect(feed).not.toMatch(/(?<!\r)\n/);
  expect(physicalLines.filter(Boolean).every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
  expect(unfolded).toContain(`SUMMARY:East\\, Hall\\; Wing\\\\ Back\\n${'Mindful café '.repeat(8)}`);
});
