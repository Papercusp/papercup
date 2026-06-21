/**
 * Shared deadline + degraded-latch for memory backend calls.
 *
 * B1 (infra-fail-fast-build-integrity-2026-06-19). The explicit memory TOOLS
 * (memory:search / remember / list / update / forget) called `backend.*()`
 * with NO deadline. When mem0 failed to load — the 2026-06-19 :3070 outage,
 * where papercup-release's better-sqlite3 native addon was built for the wrong
 * Node ABI — every memory-touching MCP/HTTP handler hung FOREVER while the
 * shallow health probe stayed green. A per-call deadline converts an infinite
 * (or 55s-transport-capped) hang into a bounded, legible degraded result the
 * caller can surface immediately.
 *
 * This primitive was previously private to `injection.ts` and only guarded the
 * pre-turn auto-injection (push) path. It now lives here so BOTH paths share
 * one process-level degraded latch: a timeout anywhere quiets the hot per-turn
 * inject path immediately (it stops paying the deadline every turn), while the
 * explicit tools keep attempting under their own deadline so they recover once
 * the backend does. The latch resets on restart — the backend's own
 * poison-cache handles client-level recovery.
 */

/** Thrown when a memory backend call exceeds its deadline. Distinct from
 *  `MemoryUnavailableError` (a clean "store is down" probe result) so callers
 *  can map a HANG to its own `memory_timeout` reason. */
export class MemoryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryTimeoutError';
  }
}

/** Auto-inject (push) path per-op deadline — fast, because injection is a
 *  best-effort enhancement that `buildOperatorPrompt` awaits inline. */
export const MEMORY_INJECT_TIMEOUT_MS = 5_000;

/** Explicit-tool per-op deadline. More generous than the inject path (a cold
 *  embedder or a wide harness fan-out can legitimately take a few seconds) but
 *  well under the ~55–60s MCP dispatch/transport cap, so a wedged backend
 *  returns a degraded envelope instead of riding the transport timeout out to
 *  an apparent infinite hang. Env-tunable; evaluated at call time so tests can
 *  flip it per-test. */
export function memoryToolTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/**
 * How long a memory timeout quiets the auto-inject path. SELF-HEALING: the latch
 * was previously a permanent boolean cleared only on restart — so ONE transient
 * timeout (a load spike, a client cold-init window) disabled memory auto-injection
 * for the whole process lifetime, even after the backend fully recovered. That
 * silently starved every later turn of injected memory context. Now the latch is a
 * timestamp: a timeout quiets injection for a COOLDOWN, after which the inject path
 * retries; if the backend recovered, injection resumes; if it is still wedged, the
 * next inject times out and re-arms the cooldown (so a sustained outage costs at most
 * one timed-out probe per cooldown, not one per turn). Env-tunable for tests/ops.
 */
export function memoryDegradedCooldownMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Epoch ms until which the auto-inject path stays quiet (0 = not degraded). */
let memoryDegradedUntil = 0;

/** True while inside the post-timeout cooldown — the auto-inject path reads this to
 *  go quiet; the explicit tools do NOT (they keep attempting under their deadline so
 *  they recover). Self-clears once the cooldown elapses (no restart required). */
export function isMemoryDegraded(): boolean {
  return Date.now() < memoryDegradedUntil;
}

/** Test-only: clear the process-level degraded latch. */
export function resetMemoryDegradedForTest(): void {
  memoryDegradedUntil = 0;
}

/**
 * Race a memory backend promise against a deadline. Rejects with
 * `MemoryTimeoutError` if the deadline fires first. NOTE: this does NOT cancel
 * the underlying work (a synchronous native wedge cannot be interrupted from JS
 * — that is B3's worker-thread-offload territory); it bounds the CALLER's wait
 * so the request returns instead of hanging forever.
 */
export function withMemoryTimeout<T>(p: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MemoryTimeoutError(`memory ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Wrap an explicit-tool backend call with the tool deadline. On timeout it
 * flips the process degraded latch (so the hot inject path goes quiet) and
 * rethrows `MemoryTimeoutError` for the caller to map onto its degraded
 * envelope.
 */
export function withMemoryToolTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return withMemoryTimeout(p, label, memoryToolTimeoutMs()).catch((err: unknown) => {
    noteMemoryFailure(err);
    throw err;
  });
}

/** Flip the process into degraded mode on a memory timeout. Other failures are
 *  ignored here (they are handled per-caller); only a HANG should quiet the
 *  inject path. */
export function noteMemoryFailure(err: unknown): void {
  if (err instanceof MemoryTimeoutError) {
    const wasDegraded = isMemoryDegraded();
    memoryDegradedUntil = Date.now() + memoryDegradedCooldownMs();
    // NODE_ENV guard mirrors injection.ts — the latch still arms; only the log
    // line is suppressed under vitest (the repo's fail-on-console treats any
    // console.warn as a test failure). Log only on the LEADING edge so a sustained
    // outage doesn't spam one line per re-arm.
    if (!wasDegraded && process.env.NODE_ENV !== 'test') {
      console.warn(
        `[memory] ${err.message} — auto-inject quieted for ${Math.round(memoryDegradedCooldownMs() / 1000)}s (will retry; explicit tools keep attempting)`,
      );
    }
  }
}
