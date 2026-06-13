/**
 * loopback-fetch — fetch() for in-process calls to the operator's own :3070
 * host, with a bounded retry on transient network errors.
 *
 * The host has no hot-reload, so picking up a lib/** edit means a RESTART;
 * during that few-second boot the port REFUSES connections and an in-flight
 * loopback call (plans:promote → /features/import, the wave-advance sweep,
 * agents-list, …) would fail. Retry transient network errors (connection-refused,
 * connection-reset, DNS failures, timeouts) a few times (~2.4s) to ride over
 * a short restart or transient network hiccup — the same philosophy as the
 * PreToolUse lock hook (EI-390: agent spawn network failures).
 *
 * Only network errors are retried: HTTP responses (incl. 4xx/5xx) are
 * returned/thrown to the caller unchanged — a 500 won't get better by waiting,
 * and the caller owns status handling.
 */
const DEFAULT_BACKOFFS_MS = [400, 800, 1200];

/** True if error is a transient network error worth retrying. */
export function isTransientNetworkError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code;
  if (code) {
    // Transient OS-level errors: connection refused/reset, DNS failures, timeouts
    return /^E(CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|NETWORK)$/.test(code);
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Catch error message patterns for transient network issues
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETWORK|Connection (refused|reset)|timeout/i.test(msg);
}

/** @deprecated Use isTransientNetworkError instead. */
export function isConnRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  if (cause && cause.code === 'ECONNREFUSED') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|Connection refused/i.test(msg);
}

export async function loopbackFetch(
  input: string | URL,
  init?: RequestInit,
  opts: { backoffsMs?: number[] } = {},
): Promise<Response> {
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      if (isTransientNetworkError(err) && attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // unreachable (loop returns or throws)
}
