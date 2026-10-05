import { Effect } from 'effect';
import type { Candidate, Weekday } from '../../../shared/domain/models';
import { candidateCoverage, candidateSession, confirmedDateCoverage } from '../../../shared/domain/candidates';
import { sessionsOverlap } from '../../../shared/domain/availability';
import { validateInterval } from '../../../shared/domain/intervals';
import { IdGenerator } from '../../services/IdGenerator';
import { canUseCenter } from '../policies';
import { attempt, fail, type HandlerContext } from './context';

export interface CandidateInput {
  candidateId?: string; centerId?: string; weekday?: Weekday; start?: string; end?: string;
  timeZone?: string; requestedStaffCount?: number; status?: 'cancelled';
}

export function readCandidates(ctx: HandlerContext) {
  return {
    centers: ctx.state.centers.filter((center) => canUseCenter(ctx.user, center.id)),
    candidates: ctx.state.candidateSchedules.filter((candidate) => canUseCenter(ctx.user, candidate.centerId))
      .map((candidate) => ({ candidate, coverage: candidateCoverage(ctx.state, candidate) })),
  };
}

export function updateCandidate(ctx: HandlerContext, input: CandidateInput) {
  return Effect.gen(function* () {
    let candidate = input.candidateId ? ctx.state.candidateSchedules.find((row) => row.id === input.candidateId) : undefined;
    if (input.candidateId && !candidate) return yield* fail('NOT_FOUND', 'Candidate not found.');
    if (candidate && !canUseCenter(ctx.user, candidate.centerId)) return yield* fail('FORBIDDEN', 'This center is outside your account.');
    if (candidate && candidate.status !== 'candidate') return yield* fail('CONFLICT', 'Confirmed and cancelled candidates cannot be changed.');
    const centerId = input.centerId ?? candidate?.centerId;
    if (!centerId) return yield* fail('INVALID_REQUEST', 'Choose a center.');
    if (!canUseCenter(ctx.user, centerId)) return yield* fail('FORBIDDEN', 'This center is outside your account.');
    const center = ctx.state.centers.find((row) => row.id === centerId && row.active);
    if (!center) return yield* fail('NOT_FOUND', 'Active center not found.');
    if (input.timeZone && input.timeZone !== ctx.config.timeZone) return yield* fail('INVALID_REQUEST', 'Use the application time zone.');
    if (!candidate) {
      if (input.weekday === undefined || !input.start || !input.end || !input.timeZone || input.status) return yield* fail('INVALID_REQUEST', 'Provide weekday, start, end, and time zone for a new candidate.');
      const ids = yield* IdGenerator;
      candidate = { id: yield* ids.next, centerId, weekday: input.weekday, start: input.start, end: input.end,
        timeZone: ctx.config.timeZone, requestedStaffCount: input.requestedStaffCount ?? 1, status: 'candidate',
        createdBy: ctx.user.id, createdAt: ctx.now.toISOString(), updatedAt: ctx.now.toISOString() };
      ctx.state.candidateSchedules.push(candidate);
    } else {
      const { candidateId: _id, ...updates } = input;
      Object.assign(candidate, updates, { updatedAt: ctx.now.toISOString() });
    }
    yield* attempt(() => validateInterval(candidate));
    return { candidate, coverage: candidateCoverage(ctx.state, candidate) };
  });
}

export function confirmCandidate(ctx: HandlerContext, candidateId: string) {
  return Effect.gen(function* () {
    const candidate = ctx.state.candidateSchedules.find((row) => row.id === candidateId);
    if (!candidate) return yield* fail('NOT_FOUND', 'Candidate not found.');
    if (candidate.status !== 'candidate') return yield* fail('CONFLICT', 'Only an unconfirmed candidate can be confirmed.');
    const center = ctx.state.centers.find((row) => row.id === candidate.centerId && row.active);
    if (!center) return yield* fail('NOT_FOUND', 'Active center not found.');
    if (candidate.timeZone !== ctx.config.timeZone) return yield* fail('CONFLICT', 'Candidate uses a different application time zone.');
    const session = yield* attempt(() => candidateSession(candidate, center.name, ctx.now.toISOString()));
    if (ctx.state.sessions.some((row) => row.kind === 'center' && row.status === 'locked' && row.centerId === session.centerId && sessionsOverlap(row, session))) {
      return yield* fail('CONFLICT', 'A locked session already overlaps this center and time.');
    }
    if (confirmedDateCoverage(ctx.state, session).shortfall > 0) return yield* fail('CONFLICT', 'There are not enough available volunteers on the confirmation date.');
    if (ctx.state.sessions.some((row) => row.id === session.id)) return yield* fail('CONFLICT', 'This candidate already has a dated session.');
    candidate.status = 'confirmed';
    candidate.updatedAt = ctx.now.toISOString();
    ctx.state.sessions.push(session);
    return { candidate, session };
  });
}
