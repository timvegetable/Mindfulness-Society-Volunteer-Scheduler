import type { ApiResponse } from '../shared/domain.js';
import { failure, validateRequestEnvelope } from '../server/integration/request-policy.js';
import { READ_API_MAX_REQUEST_BYTES } from './read-api.js';

/**
 * Composition seam for the staging slice.
 *
 * The transport is generic; this function decides what a well-formed request to
 * an allowlisted operation actually does. It currently applies the shared
 * envelope and read-only policy — so a mutation is refused by the same rule the
 * Apps Script dispatcher uses — and then refuses the three served operations,
 * because Google identity verification, the fresh `Users` read and the workbook
 * composition do not exist yet (milestones 3 and 4).
 *
 * Refusing is deliberate: an endpoint that is not yet able to verify identity
 * must not serve workbook data, and it must not pretend to succeed.
 */
export function createStagingDispatch(): (input: unknown) => Promise<ApiResponse<unknown>> {
  return async (input) => {
    const validation = validateRequestEnvelope(input, { readOnly: true, maxPayloadBytes: READ_API_MAX_REQUEST_BYTES });
    if (!validation.ok) return validation.response;
    return failure('UNAVAILABLE', 'The staging read service is not configured.');
  };
}
