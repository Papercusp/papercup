/**
 * Resilient local MCP proxy (mcp-host-availability-resilience-2026-06-22 P-005).
 *
 * WHY: the papercusp-su MCP endpoint is :3070/api/mcp, and :3070 restarts on every
 * deploy. A native MCP client (Claude Code) drops its connection on that restart and
 * does not re-discover tools → "toolless session". This always-up local proxy sits in
 * FRONT of :3070: the client connects HERE (opt-in), and the client→proxy connection
 * stays up across a :3070 deploy because THIS process never restarts on deploys. When
 * :3070 is briefly unreachable (mid-restart) the proxy RETRIES the forward, so a
 * tools/call issued during the window just waits a beat instead of erroring — the
 * restart is invisible to the agent.
 *
 * SAFETY — no double-execution (the load-bearing invariant): a tools/call is often a
 * non-idempotent WRITE. We therefore RETRY ONLY when the upstream connection was
 * REFUSED (ECONNREFUSED / pre-connect error) — i.e. the request provably never reached
 * :3070, so replaying it cannot double-apply. Once the socket has connected, an error
 * MIGHT mean :3070 already processed the call, so we do NOT retry — we surface a 502.
 * That trades a rare mid-flight failure (client re-issues) for the guarantee that a
 * restart-window retry never re-runs a write.
 *
 * The endpoint is STATELESS streamable-HTTP (no Mcp-Session-Id / handshake), so the
 * proxy is a pure per-request passthrough — no session state to lose across a restart.
 */
import http from 'node:http';

export interface McpProxyOptions {
  listenPort: number;
  listenHost?: string;
  targetHost: string;
  targetPort: number;
  /** Total wall-clock budget to keep retrying a refused upstream (a :3070 restart). */
  retryWindowMs: number;
  /** Delay between retries while the upstream is refusing connections. */
  retryBackoffMs?: number;
  log?: (s: string) => void;
}

/**
 * Pure retry decision (unit-tested): keep retrying ONLY while BOTH hold —
 *  (a) the upstream connection has NOT yet been established this attempt
 *      (`connected === false` ⇒ the request never reached :3070 ⇒ safe to replay), and
 *  (b) we are still inside the retry window.
 * `connected === true` ⇒ :3070 may already have processed the (possibly non-idempotent)
 * call ⇒ never replay.
 */
export function shouldRetry(connected: boolean, elapsedMs: number, windowMs: number): boolean {
  if (connected) return false;
  return elapsedMs < windowMs;
}

interface ForwardOutcome {
  /** The upstream response, when one was received. */
  ures?: http.IncomingMessage;
  /** The error, when the forward failed. */
  err?: NodeJS.ErrnoException;
  /** Whether the TCP socket connected before the error (gates retry safety). */
  connected: boolean;
}

/** One forward attempt. Resolves with the upstream response OR an error + whether the
 *  socket had connected (so the caller can decide retry-safety). Never rejects. */
function forwardOnce(
  opts: McpProxyOptions,
  method: string,
  reqUrl: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
): Promise<ForwardOutcome> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const done = (o: ForwardOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    const upstream = http.request(
      {
        host: opts.targetHost,
        port: opts.targetPort,
        method,
        path: reqUrl,
        headers: { ...headers, host: `${opts.targetHost}:${opts.targetPort}` },
      },
      (ures) => done({ ures, connected: true }),
    );
    upstream.on('socket', (s) => {
      // Once the TCP handshake completes, the request is (or may be) in flight at :3070.
      // A reused keep-alive socket is ALREADY connected — return without adding a
      // 'connect' listener (one per proxied request accumulated on the shared socket:
      // the MaxListenersExceededWarning in the unit journal, mcp-outage-triage-2026-07-02).
      if (s.connecting === false) {
        connected = true;
        return;
      }
      s.once('connect', () => {
        connected = true;
      });
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => done({ err, connected }));
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

/** Build the proxy HTTP server (does NOT listen — caller invokes .listen, or use
 *  startMcpProxy). Exposed for tests (drive it against a stub upstream). */
export function createMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  const backoff = opts.retryBackoffMs ?? 500;

  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {
      try {
        res.writeHead(400);
        res.end();
      } catch {
        /* client already gone */
      }
    });
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const started = Date.now();
        let attempts = 0;
        let last: ForwardOutcome | undefined;
        // Retry loop — guarded by shouldRetry (refused-only + window).
        // eslint-disable-next-line no-constant-condition
        while (true) {
          attempts++;
          const outcome = await forwardOnce(opts, req.method ?? 'GET', req.url ?? '/', req.headers, body);
          if (outcome.ures) {
            const ures = outcome.ures;
            res.writeHead(ures.statusCode ?? 502, ures.headers);
            ures.pipe(res);
            if (attempts > 1) log(`recovered after ${attempts} attempts (${Date.now() - started}ms) — :3070 came back`);
            return;
          }
          last = outcome;
          if (!shouldRetry(outcome.connected, Date.now() - started, opts.retryWindowMs)) break;
          await new Promise((r) => setTimeout(r, backoff));
        }
        // Exhausted the window (or a post-connect error we must not replay).
        const refused = last && !last.connected;
        res.writeHead(refused ? 503 : 502, { 'content-type': 'application/json', 'retry-after': '5' });
        res.end(
          JSON.stringify({
            error: refused ? 'mcp_proxy_upstream_unavailable' : 'mcp_proxy_upstream_error',
            detail: String(last?.err?.message ?? last?.err ?? 'unknown'),
            attempts,
            windowMs: opts.retryWindowMs,
            note: refused
              ? ':3070 refused connections for the whole retry window (restart took too long or is down)'
              : 'upstream errored AFTER connecting — not retried (avoids double-applying a non-idempotent tools/call)',
          }),
        );
        log(`upstream ${refused ? 'unavailable' : 'error'} after ${attempts} attempt(s): ${last?.err?.message ?? last?.err}`);
      })();
    });
  });
}

/** Start the proxy from env/opts. Returns the listening server. */
export function startMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  const server = createMcpProxy(opts);
  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () =>
    log(
      `listening on ${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort} → ${opts.targetHost}:${opts.targetPort} ` +
        `(retry-on-refused window ${opts.retryWindowMs}ms)`,
    ),
  );
  return server;
}
