import type { ApiResponse } from '../shared/domain.js';
import { createStagingReadService, isolateDependencyCache, type StagingServiceOptions } from './staging.js';

/**
 * The dispatch seam the transport calls.
 *
 * The composition itself lives in `staging.ts`; this module exists so the
 * transport depends on a single function rather than on the workbook, identity
 * and policy layers at once.
 */
export { isolateDependencyCache };
export type StagingDispatchOptions = StagingServiceOptions;

export function createStagingDispatch(
  bindings: Record<string, unknown> = {},
  options: StagingServiceOptions = {}
): (input: unknown) => Promise<ApiResponse<unknown>> {
  const service = createStagingReadService(bindings, options);
  return (input) => service.handle(input);
}
