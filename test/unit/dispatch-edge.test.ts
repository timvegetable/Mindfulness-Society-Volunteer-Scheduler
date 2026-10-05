import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { dispatchResponse } from '../../src/worker/api/dispatch';
import { testConfig } from '../../src/worker/config';
import { AuthService } from '../../src/worker/services/AuthService';
import { Clock } from '../../src/worker/services/Clock';
import { Database, schedulingInputsChanged, type IdempotencyRecord } from '../../src/worker/services/Database';
import { EmailService } from '../../src/worker/services/EmailService';
import { IdGenerator } from '../../src/worker/services/IdGenerator';
import { WhenIsGoodClient } from '../../src/worker/services/WhenIsGoodClient';
import { AppError } from '../../src/shared/api/errors';
import { emptySnapshot } from '../../src/shared/domain/models';

const zone = 'America/New_York';
function harness() {
  let now = '2026-10-04T12:00:00.000Z';
  let state = { ...emptySnapshot(),
    users: [{ id: 'user', email: 'v@example.test', roles: ['volunteer' as const], volunteerId: 'v1', centerIds: [] as string[], active: true },
      { id: 'admin', email: 'admin@example.test', roles: ['administrator' as const], volunteerId: null, centerIds: [] as string[], active: true }],
    volunteers: [{ id: 'v1', name: 'Volunteer', email: 'v@example.test', lifecycleStatus: 'active' as const, interviewStatus: 'complete' as const, readinessRank: 1 }],
    recurringAvailability: [{ id: 'original', volunteerId: 'v1', weekday: 1 as const, start: '09:00', end: '12:00', timeZone: zone }],
  };
  const records: IdempotencyRecord[] = [];
  let commits = 0; let emails = 0; let ids = 0;
  let html = '<script>{"participants":[{"id":"p1","name":"Volunteer","email":"v@example.test","availability":[[1,"09:00","12:00"]]}]}</script>';
  let authDefect = false; let emailDefect = false;
  const layer = Layer.mergeAll(
    Layer.succeed(AuthService, { verify: credential => authDefect ? Effect.die(new Error('private auth details')) : Effect.succeed({ email: credential }) }),
    Layer.succeed(Clock, { now: Effect.sync(() => new Date(now)) }),
    Layer.succeed(IdGenerator, { next: Effect.sync(() => `generated-${++ids}`) }),
    Layer.succeed(EmailService, { send: () => Effect.sync(() => { emails += 1; }).pipe(Effect.flatMap(() => emailDefect ? Effect.die(new Error('private provider details')) : Effect.void)) }),
    Layer.succeed(WhenIsGoodClient, { fetchResults: () => Effect.sync(() => html) }),
    Layer.succeed(Database, {
      read: Effect.sync(() => structuredClone(state)),
      findIdempotency: (key, instant) => Effect.sync(() => records.find(record => record.actorId === key.actorId && record.operation === key.operation && record.idempotencyKey === key.idempotencyKey && new Date(record.createdAt).getTime() >= new Date(instant).getTime() - 86400000) ?? null),
      commit: input => Effect.gen(function* () {
        if (input.before.dataRevision !== state.dataRevision) return yield* Effect.fail(new AppError('STALE_REVISION', 'Changed'));
        commits += 1;
        const inputChanged = schedulingInputsChanged(input.before, input.after);
        state = structuredClone(input.after) as typeof state;
        state.dataRevision = input.before.dataRevision + 1;
        state.schedulingInputRevision = input.before.schedulingInputRevision + Number(inputChanged);
        const cutoff = new Date(input.createdAt).getTime() - 86400000;
        for (let i = records.length - 1; i >= 0; i--) if (new Date(records[i]!.createdAt).getTime() < cutoff) records.splice(i, 1);
        records.push({ ...input.key, fingerprint: input.fingerprint, response: input.response, createdAt: input.createdAt });
      }),
    }),
  );
  const request = (operation: string, payload: unknown = {}, key = 'key', revision = state.dataRevision, credential = 'v@example.test') => ({ operation, payload, idempotencyKey: key, expectedRevision: revision, credential });
  return {
    request, invoke: (raw: unknown) => Effect.runPromise(dispatchResponse(raw, testConfig).pipe(Effect.provide(layer))),
    state: () => state, records, commits: () => commits, emails: () => emails,
    setNow: (value: string) => { now = value; }, setHtml: (value: string) => { html = value; },
    setAuthDefect: () => { authDefect = true; }, setEmailDefect: () => { emailDefect = true; },
  };
}

