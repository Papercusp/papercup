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
// @ts-expect-error worker-cap.mjs is a standalone Node script without declarations.
import { computeWorkerCap, applyWorkerCapEnv } from '../../../../scripts/lib/worker-cap.mjs';

describe('computeWorkerCap', () => {
  it('matches the original WI-3792 static formula when load is unknown', () => {
    expect(computeWorkerCap({ cores: 128 })).toBe(32); // min(32, max(8, 128/4)) = 32
    expect(computeWorkerCap({ cores: 16 })).toBe(8); // min(32, max(8, 4)) = 8
    expect(computeWorkerCap({ cores: 4 })).toBe(8); // min(32, max(8, 1)) = 8
  });

  it('leaves the static cap unchanged below the empirically-flaky load line (~40 on 128 cores)', () => {
    expect(computeWorkerCap({ cores: 128, load1: 30 })).toBe(32); // below the ~40 line
    expect(computeWorkerCap({ cores: 128, load1: 40 })).toBe(32); // right at the line
  });

  it('shrinks proportionally past the empirically-flaky line — covers the actual WI-5621 incident range (loadavg 58-105 on 128 cores)', () => {
    // threshold = 128 * 0.3125 = 40
    expect(computeWorkerCap({ cores: 128, load1: 58 })).toBe(22); // 58/40=1.45 → 32/1.45=22
    expect(computeWorkerCap({ cores: 128, load1: 86 })).toBe(14); // 86/40=2.15 → 32/2.15=14
    expect(computeWorkerCap({ cores: 128, load1: 105 })).toBe(12); // 105/40=2.625 → 32/2.625=12
  });

  it('floors the shrunk cap at 4 so a run can still make forward progress', () => {
    // Wildly oversubscribed — must never shrink to 0 or a negative/absurd value.
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
    const cap = applyWorkerCapEnv({ cores: 128, load1: 20, env: env as NodeJS.ProcessEnv });
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
    applyWorkerCapEnv({ cores: 128, load1: 20, env: env as NodeJS.ProcessEnv });
    expect(env.VITEST_MAX_WORKERS).toBe('32');
    expect(env.VITEST_MAX_FORKS).toBe('99'); // left alone
    expect(env.VITEST_MAX_THREADS).toBe('32');
  });
});
