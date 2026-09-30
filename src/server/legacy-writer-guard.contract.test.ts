import { describe, expect, it } from 'vitest';
import { MemoryTokenVerifier, MemoryUserDirectory, type VerifiedIdentityClaims } from './integration/auth.js';
import { createIntegrationDispatcher, INTEGRATION_OPERATIONS, MemoryWriteLock, type RevisionSource } from './integration/dispatcher.js';
import { runtimeRevisionSource } from './main.js';
import { CONTROL_COLUMNS, ControlError, emptyControlRecord, serializeControlRecord, type ControlAuthority, type ControlRecord } from './workbook/control.js';
import { InMemoryProperties, InMemorySpreadsheet } from './workbook/in-memory-sheet.js';
import { legacyAdmission, type ControlReadOutcome } from './workbook/legacy-admission.js';

/**
 * The legacy writer guard: a process still on the Script Properties authority
 * must refuse to write once the workbook carries a record that says the portable
 * authority owns the counters. The first block tests the judgement as a pure
 * decision table; the second drives the real wiring through the dispatcher and
 * asserts the two properties that matter — the handler never runs and nothing
 * advances.
 */

const claims: VerifiedIdentityClaims = {
  iss: 'https://accounts.google.com', aud: 'client', sub: 'sub-1', email: 'admin@example.test', email_verified: true, exp: 4102444800
};
const user = { id: 'admin@example.test', email: 'admin@example.test', roles: ['administrator'] as const, active: true, revision: 0 };

function record(overrides: Partial<ControlRecord> = {}): ControlRecord {
  return { ...emptyControlRecord('2026-09-29T00:00:00.000Z', 'operator@example.test'), authorityEpoch: 1, generation: 4, completedGeneration: 4, dataRevision: 41, ...overrides };
}

const read = (value: ControlRecord): ControlReadOutcome => ({ ok: true, record: value });
const failed = (code: ControlError['code']): ControlReadOutcome => ({ ok: false, code });

describe('legacy admission judgement', () => {
  it('admits a workbook that predates the protocol, because there is nothing to fork', () => {
    const decision = legacyAdmission({ authority: 'script-properties', controlTabsPresent: false, outcome: failed('MISSING') });

    expect(decision).toEqual({ admit: true, record: undefined });
  });

  it('admits a valid record that still sits on the Script Properties authority', () => {
    const decision = legacyAdmission({ authority: 'script-properties', controlTabsPresent: true, outcome: read(record()) });

    expect(decision).toMatchObject({ admit: true });
  });

  it('refuses an activated record: the counters it would advance are no longer the authoritative ones', () => {
    const decision = legacyAdmission({ authority: 'script-properties', controlTabsPresent: true, outcome: read(record({ authority: 'workbook-control' })) });

    expect(decision).toMatchObject({ admit: false, code: 'AUTHORITY_MISMATCH' });
    if (decision.admit) return;
    expect(decision.message).toContain('fork');
    expect(decision.message).toContain('rollback');
  });

  it('refuses a workbook whose control tabs exist but whose record is unreadable', () => {
    const decision = legacyAdmission({ authority: 'script-properties', controlTabsPresent: true, outcome: failed('MISSING') });

    expect(decision).toMatchObject({ admit: false, code: 'MISSING' });
    if (decision.admit) return;
    expect(decision.message).toContain('half-initialized');
  });

  it.each(['MALFORMED', 'DUPLICATE', 'UNSUPPORTED'] as const)('refuses a %s record rather than assuming it is safe', (code) => {
    expect(legacyAdmission({ authority: 'script-properties', controlTabsPresent: true, outcome: failed(code) })).toMatchObject({ admit: false, code });
  });

  it('refuses when the deployment itself is activated, whatever the workbook says', () => {
    const authority: ControlAuthority = 'workbook-control';

    expect(legacyAdmission({ authority, controlTabsPresent: false, outcome: failed('MISSING') })).toMatchObject({ admit: false, code: 'AUTHORITY_MISMATCH' });
    expect(legacyAdmission({ authority, controlTabsPresent: true, outcome: read(record()) })).toMatchObject({ admit: false, code: 'AUTHORITY_MISMATCH' });
  });
});

/** The revision source as `defaultServer` builds it, with the globals it reads stubbed. */
function legacySource(input: { spreadsheet: { getSheetByName(name: string): unknown } | undefined; controlTabsPresent: boolean; properties: InMemoryProperties }): RevisionSource {
  const runtime = globalThis as { PropertiesService?: unknown };
  runtime.PropertiesService = { getScriptProperties: () => input.properties };
  try {
    const source = runtimeRevisionSource({
      authority: 'script-properties',
      spreadsheet: input.spreadsheet as { getSheetByName(name: string): never } | undefined,
      controlTabsPresent: input.controlTabsPresent
    });
    if (!source) throw new Error('expected the legacy revision source to be configured');
    return source;
  } finally {
    delete runtime.PropertiesService;
  }
}

function mutationDispatcher(revision: RevisionSource, onHandler: () => void) {
  return createIntegrationDispatcher({
    verifier: new MemoryTokenVerifier({ 'valid-credential': claims }),
    users: new MemoryUserDirectory([user as unknown as Parameters<typeof MemoryUserDirectory.prototype.set>[0]]),
    handlers: { [INTEGRATION_OPERATIONS.adminScheduleRerun]: () => { onHandler(); return { preview: false }; } },
    revision,
    writeLock: new MemoryWriteLock()
  });
}

