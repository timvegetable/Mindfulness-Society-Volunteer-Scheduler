import { parseEmbeddedWhenIsGoodData, type EmbeddedParserOptions } from './parser.js';
import type { Fetcher, ParsedWhenIsGood, WhenIsGoodFetcherOptions } from './types.js';

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
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}result=${encoded}`;
}

export class WhenIsGoodFetcher {
  private readonly fetch: Fetcher;
  private readonly endpoint: string;
  private readonly maxPayloadBytes: number;
  private readonly parserOptions: Omit<EmbeddedParserOptions, 'resultId'>;

  constructor(options: WhenIsGoodFetcherOptions & { parserOptions?: Omit<EmbeddedParserOptions, 'resultId'> }) {
    this.fetch = options.fetch;
    this.endpoint = options.endpoint;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 2_000_000;
    this.parserOptions = options.parserOptions ?? {};
  }

  async fetchResult(resultId: string): Promise<WhenIsGoodFetchResult> {
    const normalizedResultId = resultId.trim();
    if (!normalizedResultId) throw new WhenIsGoodFetchError('A WhenIsGood result identifier is required');
    const url = buildUrl(this.endpoint, normalizedResultId);
    let response;
    try {
      response = await this.fetch(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown network error';
      throw new WhenIsGoodFetchError(`WhenIsGood request failed: ${message}`);
    }
    if (!response.ok) throw new WhenIsGoodFetchError(`WhenIsGood request returned HTTP ${response.status ?? 'error'}`, response.status);
    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > this.maxPayloadBytes) throw new WhenIsGoodFetchError('WhenIsGood response exceeds the configured payload limit');
    let parsed: ParsedWhenIsGood;
    try {
      parsed = parseEmbeddedWhenIsGoodData(html, { ...this.parserOptions, resultId: normalizedResultId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unsupported embedded payload';
      throw new WhenIsGoodFetchError(`WhenIsGood response could not be parsed: ${message}`);
    }
    return { resultId: normalizedResultId, url, html, parsed };
  }
}

export function createWhenIsGoodFetcher(options: WhenIsGoodFetcherOptions & { parserOptions?: Omit<EmbeddedParserOptions, 'resultId'> }): WhenIsGoodFetcher {
  return new WhenIsGoodFetcher(options);
}
