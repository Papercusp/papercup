/**
 * _cleanup-bounded.ts — bound test-teardown so one hung resource-close can't eat
 * the whole `afterEach` hook budget.
 *
 * The heavy hyperbee federation rigs (`_hive-substrate-rig.ts`, `_cross-peer-rig.ts`,
 * …) tear down, SERIALLY and UNBOUNDED, several real async resources per test — 2+
 * Postgres connections, 2 Hyperswarms, a testnet DHT, temp dirs. Under load any one
 * close (a `swarm.destroy()`, a `handle.close()`, a PG connection drop) can hang; the
 * classic `while (cleanups.length) await cleanups.pop()()` loop then blocks the
 * `afterEach` past vitest's 90s integration `hookTimeout` and reddens a test whose
 * assertions ALREADY PASSED.
 *
 * That is exactly EI-10581: the cross-hive-grant federation suite's dominant,
 * load-correlated failure is `G25 … : Hook timed out in 90000ms` — the test body
 * (60s budget) passes fast whenever the box isn't saturated, but under load a single
 * hung teardown step eats the 90s hook budget. Clean passes are ~5–12s; every
 * hook-timeout failure is 135–186s.
 *
 * Bounding each step (and the whole drain) makes teardown fail FAST + CLEAN: a leaked
 * handle at process exit is harmless (the process is exiting); a hung hook fails the
 * suite. On a HEALTHY run every close settles far under the per-step bound, so the
 * timer never fires and behaviour is byte-identical to the old unbounded loop — this
 * can only make teardown faster, never slower or wronger.
 *
 * NOTE: this bounds the TEARDOWN-hang failure class only. A run where the testcontainer
 * Postgres itself dies mid-test (`write CONNECTION_ENDED …`) is a separate infra-capacity
 * subclass that no test-side teardown change can fix.
 */

export interface DrainBounds {
  /** Max wall-clock for a SINGLE cleanup step before it is abandoned (default 8s). */
  perStepMs?: number;
  /** Max wall-clock for the ENTIRE drain — keep it under the caller's hook budget
   *  (default 75s, comfortably below the 90s integration `hookTimeout`). */
  totalMs?: number;
}

/**
 * Await `step`, abandoning it if it hangs past `boundMs`. A hang OR a throw is
 * swallowed — teardown must never leak an error, and a hung close must never block
 * the hook. Resolves when the step settles or the bound elapses (whichever first).
 */
export async function runCleanupBounded(step: () => void | Promise<void>, boundMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // Wrap in Promise.resolve().then so a SYNCHRONOUS throw becomes a rejection
      // the race can catch, not an escape past Promise.race.
      Promise.resolve().then(step),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('cleanup-step-timeout')), boundMs);
        // Don't let this guard timer keep the event loop / process alive on its own.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    /* hung or threw — swallow; the process exit reclaims any leaked handle */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Drain a newest-first cleanup stack (LIFO, matching the resource-acquisition order
 * the rigs push) with per-step + overall bounds, so the whole teardown returns well
 * under the caller's hook budget even if individual closes hang. Always empties the
 * stack (remaining steps are abandoned once the overall budget is spent). Never throws.
 */
export async function drainCleanupsBounded(
  cleanups: Array<() => void | Promise<void>>,
  { perStepMs = 8_000, totalMs = 75_000 }: DrainBounds = {},
): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (cleanups.length) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Out of budget — abandon the rest; process exit reclaims the handles.
      cleanups.length = 0;
      break;
    }
    await runCleanupBounded(cleanups.pop()!, Math.min(perStepMs, remaining));
  }
}
