import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from './utf8.js';

describe('UTF-8 byte length compatibility helper', () => {
  it('matches TextEncoder for ASCII, accented, and astral characters', () => {
    const values = ['plain text', 'caf\u00e9', '\ud83c\udf1f'];
    for (const value of values) {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
  });

  it('uses the Apps Script-safe fallback when TextEncoder is unavailable', () => {
    const original = globalThis.TextEncoder;
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
    try {
      expect(utf8ByteLength('caf\u00e9 \ud83c\udf1f')).toBe(10);
      expect(utf8ByteLength('\ud800')).toBe(3);
    } finally {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: original });
    }
  });
});
