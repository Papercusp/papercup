/**
 * host-benign-errors — classification of process-level errors that are
 * CLIENT-caused and request-scoped, so the operator Hono host's
 * `unhandledRejection` / `uncaughtException` guards (hono-host.ts) can SWALLOW
 * them (log, don't exit) instead of crash-looping :3070 for the whole fleet.
 *
 * The host is multi-tenant: one bad inbound frame must cost at most its own
 * request, never the process. Everything NOT classified benign here stays
 * FAIL-FAST (the guards exit) so genuine host bugs still surface loudly.
 *
 * Both current classes originate inside the third-party `mcp-handler` lib's
 * detached write/parse pump — they reach the process as unhandled rejections we
 * cannot try/catch at our call site, so the process-level guard is the only
 * place to neutralize them.
 */

/**
 * EI-12: an MCP/SSE client disconnects mid-stream → `mcp-handler`'s response
 * adapter enqueues onto an already-closed ReadableStream controller →
 * `ERR_INVALID_STATE: Controller is already closed`. The client is already
 * gone; the only casualty should be its one request.
 */
export function isBenignStreamClose(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  return (
    !!x &&
    (x.code === 'ERR_INVALID_STATE' || /Controller is already closed/i.test(x.message ?? ''))
  );
}

/**
 * EI-714: a malformed JSON-RPC body POSTed to `/api/mcp` (e.g. a stray brace).
 * `mcp-handler` parses the raw body in a detached pump, so a `JSON.parse`
 * `SyntaxError` surfaces as an unhandled rejection rather than a catchable throw
 * at our `await handler(req)`. A bad request body is client input, never a host
 * bug, so it must not down the host — answer the request with a failure, keep
 * serving everyone else.
 *
 * Scoped to JSON-parse SyntaxErrors specifically (not any SyntaxError): a
 * genuine code SyntaxError fails at module load / build, not as a runtime
 * unhandled rejection, so this can't mask a real bug. Node's `JSON.parse`
 * messages all name JSON ("… is not valid JSON", "… after JSON at position N",
 * "Unexpected end of JSON input"); the `Unexpected `-prefix fallback covers any
 * older-V8 phrasing that omits the word.
 */
export function isBenignRequestParse(e: unknown): boolean {
  if (!(e instanceof SyntaxError)) return false;
  const m = e.message ?? '';
  return /JSON/i.test(m) || m.startsWith('Unexpected ');
}

/**
 * A TRANSIENT postgres-js connection failure that escaped to the process level.
 * Under sustained event-loop saturation the main thread can block long enough
 * (observed: p99 ~103s on a CPU-bound box) that Postgres/the OS tears down the
 * operator's backend; postgres-js's DETACHED `nextWrite()` flush then fires
 * against the now-null socket and throws
 * `TypeError: Cannot read properties of null (reading 'write')` from
 * `postgres/src/connection.js` — an UNCAUGHT exception that crash-looped :3070
 * for the whole fleet (2026-06-18). The pool reconnects on the next query, so
 * this is recoverable + must not down the multi-tenant host.
 *
 * Scoped tightly: the null-`write` TypeError is matched ONLY when the stack is
 * inside postgres-js's connection module, so a genuine null-deref elsewhere still
 * fails fast. `CONNECTION_CLOSED` (postgres-js's closed-mid-write code) is also
 * treated as recoverable — if one ever escapes as an unhandled rejection, keep
 * serving rather than crash-loop. (backend-connection-scaling-2026-06-17.)
 */
export function isTransientPgConnectionError(e: unknown): boolean {
  const x = e as { code?: string; message?: string; stack?: string } | null;
  if (!x) return false;
  const msg = x.message ?? '';
  const stack = x.stack ?? '';
  if (
    e instanceof TypeError &&
    /Cannot read properties of null \(reading 'write'\)/.test(msg) &&
    /postgres[\\/](?:cjs[\\/])?src[\\/]connection\.js/.test(stack)
  ) {
    return true;
  }
  return x.code === 'CONNECTION_CLOSED' || /\bCONNECTION_CLOSED\b/.test(msg);
}

/**
 * EI-3385: a file watcher (chokidar / fs.watch — the harness-fs-watcher over
 * per-harness lockfiles + enabled-plugins, the session-claude config watcher, …)
 * hits the kernel inotify ceiling and throws
 * `ENOSPC: System limit for number of file watchers reached, watch '<path>'`. A high
 * cluster-worker count multiplied the per-process watchers past the system budget and
 * the session-claude watcher's ENOSPC surfaced as an UNCAUGHT exception →
 * crash-looped :3070 for the whole fleet (2026-06-24). A missing file watcher only
 * degrades a background convenience (a watched file just isn't auto-reloaded); it must
 * NEVER down the multi-tenant host.
 *
 * Scoped TIGHTLY to the inotify WATCH ENOSPC so a genuine disk-full ENOSPC (which is
 * a real fatal condition) still fails fast: matched only when `syscall === 'watch'`
 * OR the message names the watcher limit. A disk-full ENOSPC carries syscall
 * 'write'/'open' and the message "no space left on device", so it is NOT swallowed.
 */
export function isBenignFileWatcherError(e: unknown): boolean {
  const x = e as { code?: string; syscall?: string; message?: string } | null;
  if (!x || x.code !== 'ENOSPC') return false;
  return x.syscall === 'watch' || /number of file watchers|inotify/i.test(x.message ?? '');
}

/**
 * Any process-level error that is client-caused + request-scoped, OR a transient
 * recoverable infra blip (a torn-down PG connection, an exhausted file-watcher
 * budget) → the host guards log it and KEEP RUNNING. Everything else stays fail-fast
 * (exit).
 */
export function isBenignHostError(e: unknown): boolean {
  return (
    isBenignStreamClose(e) ||
    isBenignRequestParse(e) ||
    isTransientPgConnectionError(e) ||
    isBenignFileWatcherError(e)
  );
}
