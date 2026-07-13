/**
 * lint:tsc gate logic (audit P-073 / EI-104; per-file migration P-010 / WI-4535):
 *   - per-file baseline: a file above ITS baseline is a NEW, ATTRIBUTED regression,
 *   - --mine scopes the failure to files the caller changed (peer drift is reported, not gated),
 *   - ratchet-only-down per file on --update,
 *   - hard-fail on syntax-broken files (TS1xxx) regardless of counts,
 *   - per-file error attribution from raw tsc output.
 *
 * The script's pure functions are imported directly (same pattern as apps/operator's
 * psu-pty-host / ptool script tests).
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import { parseTscErrors, syntaxBrokenFiles, countByFile, decidePerFile } from '../../../scripts/lint-tsc.mjs';

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
    const errors = parseTscErrors('lib/a.ts(1,1): error TS18046: x is of type unknown.');
    expect(syntaxBrokenFiles(errors)).toEqual([]);
  });
});

describe('countByFile', () => {
  it('aggregates errors per file, bucketing unattributed under (unattributed)', () => {
    expect(countByFile(parseTscErrors(SAMPLE))).toEqual({
      'lib/foo.ts': 2,
      'lib/broken.ts': 1,
      '(unattributed)': 1,
    });
  });
});

// P-010 / WI-4535: the per-file gate. The old gate compared ONE integer total against a single pin
// (224) — it could not attribute a regression and flapped ±N under concurrent edits. These pin the
// per-file replacement: a file above ITS baseline is a named regression; a flap in file A never
// reds an agent editing file B; --mine scopes the failure to the caller's changed files.
describe('decidePerFile — per-file attribution + --update-only ratchet + syntax hard-fail', () => {
  const brokenFree = [];

  it('syntax-broken files hard-fail regardless of counts', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1 },
      baselineByFile: { 'a.ts': 500 },
      brokenFiles: ['lib/broken.ts'],
    });
    expect(r.verdict).toBe('fail-syntax');
    expect(r.brokenFiles).toEqual(['lib/broken.ts']);
  });

  it('every file at its baseline is ok', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 2, 'b.ts': 1 }, baselineByFile: { 'a.ts': 2, 'b.ts': 1 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('ok');
    expect(r.regressions).toEqual([]);
  });

  it('a file ABOVE its baseline is an attributed regression (fail-regressed, NAMED with old→new)', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 4, 'b.ts': 1 }, baselineByFile: { 'a.ts': 2, 'b.ts': 1 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions).toEqual([{ file: 'a.ts', baseline: 2, current: 4, delta: 2 }]);
  });

  it('a NEW file with errors (absent from baseline ⇒ implicit 0) is a regression', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 2, 'new.ts': 1 }, baselineByFile: { 'a.ts': 2 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions.map((x) => x.file)).toEqual(['new.ts']);
  });

  it('does NOT red an agent editing file B when only file A flapped up (attribution isolates the cause)', () => {
    // file A regressed +1, but the agent only touched b.ts → their change is clean under --mine.
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift.map((x) => x.file)).toEqual(['a.ts']);
    expect(r.attributed).toEqual([]);
  });

  it('--mine FAILS when the regression IS in a file the caller changed', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed.map((x) => x.file)).toEqual(['a.ts']);
  });

  it('a bare run (no --mine) gates ANY regression — CI stays strict', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3 },
      baselineByFile: { 'a.ts': 2 },
      brokenFiles: brokenFree,
      changedFiles: null,
    });
    expect(r.verdict).toBe('fail-regressed');
  });

  it('below baseline on a BARE run is check-only (ok-below) — no ratchet, no baseline rewrite', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 1 }, baselineByFile: { 'a.ts': 3 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('ok-below');
    expect(r.improvements).toEqual([{ file: 'a.ts', baseline: 3, current: 1, delta: -2 }]);
    expect(r.newBaselineByFile).toBeUndefined();
  });

  it('below baseline WITH --update ratchets improved files down (newBaselineByFile = current)', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 1, 'b.ts': 2 }, baselineByFile: { 'a.ts': 3, 'b.ts': 2 }, brokenFiles: brokenFree, updateFlag: true });
    expect(r.verdict).toBe('ok-ratchet');
    expect(r.newBaselineByFile).toEqual({ 'a.ts': 1, 'b.ts': 2 });
  });

  it('regressions win over improvements — --update can never RAISE a file (ratchet-only-down)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 5, 'b.ts': 1 }, // a regressed, b improved
      baselineByFile: { 'a.ts': 2, 'b.ts': 3 },
      brokenFiles: brokenFree,
      updateFlag: true,
    });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.newBaselineByFile).toBeUndefined();
  });
});
