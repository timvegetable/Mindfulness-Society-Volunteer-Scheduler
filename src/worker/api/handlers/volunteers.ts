import { Effect } from 'effect';
import type { PayloadOf } from '../../../shared/api/schemas';
import { isEmailAddress } from '../../../shared/domain/email';
import { normalizeImportEmail, savedMappingFor } from '../../../shared/imports/whenIsGood';
import type { Volunteer, VolunteerChange, VolunteerChangeCursor } from '../../../shared/domain/models';
import { Database } from '../../services/Database';
import { IdGenerator } from '../../services/IdGenerator';
import { accountEmailKey } from '../authorization';
import { fail, type HandlerContext } from './context';

/** The name and email rules for a volunteer record, shared by add and edit. Fails with the first rule broken. */
function checkVolunteerDetails(ctx: HandlerContext, volunteerId: string, input: { name: string; email: string }) {
  return Effect.gen(function* () {
    if (!input.name) return yield* fail('INVALID_REQUEST', 'Enter the volunteer’s name.');
    if (!isEmailAddress(input.email)) return yield* fail('INVALID_REQUEST', 'Enter a valid email address.');
    // Synchronization matches participants by this normalized email; a shared one would be ambiguous.
    const email = normalizeImportEmail(input.email);
    if (ctx.state.volunteers.some((row) => row.id !== volunteerId && normalizeImportEmail(row.email) === email)) return yield* fail('CONFLICT', 'Another volunteer already uses this email.');
    // A saved roster link outranks email matching, so it must not send this email's submissions elsewhere.
    const saved = ctx.state.synchronizations[0]?.participants ?? [];
    const withEmail = saved.filter((row) => normalizeImportEmail(row.email) === email);
    const candidates = withEmail.length ? withEmail : [{ id: '', name: '', email, intervals: [] }];
    const peers = withEmail.length ? saved : [...saved, ...candidates];
    if (candidates.some((row) => { const mapping = savedMappingFor(row, peers, ctx.state.importMappings); return !!mapping && mapping.volunteerId !== volunteerId; })) return yield* fail('CONFLICT', 'A saved roster link sends this email to another volunteer.');
    const accounts = ctx.state.users.filter((row) => row.volunteerId === volunteerId);
    if (accounts.length && ctx.state.users.some((row) => row.volunteerId !== volunteerId && accountEmailKey(row.email) === accountEmailKey(input.email))) return yield* fail('CONFLICT', 'Another sign-in account already uses this email.');
    return accounts;
  });
}

/** A bounded page of the history, newest first, read separately from the snapshot so no operation loads it all. */
export const readVolunteerChanges = (before: VolunteerChangeCursor | null) =>
  Effect.gen(function* () { return yield* (yield* Database).readVolunteerChanges(before); });

const findVolunteer = (ctx: HandlerContext, volunteerId: string) => {
  const volunteer = ctx.state.volunteers.find((row) => row.id === volunteerId);
  return volunteer ? Effect.succeed(volunteer) : fail('NOT_FOUND', 'Volunteer not found.');
};

/** Collected on the context, so the commit path saves the entry in the same atomic batch as the change. */
function recordChange(ctx: HandlerContext, volunteer: Volunteer, kind: VolunteerChange['kind'], changedFields: VolunteerChange['changedFields']) {
  return Effect.gen(function* () {
    const id = yield* (yield* IdGenerator).next;
    ctx.volunteerChanges.push({ id, occurredAt: ctx.now.toISOString(), actorId: ctx.user.id, actorEmail: ctx.user.email, volunteerId: volunteer.id, volunteerName: volunteer.name, kind, changedFields });
  });
}

export function createVolunteer(ctx: HandlerContext, input: PayloadOf<'admin.volunteer.create'>) {
  return Effect.gen(function* () {
    const id = yield* (yield* IdGenerator).next;
    yield* checkVolunteerDetails(ctx, id, input);
    const timestamp = ctx.now.toISOString();
    const volunteer: Volunteer = { id, name: input.name, email: input.email, lifecycleStatus: 'newly-joined', interviewStatus: 'incomplete', readinessRank: null, source: 'admin', createdAt: timestamp, updatedAt: timestamp };
    ctx.state.volunteers.push(volunteer);
    yield* recordChange(ctx, volunteer, 'added', [{ field: 'name', before: null, after: volunteer.name }, { field: 'email', before: null, after: volunteer.email }, { field: 'status', before: null, after: volunteer.lifecycleStatus }]);
    return { volunteer };
  });
}

export function updateVolunteerDetails(ctx: HandlerContext, input: PayloadOf<'admin.volunteer.update'>) {
  return Effect.gen(function* () {
    const volunteer = yield* findVolunteer(ctx, input.volunteerId);
    const changedFields: VolunteerChange['changedFields'] = [];
    if (volunteer.name !== input.name) changedFields.push({ field: 'name', before: volunteer.name, after: input.name });
    if (volunteer.email !== input.email) changedFields.push({ field: 'email', before: volunteer.email, after: input.email });
    if (!changedFields.length) return yield* fail('INVALID_REQUEST', 'No changes to save.');
    const accounts = yield* checkVolunteerDetails(ctx, volunteer.id, input);
    Object.assign(volunteer, { name: input.name, email: input.email, updatedAt: ctx.now.toISOString() });
    yield* recordChange(ctx, volunteer, 'updated', changedFields);
    for (const account of accounts) account.email = input.email;
    return { volunteer };
  });
}

// Removal never deletes: an inactive volunteer leaves future scheduling while past output and links stay intact.
export function removeVolunteer(ctx: HandlerContext, input: PayloadOf<'admin.volunteer.remove'>) {
  return Effect.gen(function* () {
    const volunteer = yield* findVolunteer(ctx, input.volunteerId);
    if (volunteer.lifecycleStatus === 'inactive') return yield* fail('CONFLICT', 'This volunteer is already inactive.');
    const before = volunteer.lifecycleStatus;
    Object.assign(volunteer, { lifecycleStatus: 'inactive', updatedAt: ctx.now.toISOString() });
    yield* recordChange(ctx, volunteer, 'removed', [{ field: 'status', before, after: 'inactive' }]);
    return { volunteer };
  });
}
