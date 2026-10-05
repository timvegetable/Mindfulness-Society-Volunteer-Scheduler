import { readFile } from 'node:fs/promises';
import { Effect, Layer } from 'effect';
import { dispatchResponse } from '../../src/worker/api/dispatch';
import { testConfig } from '../../src/worker/config';
import { AppError } from '../../src/shared/api/errors';
import { isMutation, type Operation } from '../../src/shared/api/operations';
import type { ResultOf } from '../../src/shared/api/schemas';
import { Database } from '../../src/worker/services/Database';
import { AuthService } from '../../src/worker/services/AuthService';
import { fixedClock } from '../../src/worker/services/Clock';
import { sequentialIds } from '../../src/worker/services/IdGenerator';
import { EmailService, type EmailMessage } from '../../src/worker/services/EmailService';
import { WhenIsGoodClient } from '../../src/worker/services/WhenIsGoodClient';
import { createTestDatabase } from './database';

export type Actor = 'volunteer' | 'contact' | 'admin' | 'multi' | 'inactive' | 'missing';
export type ApiResult<O extends Operation> = { ok: true; data: ResultOf<O> } | { ok: false; error: { code: string; message: string } };
const emails: Record<Actor, string> = { volunteer: 'alex@example.test', contact: 'contact@example.test', admin: 'admin@example.test', multi: 'multi@example.test', inactive: 'inactive@example.test', missing: 'unknown@example.test' };
export const interval = { weekday: 1, start: '09:00', end: '17:00', timeZone: 'America/New_York' };
export const candidateInput = { centerId: 'center-2', weekday: 1, start: '12:00', end: '13:00', timeZone: 'America/New_York', requestedStaffCount: 1 };
export function success<O extends Operation>(result: ApiResult<O>): ResultOf<O> {
  if (!result.ok) throw new Error(`Expected success, received ${result.error.code}: ${result.error.message}`);
  return result.data;
}
export async function createApplication(options: { emailFails?: boolean; fetchFails?: boolean; fixture?: string; instant?: string } = {}) {
  const local = await createTestDatabase();
  const notifications: EmailMessage[] = [];
  const fetches: string[] = [];
  let html = await readFile(new URL(`../fixtures/${options.fixture ?? 'import-normal.html'}`, import.meta.url), 'utf8');
  let sequence = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(Database, local.service),
    Layer.succeed(AuthService, { verify: credential => Object.hasOwn(emails, credential)
      ? Effect.succeed({ email: emails[credential as Actor] })
      : Effect.fail(new AppError('UNAUTHORIZED', 'Invalid test credential.')) }),
    fixedClock(options.instant ?? '2026-10-04T12:00:00.000Z'), sequentialIds('workflow'),
    Layer.succeed(EmailService, { send: message => Effect.gen(function* () {
      notifications.push(message);
      if (options.emailFails) yield* Effect.fail(new AppError('INTERNAL_ERROR', 'Synthetic email failure.'));
    }) }),
    Layer.succeed(WhenIsGoodClient, { fetchResults: resultsCode => Effect.gen(function* () {
      fetches.push(resultsCode);
      if (options.fetchFails) return yield* Effect.fail(new AppError('INVALID_REQUEST', 'Synthetic fetch failure.'));
      return html;
    }) }),
  );
  async function rawRequest(raw: unknown): Promise<string> {
    return Effect.runPromise(dispatchResponse(raw, testConfig).pipe(Effect.provide(layer)));
  }
  async function request<O extends Operation>(operation: O, payload: unknown = {}, actor: Actor = 'admin', metadata: { expectedRevision?: number; idempotencyKey?: string } = {}): Promise<ApiResult<O>> {
    const revision = (await Effect.runPromise(local.service.read)).dataRevision;
    const raw = { operation, payload, credential: actor, ...(isMutation(operation) ? { expectedRevision: revision, idempotencyKey: `request-${++sequence}` } : {}), ...metadata };
    return JSON.parse(await rawRequest(raw)) as ApiResult<O>;
  }
  return { ...local, notifications, fetches, rawRequest, request, setHtml: (value: string) => { html = value; }, read: () => Effect.runPromise(local.service.read) };
}
export type Application = Awaited<ReturnType<typeof createApplication>>;

/** Valid cancellation and confirmation resources for all matrix cases. */
export async function addPublishedFixture(app: Application): Promise<void> {
  await app.db.batch([
    app.db.prepare("UPDATE users SET volunteer_id = 'volunteer-1' WHERE id = 'user-admin'"),
    app.db.prepare("UPDATE volunteers SET lifecycle_status = 'active' WHERE id = 'volunteer-3'"),
    app.db.prepare("INSERT INTO scheduling_runs (id,input_revision,output_revision,status,assignment_ids,backup_ids) VALUES ('fixture-run',0,1,'completed','[\"assignment-1\"]','[\"backup-2\",\"backup-3\"]')"),
    app.db.prepare("INSERT INTO assignments (id,session_id,volunteer_id,schedule_revision,status) VALUES ('assignment-1','session-1','volunteer-1',1,'assigned')"),
    app.db.prepare("INSERT INTO backups (id,session_id,volunteer_id,schedule_revision,position,status) VALUES ('backup-2','session-1','volunteer-2',1,1,'available'),('backup-3','session-1','volunteer-3',1,2,'available')"),
    app.db.prepare("INSERT INTO candidate_schedules (id,center_id,weekday,start_time,end_time,time_zone,requested_staff_count,status) VALUES ('candidate-1','center-2',1,'12:00','13:00','America/New_York',1,'candidate')"),
  ]);
}
