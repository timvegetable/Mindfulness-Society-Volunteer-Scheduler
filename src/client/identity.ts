import { ApiClientError, type ApiClient, type IdentityData } from './api';

export type UserRole = IdentityData['role'];
export type IdentityCredentialCallback = (credential: string) => void | Promise<void>;

export interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
  /** Present when GIS refuses the request, e.g. an account that is not a test user. */
  error?: string;
}

interface GoogleIdentityIdApi {
  initialize(options: { client_id: string; callback: (response: GoogleCredentialResponse) => void }): void;
  prompt(): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect?(): void;
}

interface GoogleIdentityApi {
  accounts?: { id?: GoogleIdentityIdApi };
}

export interface IdentityLoaderOptions {
  document?: Document;
  timeoutMs?: number;
}

const GIS_SCRIPT_ID = 'google-identity-services';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

function globalGoogle(): GoogleIdentityApi | undefined {
  const globalWithGoogle = globalThis as typeof globalThis & { google?: unknown };
  const candidate = globalWithGoogle.google;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return candidate as GoogleIdentityApi;
}

/** Load GIS without accepting a script URL from runtime configuration. */
export async function loadGoogleIdentityServices(options: IdentityLoaderOptions = {}): Promise<GoogleIdentityApi> {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef) throw new Error('Google Identity Services requires a browser document.');
  const existing = globalGoogle();
  if (existing?.accounts?.id) return existing;

  const currentScript = documentRef.getElementById(GIS_SCRIPT_ID) as HTMLScriptElement | null;
  const script = currentScript ?? documentRef.createElement('script');
  if (!currentScript) {
    script.id = GIS_SCRIPT_ID;
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    documentRef.head.append(script);
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Google Identity Services did not load in time.'));
    }, timeoutMs);
    script.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      resolve();
    }, { once: true });
    script.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      reject(new Error('Google Identity Services failed to load.'));
    }, { once: true });
  });
  const loaded = globalGoogle();
  if (!loaded?.accounts?.id) throw new Error('Google Identity Services is unavailable.');
  return loaded;
}

export type IdentityState =
  | { status: 'idle' | 'loading' | 'unavailable' | 'signed-out'; message?: string }
  | { status: 'authenticating'; credential: string }
  | { status: 'authenticated'; credential: string; profile: IdentityData };

export interface IdentityControllerOptions extends IdentityLoaderOptions {
  oauthClientId?: string;
  buttonParent?: HTMLElement;
  onCredential?: IdentityCredentialCallback;
}

/** Surfaces the server's non-sensitive rejection reason, when it supplies one. */
function rejectedReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const record = details as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (reason && detail) return `${reason}: ${detail}`;
  return detail ?? reason;
}

export interface IdentityStateListener {
  (state: IdentityState): void;
}

/**
 * Owns GIS lifecycle and exchanges the opaque GIS credential through
 * session.me. The browser never decodes or treats the credential as verified.
 */
export class IdentityController {
  private readonly api: Pick<ApiClient, 'me'>;
  private readonly options: IdentityControllerOptions;
  private readonly listeners = new Set<IdentityStateListener>();
  private state: IdentityState = { status: 'idle' };
  private credential?: string;
  private identityApi?: GoogleIdentityIdApi;

  constructor(api: Pick<ApiClient, 'me'>, options: IdentityControllerOptions = {}) {
    this.api = api;
    this.options = options;
  }

  getState(): IdentityState {
    return this.state;
  }

  subscribe(listener: IdentityStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<IdentityState> {
    if (!this.options.oauthClientId?.trim()) {
      this.setState({ status: 'unavailable', message: 'Sign-in is not configured for this deployment.' });
      return this.state;
    }
    this.setState({ status: 'loading' });
    try {
      const google = await loadGoogleIdentityServices(this.options);
      const identityApi = google.accounts?.id;
      if (!identityApi) throw new Error('Google Identity Services is unavailable.');
      this.identityApi = identityApi;
      identityApi.initialize({
        client_id: this.options.oauthClientId,
        callback: (response) => {
          const credential = typeof response?.credential === 'string' ? response.credential : '';
          if (!credential.trim()) {
            // GIS rejects the prompt without a credential for accounts the OAuth
            // client does not allow (for example while its consent screen is still
            // in Testing and the account is not a test user).
            this.setState({
              status: 'signed-out',
              message: response?.error
                ? `Google sign-in did not complete (${response.error}).`
                : 'Google sign-in did not return a credential. If the OAuth client is still in Testing, add this account as a test user.'
            });
            return;
          }
          void this.acceptCredential(credential);
        }
      });
      if (this.options.buttonParent) {
        identityApi.renderButton(this.options.buttonParent, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'left'
        });
      }
      identityApi.prompt();
      return this.state;
    } catch {
      this.setState({ status: 'unavailable', message: 'Google sign-in is currently unavailable.' });
      return this.state;
    }
  }

  async acceptCredential(credential: string | undefined): Promise<void> {
    if (typeof credential !== 'string' || !credential.trim()) {
      this.setState({ status: 'signed-out', message: 'Google sign-in did not return a credential.' });
      return;
    }
    this.credential = credential;
    this.setState({ status: 'authenticating', credential });
    try {
      const profile = await this.api.me(credential);
      this.setState({ status: 'authenticated', credential, profile });
      await this.options.onCredential?.(credential);
    } catch (error) {
      this.credential = undefined;
      // Report why it failed: a blanket "not authorized" hid a deployment that
      // rejected the request before it ever reached the scheduler.
      const rejected = error instanceof ApiClientError && (error.code === 'unauthorized' || error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED');
      const reason = error instanceof ApiClientError ? rejectedReason(error.details) : undefined;
      const message = !rejected && error instanceof Error && error.message
        ? error.message
        : `This Google account is not authorized for scheduling.${reason ? ` (${reason})` : ''}`;
      this.setState({ status: 'signed-out', message });
    }
  }

  signOut(): void {
    this.identityApi?.disableAutoSelect?.();
    this.credential = undefined;
    this.setState({ status: 'signed-out' });
  }

  getCredential(): string | undefined {
    return this.credential;
  }

  private setState(next: IdentityState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
