import type { WorkbookTab } from './schema.js';

/** Whole-tab projections used by the two measured read operations. */
export const READ_PLANS = {
  publishedSchedule: ['Users', 'SchedulingRuns', 'Assignments', 'Backups', 'Sessions', 'Volunteers', 'Centers'],
  insightCacheHit: ['Users', 'SchedulingRuns'],
  insightCacheMiss: ['Users', 'SchedulingRuns', 'Volunteers', 'RecurringAvailability', 'Assignments']
} as const satisfies Record<string, readonly WorkbookTab['name'][]>;
