import { describe, expect, it } from 'vitest';
import { parseArgs, requiresStagingConfirmation } from '../../../scripts/staging/rehearsal-arguments.js';

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

  it.each([
    ['an unknown flag', ['baseline', '--role', 'larger', '--spreadsheet', 'abc']],
    ['an unknown event', ['transition', '--role', 'larger', '--event', 'publish']],
    ['an unknown decision', ['transition', '--role', 'larger', '--event', 'recover', '--decision', 'maybe']],
    ['an unknown authority', ['rollback', '--role', 'larger', '--authority', 'either']],
    ['a negative revision', ['capture', '--role', 'larger', '--data-revision', '-1']],
    ['tab counters that are not an object', ['capture', '--role', 'larger', '--tab-revisions', '[1,2]']],
    ['tab counters that are not integers', ['capture', '--role', 'larger', '--tab-revisions', '{"Volunteers":"1"}']],
    ['a flag without its value', ['baseline', '--role']]
  ])('refuses %s', (_label, argv) => {
    expect(() => parseArgs(argv as string[])).toThrowError(/./u);
  });
});

describe('rehearsal runner confirmation gate', () => {
  it('treats only the reading subcommands as safe without --confirm-staging', () => {
    expect(requiresStagingConfirmation('baseline')).toBe(false);
    expect(requiresStagingConfirmation('verify')).toBe(false);
    for (const command of ['initialize', 'capture', 'transition', 'rollback', 'fixture', 'cleanup']) {
      expect(requiresStagingConfirmation(command), command).toBe(true);
    }
  });
});
