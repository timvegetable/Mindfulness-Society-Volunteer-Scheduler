import { describe, expect, it } from 'vitest';
import {
  beginMutationRecord,
  CONTROL_COLUMNS,
  CONTROL_LIMITS,
  controlOperationId,
  emptyControlRecord,
  JOURNAL_COLUMNS,
  serializeControlRecord,
  type ControlRecord
} from '../workbook/control.js';
import { tabDefinition } from '../workbook/schema.js';
import { createInjectionSnapshot, restoreInjectedControlSnapshot } from '../../../scripts/staging/rehearsal-transitions.js';
import { INJECTION_KINDS, type InjectionKind, type Role } from '../../../scripts/staging/rehearsal-arguments.js';

const AT = '2026-10-01T12:00:00.000Z';
const ROLE: Role = 'representative';
const ACTOR = 'rehearsal@example.test';
const REASON = 'Restore the approved injection from the role-matched snapshot.';
const COLUMNS = tabDefinition('WorkbookControl').columns;

function baselineRecord(): ControlRecord {
  return {
    ...emptyControlRecord(AT, ACTOR),
    authorityEpoch: 4,
    authority: 'workbook-control',
    generation: 8,
    completedGeneration: 8,
    dataRevision: 41,
    schedulingInputRevision: 5,
    tabRevisions: { Volunteers: 2 }
  };
}

function injectedRows(kind: InjectionKind, baseline: ControlRecord): unknown[][] {
  const baseRow = serializeControlRecord(baseline);
  if (kind === 'missing') return [];
  if (kind === 'duplicate') return [[...baseRow], [...baseRow]];
  if (kind === 'pending') {
    const pending = beginMutationRecord(baseline, {
      operationId: controlOperationId('rehearsal.inject'),
      tabs: ['Assignments'],
      actorId: ACTOR
    }, AT);
    return [serializeControlRecord(pending)];
  }
  const row = [...baseRow];
  if (kind === 'malformed') row[CONTROL_COLUMNS.indexOf('protocolVersion')] = 'two';
  else if (kind === 'unsupported') row[CONTROL_COLUMNS.indexOf('protocolVersion')] = 99;
  else row[CONTROL_COLUMNS.indexOf('authority')] = 'script-properties';
  return [row];
}

function fakeApi(initialRows: unknown[][], initialJournalRows: unknown[][] = []) {
  let controlRows = initialRows.map((row) => [...row]);
  const journalRows: unknown[][] = initialJournalRows.map((row) => [...row]);
  const order: string[] = [];
  return {
    order,
    journalRows,
    current: () => controlRows,
    api: {
      readTabs: async () => ({ WorkbookControl: controlRows, ControlJournal: journalRows }),
      writeControlRow: async (_name: string, row: unknown[]) => {
        order.push('control');
        controlRows = [[...row], ...controlRows.slice(1).map((prior) => [...prior])];
        return 1;
      },
      replaceControlRows: async (_name: string, rows: readonly unknown[][]) => {
        order.push('control');
        controlRows = rows.map((row) => [...row]);
        return 1;
      },
      appendRow: async (_name: string, row: unknown[]) => {
        order.push('journal');
        journalRows.push([...row]);
        return 1;
      }
    }
  };
}

function snapshotFor(kind: InjectionKind, baseline = baselineRecord()) {
  const rows = injectedRows(kind, baseline);
  return createInjectionSnapshot({
    role: ROLE,
    kind,
    at: AT,
    controlRows: [serializeControlRecord(baseline)],
    injectedRows: rows
  });
}

