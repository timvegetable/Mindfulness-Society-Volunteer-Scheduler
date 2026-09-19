import { parseEmbeddedWhenIsGoodData, type EmbeddedParserOptions } from './parser.js';
import type { Fetcher, ParsedWhenIsGood, WhenIsGoodFetcherOptions } from './types.js';
import { utf8ByteLength } from '../../shared/utf8.js';

export class WhenIsGoodFetchError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WhenIsGoodFetchError';
    this.status = status;
  }
}

export type WhenIsGoodFetchResult = {
  resultId: string;
  url: string;
  html: string;
  parsed: ParsedWhenIsGood;
};

function buildUrl(endpoint: string, resultId: string): string {
  const encoded = encodeURIComponent(resultId);
  if (endpoint.includes('{resultId}')) return endpoint.replaceAll('{resultId}', encoded);
  try {
    const parsed = new URL(endpoint);
    const segments = parsed.pathname.split('/');
    const resultsIndex = segments.lastIndexOf('results');
    if (resultsIndex === segments.length - 1) {
      segments.push(encoded);
      parsed.pathname = segments.join('/');
      return parsed.toString();
    }
    if (resultsIndex === segments.length - 2) {
      segments[resultsIndex + 1] = encoded;
      parsed.pathname = segments.join('/');
      return parsed.toString();
    }
  } catch {
    // Fall through to the legacy query-parameter endpoint format.
  }
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}result=${encoded}`;
}

export class WhenIsGoodFetcher {
  private readonly request: Fetcher;
  private readonly endpoint: string;
  private readonly maxPayloadBytes: number;
  private readonly parserOptions: Omit<EmbeddedParserOptions, 'resultId'>;

  constructor(options: WhenIsGoodFetcherOptions & { parserOptions?: Omit<EmbeddedParserOptions, 'resultId'> }) {
    this.request = options.fetch;
    this.endpoint = options.endpoint;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 2_000_000;
    this.parserOptions = options.parserOptions ?? {};
  }

  fetchResult(resultId: string): WhenIsGoodFetchResult {
    const normalizedResultId = resultId.trim();
    if (!normalizedResultId) throw new WhenIsGoodFetchError('A WhenIsGood result identifier is required');
    const url = buildUrl(this.endpoint, normalizedResultId);
    let response;
    try {
      response = this.request(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown network error';
      throw new WhenIsGoodFetchError(`WhenIsGood request failed: ${message}`);
    }
    if (!response.ok) throw new WhenIsGoodFetchError(`WhenIsGood request returned HTTP ${response.status ?? 'error'}`, response.status);
    const html = response.text();
    if (utf8ByteLength(html) > this.maxPayloadBytes) throw new WhenIsGoodFetchError('WhenIsGood response exceeds the configured payload limit');
    let parsed: ParsedWhenIsGood;
    try {
      parsed = parseEmbeddedWhenIsGoodData(html, { ...this.parserOptions, resultId: normalizedResultId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unsupported embedded payload';
      throw new WhenIsGoodFetchError(`WhenIsGood response could not be parsed: ${message}`);
    }
    return { resultId: normalizedResultId, url, html, parsed };
  }

  fetch(resultId: string): WhenIsGoodFetchResult {
    return this.fetchResult(resultId);
  }
}

export function createWhenIsGoodFetcher(options: WhenIsGoodFetcherOptions & { parserOptions?: Omit<EmbeddedParserOptions, 'resultId'> }): WhenIsGoodFetcher {
  return new WhenIsGoodFetcher(options);
}
