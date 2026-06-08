/**
 * Tests for the result-format vocabulary + negotiation parsing.
 * Run with: npx vitest run libs/generic/result-encoding/src/formats.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  isResultFormat,
  mimeForFormat,
  parseFormatRequest,
  RESULT_FORMATS,
  COMPACT_FORMATS,
  ResultEncodeError,
} from './formats';

describe('format constants', () => {
  it('lists every format with json first; compact excludes json', () => {
    expect(RESULT_FORMATS).toEqual(['json', 'toon', 'csv', 'tsv', 'md']);
    expect(COMPACT_FORMATS).toEqual(['toon', 'csv', 'tsv', 'md']);
    expect(COMPACT_FORMATS).not.toContain('json');
  });
});

describe('isResultFormat', () => {
  it('accepts the five formats and rejects everything else', () => {
    for (const f of RESULT_FORMATS) expect(isResultFormat(f)).toBe(true);
    for (const v of ['compact', 'xml', 'JSON', '', 123, null, undefined]) {
      expect(isResultFormat(v)).toBe(false);
    }
  });
});

describe('mimeForFormat', () => {
  it('maps each format to its canonical MIME', () => {
    expect(mimeForFormat('json')).toBe('application/json');
    expect(mimeForFormat('toon')).toBe('application/toon');
    expect(mimeForFormat('csv')).toBe('text/csv');
    expect(mimeForFormat('tsv')).toBe('text/tab-separated-values');
    expect(mimeForFormat('md')).toBe('text/markdown');
  });
});

describe('parseFormatRequest', () => {
  it('returns undefined for empty/unrecognized input', () => {
    expect(parseFormatRequest(null)).toBeUndefined();
    expect(parseFormatRequest(undefined)).toBeUndefined();
    expect(parseFormatRequest('')).toBeUndefined();
    expect(parseFormatRequest('   ')).toBeUndefined();
    expect(parseFormatRequest('yaml')).toBeUndefined();
  });

  it('passes "compact" through and resolves the friendly aliases', () => {
    expect(parseFormatRequest('compact')).toBe('compact');
    expect(parseFormatRequest('full')).toBe('json');
    expect(parseFormatRequest('tabular')).toBe('csv');
  });

  it('recognizes the format tokens case-insensitively', () => {
    expect(parseFormatRequest('toon')).toBe('toon');
    expect(parseFormatRequest('CSV')).toBe('csv');
    expect(parseFormatRequest(' MD ')).toBe('md');
  });

  it('maps MIME types (incl. toon + tsv aliases)', () => {
    expect(parseFormatRequest('application/json')).toBe('json');
    expect(parseFormatRequest('text/x-toon')).toBe('toon');
    expect(parseFormatRequest('text/csv')).toBe('csv');
    expect(parseFormatRequest('text/tsv')).toBe('tsv');
    expect(parseFormatRequest('text/markdown')).toBe('md');
  });

  it('strips Accept-header params before matching the MIME', () => {
    expect(parseFormatRequest('text/csv; q=0.9')).toBe('csv');
  });
});

describe('ResultEncodeError', () => {
  it('is an Error with a stable name', () => {
    const e = new ResultEncodeError('nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ResultEncodeError');
    expect(e.message).toBe('nope');
  });
});
