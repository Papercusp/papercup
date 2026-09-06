// P-003 (plan gate-latency-selection-and-retry-policy-2026-09-06): the retry decision reads the
// first pass's failure SHAPE. Pins the four branches and the fail-safe direction: a flake
// signature always earns a retry; a broad deterministic red never does.
import { describe, expect, it } from 'vitest';

import {
  RETRY_FLAKE_CLASSES,
  RETRY_SMALL_RED_FILES,
  decideRetry,
  formatRetryDecisionLine,
  matchRetryFlakeClasses,
} from '../../../../scripts/lib/retry-failure-shape.mjs';

const MAX = 15;
const files = (n: number) => Array.from({ length: n }, (_, i) => `lib/f${i}.test.ts`);
const ASSERTION_RED = [
  'FAIL lib/f0.test.ts > renders',
  'AssertionError: expected "a" to deeply equal "b"',
  '- Expected',
  '+ Received',
].join('\n');

describe('matchRetryFlakeClasses', () => {
  it('names every class it recognises, in catalogue order', () => {
    const out =
      'Error: Test timed out in 60000ms\n' +
      'Error: connect ECONNREFUSED 127.0.0.1:5432\n' +
      'listen EADDRINUSE: address already in use :::3070\n' +
      'Expected test not to call console.error()\n' +
      'FATAL ERROR: Reached heap limit\n' +
      'Error: Transform failed with 1 error';
    expect(matchRetryFlakeClasses(out)).toEqual(RETRY_FLAKE_CLASSES.map((c) => c.id));
  });

  it('sees nothing in an assertion diff, or in no output at all', () => {
    expect(matchRetryFlakeClasses(ASSERTION_RED)).toEqual([]);
    expect(matchRetryFlakeClasses('')).toEqual([]);
    // @ts-expect-error — runtime callers pass null when capture was streamed
    expect(matchRetryFlakeClasses(null)).toEqual([]);
  });
});

describe('decideRetry', () => {
  it('SKIPS a broad deterministic red — the e70cd139 shape: 36 assertion failures, no flake signature', () => {
    const d = decideRetry({ failedFiles: files(36), output: ASSERTION_RED, maxFiles: MAX });
    expect(d.retry).toBe(false);
    expect(d.mode).toBe('none');
    expect(d.reason).toBe('broad-deterministic-red(36>15)');
    expect(formatRetryDecisionLine('@papercusp/operator-core', d)).toBe(
      'AFFECTED_RETRY_SKIPPED ws=@papercusp/operator-core retry=0 mode=none failedFiles=36 flakeClasses=none ' +
        'reason=broad-deterministic-red(36>15)',
    );
  });

  it('SKIPS a mid-sized deterministic red too (above the small-red floor, no signature)', () => {
    const d = decideRetry({ failedFiles: files(RETRY_SMALL_RED_FILES + 1), output: ASSERTION_RED, maxFiles: MAX });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/^deterministic-shape\(4 file\(s\)/);
  });

  it('retries a TINY red regardless of shape — seconds of cost, highest flake likelihood', () => {
    const d = decideRetry({ failedFiles: files(RETRY_SMALL_RED_FILES), output: ASSERTION_RED, maxFiles: MAX });
    expect(d).toMatchObject({ retry: true, mode: 'fresh-files', reason: `small-red(${RETRY_SMALL_RED_FILES}<=${RETRY_SMALL_RED_FILES})` });
  });

  it('retries the failed files fresh when a flake class is present and the set fits the cap', () => {
    const d = decideRetry({
      failedFiles: files(8),
      output: `${ASSERTION_RED}\nError: Hook timed out in 30000ms`,
      maxFiles: MAX,
    });
    expect(d).toMatchObject({ retry: true, mode: 'fresh-files', flakeClasses: ['test-timeout'] });
    expect(formatRetryDecisionLine('ws', d)).toMatch(/^AFFECTED_RETRY_DECISION ws=ws retry=1 mode=fresh-files failedFiles=8 flakeClasses=test-timeout reason=flake-class:test-timeout$/);
  });

  it('retries the WHOLE workspace when a flake class is present but the set exceeds the cap (unchanged behaviour)', () => {
    const d = decideRetry({ failedFiles: files(40), output: 'listen EADDRINUSE :::9071', maxFiles: MAX });
    expect(d).toMatchObject({ retry: true, mode: 'whole-workspace', reason: 'flake-class:port-conflict(broad)' });
  });

  it('keeps the conservative whole-workspace retry when nothing parsed (unattributed failure)', () => {
    const d = decideRetry({ failedFiles: [], output: 'npm ERR! something else entirely', maxFiles: MAX });
    expect(d).toMatchObject({ retry: true, mode: 'whole-workspace', reason: 'unattributed-failure' });
  });
});
