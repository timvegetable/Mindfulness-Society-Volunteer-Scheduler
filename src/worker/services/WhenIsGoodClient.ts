import { Context, Effect, Layer } from 'effect';
import { AppError } from '../../shared/api/errors';
import { readBoundedText, type Fetch } from './http';

export class WhenIsGoodClient extends Context.Service<WhenIsGoodClient, {
  readonly fetchResults: (resultId: string) => Effect.Effect<string, AppError>;
}>()('WhenIsGoodClient') {}

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Shared transport for the Effect adapter and the thin Queue consumer. */
export async function fetchWhenIsGoodResults(config: { endpoint: string; fetch: Fetch }, resultId: string, signal?: AbortSignal): Promise<string> {
  const fetcher = config.fetch;
  if (!config.endpoint.includes('{resultId}')) throw new Error('Import endpoint is not configured');
  const url = new URL(config.endpoint.replaceAll('{resultId}', encodeURIComponent(resultId)));
  if (url.protocol !== 'https:') throw new Error('Import endpoint must use HTTPS');
  const response = await fetcher(url.toString(), { signal, headers: { Accept: 'text/html,application/json' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Import fetch failed');
  }
  return readBoundedText(response, MAX_IMPORT_BYTES);
}

export function makeWhenIsGoodClient(config: { endpoint: string; fetch: Fetch }) {
  return WhenIsGoodClient.of({
    fetchResults: resultId => Effect.tryPromise({
      try: signal => fetchWhenIsGoodResults(config, resultId, signal),
      catch: () => new AppError('INVALID_REQUEST', 'The results page could not be fetched or exceeds the 2 MB limit.'),
    }),
  });
}

export const whenIsGoodLayer = (config: Parameters<typeof makeWhenIsGoodClient>[0]) => Layer.succeed(WhenIsGoodClient, makeWhenIsGoodClient(config));
