import { emptySyncStatus, type ImportRun, type Snapshot, type Volunteer } from './models';

export function syncStatus(state: Pick<Snapshot, 'synchronizations'>) {
  const row = state.synchronizations[0];
  if (!row) return emptySyncStatus();
  const { id: _id, generation: _generation, checkId: _checkId, participants: _participants, pending: _pending, ...status } = row;
  return status;
}
export type ImportSummaryInput = Pick<ImportRun, 'id' | 'status' | 'startedAt' | 'actorId' | 'participantCount' | 'matchedCount'> & { stagedCount: number | null };
/** Legacy counts use the stored staged array length; interval contents are not part of this view. */
export function importHistorySummary(run: ImportSummaryInput) {
  return { id: run.id, status: run.status, startedAt: run.startedAt ?? null, actorId: run.actorId ?? null,
    participantCount: run.participantCount ?? run.stagedCount, matchedCount: run.matchedCount ?? 0 };
}
export function rosterOption(volunteer: Pick<Volunteer, 'id' | 'name' | 'email'>) {
  return { id: volunteer.id, name: volunteer.name, email: volunteer.email };
}
export function synchronizationView(state: Snapshot) {
  return { status: syncStatus(state), pending: state.synchronizations[0]?.pending ?? [],
    imports: state.imports.map(run => importHistorySummary({ ...run, stagedCount: run.stagedAvailability.length })),
    volunteers: state.volunteers.map(rosterOption) };
}
