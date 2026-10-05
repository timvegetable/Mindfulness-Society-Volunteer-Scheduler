export const publicErrorCodes = [
  'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'NOT_FOUND',
  'STALE_REVISION', 'DUPLICATE_REQUEST', 'CONFLICT', 'INTERNAL_ERROR',
] as const;

export type PublicErrorCode = typeof publicErrorCodes[number];

/** Expected failures stay typed until the HTTP boundary serializes them. */
export class AppError extends Error {
  readonly _tag = 'AppError';
  constructor(readonly code: PublicErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}
