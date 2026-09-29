import { describe, expect, it } from 'vitest';
import { InMemoryProperties, InMemorySpreadsheet, type InMemorySheet } from './in-memory-sheet.js';
import { withMaintenanceFence } from './maintenance.js';
import { readControlRecord, serializeControlRecord, emptyControlRecord, ControlError, type ControlAuthority } from './control.js';
import { applyMigrationPayload } from './loader.js';
import type { SheetLike } from './initializer.js';
import type { LockLike } from './repository.js';

const NOW = '2026-09-29T12:00:00.000Z';
const AUTHORITY: ControlAuthority = 'workbook-control';

function openLock(): LockLike {
  let held = false;
  return { tryLock: () => (held ? false : ((held = true), true)), releaseLock: () => { held = false; } };
}

function sheet(name: string): InMemorySheet {
  const found = new InMemorySpreadsheet().getSheetByName(name);
  if (!found) throw new Error(`${name} tab is missing from the stand-in workbook`);
  return found;
}

function seedRecord(control: InMemorySheet, authority: ControlAuthority = AUTHORITY): void {
  const row = serializeControlRecord({ ...emptyControlRecord(NOW, 'operator'), authority, authorityEpoch: 1, dataRevision: 4 });
  control.getRange(2, 1, 1, row.length).setValues([row]);
}

describe('maintenance fence', () => {
  it('refuses to run while the live write gate is open, and releases the lock', () => {
    const lock = openLock();
    let ran = false;

    try {
      withMaintenanceFence({ lock, writeEnabled: () => true }, () => { ran = true; });
      throw new Error('expected the fence to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(ControlError);
      expect((error as ControlError).code).toBe('GATE_OPEN');
    }
    expect(ran).toBe(false);

    // The lock was released, so a properly drained run can proceed.
    expect(() => withMaintenanceFence({ lock, writeEnabled: () => false }, () => undefined)).not.toThrow();
  });

  it('refuses without the script lock and never runs the action', () => {
    const held: LockLike = { tryLock: () => false, releaseLock: () => undefined };
    let ran = false;

    try {
      withMaintenanceFence({ lock: held, writeEnabled: () => false }, () => { ran = true; });
      throw new Error('expected the fence to refuse');
    } catch (error) {
      expect((error as ControlError).code).toBe('LOCKED');
    }
    expect(ran).toBe(false);
  });

  it('runs with writers drained and seeds the control record idempotently', () => {
    const control = sheet('WorkbookControl');
    const journal = sheet('ControlJournal');
    const options = {
      lock: openLock(),
      writeEnabled: () => false,
      controlSheet: () => control,
      journalSheet: () => journal,
      actorId: 'operator@example.test',
      now: () => NOW
    };

    const first = withMaintenanceFence(options, (context) => context.initializeControl());
    const second = withMaintenanceFence({ ...options, lock: openLock() }, (context) => context.initializeControl());

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(control.values).toHaveLength(2);
    // Initialization never invents authority or a revision.
    expect(readControlRecord(control)).toMatchObject({ authority: 'script-properties', dataRevision: 0 });
  });

  it('journals the maintenance run once the record exists', () => {
    const control = sheet('WorkbookControl');
    const journal = sheet('ControlJournal');
    seedRecord(control);

    withMaintenanceFence({ lock: openLock(), writeEnabled: () => false, controlSheet: () => control, journalSheet: () => journal, actorId: 'operator@example.test', now: () => NOW }, (context) => {
      context.journal('capture', 'initializeWorkbook');
    });

    const rows = journal.values.slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[2]).toBe('capture');
    expect(rows[0]?.[8]).toBe('initializeWorkbook');
    expect(rows[0]?.[4]).toBe('operator@example.test');
  });

  it('tolerates a workbook that has no control tab yet', () => {
    const withoutControl: SheetLike | undefined = undefined;

    const outcome = withMaintenanceFence({ lock: openLock(), writeEnabled: () => false, controlSheet: () => withoutControl }, (context) => {
      context.journal('capture', 'initializeWorkbook');
      return context.initializeControl();
    });

    expect(outcome).toBeUndefined();
  });

  it('never overwrites a malformed control record', () => {
    const control = sheet('WorkbookControl');
    const row = serializeControlRecord(emptyControlRecord(NOW, 'operator'));
    row[7] = 'not json';
    control.getRange(2, 1, 1, row.length).setValues([row]);

    try {
      withMaintenanceFence({ lock: openLock(), writeEnabled: () => false, controlSheet: () => control }, (context) => context.initializeControl());
      throw new Error('expected the fence to refuse');
    } catch (error) {
      expect((error as ControlError).code).toBe('MALFORMED');
    }
    expect(control.values).toHaveLength(2);
  });
});

describe('migration validation is pure', () => {
  /** A workbook with only the tabs named, so initialization would have to create the rest. */
  function partialWorkbook(names: readonly string[]) {
    const sheets = new Map<string, InMemorySheet>(names.map((name) => [name, new InMemorySpreadsheet().getSheetByName(name) ?? new InMemorySpreadsheet().insertSheet(name)]));
    const inserted: string[] = [];
    const spreadsheet = {
      getSheetByName: (name: string) => sheets.get(name) ?? null,
      insertSheet: (name: string) => {
        const created = new InMemorySpreadsheet().insertSheet(name);
        sheets.set(name, created);
        inserted.push(name);
        return created;
      }
    };
    return { spreadsheet, inserted };
  }

  const payload = {
    volunteers: [{ id: 'vol-1', name: 'Ada Lovelace', email: 'ada@example.test', lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1, recurringAvailability: [], revision: 0, createdAt: NOW, updatedAt: NOW }],
    centers: [{ id: 'center-1', name: 'Downtown Center', active: true, revision: 0, createdAt: NOW, updatedAt: NOW }],
    sessions: [{ id: 'session-1', kind: 'center', centerId: 'center-1', date: '2026-10-05', start: '09:00', end: '10:00', timeZone: 'America/New_York', requiredStaffCount: 1, status: 'confirmed', revision: 0 }],
    users: [{ id: 'u1', email: 'admin@example.test', roles: ['administrator'], active: true, revision: 0 }]
  };

  it('creates no tab and reports no initialization when apply is false', () => {
    const { spreadsheet, inserted } = partialWorkbook(['Settings']);

    const report = applyMigrationPayload(spreadsheet, new InMemoryProperties(), payload, { apply: false });

    expect(inserted).toEqual([]);
    expect(report.initialized).toBeUndefined();
    expect(report.applied).toBe(false);
  });

  it('initializes only on the apply path', () => {
    const { spreadsheet, inserted } = partialWorkbook(['Settings']);

    const report = applyMigrationPayload(spreadsheet, new InMemoryProperties(), payload, { apply: true, actorId: 'operator@example.test' });

    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted).toContain('Volunteers');
    expect(report.initialized?.createdTabs).toContain('Volunteers');
    expect(report.applied).toBe(true);
  });
});
