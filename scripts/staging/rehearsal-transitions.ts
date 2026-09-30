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
import { ControlMutationWriter } from '../../src/server/workbook/control.js';

/** The slice of the REST workbook client these transitions need. */
export type ControlTabsApi = {
  readTabs(names: readonly string[]): Promise<Record<string, unknown[][]>>;
  writeControlRow(name: string, row: unknown[]): Promise<number>;
  appendRow(name: string, values: unknown[]): Promise<number>;
};

export type ControlWriterOptions = {
  /** Timestamp every transition in this run records. */
  at: string;
  controlColumns: readonly string[];
  journalColumns: readonly string[];
};

export type ControlWriterOverRest = {
  writer: ControlMutationWriter;
  controlSheet: InMemorySheet;
  journalSheet: InMemorySheet;
  /** Applies what the writer did, control row first, then the journal entries. */
  apply: () => Promise<{ controlWritten: true; journalAppended: number }>;
};

export async function controlWriterOverRest(api: ControlTabsApi, options: ControlWriterOptions): Promise<ControlWriterOverRest> {
  const rows = await api.readTabs(['WorkbookControl', 'ControlJournal']);
  const controlSheet = new InMemorySheet('WorkbookControl', options.controlColumns);
  controlSheet.values = [[...options.controlColumns], ...(rows.WorkbookControl ?? [])];
  const journalSheet = new InMemorySheet('ControlJournal', options.journalColumns);
  journalSheet.values = [[...options.journalColumns], ...(rows.ControlJournal ?? [])];
  const journalBefore = journalSheet.values.length;
  const writer = new ControlMutationWriter({
    control: controlSheet,
    journal: journalSheet,
    // Activation and rollback are stopped-service procedures: the live gate is
    // expected closed, and neither transition consults it.
    writeEnabled: () => false,
    authority: 'workbook-control',
    now: () => options.at
  });
  return {
    writer,
    controlSheet,
    journalSheet,
    apply: async () => {
      const record = controlSheet.values[1];
      if (!record) throw new Error('The writer produced no control row.');
      // Journal first, then the control row — the production order, so a crash
      // between the two leaves an auditable attempt rather than a silent switch.
      const appended = journalSheet.values.slice(journalBefore);
      for (const entry of appended) await api.appendRow('ControlJournal', entry);
      await api.writeControlRow('WorkbookControl', record);
      return { controlWritten: true, journalAppended: appended.length };
    }
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
