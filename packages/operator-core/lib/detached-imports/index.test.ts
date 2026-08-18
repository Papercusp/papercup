import { describe, it, expect } from 'vitest';

import { trackDetached, drainDetached, pendingDetachedCount } from './index';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('detached-imports registry', () => {
  it('is a pass-through: returns the SAME promise it was given', () => {
    const p = Promise.resolve('x');
    expect(trackDetached(p)).toBe(p);
  });

  it('drains a slow detached promise instead of returning early', async () => {
    let settled = false;
    void trackDetached(tick(50).then(() => void (settled = true)));

    // The whole point: before the drain the work is still outstanding.
    expect(pendingDetachedCount()).toBe(1);
    expect(settled).toBe(false);

    const drained = await drainDetached();

    expect(settled).toBe(true);
    expect(drained).toBe(1);
    expect(pendingDetachedCount()).toBe(0);
  });

  it('drains work that is registered DURING the drain (a lazy import that fires another)', async () => {
    let inner = false;
    void trackDetached(
      tick(10).then(() => {
        void trackDetached(tick(10).then(() => void (inner = true)));
      }),
    );

    const drained = await drainDetached();

    expect(inner).toBe(true);
    expect(drained).toBe(2);
    expect(pendingDetachedCount()).toBe(0);
  });

  it('a REJECTING detached promise neither throws from the drain nor escapes as unhandled', async () => {
    // The caller keeps its own error handling; the registry's mirror must swallow.
    void trackDetached(tick(5).then(() => Promise.reject(new Error('boom')))).catch(() => {});

    await expect(drainDetached()).resolves.toBeGreaterThanOrEqual(1);
    expect(pendingDetachedCount()).toBe(0);
  });

  it('drains to zero even when several are in flight at once', async () => {
    for (let i = 0; i < 5; i += 1) void trackDetached(tick(5 + i));
    expect(pendingDetachedCount()).toBe(5);

    await drainDetached();

    expect(pendingDetachedCount()).toBe(0);
  });

  // CONTROL (falsifiability, per the repo's mutation-probe discipline): a "drain" that ignores
  // the registry — the shape of the bug this module exists to prevent — must FAIL the same
  // assertion the real drain passes. Kept permanently in the test file rather than mutating
  // production code, so the guard is proven falsifiable without ever dirtying the shared tree.
  it('CONTROL: a no-op drain does NOT settle the work (so the assertions above have teeth)', async () => {
    let settled = false;
    const p = tick(50).then(() => void (settled = true));
    void trackDetached(p);

    const noopDrain = async (): Promise<number> => 0; // ignores the registry
    await noopDrain();

    expect(settled).toBe(false); // the real drain would have made this true

    await drainDetached(); // clean up so we do not leak into the next test
    expect(settled).toBe(true);
  });
});
