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
    // Transient OS-level errors: connection refused/reset, DNS failures, timeouts.
    if (/^E(CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|NETWORK)$/.test(code)) return true;
    // undici surfaces a mid-request server shutdown as `TypeError: fetch failed`
    // whose cause is a SocketError/timeout with a UND_ERR_* code — NOT an E-code.
    // The operator restarts on every deploy (no hot-reload), so a loopback call
    // that was connecting/in-flight gets "other side closed" (UND_ERR_SOCKET) or a
    // connect/headers timeout. These are exactly the EI-390 queen-launch failures —
    // the old early `return` on `code` swallowed them as non-transient (no retry).
    if (/^UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)$/.test(code)) return true;
    // Unknown code: don't assume non-transient — fall through to the message heuristic.
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Catch error message patterns for transient network issues
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETWORK|Connection (refused|reset)|other side closed|timeout/i.test(msg);
}

/**
 * Render a fetch error with its underlying cause code so a persisted failure is
 * self-diagnosing. undici's `fetch()` throws a generic `TypeError: fetch failed`
 * and hides the real reason in `.cause` — recording only `.message` (as the
 * spawn-launch path does) yields a blind "fetch failed" the watchdog can't act on
 * (EI-390 was undiagnosable for exactly this reason). Keeps the original message as
 * a prefix so existing classifiers/matchers (classifySpawnError → 'network') still
 * fire; appends `(CODE: detail)` when a cause code is present and not already shown.
 */
export function describeFetchError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code;
  if (!code || base.includes(code)) return base;
  const detail = cause?.message && cause.message !== base ? `: ${cause.message}` : '';
  return `${base} (${code}${detail})`;
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

/**
 * Parse a Response body as JSON with an ATTRIBUTABLE error (EI-20).
 *
 * A bare `await res.json()` on an empty or truncated body rejects with a
 * frame-less `SyntaxError: Unexpected end of JSON input` whose stack is only
 * `at parse (<anonymous>)` + `processTicksAndRejections` — ZERO user frames.
 * On the fleet-shared :3070 host the (deliberate, fail-fast) unhandledRejection
 * guard in bin/hono-host.ts then exits the WHOLE process on an unattributable
 * crash — the same two-frame stack recurs unfixably (EI-20: :3070 died at
 * 03:46:57 under the agent-briefs wave, a loopback self-fetch rejecting on an
 * empty body during a host restart). This reads the body as text FIRST and, on
 * a parse failure, rethrows an Error naming the URL, HTTP status, and body
 * length so the crash is traceable to a route. The empty-body case is the
 * common one: a 200 with a zero-byte body (host restarting mid-stream) still
 * passes a `res.ok` check, so guarding on status alone does not prevent it.
 */
export async function readJsonBody<T = unknown>(
  res: Response,
  context?: string,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const where = context || res.url || '<unknown url>';
    const detail = (err as Error)?.message ?? String(err);
    const body = text.length
      ? `; body starts: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)}`
      : ' (empty body)';
    throw new Error(
      `JSON parse failed for ${where} (HTTP ${res.status}, ${text.length} byte body): ${detail}${body}`,
      { cause: err },
    );
  }
}
