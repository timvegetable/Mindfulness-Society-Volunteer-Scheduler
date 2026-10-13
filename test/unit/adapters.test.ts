import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { Clock, fixedClock } from '../../src/worker/services/Clock';
import { IdGenerator, sequentialIds } from '../../src/worker/services/IdGenerator';
import { makeResendEmail } from '../../src/worker/services/EmailService';
import { makeGmailEmail } from '../../src/worker/services/GmailService';
import { makeWhenIsGoodClient, MAX_IMPORT_BYTES } from '../../src/worker/services/WhenIsGoodClient';
import { readBoundedText } from '../../src/worker/services/http';
describe('external adapters with local fetch fakes', () => {
  it('refreshes Gmail authorization and sends a Unicode notification as base64url MIME', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const service = makeGmailEmail({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', from: 'sender@gmail.com',
      fetch: async (input, init) => { requests.push({ url: String(input), init });
        return Response.json(requests.length === 1 ? { access_token: 'access' } : { id: 'sent' }); } });
    const message = { to: ['admin@example.test'], subject: 'Availability — changed', text: 'José is available.\nNext line.' };
    await Effect.runPromise(service.send(message));
    expect(requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(String(requests[0]?.init?.body)).toContain('grant_type=refresh_token');
    expect(requests[1]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(requests[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer access' });
    const mime = Buffer.from(JSON.parse(String(requests[1]?.init?.body)).raw, 'base64url').toString('utf8');
    expect(mime).toContain('From: sender@gmail.com\r\nTo: admin@example.test\r\n');
    const encodedSubject = mime.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)?.[1] ?? '';
    expect(Buffer.from(encodedSubject, 'base64').toString('utf8')).toBe(message.subject);
    expect(Buffer.from(mime.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8')).toBe(message.text);
  });
  it('reports Gmail authorization and delivery failures without sending after a rejected refresh', async () => {
    for (const failRefresh of [true, false]) {
      let calls = 0;
      const service = makeGmailEmail({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', from: 'sender@gmail.com',
        fetch: async () => { calls++; return calls === 1 && !failRefresh ? Response.json({ access_token: 'access' }) : new Response('', { status: 401 }); } });
      await expect(Effect.runPromise(service.send({ to: ['admin@example.test'], subject: 'Test', text: 'Body' }))).rejects.toThrow('Administrative notification');
      expect(calls).toBe(failRefresh ? 1 : 2);
    }
  });
  it('rejects Gmail header injection and incomplete configuration before fetching', async () => {
    for (const changes of [{ refreshToken: '' }, { from: 'sender@gmail.com\r\nBcc: other@example.test' }]) {
      let fetched = false;
      const service = makeGmailEmail({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', from: 'sender@gmail.com', ...changes,
        fetch: async () => { fetched = true; return Response.json({}); } });
      await expect(Effect.runPromise(service.send({ to: ['admin@example.test'], subject: 'Test', text: 'Body' }))).rejects.toThrow('Administrative notification');
      expect(fetched).toBe(false);
    }
  });
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
