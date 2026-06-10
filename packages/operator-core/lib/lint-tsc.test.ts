/**
 * Audit P-073 (EI-104) — lint:tsc gate logic:
 *   - ratchet-only-down (a below-baseline run lowers the baseline; nothing
 *     here ever raises it),
 *   - hard-fail on syntax-broken files (TS1xxx) regardless of count,
 *   - per-file error attribution from raw tsc output.
 *
 * The script's pure functions are imported directly (same pattern as
 * apps/operator's psu-pty-host / ptool script tests).
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import { parseTscErrors, syntaxBrokenFiles, decide } from '../../../scripts/lint-tsc.mjs';

const SAMPLE = [
  "lib/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "lib/foo.ts(22,1): error TS2339: Property 'x' does not exist on type 'Y'.",
  "lib/broken.ts(1,1): error TS1005: ';' expected.",
  'some banner line without an error',
  'error TS5042: Option project cannot be mixed with source files.',
].join('\n');

describe('parseTscErrors', () => {
  it('extracts file + code per diagnostic, tolerating unattributed lines', () => {
    const errors = parseTscErrors(SAMPLE);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toEqual({ file: 'lib/foo.ts', code: 'TS2322' });
    expect(errors[2]).toEqual({ file: 'lib/broken.ts', code: 'TS1005' });
    expect(errors[3]).toEqual({ file: null, code: 'TS5042' });
  });

  it('returns [] for clean output', () => {
    expect(parseTscErrors('')).toEqual([]);
    expect(parseTscErrors('all good\n')).toEqual([]);
  });
});

describe('syntaxBrokenFiles', () => {
  it('flags only files with TS1xxx parse errors', () => {
    expect(syntaxBrokenFiles(parseTscErrors(SAMPLE))).toEqual(['lib/broken.ts']);
  });

  it('does not confuse TS1xxx with longer codes (TS1xxxx)', () => {
    const errors = parseTscErrors(
      'lib/a.ts(1,1): error TS18046: x is of type unknown.',
    );
    expect(syntaxBrokenFiles(errors)).toEqual([]);
  });
});

describe('decide — ratchet-only-down + syntax hard-fail', () => {
  it('syntax-broken files fail even when the count is under baseline', () => {
    const r = decide({ errorCount: 1, baselineCount: 500, brokenFiles: ['lib/broken.ts'] });
    expect(r.verdict).toBe('fail-syntax');
  });

  it('above baseline fails', () => {
    expect(decide({ errorCount: 476, baselineCount: 475, brokenFiles: [] }).verdict)
      .toBe('fail-exceeds');
  });

  it('below baseline ratchets the baseline down', () => {
    const r = decide({ errorCount: 470, baselineCount: 475, brokenFiles: [] });
    expect(r).toEqual({ verdict: 'ok-ratchet', newBaseline: 470 });
  });

  it('at baseline is ok and never raises', () => {
    expect(decide({ errorCount: 475, baselineCount: 475, brokenFiles: [] }).verdict).toBe('ok');
  });
});
