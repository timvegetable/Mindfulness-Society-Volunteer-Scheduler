import { Effect } from 'effect';
import type { PayloadOf } from '../../../shared/api/schemas';
import { isEmailAddress } from '../../../shared/domain/email';
import { normalizeImportEmail } from '../../../shared/imports/whenIsGood';
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
    Object.assign(volunteer, { name: input.name, email: input.email, updatedAt: ctx.now.toISOString() });
    return { volunteer };
  });
}
