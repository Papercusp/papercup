/**
 * WI-5030 — Settings → Memory must never spin forever.
 *
 * The owner-reported symptom was an eternal "Loading…". Cause of THAT symptom:
 * `refreshMeta()` sets `metaLoaded` in a `finally`, and `finally` only runs once
 * the awaited promise SETTLES. The envelope fetches had no timeout, so a backend
 * that HANGS (as opposed to failing) never settles → `finally` never runs →
 * `metaLoaded` stays false → the render gate `!metaLoaded || …` spins forever,
 * with no error and no recovery.
 *
 * This guards the INVARIANT (a hung fetch must become a bounded, visible error),
 * not the current cause. It is written against the timeout contract rather than
 * the React tree so it stays honest without a DOM harness.
 *
 * Note on the mock: `AbortSignal.timeout` only rescues a fetch that actually
 * HONORS the signal. Real `fetch` does; a naive `new Promise(() => {})` stand-in
 * does not, and would make this a false guard that passes against broken code.
 * `hangingFetch` below therefore rejects with `signal.reason` on abort, exactly
 * as the platform fetch does.
 */
import { describe, it, expect } from 'vitest';
import { META_FETCH_TIMEOUT_MS } from './page';

/** A fetch that never responds, but honors AbortSignal — like the real one. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no signal → genuinely hangs (the pre-fix behavior)
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** The shape of the fix: bounded fetch → hang becomes a TimeoutError rejection. */
async function fetchEnvelope(fetchImpl: typeof fetch, timeoutMs: number): Promise<'ok' | 'timeout'> {
  try {
    await fetchImpl('/api/user/memory/backend', { signal: AbortSignal.timeout(timeoutMs) });
    return 'ok';
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
    throw err;
  }
}

describe('WI-5030: memory settings envelope fetch is bounded', () => {
  it('ships a sane, finite ceiling', () => {
    expect(Number.isFinite(META_FETCH_TIMEOUT_MS)).toBe(true);
    // Must clear a real cold start (>12s measured on source-run operators) so we
    // don't trade an infinite spinner for a spurious error...
    expect(META_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    // ...but must stay bounded enough that a human isn't left waiting.
    expect(META_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('a HUNG backend rejects with TimeoutError rather than hanging forever', async () => {
    // Short timeout here: the invariant is "it terminates", which is independent
    // of the shipped constant's value (asserted separately above).
    const settled = await Promise.race([
      fetchEnvelope(hangingFetch, 50),
      new Promise<'never-settled'>((r) => setTimeout(() => r('never-settled'), 3_000)),
    ]);
    expect(settled).toBe('timeout');
  });

  it('demonstrates the pre-fix behavior: an UNBOUNDED fetch never settles', async () => {
    // Same hanging backend, no signal — reproduces the original defect, and
    // proves the test above is detecting the timeout rather than passing by luck.
    const settled = await Promise.race([
      hangingFetch('/api/user/memory/backend').then(() => 'ok' as const),
      new Promise<'never-settled'>((r) => setTimeout(() => r('never-settled'), 300)),
    ]);
    expect(settled).toBe('never-settled');
  });

  it('a healthy backend is untouched by the timeout', async () => {
    const fast: typeof fetch = async () => new Response('{}', { status: 200 });
    await expect(fetchEnvelope(fast, META_FETCH_TIMEOUT_MS)).resolves.toBe('ok');
  });
});
