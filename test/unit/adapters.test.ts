import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { Clock, fixedClock } from '../../src/worker/services/Clock';
import { IdGenerator, sequentialIds } from '../../src/worker/services/IdGenerator';
import { makeResendEmail } from '../../src/worker/services/EmailService';
import { makeWhenIsGoodClient, MAX_IMPORT_BYTES } from '../../src/worker/services/WhenIsGoodClient';
import { readBoundedText } from '../../src/worker/services/http';
describe('external adapters with local fetch fakes', () => {
  it('sends a configured notification and reports provider failure', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const service = makeResendEmail({ apiKey: 'fake-key', from: 'test@example.test', fetch: async (input, init) => { requests.push({ url: String(input), init }); return new Response('{}'); } });
    const message = { to: ['admin@example.test'], subject: 'Availability changed', text: 'Test notification' };
    await Effect.runPromise(service.send(message));
    expect(requests[0]?.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ from: 'test@example.test', ...message });
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
    const failing = makeResendEmail({ apiKey: 'fake', from: 'test@example.test', fetch: async () => new Response('', { status: 500 }) });
    await expect(Effect.runPromise(failing.send(message))).rejects.toThrow('Administrative notification');
  });
  it('encodes results codes into an HTTPS URL and returns a saved response', async () => {
    let url = '';
    const client = makeWhenIsGoodClient({ endpoint: 'https://example.test/results/{resultId}', fetch: async input => { url = String(input); return new Response('<html>fixture</html>'); } });
    expect(await Effect.runPromise(client.fetchResults('a/b ?'))).toBe('<html>fixture</html>');
    expect(url).toBe('https://example.test/results/a%2Fb%20%3F');
  });
  it('rejects unconfigured and insecure endpoints before fetching', async () => {
    for (const endpoint of ['https://example.test/', 'http://example.test/{resultId}']) {
      let fetched = false;
      const client = makeWhenIsGoodClient({ endpoint, fetch: async () => { fetched = true; return new Response(''); } });
      await expect(Effect.runPromise(client.fetchResults('test'))).rejects.toThrow();
      expect(fetched).toBe(false);
    }
  });
  it('rejects unsuccessful and oversized results pages', async () => {
    for (const response of [new Response('', { status: 404 }), new Response('x'.repeat(MAX_IMPORT_BYTES + 1))]) {
      const client = makeWhenIsGoodClient({ endpoint: 'https://example.test/{resultId}', fetch: async () => response });
      await expect(Effect.runPromise(client.fetchResults('test'))).rejects.toThrow('results page');
    }
  });
  it('bounds actual streamed bytes and advisory content length, while preserving split UTF-8', async () => {
    await expect(readBoundedText(new Response('small', { headers: { 'Content-Length': '100' } }), 10)).rejects.toThrow('size limit');
    const encoded = new TextEncoder().encode('é');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded.slice(0, 1)); controller.enqueue(encoded.slice(1)); controller.close(); } });
    expect(await readBoundedText(new Response(body), 2)).toBe('é');
    await expect(readBoundedText(new Response('é'), 1)).rejects.toThrow('size limit');
  });
  it('provides deterministic clock and ID services without global mocks', async () => {
    const program = Effect.gen(function*() {
      const clock = yield* Clock;
      const ids = yield* IdGenerator;
      return { date: (yield* clock.now).toISOString(), ids: [yield* ids.next, yield* ids.next] };
    }).pipe(Effect.provide(fixedClock('2026-10-04T12:00:00Z')), Effect.provide(sequentialIds('fixture')));
    expect(await Effect.runPromise(program)).toEqual({ date: '2026-10-04T12:00:00.000Z', ids: ['fixture-1', 'fixture-2'] });
  });
});
