import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { resultSchemas } from '../../src/shared/api/schemas';
import { applySql } from '../helpers/database';

it('delivers native queued checks and authorizes manual requests through the bundled Worker', async () => {
  const work = await mkdtemp(join(tmpdir(), 'scheduler-native-queue-test-'));
  let runtime: Miniflare | undefined;
  try {
    const entry = resolve('src/worker/index.ts');
    // The local wrapper only supplies scheduled events. The application HTTP,
    // credential verification, Queue consumer and D1 paths are the real modules.
    await build({ stdin: { contents: `import worker from ${JSON.stringify(entry)};
      export default { ...worker, async fetch(request, env) {
        if (new URL(request.url).pathname !== '/test-scheduled') return worker.fetch(request, env);
        const time = Date.now(); await worker.scheduled({ scheduledTime: time, cron: '*/30 * * * *' }, env);
        return Response.json({ id: 'scheduled-' + time });
      } };`, resolveDir: process.cwd(), sourcefile: 'native-queue-test.ts', loader: 'ts' },
      bundle: true, format: 'esm', platform: 'browser', outfile: join(work, 'worker.js'), logLevel: 'silent' });
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const key = { ...await exportJWK(publicKey), kid: 'synthetic-test', alg: 'RS256', use: 'sig' };
    const credential = (email: string) => new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid }).setIssuer('https://accounts.google.com')
      .setAudience('synthetic-queue-test').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const html = await readFile(new URL('../fixtures/import-native.html', import.meta.url), 'utf8');
    let googleReads = 0, sourceReads = 0;
    runtime = new Miniflare(convertV4MiniflareOptions({ name: 'native-queue-test', modules: true, modulesRoot: work,
      scriptPath: join(work, 'worker.js'), compatibilityDate: '2026-10-04', d1Databases: ['DB'],
      queueProducers: { SYNC_QUEUE: 'synthetic-sync' },
      queueConsumers: { 'synthetic-sync': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1, deadLetterQueue: 'synthetic-dead' },
        'synthetic-dead': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 } },
      bindings: { SYNC_DEAD_LETTER_QUEUE: 'synthetic-dead', DISPLAY_INCREMENT_MINUTES: '30', OPERATING_HOURS_START: '09:00',
        OPERATING_HOURS_END: '21:00', OAUTH_CLIENT_ID: 'synthetic-queue-test', ADMIN_EMAILS: '', EMAIL_FROM: 'unused@example.test' },
      outboundService: request => {
        if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') {
          googleReads++; return Response.json({ keys: [key] }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
        }
        if (request.url === 'https://whenisgood.net/d7y3d5c/results/mx8t23j') { sourceReads++; return new Response(html); }
        throw new Error('Synthetic native runtime blocks unexpected external requests');
      },
    }));
    const db = await runtime.getD1Database('DB') as unknown as D1Database;
    await applySql(db, await readFile(new URL('../../schema.sql', import.meta.url), 'utf8'));
    await applySql(db, await readFile(new URL('../fixtures/seed.sql', import.meta.url), 'utf8'));
    await db.prepare("UPDATE volunteers SET name='Alice' WHERE id='volunteer-1'").run();
    async function complete(id: string) {
      await expect.poll(async () => (await db.prepare('SELECT phase FROM synchronization_jobs WHERE id=?').bind(id).first<{ phase: string }>())?.phase,
        { timeout: 10000, interval: 25 }).toBe('done');
    }
    for (let iteration = 0; iteration < 2; iteration++) {
      const scheduled = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await (await runtime.dispatchFetch('http://local/test-scheduled')).json());
      await complete(scheduled.id);
      expect(await db.prepare('SELECT outcome,matched_count,pending_count FROM synchronizations').first())
        .toMatchObject({ outcome: iteration ? 'unchanged' : 'changed', matched_count: 1, pending_count: 1 });
    }
    expect(googleReads).toBe(0); expect(sourceReads).toBe(2);
    const admin = await credential('admin@example.test');
    async function api(operation: string, token: string, extra = {}) {
      const response = await runtime!.dispatchFetch('http://local/api', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, credential: token, payload: {}, ...extra }) });
      return Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Boolean, data: Schema.optionalKey(Schema.Unknown),
        error: Schema.optionalKey(Schema.Struct({ code: Schema.String })) }))(await response.json());
    }
    const revision = (await db.prepare("SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key='dataRevision'").first<{ revision: number }>())!.revision;
    const accepted = await api('admin.sync.now', admin, { expectedRevision: revision, idempotencyKey: 'native-manual' });
    expect(accepted.ok).toBe(true);
    const queued = Schema.decodeUnknownSync(resultSchemas['admin.sync.now'])(accepted.data);
    expect(queued.job?.state).toBe('queued'); await complete(queued.job!.id);
    const read = await api('admin.sync.read', admin); expect(read.ok).toBe(true);
    const view = Schema.decodeUnknownSync(resultSchemas['admin.sync.read'])(read.data);
    expect(view.job?.state).toBe('succeeded'); expect(view.imports).toHaveLength(1); expect(view.dataRevision).toBe(revision);
    const volunteer = await credential('alex@example.test');
    expect(await api('admin.sync.now', volunteer, { expectedRevision: revision, idempotencyKey: 'forbidden-native' }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await api('admin.sync.read', volunteer)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const dashboard = await api('volunteer.dashboard', volunteer); expect(dashboard.ok).toBe(true);
    expect(Schema.decodeUnknownSync(resultSchemas['volunteer.dashboard'])(dashboard.data).recurringAvailability.length).toBeGreaterThan(0);
    // Native HTTP validation still rejects corrupt records and re-reads current
    // authority even when the exact same verified JWT is used again.
    await db.prepare("UPDATE volunteers SET name='' WHERE id='volunteer-1'").run();
    expect(await api('admin.sync.read', admin)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await db.prepare("UPDATE volunteers SET name='Alice' WHERE id='volunteer-1'").run();
    await db.prepare("UPDATE users SET roles='[]' WHERE email='admin@example.test'").run();
    expect(await api('admin.sync.read', admin)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.prepare("UPDATE users SET active=0 WHERE email='alex@example.test'").run();
    expect(await api('volunteer.dashboard', volunteer)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(sourceReads).toBe(3); expect(googleReads).toBe(1);
  } finally { await runtime?.dispose(); await rm(work, { recursive: true, force: true }); }
});
