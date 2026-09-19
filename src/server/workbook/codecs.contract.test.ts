import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { runtimeListField } from '../main.js';
import { candidateScheduleCodec } from '../centers/codecs.js';
import { availabilityExceptionCodec, importRunCodec, recurringAvailabilityCodec, sessionCodec, volunteerCodec } from './codecs.js';

describe('production workbook codecs', () => {
  it('round-trips roster and session rows without losing optional fields', () => {
    const volunteer = volunteerCodec.fromRow({
      id: 'vol-1', name: 'Example Volunteer', email: 'volunteer@example.test',
      lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1,
      revision: 4, source: 'reviewed-roster', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
    });
    expect(volunteer).toMatchObject({ id: 'vol-1', readinessRank: 1, recurringAvailability: [] });
    expect(volunteerCodec.toRow(volunteer)).toMatchObject({ id: 'vol-1', source: 'reviewed-roster' });

    const session = sessionCodec.fromRow({
      id: 'session-1', kind: 'center', centerId: 'center-1', title: 'Center session',
      date: '2026-09-18', start: '09:00', end: '09:45', timeZone: 'America/New_York',
      requiredStaffCount: 2, status: 'locked', sourceCandidateId: 'candidate-1', revision: 1
    });
    expect(session).toMatchObject({ id: 'session-1', centerId: 'center-1', sourceCandidateId: 'candidate-1' });
    expect(sessionCodec.toRow(session)).toMatchObject({ timeZone: 'America/New_York', requiredStaffCount: 2 });
  });

  // Sheets anchors a time-only cell to 1899-12-30 in the spreadsheet's zone, and
  // that date predates standard time, so decoding in a different zone shifts the
  // clock by a local-mean-time offset: Detroit's -05:32:11 reads as 09:32 in New
  // York. Decoding must therefore use the workbook zone.
  it('decodes a time-only cell in the workbook zone it was anchored in', () => {
    const detroit = (hour: number, minute: number) =>
      new Date(Temporal.ZonedDateTime.from({ timeZone: 'America/Detroit', year: 1899, month: 12, day: 30, hour, minute }).epochMilliseconds);

    const session = sessionCodec.fromRow(
      { id: 'session-1', kind: 'center', centerId: 'center-1', title: 'Center session', date: '2026-09-04', start: detroit(9, 0), end: detroit(9, 45), timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked', revision: 0 },
      { timeZone: 'America/Detroit' }
    );
    expect(session).toMatchObject({ date: '2026-09-04', start: '09:00', end: '09:45' });
    // The same cell read in the configured zone is where the 32-minute drift came from.
    expect(sessionCodec.fromRow({ ...sessionCodec.toRow(session), start: detroit(9, 0), end: detroit(9, 45) }, { timeZone: 'America/New_York' })).toMatchObject({ start: '09:32', end: '10:17' });
  });

  it('preserves Sessions tab audit stamps and optional identifiers across a round-trip', () => {
    const row = {
      id: 'session-1', kind: 'center', centerId: 'center-1', title: 'Center session',
      date: '2026-09-18', start: '09:00', end: '09:45', timeZone: 'America/New_York',
      requiredStaffCount: 1, status: 'locked', sourceCandidateId: 'candidate-1', revision: 0,
      createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
    };
    const session = sessionCodec.fromRow(row);
    expect(session).toEqual({
      id: 'session-1', kind: 'center', centerId: 'center-1', title: 'Center session',
      date: '2026-09-18', start: '09:00', end: '09:45', timeZone: 'America/New_York',
      requiredStaffCount: 1, status: 'locked', sourceCandidateId: 'candidate-1', revision: 0,
      createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
    });
    expect(sessionCodec.fromRow(sessionCodec.toRow(session))).toEqual(session);

    const blank = sessionCodec.fromRow({ ...sessionCodec.toRow(session), createdAt: '', updatedAt: '', sourceCandidateId: '', centerId: '', title: '' });
    expect(blank.createdAt).toBeUndefined();
    expect(blank.updatedAt).toBeUndefined();
    expect('sourceCandidateId' in blank).toBe(false);
    expect('centerId' in blank).toBe(false);
    expect('title' in blank).toBe(false);
  });

  it('persists staged import payloads as JSON workbook cells', () => {
    const run = importRunCodec.fromRow({
      id: 'import-1', source: 'whenisgood', contentHash: 'hash', status: 'staged',
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z',
      actorId: 'admin-1', resultId: 'result-1', participantCount: 1, matchedCount: 1,
      unmatched: '[]', stagedAvailability: JSON.stringify([{ id: 'availability-1', volunteerId: 'vol-1', sourceParticipantId: 'p-1', source: 'whenisgood', weekday: 1, start: '09:00', end: '09:45', timeZone: 'America/New_York', importedAt: '2026-01-01T00:01:00.000Z', importRunId: 'import-1' }]),
      diagnostic: '', promotedAt: '', promotedBy: ''
    });
    const row = importRunCodec.toRow(run);
    expect(JSON.parse(String(row.stagedAvailability))).toHaveLength(1);
    expect(run.stagedAvailability[0]?.volunteerId).toBe('vol-1');
  });

  it('loads JSON and comma-separated role fields', () => {
    expect(runtimeListField('["administrator","center-contact"]')).toEqual(['administrator', 'center-contact']);
    expect(runtimeListField('administrator, center-contact')).toEqual(['administrator', 'center-contact']);
    // A hand-edited cell with a stray entry must not drop the whole user row.
    expect(runtimeListField('["volunteer", 42, null]')).toEqual(['volunteer']);
    expect(runtimeListField('')).toEqual([]);
  });

  it('normalizes Sheet Date cells into canonical date, clock, and instant values', () => {
    const context = { timeZone: 'America/New_York' };
    const session = sessionCodec.fromRow({
      id: 'session-dated', kind: 'center', centerId: 'center-1',
      date: new Date('2026-09-04T04:00:00.000Z'),
      start: new Date('1899-12-30T14:32:00.000Z'),
      end: new Date('1899-12-30T22:00:00.000Z'),
      timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked', revision: 0,
      createdAt: new Date('2026-09-04T15:30:00.000Z')
    }, context);
    expect([session.date, session.start, session.end]).toEqual(['2026-09-04', '09:32', '17:00']);
    expect(session.createdAt).toBe('2026-09-04T15:30:00.000Z');

    const recurring = recurringAvailabilityCodec.fromRow({
      id: 'availability-1', volunteerId: 'vol-1', weekday: 5,
      start: new Date('1899-12-30T14:32:00.000Z'), end: 0.5,
      timeZone: 'America/New_York', revision: 2
    }, context);
    expect([recurring.start, recurring.end]).toEqual(['09:32', '12:00']);

    const exception = availabilityExceptionCodec.fromRow({
      id: 'exception-1', volunteerId: 'vol-1', date: new Date('2026-09-04T04:00:00.000Z'),
      kind: 'unavailable', start: '09:32', end: '17:00', timeZone: 'America/New_York', revision: 1
    }, context);
    expect(exception.date).toBe('2026-09-04');

    const candidate = candidateScheduleCodec.fromRow({
      id: 'candidate-1', centerId: 'center-1', weekday: 5,
      start: new Date('1899-12-30T14:00:00.000Z'), end: new Date('1899-12-30T22:30:00.000Z'),
      timeZone: 'America/New_York', requestedStaffCount: 2, status: 'confirmed',
      occurrenceDates: JSON.stringify(['2026-09-04']), createdBy: 'admin-1', revision: 3,
      createdAt: new Date('2026-08-01T12:00:00.000Z'), updatedAt: new Date('2026-08-02T12:00:00.000Z')
    }, context);
    expect([candidate.start, candidate.end, candidate.createdAt, candidate.occurrenceDates]).toEqual([
      '09:00', '17:30', '2026-08-01T12:00:00.000Z', ['2026-09-04']
    ]);
  });

  it('leaves unrecognized Sheet text unchanged so validation rejects it', () => {
    const session = sessionCodec.fromRow({
      id: 'session-text', kind: 'center', date: '09/04/2026', start: '9:32 AM', end: '5:00 PM',
      timeZone: 'America/New_York', requiredStaffCount: 1, status: 'locked', revision: 0
    });
    expect([session.date, session.start, session.end]).toEqual(['09/04/2026', '9:32 AM', '5:00 PM']);
  });
});