describe('staging injection snapshot restoration', () => {
  it('records the role, injected kind and complete prior valid tuple', () => {
    const baseline = baselineRecord();
    const snapshot = snapshotFor('pending', baseline);

    expect(snapshot).toMatchObject({
      role: ROLE,
      kind: 'pending',
      priorValidTuple: {
        generation: baseline.generation,
        completedGeneration: baseline.completedGeneration,
        authority: 'workbook-control',
        authorityEpoch: baseline.authorityEpoch,
        mutationState: 'idle',
        dataRevision: baseline.dataRevision,
        schedulingInputRevision: baseline.schedulingInputRevision,
        tabRevisions: { Volunteers: 2 },
        idle: true
      }
    });
    expect(snapshot.injectedRows).toHaveLength(1);
  });

  it.each(INJECTION_KINDS)('%s restore advances beyond every valid observed generation and preserves counters', async (kind) => {
    const baseline = baselineRecord();
    const snapshot = snapshotFor(kind, baseline);
    const double = fakeApi(snapshot.injectedRows);
    const result = await restoreInjectedControlSnapshot(double.api, {
      snapshot,
      role: ROLE,
      actorId: ACTOR,
      reason: REASON,
      at: '2026-10-01T12:05:00.000Z',
      controlColumns: COLUMNS,
      journalColumns: JOURNAL_COLUMNS
    });

    expect(result.record.authority).toBe('workbook-control');
    expect(result.record.mutationState).toBe('idle');
    expect(result.record.generation).toBeGreaterThan(result.generationFloor);
    expect(result.generationFloor).toBe(kind === 'pending' ? baseline.generation + 1 : baseline.generation);
    expect(result.record.dataRevision).toBe(baseline.dataRevision);
    expect(result.record.schedulingInputRevision).toBe(baseline.schedulingInputRevision);
    expect(result.record.tabRevisions).toEqual(baseline.tabRevisions);
    expect(result.record.generation).toBe(baseline.generation + 2);
    expect(result.recoveryMode).toBe(kind === 'pending' ? 'recover-pending' : 'begin-then-recover');

    const eventIndex = JOURNAL_COLUMNS.indexOf('event');
    const reasonIndex = JOURNAL_COLUMNS.indexOf('reason');
    expect(double.journalRows.map((row) => row[eventIndex])).toEqual(kind === 'pending' ? ['recover'] : ['begin', 'recover']);
    expect(double.journalRows.at(-1)?.[reasonIndex]).toBe(REASON);
    expect(double.order).toEqual(kind === 'pending'
      ? ['journal', 'control']
      : ['journal', 'control', 'journal', 'control']);
    if (kind === 'duplicate') expect(double.current()).toHaveLength(1);
    expect(result.events).toEqual(kind === 'pending' ? ['recover'] : ['begin', 'recover']);
  });

  it('refuses a two-event repair before the begin write when only one journal slot remains', async () => {
    const snapshot = snapshotFor('malformed');
    const retainedRows = Array.from({ length: CONTROL_LIMITS.journalEntries - 1 }, (_unused, index) => [`prior-${index}`]);
    const double = fakeApi(snapshot.injectedRows, retainedRows);

    await expect(restoreInjectedControlSnapshot(double.api, {
      snapshot,
      role: ROLE,
      actorId: ACTOR,
      reason: REASON,
      at: '2026-10-01T12:05:00.000Z',
      controlColumns: COLUMNS,
      journalColumns: JOURNAL_COLUMNS
    })).rejects.toThrowError(/journal capacity.*199.*2 required/u);

    expect(double.order).toEqual([]);
    expect(double.journalRows).toHaveLength(CONTROL_LIMITS.journalEntries - 1);
    expect(double.current()).toEqual(snapshot.injectedRows);
  });

  it('refuses a snapshot for another fixture role before writing', async () => {
    const snapshot = snapshotFor('missing');
    const double = fakeApi(injectedRows('missing', baselineRecord()));

    await expect(restoreInjectedControlSnapshot(double.api, {
      snapshot,
      role: 'larger',
      actorId: ACTOR,
      reason: REASON,
      at: '2026-10-01T12:05:00.000Z',
      controlColumns: COLUMNS,
      journalColumns: JOURNAL_COLUMNS
    })).rejects.toThrowError(/snapshot is for role representative/u);
    expect(double.order).toEqual([]);
  });

  it('refuses an unrelated newer valid control record instead of overwriting it', async () => {
    const baseline = baselineRecord();
    const snapshot = snapshotFor('malformed', baseline);
    const newer: ControlRecord = {
      ...baseline,
      generation: baseline.generation + 2,
      completedGeneration: baseline.generation + 2,
      dataRevision: baseline.dataRevision + 1,
      updatedAt: '2026-10-01T12:04:00.000Z'
    };
    const double = fakeApi([serializeControlRecord(newer)]);

    await expect(restoreInjectedControlSnapshot(double.api, {
      snapshot,
      role: ROLE,
      actorId: ACTOR,
      reason: REASON,
      at: '2026-10-01T12:05:00.000Z',
      controlColumns: COLUMNS,
      journalColumns: JOURNAL_COLUMNS
    })).rejects.toThrowError(/newer valid control record/u);
    expect(double.order).toEqual([]);
    expect(double.current()).toEqual([serializeControlRecord(newer)]);
  });

  it('refuses to restore after the live state no longer matches the injected rows', async () => {
    const baseline = baselineRecord();
    const snapshot = snapshotFor('authority', baseline);
    const changed = { ...baseline, dataRevision: baseline.dataRevision + 1 };
    const double = fakeApi([serializeControlRecord(changed)]);

    await expect(restoreInjectedControlSnapshot(double.api, {
      snapshot,
      role: ROLE,
      actorId: ACTOR,
      reason: REASON,
      at: '2026-10-01T12:05:00.000Z',
      controlColumns: COLUMNS,
      journalColumns: JOURNAL_COLUMNS
    })).rejects.toThrowError(/do not match the authority injection/u);
    expect(double.order).toEqual([]);
  });
});
