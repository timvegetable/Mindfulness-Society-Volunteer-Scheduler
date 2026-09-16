import { recurringWeekdayIntervals } from '../../shared/time.js';
import type { Interval, Volunteer, Weekday } from '../../shared/domain.js';
import type { InsightConfig, OverlapCell } from './types.js';

export const DEFAULT_INSIGHT_CONFIG: Required<Pick<InsightConfig, 'timeZone' | 'incrementMinutes' | 'startTime' | 'endTime'>> = {
  timeZone: 'UTC',
  incrementMinutes: 30,
  startTime: '09:00',
  endTime: '17:00',
};

type OverlapInput = {
  volunteers: readonly Volunteer[];
  config?: Partial<InsightConfig>;
};

type LocalConfig = {
  timeZone: string;
  incrementMinutes: number;
  startTime: string;
  endTime: string;
  includeEmpty: boolean;
};

function isOverlapInput(value: readonly Volunteer[] | OverlapInput): value is OverlapInput {
  return !Array.isArray(value);
}
const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5];

function parseMinutes(value: string, label: string): number {
  if (value === '24:00') return 24 * 60;
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  if (!match) throw new Error(`${label} must be a local time in HH:mm format`);
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour * 60 + minute;
}

function formatMinutes(value: number): string {
  if (value === 24 * 60) return '24:00';
  const hour = Math.floor(value / 60).toString().padStart(2, '0');
  const minute = (value % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

function normalizeConfig(config: Partial<InsightConfig> | undefined): LocalConfig {
  const supplied = config ?? {};
  const operatingHours = supplied.operatingHours;
  const startTime = supplied.startTime ?? operatingHours?.start ?? DEFAULT_INSIGHT_CONFIG.startTime;
  const endTime = supplied.endTime ?? operatingHours?.end ?? DEFAULT_INSIGHT_CONFIG.endTime;
  const start = parseMinutes(startTime, 'startTime');
  const end = parseMinutes(endTime, 'endTime');
  const incrementMinutes = supplied.incrementMinutes ?? DEFAULT_INSIGHT_CONFIG.incrementMinutes;
  if (!Number.isInteger(incrementMinutes) || incrementMinutes <= 0 || incrementMinutes > 24 * 60) {
    throw new Error('incrementMinutes must be a positive integer no greater than 1440');
  }
  if (start >= end) throw new Error('startTime must be before endTime');
  const timeZone = supplied.timeZone ?? DEFAULT_INSIGHT_CONFIG.timeZone;
  if (timeZone.length === 0) throw new Error('timeZone is required');
  return { timeZone, incrementMinutes, startTime, endTime, includeEmpty: supplied.includeEmpty ?? false };
}

function sameVolunteerSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function mergeCells(cells: readonly OverlapCell[]): OverlapCell[] {
  const merged: OverlapCell[] = [];
  for (const cell of cells) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.weekday === cell.weekday &&
      previous.end === cell.start &&
      sameVolunteerSet(previous.volunteerIds, cell.volunteerIds)
    ) {
      previous.end = cell.end;
      continue;
    }
    merged.push({ ...cell, volunteerIds: [...cell.volunteerIds] });
  }
  return merged;
}

/**
 * Calculates Monday-Friday weekly overlap windows. A volunteer counts for a
 * slot only when their recurring interval covers the complete fixed increment;
 * this avoids presenting partial interval coverage as a full opportunity.
 * Adjacent slots are merged only when the sorted volunteer ID sets are equal.
 */
export function calculateOverlapCells(input: OverlapInput): OverlapCell[];
export function calculateOverlapCells(volunteers: readonly Volunteer[], config?: Partial<InsightConfig>): OverlapCell[];
export function calculateOverlapCells(
  inputOrVolunteers: readonly Volunteer[] | OverlapInput,
  suppliedConfig?: Partial<InsightConfig>,
): OverlapCell[] {
  const volunteers = isOverlapInput(inputOrVolunteers) ? inputOrVolunteers.volunteers : inputOrVolunteers;
  const config = normalizeConfig(isOverlapInput(inputOrVolunteers) ? inputOrVolunteers.config : suppliedConfig);
  const uniqueVolunteers = new Map<string, Volunteer>();
  for (const volunteer of volunteers) {
    if (!uniqueVolunteers.has(volunteer.id)) uniqueVolunteers.set(volunteer.id, volunteer);
  }
  const gridStart = parseMinutes(config.startTime, 'startTime');
  const gridEnd = parseMinutes(config.endTime, 'endTime');
  const allCells: OverlapCell[] = [];
  for (const weekday of WEEKDAYS) {
    const localCells: OverlapCell[] = [];
    const availability = new Map<string, Interval[]>();
    for (const [volunteerId, volunteer] of uniqueVolunteers) {
      availability.set(volunteerId, recurringWeekdayIntervals(volunteer.recurringAvailability, weekday, config.timeZone));
    }

    for (let slotStart = gridStart; slotStart < gridEnd; slotStart += config.incrementMinutes) {
      const volunteerIds: string[] = [];
      const slotEnd = Math.min(slotStart + config.incrementMinutes, gridEnd);
      for (const [volunteerId, intervals] of availability) {
        const covered = intervals.some((interval) => {
          const intervalStart = parseMinutes(interval.start, 'availability start');
          const intervalEnd = parseMinutes(interval.end, 'availability end');
          return intervalStart <= slotStart && intervalEnd >= slotEnd;
        });
        if (covered) volunteerIds.push(volunteerId);
      }
      volunteerIds.sort();
      if (config.includeEmpty || volunteerIds.length > 0) {
        localCells.push({ weekday, start: formatMinutes(slotStart), end: formatMinutes(slotEnd), timeZone: config.timeZone, count: volunteerIds.length, volunteerIds });
      }
    }
    allCells.push(...mergeCells(localCells));
  }
  return allCells;
}