describe('dispatch normalization, identity and failure boundaries', () => {
  it('replays normalized interval payloads exactly, including after a later revision, without notifying twice', async () => {
    const h = harness();
    const operation = 'volunteer.availability.recurring.update';
    const original = h.request(operation, { intervals: [{ weekday: 1, start: '10:00', end: '12:00', timeZone: zone }, { weekday: 1, start: '09:00', end: '10:00', timeZone: zone }] }, 'availability', 0);
    const first = await h.invoke(original);
    expect(JSON.parse(first).ok).toBe(true);
    await h.invoke(h.request('volunteer.availability.exception.create', { date: '2026-10-06', kind: 'available', start: '10:00', end: '11:00', timeZone: zone }, 'exception'));
    const replay = await h.invoke({ ...original, payload: { intervals: [{ weekday: 1, start: '09:00', end: '12:00', timeZone: zone }] } });
    expect(replay).toBe(first); expect(h.commits()).toBe(2); expect(h.emails()).toBe(2);
  });
  it('rejects changed input on the same key while preserving the first successful response', async () => {
    const h = harness();
    const original = h.request('volunteer.availability.recurring.update', { intervals: [] });
    const first = await h.invoke(original);
    expect(JSON.parse(await h.invoke({ ...original, payload: { intervals: [{ weekday: 2, start: '10:00', end: '12:00', timeZone: zone }] } })).error.code).toBe('INVALID_REQUEST');
    expect(await h.invoke(original)).toBe(first); expect(h.commits()).toBe(1);
  });
  it('reauthenticates and rejects inactive users before an otherwise valid replay', async () => {
    const h = harness(); const raw = h.request('volunteer.availability.recurring.update', { intervals: [] });
    expect(JSON.parse(await h.invoke(raw)).ok).toBe(true);
    h.state().users[0]!.active = false;
    expect(JSON.parse(await h.invoke(raw)).error.code).toBe('UNAUTHORIZED');
    expect(h.commits()).toBe(1);
  });
  it('checks current roles before an otherwise valid replay', async () => {
    const h = harness(); const raw = h.request('volunteer.availability.recurring.update', { intervals: [] });
    expect(JSON.parse(await h.invoke(raw)).ok).toBe(true);
    h.state().users[0]!.roles = [];
    expect(JSON.parse(await h.invoke(raw)).error.code).toBe('FORBIDDEN');
    expect(h.commits()).toBe(1);
  });
  it('derives volunteer identity solely from the current account and rejects substituted payload IDs', async () => {
    const h = harness();
    expect(JSON.parse(await h.invoke(h.request('volunteer.availability.recurring.update', { intervals: [], volunteerId: 'other' }))).error.code).toBe('INVALID_REQUEST');
    expect(h.commits()).toBe(0);
    const saved = JSON.parse(await h.invoke(h.request('volunteer.availability.recurring.update', { intervals: [{ weekday: 2, start: '10:00', end: '12:00', timeZone: zone }] })));
    expect(saved.data.intervals[0].volunteerId).toBe('v1');
  });
  it('returns INTERNAL_ERROR for an authentication defect without leaking implementation details', async () => {
    const h = harness(); h.setAuthDefect();
    const response = await h.invoke(h.request('session.me'));
    expect(JSON.parse(response).error.code).toBe('INTERNAL_ERROR'); expect(response).not.toContain('private auth details');
  });
  it('keeps a successful mutation committed after an email service defect and never retries email on replay', async () => {
    const h = harness(); h.setEmailDefect(); const raw = h.request('volunteer.availability.recurring.update', { intervals: [] });
    const response = await h.invoke(raw);
    expect(JSON.parse(response).ok).toBe(true); expect(h.state().recurringAvailability).toEqual([]);
    expect(await h.invoke(raw)).toBe(response); expect(h.emails()).toBe(1); expect(h.commits()).toBe(1);
  });
  it('expires a key after 24 hours, permitting a new request using the current revision', async () => {
    const h = harness(); const raw = h.request('volunteer.availability.recurring.update', { intervals: [] });
    const response = await h.invoke(raw);
    h.setNow('2026-10-05T12:00:00.000Z');
    expect(await h.invoke(raw)).toBe(response); expect(h.commits()).toBe(1);
    h.setNow('2026-10-05T12:00:00.001Z');
    expect(JSON.parse(await h.invoke({ ...raw, expectedRevision: 1 })).data.dataRevision).toBe(2);
    expect(h.commits()).toBe(2);
  });
  it.each([[], {}])('permits explicitly empty import availability %j without calling it a parse failure', async (availability) => {
    const h = harness();
    h.setHtml(`<script>${JSON.stringify({ participants: [{ id: 'p1', name: 'Volunteer', email: 'v@example.test', availability }] })}</script>`);
    const result = JSON.parse(await h.invoke(h.request('admin.import.whenIsGood.preview', { resultsCode: 'code' }, 'preview', 0, 'admin@example.test')));
    expect(result.ok).toBe(true); expect(result.data.import.status).toBe('staged');
    expect(result.data.import.stagedAvailability[0].intervals).toEqual([]);
  });
  it('retains valid parsed intervals when an import includes malformed intervals beside them', async () => {
    const h = harness();
    h.setHtml('<script>{"participants":[{"id":"p1","name":"Volunteer","email":"v@example.test","availability":[[1,"not-a-time","invalid"],[1,"10:00","11:00"]]}]}</script>');
    const result = JSON.parse(await h.invoke(h.request('admin.import.whenIsGood.preview', { resultsCode: 'code' }, 'preview', 0, 'admin@example.test')));
    expect(result.data.import.status).toBe('staged');
    expect(result.data.import.stagedAvailability[0].intervals).toEqual([{ weekday: 1, start: '10:00', end: '11:00', timeZone: zone }]);
  });
  it('treats a malformed nonempty import availability payload as parse failure instead of destructive empty availability', async () => {
    const h = harness(); const before = structuredClone(h.state().recurringAvailability);
    h.setHtml('<script>{"participants":[{"id":"p1","name":"Volunteer","email":"v@example.test","availability":[[1,"not-a-time","also-invalid"]]}]}</script>');
    const result = JSON.parse(await h.invoke(h.request('admin.import.whenIsGood.preview', { resultsCode: 'code' }, 'preview', 0, 'admin@example.test')));
    expect(result.ok).toBe(true); expect(result.data.import.status).toBe('failed');
    const promoted = JSON.parse(await h.invoke(h.request('admin.import.whenIsGood.promote', { resultsCode: 'code' }, 'promote', 1, 'admin@example.test')));
    expect(promoted.ok).toBe(false); expect(h.state().recurringAvailability).toEqual(before);
  });
});
