/**
 * bounded-timeout — race a promise against a deadline; degrade to a fallback
 * value instead of hanging (or failing the whole caller) when the promise is
 * too slow (WI-3818).
 *
 * WHY: fleet:status (+ coord:orient's fleet-health fold) fan out to several
 * independent PG reads (presence, assignments, completion-stats, per-member
 * Tier-1/wakeability). None of those sub-reads carried an internal budget, so
 * during the 2026-07-10 host-load storm ANY ONE of them stalling silently
 * blocked the WHOLE call until the 55s MCP client timeout fired — the caller
 * got NOTHING back instead of a slim-but-usable partial result. Wrapping each
 * sub-read in `withBoundedTimeout` bounds the blast radius of one slow leg to
 * its own `timeoutMs` and lets the caller assemble a degraded-but-useful
 * response from whichever legs answered in time.
 *
 * This is a plain `Promise.race` — it does NOT cancel the underlying query (a
 * postgres.js query started via the pooled client has no cheap cancel hook at
 * this call site); the late resolution/rejection is swallowed so it never
 * surfaces as an unhandled rejection after the caller has already moved on
 * with the fallback.
 */

export interface BoundedTimeoutResult<T> {
  value: T;
  /** true when the deadline fired first (fallback used) or the work threw. */
  degraded: boolean;
  /** Why `degraded` is true — absent when not degraded. */
  reason?: 'timeout' | 'error';
  /** The error message, when `reason === 'error'`. */
  errorMessage?: string;
  elapsedMs: number;
}

const TIMEOUT_SENTINEL = Symbol('bounded-timeout:deadline');

/**
 * Run `work` (a promise, or a promise-returning thunk — a thunk lets the
 * caller defer starting the work until inside this function, though the
 * query itself still runs to completion in the background even after a
 * timeout degrades the caller). Resolves within `timeoutMs` + a tick,
 * NEVER throws and NEVER hangs past the deadline.
 */
export async function withBoundedTimeout<T>(
  work: Promise<T> | (() => Promise<T>),
  opts: { fallback: T; timeoutMs: number; label?: string },
): Promise<BoundedTimeoutResult<T>> {
  const startedAt = Date.now();
  const promise = typeof work === 'function' ? work() : work;
  // A late resolution/rejection arriving after we've already degraded must
  // never become an unhandled rejection.
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), Math.max(1, opts.timeoutMs));
  });
  try {
    const result = await Promise.race([promise, deadline]);
    if (result === TIMEOUT_SENTINEL) {
      console.warn(
        `[bounded-timeout]${opts.label ? ` ${opts.label}` : ''} exceeded ${opts.timeoutMs}ms — degrading to fallback`,
      );
      return { value: opts.fallback, degraded: true, reason: 'timeout', elapsedMs: Date.now() - startedAt };
    }
    return { value: result as T, degraded: false, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[bounded-timeout]${opts.label ? ` ${opts.label}` : ''} failed: ${errorMessage} — degrading to fallback`,
    );
    return { value: opts.fallback, degraded: true, reason: 'error', errorMessage, elapsedMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
