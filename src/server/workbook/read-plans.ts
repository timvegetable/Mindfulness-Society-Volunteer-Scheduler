import type { WorkbookTab } from './schema.js';

/** Whole-tab projections used by the two measured read operations. */
export const READ_PLANS = {
  publishedSchedule: ['Users', 'SchedulingRuns', 'Assignments', 'Backups', 'Sessions', 'Volunteers', 'Centers'],
  insightCacheHit: ['Users', 'SchedulingRuns'],
  insightCacheMiss: ['Users', 'SchedulingRuns', 'Volunteers', 'RecurringAvailability', 'Assignments'],
  /** Domain projection for the staging `admin.schedule.preview` benchmark: everything the preview derives from, in one batch, without Users (which stays on the authorization path). */
  schedulePreview: ['SchedulingRuns', 'Volunteers', 'RecurringAvailability', 'AvailabilityExceptions', 'Sessions', 'Assignments', 'Centers']
} as const satisfies Record<string, readonly WorkbookTab['name'][]>;
