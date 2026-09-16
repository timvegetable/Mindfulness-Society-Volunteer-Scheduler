import type { Assignment, Volunteer, Weekday } from '../../shared/domain.js';

/** The three revisions that define one consistent insight calculation. */
export type InsightSourceRevision = {
  /** Revision of the schedule whose assignments were considered. */
  assignmentRevision: number;
  /** Revision of volunteer lifecycle, interview, and rank data. */
  eligibilityRevision: number;
  /** Revision of recurring availability data. */
  availabilityRevision: number;
};

export type InsightRevisionChange = keyof InsightSourceRevision;

export type InsightConfig = {
  timeZone: string;
  incrementMinutes: number;
  /** Local start of the weekly grid. Defaults to DEFAULT_INSIGHT_CONFIG.startTime. */
  startTime?: string;
  /** Local exclusive end of the weekly grid. Defaults to DEFAULT_INSIGHT_CONFIG.endTime. */
  endTime?: string;
  /** Optional operating hours applied to every weekday. */
  operatingHours?: { start: string; end: string };
  /** Include zero-count cells when a complete calendar grid is needed. */
  includeEmpty?: boolean;
};
export type OverlapCell = {
  weekday: Weekday;
  start: string;
  end: string;
  timeZone: string;
  count: number;
  volunteerIds: string[];
};

export type InsightSnapshot = {
  volunteers: readonly Volunteer[];
  assignments: readonly Assignment[];
  sourceRevision: InsightSourceRevision;
  config: InsightConfig;
};

export type InsightDataset = {
  sourceRevision: InsightSourceRevision;
  generatedAt: string;
  stale: boolean;
  staleReasons: InsightRevisionChange[];
  leftoverVolunteers: Volunteer[];
  cells: OverlapCell[];
};

export type InsightProjectionCell = {
  weekday: Weekday;
  start: string;
  end: string;
  timeZone: string;
  count: number;
  volunteerIds: string[];
};

export type InsightProjection = {
  sourceRevision: InsightSourceRevision;
  generatedAt: string;
  stale: boolean;
  leftoverVolunteerCount: number;
  cells: InsightProjectionCell[];
};

export type InsightAdminProjectionCell = InsightProjectionCell & {
  volunteerNames: string[];
};

export type InsightAdminProjection = Omit<InsightProjection, 'cells'> & {
  cells: InsightAdminProjectionCell[];
  leftoverVolunteers: Array<{ id: string; name: string; readinessRank: 1 | 2 | 3 }>;
};

export type InsightRepository = {
  read(): InsightDataset | undefined;
  write(dataset: InsightDataset): void;
};

export type InsightClock = {
  now(): string;
};

export type InsightStoreDependencies = {
  repository?: InsightRepository;
  clock?: InsightClock;
};

export function cloneSourceRevision(value: InsightSourceRevision): InsightSourceRevision {
  return { ...value };
}

export function cloneCell(value: OverlapCell): OverlapCell {
  return { ...value, volunteerIds: [...value.volunteerIds] };
}

export function cloneDataset(value: InsightDataset): InsightDataset {
  return {
    sourceRevision: cloneSourceRevision(value.sourceRevision),
    generatedAt: value.generatedAt,
    stale: value.stale,
    staleReasons: [...value.staleReasons],
    leftoverVolunteers: value.leftoverVolunteers.map((volunteer) => ({ ...volunteer, recurringAvailability: volunteer.recurringAvailability.map((interval) => ({ ...interval })) })),
    cells: value.cells.map(cloneCell),
  };
}
