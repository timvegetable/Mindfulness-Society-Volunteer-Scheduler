import { Effect } from 'effect';
import { normalizeImportEmail } from '../../../shared/imports/whenIsGood';
import { fail, type HandlerContext } from './context';

export interface VolunteerDetailsInput { volunteerId: string; name: string; email: string }

export function updateVolunteerDetails(ctx: HandlerContext, input: VolunteerDetailsInput) {
  return Effect.gen(function* () {
    const volunteer = ctx.state.volunteers.find((row) => row.id === input.volunteerId);
    if (!volunteer) return yield* fail('NOT_FOUND', 'Volunteer not found.');
    if (!input.name) return yield* fail('INVALID_REQUEST', 'Enter the volunteer’s name.');
    // Same shape check as verified Google sign-in emails.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return yield* fail('INVALID_REQUEST', 'Enter a valid email address.');
    // Synchronization matches participants by this normalized email; a shared one would be ambiguous.
    const email = normalizeImportEmail(input.email);
    if (ctx.state.volunteers.some((row) => row.id !== volunteer.id && normalizeImportEmail(row.email) === email)) return yield* fail('CONFLICT', 'Another volunteer already uses this email.');
    Object.assign(volunteer, { name: input.name, email: input.email, updatedAt: ctx.now.toISOString() });
    return { volunteer };
  });
}