const mutation = { operation: INTEGRATION_OPERATIONS.adminScheduleRerun, payload: {}, idempotencyKey: 'legacy-guard-1', credential: 'valid-credential', expectedRevision: 5 };

function propertiesWithRevision(value = 5): InMemoryProperties {
  const properties = new InMemoryProperties();
  properties.setProperty('DATA_REVISION', String(value));
  return properties;
}

/** A spreadsheet carrying a control record, written through the real codec. */
function spreadsheetWith(control: ControlRecord | 'no-row'): InMemorySpreadsheet {
  const spreadsheet = new InMemorySpreadsheet();
  if (control !== 'no-row') {
    const sheet = spreadsheet.getSheetByName('WorkbookControl');
    if (!sheet) throw new Error('the fixture workbook has no control tab');
    sheet.appendRow(serializeControlRecord(control));
    expect(serializeControlRecord(control)).toHaveLength(CONTROL_COLUMNS.length);
  }
  return spreadsheet;
}

describe('legacy writer guard at the dispatcher', () => {
  it('admits a pre-protocol workbook without even looking for a control tab', () => {
    const looked: string[] = [];
    const spreadsheet = { getSheetByName: (name: string) => { looked.push(name); return null; } };
    const properties = propertiesWithRevision();
    const revision = legacySource({ spreadsheet, controlTabsPresent: false, properties });
    let handled = 0;

    const response = mutationDispatcher(revision, () => { handled += 1; }).dispatch(mutation);

    expect(response).toMatchObject({ ok: true, revision: 6 });
    expect(handled).toBe(1);
    expect(properties.getProperty('DATA_REVISION')).toBe('6');
    expect(looked).toEqual([]);
  });

  it('admits a workbook whose record is still on the Script Properties authority', () => {
    const properties = propertiesWithRevision();
    const revision = legacySource({ spreadsheet: spreadsheetWith(record()), controlTabsPresent: true, properties });
    let handled = 0;

    const response = mutationDispatcher(revision, () => { handled += 1; }).dispatch(mutation);

    expect(response).toMatchObject({ ok: true, revision: 6 });
    expect(handled).toBe(1);
  });

  it('refuses an activated workbook before the handler runs and leaves every counter where it was', () => {
    const properties = propertiesWithRevision();
    const spreadsheet = spreadsheetWith(record({ authority: 'workbook-control' }));
    const sessionsBefore = spreadsheet.getSheetByName('Sessions')?.values.length;
    const revision = legacySource({ spreadsheet, controlTabsPresent: true, properties });
    let handled = 0;

    const response = mutationDispatcher(revision, () => { handled += 1; }).dispatch(mutation);

    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', message: expect.stringContaining('fork') as unknown as string } });
    expect(handled).toBe(0);
    expect(properties.getProperty('DATA_REVISION')).toBe('5');
    expect(spreadsheet.getSheetByName('Sessions')?.values.length).toBe(sessionsBefore);
  });

  it('refuses a half-initialized workbook: control tabs but no record', () => {
    const properties = propertiesWithRevision();
    const revision = legacySource({ spreadsheet: spreadsheetWith('no-row'), controlTabsPresent: true, properties });
    let handled = 0;

    const response = mutationDispatcher(revision, () => { handled += 1; }).dispatch(mutation);

    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(handled).toBe(0);
    expect(properties.getProperty('DATA_REVISION')).toBe('5');
  });

  it('refuses a malformed record rather than treating it as absent', () => {
    const properties = propertiesWithRevision();
    const spreadsheet = spreadsheetWith(record());
    spreadsheet.getSheetByName('WorkbookControl')?.appendRow(['not-a-protocol-version']);
    const revision = legacySource({ spreadsheet, controlTabsPresent: true, properties });
    let handled = 0;

    const response = mutationDispatcher(revision, () => { handled += 1; }).dispatch(mutation);

    expect(response).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(handled).toBe(0);
    expect(properties.getProperty('DATA_REVISION')).toBe('5');
  });

  it('reads the record once per admitted mutation and never writes to it', () => {
    const properties = propertiesWithRevision();
    const spreadsheet = spreadsheetWith(record());
    const control = spreadsheet.getSheetByName('WorkbookControl');
    const rowsBefore = control?.values.length;
    const revision = legacySource({ spreadsheet, controlTabsPresent: true, properties });

    expect(mutationDispatcher(revision, () => undefined).dispatch(mutation)).toMatchObject({ ok: true });
    // The first mutation advanced the legacy counter, so the second carries the
    // revision the caller would have read back.
    expect(mutationDispatcher(revision, () => undefined).dispatch({ ...mutation, idempotencyKey: 'legacy-guard-2', expectedRevision: 6 })).toMatchObject({ ok: true });

    expect(control?.values.length).toBe(rowsBefore);
  });
});

describe('the judgement and the wiring agree', () => {
  it('throws the RepositoryError the dispatcher maps, not a raw control error', () => {
    const properties = propertiesWithRevision();
    const revision = legacySource({ spreadsheet: spreadsheetWith(record({ authority: 'workbook-control' })), controlTabsPresent: true, properties });

    expect(() => revision.begin?.('admin@example.test', INTEGRATION_OPERATIONS.adminScheduleRerun)).toThrowError(/fork/u);
    expect(() => revision.begin?.('admin@example.test', INTEGRATION_OPERATIONS.adminScheduleRerun)).not.toThrowError(ControlError);
  });
});
