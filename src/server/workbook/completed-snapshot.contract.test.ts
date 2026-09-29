import { describe, expect, it } from 'vitest';
import { withCompletedSnapshot } from './completed-snapshot.js';
import { ControlError, controlFailureCode, emptyControlRecord, type ControlAuthority, type ControlRecord } from './control.js';

const NOW = '2026-09-29T12:00:00.000Z';
const AUTHORITY: ControlAuthority = 'workbook-control';

function record(overrides: Partial<ControlRecord> = {}): ControlRecord {
  return { ...emptyControlRecord(NOW, 'operator'), authority: AUTHORITY, authorityEpoch: 1, ...overrides };
}

/** A control port that replays a scripted sequence of observations. */
function scripted(observations: readonly ControlRecord[]) {
  let index = 0;
  const calls: number[] = [];
  return {
    calls,
    read: (): ControlRecord => {
      const observation = observations[Math.min(index, observations.length - 1)];
      calls.push(index);
      index += 1;
      if (!observation) throw new Error('no control observation scripted');
      return observation;
    }
  };
}

function expectControlError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a ControlError with code ${code}`);
}

describe('completed-snapshot bracket', () => {
  it('returns hydrated data when both control reads agree', () => {
    const stable = record({ generation: 4, completedGeneration: 4, dataRevision: 9, tabRevisions: { Volunteers: 2 } });
    const control = scripted([stable, stable]);
    let hydrations = 0;

    const snapshot = withCompletedSnapshot({
      readControl: control.read,
      hydrate: () => { hydrations += 1; return ['row-1', 'row-2']; },
      tabs: ['Volunteers'],
      authority: AUTHORITY
    });

    expect(snapshot.data).toEqual(['row-1', 'row-2']);
    expect(snapshot.record).toEqual(stable);
    expect(hydrations).toBe(1);
    expect(control.calls).toEqual([0, 1]);
  });

  it('rejects a concurrent completion between the reads', () => {
    const before = record({ generation: 4, completedGeneration: 4, tabRevisions: { Volunteers: 2 } });
    const after = record({ generation: 6, completedGeneration: 6, dataRevision: 1, tabRevisions: { Volunteers: 3 } });

    expectControlError(() => withCompletedSnapshot({
      readControl: scripted([before, after]).read,
      hydrate: () => ['partial'],
      tabs: ['Volunteers'],
      authority: AUTHORITY
    }), 'GENERATION_CHANGED');
  });

  it('rejects an abort between the reads, where no revision moved at all', () => {
    // The abort advances the generation and leaves every counter untouched:
    // a reader comparing revisions only would accept this snapshot.
    const before = record({ generation: 4, completedGeneration: 4, dataRevision: 7, tabRevisions: { Volunteers: 2 } });
    const after = record({ generation: 5, completedGeneration: 5, dataRevision: 7, tabRevisions: { Volunteers: 2 } });

    expect(before.dataRevision).toBe(after.dataRevision);
    expectControlError(() => withCompletedSnapshot({
      readControl: scripted([before, after]).read,
      hydrate: () => ['rows'],
      tabs: ['Volunteers'],
      authority: AUTHORITY
    }), 'GENERATION_CHANGED');
  });

  it('rejects a recovery between the reads', () => {
    const before = record({ generation: 8, completedGeneration: 7, mutationState: 'pending', operationId: 'op#1', operationTabs: ['Volunteers'] });
    const after = record({ generation: 9, completedGeneration: 9 });

    expectControlError(() => withCompletedSnapshot({
      readControl: scripted([before, after]).read,
      hydrate: () => ['rows'],
      tabs: ['Volunteers'],
      authority: AUTHORITY
    }), 'PENDING');
  });

  it('rejects a snapshot bracketed by a pending mutation', () => {
    const pending = record({ generation: 5, completedGeneration: 4, mutationState: 'pending', operationId: 'op#1', operationTabs: ['Volunteers'] });

    expectControlError(() => withCompletedSnapshot({
      readControl: scripted([pending, pending]).read,
      hydrate: () => ['rows'],
      tabs: ['Volunteers'],
      authority: AUTHORITY
    }), 'PENDING');
  });

  it('refuses to hydrate at all under the wrong authority', () => {
    const foreign = record({ authority: 'script-properties' });
    let hydrations = 0;

    expectControlError(() => withCompletedSnapshot({
      readControl: scripted([foreign, foreign]).read,
      hydrate: () => { hydrations += 1; return ['rows']; },
      tabs: ['Volunteers'],
      authority: AUTHORITY
    }), 'AUTHORITY_MISMATCH');
    expect(hydrations).toBe(0);
  });

  it('accepts a change to a tab the caller did not consume', () => {
    const before = record({ generation: 2, completedGeneration: 2, tabRevisions: { Volunteers: 1, Sessions: 1 } });
    const after = record({ generation: 2, completedGeneration: 2, tabRevisions: { Volunteers: 1, Sessions: 4 } });

    const snapshot = withCompletedSnapshot({
      readControl: scripted([before, after]).read,
      hydrate: () => ['rows'],
      tabs: ['Volunteers'],
      authority: AUTHORITY
    });

    expect(snapshot.data).toEqual(['rows']);
  });

  it('maps its rejections onto the retryable and unavailable API codes', () => {
    const pending = record({ generation: 5, completedGeneration: 4, mutationState: 'pending', operationId: 'op#1', operationTabs: ['Volunteers'] });
    const error = (() => {
      try {
        withCompletedSnapshot({ readControl: scripted([pending, pending]).read, hydrate: () => [], tabs: ['Volunteers'], authority: AUTHORITY });
        return undefined;
      } catch (thrown) {
        return thrown as ControlError;
      }
    })();

    expect(error?.code).toBe('PENDING');
    expect(controlFailureCode(error?.code ?? 'MALFORMED', 'read')).toBe('UNAVAILABLE');
  });
});

describe('cheap rejection paths', () => {
  it('refuses a pending mutation before hydrating, so the domain read is never paid for', () => {
    const pending = record({ generation: 5, completedGeneration: 4, mutationState: 'pending', operationId: 'op#1', operationTabs: ['Volunteers'] });
    let hydrations = 0;

    expectControlError(() => withCompletedSnapshot({
      readControl: scripted([pending, pending]).read,
      hydrate: () => { hydrations += 1; return ['rows']; },
      tabs: ['Volunteers'],
      authority: AUTHORITY
    }), 'PENDING');
    // The read plan prices a pending rejection at one control read: the guard has
    // to decide from the first read rather than after the rows are fetched.
    expect(hydrations).toBe(0);
  });

  it('still hydrates when the first read is idle', () => {
    const idle = record({ generation: 4, completedGeneration: 4 });
    let hydrations = 0;

    withCompletedSnapshot({ readControl: scripted([idle, idle]).read, hydrate: () => { hydrations += 1; return ['rows']; }, tabs: ['Volunteers'], authority: AUTHORITY });

    expect(hydrations).toBe(1);
  });
});
