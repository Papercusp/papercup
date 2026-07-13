/**
 * cleanup-bounded.test.ts — Docker-free unit regression test for the bounded
 * test-teardown helper (EI-10581).
 *
 * The heavy hyperbee federation rigs used to drain their cleanup stack with an
 * unbounded `while (cleanups.length) await cleanups.pop()()` loop, so under load a
 * single hung resource-close (`swarm.destroy()`, a PG connection drop, …) blocked the
 * `afterEach` past vitest's 90s integration `hookTimeout` and reddened a test whose
 * assertions had already passed. `_cleanup-bounded.ts` bounds each step + the whole
 * drain so teardown fails fast + clean instead. These are pure timing/control-flow
 * assertions — no Docker, no testcontainers, no real swarm/PG — so the FIX MECHANISM
 * is verified even where the integration test itself can't run.
 */
import { describe, it, expect } from 'vitest';
import { runCleanupBounded, drainCleanupsBounded } from './_cleanup-bounded';

const hang = () => new Promise<void>(() => { /* never resolves */ });

describe('bounded test-teardown (EI-10581 hook-timeout guard)', () => {
  it('runs a fast cleanup step to completion', async () => {
    let ran = false;
    await runCleanupBounded(() => { ran = true; }, 1_000);
    expect(ran).toBe(true);
  });

  it('awaits an async cleanup step that settles under the bound', async () => {
    let ran = false;
    await runCleanupBounded(async () => {
      await new Promise((r) => setTimeout(r, 5));
      ran = true;
    }, 1_000);
    expect(ran).toBe(true);
  });

  it('swallows a throwing cleanup step (sync and async) — never propagates', async () => {
    await expect(runCleanupBounded(() => { throw new Error('boom'); }, 1_000)).resolves.toBeUndefined();
    await expect(
      runCleanupBounded(async () => { throw new Error('async boom'); }, 1_000),
    ).resolves.toBeUndefined();
  });

  it('abandons a hung cleanup step within ~boundMs instead of blocking forever', async () => {
    const start = Date.now();
    await runCleanupBounded(hang, 40);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000); // returned promptly — did NOT hang
    expect(elapsed).toBeGreaterThanOrEqual(25); // waited ~the bound before giving up
  });

  it('drains a newest-first stack, still attempting every step even when one hangs', async () => {
    const order: string[] = [];
    const cleanups: Array<() => void | Promise<void>> = [
      () => { order.push('a'); },              // pushed first  → popped LAST
      async () => { order.push('b'); await hang(); }, // hangs after marking → abandoned
      () => { order.push('c'); },              // pushed last   → popped FIRST
    ];
    await drainCleanupsBounded(cleanups, { perStepMs: 40, totalMs: 5_000 });
    expect(cleanups.length).toBe(0); // stack fully drained
    expect(order).toEqual(['c', 'b', 'a']); // newest-first; the hung step was still attempted
  });

  it('stops draining once the total budget is exhausted (bounds the whole teardown)', async () => {
    const cleanups: Array<() => void | Promise<void>> = Array.from({ length: 6 }, () => hang);
    const start = Date.now();
    await drainCleanupsBounded(cleanups, { perStepMs: 30, totalMs: 90 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // ~totalMs, NOT 6×perStepMs of serial hangs
    expect(cleanups.length).toBe(0); // remaining steps abandoned, stack cleared
  });

  it('is a no-op on an empty stack and never throws', async () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    await expect(drainCleanupsBounded(cleanups)).resolves.toBeUndefined();
    expect(cleanups.length).toBe(0);
  });
});
