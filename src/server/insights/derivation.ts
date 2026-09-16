import { isRankEligible } from '../../shared/domain.js';
import type { Assignment, Volunteer } from '../../shared/domain.js';
import type { InsightSnapshot } from './types.js';

export type LeftoverDerivationInput = Pick<InsightSnapshot, 'volunteers' | 'assignments'> & {
  assignmentRevision?: number;
};

function cloneVolunteer(volunteer: Volunteer): Volunteer {
  return {
    ...volunteer,
    recurringAvailability: volunteer.recurringAvailability.map((interval) => ({ ...interval })),
  };
}

function isDerivationInput(value: readonly Volunteer[] | LeftoverDerivationInput): value is LeftoverDerivationInput {
  return !Array.isArray(value);
}

/**
 * Returns active, rank-eligible volunteers who are not assigned in the selected
 * schedule revision. Assignment status is considered as well as its revision so
 * cancelled rows never remove a volunteer from the leftover population.
 */
export function deriveLeftoverVolunteers(input: LeftoverDerivationInput): Volunteer[];
export function deriveLeftoverVolunteers(volunteers: readonly Volunteer[], assignments: readonly Assignment[], assignmentRevision?: number): Volunteer[];
export function deriveLeftoverVolunteers(
  inputOrVolunteers: readonly Volunteer[] | LeftoverDerivationInput,
  assignmentRows?: readonly Assignment[],
  selectedAssignmentRevision?: number,
): Volunteer[] {
  const volunteers = isDerivationInput(inputOrVolunteers) ? inputOrVolunteers.volunteers : inputOrVolunteers;
  const assignments = isDerivationInput(inputOrVolunteers) ? inputOrVolunteers.assignments : (assignmentRows ?? []);
  const assignmentRevision = isDerivationInput(inputOrVolunteers) ? inputOrVolunteers.assignmentRevision : selectedAssignmentRevision;

  const assignedVolunteerIds = new Set(
    assignments
      .filter((assignment) => assignment.status === 'assigned')
      .filter((assignment) => assignmentRevision === undefined || assignment.scheduleRevision === assignmentRevision)
      .map((assignment) => assignment.volunteerId),
  );

  const seenVolunteerIds = new Set<string>();
  return volunteers
    .filter((volunteer) => {
      if (seenVolunteerIds.has(volunteer.id)) return false;
      seenVolunteerIds.add(volunteer.id);
      return isRankEligible(volunteer) && !assignedVolunteerIds.has(volunteer.id);
    })
    .map(cloneVolunteer);
}
