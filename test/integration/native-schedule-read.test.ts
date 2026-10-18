import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { resultSchemas } from '../../src/shared/api/schemas';
import { executeCommit, prepareScheduleBackfill } from '../../src/worker/repositories/database';
import { applySql } from '../helpers/database';

it('exchanges real Google-style credentials and reads prepared schedules through native Worker crypto and D1', async () => {
  const work = await mkdtemp(join(tmpdir(), 'native-schedule-read-')); let runtime: Miniflare | undefined;
  try {
    await build({ entryPoints: [resolve('src/worker/index.ts')], bundle: true, format: 'esm', platform: 'browser',
      outfile: join(work, 'worker.js'), logLevel: 'silent' });
    await build({ entryPoints: [resolve('src/worker/scheduleRead/worker.ts')], bundle: true, format: 'esm', platform: 'browser',
      outfile: join(work, 'reader.js'), logLevel: 'silent' });
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const key = { ...await exportJWK(publicKey), kid: 'synthetic-read-test', alg: 'RS256', use: 'sig' };
    const google = (email: string, verified = true) => new SignJWT({ email, email_verified: verified })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid }).setIssuer('https://accounts.google.com')
      .setAudience('native-read-client').setIssuedAt().setExpirationTime('10m').sign(privateKey);
    let googleReads = 0;
    const outboundService = (request: Request) => {
        if (request.url !== 'https://www.googleapis.com/oauth2/v3/certs') throw Error('Unexpected synthetic external request');
        googleReads++; return Response.json({ keys: [key] }, { headers: { 'Cache-Control': 'public,max-age=3600' } });
      };
    const readerBindings = { OAUTH_CLIENT_ID: 'native-read-client', SCHEDULE_READ_MODE: 'enabled', SCHEDULE_READ_AUDIENCE: 'native', SCHEDULE_READ_KEY: 'ac'.repeat(32) };
    runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'native-schedule-read', modules: true, modulesRoot: work,
      scriptPath: join(work, 'worker.js'), compatibilityDate: '2026-10-04', d1Databases: { DB: 'native-read-shared' }, serviceBindings: { SCHEDULE_READER: 'private-reader' },
      outboundService, bindings: { OAUTH_CLIENT_ID: 'native-read-client', ADMIN_EMAILS: '', EMAIL_FROM: 'unused@example.test',
        SCHEDULE_READ_MODE: 'enabled', SCHEDULE_READ_AUDIENCE: 'native', SCHEDULE_READ_KEY: 'ac'.repeat(32),
        DISPLAY_INCREMENT_MINUTES: '30', OPERATING_HOURS_START: '09:00', OPERATING_HOURS_END: '21:00' },

    }, { name: 'private-reader', modules: true, modulesRoot: work, scriptPath: join(work, 'reader.js'),
      compatibilityDate: '2026-10-04', d1Databases: { DB: 'native-read-shared' }, bindings: readerBindings, outboundService },
      { name: 'google-only', modules: true, modulesRoot: work, scriptPath: join(work, 'reader.js'),
        compatibilityDate: '2026-10-04', bindings: readerBindings, outboundService },
      { name: 'generic-main', modules: true, modulesRoot: work, scriptPath: join(work, 'worker.js'),
        compatibilityDate: '2026-10-04', d1Databases: { DB: 'native-read-shared' }, outboundService,
        bindings: { OAUTH_CLIENT_ID: 'native-read-client', SCHEDULE_READ_MODE: 'prepare', ADMIN_EMAILS: '', EMAIL_FROM: 'unused@example.test',
          DISPLAY_INCREMENT_MINUTES: '30', OPERATING_HOURS_START: '09:00', OPERATING_HOURS_END: '21:00' } },
      { name: 'disabled-reader', modules: true, modulesRoot: work, scriptPath: join(work, 'reader.js'),
        compatibilityDate: '2026-10-04', bindings: { ...readerBindings, SCHEDULE_READ_MODE: 'disabled' }, outboundService }] }));
    const db = await runtime.getD1Database('DB') as unknown as D1Database;
    await applySql(db, await readFile(new URL('../../schema.sql', import.meta.url), 'utf8'));
    await applySql(db, await readFile(new URL('../fixtures/seed.sql', import.meta.url), 'utf8'));
    await executeCommit(db, await prepareScheduleBackfill(db));
    const admin = await google('admin@example.test');
    async function call(operation: string, credential: string, path = '/api', payload: unknown = {}) {
      const response = await runtime!.dispatchFetch('https://local'+path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, credential, payload }) });
      return { response, body: await response.json() };
    }
    async function signIn(credential: string) {
      const proof = await runtime!.dispatchFetch('https://local/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
      const value = await proof.json() as { ok: boolean; data?: { credential: string; expiresAt: number } };
      if (!value.ok) return { response: proof, body: value };
      expect(value.data?.credential).toMatch(/^g1\./);
      expect(value.data!.expiresAt).toBeLessThanOrEqual(Date.now() + 60000);
      return call('session.me', value.data!.credential);
    }
    expect((await call('session.me', admin)).body).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { signInProtocol: 3 } } });
    const googleOnly = await runtime.getWorker('google-only');
    const disabledReader = await runtime.getWorker('disabled-reader');
    expect((await disabledReader.fetch('https://local/internal/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: admin }) })).status).toBe(404);
    expect((await googleOnly.fetch('https://local/internal/identity')).status).toBe(400);
    expect((await googleOnly.fetch('https://local/internal/identity', { method: 'POST', body: JSON.stringify({ credential: admin }) })).status).toBe(400);
    const proofResponse = await googleOnly.fetch('https://local/internal/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: admin }) });
    expect(proofResponse.status).toBe(200);
    const proofValue = await proofResponse.json() as { data: { credential: string; expiresAt: number } };
    const identityProof = proofValue.data.credential;
    expect((await call('admin.schedule.read', identityProof, '/api/schedule')).response.status).toBe(401);
    expect((await call('admin.sync.read', identityProof)).response.status).toBe(400);
    expect((await call('admin.sync.now', identityProof)).response.status).toBe(401);
    const tampered = identityProof.slice(0, -4) + 'AAAA';
    expect((await call('session.me', tampered)).response.status).toBe(401);
    await db.prepare("UPDATE users SET active=0 WHERE id='user-admin'").run();
    expect((await call('session.me', identityProof)).response.status).toBe(401);
    await db.prepare("UPDATE users SET active=1 WHERE id='user-admin'").run();
    for (const body of [{ credential: admin, email: 'other@example.test' }, { credential: 'x'.repeat(65537) }]) {
      const rejected = await runtime.dispatchFetch('https://local/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(rejected.status).toBe(400);
    }
    const envelope = Schema.Struct({ ok: Schema.Literal(true), data: resultSchemas['session.me'] });
    const session = Schema.decodeUnknownSync(envelope)((await signIn(admin)).body);
    expect(session.data).toHaveProperty('readSession');
    expect(session.data.readSession?.expiresAt).toBeLessThanOrEqual(Date.now()+600000);
    const ticket = session.data.readSession!.credential;
    const read = await call('admin.schedule.read', ticket, '/api/schedule');
    expect(read.response.status).toBe(200);
    expect(Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true), data: resultSchemas['admin.schedule.read'] }))(read.body).data.run).toBeNull();
    for (const operation of ['admin.sync.read', 'admin.insights.read', 'center.candidate.read'] as const) {
      const result = await call(operation, ticket);
      expect(result.body).toMatchObject({ ok: true });
      Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true), data: resultSchemas[operation] }))(result.body);
    }
    expect((await call('admin.sync.now', ticket)).response.status).toBe(401);
    expect(googleReads).toBe(2);
    const generic = await runtime.getWorker('generic-main');
    const genericRead = await generic.fetch('https://local/api', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'admin.sync.read', credential: admin, payload: {} }) });
    expect((await call('admin.sync.read', ticket)).body).toEqual(await genericRead.json());
    expect((await call('admin.sync.read', ticket, '/api', { extra: true })).body).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const tamperedRead = ticket.slice(0, -4) + 'AAAA';
    expect((await call('admin.sync.read', tamperedRead)).body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(googleReads).toBe(3);
    const checkedAt = '2026-10-17T20:00:00Z';
    const participant = { id: 'synthetic-quote"', name: 'Synthetic \"quote\" \u2603', email: null, intervals: [], identityStable: true };
    const pendingParticipant = { ...participant, resolvable: true, reason: 'new', present: true, firstSeenAt: checkedAt, lastSeenAt: checkedAt };
    await db.batch([
      db.prepare("INSERT INTO imports(id,source,content_hash,status,started_at,completed_at,participant_count,matched_count,unmatched,staged_availability) VALUES ('synthetic-history','whenIsGood','hash','completed',?,?,1,0,?,?)")
        .bind(checkedAt, checkedAt, JSON.stringify([participant]), JSON.stringify([{ ...participant, volunteerId: null, pendingReason: 'new' }])),
      db.prepare("INSERT INTO synchronizations(id,generation,outcome,participant_count,matched_count,pending_count,participants,pending,last_attempt_at,last_success_at) VALUES ('whenIsGood',1,'unchanged',1,0,1,'[]',?,?,?)")
        .bind(JSON.stringify([pendingParticipant]), checkedAt, checkedAt),
      db.prepare("INSERT INTO synchronization_jobs(id,actor_id,actor_kind,operation,intent_key,fingerprint,phase,created_at,updated_at) VALUES ('synthetic-job','user-admin','administrator','admin.sync.now','synthetic-key','{}','done',?,?)")
        .bind(checkedAt, checkedAt),
    ]);
    const richRead = await call('admin.sync.read', ticket);
    const richGeneric = await generic.fetch('https://local/api', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'admin.sync.read', credential: admin, payload: {} }) });
    expect(richRead.body).toEqual(await richGeneric.json());
    expect(richRead.body).toMatchObject({ ok: true, data: { pending: [pendingParticipant], imports: [{ id: 'synthetic-history' }], job: { id: 'synthetic-job', state: 'succeeded' } } });
    await db.prepare("UPDATE volunteers SET lifecycle_status='invalid' WHERE id='volunteer-1'").run();
    expect((await call('admin.sync.read', ticket)).body).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await db.prepare("UPDATE volunteers SET lifecycle_status='active' WHERE id='volunteer-1'").run();
    // Direct fixture writes invalidate the prepared schedule, even when restoring a value.
    await executeCommit(db, await prepareScheduleBackfill(db));
    const privateWorker = await runtime.getWorker('private-reader');
    const oldExchange = await privateWorker.fetch('https://local/internal/session', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'session.me', credential: admin, payload: {} }) });
    const oldSession = Schema.decodeUnknownSync(envelope)(await oldExchange.json());
    const priorExchange = await privateWorker.fetch('https://local/internal/session', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Read-Session-Protocol': '2' }, body: JSON.stringify({ operation: 'session.me', credential: admin, payload: {} }) });
    expect(Schema.decodeUnknownSync(envelope)(await priorExchange.json()).data.readSession?.credential).toMatch(/^r2\./);
    expect(oldSession.data.readSession).toBeUndefined();
    expect(oldSession.data.scheduleRead?.credential).toMatch(/^r1\./);
    expect((await call('admin.sync.read', oldSession.data.scheduleRead!.credential)).response.status).toBe(400);
    expect((await call('admin.schedule.read', oldSession.data.scheduleRead!.credential, '/api/schedule')).response.status).toBe(200);
    expect((await call('admin.schedule.read', admin)).response.status).toBe(400);
    expect((await call('admin.schedule.read', admin, '/api/schedule')).response.status).toBe(401);
    expect((await call('admin.schedule.read', ticket, '/api/schedule', { extra: true })).response.status).toBe(400);
    expect((await call('session.me', admin, '/api', { extra: true })).response.status).toBe(400);
    const denied = await signIn(await google('admin@example.test', false));
    expect(denied.body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    const volunteer = Schema.decodeUnknownSync(envelope)((await signIn(await google('alex@example.test'))).body);
    expect(volunteer.data.scheduleRead).toBeUndefined();
    expect(volunteer.data.readSession?.credential).toMatch(/^r2\./);
    const volunteerTicket = volunteer.data.readSession!.credential;
    expect((await call('volunteer.dashboard', volunteerTicket)).body).toMatchObject({ ok: true });
    expect((await call('admin.sync.read', volunteerTicket)).body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect((await call('volunteer.availability.recurring.update', volunteerTicket, '/api', { intervals: [] })).response.status).toBe(401);
    const contact = Schema.decodeUnknownSync(envelope)((await signIn(await google('contact@example.test'))).body);
    expect(contact.data.centers.map(center => center.id)).toEqual(['center-1']);
    expect(contact.data.scheduleRead).toBeUndefined();
    const proposals = await call('center.candidate.read', contact.data.readSession!.credential);
    expect(proposals.body).toMatchObject({ ok: true, data: { centers: [{ id: 'center-1' }] } });
    await db.prepare("UPDATE users SET center_ids='\"center-1 center-2\"' WHERE id='user-contact'").run();
    expect((await call('center.candidate.read', contact.data.readSession!.credential)).body).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await db.prepare("UPDATE users SET center_ids='[\"center-1\"]' WHERE id='user-contact'").run();
    expect((await call('volunteer.dashboard', contact.data.readSession!.credential)).body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect((await signIn(await google('inactive@example.test'))).response.status).toBe(401);
    await db.prepare("UPDATE centers SET name='' WHERE id='center-1'").run();
    expect((await signIn(admin)).response.status).toBe(500);
    await db.prepare("UPDATE centers SET name='North Center' WHERE id='center-1'").run();
    await db.prepare("UPDATE users SET roles='\"administrator\"' WHERE id='user-admin'").run();
    expect((await call('admin.sync.read', ticket)).body).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await db.prepare("UPDATE users SET roles='[]' WHERE id='user-admin'").run();
    expect((await call('admin.schedule.read', ticket, '/api/schedule')).response.status).toBe(403);
    expect((await call('admin.sync.read', ticket)).body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.prepare("UPDATE users SET roles='[\"administrator\"]',id='replacement-admin' WHERE id='user-admin'").run();
    expect((await call('admin.sync.read', ticket)).body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(googleReads).toBe(3);
  } finally { await runtime?.dispose(); await rm(work, { recursive: true, force: true }); }
});
