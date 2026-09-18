import { describe, expect, it } from 'vitest';
import { runtimeListField } from '../main.js';
import { importRunCodec, sessionCodec, volunteerCodec } from './codecs.js';

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
  });
});
