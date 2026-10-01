// The rehearsal runner's control-tab transitions.
//
// Separately importable for the same reason `rehearsal-arguments.ts` is: the
// runner executes `main()` on import, so anything worth testing has to live
// outside it.
//
// The production `ControlMutationWriter` is synchronous because Apps Script is,
// so it cannot be handed the REST client directly. This module fetches both
// control tabs, builds an in-memory mirror, lets the *real* writer perform the
// transition and journal it in production order, and applies the resulting rows
// over REST afterwards. The authority check, the idle check, the counter
// arithmetic and the journal shape are therefore the production ones rather than
// a reimplementation — the hand-built authority row this replaces is what
// produced the earlier rollback defect.
import { InMemorySheet } from '../../src/server/workbook/in-memory-sheet.js';
import {
  CONTROL_LIMITS,
  ControlError,
  ControlMutationWriter,
  controlOperationId,
  controlRecordFromRows,
  serializeControlRecord,
  type ControlRecord
} from '../../src/server/workbook/control.js';
import { INJECTION_KINDS, type InjectionKind, type Role } from './rehearsal-arguments.js';

/** The slice of the REST workbook client these transitions need. */
export type ControlTabsApi = {
  readTabs(names: readonly string[]): Promise<Record<string, unknown[][]>>;
  writeControlRow(name: string, row: unknown[]): Promise<number>;
  /** Replace every data row when a duplicate/malformed state needs repair. */
  replaceControlRows(name: string, rows: readonly unknown[][]): Promise<number>;
  appendRow(name: string, values: unknown[]): Promise<number>;
};

export type ControlWriterOptions = {
  /** Timestamp every transition in this run records. */
  at: string;
  controlColumns: readonly string[];
  journalColumns: readonly string[];
};

export type ControlWriterOverrides = {
  /** Use a reviewed snapshot record as the in-memory source for repair begin. */
  initialControlRecord?: ControlRecord;
  /** Recovery repair may publish a begin marker while the service is stopped. */
  writeEnabled?: () => boolean;
  /** Reserve every journal row the caller's complete transition sequence needs. */
  requiredJournalEntries?: number;
};

export type ControlWriterOverRest = {
  writer: ControlMutationWriter;
  controlSheet: InMemorySheet;
  journalSheet: InMemorySheet;
  /** Applies the writer's journal entries before its control row. */
  apply: (options?: { replaceControlRows?: boolean }) => Promise<{ controlWritten: true; journalAppended: number }>;
};

export async function controlWriterOverRest(api: ControlTabsApi, options: ControlWriterOptions, overrides: ControlWriterOverrides = {}): Promise<ControlWriterOverRest> {
  const rows = await api.readTabs(['WorkbookControl', 'ControlJournal']);
  const requiredJournalEntries = overrides.requiredJournalEntries ?? 1;
  if (!Number.isSafeInteger(requiredJournalEntries) || requiredJournalEntries < 1 || requiredJournalEntries > CONTROL_LIMITS.journalEntries) {
    throw new Error(`A transition must reserve between 1 and ${CONTROL_LIMITS.journalEntries} control journal entries.`);
  }
  const retainedJournalEntries = (rows.ControlJournal ?? []).length;
  if (retainedJournalEntries + requiredJournalEntries > CONTROL_LIMITS.journalEntries) {
    throw new Error(`Control journal capacity of ${CONTROL_LIMITS.journalEntries} entries would be exceeded: ${retainedJournalEntries} retained with ${requiredJournalEntries} required.`);
  }
  const controlSheet = new InMemorySheet('WorkbookControl', options.controlColumns);
  controlSheet.values = [[...options.controlColumns], ...(rows.WorkbookControl ?? [])];
  if (overrides.initialControlRecord) {
    controlSheet.values = [[...options.controlColumns], serializeControlRecord(overrides.initialControlRecord)];
  }
  const journalSheet = new InMemorySheet('ControlJournal', options.journalColumns);
  journalSheet.values = [[...options.journalColumns], ...(rows.ControlJournal ?? [])];
  const journalBefore = journalSheet.values.length;
  const writer = new ControlMutationWriter({
    control: controlSheet,
    journal: journalSheet,
    // Activation and rollback are stopped-service procedures: the live gate is
    // expected closed, and neither transition consults it.
    writeEnabled: overrides.writeEnabled ?? (() => false),
    authority: 'workbook-control',
    now: () => options.at
  });
  return {
    writer,
    controlSheet,
    journalSheet,
    apply: async ({ replaceControlRows = false } = {}) => {
      const record = controlSheet.values[1];
      if (!record) throw new Error('The writer produced no control row.');
      // Journal first, then the control row — the production order, so a crash
      // between the two leaves an auditable attempt rather than a silent switch.
      const appended = journalSheet.values.slice(journalBefore);
      for (const entry of appended) await api.appendRow('ControlJournal', entry);
      if (replaceControlRows) {
        await api.replaceControlRows('WorkbookControl', [record]);
      } else {
        await api.writeControlRow('WorkbookControl', record);
      }
      return { controlWritten: true, journalAppended: appended.length };
    }
  };
}

