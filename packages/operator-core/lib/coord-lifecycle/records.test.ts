/**
 * Unit tests for the pure record-boundary helpers in records.ts.
 *
 * EI-18764241942332131: Postgres' jsonb text-input parser rejects a literal NUL
 * byte with the opaque "unsupported Unicode escape sequence" — `stripNulBytesDeep`
 * is the sanitizer that keeps a NUL from ever reaching that write, and
 * `terminalPayloadMergeJson` is the shared terminal-write chokepoint that applies
 * it as a defense-in-depth backstop for every caller (work-items.ts and
 * issues-engineer.ts both funnel through it).
 *
 * NUL is built via String.fromCharCode(0) throughout — never a source literal.
 * Several editors/terminals (and the toolchain used to author this fix) render an
 * embedded raw NUL byte as a plain space, which makes a hand-typed literal
 * indistinguishable from an actual space and easy to get wrong silently.
 */

import { describe, it, expect } from 'vitest';
import { stripNulBytesDeep, terminalPayloadMergeJson } from './records';

const NUL = String.fromCharCode(0);

describe('stripNulBytesDeep (EI-18764241942332131)', () => {
  it('returns the SAME reference and stripped:false when there is no NUL anywhere', () => {
    const input = { a: 'clean', b: ['also clean', 42], c: { d: true } };
    const { value, stripped } = stripNulBytesDeep(input);
    expect(stripped).toBe(false);
    expect(value).toBe(input); // reference equality — no needless clone
  });

  it('strips a NUL from a bare string', () => {
    const { value, stripped } = stripNulBytesDeep(`before${NUL}after`);
    expect(stripped).toBe(true);
    expect(value).toBe('beforeafter');
  });

  it('strips a NUL nested inside an object', () => {
    const { value, stripped } = stripNulBytesDeep({ testResult: `ok${NUL}!`, testsRun: 'clean' });
    expect(stripped).toBe(true);
    expect(value).toEqual({ testResult: 'ok!', testsRun: 'clean' });
  });

  it('strips a NUL nested inside an array', () => {
    const { value, stripped } = stripNulBytesDeep(['clean', `dirty${NUL}`, 3]);
    expect(stripped).toBe(true);
    expect(value).toEqual(['clean', 'dirty', 3]);
  });

  it('strips multiple NULs across multiple fields in one pass', () => {
    const { value, stripped } = stripNulBytesDeep({
      summary: `a${NUL}b`,
      filesChanged: [`x${NUL}.ts`, 'clean.ts'],
      nested: { note: `c${NUL}${NUL}d` },
    });
    expect(stripped).toBe(true);
    expect(value).toEqual({
      summary: 'ab',
      filesChanged: ['x.ts', 'clean.ts'],
      nested: { note: 'cd' },
    });
  });

  it('leaves non-string primitives (numbers/booleans/null) untouched', () => {
    const input = { n: 42, b: true, nul: null, s: `x${NUL}y` };
    const { value, stripped } = stripNulBytesDeep(input);
    expect(stripped).toBe(true);
    expect(value).toEqual({ n: 42, b: true, nul: null, s: 'xy' });
  });
});

describe('terminalPayloadMergeJson NUL defense-in-depth (EI-18764241942332131)', () => {
  it('produces jsonb-safe text (no raw NUL) even when the evidence carries one', () => {
    const json = terminalPayloadMergeJson({ testResult: `repro: a raw${NUL}byte`, verifiedHow: 'unit' });
    expect(json).not.toBeNull();
    expect(json!.includes(NUL)).toBe(false);
    const parsed = JSON.parse(json!);
    expect(parsed._completionEvidence.testResult).toBe('repro: a rawbyte');
  });

  it('still returns null when there is nothing to merge', () => {
    expect(terminalPayloadMergeJson(undefined, undefined)).toBeNull();
    expect(terminalPayloadMergeJson({}, undefined)).toBeNull();
  });

  it('is unaffected (byte-identical to before) when evidence has no NUL', () => {
    const json = terminalPayloadMergeJson({ testResult: 'clean', verifiedHow: 'unit' });
    expect(JSON.parse(json!)).toEqual({ _completionEvidence: { testResult: 'clean', verifiedHow: 'unit' } });
  });

  it('persists completion narrative on the shared terminal payload surface (EI-21478999218933285)', () => {
    const narrative = {
      whatLanded: ['the existing terminal read now carries the close narrative'],
      deferred: ['deployment proof remains on EI-42'],
      coordNotes: 'leader should inspect the deferred set',
    };

    const json = terminalPayloadMergeJson(narrative);
    expect(JSON.parse(json!)).toEqual({ _completionEvidence: narrative });
  });
});
