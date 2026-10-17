import { Schema } from 'effect';
import { ErrorEnvelopeSchema, payloadSchemas, resultSchemas, type PayloadOf, type ResultOf } from '../shared/api/schemas';
import { isMutation, type Operation } from '../shared/api/operations';
export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ApiError'; }
}
/** A failed transport keeps the same intent key; successful mutations consume it. */
export class ApiClient {
  private credential = '';
  private generation = 0;
  private scheduleProtocol = false;
  private readSessionProtocol = false;
  private readTicket?: { credential: string; expiresAt: number };
  private exchange?: Promise<unknown>;
  private readonly pending = new Map<string, string>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly id: () => string = () => crypto.randomUUID()) {}
  signIn(credential: string) { this.signOut(); this.credential = credential; }
  signOut() { this.generation++; this.credential = ''; this.readTicket = undefined; this.scheduleProtocol = false; this.readSessionProtocol = false; this.exchange = undefined; this.pending.clear(); }
  call<O extends Operation>(operation: O, payload: PayloadOf<O>, revision?: number): Promise<ResultOf<O>> {
    return this.perform(operation, payload, revision, false);
  }
  private async perform<O extends Operation>(operation: O, payload: PayloadOf<O>, revision: number | undefined, renewed: boolean): Promise<ResultOf<O>> {
    if (!this.credential) throw new ApiError('UNAUTHORIZED', 'Please sign in to continue.');
    const generation = this.generation;
    const schedule = operation === 'admin.schedule.read' && this.scheduleProtocol;
    const readSession = this.readSessionProtocol && !isMutation(operation) && operation !== 'session.me';
    if ((schedule || readSession) && (!this.readTicket || this.readTicket.expiresAt <= Date.now())) {
      const exchange = this.exchange ??= this.call('session.me', {});
      try { await exchange; } finally { if (this.exchange === exchange) this.exchange = undefined; }
      if (generation !== this.generation) throw new ApiError('UNAUTHORIZED', 'Please sign in again.');
    }
    const normalized = Schema.decodeUnknownSync(payloadSchemas[operation] as Schema.ConstraintDecoder<unknown, never>)(payload);
    const body: Record<string, unknown> = { operation, payload: normalized, credential: schedule || readSession ? this.readTicket?.credential : this.credential };
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
    try { response = await fetcher(schedule ? '/api/schedule' : '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Your changes have not been confirmed. You can retry.'); }
    let envelope: unknown;
    try { envelope = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', 'The server returned an unreadable response. Please try again.'); }
    if (generation !== this.generation) throw new ApiError('UNAUTHORIZED', 'Please sign in again.');
    if (typeof envelope === 'object' && envelope !== null && 'ok' in envelope && envelope.ok === false) {
      const failure = Schema.decodeUnknownSync(ErrorEnvelopeSchema)(envelope);
      const details = failure.error.details;
      if (!isMutation(operation) && operation !== 'session.me' && !renewed && failure.error.code === 'INVALID_REQUEST'
        && typeof details === 'object' && details !== null && 'readSessionProtocol' in details && details.readSessionProtocol === 2) {
        this.readSessionProtocol = true; this.scheduleProtocol = true; this.readTicket = undefined;
        return this.perform(operation, payload, revision, true);
      }
      if (operation === 'admin.schedule.read' && !schedule && !renewed && failure.error.code === 'INVALID_REQUEST'
        && typeof details === 'object' && details !== null && 'scheduleReadProtocol' in details && details.scheduleReadProtocol === 1) {
        this.scheduleProtocol = true; this.readTicket = undefined;
        return this.perform(operation, payload, revision, true);
      }
      if ((schedule || readSession) && failure.error.code === 'UNAUTHORIZED' && !renewed) {
        this.readTicket = undefined;
        return this.perform(operation, payload, revision, true);
      }
      throw new ApiError(failure.error.code, failure.error.message);
    }
    if (!response.ok || typeof envelope !== 'object' || envelope === null || !('ok' in envelope) || envelope.ok !== true || !('data' in envelope)) throw new ApiError('INVALID_RESPONSE', 'The server returned an unexpected response. Please reload.');
    const data = Schema.decodeUnknownSync(resultSchemas[operation] as Schema.ConstraintDecoder<unknown, never>)(envelope.data) as ResultOf<O>;
    if (operation === 'session.me') {
      const session = data as ResultOf<'session.me'>;
      const ticket = session.readSession ?? session.scheduleRead;
      if (this.readSessionProtocol && !session.readSession) throw new ApiError('UNAUTHORIZED', 'Please reload and sign in again.');
      this.readSessionProtocol = !!session.readSession;
      if (ticket) { this.scheduleProtocol = true; this.readTicket = ticket; }
      else if (this.scheduleProtocol) throw new ApiError('UNAUTHORIZED', 'Please reload and sign in again.');
    }
    this.pending.delete(intent);
    return data;
  }
}
