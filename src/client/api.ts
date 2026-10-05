import { Schema } from 'effect';
import { ErrorEnvelopeSchema, payloadSchemas, resultSchemas, type PayloadOf, type ResultOf } from '../shared/api/schemas';
import { isMutation, type Operation } from '../shared/api/operations';
export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ApiError'; }
}
/** A failed transport keeps the same intent key; successful mutations consume it. */
export class ApiClient {
  private credential = '';
  private readonly pending = new Map<string, string>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly id: () => string = () => crypto.randomUUID()) {}
  signIn(credential: string) { this.credential = credential; this.pending.clear(); }
  signOut() { this.credential = ''; this.pending.clear(); }
  async call<O extends Operation>(operation: O, payload: PayloadOf<O>, revision?: number): Promise<ResultOf<O>> {
    if (!this.credential) throw new ApiError('UNAUTHORIZED', 'Please sign in to continue.');
    const normalized = Schema.decodeUnknownSync(payloadSchemas[operation] as Schema.ConstraintDecoder<unknown, never>)(payload);
    const body: Record<string, unknown> = { operation, payload: normalized, credential: this.credential };
    const intent = JSON.stringify([operation, normalized, revision]);
    if (isMutation(operation)) {
      if (revision === undefined) throw new ApiError('INVALID_REQUEST', 'Reload this view before saving.');
      body.expectedRevision = revision;
      let key = this.pending.get(intent);
      if (!key) { key = this.id(); this.pending.set(intent, key); }
      body.idempotencyKey = key;
    }
    let response: Response;
    // Native browser fetch rejects an unrelated object as its receiver.
    const fetcher = this.fetcher;
    try { response = await fetcher('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Your changes have not been confirmed. You can retry.'); }
    let envelope: unknown;
    try { envelope = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', 'The server returned an unreadable response. Please try again.'); }
    if (typeof envelope === 'object' && envelope !== null && 'ok' in envelope && envelope.ok === false) {
      const failure = Schema.decodeUnknownSync(ErrorEnvelopeSchema)(envelope);
      throw new ApiError(failure.error.code, failure.error.message);
    }
    if (!response.ok || typeof envelope !== 'object' || envelope === null || !('ok' in envelope) || envelope.ok !== true || !('data' in envelope)) throw new ApiError('INVALID_RESPONSE', 'The server returned an unexpected response. Please reload.');
    const data = Schema.decodeUnknownSync(resultSchemas[operation] as Schema.ConstraintDecoder<unknown, never>)(envelope.data) as ResultOf<O>;
    this.pending.delete(intent);
    return data;
  }
}
