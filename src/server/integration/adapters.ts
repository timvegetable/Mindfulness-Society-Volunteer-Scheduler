import type { ApiResponse } from '../../shared/domain.js';
import { IntegrationDispatcher } from './dispatcher.js';
import type { ReadTiming } from './read-timing.js';

export type AppsScriptRequest = Readonly<{
  parameter?: Readonly<Record<string, string | undefined>>;
  parameters?: Readonly<Record<string, readonly string[] | undefined>>;
  queryString?: string;
  postData?: Readonly<{ contents?: string; type?: string; length?: number }>;
}>;

export type JsonOutput = Readonly<{
  setMimeType?: (mimeType: string) => unknown;
}>;

export type ContentServiceLike = Readonly<{
  createTextOutput(text: string): JsonOutput;
  MimeType?: { JSON?: string };
}>;

export type AppsScriptAdapterOptions = Readonly<{
  contentService?: ContentServiceLike;
  jsonMimeType?: string;
  timing?: ReadTiming;
}>;

function runtimeContentService(): ContentServiceLike | undefined {
  const runtime = globalThis as unknown as { ContentService?: ContentServiceLike };
  return runtime.ContentService;
}

function jsonText(response: ApiResponse<unknown>): string {
  return JSON.stringify(response);
}

function output(response: ApiResponse<unknown>, options: AppsScriptAdapterOptions): JsonOutput | string {
  if (options.timing) return options.timing.measure('responseConstruction', () => rawOutput(response, options));
  return rawOutput(response, options);
}

function rawOutput(response: ApiResponse<unknown>, options: AppsScriptAdapterOptions): JsonOutput | string {
  const contentService = options.contentService ?? runtimeContentService();
  const text = jsonText(response);
  if (!contentService) return text;
  const result = contentService.createTextOutput(text);
  const mimeType = options.jsonMimeType ?? contentService.MimeType?.JSON ?? 'application/json';
  result.setMimeType?.(mimeType);
  return result;
}

function parseJson(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function queryRequest(event: AppsScriptRequest): unknown {
  const parameter = event.parameter ?? {};
  const rejected = { operation: '', payload: {}, idempotencyKey: 'get-credential-rejected' };
  const encodedRequest = parameter.request;
  if (encodedRequest !== undefined) {
    const parsed = parseJson(encodedRequest);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'credential' in parsed) return rejected;
    if (parsed !== undefined) return parsed;
  }
  if (parameter.credential !== undefined) return rejected;
  const payload = parseJson(parameter.payload) ?? {};
  const request: Record<string, unknown> = {
    operation: parameter.operation,
    payload,
    idempotencyKey: parameter.idempotencyKey
  };
  if (parameter.expectedRevision !== undefined) {
    const parsedRevision = Number(parameter.expectedRevision);
    request.expectedRevision = Number.isSafeInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : parameter.expectedRevision;
  }
  return request;
}

function postRequest(event: AppsScriptRequest): unknown {
  const contents = event.postData?.contents;
  if (!contents) return undefined;
  return parseJson(contents);
}

export type AppsScriptAdapters = Readonly<{
  doGet(event: AppsScriptRequest): JsonOutput | string;
  doPost(event: AppsScriptRequest): JsonOutput | string;
}>;

/**
 * Pure adapters for Apps Script web-app entry points. SpreadsheetApp is not read
 * at module load time; all state and feature behavior enters through the dispatcher.
 */
export function createAppsScriptAdapters(
  dispatcher: IntegrationDispatcher,
  options: AppsScriptAdapterOptions = {}
): AppsScriptAdapters {
  return {
    doGet(event: AppsScriptRequest): JsonOutput | string {
      const response = dispatcher.dispatchReadOnly(queryRequest(event));
      return output(response, options);
    },
    doPost(event: AppsScriptRequest): JsonOutput | string {
      const response = dispatcher.dispatch(postRequest(event));
      return output(response, options);
    }
  };
}

export function doGet(
  event: AppsScriptRequest,
  dispatcher: IntegrationDispatcher,
  options: AppsScriptAdapterOptions = {}
): JsonOutput | string {
  return createAppsScriptAdapters(dispatcher, options).doGet(event);
}

export function doPost(
  event: AppsScriptRequest,
  dispatcher: IntegrationDispatcher,
  options: AppsScriptAdapterOptions = {}
): JsonOutput | string {
  return createAppsScriptAdapters(dispatcher, options).doPost(event);
}
