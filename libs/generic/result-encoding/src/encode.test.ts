import { describe, it, expect } from 'vitest';
import {
  encode,
  decode,
  encodeAuto,
  encodeToonChecked,
  isFlatObjectArray,
  encodeDelimited,
  decodeDelimited,
  encodeMarkdownTable,
  TOON_VERIFY_MAX_BYTES,
  ResultEncodeError,
} from './index';

describe('encode/decode — json', () => {
  it('is compact (no whitespace) and round-trips', () => {
    const v = { a: 1, b: [1, 2, 3], c: 'x' };
    const text = encode(v, 'json');
    expect(text).toBe('{"a":1,"b":[1,2,3],"c":"x"}');
    expect(decode(text, 'json')).toEqual(v);
  });
  it('encodes undefined-returning stringify as null', () => {
    expect(encode(undefined, 'json')).toBe('null');
  });
});

describe('encode/decode — toon', () => {
  it('renders a uniform object array as tabular rows with a self-describing header', () => {
    const v = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    const text = encode(v, 'toon');
    expect(text).toContain('[2]{id,name}:');
    expect(decode(text, 'toon')).toEqual(v);
  });
  it('round-trips nested / heterogeneous arrays losslessly', () => {
    const v = [
      { id: 1, tags: ['x', 'y'], meta: { k: 1 } },
      { id: 2, tags: [], meta: { k: 2, extra: true } },
    ];
    expect(decode(encode(v, 'toon'), 'toon')).toEqual(v);
  });
  it('round-trips an empty array', () => {
    expect(decode(encode([], 'toon'), 'toon')).toEqual([]);
  });
});

describe('encode — csv/tsv', () => {
  const rows = [
    { id: 1, name: 'Alice', note: 'hi, there' },
    { id: 2, name: 'Bob', note: 'says "hey"' },
  ];
  it('quotes fields containing the delimiter or quotes (RFC 4180)', () => {
    const csv = encode(rows, 'csv');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('id,name,note');
    expect(lines[1]).toBe('1,Alice,"hi, there"');
    expect(lines[2]).toBe('2,Bob,"says ""hey"""');
  });
  it('tsv uses tab and does not quote commas', () => {
    const tsv = encode(rows, 'tsv');
    expect(tsv.split('\n')[1]).toBe('1\tAlice\thi, there');
  });
  it('uses the first-seen union of columns across ragged rows', () => {
    const ragged = [{ a: 1 }, { b: 2 }, { a: 3, b: 4 }];
    expect(encode(ragged, 'csv')).toBe('a,b\n1,\n,2\n3,4');
  });
  it('throws on non-tabular input', () => {
    expect(() => encode({ a: 1 }, 'csv')).toThrow(ResultEncodeError);
    expect(() => encode([1, 2, 3], 'csv')).toThrow(ResultEncodeError);
  });
  it('csv round-trips to string-coerced rows (lossy)', () => {
    const csv = encodeDelimited(rows, ',');
    expect(decodeDelimited(csv, ',')).toEqual([
      { id: '1', name: 'Alice', note: 'hi, there' },
      { id: '2', name: 'Bob', note: 'says "hey"' },
    ]);
  });
  it('round-trips embedded newlines inside quoted fields', () => {
    const withNewline = [{ a: 'line1\nline2', b: 'plain' }];
    const csv = encodeDelimited(withNewline, ',');
    expect(decodeDelimited(csv, ',')).toEqual([{ a: 'line1\nline2', b: 'plain' }]);
  });
  it('decodes the empty string to no rows', () => {
    expect(decodeDelimited('', ',')).toEqual([]);
  });
});

describe('encode — markdown table', () => {
  it('emits a GFM table and escapes pipes', () => {
    const md = encodeMarkdownTable([{ a: 'x|y', b: 1 }]);
    expect(md).toBe('| a | b |\n| --- | --- |\n| x\\|y | 1 |');
  });
  it('decode throws (display-only)', () => {
    expect(() => decode('| a |', 'md')).toThrow(ResultEncodeError);
  });
});

describe('encodeAuto — no-schema runtime sniff', () => {
  it('arrays → toon', () => {
    const r = encodeAuto([{ a: 1 }, { a: 2 }]);
    expect(r.format).toBe('toon');
    expect(decode(r.text, 'toon')).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('single objects → json', () => {
    const r = encodeAuto({ a: 1, b: 2 });
    expect(r.format).toBe('json');
    expect(decode(r.text, 'json')).toEqual({ a: 1, b: 2 });
  });
  it('scalars → json', () => {
    expect(encodeAuto('hi')).toEqual({ format: 'json', text: '"hi"' });
    expect(encodeAuto(42)).toEqual({ format: 'json', text: '42' });
  });
});

describe('encodeToonChecked — lossless round-trip size-gate (P1-1 / F-A1)', () => {
  it('verifies and reports lossless for a small array', () => {
    const r = encodeToonChecked([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(r.lossless).toBe(true);
    expect(decode(r.text, 'toon')).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(r.text.length).toBeLessThanOrEqual(TOON_VERIFY_MAX_BYTES);
  });

  it('verifies the formerly problematic empty-key nested object shape', () => {
    // @toon-format/toon 2.3.1 now round-trips this shape losslessly. Keep the
    // regression focused on the live dependency behavior so a future encoder
    // regression still makes the lossless check fail loudly.
    const r = encodeToonChecked([{ '': { ':': 0 } }]);
    expect(r.lossless).toBe(true);
    expect(decode(r.text, 'toon')).toEqual([{ '': { ':': 0 } }]);
  });

  it('SKIPS the verify above the byte gate and reports not-lossless (so callers use JSON)', () => {
    // A faithfully-encodable array whose TOON output exceeds the gate. The
    // verify would have returned lossless:true; the size-gate skips it and
    // returns false so the caller routes the large payload to plain JSON
    // rather than pay the O(size)×3 round-trip on the event loop.
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const r = encodeToonChecked(big);
    expect(r.text.length).toBeGreaterThan(TOON_VERIFY_MAX_BYTES);
    expect(r.lossless).toBe(false);
    // The text is still produced (a valid TOON encoding), just unverified.
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('encodeAuto falls back to JSON for an over-gate array', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const r = encodeAuto(big);
    expect(r.format).toBe('json');
    expect(decode(r.text, 'json')).toEqual(big);
  });

  it('still TOON-encodes an array right at/under the gate', () => {
    // ~100 rows — comfortably under 16 KiB — stays TOON.
    const modest = Array.from({ length: 100 }, (_, i) => ({ id: i, v: i * 2 }));
    const r = encodeAuto(modest);
    expect(r.format).toBe('toon');
    expect(decode(r.text, 'toon')).toEqual(modest);
  });
});

describe('isFlatObjectArray', () => {
  it('true for non-empty arrays of all-scalar objects', () => {
    expect(isFlatObjectArray([{ a: 1, b: 'x', c: null }])).toBe(true);
  });
  it('false for nested fields, empty arrays, non-arrays', () => {
    expect(isFlatObjectArray([{ a: { nested: 1 } }])).toBe(false);
    expect(isFlatObjectArray([{ a: [1] }])).toBe(false);
    expect(isFlatObjectArray([])).toBe(false);
    expect(isFlatObjectArray({ a: 1 })).toBe(false);
  });
});
