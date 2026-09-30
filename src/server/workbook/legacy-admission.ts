import type { ControlAuthority, ControlFailureCode, ControlRecord } from './control.js';

/**
 * Whether a process running on the legacy Script Properties authority may admit
 * one mutation.
 *
 * The protocol's whole point is that exactly one authority advances revisions. A
 * legacy process writes domain rows and increments Script Property counters; if
 * the workbook's control record says the portable authority owns those counters,
 * the legacy write advances numbers nobody reads and leaves the record's
 * generation and revisions describing a workbook that has changed underneath it.
 * That fork is silent, which is why this is a refusal rather than a warning.
 *
 * The judgement is pure: the caller supplies what it read, and the decision is a
 * value. It is deliberately stricter than "is the record activated" — an
 * initialized workbook whose record is missing is refused too, because the
 * control structure exists and the only reason no record is readable is that the
 * workbook is half-initialized or the row was removed.
 */

/** The outcome of reading the control record, as the caller observed it. */
export type ControlReadOutcome =
  | { readonly ok: true; readonly record: ControlRecord }
  | { readonly ok: false; readonly code: ControlFailureCode };

export type LegacyAdmissionInput = {
  /** The authority this process is configured for, not the workbook's. */
  readonly authority: ControlAuthority;
  /**
   * Whether the workbook carries any control structure at all. Absent means a
   * workbook that predates the protocol: there is no record to fork, so a legacy
   * write is admitted. Present means the workbook carries the protocol and the
   * record has to justify the write.
   */
  readonly controlTabsPresent: boolean;
  /** What reading the control record produced. */
  readonly outcome: ControlReadOutcome;
};

export type LegacyAdmission =
  | { readonly admit: true; readonly record: ControlRecord | undefined }
  | { readonly admit: false; readonly code: ControlFailureCode; readonly message: string };

const FORK_RISK = 'a legacy write would advance the Script Properties counters while the workbook control record keeps its own, forking the revision authority';

/**
 * A workbook with the control structure but no readable record cannot be shown
 * to be on the Script Properties authority, so it is refused rather than
 * assumed safe. The one exception is a workbook with no control structure at
 * all, which is the pre-protocol state the legacy authority exists for.
 */
function refuse(code: ControlFailureCode, detail: string): LegacyAdmission {
  return { admit: false, code, message: `This workbook carries portable control state: ${detail}; ${FORK_RISK}. Use the reviewed reconciliation or rollback procedure instead.` };
}

export function legacyAdmission(input: LegacyAdmissionInput): LegacyAdmission {
  if (input.authority === 'workbook-control') {
    return refuse('AUTHORITY_MISMATCH', 'this deployment is activated for the portable authority, so a legacy writer must not run at all');
  }
  if (!input.outcome.ok) {
    if (input.outcome.code === 'MISSING' && !input.controlTabsPresent) {
      // Pre-protocol workbook: no control tab, no record, nothing to fork.
      return { admit: true, record: undefined };
    }
    if (input.outcome.code === 'MISSING') {
      return refuse('MISSING', 'the control tabs exist but no control record is readable, so the workbook is half-initialized or the record row was removed');
    }
    return refuse(input.outcome.code, `the control record could not be read (${input.outcome.code.toLowerCase()})`);
  }
  if (input.outcome.record.authority === 'workbook-control') {
    return refuse('AUTHORITY_MISMATCH', 'the control record has already been activated for the portable authority');
  }
  // The record is valid and still on the Script Properties authority, so the
  // legacy counters it mirrors are the authoritative ones.
  return { admit: true, record: input.outcome.record };
}
