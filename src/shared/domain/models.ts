export type Role = 'volunteer' | 'center-contact' | 'administrator';
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface Interval { start: string; end: string }
export interface WeeklyInterval extends Interval { weekday: Weekday; timeZone: string }
export interface Center { id: string; name: string; active: boolean; createdAt?: string | null; updatedAt?: string | null }
export interface Volunteer {
  id: string; name: string; email: string;
  lifecycleStatus: 'active' | 'newly-joined' | 'inactive' | 'graduated';
  interviewStatus: 'complete' | 'incomplete'; readinessRank: number | null;
  source?: string | null; createdAt?: string | null; updatedAt?: string | null;
}
export interface User { id: string; email: string; roles: Role[]; volunteerId: string | null; centerIds: string[]; active: boolean }
export interface RecurringInterval extends WeeklyInterval { id: string; volunteerId: string; source?: string | null; updatedAt?: string | null }
export interface AvailabilityException extends Interval {
  id: string; volunteerId: string; date: string; kind: 'available' | 'unavailable'; timeZone: string;
  reason?: string | null; updatedAt?: string | null;
}
export interface Candidate extends WeeklyInterval {
  id: string; centerId: string; requestedStaffCount: number; status: 'candidate' | 'confirmed' | 'cancelled';
  createdBy?: string | null; createdAt?: string | null; updatedAt?: string | null;
}
export interface Session extends Interval {
  id: string; kind: 'center' | 'univ100'; centerId: string | null; title: string; date: string; timeZone: string;
  requiredStaffCount: number; status: 'locked' | 'proposed' | 'confirmed' | 'cancelled'; sourceCandidateId?: string | null;
  createdAt?: string | null; updatedAt?: string | null;
}
export interface Assignment {
  id: string; sessionId: string; volunteerId: string; scheduleRevision: number; status: 'assigned' | 'cancelled';
  createdAt?: string | null; cancelledAt?: string | null; cancellationReason?: string | null;
}
export interface Backup { id: string; sessionId: string; volunteerId: string; scheduleRevision: number; position: number; status: 'available' | 'promoted' | 'skipped' }
export interface Shortfall { sessionId: string; required: number; assigned: number; missing: number }
export interface SchedulingRun {
  id: string; inputRevision: number; outputRevision: number; status: 'staged' | 'completed' | 'failed';
  startedAt?: string | null; completedAt?: string | null; assignmentIds: string[]; backupIds: string[]; shortfalls: Shortfall[]; diagnostic?: string | null;
}
export interface ImportParticipant { id: string; name: string; email: string | null; intervals: WeeklyInterval[] }
export interface StagedParticipant extends ImportParticipant { volunteerId: string | null }
export interface ImportRun {
  id: string; source: string; contentHash: string; status: 'staged' | 'completed' | 'failed';
  startedAt?: string | null; completedAt?: string | null; actorId?: string | null; resultId?: string | null;
  participantCount?: number | null; matchedCount?: number | null; unmatched: ImportParticipant[];
  stagedAvailability: StagedParticipant[]; diagnostic?: string | null; promotedAt?: string | null; promotedBy?: string | null;
}
export interface ImportMapping {
  id: string; source: string; sourceParticipantId?: string | null; sourceEmail?: string | null; sourceName?: string | null;
  volunteerId: string; createdAt?: string | null; updatedAt?: string | null; updatedBy?: string | null;
}
export interface ImportedAvailability extends WeeklyInterval {
  id: string; volunteerId: string; sourceParticipantId?: string | null; source?: string | null; importedAt?: string | null; importRunId?: string | null;
}
export interface Snapshot {
  centers: Center[]; volunteers: Volunteer[]; users: User[]; recurringAvailability: RecurringInterval[];
  availabilityExceptions: AvailabilityException[]; candidateSchedules: Candidate[]; sessions: Session[];
  schedulingRuns: SchedulingRun[]; assignments: Assignment[]; backups: Backup[]; imports: ImportRun[];
  importMappings: ImportMapping[]; importedAvailability: ImportedAvailability[];
  dataRevision: number; schedulingInputRevision: number;
}
export interface ProposedAssignment { sessionId: string; volunteerId: string }
export interface ProposedBackup extends ProposedAssignment { position: number }
export interface ScheduleOutput { assignments: ProposedAssignment[]; backups: ProposedBackup[]; shortfalls: Shortfall[] }
export interface Coverage { volunteers: Volunteer[]; requestedCount: number; shortfall: number }
export interface CandidateWithCoverage { candidate: Candidate; coverage: Coverage }
export interface GridCell extends Interval { weekday: Weekday; volunteers: Volunteer[]; count: number }
export interface Insights { leftoverVolunteers: Volunteer[]; grid: GridCell[] }
export function emptySnapshot(): Snapshot {
  return { centers: [], volunteers: [], users: [], recurringAvailability: [], availabilityExceptions: [], candidateSchedules: [], sessions: [], schedulingRuns: [], assignments: [], backups: [], imports: [], importMappings: [], importedAvailability: [], dataRevision: 0, schedulingInputRevision: 0 };
}
