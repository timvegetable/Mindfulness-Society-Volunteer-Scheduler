import { describe, expect, it } from 'vitest';
import { INTEGRATION_OPERATIONS } from './integration/dispatcher.js';
import { createProductionRuntime } from './runtime.js';
import { InMemoryProperties, InMemorySpreadsheet } from './workbook/in-memory-sheet.js';

describe('production Apps Script runtime', () => {
  it('composes persistent workbook handlers for every allowlisted operation', () => {
    const runtime = createProductionRuntime(new InMemorySpreadsheet(), new InMemoryProperties());
    for (const operation of Object.values(INTEGRATION_OPERATIONS)) expect(runtime.handlers[operation]).toBeTypeOf('function');
  });
});
