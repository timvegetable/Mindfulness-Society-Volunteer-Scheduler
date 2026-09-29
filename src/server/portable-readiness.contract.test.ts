import { describe, expect, it } from 'vitest';
import { portableReadiness } from './portable-authority.js';
import { activatedAuthority } from './workbook/authority.js';
import { InMemoryProperties } from './workbook/in-memory-sheet.js';

/**
 * The deployment's fail-closed decision. A process activated for the portable
 * authority must have its workbook, both control tabs and the batched read path:
 * each prerequisite without the others would serve data the protocol cannot
 * validate. A legacy process is always ready, and a typo in the configuration is
 * a fault rather than a silent downgrade.
 */
describe('portable readiness', () => {
  it('leaves a legacy deployment ready', () => {
    expect(portableReadiness({ authority: 'script-properties', hasSpreadsheet: false, hasControlTabs: false, hasBatchReader: false })).toEqual({ ready: true, portable: false });
  });

  it('requires the workbook, the control tabs and the batched read path', () => {
    expect(portableReadiness({ authority: 'workbook-control', hasSpreadsheet: false, hasControlTabs: true, hasBatchReader: true })).toMatchObject({ ready: false });
    const noTabs = portableReadiness({ authority: 'workbook-control', hasSpreadsheet: true, hasControlTabs: false, hasBatchReader: true });
    expect(noTabs).toMatchObject({ ready: false });
    expect(noTabs.ready === false ? noTabs.message : '').toContain('initialization');
    const noReader = portableReadiness({ authority: 'workbook-control', hasSpreadsheet: true, hasControlTabs: true, hasBatchReader: false });
    expect(noReader).toMatchObject({ ready: false });
    expect(noReader.ready === false ? noReader.message : '').toContain('batched read path');
  });

  it('is ready only when every prerequisite is present', () => {
    expect(portableReadiness({ authority: 'workbook-control', hasSpreadsheet: true, hasControlTabs: true, hasBatchReader: true })).toEqual({ ready: true, portable: true });
  });
});

describe('activated authority configuration', () => {
  it('treats an absent or empty value as the legacy authority', () => {
    expect(activatedAuthority(new InMemoryProperties())).toBe('script-properties');
    const blank = new InMemoryProperties();
    blank.setProperty('CONTROL_AUTHORITY', '   ');
    expect(activatedAuthority(blank)).toBe('script-properties');
  });

  it.each(['script-properties', 'workbook-control'])('accepts %s', (value) => {
    const properties = new InMemoryProperties();
    properties.setProperty('CONTROL_AUTHORITY', value);
    expect(activatedAuthority(properties)).toBe(value);
  });

  it.each(['Workbook-Control', 'portable', 'true'])('refuses the typo %s rather than downgrading', (value) => {
    const properties = new InMemoryProperties();
    properties.setProperty('CONTROL_AUTHORITY', value);
    expect(() => activatedAuthority(properties)).toThrowError(/CONTROL_AUTHORITY/u);
  });
});
