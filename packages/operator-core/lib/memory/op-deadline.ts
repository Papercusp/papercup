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

let memoryDegraded = false;

/** True once any memory backend call has timed out this process. The
 *  auto-inject path reads this to go quiet; the explicit tools do NOT (they
 *  keep attempting under their deadline so they recover). */
export function isMemoryDegraded(): boolean {
  return memoryDegraded;
}

/** Test-only: clear the process-level degraded latch. */
export function resetMemoryDegradedForTest(): void {
  memoryDegraded = false;
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
    memoryDegraded = true;
    console.warn(`[memory] ${err.message} — auto-inject disabled for this process (degraded)`);
  }
}
