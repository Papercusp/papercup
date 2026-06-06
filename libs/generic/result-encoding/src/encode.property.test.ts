/**
 * Property-based round-trip tests (fast-check). The load-bearing invariant of
 * the encoder is the lossless-to-JSON guarantee for TOON — examples undercount
 * the ways a serializer can mangle a value, so we assert it over generated
 * JSON. CSV is lossy-by-design, so its property is the weaker string-coerced
 * round-trip over arrays of flat string records.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { encode, decode, encodeAuto, encodeToonChecked, encodeDelimited, decodeDelimited } from './index';

describe('property — the auto path is ALWAYS lossless', () => {
  // The guarantee that matters: encodeAuto never returns a compact payload that
  // fails to decode back to the input. TOON has rare edge cases (pathological
  // keys); the checked encoder falls back to JSON so the agent is never handed
  // a corrupt payload. This must hold for arbitrary JSON.
  it('decode(encodeAuto(v).text, encodeAuto(v).format) deep-equals v for arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const canonical = JSON.parse(JSON.stringify(v));
        const { format, text } = encodeAuto(canonical);
        expect(decode(text, format)).toEqual(canonical);
      }),
      { numRuns: 1000 },
    );
  });

  it('encodeToonChecked only reports lossless when the round-trip actually holds', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const canonical = JSON.parse(JSON.stringify(v));
        const { text, lossless } = encodeToonChecked(canonical);
        if (lossless) expect(decode(text, 'toon')).toEqual(canonical);
      }),
      { numRuns: 1000 },
    );
  });

  it('toon round-trips arrays of uniform records (the tabular path)', () => {
    const record = fc.record({
      id: fc.integer(),
      name: fc.string(),
      active: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(record), (rows) => {
        expect(decode(encode(rows, 'toon'), 'toon')).toEqual(rows);
      }),
      { numRuns: 300 },
    );
  });
});

describe('property — csv string-coerced round-trip', () => {
  it('decodeDelimited(encodeDelimited(rows)) recovers the string rows under RFC 4180', () => {
    // Arrays of records sharing one key set, all string values — the shape CSV
    // is lossless on. Exercises quoting of commas / quotes / CR / LF.
    const keys = ['a', 'b', 'c'];
    const rowArb = fc.record({
      a: fc.string(),
      b: fc.string(),
      c: fc.string(),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1 }), (rows) => {
        const csv = encodeDelimited(rows, ',');
        const back = decodeDelimited(csv, ',');
        expect(back).toEqual(rows);
        // Column set preserved.
        if (back.length > 0) expect(Object.keys(back[0])).toEqual(keys);
      }),
      { numRuns: 300 },
    );
  });

  it('tsv round-trips string rows containing commas without quoting', () => {
    const rowArb = fc.record({ a: fc.string(), b: fc.string() });
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1 }), (rows) => {
        // TSV delimiter is tab; values may freely contain commas. Exclude tabs
        // from this assertion path by mapping them out (tab IS the delimiter).
        const safe = rows.map((r) => ({ a: r.a.replaceAll('\t', ' '), b: r.b.replaceAll('\t', ' ') }));
        expect(decodeDelimited(encodeDelimited(safe, '\t'), '\t')).toEqual(safe);
      }),
      { numRuns: 200 },
    );
  });
});
