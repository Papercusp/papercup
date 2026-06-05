/**
 * loopback-fetch — fetch() for in-process calls to the operator's own :3070
 * host, with a bounded retry on connection-refused.
 *
 * The host has no hot-reload, so picking up a lib/** edit means a RESTART;
 * during that few-second boot the port REFUSES connections and an in-flight
 * loopback call (plans:promote → /features/import, the wave-advance sweep,
 * agents-list, …) would fail. Retry the refused case a few times (~2.4s) to
 * ride over a short restart — the same philosophy as the PreToolUse lock hook.
 *
 * Only connection-refused is retried: any other network error, or any HTTP
 * response (incl. 4xx/5xx), is returned/thrown to the caller unchanged — a
 * 500 won't get better by waiting, and the caller owns status handling.
 */
const DEFAULT_BACKOFFS_MS = [400, 800, 1200];

/** Node's fetch (undici) wraps ECONNREFUSED as a TypeError with `cause.code`. */
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
      if (isConnRefused(err) && attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // unreachable (loop returns or throws)
}
