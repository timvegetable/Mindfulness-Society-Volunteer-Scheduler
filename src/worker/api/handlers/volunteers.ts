import { Effect } from 'effect';
import type { PayloadOf } from '../../../shared/api/schemas';
import { isEmailAddress } from '../../../shared/domain/email';
import { normalizeImportEmail, savedMappingFor } from '../../../shared/imports/whenIsGood';
import { accountEmailKey } from '../authorization';
import { fail, type HandlerContext } from './context';

export function updateVolunteerDetails(ctx: HandlerContext, input: PayloadOf<'admin.volunteer.update'>) {
  return Effect.gen(function* () {
    const volunteer = ctx.state.volunteers.find((row) => row.id === input.volunteerId);
    if (!volunteer) return yield* fail('NOT_FOUND', 'Volunteer not found.');
    if (!input.name) return yield* fail('INVALID_REQUEST', 'Enter the volunteer’s name.');
    if (!isEmailAddress(input.email)) return yield* fail('INVALID_REQUEST', 'Enter a valid email address.');
    // Synchronization matches participants by this normalized email; a shared one would be ambiguous.
    const email = normalizeImportEmail(input.email);
    if (ctx.state.volunteers.some((row) => row.id !== volunteer.id && normalizeImportEmail(row.email) === email)) return yield* fail('CONFLICT', 'Another volunteer already uses this email.');
    // A saved roster link outranks email matching, so it must not send this email's submissions elsewhere.
    const saved = ctx.state.synchronizations[0]?.participants ?? [];
    const withEmail = saved.filter((row) => normalizeImportEmail(row.email) === email);
    const candidates = withEmail.length ? withEmail : [{ id: '', name: '', email, intervals: [] }];
    const peers = withEmail.length ? saved : [...saved, ...candidates];
    if (candidates.some((row) => { const mapping = savedMappingFor(row, peers, ctx.state.importMappings); return !!mapping && mapping.volunteerId !== volunteer.id; })) return yield* fail('CONFLICT', 'A saved roster link sends this email to another volunteer.');
    const accounts = ctx.state.users.filter((row) => row.volunteerId === volunteer.id);
    if (accounts.length && ctx.state.users.some((row) => row.volunteerId !== volunteer.id && accountEmailKey(row.email) === accountEmailKey(input.email))) return yield* fail('CONFLICT', 'Another sign-in account already uses this email.');
    Object.assign(volunteer, { name: input.name, email: input.email, updatedAt: ctx.now.toISOString() });
    for (const account of accounts) account.email = input.email;
    return { volunteer };
  });
}

// Removal never deletes: an inactive volunteer leaves future scheduling while past output and links stay intact.
export function removeVolunteer(ctx: HandlerContext, input: PayloadOf<'admin.volunteer.remove'>) {
  return Effect.gen(function* () {
    const volunteer = ctx.state.volunteers.find((row) => row.id === input.volunteerId);
    if (!volunteer) return yield* fail('NOT_FOUND', 'Volunteer not found.');
    if (volunteer.lifecycleStatus === 'inactive') return yield* fail('CONFLICT', 'This volunteer is already inactive.');
    Object.assign(volunteer, { lifecycleStatus: 'inactive', updatedAt: ctx.now.toISOString() });
    return { volunteer };
  });
}
