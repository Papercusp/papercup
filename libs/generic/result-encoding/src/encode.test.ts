import { describe, it, expect } from 'vitest';
import {
  encode,
  decode,
  encodeAuto,
  isFlatObjectArray,
  encodeDelimited,
  decodeDelimited,
  encodeMarkdownTable,
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
