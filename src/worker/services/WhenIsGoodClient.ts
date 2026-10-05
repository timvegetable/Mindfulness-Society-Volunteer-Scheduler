import { Context, Effect, Layer } from 'effect';
import { AppError } from '../../shared/api/errors';
import { readBoundedText, type Fetch } from './http';

export class WhenIsGoodClient extends Context.Service<WhenIsGoodClient, {
  readonly fetchResults: (resultId: string) => Effect.Effect<string, AppError>;
}>()('WhenIsGoodClient') {}

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function makeWhenIsGoodClient(config: { endpoint: string; fetch: Fetch }) {
  const fetcher = config.fetch;
  return WhenIsGoodClient.of({
    fetchResults: resultId => Effect.tryPromise({
      try: async signal => {
        if (!config.endpoint.includes('{resultId}')) throw new Error('Import endpoint is not configured');
        const url = new URL(config.endpoint.replaceAll('{resultId}', encodeURIComponent(resultId)));
        if (url.protocol !== 'https:') throw new Error('Import endpoint must use HTTPS');
        const response = await fetcher(url.toString(), { signal, headers: { Accept: 'text/html,application/json' } });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Import fetch failed');
        }
        return await readBoundedText(response, MAX_IMPORT_BYTES);
      },
      catch: () => new AppError('INVALID_REQUEST', 'The results page could not be fetched or exceeds the 2 MB limit.'),
    }),
  });
}

export const whenIsGoodLayer = (config: Parameters<typeof makeWhenIsGoodClient>[0]) => Layer.succeed(WhenIsGoodClient, makeWhenIsGoodClient(config));
