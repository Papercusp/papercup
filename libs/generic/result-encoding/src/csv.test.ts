/**
 * Unit tests for the delimited (CSV/TSV) + markdown-table encoder/parser (csv.ts).
 *
 * The package's `encode.property.test.ts` already round-trips `encodeDelimited`/`decodeDelimited`
 * over STRING-COERCED rows, but the RFC-4180 quoting/parsing edge cases — embedded delimiters,
 * doubled quotes, CR/LF/CRLF inside fields — and the other exports (`cellToString`, `quoteField`,
 * `encodeMarkdownTable`, `parseRows`) had no direct coverage. These are the bug-prone parts.
 */
import { describe, expect, it } from 'vitest';
import {
  cellToString,
  quoteField,
  encodeDelimited,
  encodeMarkdownTable,
  parseRows,
  decodeDelimited,
} from './csv';
import { ResultEncodeError } from './formats';

describe('cellToString', () => {
  it('maps null/undefined to the empty string', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });

  it('passes primitives through String()', () => {
    expect(cellToString('hi')).toBe('hi');
    expect(cellToString('')).toBe('');
    expect(cellToString(42)).toBe('42');
    expect(cellToString(0)).toBe('0');
    expect(cellToString(-1.5)).toBe('-1.5');
    expect(cellToString(true)).toBe('true');
    expect(cellToString(false)).toBe('false');
  });

  it('JSON-encodes objects and arrays (typeof object)', () => {
    expect(cellToString({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(cellToString([1, 2, 3])).toBe('[1,2,3]');
    expect(cellToString({})).toBe('{}');
  });
});

describe('quoteField (RFC 4180)', () => {
  it('leaves a clean field unquoted', () => {
    expect(quoteField('plain', ',')).toBe('plain');
    expect(quoteField('', ',')).toBe('');
    expect(quoteField('123', ',')).toBe('123');
  });

  it('quotes when the field contains the delimiter', () => {
    expect(quoteField('a,b', ',')).toBe('"a,b"');
    expect(quoteField('a\tb', '\t')).toBe('"a\tb"');
  });

  it('does NOT quote a foreign delimiter (a comma is harmless under TSV)', () => {
    expect(quoteField('a,b', '\t')).toBe('a,b');
    expect(quoteField('a\tb', ',')).toBe('"a\tb"'); // tab still triggers? no — only the active delimiter
  });

  it('quotes and DOUBLES embedded double-quotes', () => {
    expect(quoteField('he said "hi"', ',')).toBe('"he said ""hi"""');
    expect(quoteField('"', ',')).toBe('""""'); // a lone quote → "" wrapping + doubled inner
  });

  it('quotes when the field contains CR or LF', () => {
    expect(quoteField('line1\nline2', ',')).toBe('"line1\nline2"');
    expect(quoteField('a\rb', ',')).toBe('"a\rb"');
  });
});

describe('encodeDelimited', () => {
  it('encodes a simple object array as CSV with a header row', () => {
    expect(encodeDelimited([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], ',')).toBe('a,b\n1,x\n2,y');
  });

  it('encodes as TSV when the delimiter is a tab', () => {
    expect(encodeDelimited([{ a: 1, b: 2 }], '\t')).toBe('a\tb\n1\t2');
  });

  it('uses the first-seen union of keys as the column order; missing keys → empty cells', () => {
    // row1 has a,b; row2 introduces c (appended) and omits a.
    expect(encodeDelimited([{ a: 1, b: 2 }, { b: 3, c: 4 }], ',')).toBe('a,b,c\n1,2,\n,3,4');
  });

  it('quotes values containing the delimiter, quotes, or newlines', () => {
    expect(encodeDelimited([{ a: 'x,y', b: 'p"q', c: 'l1\nl2' }], ',')).toBe(
      'a,b,c\n"x,y","p""q","l1\nl2"',
    );
  });

  it('stringifies cells the cellToString way (null → empty, object → JSON)', () => {
    expect(encodeDelimited([{ a: null, b: { k: 1 } }], ',')).toBe('a,b\n,"{""k"":1}"');
  });

  it('throws ResultEncodeError on a non-array', () => {
    expect(() => encodeDelimited({ a: 1 } as unknown, ',')).toThrow(ResultEncodeError);
    expect(() => encodeDelimited('nope' as unknown, ',')).toThrow(ResultEncodeError);
  });

  it('throws ResultEncodeError on an array of non-objects', () => {
    expect(() => encodeDelimited([1, 2] as unknown, ',')).toThrow(ResultEncodeError);
    expect(() => encodeDelimited([null] as unknown, ',')).toThrow(ResultEncodeError);
    expect(() => encodeDelimited([['nested']] as unknown, ',')).toThrow(ResultEncodeError);
  });

  it('encodes an empty array as a single empty header line', () => {
    expect(encodeDelimited([], ',')).toBe('');
  });
});

describe('encodeMarkdownTable', () => {
  it('renders a GitHub-flavored table with a separator row', () => {
    expect(encodeMarkdownTable([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])).toBe(
      '| a | b |\n| --- | --- |\n| 1 | x |\n| 2 | y |',
    );
  });

  it('escapes pipes and backslashes and flattens newlines to spaces', () => {
    expect(encodeMarkdownTable([{ col: 'a|b\\c\nd' }])).toBe(
      '| col |\n| --- |\n| a\\|b\\\\c d |',
    );
  });

  it('strips carriage returns', () => {
    expect(encodeMarkdownTable([{ x: 'a\r\nb' }])).toBe('| x |\n| --- |\n| a b |');
  });
});

describe('parseRows (RFC 4180)', () => {
  it('returns [] for the empty string', () => {
    expect(parseRows('', ',')).toEqual([]);
  });

  it('parses simple rows', () => {
    expect(parseRows('a,b\nc,d', ',')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('respects quoted fields containing the delimiter', () => {
    expect(parseRows('"a,b",c', ',')).toEqual([['a,b', 'c']]);
  });

  it('un-doubles embedded quotes inside a quoted field', () => {
    expect(parseRows('"she said ""hi"""', ',')).toEqual([['she said "hi"']]);
  });

  it('keeps newlines that live inside a quoted field', () => {
    expect(parseRows('"line1\nline2",x', ',')).toEqual([['line1\nline2', 'x']]);
  });

  it('treats CRLF and bare CR as row terminators', () => {
    expect(parseRows('a,b\r\nc,d', ',')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseRows('a\rb', ',')).toEqual([['a'], ['b']]);
  });

  it('does not emit a phantom trailing row for a final newline', () => {
    expect(parseRows('a,b\n', ',')).toEqual([['a', 'b']]);
    expect(parseRows('a,b\nc', ',')).toEqual([['a', 'b'], ['c']]);
  });

  it('parses TSV with a tab delimiter (commas are literal)', () => {
    expect(parseRows('a,1\tb', '\t')).toEqual([['a,1', 'b']]);
  });
});

describe('decodeDelimited', () => {
  it('decodes to string-coerced row objects keyed by the header', () => {
    expect(decodeDelimited('a,b\n1,x\n2,y', ',')).toEqual([
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ]);
  });

  it('returns [] for empty input and for a header-only document', () => {
    expect(decodeDelimited('', ',')).toEqual([]);
    expect(decodeDelimited('a,b', ',')).toEqual([]);
  });

  it('fills missing trailing cells of a ragged row with empty strings', () => {
    expect(decodeDelimited('a,b,c\n1,2', ',')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('round-trips encode → decode, preserving special characters (the RFC-4180 crux)', () => {
    const rows = [
      { name: 'Ada, Lovelace', note: 'said "hi"', body: 'line1\nline2' },
      { name: 'plain', note: '', body: 'tab\tinside' },
    ];
    for (const delimiter of [',', '\t'] as const) {
      const encoded = encodeDelimited(rows, delimiter);
      // string-coerced (every cell is already a string here) → exact round-trip
      expect(decodeDelimited(encoded, delimiter)).toEqual(rows);
    }
  });

  it('round-trips a column whose value equals the delimiter alone', () => {
    expect(decodeDelimited(encodeDelimited([{ a: ',', b: '\t' }], ','), ',')).toEqual([
      { a: ',', b: '\t' },
    ]);
  });
});
