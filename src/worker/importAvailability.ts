import { Effect } from 'effect';
import type { Snapshot, StagedParticipant } from '../shared/domain/models';
import { weeklyAvailabilityByVolunteer } from '../shared/imports/whenIsGood';
import { IdGenerator } from './services/IdGenerator';

/** One owner for WhenIsGood aggregation, replacement and per-participant provenance. */
export function applyImportedAvailability(state: Snapshot, input: {
  participants: StagedParticipant[]; runId: string; now: Date;
  replaceVolunteers: ReadonlySet<string>; recordVolunteers: ReadonlySet<string>;
}) {
  return Effect.gen(function* () {
    const ids = yield* IdGenerator;
    const timestamp = input.now.toISOString();
    for (const participant of input.participants) if (participant.volunteerId && input.recordVolunteers.has(participant.volunteerId)) {
      for (const interval of participant.intervals) state.importedAvailability.push({ ...interval, id: yield* ids.next,
        volunteerId: participant.volunteerId, sourceParticipantId: participant.id, source: 'whenIsGood', importedAt: timestamp, importRunId: input.runId });
    }
    state.recurringAvailability = state.recurringAvailability.filter(row => !input.replaceVolunteers.has(row.volunteerId));
    for (const [volunteerId, intervals] of weeklyAvailabilityByVolunteer(input.participants)) if (input.replaceVolunteers.has(volunteerId)) {
      for (const interval of intervals) state.recurringAvailability.push({ ...interval, id: yield* ids.next,
        volunteerId, source: 'whenIsGood', updatedAt: timestamp });
    }
  });
}
