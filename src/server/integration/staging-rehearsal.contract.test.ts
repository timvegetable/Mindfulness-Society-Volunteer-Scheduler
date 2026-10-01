import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIRE_MS, INJECTION_KINDS, DEFAULT_STRADDLE_EXPECTATION, DEFAULT_STRADDLE_OPERATION, parseArgs, privateCredentialPath, requiresStagingConfirmation, stagingWorkerUrl } from '../../../scripts/staging/rehearsal-arguments.js';
import { capturedCounters, controlWriterOverRest } from '../../../scripts/staging/rehearsal-transitions.js';
import { activationTransition, CONTROL_LIMITS, controlCounters, controlRecordFromRows, emptyControlRecord, initializeControlRecord, JOURNAL_COLUMNS, rollbackTransition, serializeControlRecord, serializeJournalEntry, type ControlRecord } from '../workbook/control.js';
import { tabDefinition } from '../workbook/schema.js';

const HOST_DEPLOYED_AT = '2026-10-01T12:00:00.000Z';

/**
 * The rehearsal runner addresses synthetic workbooks by role and refuses anything
 * that could reach a different one: no raw spreadsheet id, no unconfirmed
 * mutation. These tests import the module (which is why its entry point is
 * guarded) and never contact a workbook.
 */
describe('rehearsal runner arguments', () => {
  it('requires a role and refuses one that is not a synthetic fixture', () => {
    expect(() => parseArgs(['baseline'])).toThrowError(/--role/u);
    expect(() => parseArgs(['baseline', '--role', 'production'])).toThrowError(/representative or larger/u);
  });

  it('accepts the documented invocations', () => {
    expect(parseArgs(['baseline', '--role', 'larger'])).toMatchObject({ command: 'baseline', role: 'larger', confirm: false, tabs: [], actor: 'rehearsal@example.test' });
    expect(parseArgs(['transition', '--role', 'representative', '--event', 'begin', '--tabs', 'Assignments, Volunteers', '--confirm-staging'])).toMatchObject({
      command: 'transition',
      event: 'begin',
      tabs: ['Assignments', 'Volunteers'],
      confirm: true
    });
    expect(parseArgs(['capture', '--role', 'representative', '--data-revision', '42', '--input-revision', '5', '--tab-revisions', '{"Volunteers":1}'])).toMatchObject({
      dataRevision: 42,
      inputRevision: 5,
      tabRevisions: { Volunteers: 1 }
    });
  });

  it('accepts the straddle invocation and defaults the race to the pinned refusal', () => {
    const straddle = parseArgs(['straddle', '--role', 'representative', '--worker-url', 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec', '--credential', 'staging-local/credential-rehearsal.txt', '--host-deployed-at', HOST_DEPLOYED_AT, '--confirm-staging']);

    expect(straddle).toMatchObject({
      command: 'straddle',
      workerUrl: 'https://volunteer-scheduling-staging-gateway.example.workers.dev/exec',
      credentialPath: 'staging-local/credential-rehearsal.txt',
      expectedHostDeployedAt: HOST_DEPLOYED_AT,
      confirm: true
    });
    expect(DEFAULT_STRADDLE_OPERATION).toBe('admin.schedule.read');
    expect(DEFAULT_STRADDLE_EXPECTATION).toBe('STALE_REVISION:control-generation_changed');
    expect(DEFAULT_FIRE_MS).toBe(1500);
  });

  it('accepts every injection kind the read matrix has to see refused', () => {
    for (const kind of INJECTION_KINDS) {
      expect(parseArgs(['inject', '--role', 'representative', '--kind', kind, '--confirm-staging'])).toMatchObject({ command: 'inject', kind, confirm: true });
    }
    expect(parseArgs(['restore', '--role', 'representative', '--from', 'staging-local/rehearsal-inject-snapshot-representative-x.json', '--confirm-staging'])).toMatchObject({
      command: 'restore',
      from: 'staging-local/rehearsal-inject-snapshot-representative-x.json'
    });
  });

  it('accepts an explicit operation, expectation and fire delay', () => {
    expect(parseArgs(['straddle', '--role', 'larger', '--operation', 'admin.insights.read', '--expect', 'failed:UNAVAILABLE:control-pending', '--fire-ms', '250', '--host-deployed-at', HOST_DEPLOYED_AT])).toMatchObject({
      operation: 'admin.insights.read',
      expect: 'failed:UNAVAILABLE:control-pending',
      fireMs: 250
    });
    expect(parseArgs(['straddle', '--role', 'larger', '--expect', 'ok', '--host-deployed-at', HOST_DEPLOYED_AT])).toMatchObject({ expect: 'ok' });
    // The straddle's own form names the code first, with or without the
    // `failed:` prefix the read-matrix lists use.
    expect(parseArgs(['straddle', '--role', 'larger', '--expect', 'STALE_REVISION:control-generation_changed', '--host-deployed-at', HOST_DEPLOYED_AT])).toMatchObject({ expect: 'STALE_REVISION:control-generation_changed' });
    expect(parseArgs(['straddle', '--role', 'larger', '--expect', 'failed:UNAVAILABLE:control-pending', '--host-deployed-at', HOST_DEPLOYED_AT])).toMatchObject({ expect: 'failed:UNAVAILABLE:control-pending' });
  });

  it('requires a canonical expected Worker deployment marker for straddle', () => {
    expect(() => parseArgs(['straddle', '--role', 'representative'])).toThrowError(/--host-deployed-at/u);
    expect(() => parseArgs(['straddle', '--role', 'representative', '--host-deployed-at', '2026-10-01'])).toThrowError(/canonical UTC/u);
  });

  it('keeps a deployment target on https and staging-shaped', () => {
    expect(stagingWorkerUrl('https://volunteer-scheduling-staging-gateway.example.workers.dev/exec')).toBe('https://volunteer-scheduling-staging-gateway.example.workers.dev/exec');
    expect(() => stagingWorkerUrl('https://gateway.example.test/exec')).toThrowError(/staging deployment host/u);
    expect(() => stagingWorkerUrl('http://staging.example.test/exec')).toThrowError(/https/u);
  });

  it('keeps a private file inside the private staging directory', () => {
    expect(privateCredentialPath('staging-local/credential-rehearsal.txt')).toBe('staging-local/credential-rehearsal.txt');
    // The runner prints absolute snapshot paths, and refusing them once turned a
    // restore into a silent no-op that left a pending marker in the workbook.
    const absolute = resolve('staging-local/rehearsal-inject-snapshot-representative-x.json');
    expect(privateCredentialPath(absolute, '--from')).toBe(absolute);
    expect(() => privateCredentialPath('staging-local/../credential.txt')).toThrowError(/staging-local/u);
    expect(() => privateCredentialPath('/tmp/credential.txt')).toThrowError(/staging-local/u);
    expect(() => privateCredentialPath('/tmp/credential.txt', '--from')).toThrowError(/--from/u);
  });

  it.each([
    ['an unknown flag', ['baseline', '--role', 'larger', '--spreadsheet', 'abc']],
    ['an unknown event', ['transition', '--role', 'larger', '--event', 'publish']],
    ['an unknown decision', ['transition', '--role', 'larger', '--event', 'recover', '--decision', 'maybe']],
    ['an unknown authority', ['rollback', '--role', 'larger', '--authority', 'either']],
    ['a negative revision', ['capture', '--role', 'larger', '--data-revision', '-1']],
    ['tab counters that are not an object', ['capture', '--role', 'larger', '--tab-revisions', '[1,2]']],
    ['tab counters that are not integers', ['capture', '--role', 'larger', '--tab-revisions', '{"Volunteers":"1"}']],
    ['a flag without its value', ['baseline', '--role']],
    ['a negative fire delay', ['straddle', '--role', 'larger', '--fire-ms', '-1']],
    ['a fire delay beyond the window', ['straddle', '--role', 'larger', '--fire-ms', '60001']],
    ['a non-integer fire delay', ['straddle', '--role', 'larger', '--fire-ms', '1.5']],
    ['an expectation that is not ok or failed:CODE[:reason]', ['straddle', '--role', 'larger', '--expect', 'maybe']],
    ['an expectation with a lowercase code', ['straddle', '--role', 'larger', '--expect', 'failed:stale']],
    ['an expectation with no code at all', ['straddle', '--role', 'larger', '--expect', ':reason']],
    ['a worker URL that is not https', ['straddle', '--role', 'larger', '--worker-url', 'http://staging.example.test/exec']],
    ['a worker URL that is not a URL', ['straddle', '--role', 'larger', '--worker-url', 'not-a-url']],
    ['a credential outside the private directory', ['straddle', '--role', 'larger', '--credential', 'secrets/token.txt']],
    ['a credential that escapes the private directory', ['straddle', '--role', 'larger', '--credential', 'staging-local/../token.txt']],
    ['an empty operation', ['straddle', '--role', 'larger', '--operation', '  ']],
    ['an injection kind that is not a control state', ['inject', '--role', 'larger', '--kind', 'broken']],
    ['a restore snapshot outside the private directory', ['restore', '--role', 'larger', '--from', '/tmp/snapshot.json']]
  ])('refuses %s', (_label, argv) => {
    const withExpectedHost = argv[0] === 'straddle'
      ? [...argv, '--host-deployed-at', HOST_DEPLOYED_AT]
      : argv;
    expect(() => parseArgs(withExpectedHost as string[])).toThrowError(/./u);
  });
});

describe('rehearsal runner confirmation gate', () => {
  it('treats only the reading subcommands as safe without --confirm-staging', () => {
    expect(requiresStagingConfirmation('baseline')).toBe(false);
    expect(requiresStagingConfirmation('verify')).toBe(false);
    // Reading the live record and judging it changes nothing; racing a read
    // against a transition pair writes the control row, so it is a mutation.
    expect(requiresStagingConfirmation('legacy-admission')).toBe(false);
    for (const command of ['initialize', 'capture', 'transition', 'rollback', 'fixture', 'cleanup', 'straddle', 'inject', 'restore']) {
      expect(requiresStagingConfirmation(command), command).toBe(true);
    }
  });
});

/**
 * The runner's transitions must be the production ones. The earlier hand-built
 * authority row is what produced the rollback defect this rehearsal is meant to
 * rule out, so the contract is asserted against the transitions themselves
 * rather than against a copy of their arithmetic.
 */
describe('rehearsal transitions over REST', () => {
  const AT = '2026-09-30T02:00:00.000Z';
  const controlColumns = tabDefinition('WorkbookControl').columns;
  const journalColumns = JOURNAL_COLUMNS;

  function serializedRecord(overrides: Partial<ControlRecord> = {}): unknown[] {
    return serializeControlRecord({
      ...emptyControlRecord(AT, 'operator@example.test'),
      authorityEpoch: 3,
      authority: 'script-properties',
      generation: 8,
      completedGeneration: 8,
      dataRevision: 41,
      schedulingInputRevision: 5,
      tabRevisions: { Volunteers: 2 },
      ...overrides
    });
  }

  /** A REST client double that records the order of its writes. */
  function fakeApi(controlRow: unknown[] | undefined, journal: unknown[][] = []) {
    const order: string[] = [];
    const journalRows = [...journal];
    let current = controlRow;
    return {
      order,
      journalRows,
      written: () => current,
      api: {
        readTabs: async () => ({ WorkbookControl: current === undefined ? [] : [current], ControlJournal: journalRows }),
        writeControlRow: async (_name: string, row: unknown[]) => { order.push('control'); current = row; return 1; },
        replaceControlRows: async (_name: string, rows: readonly unknown[][]) => { order.push('control'); current = rows[0] ? [...rows[0]] : undefined; return rows.length; },
        appendRow: async (_name: string, values: unknown[]) => { order.push('journal'); journalRows.push(values); return 1; }
      }
    };
  }

  async function facade(controlRow: unknown[] | undefined, journal: unknown[][] = []) {
    const double = fakeApi(controlRow, journal);
    const overRest = await controlWriterOverRest(double.api, { at: AT, controlColumns, journalColumns });
    return { ...double, ...overRest };
  }

  it('captures through activationTransition, seeding the production empty record first', async () => {
    const { writer, controlSheet, apply, written, order, journalRows } = await facade(undefined);

    const seeded = initializeControlRecord(controlSheet, AT, 'operator@example.test');
    const captured = { dataRevision: 46, schedulingInputRevision: 6, tabRevisions: { Volunteers: 3 } };
    const { record } = writer.activate({ captured, actorId: 'operator@example.test', reason: 'rehearsal capture' });
    await apply();

    expect(seeded.created).toBe(true);
    const expected = activationTransition(seeded.record, { captured, actorId: 'operator@example.test', reason: 'rehearsal capture' }, AT);
    expect(written()).toEqual(serializeControlRecord(expected));
    expect(record).toEqual(expected);
    expect(record).toMatchObject({ authority: 'workbook-control', authorityEpoch: 1, generation: 1, completedGeneration: 1, dataRevision: 46, schedulingInputRevision: 6 });
    // Journal first, then the control row: a crash between them leaves an
    // auditable attempt rather than a silent switch.
    expect(order).toEqual(['journal', 'control']);
    expect(journalRows.at(-1)).toEqual(serializeJournalEntry({
      id: expect.any(String) as unknown as string,
      generation: expected.generation,
      event: 'activate',
      operationId: '',
      actorId: 'operator@example.test',
      tabs: ['Volunteers'],
      before: controlCounters(seeded.record),
      after: controlCounters(expected),
      reason: 'rehearsal capture',
      timestamp: AT
    }));
  });

  it('takes every counter as max(captured, current) rather than trusting the capture', async () => {
    const { writer, apply, written } = await facade(serializedRecord({ dataRevision: 46, schedulingInputRevision: 6, tabRevisions: { Volunteers: 3, Centers: 1 } }));

    const { record } = writer.activate({ captured: { dataRevision: 42, schedulingInputRevision: 5, tabRevisions: { Volunteers: 2 } }, actorId: 'operator@example.test', reason: 'stale capture' });
    await apply();

    expect(record).toMatchObject({ dataRevision: 46, schedulingInputRevision: 6, tabRevisions: { Volunteers: 3, Centers: 1 } });
    expect(written()).toEqual(serializeControlRecord(record));
  });

  it('rolls back through rollbackTransition and refuses a second rollback', async () => {
    const activated = serializedRecord({ authority: 'workbook-control', authorityEpoch: 4, dataRevision: 46, schedulingInputRevision: 6, tabRevisions: { Volunteers: 3 } });
    const { writer, apply, written, order, journalRows } = await facade(activated);

    const captured = { dataRevision: 40, schedulingInputRevision: 4, tabRevisions: { Volunteers: 1 } };
    const { record } = writer.revert({ captured, actorId: 'operator@example.test', reason: 'approved rollback' });
    await apply();

    const before = controlRecordFromRows([activated]);
    const expected = rollbackTransition(before, { captured, actorId: 'operator@example.test', reason: 'approved rollback' }, AT);
    expect(written()).toEqual(serializeControlRecord(expected));
    expect(record).toMatchObject({ authority: 'script-properties', authorityEpoch: 5, generation: 9, completedGeneration: 9, dataRevision: 46, schedulingInputRevision: 6 });
    expect(order).toEqual(['journal', 'control']);
    const entry = Object.fromEntries(journalColumns.map((column, index) => [column, (journalRows.at(-1) ?? [])[index]]));
    expect(entry).toMatchObject({ event: 'rollback', reason: 'approved rollback', generation: 9 });
    // The record the writer just wrote is no longer on the portable authority,
    // so a repeated rollback stops instead of advancing the epoch again.
    expect(() => writer.revert({ captured, actorId: 'operator@example.test', reason: 'again' })).toThrowError(/authority is script-properties/u);
  });

  it('refuses a capture that does not supply the deployment counters', () => {
    expect(() => capturedCounters({ dataRevision: 1, inputRevision: 2 })).toThrowError(/--tab-revisions/u);
    expect(() => capturedCounters({ dataRevision: 1, tabRevisions: {} })).toThrowError(/--input-revision/u);
    expect(capturedCounters({ dataRevision: 1, inputRevision: 2, tabRevisions: { Volunteers: 1 } })).toEqual({ dataRevision: 1, schedulingInputRevision: 2, tabRevisions: { Volunteers: 1 } });
  });

  it('reserves the default journal slot before a transition and allows the final available slot', async () => {
    const retainedRows = (count: number) => Array.from({ length: count }, (_unused, index) => [`prior-${index}`]);
    const atCapacity = fakeApi(serializedRecord(), retainedRows(CONTROL_LIMITS.journalEntries));
    await expect(controlWriterOverRest(atCapacity.api, { at: AT, controlColumns, journalColumns }))
      .rejects.toThrowError(/journal capacity.*200.*1 required/u);
    expect(atCapacity.order).toEqual([]);
    expect(atCapacity.journalRows).toHaveLength(CONTROL_LIMITS.journalEntries);

    const oneSlotLeft = fakeApi(serializedRecord(), retainedRows(CONTROL_LIMITS.journalEntries - 1));
    const facade = await controlWriterOverRest(oneSlotLeft.api, { at: AT, controlColumns, journalColumns });
    facade.writer.activate({ captured: { dataRevision: 41, schedulingInputRevision: 5, tabRevisions: { Volunteers: 2 } }, actorId: 'operator@example.test', reason: 'last journal slot' });
    await facade.apply();

    expect(oneSlotLeft.order).toEqual(['journal', 'control']);
    expect(oneSlotLeft.journalRows).toHaveLength(CONTROL_LIMITS.journalEntries);
  });
});
