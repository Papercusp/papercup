/**
 * batch-watchdog.test.ts — EI-19370814345784324 regression guard.
 *
 * `scripts/lib/batch-watchdog.mjs` backs the per-batch process-level watchdog
 * `scripts/affected-tests.mjs` applies to every workspace's test spawn: a test
 * that blocks its vitest worker's event loop SYNCHRONOUSLY makes vitest's own
 * `testTimeout` structurally unable to fire (it is a timer on the very loop the
 * spin never yields), so a single wedged worker held the green-checkpoint gate
 * for 74 minutes before being found and killed by hand. `spawnSync`'s `timeout`
 * option bounds this at the PARENT's native (libuv) wait loop instead, which is
 * immune to the child's event loop being blocked.
 *
 * Pure-function tests only (no subprocess spawn) — see worker-cap.test.ts /
 * empty-suite-guard.test.ts for the sibling pattern this follows.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error batch-watchdog.mjs is a standalone Node script without declarations.
import { resolveBatchTimeoutMs, isWatchdogTimeout } from '../../../../scripts/lib/batch-watchdog.mjs';

describe('resolveBatchTimeoutMs', () => {
  it('defaults when unset', () => {
    expect(resolveBatchTimeoutMs(undefined, 1_200_000)).toBe(1_200_000);
  });

  it('honors a positive explicit override', () => {
    expect(resolveBatchTimeoutMs('300000', 1_200_000)).toBe(300_000);
  });

  it('falls back on a non-numeric override rather than producing NaN (would disable the timeout)', () => {
    expect(resolveBatchTimeoutMs('not-a-number', 1_200_000)).toBe(1_200_000);
  });

  it('falls back on zero or negative — spawnSync treats timeout:0 as "no timeout"', () => {
    expect(resolveBatchTimeoutMs('0', 1_200_000)).toBe(1_200_000);
    expect(resolveBatchTimeoutMs('-5', 1_200_000)).toBe(1_200_000);
  });
});

const OPTS = { killSignal: 'SIGKILL', timeoutMs: 1_200_000 };

describe('isWatchdogTimeout', () => {
  it('is true for a kill at (or past) the configured deadline with the configured signal', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_200_000 }, OPTS)).toBe(true);
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_205_000 }, OPTS)).toBe(true);
  });

  it('is true within the slack window just under the exact deadline (scheduling jitter)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_199_000 }, OPTS)).toBe(true);
  });

  it('is false for a normal, non-killed exit (the overwhelmingly common case)', () => {
    expect(isWatchdogTimeout({ signal: null, status: 0 }, OPTS)).toBe(false);
    expect(isWatchdogTimeout({ signal: null, status: 1 }, OPTS)).toBe(false);
  });

  it('is false for a SIGKILL that landed WAY before the deadline — not our watchdog (e.g. OOM killer, an operator kill)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 5_000 }, OPTS)).toBe(false);
  });

  it('is false for a different signal even at the deadline (SIGTERM from somewhere else)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGTERM', status: null, elapsedMs: 1_200_000 }, OPTS)).toBe(false);
  });

  it('treats a missing elapsedMs as 0 rather than throwing (never crash the caller mid-gate-run)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null }, OPTS)).toBe(false);
  });

  it('respects a caller-supplied slackMs', () => {
    const tight = { ...OPTS, slackMs: 0 };
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_199_999 }, tight)).toBe(false);
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_200_000 }, tight)).toBe(true);
  });
});
