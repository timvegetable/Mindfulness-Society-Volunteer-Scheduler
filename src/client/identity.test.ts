import { describe, expect, it } from 'vitest';
import { ApiClientError } from './api.js';
import { IdentityController, loadGoogleIdentityServices } from './identity.js';

function fakeIdentityApi() {
  const controllers: Array<(response: { credential?: string; error?: string }) => void> = [];
  const globalWithGoogle = globalThis as typeof globalThis & { google?: unknown };
  const previous = globalWithGoogle.google;
  globalWithGoogle.google = {
    accounts: {
      id: {
        initialize: (options: { callback: (response: { credential?: string; error?: string }) => void }) => { controllers.push(options.callback); },
        prompt: () => undefined,
        renderButton: () => undefined
      }
    }
  };
  return {
    respond: (response: { credential?: string; error?: string }) => controllers.forEach((callback) => callback(response)),
    restore: () => { globalWithGoogle.google = previous; },
    loaded: loadGoogleIdentityServices,
    previous
  };
}

const apiStub = (me: (credential: string) => Promise<{ email: string; role: 'volunteer' | 'administrator' | 'center-contact' }>) => ({ me });

describe('Google sign-in handling', () => {
  it('reports the GIS error when the account is not allowed by the OAuth client', async () => {
    const fake = fakeIdentityApi();
    try {
      const controller = new IdentityController(apiStub(async () => { throw new Error('should not be called'); }), { oauthClientId: 'client-id.apps.googleusercontent.com', document: {} as Document });
      await controller.initialize();
      fake.respond({ error: 'access_denied' });
      expect(controller.getState()).toMatchObject({ status: 'signed-out', message: expect.stringContaining('access_denied') as unknown as string });
    } finally {
      fake.restore();
    }
  });

  it('explains a missing credential, including the Testing-status remedy', async () => {
    const fake = fakeIdentityApi();
    try {
      const controller = new IdentityController(apiStub(async () => { throw new Error('should not be called'); }), { oauthClientId: 'client-id.apps.googleusercontent.com', document: {} as Document });
      await controller.initialize();
      fake.respond({});
      const state = controller.getState();
      expect(state.status).toBe('signed-out');
      expect(state).toMatchObject({ message: expect.stringContaining('test user') as unknown as string });
    } finally {
      fake.restore();
    }
  });

  it('surfaces the reason an authenticated account was rejected', async () => {
    const controller = new IdentityController(apiStub(async () => { throw new ApiClientError('deployment_not_public', 'Publish the deployment with access set to "Anyone".'); }));
    await controller.acceptCredential('credential');
    expect(controller.getState()).toMatchObject({ status: 'signed-out', message: 'Publish the deployment with access set to "Anyone".' });
  });

  it('keeps the authorization wording for a genuine rejection', async () => {
    const controller = new IdentityController(apiStub(async () => { throw new ApiClientError('FORBIDDEN', 'Your account is not authorized for this operation.'); }));
    await controller.acceptCredential('credential');
    expect(controller.getState()).toMatchObject({ status: 'signed-out', message: 'This Google account is not authorized for scheduling.' });
  });
});
