import { describe, expect, it } from 'vitest';
import { effectiveIntervalsForDate, intervalContains, intervalsOverlap, normalizeIntervals } from './time.js';

describe('shared scheduling invariants', () => {
  it('normalizes adjacent and overlapping recurring intervals', () => {
    const result = normalizeIntervals([
      { start: '10:00', end: '11:00', timeZone: 'UTC' },
      { start: '09:00', end: '10:30', timeZone: 'UTC' },
      { start: '11:00', end: '12:00', timeZone: 'UTC' }
    ]);
    expect(result).toEqual([{ start: '09:00', end: '12:00', timeZone: 'UTC' }]);
  });

  it('applies dated exceptions only to their date and overlapping interval', () => {
    const recurring = [{ weekday: 2 as const, start: '09:00', end: '12:00', timeZone: 'UTC' }];
    const unavailable = { id: 'absence', volunteerId: 'v1', date: '2026-01-06', kind: 'unavailable' as const, interval: { start: '10:00', end: '11:00', timeZone: 'UTC' }, revision: 1 };
    expect(effectiveIntervalsForDate('2026-01-06', 'UTC', recurring, [unavailable])).toEqual([
      { start: '09:00', end: '10:00', timeZone: 'UTC' },
      { start: '11:00', end: '12:00', timeZone: 'UTC' }
    ]);
    expect(effectiveIntervalsForDate('2026-01-13', 'UTC', recurring, [unavailable])).toEqual([{ start: '09:00', end: '12:00', timeZone: 'UTC' }]);
  });

  it('compares interval boundaries as instants in the configured zone', () => {
    const left = { start: '01:30', end: '03:30', timeZone: 'America/New_York' };
    const right = { start: '03:00', end: '04:00', timeZone: 'America/New_York' };
    expect(intervalsOverlap(left, right, '2026-03-08')).toBe(true);
    expect(intervalContains({ start: '01:00', end: '04:00', timeZone: 'America/New_York' }, left, '2026-03-08')).toBe(true);
  });
});
