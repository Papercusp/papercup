/**
 * worker-cap.test.ts — WI-5621 regression guard.
 *
 * `scripts/lib/worker-cap.mjs` caps each Vitest run's fork/thread/worker pool
 * so a single invocation can't grab every core on the shared dev box
 * (WI-3792), and — new in WI-5621 — shrinks that cap further when the host is
 * ALREADY oversubscribed (loadavg above the core count) before this run even
 * starts, since on a large fleet many concurrent test:affected/test:file
 * invocations piling on their own full static cap is what actually produces
 * the fleet-wide CPU contention. Pure-function tests only (no subprocess
 * spawn, no `os.loadavg` stubbing) — see empty-suite-guard.test.ts for the
 * sibling pattern this follows.
 */
import { describe, it, expect } from 'vitest';
import { computeWorkerCap, applyWorkerCapEnv } from '../../../../scripts/lib/worker-cap.mjs';

describe('computeWorkerCap', () => {
  it('matches the original WI-3792 static formula when load is unknown', () => {
    expect(computeWorkerCap({ cores: 128 })).toBe(32); // min(32, max(8, 128/4)) = 32
    expect(computeWorkerCap({ cores: 16 })).toBe(8); // min(32, max(8, 4)) = 8
    expect(computeWorkerCap({ cores: 4 })).toBe(8); // min(32, max(8, 1)) = 8
  });

  it('leaves the static cap unchanged when the host is not yet oversubscribed', () => {
    expect(computeWorkerCap({ cores: 128, load1: 50 })).toBe(32); // load1 < cores
    expect(computeWorkerCap({ cores: 128, load1: 128 })).toBe(32); // exactly at the line
  });

  it('shrinks proportionally once load1 exceeds the core count', () => {
    // load1=256 on 128 cores → 2x oversubscribed → base(32)/2 = 16
    expect(computeWorkerCap({ cores: 128, load1: 256 })).toBe(16);
    // load1=384 on 128 cores → 3x oversubscribed → base(32)/3 = 10 (floored)
    expect(computeWorkerCap({ cores: 128, load1: 384 })).toBe(10);
  });

  it('floors the shrunk cap at 4 so a run can still make forward progress', () => {
    // Wildly oversubscribed (matches the WI-5621 observed 60-100+ loadavg
    // territory scaled up) — must never shrink to 0 or a negative/absurd value.
    expect(computeWorkerCap({ cores: 128, load1: 5000 })).toBe(4);
  });

  it('ignores a non-finite or missing load1 (falls back to the static formula)', () => {
    expect(computeWorkerCap({ cores: 128, load1: NaN })).toBe(32);
    expect(computeWorkerCap({ cores: 128, load1: undefined })).toBe(32);
  });
});

describe('applyWorkerCapEnv', () => {
  it('sets VITEST_MAX_WORKERS/FORKS/THREADS from the computed cap', () => {
    const env: Record<string, string | undefined> = {};
    const cap = applyWorkerCapEnv({ cores: 128, load1: 50, env: env as NodeJS.ProcessEnv });
    expect(cap).toBe('32');
    expect(env.VITEST_MAX_WORKERS).toBe('32');
    expect(env.VITEST_MAX_FORKS).toBe('32');
    expect(env.VITEST_MAX_THREADS).toBe('32');
  });

  it('never overrides a caller-provided VITEST_MAX_WORKERS', () => {
    const env: Record<string, string | undefined> = { VITEST_MAX_WORKERS: '2' };
    const cap = applyWorkerCapEnv({ cores: 128, load1: 5000, env: env as NodeJS.ProcessEnv });
    expect(cap).toBe('2');
    expect(env.VITEST_MAX_FORKS).toBeUndefined(); // short-circuits before touching the others
  });

  it('respects a pre-set MAX_FORKS/MAX_THREADS independently of MAX_WORKERS', () => {
    const env: Record<string, string | undefined> = { VITEST_MAX_FORKS: '99' };
    applyWorkerCapEnv({ cores: 128, load1: 50, env: env as NodeJS.ProcessEnv });
    expect(env.VITEST_MAX_WORKERS).toBe('32');
    expect(env.VITEST_MAX_FORKS).toBe('99'); // left alone
    expect(env.VITEST_MAX_THREADS).toBe('32');
  });
});
