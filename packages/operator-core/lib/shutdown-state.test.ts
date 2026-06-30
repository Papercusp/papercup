/**
 * shutdown-state.test.ts — the per-process drain flag (infra round-4 P-005).
 *
 * The flag gates the auto-implement dispatch loop's "stop claiming new work once
 * SIGTERM lands" guard. Here we pin the module's own contract: starts false, one
 * markShuttingDown() flips it true, idempotent, and the test seam resets it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isShuttingDown, markShuttingDown, __resetShutdownStateForTest } from './shutdown-state';

describe('shutdown-state — per-process drain flag', () => {
  afterEach(() => __resetShutdownStateForTest());

  it('starts false (a fresh process is not draining)', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('markShuttingDown() flips it true', () => {
    markShuttingDown();
    expect(isShuttingDown()).toBe(true);
  });

  it('is idempotent: marking twice stays true (a 2nd SIGTERM is harmless)', () => {
    markShuttingDown();
    markShuttingDown();
    expect(isShuttingDown()).toBe(true);
  });

  it('the test reset seam clears it back to false', () => {
    markShuttingDown();
    __resetShutdownStateForTest();
    expect(isShuttingDown()).toBe(false);
  });
});
