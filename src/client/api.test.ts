import { describe, expect, it } from 'vitest';
import { ApiClient, ApiClientError } from './api.js';

const googleGateHtml = '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head></html>';

function clientReturning(status: number, body: string) {
  const fetchImpl = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  }) as Response) as unknown as typeof fetch;
  return new ApiClient({ appsScriptUrl: 'https://script.google.com/macros/s/EXAMPLE/exec', fetchImpl });
}

describe('scheduling service error reporting', () => {
  it('names the web-app gate when Google rejects the request before Apps Script', async () => {
    const client = clientReturning(401, googleGateHtml);
    await expect(client.me('credential')).rejects.toMatchObject({
      code: 'deployment_not_public',
      message: expect.stringContaining('access set to "Anyone"') as unknown as string
    });
  });

  it('passes the service envelope through unchanged', async () => {
    const envelope = JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    await expect(clientReturning(200, envelope).me('credential')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Authentication is required.'
    });
  });

  it('keeps a server failure distinguishable from an authorization failure', async () => {
    const error = await clientReturning(500, '<html>error</html>').me('credential').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('server_unavailable');
    expect((error as ApiClientError).code).not.toBe('deployment_not_public');
  });
});
