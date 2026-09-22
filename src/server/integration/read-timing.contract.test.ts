import { describe, expect, it, vi } from 'vitest';
import { ReadTiming } from './read-timing.js';

describe('read timing', () => {
  it('reports only phase totals and tab counts', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const timing = new ReadTiming();
      timing.measure('credentialVerification', () => 'private-credential');
      timing.measure('authorization', () => 'private-email@example.test');
      timing.derive(() => timing.hydration('Users', () => timing.sheetCall(() => ['private-row'])));
      timing.report('admin.schedule.read', true);
      const message = String(log.mock.calls[0]?.[0]);
      expect(message).toContain('"sheetReads":{"Users":1}');
      expect(message).toContain('"sheetCallCount":1');
      expect(message).not.toContain('private-credential');
      expect(message).not.toContain('private-email');
      expect(message).not.toContain('private-row');
    } finally { log.mockRestore(); }
  });
});
