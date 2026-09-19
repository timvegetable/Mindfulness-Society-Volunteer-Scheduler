/**
 * Returns the number of UTF-8 bytes needed for a string in both browser/Node
 * and the Apps Script V8 runtime. Apps Script does not provide TextEncoder, so
 * the fallback counts Unicode scalar values directly and treats lone UTF-16
 * surrogates as the replacement character, matching TextEncoder semantics.
 */
export function utf8ByteLength(value: string): number {
  if (typeof globalThis.TextEncoder === 'function') return new globalThis.TextEncoder().encode(value).byteLength;

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (first <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
    }
    bytes += 3;
  }
  return bytes;
}