export type InjectionSnapshot = {
  role: Role;
  kind: InjectionKind;
  at: string;
  controlRows: unknown[][];
  injectedRows: unknown[][];
  priorValidTuple: ReturnType<typeof controlTuple>;
};

export type InjectionRestoreOptions = ControlWriterOptions & {
  role: Role;
  snapshot: InjectionSnapshot;
  actorId: string;
  reason: string;
  at: string;
};

export type InjectionRestoreResult = {
  record: ControlRecord;
  priorValidTuple: ReturnType<typeof controlTuple>;
  generationFloor: number;
  observedGenerations: number[];
  recoveryMode: 'recover-pending' | 'begin-then-recover';
  events: readonly ('begin' | 'recover')[];
};

/** The audited tuple stored with every private injection snapshot. */
export function controlTuple(record: ControlRecord) {
  return {
    generation: record.generation,
    completedGeneration: record.completedGeneration,
    authority: record.authority,
    authorityEpoch: record.authorityEpoch,
    mutationState: record.mutationState,
    dataRevision: record.dataRevision,
    schedulingInputRevision: record.schedulingInputRevision,
    tabRevisions: { ...record.tabRevisions },
    idle: record.mutationState === 'idle'
  };
}

/** Build the private snapshot before an injection writes its rows. */
export function createInjectionSnapshot(options: {
  role: Role;
  kind: InjectionKind;
  at: string;
  controlRows: readonly (readonly unknown[])[];
  injectedRows: readonly (readonly unknown[])[];
}): InjectionSnapshot {
  const prior = controlRecordFromRows(options.controlRows);
  if (prior.authority !== 'workbook-control' || prior.mutationState !== 'idle') {
    throw new Error('An injection snapshot requires one idle workbook-control record.');
  }
  return {
    role: options.role,
    kind: options.kind,
    at: options.at,
    controlRows: options.controlRows.map((row) => [...row]),
    injectedRows: options.injectedRows.map((row) => [...row]),
    priorValidTuple: controlTuple(prior)
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function dataRows(rows: readonly (readonly unknown[])[]): unknown[][] {
  return rows
    .filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined))
    .map((row) => [...row]);
}

function normalizedRows(rows: readonly (readonly unknown[])[], width: number): unknown[][] {
  return dataRows(rows).map((row) => Array.from({ length: width }, (_unused, index) => row[index] ?? ''));
}

function validRecords(rows: readonly (readonly unknown[])[]): ControlRecord[] {
  const records: ControlRecord[] = [];
  for (const row of rows) {
    try {
      records.push(controlRecordFromRows([row]));
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
    }
  }
  return records;
}

/**
 * Restore only the exact injection represented by a role-matched snapshot.
 * Pending injections go through production recovery directly. Invalid and
 * authority-flipped injections first publish a valid begin marker derived from
 * the reviewed baseline, then recover it. Both steps journal before writing the
 * control row, and the final generation exceeds every valid observed state.
 */
