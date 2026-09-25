/**
 * Structural comparison for read projections.
 *
 * Extracted from `main.ts`, where the Apps Script editor parity report used it,
 * so the Worker differential harness can assert the same rule against the same
 * snapshot instead of inventing a second comparison.
 */

/** Deterministic JSON with object keys sorted, so two projections compare by value. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Names the top-level fields that differ between two projections, ignoring
 * timestamps that are expected to move. Returns an empty array when the two
 * values are structurally equal.
 */
export function differingProjectionFields(left: unknown, right: unknown, ignoredFields: readonly string[] = []): string[] {
  if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) {
    return stableJson(left) === stableJson(right) ? [] : ['(projection)'];
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].filter((key) => !ignoredFields.includes(key) && stableJson(leftRecord[key]) !== stableJson(rightRecord[key])).sort();
}
