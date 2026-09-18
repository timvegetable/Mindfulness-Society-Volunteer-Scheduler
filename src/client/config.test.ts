import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENT_CONFIG, loadClientConfig } from './main.js';

const served = { appsScriptUrl: 'https://script.google.com/macros/s/EXAMPLE_DEPLOYMENT/exec', oauthClientId: '1234-example.apps.googleusercontent.com' };

function capturingFetch(payload: unknown, status = 200, base = 'https://example.test/Mindfulness-Society-Volunteer-Scheduler/') {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, requested, resolve: () => new URL(requested[0] ?? '', base).toString() };
}

describe('client configuration loading', () => {
  it('fetches config.json relative to the deployment base, not from the domain root', async () => {
    const capture = capturingFetch(served);
    const config = await loadClientConfig(capture.fetchImpl);
    expect(config).toEqual(served);
    // A project site lives under /<repo>/, so the request must stay inside it.
    expect(capture.resolve()).toBe('https://example.test/Mindfulness-Society-Volunteer-Scheduler/config.json');
  });

  it('also resolves inside the base when the app is served at the domain root', async () => {
    const capture = capturingFetch(served, 200, 'https://example.test/');
    await loadClientConfig(capture.fetchImpl);
    expect(capture.resolve()).toBe('https://example.test/config.json');
  });

  it('falls back to an unconfigured client when the file is missing or malformed', async () => {
    expect(await loadClientConfig(capturingFetch({}, 404).fetchImpl)).toEqual(DEFAULT_CLIENT_CONFIG);
    expect(await loadClientConfig(capturingFetch([{ appsScriptUrl: 1 }]).fetchImpl)).toEqual(DEFAULT_CLIENT_CONFIG);
    const throwing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await loadClientConfig(throwing)).toEqual(DEFAULT_CLIENT_CONFIG);
  });
});