export async function restoreInjectedControlSnapshot(api: ControlTabsApi, options: InjectionRestoreOptions): Promise<InjectionRestoreResult> {
  const { snapshot } = options;
  if (!INJECTION_KINDS.includes(snapshot.kind)) throw new Error('The injection snapshot names an unsupported kind.');
  if (snapshot.role !== options.role) {
    throw new Error(`The snapshot is for role ${snapshot.role}; refusing to restore it as ${options.role}.`);
  }
  if (!Array.isArray(snapshot.controlRows) || !Array.isArray(snapshot.injectedRows)) {
    throw new Error('The injection snapshot has no reviewed baseline or injected rows.');
  }

  const baseline = controlRecordFromRows(snapshot.controlRows);
  if (baseline.authority !== 'workbook-control' || baseline.mutationState !== 'idle') {
    throw new Error('The reviewed injection baseline is not an idle workbook-control record.');
  }
  if (canonical(snapshot.priorValidTuple) !== canonical(controlTuple(baseline))) {
    throw new Error('The snapshot prior-valid tuple does not match its control-row baseline.');
  }

  const currentRows = dataRows((await api.readTabs(['WorkbookControl'])).WorkbookControl ?? []);
  const currentValidRecords = validRecords(currentRows);
  const observedGenerations = [baseline.generation, ...currentValidRecords.map((record) => record.generation)];
  const generationFloor = Math.max(...observedGenerations);
  const permittedInjectedGeneration = snapshot.kind === 'pending' ? baseline.generation + 1 : baseline.generation;
  if (currentValidRecords.some((record) => record.generation > permittedInjectedGeneration)) {
    throw new Error(`A newer valid control record exists at generation ${generationFloor}; refusing to overwrite it with the injection snapshot.`);
  }
  if (canonical(normalizedRows(currentRows, options.controlColumns.length)) !== canonical(normalizedRows(snapshot.injectedRows, options.controlColumns.length))) {
    throw new Error(`The live control rows do not match the ${snapshot.kind} injection recorded for ${snapshot.role}; refusing to overwrite unrelated state.`);
  }

  const transitionOptions = {
    at: options.at,
    controlColumns: options.controlColumns,
    journalColumns: options.journalColumns
  };
  const reason = options.reason.trim();
  if (!reason) throw new Error('Restoring an injection needs a journal reason.');

  let record: ControlRecord;
  let recoveryMode: InjectionRestoreResult['recoveryMode'];
  let events: InjectionRestoreResult['events'];
  if (snapshot.kind === 'pending') {
    if (currentRows.length !== 1 || currentValidRecords.length !== 1 || currentValidRecords[0]?.mutationState !== 'pending') {
      throw new Error('The recorded pending injection is no longer a single valid pending mutation.');
    }
    const facade = await controlWriterOverRest(api, transitionOptions);
    ({ record } = facade.writer.recover({ decision: 'not-started', actorId: options.actorId, reason }));
    await facade.apply();
    recoveryMode = 'recover-pending';
    events = ['recover'];
  } else {
    const bridge = await controlWriterOverRest(api, transitionOptions, {
      initialControlRecord: baseline,
      writeEnabled: () => true,
      // This repair publishes begin and then recover. Reserve both before the
      // first write so a near-full journal cannot lose either event in the REST
      // adapter's bounded in-memory mirror.
      requiredJournalEntries: 2
    });
    bridge.writer.begin({
      operationId: controlOperationId('rehearsal.restore'),
      tabs: ['Assignments'],
      actorId: options.actorId
    });
    // Invalid and duplicate injections can leave more than one physical row.
    // A2-only writes do not remove the second row, so replace the whole data
    // range when publishing the reviewed-baseline begin marker.
    await bridge.apply({ replaceControlRows: true });

    const facade = await controlWriterOverRest(api, transitionOptions);
    ({ record } = facade.writer.recover({ decision: 'not-started', actorId: options.actorId, reason }));
    await facade.apply();
    recoveryMode = 'begin-then-recover';
    events = ['begin', 'recover'];
  }

  const restoredRows = dataRows((await api.readTabs(['WorkbookControl'])).WorkbookControl ?? []);
  const restored = controlRecordFromRows(restoredRows);
  if (restored.generation <= generationFloor) {
    throw new Error(`The restored generation ${restored.generation} did not advance beyond observed generation ${generationFloor}.`);
  }
  if (restored.authority !== baseline.authority || restored.mutationState !== 'idle') {
    throw new Error('The restored record did not return to the reviewed idle authority.');
  }
  const counters = (value: ControlRecord) => ({
    dataRevision: value.dataRevision,
    schedulingInputRevision: value.schedulingInputRevision,
    tabRevisions: value.tabRevisions
  });
  if (canonical(counters(restored)) !== canonical(counters(baseline))) {
    throw new Error('The restore changed counters from the reviewed baseline.');
  }

  return {
    record: restored,
    priorValidTuple: controlTuple(baseline),
    generationFloor,
    observedGenerations,
    recoveryMode,
    events
  };
}

/** The counters a deployment currently serves, as the capture step supplies them. */
export function capturedCounters(args: {
  dataRevision?: number | undefined;
  inputRevision?: number | undefined;
  tabRevisions?: Record<string, number> | undefined;
}): { dataRevision: number; schedulingInputRevision: number; tabRevisions: Record<string, number> } {
  if (args.dataRevision === undefined || args.inputRevision === undefined || !args.tabRevisions) {
    throw new Error('this step needs --data-revision, --input-revision and --tab-revisions (the counters the deployment currently serves).');
  }
  return { dataRevision: args.dataRevision, schedulingInputRevision: args.inputRevision, tabRevisions: args.tabRevisions };
}
