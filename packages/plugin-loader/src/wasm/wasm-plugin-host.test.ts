/**
 * wasm-plugin-host.test.ts — inspectWasmMemoryMax byte-parser.
 *
 * inspectWasmMemoryMax is the memory-budget gate: before instantiating a
 * plugin's core wasm it parses the binary's Memory section (id 5) to read the
 * declared min/max page limits so an over-budget module is rejected pre-spawn.
 * It's a hand-rolled LEB128 + section walker — pure and exception-prone, so it
 * earns direct coverage of: the magic-number guard, the limits-flag (max
 * present vs absent), the empty-memory-count case, no-memory-section, section
 * skipping, and the LEB128 varuint decoder (multi-byte + overflow). No wasm
 * runtime is touched — these are raw byte fixtures.
 */
import { describe, expect, it } from 'vitest';
import { inspectWasmMemoryMax } from './wasm-plugin-host.ts';

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** Build a Memory section (id 5) body: count=1, one limits entry. */
function memorySection(flag: number, min: number, max?: number): number[] {
  const body = [1, flag, ...leb128(min)];
  if (flag & 0x01) body.push(...leb128(max!));
  return [5, body.length, ...body];
}

/** Minimal unsigned LEB128 encoder (matches the decoder under test). */
function leb128(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

const bin = (...sections: number[][]) => new Uint8Array([...WASM_HEADER, ...sections.flat()]);

describe('inspectWasmMemoryMax', () => {
  it('throws on input that is not a wasm binary (bad magic)', () => {
    expect(() => inspectWasmMemoryMax(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      /not a wasm binary/,
    );
  });

  it('throws on input shorter than the 8-byte header', () => {
    expect(() => inspectWasmMemoryMax(new Uint8Array([0x00, 0x61, 0x73]))).toThrow(
      /not a wasm binary/,
    );
  });

  it('reads min and max when the limits flag declares a max (flag=1)', () => {
    expect(inspectWasmMemoryMax(bin(memorySection(0x01, 16, 256)))).toEqual({ min: 16, max: 256 });
  });

  it('returns max=null when the limits flag has no max (flag=0)', () => {
    expect(inspectWasmMemoryMax(bin(memorySection(0x00, 4)))).toEqual({ min: 4, max: null });
  });

  it('decodes multi-byte LEB128 page counts (>127)', () => {
    // 300 needs two LEB128 bytes; exercises the shift/continuation path.
    expect(inspectWasmMemoryMax(bin(memorySection(0x01, 1, 300)))).toEqual({ min: 1, max: 300 });
  });

  it('treats an empty memory section (count=0) as 0 pages', () => {
    // Memory section id 5, body = [count=0].
    expect(inspectWasmMemoryMax(bin([5, 1, 0]))).toEqual({ min: 0, max: 0 });
  });

  it('returns {0,0} when there is no memory section at all', () => {
    // A type section (id 1) with an empty body, no memory section.
    expect(inspectWasmMemoryMax(bin([1, 1, 0]))).toEqual({ min: 0, max: 0 });
  });

  it('skips a preceding non-memory section and finds the memory section after it', () => {
    const typeSection = [1, 3, 0xaa, 0xbb, 0xcc]; // id 1, len 3, opaque body
    expect(inspectWasmMemoryMax(bin(typeSection, memorySection(0x01, 2, 8)))).toEqual({
      min: 2,
      max: 8,
    });
  });

  it('throws on an over-long varuint32 (>5 continuation bytes)', () => {
    // Memory section whose min is encoded with 6 continuation bytes → overflow.
    const badMin = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00];
    const body = [1, 0x00, ...badMin];
    expect(() => inspectWasmMemoryMax(bin([5, body.length, ...body]))).toThrow(
      /varuint32 too long/,
    );
  });
});
