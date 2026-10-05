import { Effect } from 'effect';
import type { ImportMapping, ImportRun, WeeklyInterval } from '../../../shared/domain/models';
import { normalizeWeeklyIntervals } from '../../../shared/domain/intervals';
import { parseWhenIsGood, stageParticipants } from '../../../shared/imports/whenIsGood';
import { WhenIsGoodClient } from '../../services/WhenIsGoodClient';
import { IdGenerator } from '../../services/IdGenerator';
import { AppError } from '../../../shared/api/errors';
import { fail, type HandlerContext } from './context';

function latestStaged(ctx: HandlerContext, applicable: (run: ImportRun) => boolean) {
  return ctx.state.imports.map((run, index) => ({ run, index }))
    .filter(({ run }) => run.source === 'whenIsGood' && run.status === 'staged' && applicable(run))
    .sort((a, b) => (b.run.startedAt ?? '').localeCompare(a.run.startedAt ?? '') || b.index - a.index)[0]?.run;
}

export function previewImport(ctx: HandlerContext, resultsCode: string) {
  return Effect.gen(function* () {
    const client = yield* WhenIsGoodClient;
    const ids = yield* IdGenerator;
    const fetched = yield* client.fetchResults(resultsCode).pipe(Effect.match({
      onFailure: () => ({ ok: false as const, error: 'Could not fetch the WhenIsGood results.' }),
      onSuccess: (html) => ({ ok: true as const, html }),
    }));
    let contentHash = '';
    let diagnostic: string | null = null;
    let participants = null;
    if (!fetched.ok) diagnostic = fetched.error;
    else {
      contentHash = yield* Effect.tryPromise({
        try: async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fetched.html))))
          .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        catch: () => new AppError('INTERNAL_ERROR', 'Could not hash import content.'),
      });
      const parsed = parseWhenIsGood(fetched.html, ctx.config.timeZone);
      if (parsed.ok) participants = parsed.participants;
      else diagnostic = parsed.error;
    }
    const staged = participants ? stageParticipants(participants, ctx.state.volunteers, ctx.state.importMappings) : { stagedAvailability: [], unmatched: [], matchedCount: 0 };
    const existing = latestStaged(ctx, (run) => run.resultId === resultsCode);
    // Reuse only the current representation for this code: promotion must target the preview just reviewed.
    if (existing && !diagnostic && existing.contentHash === contentHash
      && JSON.stringify(existing.stagedAvailability) === JSON.stringify(staged.stagedAvailability)) return { import: existing };
    const run: ImportRun = { id: yield* ids.next, source: 'whenIsGood', resultId: resultsCode, contentHash,
      status: diagnostic ? 'failed' : 'staged', actorId: ctx.user.id, startedAt: ctx.now.toISOString(),
      completedAt: ctx.now.toISOString(), participantCount: participants?.length ?? 0, ...staged, diagnostic };
    ctx.state.imports.push(run);
    return { import: run };
  });
}

type MappingInput = Pick<ImportMapping, 'volunteerId'> & { sourceParticipantId?: string; sourceEmail?: string; sourceName?: string };
export function upsertMapping(ctx: HandlerContext, input: MappingInput) {
  return Effect.gen(function* () {
    if (!ctx.state.volunteers.some((row) => row.id === input.volunteerId)) return yield* fail('NOT_FOUND', 'Volunteer not found.');
    const ids = yield* IdGenerator;
    const existing = ctx.state.importMappings.find((row) => row.source === 'whenIsGood' && (
      (input.sourceParticipantId && row.sourceParticipantId === input.sourceParticipantId)
      || (input.sourceEmail && row.sourceEmail?.toLowerCase() === input.sourceEmail.toLowerCase())
      || (input.sourceName && row.sourceName?.toLowerCase() === input.sourceName.toLowerCase())
    ));
    const mapping: ImportMapping = { ...existing, ...input, id: existing?.id ?? (yield* ids.next), source: 'whenIsGood',
      createdAt: existing?.createdAt ?? ctx.now.toISOString(), updatedAt: ctx.now.toISOString(), updatedBy: ctx.user.id };
    ctx.state.importMappings = [...ctx.state.importMappings.filter((row) => row.id !== mapping.id), mapping];
    const latest = latestStaged(ctx, (run) => run.stagedAvailability.some((participant) =>
      (input.sourceParticipantId && participant.id === input.sourceParticipantId)
      || (input.sourceEmail && participant.email?.toLowerCase() === input.sourceEmail.toLowerCase())
      || (input.sourceName && participant.name.toLowerCase() === input.sourceName.toLowerCase())));
    if (latest) {
      const participants = latest.stagedAvailability.map(({ volunteerId: _id, ...participant }) => participant);
      Object.assign(latest, stageParticipants(participants, ctx.state.volunteers, ctx.state.importMappings));
    }
    return { mapping };
  });
}

export function promoteImport(ctx: HandlerContext, resultsCode: string) {
  return Effect.gen(function* () {
    const run = latestStaged(ctx, (row) => row.resultId === resultsCode);
    if (!run) return yield* fail('NOT_FOUND', 'Preview this results code before promotion.');
    const ids = yield* IdGenerator;
    const byVolunteer = new Map<string, WeeklyInterval[]>();
    for (const participant of run.stagedAvailability) {
      if (!participant.volunteerId) continue;
      if (!ctx.state.volunteers.some((row) => row.id === participant.volunteerId)) return yield* fail('CONFLICT', 'A mapped volunteer no longer exists.');
      if (participant.intervals.some((row) => row.timeZone !== ctx.config.timeZone)) return yield* fail('CONFLICT', 'Import contains availability in another time zone.');
      byVolunteer.set(participant.volunteerId, [...(byVolunteer.get(participant.volunteerId) ?? []), ...participant.intervals]);
      for (const interval of participant.intervals) ctx.state.importedAvailability.push({ ...interval,
        id: yield* ids.next, volunteerId: participant.volunteerId, sourceParticipantId: participant.id,
        source: 'whenIsGood', importedAt: ctx.now.toISOString(), importRunId: run.id });
    }
    ctx.state.recurringAvailability = ctx.state.recurringAvailability.filter((row) => !byVolunteer.has(row.volunteerId));
    for (const [volunteerId, intervals] of byVolunteer) {
      for (const interval of normalizeWeeklyIntervals(intervals)) ctx.state.recurringAvailability.push({ ...interval,
        id: yield* ids.next, volunteerId, source: 'whenIsGood', updatedAt: ctx.now.toISOString() });
    }
    run.status = 'completed';
    run.promotedAt = ctx.now.toISOString();
    run.promotedBy = ctx.user.id;
    return { import: run };
  });
}
