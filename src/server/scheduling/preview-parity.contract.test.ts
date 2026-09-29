import { describe, expect, it } from 'vitest';
import { buildFixture } from '../../../scripts/staging/fixture.mjs';
import { INTEGRATION_OPERATIONS } from '../integration/request-policy.js';
import {
  DEPLOYED_FIXTURE_DIGESTS,
  DISPLAY_ZONE,
  EDGE_CASES,
  POST_DST_CLOCK,
  RANDOM_SEEDS,
  REPRESENTATIVE_CLOCK,
  WORKBOOK_ZONE,
  fixtureRows,
  parityInputFor,
  pinnedCase,
  randomCase,
  workbookDigest,
  decodeRows
} from './preview-parity-cases.js';
import { computePreview, computeReferencePreview, differingPaths, runParityCase } from './preview-parity.js';

/**
 * Differential parity between the live preview computation and the frozen
 * pre-optimization implementation (`reference/`). Every case compares the
 * complete preview envelope — identifiers, revision continuity, ordering,
 * shortfall and backup rows — at byte level; the digest per case is what the
 * execution record and the staging cross-checks quote.
 *
 * Baseline evidence for `accelerate-schedule-preview` tasks 1.2/3.1: this suite
 * is the permanent regression parity guard. It must pass without modifying any
 * existing expectation, and the deliberate-change test proves the comparator
 * itself is not a tautology.
 */

describe('preview parity — fixture identity', () => {
  it('regenerates the deployed workbooks digest for digest', async () => {
    // The pinned local fixtures must be the deployed workbooks: row for row,
    // with the same Sheets-typed cells. A divergence here would make every
    // downstream differential number describe a different workbook.
    for (const size of ['representative', 'larger'] as const) {
      const fixture = buildFixture({ size, startDate: '2026-10-05' });
      expect(await workbookDigest(fixtureRows(fixture)), size).toBe(DEPLOYED_FIXTURE_DIGESTS[size]);
    }
  });
});

describe('preview parity — pinned fixtures', () => {
  it('is byte-equal on the representative fixture at the pinned clock', { timeout: 120_000 }, async () => {
    const outcome = await runParityCase('representative@2026-10-05', pinnedCase('representative', REPRESENTATIVE_CLOCK));
    expect(outcome.equal, outcome.differences.join('; ')).toBe(true);
  });

  it('is byte-equal on the representative fixture after the DST transition', { timeout: 120_000 }, async () => {
    const outcome = await runParityCase('representative@2026-11-03', pinnedCase('representative', POST_DST_CLOCK));
    expect(outcome.equal, outcome.differences.join('; ')).toBe(true);
  });

  it('is byte-equal on the larger fixture across the DST transition', { timeout: 300_000 }, async () => {
    const outcome = await runParityCase('larger@2026-10-05', pinnedCase('larger', REPRESENTATIVE_CLOCK));
    expect(outcome.equal, outcome.differences.join('; ')).toBe(true);
  });

  it('is byte-equal on the larger fixture after the DST transition', { timeout: 300_000 }, async () => {
    const outcome = await runParityCase('larger@2026-11-03', pinnedCase('larger', POST_DST_CLOCK));
    expect(outcome.equal, outcome.differences.join('; ')).toBe(true);
  });
});

describe('preview parity — edge cases', () => {
  it('is byte-equal on every edge case', async () => {
    for (const edge of EDGE_CASES) {
      const outcome = await runParityCase(edge.name, edge.computation);
      expect(outcome.equal, `${edge.name}: ${outcome.differences.join('; ')}`).toBe(true);
    }
  });
});

describe('preview parity — randomized workbooks', () => {
  it('is byte-equal across the seeded randomized workbooks', { timeout: 60_000 }, async () => {
    for (const seed of RANDOM_SEEDS) {
      const outcome = await runParityCase(`seed-${seed}`, randomCase(seed));
      expect(outcome.equal, `${seed}: ${outcome.differences.join('; ')}`).toBe(true);
    }
  });
});

describe('preview parity — engine anchor', () => {
  it('computes the same envelope the real preview handler returns', async () => {
    // decodeRows builds the runtime over the same snapshot, so the real handler
    // and the parity engine read identical decoded rows.
    const decoded = decodeRows(fixtureRows(buildFixture({ size: 'representative', startDate: '2026-10-05' })));
    const handler = decoded.runtime.handlers[INTEGRATION_OPERATIONS.adminSchedulePreview];
    if (!handler) throw new Error('preview handler is unavailable');
    const fromHandler = handler({
      actor: { claims: { iss: 'https://accounts.google.com', aud: 'staging', sub: 'parity', email: 'parity@example.test', exp: 0 }, user: { id: 'parity', email: 'parity@example.test', roles: ['administrator'], active: true, revision: 0 }, email: 'parity@example.test' },
      operation: INTEGRATION_OPERATIONS.adminSchedulePreview,
      idempotencyKey: 'preview-parity-anchor',
      now: REPRESENTATIVE_CLOCK
    }, {}) as Record<string, unknown>;
    const fromEngine = computePreview(parityInputFor(decoded, REPRESENTATIVE_CLOCK)).envelope;
    expect(differingPaths(fromEngine, fromHandler, '', 5)).toEqual([]);
  });
});

describe('preview parity — comparator self-test', () => {
  it('reports a field-level diff for a deliberate unrelated change', () => {
    // The scratch comparison task 1.2 requires: an intentional, unrelated edit
    // must surface as concrete field paths, proving the comparator is not a
    // tautology.
    const computation = pinnedCase('representative', REPRESENTATIVE_CLOCK);
    const current = computePreview(computation);
    const reference = computeReferencePreview(computation);
    const altered = structuredClone(reference.envelope) as {
      sessions: Array<{ assignments: Array<{ volunteerId: string }>; displayName: string }>;
    };
    const firstAssignment = altered.sessions[0]?.assignments[0];
    if (!firstAssignment) throw new Error('fixture produced no assignment to mutate');
    firstAssignment.volunteerId = `${firstAssignment.volunteerId}-deliberately-altered`;
    altered.sessions[0]!.displayName = `${altered.sessions[0]!.displayName} (altered)`;
    const paths = differingPaths(current.envelope, altered);
    expect(paths).toContain('sessions[0].assignments[0].volunteerId');
    expect(paths).toContain('sessions[0].displayName');
  });
});
