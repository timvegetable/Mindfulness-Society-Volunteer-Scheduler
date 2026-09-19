import { describe, expect, it } from 'vitest';
import { ApiClientError } from './api.js';
import {
  actionFailureMessage,
  candidateStateLabel,
  formatClock,
  formatDate,
  formatInstant,
  formatRange,
  futureAssignments,
  sessionLabel
} from './format.js';

describe('canonical date, clock, range, and instant formatting', () => {
  it('renders a canonical workbook date without shifting it across time zones', () => {
    expect(formatDate('2026-09-04')).toBe('Fri, Sep 4, 2026');
    expect(formatDate('2026-01-01')).toBe('Thu, Jan 1, 2026');
  });

  it('renders a canonical clock as a readable time of day', () => {
    expect(formatClock('09:32')).toBe('9:32 AM');
    expect(formatClock('17:00')).toBe('5:00 PM');
    expect(formatClock('00:00')).toBe('12:00 AM');
    expect(formatClock('12:00')).toBe('12:00 PM');
  });

  it('renders a range from two clocks', () => {
    expect(formatRange('09:32', '10:02')).toBe('9:32 AM–10:02 AM');
    expect(formatRange('17:00', '21:00')).toBe('5:00 PM–9:00 PM');
  });

  it('renders an ISO instant in the requested time zone', () => {
    expect(formatInstant('2026-09-19T18:04:05.000Z')).toBe('Sep 19, 2026, 6:04 PM');
    expect(formatInstant('2026-09-19T18:04:05.000Z', 'America/New_York')).toBe('Sep 19, 2026, 2:04 PM');
  });

  it('passes an unrecognized value through instead of throwing', () => {
    expect(formatDate('09/04/2026')).toBe('09/04/2026');
    expect(formatDate('2026-02-31')).toBe('2026-02-31');
    expect(formatClock('9:32 AM')).toBe('9:32 AM');
    expect(formatClock('25:00')).toBe('25:00');
    expect(formatInstant('not-an-instant')).toBe('not-an-instant');
  });
});

describe('session labels', () => {
  it('prefers the server display name and falls back to the title, center, then kind', () => {
    expect(sessionLabel({ displayName: 'Cottonwood Center', title: 'UNIV100 class', center: 'center-a', kind: 'univ100' })).toBe('Cottonwood Center');
    expect(sessionLabel({ title: 'UNIV100 class', kind: 'univ100' })).toBe('UNIV100 class');
    expect(sessionLabel({ center: 'center-a' })).toBe('center-a');
    expect(sessionLabel({ kind: 'univ100' })).toBe('UNIV100 class');
    expect(sessionLabel({ kind: 'open-lab' })).toBe('open-lab');
  });

  it('reports nothing to name when the server supplied nothing', () => {
    expect(sessionLabel({})).toBeUndefined();
    expect(sessionLabel({ displayName: '   ', title: '' })).toBeUndefined();
  });
});

describe('future assignments', () => {
  it('hides cancelled occurrences and keeps the rest in order', () => {
    const assignments = [
      { id: 'kept', status: 'assigned' },
      { id: 'cancelled', status: 'cancelled' },
      { id: 'no-status' },
      { id: 'canceled', status: 'CANCELLED' }
    ];
    expect(futureAssignments(assignments).map((assignment) => assignment.id)).toEqual(['kept', 'no-status']);
  });
});

describe('candidate state labels', () => {
  it('maps a stored state to its readable label, leaving other text alone', () => {
    expect(candidateStateLabel('draft')).toBe('Draft');
    expect(candidateStateLabel('submitted')).toBe('Submitted');
    expect(candidateStateLabel('confirmed')).toBe('Confirmed');
    expect(candidateStateLabel('rejected')).toBe('Rejected');
    expect(candidateStateLabel('cancelled')).toBe('Cancelled');
    expect(candidateStateLabel('Candidate coverage')).toBe('Candidate coverage');
    expect(candidateStateLabel(undefined)).toBeUndefined();
  });
});

describe('action feedback for structured errors', () => {
  it('keeps shortfall counts and the current revision visible', () => {
    const error = new ApiClientError('CONFLICT', 'Candidate coverage is insufficient.', {
      details: { requiredStaffCount: 2, matchingVolunteerCount: 1, shortfall: 1, currentRevision: 42 }
    });
    expect(actionFailureMessage(error)).toBe('Candidate coverage is insufficient. (required 2, matching 1, shortfall 1, current revision 42)');
  });

  it('never reveals the volunteer identities carried in error details', () => {
    const error = new ApiClientError('CONFLICT', 'Candidate coverage is insufficient.', {
      details: { shortfall: 1, coverage: { rankedVolunteers: [{ name: 'Robin Volunteer', email: 'robin@example.test' }] } }
    });
    const message = actionFailureMessage(error);
    expect(message).toBe('Candidate coverage is insufficient. (shortfall 1)');
    expect(message).not.toContain('Robin');
    expect(message).not.toContain('robin@example.test');
  });

  it('falls back to the plain message for a failure without numeric details', () => {
    expect(actionFailureMessage(new Error('Saved nothing.'))).toBe('Saved nothing.');
    expect(actionFailureMessage(undefined)).toBe('The action could not be completed.');
    expect(actionFailureMessage(new ApiClientError('CONFLICT', 'Nope.', { details: { candidateId: 'candidate-1' } }))).toBe('Nope.');
  });
});
