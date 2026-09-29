import { stableJson } from '../integration/projection-diff.js';
import {
  scheduleProjection,
  type ScheduleReadState,
  type ScheduleRows
} from '../runtime.js';
import { SchedulingStore, runScheduling, type SchedulingRunInput } from './publication.js';
import { runReferenceScheduling, type ReferenceRunInput } from './reference/publication.js';
import type { ScheduleResult } from './scheduler.js';
import type { Center } from '../centers/models.js';
import type { Assignment, AvailabilityException, Backup, Session, Shortfall, SchedulingRun, Volunteer } from '../../shared/domain.js';

/**
 * Differential parity harness for the schedule preview (`accelerate-schedule-preview`).
 *
 * It runs the live preview computation and the frozen pre-optimization
 * implementation (`reference/`) side by side over identical inputs and compares
 * the complete results: the raw `ScheduleResult` and the full preview envelope
 * exactly as `scheduleProjection` assembles it for `admin.schedule.preview` —
 * identifiers, revisions, ordering, shortfalls, backups and summary. Equality
 * is byte-level (`stableJson` over the whole envelope), and `differingPaths`
 * names concrete field paths for any mismatch.
 *
 * The orchestration mirrors the preview handler in `runtime.ts` (cutoff at the
 * request clock, staged publication through the shared `SchedulingStore`, then
 * projection assembly), and the contract test anchors that mirror to the real
 * handler, so drift between the harness and the handler fails loudly.
 */

/** The exact computation the preview handler performs, minus workbook plumbing. */
export type PreviewComputationInput = {
  /** Roster with hydrated recurring availability, as `hydratedVolunteers` produces. */
  volunteers: readonly Volunteer[];
  /**
   * Sessions as the handler passes them to the scheduler: the output of
   * `validateCommittedSessionInputs` over the workbook's session rows.
   */
  sessions: readonly Session[];
  /** The workbook's raw session rows; the projection reads them for exclusions. */
  workbookSessions: readonly Session[];
  exceptions: readonly AvailabilityException[];
  assignments: readonly Assignment[];
  centers: readonly Center[];
  inputRevision: number;
  /** The stored run the preview reads; `undefined` means no completed run exists. */
  previous: SchedulingRun | undefined;
  globalRevision: number;
  schedulingTimeZone: string;
  /** The request clock: deterministic cutoff, `createdAt` and `computedAt`. */
  requestNow: string;
};

export type PreviewComputationResult = {
  calculation: ScheduleResult;
  /** Published rows as `publishRun` returned them (staged revision attached). */
  published: { revision: number; assignments: Assignment[]; backups: Backup[]; shortfalls: Shortfall[] };
  /** The complete preview envelope, exactly as the handler returns it. */
  envelope: Record<string, unknown>;
};

const PARITY_RUN_ID = 'preview-parity';

function runInput(computation: PreviewComputationInput): SchedulingRunInput {
  const input: SchedulingRunInput = {
    inputRevision: computation.inputRevision,
    actorId: 'administrator-preview',
    volunteers: computation.volunteers,
    sessions: computation.sessions,
    exceptions: computation.exceptions,
    assignments: computation.assignments,
    runId: PARITY_RUN_ID,
    startedAt: computation.requestNow
  };
  if (computation.schedulingTimeZone !== undefined) input.schedulingTimeZone = computation.schedulingTimeZone;
  return input;
}

function previewState(computation: PreviewComputationInput): ScheduleReadState {
  return {
    globalRevision: computation.globalRevision,
    schedulingInput: computation.inputRevision,
    run: computation.previous,
    preview: true,
    computedAt: computation.requestNow,
    schedulingTimeZone: computation.schedulingTimeZone
  };
}

/** Projection needs three tab projections only; the stub serves their list(). */
function projectionRepositories(computation: PreviewComputationInput) {
  return {
    sessions: { list: () => [...computation.workbookSessions] },
    volunteers: { list: () => [...computation.volunteers] },
    centers: { list: () => [...computation.centers] }
  } as unknown as Parameters<typeof scheduleProjection>[0];
}

/** Envelope assembly from a published result, exactly as the preview handler does. */
export function previewEnvelope(computation: PreviewComputationInput, published: PreviewComputationResult['published']): Record<string, unknown> {
  const rows: ScheduleRows = { assignments: published.assignments, backups: published.backups, outputRevision: published.revision };
  return scheduleProjection(projectionRepositories(computation), rows, previewState(computation));
}

/** The live computation, as the preview handler performs it today. */
export function computePreview(computation: PreviewComputationInput): PreviewComputationResult {
  const store = new SchedulingStore({ inputRevision: computation.inputRevision, currentRevision: computation.previous?.outputRevision ?? 0 });
  const result = runScheduling(store, runInput(computation));
  return toResult(result.schedule.revision, result.calculation, result.schedule.assignments, result.schedule.backups, result.schedule.shortfalls, computation);
}

/** The frozen pre-optimization computation over the same inputs. */
export function computeReferencePreview(computation: PreviewComputationInput): PreviewComputationResult {
  const store = new SchedulingStore({ inputRevision: computation.inputRevision, currentRevision: computation.previous?.outputRevision ?? 0 });
  const referenceInput = runInput(computation) as unknown as ReferenceRunInput;
  const result = runReferenceScheduling(store, referenceInput);
  return toResult(result.revision, result.calculation, result.assignments, result.backups, result.shortfalls, computation);
}

function toResult(
  revision: number,
  calculation: ScheduleResult,
  assignments: Assignment[],
  backups: Backup[],
  shortfalls: Shortfall[],
  computation: PreviewComputationInput
): PreviewComputationResult {
  const published = { revision, assignments, backups, shortfalls };
  return { calculation, published, envelope: previewEnvelope(computation, published) };
}

/**
 * Recursive field-path diff. Returns concrete paths (e.g.
 * `sessions[3].assignments[0].volunteerId`) whose values differ, capped at
 * `limit` entries so a mismatch stays readable.
 */
export function differingPaths(left: unknown, right: unknown, prefix = '', limit = 40): string[] {
  if (stableJson(left) === stableJson(right)) return [];
  const bothObjects = isPlainObject(left) && isPlainObject(right);
  const bothArrays = Array.isArray(left) && Array.isArray(right);
  if (!bothObjects && !bothArrays) return prefix === '' ? ['(value)'] : [prefix];
  const paths: string[] = [];
  if (bothArrays) {
    const length = Math.max((left as unknown[]).length, (right as unknown[]).length);
    for (let index = 0; index < length && paths.length < limit; index += 1) {
      paths.push(...differingPaths((left as unknown[])[index], (right as unknown[])[index], `${prefix}[${index}]`, limit - paths.length));
    }
  } else {
    const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
    for (const key of [...keys].sort()) {
      if (paths.length >= limit) break;
      paths.push(...differingPaths((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], prefix === '' ? key : `${prefix}.${key}`, limit - paths.length));
    }
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type ParityOutcome = {
  name: string;
  /** SHA-256 over the canonical current envelope, for cross-run comparison. */
  digest: string;
  equal: boolean;
  /** Concrete differing field paths; empty when equal. */
  differences: string[];
};

export async function runParityCase(name: string, computation: PreviewComputationInput): Promise<ParityOutcome> {
  const current = computePreview(computation);
  const reference = computeReferencePreview(computation);
  const differences = differingPaths(current.envelope, reference.envelope);
  return { name, digest: await digestOf(current.envelope), equal: differences.length === 0, differences };
}

/** Deterministic digest over a complete envelope (or any value), for recorded reports. */
export async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
